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
import {
  parseInventoryAgingWorkbook,
  sumAgingLossByRawStore,
  matchAgingLossToStores,
  buildDevicesLostJournalEntryRows,
} from "@/lib/inventoryAgingProcessor";
import { formatMMDDYYYYFromIso } from "@/lib/payrollProcessor";
import { buildExportFileName, parseSingleDateFromFileName } from "@/lib/fileNaming";
import { buildStoreNameMap, remapStoreNamesInRows } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";
import { triggerDownload, todayIso } from "@/lib/download";
import { sharedPageStyles } from "@/lib/pageStyles";
import { checkRawRowsUsable } from "@/lib/validation";

const STATE_KEY = "inventory";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

export default function InventoryPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;
  const [activeTab, setActiveTab] = useState(saved?.activeTab ?? "change");

  const [jeDate, setJeDate] = useState(saved?.jeDate ?? todayIso());

  const [storeMaster, setStoreMaster] = useState(null);
  const [storeMasterError, setStoreMasterError] = useState("");
  const [storeNameMap, setStoreNameMap] = useState({});

  const [openingFileName, setOpeningFileName] = useState(saved?.openingFileName ?? null);
  const [openingDragOver, setOpeningDragOver] = useState(false);
  const [openingError, setOpeningError] = useState("");
  const [openingRows, setOpeningRows] = useState(null);
  const openingInputRef = useRef(null);

  const [closingFileName, setClosingFileName] = useState(saved?.closingFileName ?? null);
  const [closingDragOver, setClosingDragOver] = useState(false);
  const [closingError, setClosingError] = useState("");
  const [closingRows, setClosingRows] = useState(null);
  const closingInputRef = useRef(null);

  // changeRows/unmatchedStores are derived (small) results, not the raw
  // opening/closing rows (which can be tens of thousands of line items and
  // aren't kept around after computing this) — restored directly so a
  // reload/tab-switch doesn't need the original files again.
  const [changeResult, setChangeResult] = useState(saved?.changeResult ?? null); // { changeRows, unmatchedStores }
  const [changeCompanyFilter, setChangeCompanyFilter] = useState(saved?.changeCompanyFilter ?? "all");

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [result, setResult] = useState(saved?.result ?? null); // { byCompany }
  const [previewOpen, setPreviewOpen] = useState(saved?.previewOpen ?? false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set(saved?.selectedCompanies ?? []));

  // ---- Devices Lost (Inventory Aging) tab state ----
  const [agingJeDate, setAgingJeDate] = useState(saved?.agingJeDate ?? todayIso());
  const [agingReportDate, setAgingReportDate] = useState(saved?.agingReportDate ?? "");
  const [agingMonth, setAgingMonth] = useState(saved?.agingMonth ?? "");
  const [agingFileName, setAgingFileName] = useState(saved?.agingFileName ?? null);
  const [agingDragOver, setAgingDragOver] = useState(false);
  const [agingError, setAgingError] = useState("");
  const [agingRows, setAgingRows] = useState(null);
  const agingInputRef = useRef(null);

  // lossResult is derived (small) — not the raw agingRows, same reasoning
  // as changeResult above.
  const [agingLossResult, setAgingLossResult] = useState(saved?.agingLossResult ?? null); // { lossRows, unmatchedStores }

  const [agingGenerating, setAgingGenerating] = useState(false);
  const [agingGenerateError, setAgingGenerateError] = useState("");
  const [agingResult, setAgingResult] = useState(saved?.agingResult ?? null); // { byCompany }
  const [agingPreviewOpen, setAgingPreviewOpen] = useState(saved?.agingPreviewOpen ?? false);
  const [agingSelectedCompanies, setAgingSelectedCompanies] = useState(new Set(saved?.agingSelectedCompanies ?? []));

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
      jeDate,
      openingFileName,
      closingFileName,
      changeResult,
      changeCompanyFilter,
      result,
      previewOpen,
      selectedCompanies: Array.from(selectedCompanies),
      agingJeDate,
      agingReportDate,
      agingMonth,
      agingFileName,
      agingLossResult,
      agingResult,
      agingPreviewOpen,
      agingSelectedCompanies: Array.from(agingSelectedCompanies),
    });
  }, [
    activeTab,
    jeDate,
    openingFileName,
    closingFileName,
    changeResult,
    changeCompanyFilter,
    result,
    previewOpen,
    selectedCompanies,
    agingJeDate,
    agingReportDate,
    agingMonth,
    agingFileName,
    agingLossResult,
    agingResult,
    agingPreviewOpen,
    agingSelectedCompanies,
  ]);

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
      const usableIssue = checkRawRowsUsable(rows, ["Store"], "Opening Inventory file");
      if (usableIssue) throw new Error(usableIssue);
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
      const usableIssue = checkRawRowsUsable(rows, ["Store"], "Closing Inventory file");
      if (usableIssue) throw new Error(usableIssue);
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
    setChangeCompanyFilter("all");
    setResult(null);
    setPreviewOpen(false);
    savePendingMappings({ unmatchedStoreNames: unmatchedStores });
  }, [openingRows, closingRows, storeMaster, storeNameMap]);

  const processAgingFile = useCallback(async (file) => {
    setAgingError("");
    setAgingRows(null);
    try {
      const buffer = await file.arrayBuffer();
      const rows = parseInventoryAgingWorkbook(buffer);
      if (!rows.length || !("Store" in rows[0]) || !("Age in Store" in rows[0]) || !("Cost" in rows[0])) {
        throw new Error('This file is missing expected "Store"/"Age in Store"/"Cost" columns.');
      }
      const usableIssue = checkRawRowsUsable(rows, ["Store", "Cost"], "Inventory Aging file");
      if (usableIssue) throw new Error(usableIssue);
      setAgingRows(rows);
      const parsedDate = parseSingleDateFromFileName(file.name);
      if (parsedDate) setAgingReportDate(parsedDate);
    } catch (e) {
      setAgingError(e.message || String(e));
    }
  }, []);

  function handleAgingFile(file) {
    if (!file) return;
    setAgingFileName(file.name);
    processAgingFile(file);
  }

  function handleAgingFileChange(e) {
    handleAgingFile(e.target.files?.[0]);
  }

  function handleAgingDrop(e) {
    e.preventDefault();
    setAgingDragOver(false);
    handleAgingFile(e.dataTransfer.files?.[0]);
  }

  useEffect(() => {
    if (!agingRows || !storeMaster || !agingReportDate || !agingMonth) return;
    const mappedAging = remapStoreNamesInRows(agingRows, "Store", storeNameMap);
    const lossByRawStore = sumAgingLossByRawStore(mappedAging, agingReportDate, agingMonth);
    const { lossRows, unmatchedStores } = matchAgingLossToStores(lossByRawStore, storeMaster);
    setAgingLossResult({ lossRows, unmatchedStores });
    setAgingResult(null);
    setAgingPreviewOpen(false);
    savePendingMappings({ unmatchedStoreNames: unmatchedStores });
  }, [agingRows, storeMaster, storeNameMap, agingReportDate, agingMonth]);

  function handleGenerateAging() {
    setAgingGenerating(true);
    setAgingGenerateError("");
    setAgingResult(null);
    setAgingPreviewOpen(false);
    try {
      const byCompany = buildDevicesLostJournalEntryRows(agingLossResult.lossRows, formatMMDDYYYYFromIso(agingJeDate));
      setAgingResult({ byCompany });
      setAgingSelectedCompanies(new Set(Object.keys(byCompany)));
    } catch (e) {
      setAgingGenerateError(e.message || String(e));
    } finally {
      setAgingGenerating(false);
    }
  }

  function toggleAgingCompany(company) {
    setAgingSelectedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  function toggleAgingSelectAll(allCompanyNames, checked) {
    setAgingSelectedCompanies(checked ? new Set(allCompanyNames) : new Set());
  }

  async function downloadAgingCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, company);
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "DevicesLostJE", rows, "Date", "xlsx"));
  }

  function downloadAgingCompanyCsv(company, rows) {
    triggerDownload(new Blob([rowsToCsv(rows)], { type: CSV_MIME }), buildExportFileName(company, "DevicesLostJE", rows, "Date", "csv"));
  }

  async function downloadAgingAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(agingResult.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "DevicesLostJE", rows, "Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "DevicesLostJE", rows, "Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `DevicesLost-AllCompanies-${format}.zip`);
  }

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

  const debitTotal = (rows) => rows.reduce((sum, r) => sum + (Number(r.Debit) || 0), 0);

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const grandTotal = companyEntries.reduce((sum, [, rows]) => sum + debitTotal(rows), 0);
  const changeRows = changeResult?.changeRows || [];
  const changeCompanies = Array.from(new Set(changeRows.map((r) => r.company))).sort();
  const filteredChangeRows =
    changeCompanyFilter === "all" ? changeRows : changeRows.filter((r) => r.company === changeCompanyFilter);
  const changeTotals = filteredChangeRows.reduce(
    (acc, r) => ({
      opening: acc.opening + (Number(r.opening) || 0),
      closing: acc.closing + (Number(r.closing) || 0),
      change: acc.change + (Number(r.change) || 0),
    }),
    { opening: 0, closing: 0, change: 0 }
  );

  const agingCompanyEntries = agingResult ? Object.entries(agingResult.byCompany) : [];
  const agingTotalRows = agingCompanyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const agingGrandTotal = agingCompanyEntries.reduce((sum, [, rows]) => sum + debitTotal(rows), 0);
  const agingLossRows = agingLossResult?.lossRows || [];

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Change in Inventory</h1>
          <p style={styles.pageSub}>
            {activeTab === "change"
              ? "Upload your opening and closing inventory exports separately to get per-store Opening/Closing/Change in Inventory, then generate a per-company Journal Entry."
              : "Upload an Inventory Aging (Devices Lost) export, pick the entry month, and generate the write-off Journal Entry per store."}
          </p>
        </div>

        <div style={styles.tabRow}>
          <button style={activeTab === "change" ? styles.tabActive : styles.tab} onClick={() => setActiveTab("change")}>
            Change in Inventory
          </button>
          <button style={activeTab === "aging" ? styles.tabActive : styles.tab} onClick={() => setActiveTab("aging")}>
            Devices Lost
          </button>
        </div>

        {activeTab === "change" && (
          <>
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
            <div style={styles.fieldRow}>
              <label style={styles.fieldBlock}>
                <span style={styles.fieldLabel}>Company</span>
                <select
                  style={styles.dateInput}
                  value={changeCompanyFilter}
                  onChange={(e) => setChangeCompanyFilter(e.target.value)}
                >
                  <option value="all">All companies</option>
                  {changeCompanies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
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
                  {filteredChangeRows.map((r, i) => (
                    <tr key={i} style={styles.tr}>
                      <td style={styles.td}>{r.company}</td>
                      <td style={styles.td}>{r.storeLabel}</td>
                      <td style={styles.td}>{r.opening.toFixed(2)}</td>
                      <td style={styles.td}>{r.closing.toFixed(2)}</td>
                      <td style={styles.td}>{r.change.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={styles.totalsCell} colSpan={2}>
                      Total ({filteredChangeRows.length} store{filteredChangeRows.length === 1 ? "" : "s"})
                    </td>
                    <td style={styles.totalsCell}>{changeTotals.opening.toFixed(2)}</td>
                    <td style={styles.totalsCell}>{changeTotals.closing.toFixed(2)}</td>
                    <td style={styles.totalsCell}>{changeTotals.change.toFixed(2)}</td>
                  </tr>
                </tfoot>
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
                {totalRows === 1 ? "" : "s"} · Total ${grandTotal.toFixed(2)}
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
                        {rows.length} JE line(s) · ${debitTotal(rows).toFixed(2)}
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
          </>
        )}

        {activeTab === "aging" && (
          <>
            <div style={styles.card}>
              <h2 style={styles.h2}>1. Report Date, Entry Month & upload</h2>
              <div style={styles.fieldRow}>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Report Date (aging as-of date)</span>
                  <input
                    type="date"
                    style={styles.dateInput}
                    value={agingReportDate}
                    onChange={(e) => setAgingReportDate(e.target.value)}
                  />
                </label>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Entry Month</span>
                  <input type="month" style={styles.dateInput} value={agingMonth} onChange={(e) => setAgingMonth(e.target.value)} />
                </label>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>JE Date</span>
                  <input
                    type="date"
                    style={styles.dateInput}
                    value={agingJeDate}
                    onChange={(e) => setAgingJeDate(e.target.value)}
                  />
                </label>
              </div>

              {storeMasterError && <div style={styles.errorBanner}>{storeMasterError}</div>}

              <div style={styles.uploadCol}>
                <span style={styles.fieldLabel}>Inventory Aging export</span>
                <input
                  ref={agingInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleAgingFileChange}
                  style={{ display: "none" }}
                />
                <div
                  style={{ ...styles.dropzone, ...(agingDragOver ? styles.dropzoneActive : {}) }}
                  onClick={() => agingInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setAgingDragOver(true);
                  }}
                  onDragLeave={() => setAgingDragOver(false)}
                  onDrop={handleAgingDrop}
                >
                  <div style={styles.dropzoneIcon}>📄</div>
                  <div style={styles.dropzoneText}>{agingFileName || "Choose or drop Inventory Aging export"}</div>
                </div>
                {agingRows && !agingError && <div style={styles.info}>{agingRows.length} row(s) loaded.</div>}
                {agingError && <div style={styles.errorBanner}>{agingError}</div>}
              </div>

              {agingRows && (!agingReportDate || !agingMonth) && (
                <div style={styles.warnBanner}>Set both Report Date and Entry Month to compute each store's loss.</div>
              )}

              {agingLossResult && agingLossResult.unmatchedStores.length > 0 && (
                <div style={styles.warnBanner}>
                  {agingLossResult.unmatchedStores.length} store name(s) in the file don't match any store's Elevate
                  Name in Store Master, so their loss was excluded:{" "}
                  <strong>{agingLossResult.unmatchedStores.join(", ")}</strong>.
                </div>
              )}
            </div>

            {agingLossResult && agingLossRows.length > 0 && (
              <div style={styles.card}>
                <h2 style={styles.h2}>2. Devices Lost by store (preview)</h2>
                <div style={styles.tableWrap}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Company</th>
                        <th style={styles.th}>Store</th>
                        <th style={styles.th}>Loss Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agingLossRows.map((r, i) => (
                        <tr key={i} style={styles.tr}>
                          <td style={styles.td}>{r.company}</td>
                          <td style={styles.td}>{r.storeLabel}</td>
                          <td style={styles.td}>{r.amount.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {agingLossResult && agingLossRows.length > 0 && (
              <div style={styles.card}>
                <h2 style={styles.h2}>3. Generate Journal Entry</h2>
                <button style={styles.generateBtn} onClick={handleGenerateAging} disabled={agingGenerating}>
                  {agingGenerating ? "Generating…" : "Generate Journal Entry"}
                </button>
                {agingGenerateError && <div style={styles.errorBanner}>{agingGenerateError}</div>}
              </div>
            )}

            {agingResult && agingTotalRows > 0 && (
              <>
                <div style={styles.actionsRow}>
                  <button style={styles.previewBtn} onClick={() => setAgingPreviewOpen((v) => !v)}>
                    👁 {agingPreviewOpen ? "Hide preview" : "Preview selected"}
                  </button>
                  <button style={styles.xlsxBtn} onClick={() => downloadAgingAllZip("xlsx")}>
                    📘 Download all (XLSX)
                  </button>
                  <button style={styles.csvBtnMuted} onClick={() => downloadAgingAllZip("csv")}>
                    Download all (CSV)
                  </button>
                </div>

                <div style={styles.resultsHeader}>
                  <h2 style={styles.h2}>
                    {agingCompanyEntries.length} compan{agingCompanyEntries.length === 1 ? "y" : "ies"} ·{" "}
                    {agingTotalRows} JE line{agingTotalRows === 1 ? "" : "s"} · Total ${agingGrandTotal.toFixed(2)}
                  </h2>
                  <label style={styles.selectAllLabel}>
                    <input
                      type="checkbox"
                      checked={agingSelectedCompanies.size === agingCompanyEntries.length && agingCompanyEntries.length > 0}
                      onChange={(e) =>
                        toggleAgingSelectAll(
                          agingCompanyEntries.map(([company]) => company),
                          e.target.checked
                        )
                      }
                    />
                    Select all
                  </label>
                </div>

                <div style={styles.companyGrid}>
                  {agingCompanyEntries.map(([company, rows]) => (
                    <div key={company} style={styles.companyCard}>
                      <label style={styles.companyCheckLabel}>
                        <input
                          type="checkbox"
                          checked={agingSelectedCompanies.has(company)}
                          onChange={() => toggleAgingCompany(company)}
                        />
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={styles.companyName}>{company}</span>
                          <span style={styles.companyMeta}>
                            {rows.length} JE line(s) · ${debitTotal(rows).toFixed(2)}
                          </span>
                        </div>
                      </label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button style={styles.secondaryBtn} onClick={() => downloadAgingCompanyXlsx(company, rows)}>
                          XLSX
                        </button>
                        <button style={styles.secondaryBtn} onClick={() => downloadAgingCompanyCsv(company, rows)}>
                          CSV
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {agingPreviewOpen && (
                  <div style={styles.previewGroups}>
                    {agingCompanyEntries
                      .filter(([company]) => agingSelectedCompanies.has(company))
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

  tabRow: { display: "flex", gap: 8, margin: "20px 0" },
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

  dropzoneIcon: { fontSize: 22 },

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
  // separate/0 instead of collapse -- border-collapse breaks position:sticky
  // th painting opaquely over rows scrolling underneath in some browsers
  // (rows visibly bleed through/overlap the sticky header); 0 spacing keeps
  // the same collapsed look without that bug.
  table: { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 },
  th: {
    position: "sticky",
    top: 0,
    zIndex: 2,
    background: "var(--panel)",
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

  td: {
    padding: "6px 8px",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    whiteSpace: "nowrap",
  },
  // tfoot row, same table as the header/body -- lines up with the
  // Opening/Closing/Change columns exactly since it's the same columns,
  // same table. Sticky at the bottom so it's visible without scrolling to
  // the end. table's borderCollapse:"separate" above is required for this
  // to paint opaquely while scrolling (collapse + sticky bleeds/overlaps
  // scrolled rows in some browsers -- don't revert that). Background here
  // must stay a fully OPAQUE color, not a translucent rgba tint -- a
  // low-alpha sticky background still lets scrolled row text show through
  // underneath it (not a bug, just normal alpha blending), which looked
  // just as garbled as the original overlap bug.
  totalsCell: {
    position: "sticky",
    bottom: 0,
    zIndex: 2,
    padding: "10px 8px",
    fontFamily: "var(--font-mono)",
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--ink)",
    whiteSpace: "nowrap",
    background: "#173230",
    borderTop: "2px solid var(--ledger)",
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

  companyMeta: { fontSize: 10.5, color: "var(--ink-soft)" },

};
