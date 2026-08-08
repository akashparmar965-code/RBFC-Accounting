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
import {
  parseEpayWorkbook,
  buildEpayRows,
  rowsToCsv as epayRowsToCsv,
  rowsToXlsxBuffer as epayRowsToXlsxBuffer,
  INCOME_COLUMNS,
  PURCHASE_COLUMNS,
} from "@/lib/epayProcessor";
import { parseOndigoWorkbook, buildOndigoBillRows } from "@/lib/ondigoProcessor";
import { buildExportFileName } from "@/lib/fileNaming";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";
import { triggerDownload } from "@/lib/download";
import { sharedPageStyles } from "@/lib/pageStyles";

const STATE_KEY = "bills";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

export default function BillsPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;
  const [activeTab, setActiveTab] = useState(saved?.activeTab ?? "vip");

  // ---- VIP tab state ----
  const [fileName, setFileName] = useState(saved?.fileName ?? null);
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(saved?.result ?? null); // { byCompany, unmatched, unmappedProducts }
  const [previewOpen, setPreviewOpen] = useState(saved?.previewOpen ?? false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set(saved?.selectedCompanies ?? []));
  const fileInputRef = useRef(null);

  // ---- Epay tab state ----
  const [epayFileName, setEpayFileName] = useState(saved?.epayFileName ?? null);
  const [epayDragOver, setEpayDragOver] = useState(false);
  const [epayProcessing, setEpayProcessing] = useState(false);
  const [epayError, setEpayError] = useState("");
  const [epayResult, setEpayResult] = useState(saved?.epayResult ?? null); // { incomeByCompany, purchaseByCompany, unmatchedAccounts }
  const [epayPreviewOpen, setEpayPreviewOpen] = useState(saved?.epayPreviewOpen ?? false);
  const [epaySelectedCompanies, setEpaySelectedCompanies] = useState(new Set(saved?.epaySelectedCompanies ?? []));
  const epayFileInputRef = useRef(null);

  // ---- Ondigo tab state ----
  const [ondigoFileName, setOndigoFileName] = useState(saved?.ondigoFileName ?? null);
  const [ondigoDragOver, setOndigoDragOver] = useState(false);
  const [ondigoProcessing, setOndigoProcessing] = useState(false);
  const [ondigoError, setOndigoError] = useState("");
  const [ondigoResult, setOndigoResult] = useState(saved?.ondigoResult ?? null); // { byCompany, unmatchedAddresses }
  const [ondigoPreviewOpen, setOndigoPreviewOpen] = useState(saved?.ondigoPreviewOpen ?? false);
  const [ondigoSelectedCompanies, setOndigoSelectedCompanies] = useState(new Set(saved?.ondigoSelectedCompanies ?? []));
  const ondigoFileInputRef = useRef(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  useEffect(() => {
    savePageState(STATE_KEY, {
      activeTab,
      fileName,
      result,
      previewOpen,
      selectedCompanies: Array.from(selectedCompanies),
      epayFileName,
      epayResult,
      epayPreviewOpen,
      epaySelectedCompanies: Array.from(epaySelectedCompanies),
      ondigoFileName,
      ondigoResult,
      ondigoPreviewOpen,
      ondigoSelectedCompanies: Array.from(ondigoSelectedCompanies),
    });
  }, [
    activeTab,
    fileName,
    result,
    previewOpen,
    selectedCompanies,
    epayFileName,
    epayResult,
    epayPreviewOpen,
    epaySelectedCompanies,
    ondigoFileName,
    ondigoResult,
    ondigoPreviewOpen,
    ondigoSelectedCompanies,
  ]);

  // ===================== VIP =====================

  const processFile = useCallback(async (file) => {
    setProcessing(true);
    setError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);
      const { data: productMappings, error: pmError } = await supabase.from("product_mappings").select("*");
      if (pmError) throw new Error("Could not load product mappings: " + pmError.message);
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

      const groupedLines = aggregateBillLines(rawRows, productMappings || []);
      const { byCompany, unmatchedDoors, unmappedProducts } = buildBillRows(
        groupedLines,
        storeMaster,
        "all",
        doorMappings || []
      );
      setResult({ byCompany, unmatched: unmatchedDoors, unmappedProducts });
      setSelectedCompanies(new Set(Object.keys(byCompany)));
      savePendingMappings({ unmatchedDoors, unmappedProducts });
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

  // ===================== Epay =====================

  const processEpayFile = useCallback(async (file) => {
    setEpayProcessing(true);
    setEpayError("");
    setEpayResult(null);
    setEpayPreviewOpen(false);
    try {
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);
      const { data: accountMappings, error: amError } = await supabase
        .from("epay_account_mappings")
        .select("*");
      if (amError) throw new Error("Could not load Epay account mappings: " + amError.message);

      const buffer = await file.arrayBuffer();
      const rawRows = parseEpayWorkbook(buffer);
      if (!rawRows.length) throw new Error("No rows found in this file.");
      if (!("Account Number" in rawRows[0])) {
        throw new Error("This file doesn't look like an Epay export — no 'Account Number' column found.");
      }

      const { incomeByCompany, purchaseByCompany, unmatchedAccounts } = buildEpayRows(
        rawRows,
        storeMaster,
        accountMappings || []
      );
      setEpayResult({ incomeByCompany, purchaseByCompany, unmatchedAccounts });
      setEpaySelectedCompanies(
        new Set([...Object.keys(incomeByCompany), ...Object.keys(purchaseByCompany)])
      );
      savePendingMappings({ unmatchedAccounts });
    } catch (e) {
      setEpayError(e.message || String(e));
    } finally {
      setEpayProcessing(false);
    }
  }, []);

  function handleEpayFile(file) {
    if (!file) return;
    setEpayFileName(file.name);
    processEpayFile(file);
  }

  function handleEpayFileChange(e) {
    handleEpayFile(e.target.files?.[0]);
  }

  function handleEpayDrop(e) {
    e.preventDefault();
    setEpayDragOver(false);
    handleEpayFile(e.dataTransfer.files?.[0]);
  }

  function downloadEpayCompanyXlsx(kind, company, rows) {
    const columns = kind === "income" ? INCOME_COLUMNS : PURCHASE_COLUMNS;
    const dateKey = kind === "income" ? "Invoice Date" : "Date";
    const buf = epayRowsToXlsxBuffer(rows, columns, company);
    triggerDownload(
      new Blob([buf], { type: XLSX_MIME }),
      buildExportFileName(company, kind === "income" ? "Income" : "Purchase", rows, dateKey, "xlsx")
    );
  }

  function downloadEpayCompanyCsv(kind, company, rows) {
    const columns = kind === "income" ? INCOME_COLUMNS : PURCHASE_COLUMNS;
    const dateKey = kind === "income" ? "Invoice Date" : "Date";
    triggerDownload(
      new Blob([epayRowsToCsv(rows, columns)], { type: CSV_MIME }),
      buildExportFileName(company, kind === "income" ? "Income" : "Purchase", rows, dateKey, "csv")
    );
  }

  async function downloadAllEpayZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(epayResult.incomeByCompany)) {
      const name = buildExportFileName(company, "Income", rows, "Invoice Date", format);
      zip.file(name, format === "xlsx" ? epayRowsToXlsxBuffer(rows, INCOME_COLUMNS, company) : epayRowsToCsv(rows, INCOME_COLUMNS));
    }
    for (const [company, rows] of Object.entries(epayResult.purchaseByCompany)) {
      const name = buildExportFileName(company, "Purchase", rows, "Date", format);
      zip.file(name, format === "xlsx" ? epayRowsToXlsxBuffer(rows, PURCHASE_COLUMNS, company) : epayRowsToCsv(rows, PURCHASE_COLUMNS));
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Epay-AllCompanies-${format}.zip`);
  }

  function toggleEpayCompany(company) {
    setEpaySelectedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  function toggleEpaySelectAll(allCompanyNames, checked) {
    setEpaySelectedCompanies(checked ? new Set(allCompanyNames) : new Set());
  }

  // ===================== Ondigo =====================

  const processOndigoFile = useCallback(async (file) => {
    setOndigoProcessing(true);
    setOndigoError("");
    setOndigoResult(null);
    setOndigoPreviewOpen(false);
    try {
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);
      const { data: addressMappings, error: amError } = await supabase.from("ondigo_address_mappings").select("*");
      if (amError) throw new Error("Could not load Ondigo address mappings: " + amError.message);
      const { data: ondigoDefaultRows, error: odError } = await supabase.from("ondigo_defaults").select("*");
      if (odError) throw new Error("Could not load Ondigo defaults: " + odError.message);
      const defaultsByKey = {};
      for (const r of ondigoDefaultRows || []) defaultsByKey[r.key] = r.value;

      const buffer = await file.arrayBuffer();
      const rawRows = parseOndigoWorkbook(buffer);
      if (!rawRows.length) throw new Error("No rows found in this file.");
      if (!("Invoice #" in rawRows[0]) || !("Store/Location" in rawRows[0])) {
        throw new Error(
          "This file doesn't look like an Ondigo export — no 'Invoice #'/'Store/Location' column found."
        );
      }

      const { byCompany, unmatchedAddresses } = buildOndigoBillRows(rawRows, storeMaster, addressMappings || [], {
        vendor: defaultsByKey.vendor,
        expenseAccount: defaultsByKey.expense_account,
      });
      setOndigoResult({ byCompany, unmatchedAddresses });
      setOndigoSelectedCompanies(new Set(Object.keys(byCompany)));
      savePendingMappings({ unmatchedOndigoAddresses: unmatchedAddresses });
    } catch (e) {
      setOndigoError(e.message || String(e));
    } finally {
      setOndigoProcessing(false);
    }
  }, []);

  function handleOndigoFile(file) {
    if (!file) return;
    setOndigoFileName(file.name);
    processOndigoFile(file);
  }

  function handleOndigoFileChange(e) {
    handleOndigoFile(e.target.files?.[0]);
  }

  function handleOndigoDrop(e) {
    e.preventDefault();
    setOndigoDragOver(false);
    handleOndigoFile(e.dataTransfer.files?.[0]);
  }

  async function downloadOndigoCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, company);
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "Exp", rows, "Date", "xlsx"));
  }

  function downloadOndigoCompanyCsv(company, rows) {
    triggerDownload(
      new Blob([rowsToCsv(rows)], { type: CSV_MIME }),
      buildExportFileName(company, "Exp", rows, "Date", "csv")
    );
  }

  async function downloadAllOndigoZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(ondigoResult.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "Exp", rows, "Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "Exp", rows, "Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Bills-Ondigo-AllCompanies-${format}.zip`);
  }

  function toggleOndigoCompany(company) {
    setOndigoSelectedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  function toggleOndigoSelectAll(allCompanyNames, checked) {
    setOndigoSelectedCompanies(checked ? new Set(allCompanyNames) : new Set());
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);

  const epayCompanyNames = epayResult
    ? Array.from(new Set([...Object.keys(epayResult.incomeByCompany), ...Object.keys(epayResult.purchaseByCompany)])).sort()
    : [];
  const epayTotalRows = epayCompanyNames.reduce(
    (sum, c) =>
      sum + (epayResult.incomeByCompany[c]?.length || 0) + (epayResult.purchaseByCompany[c]?.length || 0),
    0
  );

  const ondigoCompanyEntries = ondigoResult ? Object.entries(ondigoResult.byCompany) : [];
  const ondigoTotalRows = ondigoCompanyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <div>
            <h1 style={styles.h1}>Bills</h1>
            <p style={styles.pageSub}>
              {activeTab === "vip"
                ? "Upload the VIP export — device and service lines come back together, one file per company"
                : activeTab === "epay"
                ? "Upload the Epay invoices export — get income and purchase uploads, one pair per company"
                : "Upload the Ondigo invoices export — matched by store address, one file per company"}
            </p>
          </div>
        </div>

        <div style={styles.tabRow}>
          <button
            style={activeTab === "vip" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("vip")}
          >
            VIP
          </button>
          <button
            style={activeTab === "epay" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("epay")}
          >
            Epay
          </button>
          <button
            style={activeTab === "ondigo" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("ondigo")}
          >
            Ondigo
          </button>
        </div>

        {activeTab === "vip" && (
          <>
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

            {result && result.unmappedProducts.length > 0 && (
              <div style={styles.errorBanner}>
                {result.unmappedProducts.length} line(s) have a Product that doesn't match a known mapping,
                so they were skipped. Add the product text below to{" "}
                <Link href="/mappings" style={styles.inlineLink}>
                  Product Mapping
                </Link>{" "}
                and re-upload:
                <ul style={styles.unmappedList}>
                  {result.unmappedProducts.map((m, i) => (
                    <li key={i}>
                      Door {m.doorNumber} · {m.invoiceNo} · "{m.product}"
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
                    {companyEntries.length} compan{companyEntries.length === 1 ? "y" : "ies"} · {totalRows}{" "}
                    bill line{totalRows === 1 ? "" : "s"}
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
          </>
        )}

        {activeTab === "epay" && (
          <>
            <div style={styles.card}>
              <input
                ref={epayFileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleEpayFileChange}
                style={{ display: "none" }}
              />
              <div
                style={{ ...styles.dropzone, ...(epayDragOver ? styles.dropzoneActive : {}) }}
                onClick={() => epayFileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setEpayDragOver(true);
                }}
                onDragLeave={() => setEpayDragOver(false)}
                onDrop={handleEpayDrop}
              >
                <div style={styles.dropzoneIcon}>📄</div>
                <div style={styles.dropzoneText}>{epayFileName || "Choose or drop Epay invoices export (.csv/.xlsx)"}</div>
              </div>
            </div>

            {epayProcessing && <div style={styles.info}>Processing…</div>}
            {epayError && <div style={styles.errorBanner}>{epayError}</div>}

            {epayResult && epayResult.unmatchedAccounts.length > 0 && (
              <div style={styles.warnBanner}>
                {epayResult.unmatchedAccounts.length} account number(s) in the file don't match any store's
                "Epay" field, so they were skipped: <strong>{epayResult.unmatchedAccounts.join(", ")}</strong>.
                Add them in{" "}
                <Link href="/mappings" style={styles.inlineLink}>
                  Epay Account Mapping
                </Link>{" "}
                or add the store in Store Master, then re-upload.
              </div>
            )}

            {epayResult && epayTotalRows > 0 && (
              <>
                <div style={styles.actionsRow}>
                  <button style={styles.previewBtn} onClick={() => setEpayPreviewOpen((v) => !v)}>
                    👁 {epayPreviewOpen ? "Hide preview" : "Preview selected"}
                  </button>
                  <button style={styles.xlsxBtn} onClick={() => downloadAllEpayZip("xlsx")}>
                    📘 Download all (XLSX)
                  </button>
                  <button style={styles.csvBtnMuted} onClick={() => downloadAllEpayZip("csv")}>
                    Download all (CSV)
                  </button>
                </div>

                <div style={styles.resultsHeader}>
                  <h2 style={styles.h2}>
                    {epayCompanyNames.length} compan{epayCompanyNames.length === 1 ? "y" : "ies"} ·{" "}
                    {epayTotalRows} line{epayTotalRows === 1 ? "" : "s"}
                  </h2>
                  <label style={styles.selectAllLabel}>
                    <input
                      type="checkbox"
                      checked={epaySelectedCompanies.size === epayCompanyNames.length && epayCompanyNames.length > 0}
                      onChange={(e) => toggleEpaySelectAll(epayCompanyNames, e.target.checked)}
                    />
                    Select all
                  </label>
                </div>

                <div style={styles.companyGrid}>
                  {epayCompanyNames.map((company) => {
                    const incomeRows = epayResult.incomeByCompany[company] || [];
                    const purchaseRows = epayResult.purchaseByCompany[company] || [];
                    return (
                      <div key={company} style={styles.companyCard}>
                        <label style={styles.companyCheckLabel}>
                          <input
                            type="checkbox"
                            checked={epaySelectedCompanies.has(company)}
                            onChange={() => toggleEpayCompany(company)}
                          />
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                            <span style={styles.companyName}>{company}</span>
                            <span style={styles.companyMeta}>
                              {incomeRows.length} income · {purchaseRows.length} purchase
                            </span>
                          </div>
                        </label>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {incomeRows.length > 0 && (
                            <>
                              <button
                                style={styles.secondaryBtn}
                                onClick={() => downloadEpayCompanyXlsx("income", company, incomeRows)}
                              >
                                Income XLSX
                              </button>
                              <button
                                style={styles.secondaryBtn}
                                onClick={() => downloadEpayCompanyCsv("income", company, incomeRows)}
                              >
                                Income CSV
                              </button>
                            </>
                          )}
                          {purchaseRows.length > 0 && (
                            <>
                              <button
                                style={styles.secondaryBtn}
                                onClick={() => downloadEpayCompanyXlsx("purchase", company, purchaseRows)}
                              >
                                Purchase XLSX
                              </button>
                              <button
                                style={styles.secondaryBtn}
                                onClick={() => downloadEpayCompanyCsv("purchase", company, purchaseRows)}
                              >
                                Purchase CSV
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {epayPreviewOpen && (
                  <>
                    <div style={styles.previewSectionTitle}>Income</div>
                    <div style={styles.previewWrap}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            {INCOME_COLUMNS.map((c) => (
                              <th key={c} style={styles.th}>
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {epayCompanyNames
                            .filter((c) => epaySelectedCompanies.has(c))
                            .flatMap((c) => epayResult.incomeByCompany[c] || [])
                            .map((r, i) => (
                              <tr key={i} style={styles.tr}>
                                {INCOME_COLUMNS.map((c) => (
                                  <td key={c} style={styles.td}>
                                    {r[c]}
                                  </td>
                                ))}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>

                    <div style={styles.previewSectionTitle}>Purchase</div>
                    <div style={styles.previewWrap}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            {PURCHASE_COLUMNS.map((c) => (
                              <th key={c} style={styles.th}>
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {epayCompanyNames
                            .filter((c) => epaySelectedCompanies.has(c))
                            .flatMap((c) => epayResult.purchaseByCompany[c] || [])
                            .map((r, i) => (
                              <tr key={i} style={styles.tr}>
                                {PURCHASE_COLUMNS.map((c) => (
                                  <td key={c} style={styles.td}>
                                    {r[c]}
                                  </td>
                                ))}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {activeTab === "ondigo" && (
          <>
            <div style={styles.card}>
              <input
                ref={ondigoFileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleOndigoFileChange}
                style={{ display: "none" }}
              />
              <div
                style={{ ...styles.dropzone, ...(ondigoDragOver ? styles.dropzoneActive : {}) }}
                onClick={() => ondigoFileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOndigoDragOver(true);
                }}
                onDragLeave={() => setOndigoDragOver(false)}
                onDrop={handleOndigoDrop}
              >
                <div style={styles.dropzoneIcon}>📄</div>
                <div style={styles.dropzoneText}>{ondigoFileName || "Choose or drop Ondigo invoices export"}</div>
              </div>
            </div>

            {ondigoProcessing && <div style={styles.info}>Processing…</div>}
            {ondigoError && <div style={styles.errorBanner}>{ondigoError}</div>}

            {ondigoResult && ondigoResult.unmatchedAddresses.length > 0 && (
              <div style={styles.warnBanner}>
                {ondigoResult.unmatchedAddresses.length} invoice(s) have a Store/Location address that doesn't
                match any store's VIP Address in Store Master (matched on the street portion only), so they were
                skipped: <strong>{ondigoResult.unmatchedAddresses.join(" · ")}</strong>. Add them in{" "}
                <Link href="/mappings" style={styles.inlineLink}>
                  Ondigo Address Mapping
                </Link>{" "}
                or fix the address in Store Master's VIP Address field, then re-upload.
              </div>
            )}

            {ondigoResult && ondigoTotalRows > 0 && (
              <>
                <div style={styles.actionsRow}>
                  <button style={styles.previewBtn} onClick={() => setOndigoPreviewOpen((v) => !v)}>
                    👁 {ondigoPreviewOpen ? "Hide preview" : "Preview selected"}
                  </button>
                  <button style={styles.xlsxBtn} onClick={() => downloadAllOndigoZip("xlsx")}>
                    📘 Download all (XLSX)
                  </button>
                  <button style={styles.csvBtnMuted} onClick={() => downloadAllOndigoZip("csv")}>
                    Download all (CSV)
                  </button>
                </div>

                <div style={styles.resultsHeader}>
                  <h2 style={styles.h2}>
                    {ondigoCompanyEntries.length} compan{ondigoCompanyEntries.length === 1 ? "y" : "ies"} ·{" "}
                    {ondigoTotalRows} bill line{ondigoTotalRows === 1 ? "" : "s"}
                  </h2>
                  <label style={styles.selectAllLabel}>
                    <input
                      type="checkbox"
                      checked={ondigoSelectedCompanies.size === ondigoCompanyEntries.length && ondigoCompanyEntries.length > 0}
                      onChange={(e) =>
                        toggleOndigoSelectAll(
                          ondigoCompanyEntries.map(([company]) => company),
                          e.target.checked
                        )
                      }
                    />
                    Select all
                  </label>
                </div>

                <div style={styles.companyGrid}>
                  {ondigoCompanyEntries.map(([company, rows]) => (
                    <div key={company} style={styles.companyCard}>
                      <label style={styles.companyCheckLabel}>
                        <input
                          type="checkbox"
                          checked={ondigoSelectedCompanies.has(company)}
                          onChange={() => toggleOndigoCompany(company)}
                        />
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={styles.companyName}>{company}</span>
                          <span style={styles.companyMeta}>{rows.length} bill line(s)</span>
                        </div>
                      </label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button style={styles.secondaryBtn} onClick={() => downloadOndigoCompanyXlsx(company, rows)}>
                          XLSX
                        </button>
                        <button style={styles.secondaryBtn} onClick={() => downloadOndigoCompanyCsv(company, rows)}>
                          CSV
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {ondigoPreviewOpen && (
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
                        {ondigoCompanyEntries
                          .filter(([company]) => ondigoSelectedCompanies.has(company))
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
  tabRow: { display: "flex", gap: 8, marginBottom: 20 },
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

  previewSectionTitle: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 13,
    color: "var(--ink-soft)",
    margin: "16px 0 8px",
  },
  previewWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    maxHeight: 240,
    marginTop: 4,
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
