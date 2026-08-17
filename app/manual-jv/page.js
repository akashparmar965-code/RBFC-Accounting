"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import { parseTimesheetWorkbook, buildStoreHours, formatMMDDYYYYFromIso } from "@/lib/payrollProcessor";
import {
  buildActiveStoreInfo,
  buildManualJvJournalEntryRows,
  buildCompanyActiveStores,
  buildCompanySplitJournalEntryRows,
  JE_COLUMNS,
  rowsToCsv,
  rowsToXlsxBuffer,
} from "@/lib/manualJvProcessor";
import { buildExportFileName } from "@/lib/fileNaming";
import { buildStoreNameMap, remapStoreNamesInRows } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";
import { triggerDownload, todayIso } from "@/lib/download";
import { sharedPageStyles } from "@/lib/pageStyles";
import { validateManualJvLines } from "@/lib/validation";

const STATE_KEY = "manual-jv";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

function emptyLine() {
  return { account_name: "", debit: "", credit: "", split_per_store: true };
}

function emptySplitLine() {
  return { account_name: "", company_name: "", debit: "", credit: "", split_per_store: true };
}

export default function ManualJvPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;
  const [activeTab, setActiveTab] = useState(saved?.activeTab ?? "manual");

  const [jeDate, setJeDate] = useState(saved?.jeDate ?? todayIso());

  const [storeMaster, setStoreMaster] = useState(null);
  const [storeMasterError, setStoreMasterError] = useState("");
  const [storeNameMap, setStoreNameMap] = useState({});

  const [jvLines, setJvLines] = useState([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  const [timesheetFileName, setTimesheetFileName] = useState(saved?.timesheetFileName ?? null);
  const [timesheetDragOver, setTimesheetDragOver] = useState(false);
  const [timesheetError, setTimesheetError] = useState("");
  const [storeHours, setStoreHours] = useState(saved?.storeHours ?? null);
  const timesheetInputRef = useRef(null);

  // activeInfo is derived (small) — recomputed from storeHours + storeMaster,
  // not persisted directly, since storeMaster/storeNameMap are refetched
  // fresh each load anyway.
  const [activeInfo, setActiveInfo] = useState(null);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [result, setResult] = useState(saved?.result ?? null); // { byCompany }
  const [previewOpen, setPreviewOpen] = useState(saved?.previewOpen ?? false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set(saved?.selectedCompanies ?? []));

  // ==================== Company Split tab ====================
  const [splitJeDate, setSplitJeDate] = useState(saved?.splitJeDate ?? todayIso());
  const [splitLines, setSplitLines] = useState([]);
  const [splitLinesLoading, setSplitLinesLoading] = useState(false);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitSaveMessage, setSplitSaveMessage] = useState("");
  const [splitSaveError, setSplitSaveError] = useState("");

  const [splitGenerating, setSplitGenerating] = useState(false);
  const [splitGenerateError, setSplitGenerateError] = useState("");
  const [splitResult, setSplitResult] = useState(saved?.splitResult ?? null); // { byCompany, skippedCompanies, roundingAdjustments }
  const [splitPreviewOpen, setSplitPreviewOpen] = useState(saved?.splitPreviewOpen ?? false);
  const [splitSelectedCompanies, setSplitSelectedCompanies] = useState(new Set(saved?.splitSelectedCompanies ?? []));

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
      timesheetFileName,
      storeHours,
      result,
      previewOpen,
      selectedCompanies: Array.from(selectedCompanies),
      splitJeDate,
      splitResult,
      splitPreviewOpen,
      splitSelectedCompanies: Array.from(splitSelectedCompanies),
    });
  }, [
    activeTab,
    jeDate,
    timesheetFileName,
    storeHours,
    result,
    previewOpen,
    selectedCompanies,
    splitJeDate,
    splitResult,
    splitPreviewOpen,
    splitSelectedCompanies,
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

  const loadLines = useCallback(async (dateStr) => {
    if (!dateStr) return;
    setLinesLoading(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("manual_jv_lines")
        .select("*")
        .eq("je_date", dateStr)
        .order("sort_order", { ascending: true });
      if (error) throw new Error(error.message);
      if (data && data.length > 0) {
        setJvLines(
          data.map((r) => ({
            account_name: r.account_name,
            debit: r.debit ? String(r.debit) : "",
            credit: r.credit ? String(r.credit) : "",
            split_per_store: r.split_per_store,
          }))
        );
      } else {
        setJvLines([emptyLine(), emptyLine()]);
      }
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setLinesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLines(jeDate);
  }, [jeDate, loadLines]);

  function updateLine(index, field, value) {
    setJvLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  function addLine() {
    setJvLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(index) {
    setJvLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveLines() {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const lineErrors = validateManualJvLines(jvLines);
      if (lineErrors.length > 0) {
        throw new Error(lineErrors.join(" "));
      }
      const supabase = createClient();
      const cleanLines = jvLines
        .filter((l) => l.account_name.trim() && (Number(l.debit) > 0 || Number(l.credit) > 0))
        .map((l, i) => ({
          je_date: jeDate,
          account_name: l.account_name.trim(),
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          split_per_store: !!l.split_per_store,
          sort_order: i,
        }));
      const { error: delError } = await supabase.from("manual_jv_lines").delete().eq("je_date", jeDate);
      if (delError) throw new Error(delError.message);
      if (cleanLines.length > 0) {
        const { error: insError } = await supabase.from("manual_jv_lines").insert(cleanLines);
        if (insError) throw new Error(insError.message);
      }
      setSaveMessage("Saved.");
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  const companyOptions = useMemo(() => {
    if (!storeMaster) return [];
    const names = new Set();
    for (const s of storeMaster) {
      if (s.status !== "Active") continue;
      const company = s.company_name ? String(s.company_name).trim() : "";
      if (company) names.add(company);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [storeMaster]);

  const companyStoreCounts = useMemo(() => {
    if (!storeMaster) return {};
    const byCompany = buildCompanyActiveStores(storeMaster);
    const counts = {};
    for (const [company, stores] of Object.entries(byCompany)) counts[company] = stores.length;
    return counts;
  }, [storeMaster]);

  const loadSplitLines = useCallback(async (dateStr) => {
    if (!dateStr) return;
    setSplitLinesLoading(true);
    setSplitSaveMessage("");
    setSplitSaveError("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("manual_jv_company_lines")
        .select("*")
        .eq("je_date", dateStr)
        .order("sort_order", { ascending: true });
      if (error) throw new Error(error.message);
      if (data && data.length > 0) {
        setSplitLines(
          data.map((r) => ({
            account_name: r.account_name,
            company_name: r.company_name,
            debit: r.debit ? String(r.debit) : "",
            credit: r.credit ? String(r.credit) : "",
            split_per_store: r.split_per_store,
          }))
        );
      } else {
        setSplitLines([emptySplitLine(), emptySplitLine()]);
      }
    } catch (e) {
      setSplitSaveError(e.message || String(e));
    } finally {
      setSplitLinesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSplitLines(splitJeDate);
  }, [splitJeDate, loadSplitLines]);

  function updateSplitLine(index, field, value) {
    setSplitLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  function addSplitLine() {
    setSplitLines((prev) => [...prev, emptySplitLine()]);
  }

  function removeSplitLine(index) {
    setSplitLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveSplitLines() {
    setSplitSaving(true);
    setSplitSaveMessage("");
    setSplitSaveError("");
    try {
      const lineErrors = validateManualJvLines(splitLines);
      splitLines.forEach((l, i) => {
        const hasAmount = Number(l.debit) > 0 || Number(l.credit) > 0;
        if (hasAmount && !l.company_name.trim()) {
          lineErrors.push(`Row ${i + 1}: choose a Company.`);
        }
      });
      if (lineErrors.length > 0) {
        throw new Error(lineErrors.join(" "));
      }
      const supabase = createClient();
      const cleanLines = splitLines
        .filter((l) => l.account_name.trim() && l.company_name.trim() && (Number(l.debit) > 0 || Number(l.credit) > 0))
        .map((l, i) => ({
          je_date: splitJeDate,
          account_name: l.account_name.trim(),
          company_name: l.company_name.trim(),
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          split_per_store: !!l.split_per_store,
          sort_order: i,
        }));
      const { error: delError } = await supabase.from("manual_jv_company_lines").delete().eq("je_date", splitJeDate);
      if (delError) throw new Error(delError.message);
      if (cleanLines.length > 0) {
        const { error: insError } = await supabase.from("manual_jv_company_lines").insert(cleanLines);
        if (insError) throw new Error(insError.message);
      }
      setSplitSaveMessage("Saved.");
    } catch (e) {
      setSplitSaveError(e.message || String(e));
    } finally {
      setSplitSaving(false);
    }
  }

  function handleGenerateSplit() {
    setSplitGenerating(true);
    setSplitGenerateError("");
    setSplitResult(null);
    setSplitPreviewOpen(false);
    try {
      const lineErrors = validateManualJvLines(splitLines);
      splitLines.forEach((l, i) => {
        const hasAmount = Number(l.debit) > 0 || Number(l.credit) > 0;
        if (hasAmount && !l.company_name.trim()) {
          lineErrors.push(`Row ${i + 1}: choose a Company.`);
        }
      });
      if (lineErrors.length > 0) {
        throw new Error(lineErrors.join(" "));
      }
      const cleanLines = splitLines.filter(
        (l) => l.account_name.trim() && l.company_name.trim() && (Number(l.debit) > 0 || Number(l.credit) > 0)
      );
      if (cleanLines.length === 0) throw new Error("Add at least one line with an Account Name, Company, and a Debit or Credit amount.");
      const byCompanyStores = buildCompanyActiveStores(storeMaster);
      const { byCompany, skippedCompanies, roundingAdjustments } = buildCompanySplitJournalEntryRows(
        cleanLines,
        byCompanyStores,
        formatMMDDYYYYFromIso(splitJeDate)
      );
      if (Object.keys(byCompany).length === 0) {
        throw new Error("No journal entry rows were generated — every referenced company has zero Active stores in Store Master.");
      }
      setSplitResult({ byCompany, skippedCompanies, roundingAdjustments });
      setSplitSelectedCompanies(new Set(Object.keys(byCompany)));
    } catch (e) {
      setSplitGenerateError(e.message || String(e));
    } finally {
      setSplitGenerating(false);
    }
  }

  function toggleSplitCompany(company) {
    setSplitSelectedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  function toggleSplitSelectAll(allCompanyNames, checked) {
    setSplitSelectedCompanies(checked ? new Set(allCompanyNames) : new Set());
  }

  async function downloadSplitCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, company);
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "CompanySplitJV", rows, "Journal Date", "xlsx"));
  }

  function downloadSplitCompanyCsv(company, rows) {
    triggerDownload(
      new Blob([rowsToCsv(rows)], { type: CSV_MIME }),
      buildExportFileName(company, "CompanySplitJV", rows, "Journal Date", "csv")
    );
  }

  async function downloadSplitAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(splitResult.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "CompanySplitJV", rows, "Journal Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "CompanySplitJV", rows, "Journal Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `CompanySplitJV-AllCompanies-${format}.zip`);
  }

  const processTimesheet = useCallback(
    async (file) => {
      setTimesheetError("");
      setStoreHours(null);
      setActiveInfo(null);
      try {
        const buffer = await file.arrayBuffer();
        const rawRows = parseTimesheetWorkbook(buffer);
        if (!rawRows.length) throw new Error("No rows found in this timesheet file.");
        if (!("Store" in rawRows[0]) || !("Total Working Time Decimal" in rawRows[0])) {
          throw new Error(
            "This file doesn't look like an Employee Timesheet export — expected 'Store' and 'Total Working Time Decimal' columns."
          );
        }
        const mappedRows = remapStoreNamesInRows(rawRows, "Store", storeNameMap);
        setStoreHours(buildStoreHours(mappedRows));
      } catch (e) {
        setTimesheetError(e.message || String(e));
      }
    },
    [storeNameMap]
  );

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

  useEffect(() => {
    if (!storeHours || !storeMaster) return;
    const info = buildActiveStoreInfo(storeHours, storeMaster);
    setActiveInfo(info);
    savePendingMappings({ unmatchedStoreNames: info.unmatchedStores });
  }, [storeHours, storeMaster]);

  function handleGenerate() {
    setGenerating(true);
    setGenerateError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const lineErrors = validateManualJvLines(jvLines);
      if (lineErrors.length > 0) {
        throw new Error(lineErrors.join(" "));
      }
      const cleanLines = jvLines.filter((l) => l.account_name.trim() && (Number(l.debit) > 0 || Number(l.credit) > 0));
      if (cleanLines.length === 0) throw new Error("Add at least one JV line with an Account Name and a Debit or Credit amount.");
      const { byCompany, roundingAdjustments } = buildManualJvJournalEntryRows(cleanLines, activeInfo, formatMMDDYYYYFromIso(jeDate));
      setResult({ byCompany, roundingAdjustments });
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
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "ManualJV", rows, "Journal Date", "xlsx"));
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(new Blob([rowsToCsv(rows)], { type: CSV_MIME }), buildExportFileName(company, "ManualJV", rows, "Journal Date", "csv"));
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "ManualJV", rows, "Journal Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "ManualJV", rows, "Journal Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `ManualJV-AllCompanies-${format}.zip`);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const debitTotal = (rows) => rows.reduce((sum, r) => sum + (Number(r.Debit) || 0), 0);

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const grandTotal = companyEntries.reduce((sum, [, rows]) => sum + debitTotal(rows), 0);
  const enteredDebit = jvLines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const enteredCredit = jvLines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
  const enteredBalanced = Math.abs(enteredDebit - enteredCredit) < 0.01;
  const lineErrors = validateManualJvLines(jvLines);
  const canGenerate = !!activeInfo && activeInfo.matchedStores.length > 0 && !generating && lineErrors.length === 0;

  const splitCompanyEntries = splitResult ? Object.entries(splitResult.byCompany) : [];
  const splitTotalRows = splitCompanyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const splitGrandTotal = splitCompanyEntries.reduce((sum, [, rows]) => sum + debitTotal(rows), 0);
  const splitEnteredDebit = splitLines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const splitEnteredCredit = splitLines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
  const splitEnteredBalanced = Math.abs(splitEnteredDebit - splitEnteredCredit) < 0.01;
  const splitLineErrors = validateManualJvLines(splitLines).concat(
    splitLines
      .map((l, i) => {
        const hasAmount = Number(l.debit) > 0 || Number(l.credit) > 0;
        return hasAmount && !l.company_name.trim() ? `Row ${i + 1}: choose a Company.` : null;
      })
      .filter(Boolean)
  );
  const canGenerateSplit = !!storeMaster && !splitGenerating && splitLineErrors.length === 0;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Manual JV</h1>
          <p style={styles.pageSub}>
            {activeTab === "manual"
              ? "Type in any JV, upload the Employee Timesheet, and split each line equally across every store active that period (or keep it as one line per company) — same allocation idea as Payroll, but a flat split instead of hours-weighted."
              : "Type in a company-wise amount per line and it's split equally across every Active store in that company — no upload needed."}
          </p>
        </div>

        <div style={styles.tabRow}>
          <button
            style={{ ...styles.tab, ...(activeTab === "manual" ? styles.tabActive : {}) }}
            onClick={() => setActiveTab("manual")}
          >
            Manual JV
          </button>
          <button
            style={{ ...styles.tab, ...(activeTab === "split" ? styles.tabActive : {}) }}
            onClick={() => setActiveTab("split")}
          >
            Company Split
          </button>
        </div>

        {activeTab === "manual" && (
        <>
        <div style={styles.card}>
          <h2 style={styles.h2}>1. JE Date & JV lines</h2>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>Journal Date</span>
              <input type="date" style={styles.dateInput} value={jeDate} onChange={(e) => setJeDate(e.target.value)} />
            </label>
          </div>

          {storeMasterError && <div style={styles.errorBanner}>{storeMasterError}</div>}
          {linesLoading && <div style={styles.info}>Loading…</div>}
          {saveError && <div style={styles.errorBanner}>{saveError}</div>}

          {!linesLoading && (
            <>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Account Name</th>
                      <th style={styles.th}>Debit</th>
                      <th style={styles.th}>Credit</th>
                      <th style={styles.th}>Split per store</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {jvLines.map((line, i) => {
                      const debitNum = Number(line.debit);
                      const creditNum = Number(line.credit);
                      const debitBad = Number.isFinite(debitNum) && debitNum < 0;
                      const creditBad = Number.isFinite(creditNum) && creditNum < 0;
                      const bothFilled = debitNum > 0 && creditNum > 0;
                      return (
                        <tr key={i} style={styles.tr}>
                          <td style={styles.td}>
                            <input
                              style={styles.cellInput}
                              placeholder="e.g. Personal Expense"
                              value={line.account_name}
                              onChange={(e) => updateLine(i, "account_name", e.target.value)}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              style={{ ...styles.numInput, ...((debitBad || bothFilled) ? styles.numInputError : {}) }}
                              value={line.debit}
                              onChange={(e) => updateLine(i, "debit", e.target.value)}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              style={{ ...styles.numInput, ...((creditBad || bothFilled) ? styles.numInputError : {}) }}
                              value={line.credit}
                              onChange={(e) => updateLine(i, "credit", e.target.value)}
                            />
                          </td>
                          <td style={{ ...styles.td, textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={line.split_per_store}
                              onChange={(e) => updateLine(i, "split_per_store", e.target.checked)}
                            />
                          </td>
                          <td style={styles.td}>
                            <button style={styles.linkBtn} onClick={() => removeLine(i)}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {lineErrors.length > 0 && (
                <div style={styles.errorBanner}>
                  {lineErrors.map((msg, i) => (
                    <div key={i}>{msg}</div>
                  ))}
                </div>
              )}

              <div style={styles.actionsRow}>
                <button style={styles.addBtn} onClick={addLine}>
                  + Add line
                </button>
                <button style={styles.saveBtn} onClick={handleSaveLines} disabled={saving || lineErrors.length > 0}>
                  {saving ? "Saving…" : "Save"}
                </button>
                {saveMessage && <span style={styles.info}>{saveMessage}</span>}
                <span style={enteredBalanced ? styles.balanceOk : styles.balanceBad}>
                  Entered Dr {enteredDebit.toFixed(2)} · Cr {enteredCredit.toFixed(2)}
                  {enteredBalanced ? " ✓ Balanced" : ` ⚠ Out of balance by ${(enteredDebit - enteredCredit).toFixed(2)}`}
                </span>
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

          {activeInfo && activeInfo.unmatchedStores.length > 0 && (
            <div style={styles.warnBanner}>
              {activeInfo.unmatchedStores.length} store name(s) in the timesheet don't match any store's Elevate
              Name in Store Master, so they were excluded from the active-store count:{" "}
              <strong>{activeInfo.unmatchedStores.join(", ")}</strong>.
            </div>
          )}

          {activeInfo && (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Company</th>
                    <th style={styles.th}>Active stores</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(activeInfo.byCompany)
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([company, stores]) => (
                      <tr key={company} style={styles.tr}>
                        <td style={styles.td}>{company}</td>
                        <td style={styles.td}>{stores.length}</td>
                      </tr>
                    ))}
                  <tr style={styles.tr}>
                    <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
                    <td style={{ ...styles.td, fontWeight: 700 }}>{activeInfo.matchedStores.length}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>3. Generate Journal Entry</h2>
          <button style={styles.generateBtn} onClick={handleGenerate} disabled={!canGenerate}>
            {generating ? "Generating…" : "Allocate & Generate Journal Entry"}
          </button>
          {generateError && <div style={styles.errorBanner}>{generateError}</div>}
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

                    const storeCount = activeInfo?.byCompany?.[company]?.length ?? 0;
                    const roundingNote = result.roundingAdjustments?.[company];

                    return (
                      <div key={company} style={styles.previewGroup}>
                        <div style={styles.previewGroupHeader}>
                          <span style={styles.companyName}>
                            {company} <span style={styles.companyMeta}>({storeCount} active store(s))</span>
                          </span>
                          <span style={balanced ? styles.balanceOk : styles.balanceBad}>
                            Dr {totalDebit.toFixed(2)} · Cr {totalCredit.toFixed(2)}
                            {balanced ? " ✓ Balanced" : ` ⚠ Out of balance by ${(totalDebit - totalCredit).toFixed(2)}`}
                          </span>
                        </div>
                        {roundingNote && (
                          <div style={styles.roundingNote}>
                            Rounding adjustment: {roundingNote.total >= 0 ? "+" : ""}
                            {roundingNote.total.toFixed(2)} placed in {roundingNote.store} to keep each line's
                            system-wide total exact — every other company keeps its own small rounding drift.
                          </div>
                        )}
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

        {activeTab === "split" && (
        <>
        <div style={styles.card}>
          <h2 style={styles.h2}>1. JE Date & Company amounts</h2>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>Journal Date</span>
              <input type="date" style={styles.dateInput} value={splitJeDate} onChange={(e) => setSplitJeDate(e.target.value)} />
            </label>
          </div>

          {storeMasterError && <div style={styles.errorBanner}>{storeMasterError}</div>}
          {splitLinesLoading && <div style={styles.info}>Loading…</div>}
          {splitSaveError && <div style={styles.errorBanner}>{splitSaveError}</div>}

          {!splitLinesLoading && (
            <>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Account Name</th>
                      <th style={styles.th}>Company</th>
                      <th style={styles.th}>Debit</th>
                      <th style={styles.th}>Credit</th>
                      <th style={styles.th}>Split per store</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {splitLines.map((line, i) => {
                      const debitNum = Number(line.debit);
                      const creditNum = Number(line.credit);
                      const debitBad = Number.isFinite(debitNum) && debitNum < 0;
                      const creditBad = Number.isFinite(creditNum) && creditNum < 0;
                      const bothFilled = debitNum > 0 && creditNum > 0;
                      return (
                        <tr key={i} style={styles.tr}>
                          <td style={styles.td}>
                            <input
                              style={styles.cellInput}
                              placeholder="e.g. Personal Expense"
                              value={line.account_name}
                              onChange={(e) => updateSplitLine(i, "account_name", e.target.value)}
                            />
                          </td>
                          <td style={styles.td}>
                            <select
                              style={styles.cellInput}
                              value={line.company_name}
                              onChange={(e) => updateSplitLine(i, "company_name", e.target.value)}
                            >
                              <option value="">— select —</option>
                              {companyOptions.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              style={{ ...styles.numInput, ...((debitBad || bothFilled) ? styles.numInputError : {}) }}
                              value={line.debit}
                              onChange={(e) => updateSplitLine(i, "debit", e.target.value)}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              style={{ ...styles.numInput, ...((creditBad || bothFilled) ? styles.numInputError : {}) }}
                              value={line.credit}
                              onChange={(e) => updateSplitLine(i, "credit", e.target.value)}
                            />
                          </td>
                          <td style={{ ...styles.td, textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={line.split_per_store}
                              onChange={(e) => updateSplitLine(i, "split_per_store", e.target.checked)}
                            />
                          </td>
                          <td style={styles.td}>
                            <button style={styles.linkBtn} onClick={() => removeSplitLine(i)}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {splitLineErrors.length > 0 && (
                <div style={styles.errorBanner}>
                  {splitLineErrors.map((msg, i) => (
                    <div key={i}>{msg}</div>
                  ))}
                </div>
              )}

              <div style={styles.actionsRow}>
                <button style={styles.addBtn} onClick={addSplitLine}>
                  + Add line
                </button>
                <button style={styles.saveBtn} onClick={handleSaveSplitLines} disabled={splitSaving || splitLineErrors.length > 0}>
                  {splitSaving ? "Saving…" : "Save"}
                </button>
                {splitSaveMessage && <span style={styles.info}>{splitSaveMessage}</span>}
                <span style={splitEnteredBalanced ? styles.balanceOk : styles.balanceBad}>
                  Entered Dr {splitEnteredDebit.toFixed(2)} · Cr {splitEnteredCredit.toFixed(2)}
                  {splitEnteredBalanced ? " ✓ Balanced" : ` ⚠ Out of balance by ${(splitEnteredDebit - splitEnteredCredit).toFixed(2)}`}
                </span>
              </div>
            </>
          )}
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>2. Generate Journal Entry</h2>
          <button style={styles.generateBtn} onClick={handleGenerateSplit} disabled={!canGenerateSplit}>
            {splitGenerating ? "Generating…" : "Allocate & Generate Journal Entry"}
          </button>
          {splitGenerateError && <div style={styles.errorBanner}>{splitGenerateError}</div>}
        </div>

        {splitResult && splitResult.skippedCompanies.length > 0 && (
          <div style={styles.warnBanner}>
            These companies have zero Active stores in Store Master, so those lines were skipped:{" "}
            <strong>{splitResult.skippedCompanies.join(", ")}</strong>.
          </div>
        )}

        {splitResult && splitTotalRows > 0 && (
          <>
            <div style={styles.actionsRow}>
              <button style={styles.previewBtn} onClick={() => setSplitPreviewOpen((v) => !v)}>
                👁 {splitPreviewOpen ? "Hide preview" : "Preview selected"}
              </button>
              <button style={styles.xlsxBtn} onClick={() => downloadSplitAllZip("xlsx")}>
                📘 Download all (XLSX)
              </button>
              <button style={styles.csvBtnMuted} onClick={() => downloadSplitAllZip("csv")}>
                Download all (CSV)
              </button>
            </div>

            <div style={styles.resultsHeader}>
              <h2 style={styles.h2}>
                {splitCompanyEntries.length} compan{splitCompanyEntries.length === 1 ? "y" : "ies"} · {splitTotalRows} JE line
                {splitTotalRows === 1 ? "" : "s"} · Total ${splitGrandTotal.toFixed(2)}
              </h2>
              <label style={styles.selectAllLabel}>
                <input
                  type="checkbox"
                  checked={splitSelectedCompanies.size === splitCompanyEntries.length && splitCompanyEntries.length > 0}
                  onChange={(e) =>
                    toggleSplitSelectAll(
                      splitCompanyEntries.map(([company]) => company),
                      e.target.checked
                    )
                  }
                />
                Select all
              </label>
            </div>

            <div style={styles.companyGrid}>
              {splitCompanyEntries.map(([company, rows]) => (
                <div key={company} style={styles.companyCard}>
                  <label style={styles.companyCheckLabel}>
                    <input
                      type="checkbox"
                      checked={splitSelectedCompanies.has(company)}
                      onChange={() => toggleSplitCompany(company)}
                    />
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={styles.companyName}>{company}</span>
                      <span style={styles.companyMeta}>
                        {rows.length} JE line(s) · ${debitTotal(rows).toFixed(2)}
                      </span>
                    </div>
                  </label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={styles.secondaryBtn} onClick={() => downloadSplitCompanyXlsx(company, rows)}>
                      XLSX
                    </button>
                    <button style={styles.secondaryBtn} onClick={() => downloadSplitCompanyCsv(company, rows)}>
                      CSV
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {splitPreviewOpen && (
              <div style={styles.previewGroups}>
                {splitCompanyEntries
                  .filter(([company]) => splitSelectedCompanies.has(company))
                  .map(([company, rows]) => {
                    const totalDebit = rows.reduce((sum, r) => sum + (Number(r.Debit) || 0), 0);
                    const totalCredit = rows.reduce((sum, r) => sum + (Number(r.Credit) || 0), 0);
                    const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
                    const storeCount = companyStoreCounts[company] ?? rows.length;
                    const roundingNote = splitResult.roundingAdjustments?.[company];

                    return (
                      <div key={company} style={styles.previewGroup}>
                        <div style={styles.previewGroupHeader}>
                          <span style={styles.companyName}>
                            {company} <span style={styles.companyMeta}>({storeCount} active store(s))</span>
                          </span>
                          <span style={balanced ? styles.balanceOk : styles.balanceBad}>
                            Dr {totalDebit.toFixed(2)} · Cr {totalCredit.toFixed(2)}
                            {balanced ? " ✓ Balanced" : ` ⚠ Out of balance by ${(totalDebit - totalCredit).toFixed(2)}`}
                          </span>
                        </div>
                        {roundingNote && (
                          <div style={styles.roundingNote}>
                            Rounding adjustment: {roundingNote.total >= 0 ? "+" : ""}
                            {roundingNote.total.toFixed(2)} placed in {roundingNote.store} to keep this company exact.
                          </div>
                        )}
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

  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 14px" },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 760 },

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
    marginBottom: 14,
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

  td: {
    padding: "6px 8px",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    whiteSpace: "nowrap",
  },
  cellInput: {
    width: "100%",
    minWidth: 160,
    padding: "6px 8px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    fontSize: 12.5,
    fontFamily: "var(--font-mono)",
    background: "var(--field)",
    color: "var(--ink)",
  },
  numInput: {
    width: 110,
    padding: "6px 8px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    fontFamily: "var(--font-mono)",
    fontSize: 12.5,
    background: "var(--field)",
    color: "var(--ink)",
  },
  numInputError: { borderColor: "var(--danger)", boxShadow: "0 0 0 1px var(--danger)" },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--danger)",
    fontSize: 12,
    fontWeight: 600,
    padding: 0,
    fontFamily: "var(--font-body)",
  },
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, alignItems: "center" },
  addBtn: {
    background: "transparent",
    color: "var(--ledger)",
    border: "1px solid var(--ledger)",
    borderRadius: 7,
    padding: "9px 16px",
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
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
  roundingNote: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-soft)", marginBottom: 6 },
  previewWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    maxHeight: 320,
    marginTop: 4,
  },

  companyMeta: { fontSize: 10.5, color: "var(--ink-soft)", fontWeight: 500, fontFamily: "var(--font-body)" },

};
