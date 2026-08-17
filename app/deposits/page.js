"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  parseXReportWorkbook,
  buildDepositRows,
  ALL_DATA_COLUMNS,
  COMPANY_COLUMNS,
  rowsToCsv,
  rowsToXlsxBuffer,
} from "@/lib/depositsProcessor";
import { formatMMDDYYYYFromIso } from "@/lib/payrollProcessor";
import { buildExportFileName } from "@/lib/fileNaming";
import { buildStoreNameMap, remapStoreNamesInRows } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";
import { triggerDownload, todayIso } from "@/lib/download";
import { sharedPageStyles } from "@/lib/pageStyles";

const STATE_KEY = "deposits";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

export default function DepositsPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;

  const [depositDate, setDepositDate] = useState(saved?.depositDate ?? todayIso());
  const [receivedFrom, setReceivedFrom] = useState(saved?.receivedFrom ?? "ELEVATE");
  const [fromAccount, setFromAccount] = useState(saved?.fromAccount ?? "Accounts Receivable");
  const [memo, setMemo] = useState(saved?.memo ?? "Deposit");

  const [storeMaster, setStoreMaster] = useState(null);
  const [storeMasterError, setStoreMasterError] = useState("");
  const [storeNameMap, setStoreNameMap] = useState({});
  const [accountMappings, setAccountMappings] = useState(null);

  const [fileName, setFileName] = useState(saved?.fileName ?? null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [rawRows, setRawRows] = useState(null);

  // result is derived (small) — not the raw parsed rows, same reasoning as
  // every other upload page's pageState.
  const [result, setResult] = useState(saved?.result ?? null); // { rows, byCompany, unmatchedStores, unmatchedTenderTypes }
  const [previewOpen, setPreviewOpen] = useState(saved?.previewOpen ?? false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set(saved?.selectedCompanies ?? []));

  const fileInputRef = useRef(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  useEffect(() => {
    savePageState(STATE_KEY, {
      depositDate,
      receivedFrom,
      fromAccount,
      memo,
      fileName,
      result,
      previewOpen,
      selectedCompanies: Array.from(selectedCompanies),
    });
  }, [depositDate, receivedFrom, fromAccount, memo, fileName, result, previewOpen, selectedCompanies]);

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

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("deposit_account_mappings")
      .select("*")
      .then(({ data, error }) => {
        if (error) setError("Could not load Deposit Account Mapping: " + error.message);
        else setAccountMappings(data || []);
      });
  }, [session]);

  // Received From / From Account / Memo default from Mapping Master's AR
  // Deposits > Defaults (edited there) — only applied if this browser
  // session hasn't already got its own saved/edited value for this run.
  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("deposit_defaults")
      .select("*")
      .then(({ data, error }) => {
        if (error || !data) return;
        const byKey = {};
        for (const r of data) byKey[r.key] = r.value;
        if (saved?.receivedFrom == null && byKey.received_from != null) setReceivedFrom(byKey.received_from);
        if (saved?.fromAccount == null && byKey.from_account != null) setFromAccount(byKey.from_account);
        if (saved?.memo == null && byKey.memo != null) setMemo(byKey.memo);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const processFile = useCallback(async (file) => {
    setError("");
    setRawRows(null);
    try {
      const buffer = await file.arrayBuffer();
      const rows = parseXReportWorkbook(buffer);
      if (!rows.length) {
        throw new Error("No per-store Tendered Amounts sections found in this file.");
      }
      setRawRows(rows);
    } catch (e) {
      setError(e.message || String(e));
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

  useEffect(() => {
    if (!rawRows || !storeMaster || !accountMappings || !depositDate) return;
    const computed = buildDepositRows(
      rawRows,
      storeMaster,
      storeNameMap,
      accountMappings,
      formatMMDDYYYYFromIso(depositDate),
      { receivedFrom, fromAccount, memo }
    );
    setResult(computed);
    setSelectedCompanies(new Set(Object.keys(computed.byCompany)));
    setPreviewOpen(false);
    savePendingMappings({
      unmatchedStoreNames: computed.unmatchedStores,
      unmatchedTenderTypes: computed.unmatchedTenderTypes,
    });
  }, [rawRows, storeMaster, storeNameMap, accountMappings, depositDate, receivedFrom, fromAccount, memo]);

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

  function downloadAllData(format) {
    if (!result) return;
    if (format === "xlsx") {
      const buf = rowsToXlsxBuffer(result.rows, ALL_DATA_COLUMNS, "All Data");
      triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName("AllData", "ARDeposit", result.rows, "Deposit Date", "xlsx"));
    } else {
      triggerDownload(
        new Blob([rowsToCsv(result.rows, ALL_DATA_COLUMNS)], { type: CSV_MIME }),
        buildExportFileName("AllData", "ARDeposit", result.rows, "Deposit Date", "csv")
      );
    }
  }

  function downloadCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, COMPANY_COLUMNS, company);
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "ARDeposit", rows, "Deposit Date", "xlsx"));
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(
      new Blob([rowsToCsv(rows, COMPANY_COLUMNS)], { type: CSV_MIME }),
      buildExportFileName(company, "ARDeposit", rows, "Deposit Date", "csv")
    );
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "ARDeposit", rows, "Deposit Date", "xlsx"), rowsToXlsxBuffer(rows, COMPANY_COLUMNS, company));
      } else {
        zip.file(buildExportFileName(company, "ARDeposit", rows, "Deposit Date", "csv"), rowsToCsv(rows, COMPANY_COLUMNS));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `ARDeposits-AllCompanies-${format}.zip`);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const rowsTotal = (rows) => rows.reduce((sum, r) => sum + (Number(r["Deposit Amount"]) || 0), 0);
  const grandTotal = companyEntries.reduce((sum, [, rows]) => sum + rowsTotal(rows), 0);

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>AR Deposits</h1>
          <p style={styles.pageSub}>
            Upload an X-Report export — each store's Cash/Card/Financing tender totals become one AR
            Deposit line per store, matched to Store Master and the Deposit Account mapping.
          </p>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>1. Deposit Date & upload</h2>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>Deposit Date</span>
              <input type="date" style={styles.dateInput} value={depositDate} onChange={(e) => setDepositDate(e.target.value)} />
            </label>
          </div>

          {storeMasterError && <div style={styles.errorBanner}>{storeMasterError}</div>}

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
            <div style={styles.dropzoneText}>{fileName || "Choose or drop X-Report export"}</div>
          </div>
          {rawRows && !error && <div style={styles.info}>{rawRows.length} tender line(s) found across all stores.</div>}
          {error && <div style={styles.errorBanner}>{error}</div>}

          {result && result.unmatchedStores.length > 0 && (
            <div style={styles.warnBanner}>
              {result.unmatchedStores.length} store name(s) in the file don't match any store's Elevate Name in
              Store Master, so their deposits were excluded: <strong>{result.unmatchedStores.join(", ")}</strong>.
              Add them on Mapping Master's Store Mapping tab.
            </div>
          )}

          {result && result.unmatchedTenderTypes.length > 0 && (
            <div style={styles.warnBanner}>
              {result.unmatchedTenderTypes.length} tender type(s) have no Deposit Account mapping yet, so those
              lines used a blank Deposit To Account/Payment Method:{" "}
              <strong>{result.unmatchedTenderTypes.join(", ")}</strong>. Add them on Mapping Master's AR Deposits
              tab.
            </div>
          )}
        </div>

        {result && totalRows > 0 && (
          <>
            <div style={styles.actionsRow}>
              <button style={styles.xlsxBtn} onClick={() => downloadAllData("xlsx")}>
                📘 Download All Data (XLSX)
              </button>
              <button style={styles.csvBtnMuted} onClick={() => downloadAllData("csv")}>
                Download All Data (CSV)
              </button>
            </div>

            <div style={styles.actionsRow}>
              <button style={styles.previewBtn} onClick={() => setPreviewOpen((v) => !v)}>
                👁 {previewOpen ? "Hide preview" : "Preview selected"}
              </button>
              <button style={styles.xlsxBtn} onClick={() => downloadAllZip("xlsx")}>
                📘 Download by company (XLSX)
              </button>
              <button style={styles.csvBtnMuted} onClick={() => downloadAllZip("csv")}>
                Download by company (CSV)
              </button>
            </div>

            <div style={styles.resultsHeader}>
              <h2 style={styles.h2}>
                {companyEntries.length} compan{companyEntries.length === 1 ? "y" : "ies"} · {totalRows} deposit
                line{totalRows === 1 ? "" : "s"} · Total ${grandTotal.toFixed(2)}
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
                      <span style={styles.companyMeta}>
                        {rows.length} deposit line(s) · ${rowsTotal(rows).toFixed(2)}
                      </span>
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
                    const total = rows.reduce((sum, r) => sum + (Number(r["Deposit Amount"]) || 0), 0);
                    return (
                      <div key={company} style={styles.previewGroup}>
                        <div style={styles.previewGroupHeader}>
                          <span style={styles.companyName}>{company}</span>
                          <span style={styles.balanceOk}>
                            {rows.length} line{rows.length === 1 ? "" : "s"} · ${total.toFixed(2)}
                          </span>
                        </div>
                        <div style={styles.previewWrap}>
                          <table style={styles.table}>
                            <thead>
                              <tr>
                                {COMPANY_COLUMNS.map((c) => (
                                  <th key={c} style={styles.th}>
                                    {c}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((r, i) => (
                                <tr key={i} style={styles.tr}>
                                  {COMPANY_COLUMNS.map((c) => (
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
  ...sharedPageStyles,

  main: { flex: 1, padding: "36px 44px", maxWidth: 1300 },

  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 14px" },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0" },

  fieldRow: { display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 },
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
    padding: "22px 12px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    cursor: "pointer",
    textAlign: "center",
  },
  dropzoneIcon: { fontSize: 22 },
  info: { fontSize: 13, color: "var(--ink-soft)", marginTop: 10 },
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
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, alignItems: "center" },

  previewWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    maxHeight: 420,
    marginBottom: 20,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 11.5 },
  th: {
    textAlign: "left",
    padding: "9px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 9.5,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
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
};
