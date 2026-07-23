"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  parseSalesWorkbook,
  aggregateByStore,
  buildJournalRows,
  rowsToCsv,
} from "@/lib/salesProcessor";

export default function SalesPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [fileName, setFileName] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { byCompany, unmatchedStores, invoiceDate }
  const [invoiceDateOverride, setInvoiceDateOverride] = useState("");
  const fileInputRef = useRef(null);
  const lastFileRef = useRef(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  const processFile = useCallback(
    async (file, dateOverrideStr) => {
      setProcessing(true);
      setError("");
      setResult(null);
      try {
        const supabase = createClient();
        const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
        if (smError) throw new Error("Could not load Store Master: " + smError.message);

        const buffer = await file.arrayBuffer();
        const rawRows = parseSalesWorkbook(buffer);
        if (!rawRows.length) throw new Error("No rows found in this file.");
        if (!("Store" in rawRows[0])) {
          throw new Error(
            "This file doesn't look like a sales export — no 'Store' column found."
          );
        }

        const { totals, latestDate } = aggregateByStore(rawRows);
        const invoiceDate = dateOverrideStr ? new Date(dateOverrideStr) : latestDate || new Date();

        const { byCompany, unmatchedStores } = buildJournalRows(totals, storeMaster, invoiceDate);

        setResult({ byCompany, unmatchedStores, invoiceDate });
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        setProcessing(false);
      }
    },
    []
  );

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    lastFileRef.current = file;
    processFile(file, invoiceDateOverride);
  }

  function handleReprocessWithDate() {
    if (lastFileRef.current) processFile(lastFileRef.current, invoiceDateOverride);
  }

  function downloadCompanyCsv(company, rows) {
    const csv = rowsToCsv(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Sales-${company.replace(/[^a-z0-9]+/gi, "_")}-Upload.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadAllZip() {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      zip.file(`Sales-${company.replace(/[^a-z0-9]+/gi, "_")}-Upload.csv`, rowsToCsv(rows));
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Sales-Journals.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <div>
            <h1 style={styles.h1}>Sales Upload</h1>
            <p style={styles.pageSub}>
              Upload the raw sales export — get back QBO-ready journal CSVs, one per company
            </p>
          </div>
        </div>

        <div style={styles.uploadCard}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
          <button style={styles.primaryBtn} onClick={() => fileInputRef.current?.click()}>
            {fileName ? "Choose a different file" : "Choose sales file (.xlsx)"}
          </button>
          {fileName && <span style={styles.fileName}>{fileName}</span>}

          <div style={styles.dateRow}>
            <label style={styles.dateLabel}>
              Invoice date (defaults to the latest transaction date in the file)
            </label>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                type="date"
                value={invoiceDateOverride}
                onChange={(e) => setInvoiceDateOverride(e.target.value)}
                style={styles.dateInput}
              />
              <button
                style={styles.secondaryBtn}
                onClick={handleReprocessWithDate}
                disabled={!lastFileRef.current || processing}
              >
                Apply date
              </button>
            </div>
          </div>
        </div>

        {processing && <div style={styles.info}>Processing…</div>}
        {error && <div style={styles.errorBanner}>{error}</div>}

        {result && (
          <>
            {result.unmatchedStores.length > 0 && (
              <div style={styles.warnBanner}>
                {result.unmatchedStores.length} store name(s) in the sales file don't match any
                store in your Store Master, so they were skipped:{" "}
                <strong>{result.unmatchedStores.join(", ")}</strong>. Check spelling against the
                "Elevate Name" field in Store Master.
              </div>
            )}

            <div style={styles.resultsHeader}>
              <h2 style={styles.h2}>
                {Object.keys(result.byCompany).length} compan
                {Object.keys(result.byCompany).length === 1 ? "y" : "ies"} ready
              </h2>
              {Object.keys(result.byCompany).length > 1 && (
                <button style={styles.primaryBtn} onClick={downloadAllZip}>
                  Download all (.zip)
                </button>
              )}
            </div>

            <div style={styles.companyGrid}>
              {Object.entries(result.byCompany).map(([company, rows]) => (
                <div key={company} style={styles.companyCard}>
                  <div>
                    <div style={styles.companyName}>{company}</div>
                    <div style={styles.companyMeta}>{rows.length} journal lines</div>
                  </div>
                  <button
                    style={styles.secondaryBtn}
                    onClick={() => downloadCompanyCsv(company, rows)}
                  >
                    Download CSV
                  </button>
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
  main: { flex: 1, padding: "36px 44px", maxWidth: 1000 },
  topRow: { marginBottom: 24 },
  h1: { fontFamily: "var(--font-display)", fontSize: 26, margin: 0 },
  h2: { fontFamily: "var(--font-display)", fontSize: 17, margin: 0 },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0" },
  uploadCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 18,
    marginBottom: 20,
  },
  primaryBtn: {
    background: "var(--ledger)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
    alignSelf: "flex-start",
  },
  secondaryBtn: {
    background: "#fff",
    color: "var(--ink)",
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: "9px 14px",
    fontSize: 13,
    fontWeight: 600,
  },
  fileName: { fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ink-soft)" },
  dateRow: { display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 16 },
  dateLabel: { fontSize: 12, color: "var(--ink-soft)" },
  dateInput: {
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
  },
  info: { fontSize: 13, color: "var(--ink-soft)", marginBottom: 14 },
  errorBanner: {
    background: "#fbeeea",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
  },
  warnBanner: {
    background: "#fdf3e3",
    color: "#8a5a10",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
    lineHeight: 1.5,
  },
  resultsHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  companyGrid: { display: "flex", flexDirection: "column", gap: 10 },
  companyCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: "14px 18px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  companyName: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 14 },
  companyMeta: { fontSize: 12, color: "var(--ink-soft)", marginTop: 2 },
};
