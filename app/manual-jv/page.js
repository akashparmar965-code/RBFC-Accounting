"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import { parseTimesheetWorkbook, buildStoreHours, formatMMDDYYYYFromIso } from "@/lib/payrollProcessor";
import { buildActiveStoreInfo, buildManualJvJournalEntryRows, JE_COLUMNS, rowsToCsv, rowsToXlsxBuffer } from "@/lib/manualJvProcessor";
import { buildExportFileName } from "@/lib/fileNaming";
import { buildStoreNameMap, remapStoreNamesInRows } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";

const STATE_KEY = "manual-jv";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

function todayIso() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function emptyLine() {
  return { account_name: "", debit: "", credit: "", split_per_store: true };
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ManualJvPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;

  const [jeDate, setJeDate] = useState(saved?.jeDate ?? todayIso());

  const [storeMaster, setStoreMaster] = useState(null);
  const [storeMasterError, setStoreMasterError] = useState("");
  const [storeNameMap, setStoreNameMap] = useState({});

  const [jvLines, setJvLines] = useState([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  const [timesheetFileName, setTimesheetFileName] = useState(saved?.timesheetFileName ?? null);
  const [timesheetDragOver, setTimesheetDragOver] = useState(false);
  const [timesheetError, setTimesheetError] = useState("");
  const [storeHours, setStoreHours] = useState(saved?.storeHours ?? null);
  const timesheetInputRef = useRef(null);

  // activeInfo is derived (small) — recomputed from storeHours + storeMaster,
  // not persisted directly, since storeMaster/storeNameMap are refetched
  // fresh each load anyway.
  const [activeInfo, setActiveInfo] = useState(null);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [result, setResult] = useState(saved?.result ?? null); // { byCompany }
  const [previewOpen, setPreviewOpen] = useState(saved?.previewOpen ?? false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set(saved?.selectedCompanies ?? []));

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  useEffect(() => {
    savePageState(STATE_KEY, {
      jeDate,
      timesheetFileName,
      storeHours,
      result,
      previewOpen,
      selectedCompanies: Array.from(selectedCompanies),
    });
  }, [jeDate, timesheetFileName, storeHours, result, previewOpen, selectedCompanies]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("stores")
      .select("*")
      .then(({ data, error }) => {
        if (error) setStoreMasterError("Could not load Store Master: " + error.message);
        else setStoreMaster(data || []);
      });
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("store_name_mappings")
      .select("*")
      .then(({ data, error }) => {
        if (error) return;
        setStoreNameMap(buildStoreNameMap(data || []));
      });
  }, [session]);

  const loadLines = useCallback(async (dateStr) => {
    if (!dateStr) return;
    setLinesLoading(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("manual_jv_lines")
        .select("*")
        .eq("je_date", dateStr)
        .order("sort_order", { ascending: true });
      if (error) throw new Error(error.message);
      if (data && data.length > 0) {
        setJvLines(
          data.map((r) => ({
            account_name: r.account_name,
            debit: r.debit ? String(r.debit) : "",
            credit: r.credit ? String(r.credit) : "",
            split_per_store: r.split_per_store,
          }))
        );
      } else {
        setJvLines([emptyLine(), emptyLine()]);
      }
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setLinesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLines(jeDate);
  }, [jeDate, loadLines]);

  function updateLine(index, field, value) {
    setJvLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  function addLine() {
    setJvLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index) {
    setJvLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveLines() {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const supabase = createClient();
      const cleanLines = jvLines
        .filter((l) => l.account_name.trim() && (Number(l.debit) > 0 || Number(l.credit) > 0))
        .map((l, i) => ({
          je_date: jeDate,
          account_name: l.account_name.trim(),
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          split_per_store: !!l.split_per_store,
          sort_order: i,
        }));
      const { error: delError } = await supabase.from("manual_jv_lines").delete().eq("je_date", jeDate);
      if (delError) throw new Error(delError.message);
      if (cleanLines.length > 0) {
        const { error: insError } = await supabase.from("manual_jv_lines").insert(cleanLines);
        if (insError) throw new Error(insError.message);
      }
      setSaveMessage("Saved.");
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  const processTimesheet = useCallback(
    async (file) => {
      setTimesheetError("");
      setStoreHours(null);
      setActiveInfo(null);
      try {
        const buffer = await file.arrayBuffer();
        const rawRows = parseTimesheetWorkbook(buffer);
        if (!rawRows.length) throw new Error("No rows found in this timesheet file.");
        if (!("Store" in rawRows[0]) || !("Total Working Time Decimal" in rawRows[0])) {
          throw new Error(
            "This file doesn't look like an Employee Timesheet export — expected 'Store' and 'Total Working Time Decimal' columns."
          );
        }
        const mappedRows = remapStoreNamesInRows(rawRows, "Store", storeNameMap);
        setStoreHours(buildStoreHours(mappedRows));
      } catch (e) {
        setTimesheetError(e.message || String(e));
      }
    },
    [storeNameMap]
  );

  function handleTimesheetFile(file) {
    if (!file) return;
    setTimesheetFileName(file.name);
    processTimesheet(file);
  }

  function handleTimesheetFileChange(e) {
    handleTimesheetFile(e.target.files?.[0]);
  }

  function handleTimesheetDrop(e) {
    e.preventDefault();
    setTimesheetDragOver(false);
    handleTimesheetFile(e.dataTransfer.files?.[0]);
  }

  useEffect(() => {
    if (!storeHours || !storeMaster) return;
    const info = buildActiveStoreInfo(storeHours, storeMaster);
    setActiveInfo(info);
    savePendingMappings({ unmatchedStoreNames: info.unmatchedStores });
  }, [storeHours, storeMaster]);

  function handleGenerate() {
    setGenerating(true);
    setGenerateError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const cleanLines = jvLines.filter((l) => l.account_name.trim() && (Number(l.debit) > 0 || Number(l.credit) > 0));
      if (cleanLines.length === 0) throw new Error("Add at least one JV line with an Account Name and a Debit or Credit amount.");
      const byCompany = buildManualJvJournalEntryRows(cleanLines, activeInfo, formatMMDDYYYYFromIso(jeDate));
      setResult({ byCompany });
      setSelectedCompanies(new Set(Object.keys(byCompany)));
    } catch (e) {
      setGenerateError(e.message || String(e));
    } finally {
      setGenerating(false);
    }
  }

  function toggleCompany(company) {
    setSelectedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  function toggleSelectAll(allCompanyNames, checked) {
    setSelectedCompanies(checked ? new Set(allCompanyNames) : new Set());
  }

  async function downloadCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, company);
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "ManualJV", rows, "Journal Date", "xlsx"));
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(new Blob([rowsToCsv(rows)], { type: CSV_MIME }), buildExportFileName(company, "ManualJV", rows, "Journal Date", "csv"));
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "ManualJV", rows, "Journal Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "ManualJV", rows, "Journal Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `ManualJV-AllCompanies-${format}.zip`);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const enteredDebit = jvLines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const enteredCredit = jvLines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
  const enteredBalanced = Math.abs(enteredDebit - enteredCredit) < 0.01;
  const canGenerate = !!activeInfo && activeInfo.matchedStores.length > 0 && !generating;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Manual JV</h1>
          <p style={styles.pageSub}>
            Type in any JV, upload the Employee Timesheet, and split each line equally across every store active
            that period (or keep it as one line per company) — same allocation idea as Payroll, but a flat split
            instead of hours-weighted.
          </p>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>1. JE Date & JV lines</h2>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>Journal Date</span>
              <input type="date" style={styles.dateInput} value={jeDate} onChange={(e) => setJeDate(e.target.value)} />
            </label>
          </div>

          {storeMasterError && <div style={styles.errorBanner}>{storeMasterError}</div>}
          {linesLoading && <div style={styles.info}>Loading…</div>}
          {saveError && <div style={styles.errorBanner}>{saveError}</div>}

          {!linesLoading && (
            <>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Account Name</th>
                      <th style={styles.th}>Debit</th>
                      <th style={styles.th}>Credit</th>
                      <th style={styles.th}>Split per store</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {jvLines.map((line, i) => (
                      <tr key={i} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder="e.g. Personal Expense"
                            value={line.account_name}
                            onChange={(e) => updateLine(i, "account_name", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            step="0.01"
                            style={styles.numInput}
                            value={line.debit}
                            onChange={(e) => updateLine(i, "debit", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="number"
                            step="0.01"
                            style={styles.numInput}
                            value={line.credit}
                            onChange={(e) => updateLine(i, "credit", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={line.split_per_store}
                            onChange={(e) => updateLine(i, "split_per_store", e.target.checked)}
                          />
                        </td>
                        <td style={styles.td}>
                          <button style={styles.linkBtn} onClick={() => removeLine(i)}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={styles.actionsRow}>
                <button style={styles.addBtn} onClick={addLine}>
                  + Add line
                </button>
                <button style={styles.saveBtn} onClick={handleSaveLines} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                {saveMessage && <span style={styles.info}>{saveMessage}</span>}
                <span style={enteredBalanced ? styles.balanceOk : styles.balanceBad}>
                  Entered Dr {enteredDebit.toFixed(2)} · Cr {enteredCredit.toFixed(2)}
                  {enteredBalanced ? " ✓ Balanced" : ` ⚠ Out of balance by ${(enteredDebit - enteredCredit).toFixed(2)}`}
                </span>
              </div>
            </>
          )}
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>2. Employee Timesheet</h2>
          <input
            ref={timesheetInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleTimesheetFileChange}
            style={{ display: "none" }}
          />
          <div
            style={{ ...styles.dropzone, ...(timesheetDragOver ? styles.dropzoneActive : {}) }}
            onClick={() => timesheetInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setTimesheetDragOver(true);
            }}
            onDragLeave={() => setTimesheetDragOver(false)}
            onDrop={handleTimesheetDrop}
          >
            <div style={styles.dropzoneIcon}>📄</div>
            <div style={styles.dropzoneText}>{timesheetFileName || "Choose or drop Employee Timesheet export (.xlsx/.csv)"}</div>
          </div>
          {timesheetError && <div style={styles.errorBanner}>{timesheetError}</div>}

          {activeInfo && activeInfo.unmatchedStores.length > 0 && (
            <div style={styles.warnBanner}>
              {activeInfo.unmatchedStores.length} store name(s) in the timesheet don't match any store's Elevate
              Name in Store Master, so they were excluded from the active-store count:{" "}
              <strong>{activeInfo.unmatchedStores.join(", ")}</strong>.
            </div>
          )}

          {activeInfo && (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Company</th>
                    <th style={styles.th}>Active stores</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(activeInfo.byCompany)
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([company, stores]) => (
                      <tr key={company} style={styles.tr}>
                        <td style={styles.td}>{company}</td>
                        <td style={styles.td}>{stores.length}</td>
                      </tr>
                    ))}
                  <tr style={styles.tr}>
                    <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
                    <td style={{ ...styles.td, fontWeight: 700 }}>{activeInfo.matchedStores.length}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>3. Generate Journal Entry</h2>
          <button style={styles.generateBtn} onClick={handleGenerate} disabled={!canGenerate}>
            {generating ? "Generating…" : "Allocate & Generate Journal Entry"}
          </button>
          {generateError && <div style={styles.errorBanner}>{generateError}</div>}
        </div>

        {result && totalRows > 0 && (
          <>
            <div style={styles.actionsRow}>
              <button style={styles.previewBtn} onClick={() => setPreviewOpen((v) => !v)}>
                👁 {previewOpen ? "Hide preview" : "Preview selected"}
              </button>
              <button style={styles.xlsxBtn} onClick={() => downloadAllZip("xlsx")}>
                📘 Download all (XLSX)
              </button>
              <button style={styles.csvBtnMuted} onClick={() => downloadAllZip("csv")}>
                Download all (CSV)
              </button>
            </div>

            <div style={styles.resultsHeader}>
              <h2 style={styles.h2}>
                {companyEntries.length} compan{companyEntries.length === 1 ? "y" : "ies"} · {totalRows} JE line
                {totalRows === 1 ? "" : "s"}
              </h2>
              <label style={styles.selectAllLabel}>
                <input
                  type="checkbox"
                  checked={selectedCompanies.size === companyEntries.length && companyEntries.length > 0}
                  onChange={(e) =>
                    toggleSelectAll(
                      companyEntries.map(([company]) => company),
                      e.target.checked
                    )
                  }
                />
                Select all
              </label>
            </div>

            <div style={styles.companyGrid}>
              {companyEntries.map(([company, rows]) => (
                <div key={company} style={styles.companyCard}>
                  <label style={styles.companyCheckLabel}>
                    <input type="checkbox" checked={selectedCompanies.has(company)} onChange={() => toggleCompany(company)} />
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={styles.companyName}>{company}</span>
                      <span style={styles.companyMeta}>{rows.length} JE line(s)</span>
                    </div>
                  </label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={styles.secondaryBtn} onClick={() => downloadCompanyXlsx(company, rows)}>
                      XLSX
                    </button>
                    <button style={styles.secondaryBtn} onClick={() => downloadCompanyCsv(company, rows)}>
                      CSV
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {previewOpen && (
              <div style={styles.previewGroups}>
                {companyEntries
                  .filter(([company]) => selectedCompanies.has(company))
                  .map(([company, rows]) => {
                    const totalDebit = rows.reduce((sum, r) => sum + (Number(r.Debit) || 0), 0);
                    const totalCredit = rows.reduce((sum, r) => sum + (Number(r.Credit) || 0), 0);
                    const balanced = Math.abs(totalDebit - totalCredit) < 0.01;

                    const storeCount = activeInfo?.byCompany?.[company]?.length ?? 0;

                    return (
                      <div key={company} style={styles.previewGroup}>
                        <div style={styles.previewGroupHeader}>
                          <span style={styles.companyName}>
                            {company} <span style={styles.companyMeta}>({storeCount} active store(s))</span>
                          </span>
                          <span style={balanced ? styles.balanceOk : styles.balanceBad}>
                            Dr {totalDebit.toFixed(2)} · Cr {totalCredit.toFixed(2)}
                            {balanced ? " ✓ Balanced" : ` ⚠ Out of balance by ${(totalDebit - totalCredit).toFixed(2)}`}
                          </span>
                        </div>
                        <div style={styles.previewWrap}>
                          <table style={styles.table}>
                            <thead>
                              <tr>
                                {JE_COLUMNS.map((c) => (
                                  <th key={c} style={styles.th}>
                                    {c}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r, i) => (
                                <tr key={i} style={styles.tr}>
                                  {JE_COLUMNS.map((c) => (
                                    <td key={c} style={styles.td}>
                                      {r[c]}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const styles = {
  loadingScreen: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--ink-soft)",
  },
  shell: { display: "flex", minHeight: "100vh" },
  main: { flex: 1, padding: "36px 44px", maxWidth: 1300 },
  topRow: { marginBottom: 20 },
  h1: { fontFamily: "var(--font-display)", fontSize: 26, margin: 0 },
  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 14px" },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 760 },
  card: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
  },
  fieldRow: { display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16 },
  fieldBlock: { display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 180 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--ink-soft)",
  },
  dateInput: {
    padding: "11px 12px",
    borderRadius: 8,
    border: "1px solid var(--line)",
    fontSize: 14,
    background: "var(--field)",
    color: "var(--ink)",
    maxWidth: 220,
  },
  dropzone: {
    border: "1px dashed var(--line)",
    borderRadius: 8,
    padding: "22px 12px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    cursor: "pointer",
    textAlign: "center",
  },
  dropzoneActive: { borderColor: "var(--ledger)", background: "rgba(34,163,123,0.06)" },
  dropzoneIcon: { fontSize: 22 },
  dropzoneText: { fontSize: 13, color: "var(--ink-soft)" },
  info: { fontSize: 13, color: "var(--ink-soft)" },
  errorBanner: {
    background: "var(--danger-bg)",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginTop: 12,
    lineHeight: 1.5,
  },
  warnBanner: {
    background: "var(--warn-bg)",
    color: "var(--warn-text)",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginTop: 12,
    marginBottom: 14,
    lineHeight: 1.5,
  },
  tableWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    marginBottom: 14,
    maxHeight: 420,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: {
    textAlign: "left",
    padding: "9px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid var(--line)" },
  td: {
    padding: "6px 8px",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    whiteSpace: "nowrap",
  },
  cellInput: {
    width: "100%",
    minWidth: 160,
    padding: "6px 8px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    fontSize: 12.5,
    fontFamily: "var(--font-mono)",
    background: "var(--field)",
    color: "var(--ink)",
  },
  numInput: {
    width: 110,
    padding: "6px 8px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    fontFamily: "var(--font-mono)",
    fontSize: 12.5,
    background: "var(--field)",
    color: "var(--ink)",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--danger)",
    fontSize: 12,
    fontWeight: 600,
    padding: 0,
    fontFamily: "var(--font-body)",
  },
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, alignItems: "center" },
  addBtn: {
    background: "transparent",
    color: "var(--ledger)",
    border: "1px solid var(--ledger)",
    borderRadius: 7,
    padding: "9px 16px",
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  saveBtn: {
    background: "var(--ledger)",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "10px 18px",
    fontSize: 13,
    fontWeight: 600,
  },
  generateBtn: {
    background: "var(--accent-purple)",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "10px 18px",
    fontSize: 13,
    fontWeight: 600,
  },
  previewBtn: {
    background: "var(--danger)",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
  },
  xlsxBtn: {
    background: "var(--accent-purple)",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
  },
  csvBtnMuted: {
    background: "transparent",
    color: "var(--ink-soft)",
    border: "1px solid var(--line)",
    borderRadius: 7,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
  },
  resultsHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
    gap: 12,
  },
  selectAllLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12.5,
    color: "var(--ink-soft)",
    fontWeight: 600,
    cursor: "pointer",
  },
  companyCheckLabel: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" },
  previewGroups: { display: "flex", flexDirection: "column", gap: 16 },
  previewGroup: {},
  previewGroupHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 12,
    marginBottom: 6,
    flexWrap: "wrap",
  },
  balanceOk: { fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ledger)" },
  balanceBad: { fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--danger)", fontWeight: 700 },
  previewWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    maxHeight: 320,
    marginTop: 4,
  },
  companyGrid: { display: "flex", flexDirection: "column", gap: 5 },
  companyCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: "7px 14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  companyName: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12.5 },
  companyMeta: { fontSize: 10.5, color: "var(--ink-soft)", fontWeight: 500, fontFamily: "var(--font-body)" },
  secondaryBtn: {
    background: "transparent",
    color: "var(--ink)",
    border: "1px solid var(--line)",
    borderRadius: 5,
    padding: "5px 10px",
    fontSize: 11,
    fontWeight: 600,
  },
};
