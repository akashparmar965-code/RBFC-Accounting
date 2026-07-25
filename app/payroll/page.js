"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  PAYROLL_FIELDS,
  parseTimesheetWorkbook,
  buildStoreHours,
  allocatePayrollByHours,
  buildFinalDataRows,
  buildJournalEntryRows,
  formatMMDDYYYYFromIso,
  JE_COLUMNS,
  rowsToCsv,
  rowsToXlsxBuffer,
} from "@/lib/payrollProcessor";
import { buildExportFileName } from "@/lib/fileNaming";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

function todayIso() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function emptyRow() {
  const row = {};
  for (const { key } of PAYROLL_FIELDS) row[key] = "";
  return row;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function PayrollPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);

  const [companies, setCompanies] = useState([]);
  const [payPeriodDate, setPayPeriodDate] = useState(todayIso());
  const [companyRows, setCompanyRows] = useState({}); // { [company]: { [fieldKey]: string } }
  const [gridLoading, setGridLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  const [timesheetFileName, setTimesheetFileName] = useState(null);
  const [timesheetDragOver, setTimesheetDragOver] = useState(false);
  const [timesheetError, setTimesheetError] = useState("");
  const [storeHours, setStoreHours] = useState(null); // { [elevate_name]: hours } once loaded
  const timesheetInputRef = useRef(null);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [result, setResult] = useState(null); // { byCompany, zeroHourCompanies, unmatchedTimesheetStores, zeroHourStores }
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set());

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("stores")
      .select("company_name")
      .order("company_name", { ascending: true })
      .then(({ data, error }) => {
        if (error) return;
        const unique = Array.from(new Set((data || []).map((r) => r.company_name).filter(Boolean)));
        setCompanies(unique);
      });
  }, [session]);

  const loadGrid = useCallback(async (dateStr, companyList) => {
    if (!dateStr || companyList.length === 0) return;
    setGridLoading(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from("payroll_company_data").select("*").eq("pay_period_date", dateStr);
      if (error) throw new Error(error.message);
      const existingByCompany = {};
      for (const row of data || []) existingByCompany[row.company_name] = row;

      const next = {};
      for (const company of companyList) {
        const existing = existingByCompany[company];
        const row = emptyRow();
        if (existing) {
          for (const { key } of PAYROLL_FIELDS) {
            row[key] = existing[key] != null ? String(existing[key]) : "";
          }
        }
        next[company] = row;
      }
      setCompanyRows(next);
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setGridLoading(false);
    }
  }, []);

  useEffect(() => {
    if (companies.length > 0) loadGrid(payPeriodDate, companies);
  }, [companies, payPeriodDate, loadGrid]);

  function handleCellChange(company, key, value) {
    setCompanyRows((prev) => ({
      ...prev,
      [company]: { ...prev[company], [key]: value },
    }));
  }

  function handleGridKeyDown(e, rowIndex, colIndex) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const nextRow = e.key === "ArrowUp" ? rowIndex - 1 : rowIndex + 1;
    document.getElementById(`payroll-cell-${nextRow}-${colIndex}`)?.focus();
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const supabase = createClient();
      const rows = companies.map((company) => {
        const row = { pay_period_date: payPeriodDate, company_name: company };
        for (const { key } of PAYROLL_FIELDS) {
          const raw = companyRows[company]?.[key];
          const n = Number(raw);
          row[key] = Number.isFinite(n) ? n : 0;
        }
        return row;
      });
      const { error } = await supabase.from("payroll_company_data").upsert(rows, { onConflict: "pay_period_date,company_name" });
      if (error) throw new Error(error.message);
      setSaveMessage("Saved.");
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  const processTimesheet = useCallback(async (file) => {
    setTimesheetError("");
    setStoreHours(null);
    try {
      const buffer = await file.arrayBuffer();
      const rawRows = parseTimesheetWorkbook(buffer);
      if (!rawRows.length) throw new Error("No rows found in this timesheet file.");
      if (!("Store" in rawRows[0]) || !("Total Working Time Decimal" in rawRows[0])) {
        throw new Error(
          "This file doesn't look like an Employee Timesheet export — expected 'Store' and 'Total Working Time Decimal' columns."
        );
      }
      setStoreHours(buildStoreHours(rawRows));
    } catch (e) {
      setTimesheetError(e.message || String(e));
    }
  }, []);

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

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);

      const companyPayrollRows = companies.map((company) => {
        const row = { company_name: company };
        for (const { key } of PAYROLL_FIELDS) {
          const n = Number(companyRows[company]?.[key]);
          row[key] = Number.isFinite(n) ? n : 0;
        }
        return row;
      });

      const { allocatedRows, zeroHourCompanies, unmatchedTimesheetStores, zeroHourStores } = allocatePayrollByHours(
        companyPayrollRows,
        storeMaster,
        storeHours || {}
      );
      const finalRows = buildFinalDataRows(allocatedRows);
      const byCompany = buildJournalEntryRows(finalRows, formatMMDDYYYYFromIso(payPeriodDate));
      setResult({ byCompany, zeroHourCompanies, unmatchedTimesheetStores, zeroHourStores });
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
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "PayrollJE", rows, "Journal Date", "xlsx"));
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(new Blob([rowsToCsv(rows)], { type: CSV_MIME }), buildExportFileName(company, "PayrollJE", rows, "Journal Date", "csv"));
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "PayrollJE", rows, "Journal Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "PayrollJE", rows, "Journal Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Payroll-AllCompanies-${format}.zip`);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const canGenerate = !!payPeriodDate && !!storeHours && companies.length > 0 && !generating;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Payroll</h1>
          <p style={styles.pageSub}>
            Type in company-wise payroll, upload the Employee Timesheet, and generate a per-store Journal Entry
            allocated by hours worked.
          </p>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>1. Pay period & company payroll</h2>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>Pay Period Date</span>
              <input
                type="date"
                style={styles.dateInput}
                value={payPeriodDate}
                onChange={(e) => setPayPeriodDate(e.target.value)}
              />
            </label>
          </div>

          {gridLoading && <div style={styles.info}>Loading…</div>}
          {saveError && <div style={styles.errorBanner}>{saveError}</div>}

          {!gridLoading && companies.length > 0 && (
            <>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, position: "sticky", left: 0, background: "var(--panel)" }}>Company</th>
                      {PAYROLL_FIELDS.map(({ key, label }) => (
                        <th key={key} style={styles.th}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {companies.map((company, rowIndex) => (
                      <tr key={company} style={styles.tr}>
                        <td style={{ ...styles.td, position: "sticky", left: 0, background: "var(--panel)", fontWeight: 600 }}>
                          {company}
                        </td>
                        {PAYROLL_FIELDS.map(({ key }, colIndex) => (
                          <td key={key} style={styles.td}>
                            <input
                              id={`payroll-cell-${rowIndex}-${colIndex}`}
                              type="number"
                              step="0.01"
                              style={styles.numInput}
                              value={companyRows[company]?.[key] ?? ""}
                              onChange={(e) => handleCellChange(company, key, e.target.value)}
                              onKeyDown={(e) => handleGridKeyDown(e, rowIndex, colIndex)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={styles.actionsRow}>
                <button style={styles.saveBtn} onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                {saveMessage && <span style={styles.info}>{saveMessage}</span>}
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
          {storeHours && !timesheetError && (
            <div style={styles.info}>
              {Object.keys(storeHours).length} store(s), {Object.values(storeHours).reduce((a, b) => a + b, 0).toFixed(2)} total
              hours found.
            </div>
          )}
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>3. Generate Journal Entry</h2>
          <button style={styles.generateBtn} onClick={handleGenerate} disabled={!canGenerate}>
            {generating ? "Generating…" : "Allocate & Generate Journal Entry"}
          </button>
          {generateError && <div style={styles.errorBanner}>{generateError}</div>}

          {result && result.zeroHourCompanies.length > 0 && (
            <div style={styles.warnBanner}>
              {result.zeroHourCompanies.length} compan{result.zeroHourCompanies.length === 1 ? "y has" : "ies have"} no
              hours in the uploaded timesheet, so no allocation could be made:{" "}
              <strong>{result.zeroHourCompanies.join(", ")}</strong>.
            </div>
          )}
          {result && result.unmatchedTimesheetStores.length > 0 && (
            <div style={styles.warnBanner}>
              {result.unmatchedTimesheetStores.length} store name(s) in the timesheet don't match any store's Elevate
              Name in Store Master, so their hours were ignored:{" "}
              <strong>{result.unmatchedTimesheetStores.join(", ")}</strong>.
            </div>
          )}
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
                    {companyEntries
                      .filter(([company]) => selectedCompanies.has(company))
                      .flatMap(([, rows]) => rows)
                      .map((r, i) => (
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
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0" },
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
  numInput: {
    width: 88,
    padding: "5px 6px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    background: "var(--field)",
    color: "var(--ink)",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
  },
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, alignItems: "center" },
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
  previewWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    maxHeight: 240,
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
  companyMeta: { fontSize: 10.5, color: "var(--ink-soft)" },
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
