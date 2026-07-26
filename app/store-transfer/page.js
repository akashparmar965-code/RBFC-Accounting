"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  parseStoreTransferWorkbook,
  buildTransferRows,
  buildDeviceTransferPivots,
  buildInterCompanySummary,
  buildStoreTransferJournalEntryRows,
  JE_COLUMNS,
  rowsToCsv,
  rowsToXlsxBuffer,
} from "@/lib/storeTransferProcessor";
import { formatMMDDYYYYFromIso } from "@/lib/payrollProcessor";
import { buildExportFileName } from "@/lib/fileNaming";

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
  URL.revokeObjectURL(url);
}

export default function StoreTransferPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);

  const [jeDate, setJeDate] = useState(todayIso());

  const [fileName, setFileName] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [transferData, setTransferData] = useState(null); // { transferRows, unmatchedStores }
  const fileInputRef = useRef(null);

  const [verifyTab, setVerifyTab] = useState("out");

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

  const processFile = useCallback(async (file) => {
    setProcessing(true);
    setError("");
    setTransferData(null);
    setResult(null);
    setPreviewOpen(false);
    try {
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);

      const buffer = await file.arrayBuffer();
      const rawRows = parseStoreTransferWorkbook(buffer);
      if (!rawRows.length || !("From" in rawRows[0]) || !("To" in rawRows[0]) || !("Ext Cost" in rawRows[0])) {
        throw new Error('This file is missing expected "From"/"To"/"Ext Cost" columns.');
      }

      const { transferRows, unmatchedStores } = buildTransferRows(rawRows, storeMaster);
      setTransferData({ transferRows, unmatchedStores });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setProcessing(false);
    }
  }, []);

  function handleFile(file) {
    if (!file) return;
    setFileName(file.name);
    processFile(file);
  }

  function handleFileChange(e) {
    handleFile(e.target.files?.[0]);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  function handleGenerate() {
    setGenerating(true);
    setGenerateError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const byCompany = buildStoreTransferJournalEntryRows(transferData.transferRows, formatMMDDYYYYFromIso(jeDate));
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
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "TransferJE", rows, "Date", "xlsx"));
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(new Blob([rowsToCsv(rows)], { type: CSV_MIME }), buildExportFileName(company, "TransferJE", rows, "Date", "csv"));
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "TransferJE", rows, "Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "TransferJE", rows, "Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `StoreTransfer-AllCompanies-${format}.zip`);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);

  const pivots = transferData ? buildDeviceTransferPivots(transferData.transferRows) : null;
  const interCompany = transferData ? buildInterCompanySummary(transferData.transferRows) : null;
  const interCompanyNames = interCompany ? Array.from(new Set([...Object.keys(interCompany), ...Object.values(interCompany).flatMap((r) => Object.keys(r))])).sort() : [];

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Store Transfer</h1>
          <p style={styles.pageSub}>
            Upload the Store Transfer Receiving Details export to verify device transfers between stores, then
            generate a per-company Journal Entry.
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

          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleFileChange} style={{ display: "none" }} />
          <div
            style={{ ...styles.dropzone, ...(dragOver ? styles.dropzoneActive : {}) }}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <div style={styles.dropzoneIcon}>📄</div>
            <div style={styles.dropzoneText}>{fileName || "Choose or drop Store Transfer Receiving Details export"}</div>
          </div>

          {processing && <div style={styles.info}>Processing…</div>}
          {error && <div style={styles.errorBanner}>{error}</div>}

          {transferData && transferData.unmatchedStores.length > 0 && (
            <div style={styles.warnBanner}>
              {transferData.unmatchedStores.length} store name(s) in the file don't match any store's Elevate Name
              in Store Master, so any transfer touching them was excluded entirely:{" "}
              <strong>{transferData.unmatchedStores.join(", ")}</strong>.
            </div>
          )}
        </div>

        {interCompany && (
          <div style={styles.card}>
            <h2 style={styles.h2}>2. Inter-Company Transfer Summary (verification only)</h2>
            <p style={styles.info}>
              Total value transferred between companies. Only these amounts hit each company's balance sheet —
              transfers within the same company net to zero.
            </p>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>From \ To</th>
                    {interCompanyNames.map((c) => (
                      <th key={c} style={styles.th}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {interCompanyNames.map((fromCo) => (
                    <tr key={fromCo} style={styles.tr}>
                      <td style={{ ...styles.td, fontWeight: 600 }}>{fromCo}</td>
                      {interCompanyNames.map((toCo) => (
                        <td key={toCo} style={{ ...styles.td, ...(fromCo === toCo ? { color: "var(--ink-soft)" } : {}) }}>
                          {interCompany[fromCo]?.[toCo] != null ? interCompany[fromCo][toCo].toFixed(2) : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {pivots && (
          <div style={styles.card}>
            <h2 style={styles.h2}>3. Inter-Store Transfer Summary (verification only)</h2>
            <div style={styles.tabRow}>
              <button style={verifyTab === "out" ? styles.tabActive : styles.tab} onClick={() => setVerifyTab("out")}>
                Device Transfer Out
              </button>
              <button style={verifyTab === "in" ? styles.tabActive : styles.tab} onClick={() => setVerifyTab("in")}>
                Device Transfer In
              </button>
            </div>
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>{verifyTab === "out" ? "From Store" : "To Store"}</th>
                    <th style={styles.th}>{verifyTab === "out" ? "To Store" : "From Store"}</th>
                    <th style={styles.th}>Counterpart Company</th>
                    <th style={styles.th}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(verifyTab === "out" ? pivots.outRows : pivots.inRows).map((row) => (
                    <Fragment key={row.store}>
                      <tr style={{ ...styles.tr, background: "rgba(255,255,255,0.03)" }}>
                        <td style={{ ...styles.td, fontWeight: 700 }}>{row.label}</td>
                        <td style={styles.td} />
                        <td style={styles.td} />
                        <td style={{ ...styles.td, fontWeight: 700 }}>{row.total.toFixed(2)}</td>
                      </tr>
                      {row.counterparts.map((c) => (
                        <tr key={row.store + "|" + c.store} style={styles.tr}>
                          <td style={styles.td} />
                          <td style={styles.td}>{c.store}</td>
                          <td style={styles.td}>{c.company}</td>
                          <td style={styles.td}>{c.amount.toFixed(2)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {transferData && transferData.transferRows.length > 0 && (
          <div style={styles.card}>
            <h2 style={styles.h2}>4. Generate Journal Entry</h2>
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
  tabRow: { display: "flex", gap: 8, marginBottom: 14 },
  tab: {
    background: "transparent",
    color: "var(--ink-soft)",
    border: "1px solid var(--line)",
    borderRadius: 7,
    padding: "8px 18px",
    fontSize: 13,
    fontWeight: 600,
  },
  tabActive: {
    background: "var(--ledger)",
    color: "#fff",
    border: "1px solid var(--ledger)",
    borderRadius: 7,
    padding: "8px 18px",
    fontSize: 13,
    fontWeight: 600,
  },
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
