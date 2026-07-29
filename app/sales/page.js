"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  parseSalesWorkbook,
  aggregateByStore,
  buildJournalRows,
  rowsToCsv,
  rowsToXlsxBuffer,
  CSV_COLUMNS,
} from "@/lib/salesProcessor";
import { buildExportFileName, parseDateRangeFromFileName, isFileRangeWithinMonth, currentMonthIso } from "@/lib/fileNaming";
import { buildStoreNameMap, remapStoreNamesInRows } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";
import { triggerDownload, todayIso } from "@/lib/download";
import { sharedPageStyles } from "@/lib/pageStyles";

const STATE_KEY = "sales";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

export default function SalesPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;
  const [jvDate, setJvDate] = useState(saved?.jvDate ?? todayIso());
  const [periodMonth, setPeriodMonth] = useState(saved?.periodMonth ?? currentMonthIso());
  const [fileName, setFileName] = useState(saved?.fileName ?? null);
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(saved?.result ?? null); // { byCompany, unmatched }
  const [previewOpen, setPreviewOpen] = useState(saved?.previewOpen ?? false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set(saved?.selectedCompanies ?? []));
  const fileInputRef = useRef(null);
  const lastFileRef = useRef(null);

  useEffect(() => {
    savePageState(STATE_KEY, {
      jvDate,
      periodMonth,
      fileName,
      result,
      previewOpen,
      selectedCompanies: Array.from(selectedCompanies),
    });
  }, [jvDate, periodMonth, fileName, result, previewOpen, selectedCompanies]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  const processFile = useCallback(async (file, dateStr, monthStr) => {
    setProcessing(true);
    setError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const supabase = createClient();
      const [
        { data: storeMaster, error: smError },
        { data: storeMappings, error: mapError },
      ] = await Promise.all([
        supabase.from("stores").select("*"),
        supabase.from("store_name_mappings").select("*"),
      ]);
      if (smError) throw new Error("Could not load Store Master: " + smError.message);
      const storeNameMap = buildStoreNameMap(mapError ? [] : storeMappings || []);

      const buffer = await file.arrayBuffer();
      const rawRows = parseSalesWorkbook(buffer);
      if (!rawRows.length) throw new Error("No rows found in this file.");
      if (!("Store" in rawRows[0])) {
        throw new Error("This file doesn't look like a sales export — no 'Store' column found.");
      }
      const { start, end } = parseDateRangeFromFileName(file.name);
      if (start && end && !isFileRangeWithinMonth(start, end, monthStr)) {
        throw new Error(
          `This file's dates (${start}–${end}) don't fall within the selected Month (${monthStr}) — not loaded. Pick the correct Month or upload the correct file.`
        );
      }
      const mappedRows = remapStoreNamesInRows(rawRows, "Store", storeNameMap);

      const { totals } = aggregateByStore(mappedRows);
      const jvDateObj = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
      const { byCompany, unmatchedStores } = buildJournalRows(totals, storeMaster, jvDateObj);
      setResult({ byCompany, unmatched: unmatchedStores });
      setSelectedCompanies(new Set(Object.keys(byCompany)));
      savePendingMappings({ unmatchedStoreNames: unmatchedStores });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setProcessing(false);
    }
  }, []);

  function handleFile(file) {
    if (!file) return;
    setFileName(file.name);
    lastFileRef.current = file;
    processFile(file, jvDate, periodMonth);
  }

  function handleFileChange(e) {
    handleFile(e.target.files?.[0]);
  }

  function handleDateChange(e) {
    const next = e.target.value;
    setJvDate(next);
    if (lastFileRef.current) processFile(lastFileRef.current, next, periodMonth);
  }

  function handleMonthChange(e) {
    const next = e.target.value;
    setPeriodMonth(next);
    if (lastFileRef.current) processFile(lastFileRef.current, jvDate, next);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  function downloadCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, company);
    triggerDownload(
      new Blob([buf], { type: XLSX_MIME }),
      buildExportFileName(company, "Sale", rows, "Invoice Date", "xlsx")
    );
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(
      new Blob([rowsToCsv(rows)], { type: CSV_MIME }),
      buildExportFileName(company, "Sale", rows, "Invoice Date", "csv")
    );
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "Sale", rows, "Invoice Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "Sale", rows, "Invoice Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Sales-AllCompanies-${format}.zip`);
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

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <div>
            <h1 style={styles.h1}>Sales</h1>
            <p style={styles.pageSub}>
              Upload the raw sales export — get back QBO-ready journal CSVs, one per company
            </p>
          </div>
        </div>

        <div style={styles.card}>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>JV Date</span>
              <input type="date" style={styles.dateInput} value={jvDate} onChange={handleDateChange} />
            </label>

            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>Month</span>
              <input type="month" style={styles.dateInput} value={periodMonth} onChange={handleMonthChange} />
            </label>

            <div style={{ ...styles.fieldBlock, flex: 1.6 }}>
              <span style={styles.fieldLabel}>Upload File</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
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
                <div style={styles.dropzoneText}>{fileName || "Choose or drop sales export (.xlsx)"}</div>
              </div>
            </div>
          </div>
          <div style={styles.info}>
            If the file name's own dates don't fall within the selected Month, it won't be loaded.
          </div>
        </div>

        {processing && <div style={styles.info}>Processing…</div>}
        {error && <div style={styles.errorBanner}>{error}</div>}

        {result && result.unmatched.length > 0 && (
          <div style={styles.warnBanner}>
            {result.unmatched.length} store name(s) in the file don't match any store in your Store
            Master, so they were skipped: <strong>{result.unmatched.join(", ")}</strong>. Add the store in{" "}
            <Link href="/mappings" style={styles.inlineLink}>
              Store Master
            </Link>{" "}
            (matched by "Elevate Name"), then re-upload.
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
                {companyEntries.length} compan{companyEntries.length === 1 ? "y" : "ies"} · {totalRows} line
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
                    <input
                      type="checkbox"
                      checked={selectedCompanies.has(company)}
                      onChange={() => toggleCompany(company)}
                    />
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={styles.companyName}>{company}</span>
                      <span style={styles.companyMeta}>{rows.length} line(s)</span>
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
                      {CSV_COLUMNS.map((c) => (
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
                          {CSV_COLUMNS.map((c) => (
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
  ...sharedPageStyles,

  main: { flex: 1, padding: "36px 44px", maxWidth: 1200 },

  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: 0 },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0" },

  fieldRow: { display: "flex", gap: 20, flexWrap: "wrap" },
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
  },
  dropzone: {
    border: "1px dashed var(--line)",
    borderRadius: 8,
    padding: "18px 12px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 46,
    cursor: "pointer",
    textAlign: "center",
  },

  dropzoneIcon: { fontSize: 20 },

  info: { fontSize: 13, color: "var(--ink-soft)", marginBottom: 14 },
  errorBanner: {
    background: "var(--danger-bg)",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
    lineHeight: 1.5,
  },
  inlineLink: { textDecoration: "underline", fontWeight: 600 },
  warnBanner: {
    background: "var(--warn-bg)",
    color: "var(--warn-text)",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
    lineHeight: 1.5,
  },
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 },

  previewWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    maxHeight: 240,
    marginTop: 20,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 11.5 },
  th: {
    textAlign: "left",
    padding: "7px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 9.5,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    position: "sticky",
    top: 0,
    background: "var(--panel)",
  },

  td: {
    padding: "6px 10px",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    whiteSpace: "nowrap",
  },

  companyMeta: { fontSize: 10.5, color: "var(--ink-soft)" },

};
