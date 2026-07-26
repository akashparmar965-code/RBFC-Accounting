"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  parseInventorySheet,
  sumCostByStore,
  buildInventoryChangeRows,
  buildInventoryJournalEntryRows,
  JE_COLUMNS,
  rowsToCsv,
  rowsToXlsxBuffer,
} from "@/lib/inventoryProcessor";
import { formatMMDDYYYYFromIso } from "@/lib/payrollProcessor";
import { buildExportFileName } from "@/lib/fileNaming";
import { buildStoreNameMap, remapStoreNamesInRows } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

function todayIso() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can race the browser's blob read on some
  // versions and truncate the download — give it a moment first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function InventoryPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);

  const [jeDate, setJeDate] = useState(todayIso());

  const [storeMaster, setStoreMaster] = useState(null);
  const [storeMasterError, setStoreMasterError] = useState("");
  const [storeNameMap, setStoreNameMap] = useState({});

  const [openingFileName, setOpeningFileName] = useState(null);
  const [openingDragOver, setOpeningDragOver] = useState(false);
  const [openingError, setOpeningError] = useState("");
  const [openingRows, setOpeningRows] = useState(null);
  const openingInputRef = useRef(null);

  const [closingFileName, setClosingFileName] = useState(null);
  const [closingDragOver, setClosingDragOver] = useState(false);
  const [closingError, setClosingError] = useState("");
  const [closingRows, setClosingRows] = useState(null);
  const closingInputRef = useRef(null);

  const [changeResult, setChangeResult] = useState(null); // { changeRows, unmatchedStores }

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [result, setResult] = useState(null); // { byCompany }
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

  const processOpeningFile = useCallback(async (file) => {
    setOpeningError("");
    setOpeningRows(null);
    try {
      const buffer = await file.arrayBuffer();
      const rows = parseInventorySheet(buffer, "opening");
      if (!rows.length || !("Store" in rows[0]) || !("Total Cost" in rows[0])) {
        throw new Error('This file is missing expected "Store"/"Total Cost" columns.');
      }
      setOpeningRows(rows);
    } catch (e) {
      setOpeningError(e.message || String(e));
    }
  }, []);

  const processClosingFile = useCallback(async (file) => {
    setClosingError("");
    setClosingRows(null);
    try {
      const buffer = await file.arrayBuffer();
      const rows = parseInventorySheet(buffer, "closing");
      if (!rows.length || !("Store" in rows[0]) || !("Total Cost" in rows[0])) {
        throw new Error('This file is missing expected "Store"/"Total Cost" columns.');
      }
      setClosingRows(rows);
    } catch (e) {
      setClosingError(e.message || String(e));
    }
  }, []);

  function handleOpeningFile(file) {
    if (!file) return;
    setOpeningFileName(file.name);
    processOpeningFile(file);
  }

  function handleClosingFile(file) {
    if (!file) return;
    setClosingFileName(file.name);
    processClosingFile(file);
  }

  function handleOpeningFileChange(e) {
    handleOpeningFile(e.target.files?.[0]);
  }

  function handleClosingFileChange(e) {
    handleClosingFile(e.target.files?.[0]);
  }

  function handleOpeningDrop(e) {
    e.preventDefault();
    setOpeningDragOver(false);
    handleOpeningFile(e.dataTransfer.files?.[0]);
  }

  function handleClosingDrop(e) {
    e.preventDefault();
    setClosingDragOver(false);
    handleClosingFile(e.dataTransfer.files?.[0]);
  }

  useEffect(() => {
    if (!openingRows || !closingRows || !storeMaster) return;
    const mappedOpening = remapStoreNamesInRows(openingRows, "Store", storeNameMap);
    const mappedClosing = remapStoreNamesInRows(closingRows, "Store", storeNameMap);
    const openingByStore = sumCostByStore(mappedOpening);
    const closingByStore = sumCostByStore(mappedClosing);
    const { changeRows, unmatchedStores } = buildInventoryChangeRows(openingByStore, closingByStore, storeMaster);
    setChangeResult({ changeRows, unmatchedStores });
    setResult(null);
    setPreviewOpen(false);
    savePendingMappings({ unmatchedStoreNames: unmatchedStores });
  }, [openingRows, closingRows, storeMaster, storeNameMap]);

  function handleGenerate() {
    setGenerating(true);
    setGenerateError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const byCompany = buildInventoryJournalEntryRows(changeResult.changeRows, formatMMDDYYYYFromIso(jeDate));
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
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "InvJE", rows, "Date", "xlsx"));
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(new Blob([rowsToCsv(rows)], { type: CSV_MIME }), buildExportFileName(company, "InvJE", rows, "Date", "csv"));
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "InvJE", rows, "Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "InvJE", rows, "Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Inventory-AllCompanies-${format}.zip`);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const changeRows = changeResult?.changeRows || [];

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Change in Inventory</h1>
          <p style={styles.pageSub}>
            Upload your opening and closing inventory exports separately to get per-store Opening/Closing/Change in
            Inventory, then generate a per-company Journal Entry.
          </p>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>1. JE Date & upload</h2>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>JE Date</span>
              <input type="date" style={styles.dateInput} value={jeDate} onChange={(e) => setJeDate(e.target.value)} />
            </label>
          </div>

          {storeMasterError && <div style={styles.errorBanner}>{storeMasterError}</div>}

          <div style={styles.uploadPairRow}>
            <div style={styles.uploadCol}>
              <span style={styles.fieldLabel}>Opening Inventory</span>
              <input
                ref={openingInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleOpeningFileChange}
                style={{ display: "none" }}
              />
              <div
                style={{ ...styles.dropzone, ...(openingDragOver ? styles.dropzoneActive : {}) }}
                onClick={() => openingInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOpeningDragOver(true);
                }}
                onDragLeave={() => setOpeningDragOver(false)}
                onDrop={handleOpeningDrop}
              >
                <div style={styles.dropzoneIcon}>📄</div>
                <div style={styles.dropzoneText}>{openingFileName || "Choose or drop Opening Inventory export"}</div>
              </div>
              {openingRows && !openingError && <div style={styles.info}>{openingRows.length} row(s) loaded.</div>}
              {openingError && <div style={styles.errorBanner}>{openingError}</div>}
            </div>

            <div style={styles.uploadCol}>
              <span style={styles.fieldLabel}>Closing Inventory</span>
              <input
                ref={closingInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleClosingFileChange}
                style={{ display: "none" }}
              />
              <div
                style={{ ...styles.dropzone, ...(closingDragOver ? styles.dropzoneActive : {}) }}
                onClick={() => closingInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setClosingDragOver(true);
                }}
                onDragLeave={() => setClosingDragOver(false)}
                onDrop={handleClosingDrop}
              >
                <div style={styles.dropzoneIcon}>📄</div>
                <div style={styles.dropzoneText}>{closingFileName || "Choose or drop Closing Inventory export"}</div>
              </div>
              {closingRows && !closingError && <div style={styles.info}>{closingRows.length} row(s) loaded.</div>}
              {closingError && <div style={styles.errorBanner}>{closingError}</div>}
            </div>
          </div>

          {changeResult && changeResult.unmatchedStores.length > 0 && (
            <div style={styles.warnBanner}>
              {changeResult.unmatchedStores.length} store name(s) in the file don't match any store's Elevate Name
              in Store Master, so their cost was excluded from every store's change calculation:{" "}
              <strong>{changeResult.unmatchedStores.join(", ")}</strong>.
            </div>
          )}
        </div>

        {changeResult && changeRows.length > 0 && (
          <div style={styles.card}>
            <h2 style={styles.h2}>2. Opening / Closing / Change in Inventory (preview)</h2>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Company</th>
                    <th style={styles.th}>Store</th>
                    <th style={styles.th}>Opening Stock</th>
                    <th style={styles.th}>Closing Stock</th>
                    <th style={styles.th}>Change in Inventory</th>
                  </tr>
                </thead>
                <tbody>
                  {changeRows.map((r, i) => (
                    <tr key={i} style={styles.tr}>
                      <td style={styles.td}>{r.company}</td>
                      <td style={styles.td}>{r.storeLabel}</td>
                      <td style={styles.td}>{r.opening.toFixed(2)}</td>
                      <td style={styles.td}>{r.closing.toFixed(2)}</td>
                      <td style={styles.td}>{r.change.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {changeResult && changeRows.length > 0 && (
          <div style={styles.card}>
            <h2 style={styles.h2}>3. Generate Journal Entry</h2>
            <button style={styles.generateBtn} onClick={handleGenerate} disabled={generating}>
              {generating ? "Generating…" : "Generate Journal Entry"}
            </button>
            {generateError && <div style={styles.errorBanner}>{generateError}</div>}
          </div>
        )}

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
                    return (
                      <div key={company} style={styles.previewGroup}>
                        <div style={styles.previewGroupHeader}>
                          <span style={styles.companyName}>{company}</span>
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
  uploadPairRow: { display: "flex", gap: 20, flexWrap: "wrap" },
  uploadCol: { display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 260 },
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
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, alignItems: "center" },
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
