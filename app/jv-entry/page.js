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
  rowsToCsv as salesRowsToCsv,
  rowsToXlsxBuffer as salesRowsToXlsxBuffer,
  buildAllInOneRows as salesAllInOneRows,
  CSV_COLUMNS as SALES_COLUMNS,
} from "@/lib/salesProcessor";
import {
  parseVipWorkbook,
  aggregateBillLines,
  buildBillRows,
  rowsToCsv as billsRowsToCsv,
  rowsToXlsxBuffer as billsRowsToXlsxBuffer,
  buildAllInOneRows as billsAllInOneRows,
  CSV_COLUMNS as BILLS_COLUMNS,
} from "@/lib/billsProcessor";
import { buildExportFileName } from "@/lib/fileNaming";

const ENTRY_TYPES = [
  { value: "vip-bills", label: "VIP Bills (Device + Service)" },
  { value: "vip-service", label: "VIP Service Expense" },
  { value: "vip-device", label: "VIP Device Expense" },
  { value: "sales", label: "Sales Journal Entry" },
];

const BILL_CATEGORY_BY_TYPE = {
  "vip-device": "device",
  "vip-service": "service",
  "vip-bills": "all",
};

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

function processorFor(entryType) {
  if (entryType === "sales") {
    return {
      rowsToCsv: salesRowsToCsv,
      rowsToXlsxBuffer: salesRowsToXlsxBuffer,
      allInOne: salesAllInOneRows,
      columns: SALES_COLUMNS,
      kind: "Sale",
      dateKey: "Invoice Date",
    };
  }
  return {
    rowsToCsv: billsRowsToCsv,
    rowsToXlsxBuffer: billsRowsToXlsxBuffer,
    allInOne: billsAllInOneRows,
    columns: BILLS_COLUMNS,
    kind: "Exp",
    dateKey: "Date",
  };
}

export default function JvEntryPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [entryType, setEntryType] = useState("vip-bills");
  const [jvDate, setJvDate] = useState(todayIso());
  const [fileName, setFileName] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { entryType, byCompany, unmatched }
  const [previewOpen, setPreviewOpen] = useState(false);
  const fileInputRef = useRef(null);
  const lastFileRef = useRef(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  const processFile = useCallback(async (file, type, dateStr) => {
    setProcessing(true);
    setError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);

      const buffer = await file.arrayBuffer();
      const jvDateObj = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();

      if (type === "sales") {
        const rawRows = parseSalesWorkbook(buffer);
        if (!rawRows.length) throw new Error("No rows found in this file.");
        if (!("Store" in rawRows[0])) {
          throw new Error("This file doesn't look like a sales export — no 'Store' column found.");
        }
        const { totals } = aggregateByStore(rawRows);
        const { byCompany, unmatchedStores } = buildJournalRows(totals, storeMaster, jvDateObj);
        setResult({ entryType: type, byCompany, unmatched: unmatchedStores, unmappedMemos: [] });
      } else {
        const { data: memoMappings, error: mmError } = await supabase.from("memo_mappings").select("*");
        if (mmError) throw new Error("Could not load memo mappings: " + mmError.message);
        const { data: doorMappings, error: dmError } = await supabase.from("door_mappings").select("*");
        if (dmError) throw new Error("Could not load door mappings: " + dmError.message);

        const rawRows = parseVipWorkbook(buffer);
        if (!rawRows.length) throw new Error("No rows found in the Bill sheet of this file.");
        if (!("Door Number" in rawRows[0])) {
          throw new Error(
            "This file doesn't look like a VIP export — no 'Door Number' column found in the Bill sheet."
          );
        }
        const groupedLines = aggregateBillLines(rawRows, memoMappings || []);
        const category = BILL_CATEGORY_BY_TYPE[type] || "all";
        const { byCompany, unmatchedDoors, unmappedMemos } = buildBillRows(
          groupedLines,
          storeMaster,
          category,
          doorMappings || []
        );
        setResult({ entryType: type, byCompany, unmatched: unmatchedDoors, unmappedMemos });
      }
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
    processFile(file, entryType, jvDate);
  }

  function handleFileChange(e) {
    handleFile(e.target.files?.[0]);
  }

  function handleEntryTypeChange(e) {
    const next = e.target.value;
    setEntryType(next);
    if (lastFileRef.current) processFile(lastFileRef.current, next, jvDate);
  }

  function handleDateChange(e) {
    const next = e.target.value;
    setJvDate(next);
    if (lastFileRef.current) processFile(lastFileRef.current, entryType, next);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  function handlePreview() {
    setPreviewOpen((v) => !v);
  }

  function handleAllInOneXlsx() {
    const fns = processorFor(result.entryType);
    const combined = fns.allInOne(result.byCompany);
    const buf = fns.rowsToXlsxBuffer(combined, "JV");
    triggerDownload(
      new Blob([buf], { type: XLSX_MIME }),
      buildExportFileName("AllCompanies", fns.kind, combined, fns.dateKey, "xlsx")
    );
  }

  function handleAllInOneCsv() {
    const fns = processorFor(result.entryType);
    const combined = fns.allInOne(result.byCompany);
    triggerDownload(
      new Blob([fns.rowsToCsv(combined)], { type: CSV_MIME }),
      buildExportFileName("AllCompanies", fns.kind, combined, fns.dateKey, "csv")
    );
  }

  async function handleCompanyWiseXlsx() {
    const fns = processorFor(result.entryType);
    const companies = Object.entries(result.byCompany);
    if (companies.length <= 1) {
      const [company, rows] = companies[0];
      const buf = fns.rowsToXlsxBuffer(rows, company);
      triggerDownload(
        new Blob([buf], { type: XLSX_MIME }),
        buildExportFileName(company, fns.kind, rows, fns.dateKey, "xlsx")
      );
      return;
    }
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of companies) {
      zip.file(buildExportFileName(company, fns.kind, rows, fns.dateKey, "xlsx"), fns.rowsToXlsxBuffer(rows, company));
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, "JV-CompanyWise.zip");
  }

  async function handleCompanyWiseCsv() {
    const fns = processorFor(result.entryType);
    const companies = Object.entries(result.byCompany);
    if (companies.length <= 1) {
      const [company, rows] = companies[0];
      triggerDownload(
        new Blob([fns.rowsToCsv(rows)], { type: CSV_MIME }),
        buildExportFileName(company, fns.kind, rows, fns.dateKey, "csv")
      );
      return;
    }
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of companies) {
      zip.file(buildExportFileName(company, fns.kind, rows, fns.dateKey, "csv"), fns.rowsToCsv(rows));
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, "JV-CompanyWise.zip");
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const fns = result ? processorFor(result.entryType) : null;
  const combinedPreviewRows = fns ? fns.allInOne(result.byCompany) : [];
  const totalRows = combinedPreviewRows.length;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>📋 JV Entry</h1>
        </div>

        <div style={styles.card}>
          <div style={styles.cardLabel}>JV Entry Generator</div>

          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>Entry Type</span>
              <select style={styles.entryTypeSelect} value={entryType} onChange={handleEntryTypeChange}>
                {ENTRY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>JV Date</span>
              <input type="date" style={styles.dateInput} value={jvDate} onChange={handleDateChange} />
            </label>

            <div style={{ ...styles.fieldBlock, flex: 1.4 }}>
              <span style={styles.fieldLabel}>Upload File</span>
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
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleFileChange}
                  style={{ display: "none" }}
                />
                <div style={styles.dropzoneIcon}>📄</div>
                <div style={styles.dropzoneText}>{fileName || "CSV or XLSX file"}</div>
              </div>
            </div>
          </div>

          <div style={styles.actionsRow}>
            <button style={styles.previewBtn} onClick={handlePreview} disabled={!result}>
              👁 Preview JV
            </button>
            <button style={styles.xlsxBtn} onClick={handleAllInOneXlsx} disabled={!result || totalRows === 0}>
              📘 All-in-One XLSX
            </button>
            <button style={styles.csvBtnMuted} onClick={handleAllInOneCsv} disabled={!result || totalRows === 0}>
              All-in-One CSV
            </button>
            <button style={styles.greenBtn} onClick={handleCompanyWiseXlsx} disabled={!result || totalRows === 0}>
              📗 Company-wise XLSX
            </button>
            <button style={styles.csvBtnMuted} onClick={handleCompanyWiseCsv} disabled={!result || totalRows === 0}>
              Company-wise CSV
            </button>
          </div>
        </div>

        {processing && <div style={styles.info}>Processing…</div>}
        {error && <div style={styles.errorBanner}>{error}</div>}

        {result && result.unmatched.length > 0 && (
          <div style={styles.warnBanner}>
            {result.unmatched.length} {result.entryType === "sales" ? "store name(s)" : "door number(s)"} in
            the file don't match any store in your Store Master, so they were skipped:{" "}
            <strong>{result.unmatched.join(", ")}</strong>.
            {result.entryType !== "sales" && (
              <>
                {" "}
                Add them in{" "}
                <Link href="/mappings" style={styles.inlineLink}>
                  Door Mapping
                </Link>{" "}
                or add the store in Store Master, then re-upload.
              </>
            )}
          </div>
        )}

        {result && result.unmappedMemos.length > 0 && (
          <div style={styles.errorBanner}>
            {result.unmappedMemos.length} line(s) have a Memo that doesn't match a known device or service
            pattern, so they were skipped. Add the memo text below to{" "}
            <Link href="/mappings" style={styles.inlineLink}>
              Memo Mapping
            </Link>{" "}
            and re-upload:
            <ul style={styles.unmappedList}>
              {result.unmappedMemos.map((m, i) => (
                <li key={i}>
                  Door {m.doorNumber} · {m.invoiceNo} · "{m.memo}"
                </li>
              ))}
            </ul>
          </div>
        )}

        {result && totalRows > 0 && (
          <>
            <div style={styles.resultsHeader}>
              <h2 style={styles.h2}>
                {Object.keys(result.byCompany).length} compan
                {Object.keys(result.byCompany).length === 1 ? "y" : "ies"} · {totalRows} line
                {totalRows === 1 ? "" : "s"}
              </h2>
            </div>

            {previewOpen && (
              <div style={styles.previewWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {fns.columns.map((c) => (
                        <th key={c} style={styles.th}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {combinedPreviewRows.map((r, i) => (
                      <tr key={i} style={styles.tr}>
                        {fns.columns.map((c) => (
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

            <div style={styles.companyGrid}>
              {Object.entries(result.byCompany).map(([company, rows]) => (
                <div key={company} style={styles.companyCard}>
                  <div>
                    <div style={styles.companyName}>{company}</div>
                    <div style={styles.companyMeta}>{rows.length} line(s)</div>
                  </div>
                </div>
              ))}
            </div>
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
  main: { flex: 1, padding: "36px 44px", maxWidth: 1200 },
  topRow: { marginBottom: 24 },
  h1: { fontFamily: "var(--font-display)", fontSize: 22, margin: 0, display: "flex", alignItems: "center", gap: 8 },
  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: 0 },
  card: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 24,
    marginBottom: 20,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--ink-soft)",
    marginBottom: 18,
  },
  fieldRow: { display: "flex", gap: 20, marginBottom: 22, flexWrap: "wrap" },
  fieldBlock: { display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 200 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--ink-soft)",
  },
  entryTypeSelect: {
    padding: "11px 12px",
    borderRadius: 8,
    border: "1px solid var(--danger)",
    fontSize: 14,
    background: "var(--field)",
    color: "var(--ink)",
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
    minHeight: 68,
    cursor: "pointer",
    textAlign: "center",
  },
  dropzoneActive: { borderColor: "var(--ledger)", background: "rgba(34,163,123,0.06)" },
  dropzoneIcon: { fontSize: 18 },
  dropzoneText: { fontSize: 12.5, color: "var(--ink-soft)" },
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap" },
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
  greenBtn: {
    background: "var(--ledger)",
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
  unmappedList: {
    margin: "8px 0 0",
    paddingLeft: 18,
    fontFamily: "var(--font-mono)",
    fontSize: 12,
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
  resultsHeader: { marginBottom: 14 },
  previewWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    maxHeight: 420,
    marginBottom: 20,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: {
    textAlign: "left",
    padding: "10px 14px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    position: "sticky",
    top: 0,
    background: "var(--panel)",
  },
  tr: { borderBottom: "1px solid var(--line)" },
  td: {
    padding: "9px 14px",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  companyGrid: { display: "flex", flexWrap: "wrap", gap: 10 },
  companyCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: "12px 16px",
    minWidth: 160,
  },
  companyName: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13.5 },
  companyMeta: { fontSize: 11.5, color: "var(--ink-soft)", marginTop: 2 },
};
