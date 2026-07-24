"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  parseVipWorkbook,
  aggregateBillLines,
  buildBillRows,
  rowsToCsv,
  rowsToXlsxBuffer,
  CSV_COLUMNS,
} from "@/lib/billsProcessor";
import { buildExportFileName } from "@/lib/fileNaming";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

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

export default function BillsPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [fileName, setFileName] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { byCompany, unmatched }
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set());
  const fileInputRef = useRef(null);

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
    setResult(null);
    setPreviewOpen(false);
    try {
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);
      const { data: memoMappings, error: mmError } = await supabase.from("memo_mappings").select("*");
      if (mmError) throw new Error("Could not load memo mappings: " + mmError.message);
      const { data: doorMappings, error: dmError } = await supabase.from("door_mappings").select("*");
      if (dmError) throw new Error("Could not load door mappings: " + dmError.message);

      const buffer = await file.arrayBuffer();
      const rawRows = parseVipWorkbook(buffer);
      if (!rawRows.length) throw new Error("No rows found in the Bill sheet of this file.");
      if (!("Door Number" in rawRows[0])) {
        throw new Error(
          "This file doesn't look like a VIP export — no 'Door Number' column found in the Bill sheet."
        );
      }

      const groupedLines = aggregateBillLines(rawRows, memoMappings || []);
      const { byCompany, unmatchedDoors, unmappedMemos } = buildBillRows(
        groupedLines,
        storeMaster,
        "all",
        doorMappings || []
      );
      setResult({ byCompany, unmatched: unmatchedDoors, unmappedMemos });
      setSelectedCompanies(new Set(Object.keys(byCompany)));
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

  async function downloadCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, company);
    triggerDownload(
      new Blob([buf], { type: XLSX_MIME }),
      buildExportFileName(company, "Exp", rows, "Date", "xlsx")
    );
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(
      new Blob([rowsToCsv(rows)], { type: CSV_MIME }),
      buildExportFileName(company, "Exp", rows, "Date", "csv")
    );
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "Exp", rows, "Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "Exp", rows, "Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Bills-AllCompanies-${format}.zip`);
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
            <h1 style={styles.h1}>Bills</h1>
            <p style={styles.pageSub}>
              Upload the VIP export — device and service lines come back together, one file per company
            </p>
          </div>
        </div>

        <div style={styles.card}>
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
            <div style={styles.dropzoneText}>{fileName || "Choose or drop VIP export (.xlsx)"}</div>
          </div>
        </div>

        {processing && <div style={styles.info}>Processing…</div>}
        {error && <div style={styles.errorBanner}>{error}</div>}

        {result && result.unmatched.length > 0 && (
          <div style={styles.warnBanner}>
            {result.unmatched.length} door number(s) in the file don't match any store in your Store
            Master, so they were skipped: <strong>{result.unmatched.join(", ")}</strong>. Add them in{" "}
            <Link href="/mappings" style={styles.inlineLink}>
              Door Mapping
            </Link>{" "}
            or add the store in Store Master, then re-upload.
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
                {companyEntries.length} compan{companyEntries.length === 1 ? "y" : "ies"} · {totalRows} bill
                line{totalRows === 1 ? "" : "s"}
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
                      <span style={styles.companyMeta}>{rows.length} bill line(s)</span>
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
  h1: { fontFamily: "var(--font-display)", fontSize: 26, margin: 0 },
  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: 0 },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0" },
  card: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 20,
    marginBottom: 20,
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
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 },
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
  tr: { borderBottom: "1px solid var(--line)" },
  td: {
    padding: "6px 10px",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    whiteSpace: "nowrap",
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
