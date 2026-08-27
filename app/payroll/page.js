"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  PAYROLL_FIELDS,
  ARCADE_SUBCONTRACTOR_FIELDS,
  parseTimesheetWorkbook,
  parsePayrollReportFile,
  guessCompanyFromFileName,
  buildStoreHours,
  allocatePayrollByHours,
  expectedCompanyTotal,
  buildFinalDataRows,
  buildJournalEntryRows,
  buildArcadeSubcontractorJournalEntryRows,
  formatMMDDYYYYFromIso,
  JE_COLUMNS,
  rowsToCsv,
  rowsToXlsxBuffer,
} from "@/lib/payrollProcessor";
import { buildExportFileName, parseDateRangeFromFileName } from "@/lib/fileNaming";
import { buildStoreNameMap, remapStoreNamesInRows } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";
import { triggerDownload, todayIso, firstOfMonthIso } from "@/lib/download";
import { sharedPageStyles } from "@/lib/pageStyles";
import {
  findNegativeGridEntries,
  checkRawRowsUsable,
  evaluateAddSubtractExpression,
  isValidNumericExpressionInput,
} from "@/lib/validation";

const STATE_KEY = "payroll";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv;charset=utf-8;";

function emptyRow(fields) {
  const row = {};
  for (const { key } of fields) row[key] = "";
  return row;
}

export default function PayrollPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;
  const [activeTab, setActiveTab] = useState(saved?.activeTab ?? "payroll");

  const [companies, setCompanies] = useState([]);
  const [storeNameMap, setStoreNameMap] = useState({});

  // ==================== Payroll tab ====================
  const [payPeriodStart, setPayPeriodStart] = useState(saved?.payPeriodStart ?? firstOfMonthIso());
  const [payPeriodDate, setPayPeriodDate] = useState(saved?.payPeriodDate ?? todayIso());
  const [companyRows, setCompanyRows] = useState({}); // { [company]: { [fieldKey]: string } }
  const [gridLoading, setGridLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  const [payrollReportDragOver, setPayrollReportDragOver] = useState(false);
  const [payrollReportResults, setPayrollReportResults] = useState([]); // [{ fileName, company, values, unmatchedHeaders, periodStart, periodEnd, periodMismatch, error }]
  const payrollReportInputRef = useRef(null);

  // Companies whose most recently uploaded report file's declared "Time
  // Period" didn't match the Period Start/Pay Period Date selected at
  // upload time — periodMismatch is decided once per file, in
  // handlePayrollReportFiles, and blocks applying that file's values, so
  // this is just for the grid's red-row warning, not a live re-check.
  const periodMismatchCompanies = useMemo(() => {
    const set = new Set();
    const seen = new Set(); // results are newest-first; only the latest upload per company counts
    for (const r of payrollReportResults) {
      if (!r.company) continue;
      if (seen.has(r.company)) continue;
      seen.add(r.company);
      if (r.periodMismatch) set.add(r.company);
    }
    return set;
  }, [payrollReportResults]);

  const [timesheetFileName, setTimesheetFileName] = useState(saved?.timesheetFileName ?? null);
  const [timesheetDragOver, setTimesheetDragOver] = useState(false);
  const [timesheetError, setTimesheetError] = useState("");
  const [storeHours, setStoreHours] = useState(saved?.storeHours ?? null); // { [elevate_name]: hours } once loaded
  const timesheetInputRef = useRef(null);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [result, setResult] = useState(saved?.result ?? null); // { byCompany, zeroHourCompanies, unmatchedTimesheetStores, zeroHourStores, expectedTotals }
  const [previewOpen, setPreviewOpen] = useState(saved?.previewOpen ?? false);
  const [selectedCompanies, setSelectedCompanies] = useState(new Set(saved?.selectedCompanies ?? []));

  // ==================== Arcade & Subcontractor tab ====================
  const [arcadePayPeriodDate, setArcadePayPeriodDate] = useState(saved?.arcadePayPeriodDate ?? todayIso());
  const [arcadeCompanyRows, setArcadeCompanyRows] = useState({});
  const [arcadeGridLoading, setArcadeGridLoading] = useState(false);
  const [arcadeSaving, setArcadeSaving] = useState(false);
  const [arcadeSaveMessage, setArcadeSaveMessage] = useState("");
  const [arcadeSaveError, setArcadeSaveError] = useState("");

  const [arcadeTimesheetFileName, setArcadeTimesheetFileName] = useState(saved?.arcadeTimesheetFileName ?? null);
  const [arcadeTimesheetDragOver, setArcadeTimesheetDragOver] = useState(false);
  const [arcadeTimesheetError, setArcadeTimesheetError] = useState("");
  const [arcadeStoreHours, setArcadeStoreHours] = useState(saved?.arcadeStoreHours ?? null);
  const arcadeTimesheetInputRef = useRef(null);

  const [arcadeGenerating, setArcadeGenerating] = useState(false);
  const [arcadeGenerateError, setArcadeGenerateError] = useState("");
  const [arcadeResult, setArcadeResult] = useState(saved?.arcadeResult ?? null); // { byCompany, zeroHourCompanies, unmatchedTimesheetStores, expectedTotals }
  const [arcadePreviewOpen, setArcadePreviewOpen] = useState(saved?.arcadePreviewOpen ?? false);
  const [arcadeSelectedCompanies, setArcadeSelectedCompanies] = useState(new Set(saved?.arcadeSelectedCompanies ?? []));

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
      payPeriodStart,
      payPeriodDate,
      timesheetFileName,
      storeHours,
      result,
      previewOpen,
      selectedCompanies: Array.from(selectedCompanies),
      arcadePayPeriodDate,
      arcadeTimesheetFileName,
      arcadeStoreHours,
      arcadeResult,
      arcadePreviewOpen,
      arcadeSelectedCompanies: Array.from(arcadeSelectedCompanies),
    });
  }, [
    activeTab,
    payPeriodStart,
    payPeriodDate,
    timesheetFileName,
    storeHours,
    result,
    previewOpen,
    selectedCompanies,
    arcadePayPeriodDate,
    arcadeTimesheetFileName,
    arcadeStoreHours,
    arcadeResult,
    arcadePreviewOpen,
    arcadeSelectedCompanies,
  ]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("stores")
      .select("company_name")
      .order("company_name", { ascending: true })
      .then(({ data, error }) => {
        if (error) return;
        const unique = Array.from(new Set((data || []).map((r) => r.company_name).filter(Boolean)));
        setCompanies(unique);
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

  // ==================== Payroll tab logic ====================

  const loadGrid = useCallback(async (dateStr, companyList) => {
    if (!dateStr || companyList.length === 0) return;
    setGridLoading(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase.from("payroll_company_data").select("*").eq("pay_period_date", dateStr);
      if (error) throw new Error(error.message);
      const existingByCompany = {};
      for (const row of data || []) existingByCompany[row.company_name] = row;

      const next = {};
      for (const company of companyList) {
        const existing = existingByCompany[company];
        const row = emptyRow(PAYROLL_FIELDS);
        if (existing) {
          for (const { key } of PAYROLL_FIELDS) {
            row[key] = existing[key] != null ? String(existing[key]) : "";
          }
        }
        next[company] = row;
      }
      setCompanyRows(next);
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setGridLoading(false);
    }
  }, []);

  useEffect(() => {
    if (companies.length > 0) loadGrid(payPeriodDate, companies);
  }, [companies, payPeriodDate, loadGrid]);

  function handleCellChange(company, key, value) {
    setCompanyRows((prev) => ({
      ...prev,
      [company]: { ...prev[company], [key]: value },
    }));
  }

  function applyPayrollReportValues(company, values) {
    setCompanyRows((prev) => ({
      ...prev,
      [company]: {
        ...prev[company],
        ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
      },
    }));
  }

  async function handlePayrollReportFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const expectedStart = formatMMDDYYYYFromIso(payPeriodStart);
    const expectedEnd = formatMMDDYYYYFromIso(payPeriodDate);
    const results = [];
    for (const file of files) {
      try {
        const buffer = await file.arrayBuffer();
        const { values, unmatchedHeaders, periodStart, periodEnd } = parsePayrollReportFile(buffer);
        const periodMismatch = !!periodStart && !!periodEnd && (periodStart !== expectedStart || periodEnd !== expectedEnd);
        const company = guessCompanyFromFileName(file.name, companies);
        // Never apply a file whose own declared Time Period doesn't match
        // the selected Period Start/Pay Period Date — a wrong-period file
        // must be rejected, not silently merged into the grid.
        if (company && !periodMismatch) applyPayrollReportValues(company, values);
        results.push({ fileName: file.name, company, values, unmatchedHeaders, periodStart, periodEnd, periodMismatch, error: null });
      } catch (e) {
        results.push({
          fileName: file.name,
          company: null,
          values: null,
          unmatchedHeaders: [],
          periodStart: null,
          periodEnd: null,
          periodMismatch: false,
          error: e.message || String(e),
        });
      }
    }
    setPayrollReportResults((prev) => [...results, ...prev]);
  }

  function handlePayrollReportFileChange(e) {
    handlePayrollReportFiles(e.target.files);
    e.target.value = "";
  }

  function handlePayrollReportDrop(e) {
    e.preventDefault();
    setPayrollReportDragOver(false);
    handlePayrollReportFiles(e.dataTransfer.files);
  }

  function assignPayrollReportCompany(index, company) {
    setPayrollReportResults((prev) => {
      const item = prev[index];
      if (!item) return prev;
      if (!item.periodMismatch) applyPayrollReportValues(company, item.values);
      const next = [...prev];
      next[index] = { ...item, company };
      return next;
    });
  }

  function handleClearAllPayrollAmounts() {
    setCompanyRows((prev) => {
      const next = {};
      for (const company of companies) next[company] = emptyRow(PAYROLL_FIELDS);
      return next;
    });
    setPayrollReportResults([]);
  }

  function handleGridKeyDown(e, rowIndex, colIndex) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const nextRow = e.key === "ArrowUp" ? rowIndex - 1 : rowIndex + 1;
    document.getElementById(`payroll-cell-${nextRow}-${colIndex}`)?.focus();
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const negatives = findNegativeGridEntries(companyRows, PAYROLL_FIELDS);
      if (negatives.length > 0) {
        throw new Error(`Amounts can't be negative — fix: ${negatives.join(", ")}.`);
      }
      const supabase = createClient();
      const rows = companies.map((company) => {
        const row = { pay_period_date: payPeriodDate, company_name: company };
        for (const { key } of PAYROLL_FIELDS) {
          const raw = companyRows[company]?.[key];
          const n = Number(raw);
          row[key] = Number.isFinite(n) ? n : 0;
        }
        return row;
      });
      const { error } = await supabase.from("payroll_company_data").upsert(rows, { onConflict: "pay_period_date,company_name" });
      if (error) throw new Error(error.message);
      setSaveMessage("Saved.");
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  const processTimesheet = useCallback(async (file) => {
    setTimesheetError("");
    setStoreHours(null);
    try {
      const buffer = await file.arrayBuffer();
      const rawRows = parseTimesheetWorkbook(buffer);
      if (!rawRows.length) throw new Error("No rows found in this timesheet file.");
      if (!("Store" in rawRows[0]) || !("Total Working Time Decimal" in rawRows[0])) {
        throw new Error(
          "This file doesn't look like an Employee Timesheet export — expected 'Store' and 'Total Working Time Decimal' columns."
        );
      }
      const usableIssue = checkRawRowsUsable(rawRows, ["Store"], "Employee Timesheet file");
      if (usableIssue) throw new Error(usableIssue);
      const { start, end } = parseDateRangeFromFileName(file.name);
      if (start && end) {
        const expectedStart = formatMMDDYYYYFromIso(payPeriodStart);
        const expectedEnd = formatMMDDYYYYFromIso(payPeriodDate);
        if (start !== expectedStart || end !== expectedEnd) {
          throw new Error(
            `This timesheet's dates (${start}–${end}) don't match the selected Period Start/Pay Period Date (${expectedStart}–${expectedEnd}) — not loaded. Fix the period above or upload the correct timesheet.`
          );
        }
      }
      const mappedRows = remapStoreNamesInRows(rawRows, "Store", storeNameMap);
      setStoreHours(buildStoreHours(mappedRows));
    } catch (e) {
      setTimesheetError(e.message || String(e));
    }
  }, [storeNameMap, payPeriodStart, payPeriodDate]);

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

  async function handleGenerate() {
    setGenerating(true);
    setGenerateError("");
    setResult(null);
    setPreviewOpen(false);
    try {
      const negatives = findNegativeGridEntries(companyRows, PAYROLL_FIELDS);
      if (negatives.length > 0) {
        throw new Error(`Amounts can't be negative — fix: ${negatives.join(", ")}.`);
      }
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);

      const companyPayrollRows = companies.map((company) => {
        const row = { company_name: company };
        for (const { key } of PAYROLL_FIELDS) {
          const n = Number(companyRows[company]?.[key]);
          row[key] = Number.isFinite(n) ? n : 0;
        }
        return row;
      });

      const { allocatedRows, zeroHourCompanies, unmatchedTimesheetStores, zeroHourStores } = allocatePayrollByHours(
        companyPayrollRows,
        storeMaster,
        storeHours || {}
      );
      const finalRows = buildFinalDataRows(allocatedRows);
      const byCompany = buildJournalEntryRows(finalRows, formatMMDDYYYYFromIso(payPeriodDate));
      const expectedTotals = {};
      for (const row of companyPayrollRows) expectedTotals[row.company_name] = expectedCompanyTotal(row);
      setResult({ byCompany, zeroHourCompanies, unmatchedTimesheetStores, zeroHourStores, expectedTotals });
      setSelectedCompanies(new Set(Object.keys(byCompany)));
      savePendingMappings({ unmatchedStoreNames: unmatchedTimesheetStores });
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
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "PayrollJE", rows, "Journal Date", "xlsx"));
  }

  function downloadCompanyCsv(company, rows) {
    triggerDownload(new Blob([rowsToCsv(rows)], { type: CSV_MIME }), buildExportFileName(company, "PayrollJE", rows, "Journal Date", "csv"));
  }

  async function downloadAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(result.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "PayrollJE", rows, "Journal Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "PayrollJE", rows, "Journal Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Payroll-AllCompanies-${format}.zip`);
  }

  // ==================== Arcade & Subcontractor tab logic ====================

  const loadArcadeGrid = useCallback(async (dateStr, companyList) => {
    if (!dateStr || companyList.length === 0) return;
    setArcadeGridLoading(true);
    setArcadeSaveMessage("");
    setArcadeSaveError("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("payroll_arcade_subcontractor_data")
        .select("*")
        .eq("pay_period_date", dateStr);
      if (error) throw new Error(error.message);
      const existingByCompany = {};
      for (const row of data || []) existingByCompany[row.company_name] = row;

      const next = {};
      for (const company of companyList) {
        const existing = existingByCompany[company];
        const row = emptyRow(ARCADE_SUBCONTRACTOR_FIELDS);
        if (existing) {
          for (const { key } of ARCADE_SUBCONTRACTOR_FIELDS) {
            row[key] = existing[key] != null ? String(existing[key]) : "";
          }
        }
        next[company] = row;
      }
      setArcadeCompanyRows(next);
    } catch (e) {
      setArcadeSaveError(e.message || String(e));
    } finally {
      setArcadeGridLoading(false);
    }
  }, []);

  useEffect(() => {
    if (companies.length > 0) loadArcadeGrid(arcadePayPeriodDate, companies);
  }, [companies, arcadePayPeriodDate, loadArcadeGrid]);

  function handleArcadeCellChange(company, key, value) {
    // Reject the whole keystroke rather than stripping bad characters out
    // of it -- avoids the cursor jumping around when a disallowed
    // character (a letter, a 2nd ".", a 3rd decimal digit) gets typed.
    if (!isValidNumericExpressionInput(value)) return;
    setArcadeCompanyRows((prev) => ({
      ...prev,
      [company]: { ...prev[company], [key]: value },
    }));
  }

  // Lets a cell be typed as "100+150" and resolve to 250 -- evaluated on
  // blur and on Enter (not on every keystroke, so "100+" mid-typing isn't
  // clobbered before the second number is entered).
  function commitArcadeCellExpression(company, key) {
    const raw = arcadeCompanyRows[company]?.[key];
    const evaluated = evaluateAddSubtractExpression(raw);
    if (evaluated !== null && String(evaluated) !== String(raw ?? "")) {
      handleArcadeCellChange(company, key, String(evaluated));
    }
  }

  function handleArcadeGridKeyDown(e, rowIndex, colIndex) {
    if (e.key === "Enter") {
      const company = companies[rowIndex];
      const key = ARCADE_SUBCONTRACTOR_FIELDS[colIndex]?.key;
      if (company && key) commitArcadeCellExpression(company, key);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const nextRow = e.key === "ArrowUp" ? rowIndex - 1 : rowIndex + 1;
    document.getElementById(`arcade-cell-${nextRow}-${colIndex}`)?.focus();
  }

  async function handleArcadeSave() {
    setArcadeSaving(true);
    setArcadeSaveMessage("");
    setArcadeSaveError("");
    try {
      const negatives = findNegativeGridEntries(arcadeCompanyRows, ARCADE_SUBCONTRACTOR_FIELDS);
      if (negatives.length > 0) {
        throw new Error(`Amounts can't be negative — fix: ${negatives.join(", ")}.`);
      }
      const supabase = createClient();
      const rows = companies.map((company) => {
        const row = { pay_period_date: arcadePayPeriodDate, company_name: company };
        for (const { key } of ARCADE_SUBCONTRACTOR_FIELDS) {
          const raw = arcadeCompanyRows[company]?.[key];
          const n = Number(raw);
          row[key] = Number.isFinite(n) ? n : 0;
        }
        return row;
      });
      const { error } = await supabase
        .from("payroll_arcade_subcontractor_data")
        .upsert(rows, { onConflict: "pay_period_date,company_name" });
      if (error) throw new Error(error.message);
      setArcadeSaveMessage("Saved.");
    } catch (e) {
      setArcadeSaveError(e.message || String(e));
    } finally {
      setArcadeSaving(false);
    }
  }

  const processArcadeTimesheet = useCallback(async (file) => {
    setArcadeTimesheetError("");
    setArcadeStoreHours(null);
    try {
      const buffer = await file.arrayBuffer();
      const rawRows = parseTimesheetWorkbook(buffer);
      if (!rawRows.length) throw new Error("No rows found in this timesheet file.");
      if (!("Store" in rawRows[0]) || !("Total Working Time Decimal" in rawRows[0])) {
        throw new Error(
          "This file doesn't look like an Employee Timesheet export — expected 'Store' and 'Total Working Time Decimal' columns."
        );
      }
      const usableIssue = checkRawRowsUsable(rawRows, ["Store"], "Employee Timesheet file");
      if (usableIssue) throw new Error(usableIssue);
      const mappedRows = remapStoreNamesInRows(rawRows, "Store", storeNameMap);
      setArcadeStoreHours(buildStoreHours(mappedRows));
    } catch (e) {
      setArcadeTimesheetError(e.message || String(e));
    }
  }, [storeNameMap]);

  function handleArcadeTimesheetFile(file) {
    if (!file) return;
    setArcadeTimesheetFileName(file.name);
    processArcadeTimesheet(file);
  }

  function handleArcadeTimesheetFileChange(e) {
    handleArcadeTimesheetFile(e.target.files?.[0]);
  }

  function handleArcadeTimesheetDrop(e) {
    e.preventDefault();
    setArcadeTimesheetDragOver(false);
    handleArcadeTimesheetFile(e.dataTransfer.files?.[0]);
  }

  async function handleArcadeGenerate() {
    setArcadeGenerating(true);
    setArcadeGenerateError("");
    setArcadeResult(null);
    setArcadePreviewOpen(false);
    try {
      const negatives = findNegativeGridEntries(arcadeCompanyRows, ARCADE_SUBCONTRACTOR_FIELDS);
      if (negatives.length > 0) {
        throw new Error(`Amounts can't be negative — fix: ${negatives.join(", ")}.`);
      }
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);

      const companyRowsArr = companies.map((company) => {
        const row = { company_name: company };
        for (const { key } of ARCADE_SUBCONTRACTOR_FIELDS) {
          const n = Number(arcadeCompanyRows[company]?.[key]);
          row[key] = Number.isFinite(n) ? n : 0;
        }
        return row;
      });

      const { allocatedRows, zeroHourCompanies, unmatchedTimesheetStores } = allocatePayrollByHours(
        companyRowsArr,
        storeMaster,
        arcadeStoreHours || {},
        ARCADE_SUBCONTRACTOR_FIELDS
      );
      const byCompany = buildArcadeSubcontractorJournalEntryRows(allocatedRows, formatMMDDYYYYFromIso(arcadePayPeriodDate));
      const expectedTotals = {};
      for (const row of companyRowsArr) {
        expectedTotals[row.company_name] = ARCADE_SUBCONTRACTOR_FIELDS.reduce((sum, { key }) => sum + (Number(row[key]) || 0), 0);
      }
      setArcadeResult({ byCompany, zeroHourCompanies, unmatchedTimesheetStores, expectedTotals });
      setArcadeSelectedCompanies(new Set(Object.keys(byCompany)));
      savePendingMappings({ unmatchedStoreNames: unmatchedTimesheetStores });
    } catch (e) {
      setArcadeGenerateError(e.message || String(e));
    } finally {
      setArcadeGenerating(false);
    }
  }

  function toggleArcadeCompany(company) {
    setArcadeSelectedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  function toggleArcadeSelectAll(allCompanyNames, checked) {
    setArcadeSelectedCompanies(checked ? new Set(allCompanyNames) : new Set());
  }

  async function downloadArcadeCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, company);
    triggerDownload(new Blob([buf], { type: XLSX_MIME }), buildExportFileName(company, "ArcadeSub", rows, "Journal Date", "xlsx"));
  }

  function downloadArcadeCompanyCsv(company, rows) {
    triggerDownload(new Blob([rowsToCsv(rows)], { type: CSV_MIME }), buildExportFileName(company, "ArcadeSub", rows, "Journal Date", "csv"));
  }

  async function downloadArcadeAllZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(arcadeResult.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "ArcadeSub", rows, "Journal Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "ArcadeSub", rows, "Journal Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Payroll-Arcade-AllCompanies-${format}.zip`);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const debitTotal = (rows) => rows.reduce((sum, r) => sum + (Number(r.Debit) || 0), 0);

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const grandTotal = companyEntries.reduce((sum, [, rows]) => sum + debitTotal(rows), 0);
  const canGenerate = !!payPeriodDate && !!storeHours && companies.length > 0 && !generating;

  const arcadeCompanyEntries = arcadeResult ? Object.entries(arcadeResult.byCompany) : [];
  const arcadeTotalRows = arcadeCompanyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const arcadeGrandTotal = arcadeCompanyEntries.reduce((sum, [, rows]) => sum + debitTotal(rows), 0);
  const arcadeCanGenerate = !!arcadePayPeriodDate && !!arcadeStoreHours && companies.length > 0 && !arcadeGenerating;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Payroll</h1>
          <p style={styles.pageSub}>
            {activeTab === "payroll"
              ? "Type in company-wise payroll, upload the Employee Timesheet, and generate a per-store Journal Entry allocated by hours worked."
              : "Type in company-wise Arcade & Subcontractor amounts, upload the Employee Timesheet, and generate a per-store Journal Entry allocated by hours worked."}
          </p>
        </div>

        <div style={styles.tabRow}>
          <button style={activeTab === "payroll" ? styles.tabActive : styles.tab} onClick={() => setActiveTab("payroll")}>
            Payroll
          </button>
          <button style={activeTab === "arcade" ? styles.tabActive : styles.tab} onClick={() => setActiveTab("arcade")}>
            Arcade &amp; Subcontractor
          </button>
        </div>

        {activeTab === "payroll" && (
          <>
            <div style={styles.card}>
              <h2 style={styles.h2}>1. Pay period & company payroll</h2>
              <div style={styles.fieldRow}>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Period Start</span>
                  <input
                    type="date"
                    style={styles.dateInput}
                    value={payPeriodStart}
                    onChange={(e) => setPayPeriodStart(e.target.value)}
                  />
                </label>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Pay Period Date</span>
                  <input
                    type="date"
                    style={styles.dateInput}
                    value={payPeriodDate}
                    onChange={(e) => setPayPeriodDate(e.target.value)}
                  />
                </label>
              </div>

              <div style={styles.reportUploadBlock}>
                <span style={styles.fieldLabel}>Or upload company payroll report(s)</span>
                <span style={styles.info}>
                  Each file's own "Time Period" is checked against Period Start–Pay Period Date above — a file that
                  doesn't match is rejected (not applied) and that company is highlighted red in the grid below.
                </span>
                <input
                  ref={payrollReportInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  multiple
                  onChange={handlePayrollReportFileChange}
                  style={{ display: "none" }}
                />
                <div
                  style={{ ...styles.dropzone, ...(payrollReportDragOver ? styles.dropzoneActive : {}) }}
                  onClick={() => payrollReportInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setPayrollReportDragOver(true);
                  }}
                  onDragLeave={() => setPayrollReportDragOver(false)}
                  onDrop={handlePayrollReportDrop}
                >
                  <div style={styles.dropzoneIcon}>📄</div>
                  <div style={styles.dropzoneText}>
                    Choose or drop one or more "Custom Report" exports (.xlsx/.csv) — one file per company, any
                    column order
                  </div>
                </div>

                {payrollReportResults.length > 0 && (
                  <div style={styles.reportResultsList}>
                    <div style={styles.reportResultsHeader}>
                      <button style={styles.clearAllBtn} onClick={handleClearAllPayrollAmounts}>
                        Clear all
                      </button>
                    </div>
                    {payrollReportResults.map((r, i) => (
                      <div key={i} style={styles.reportResultRow}>
                        <span style={styles.reportFileName}>{r.fileName}</span>
                        {r.error ? (
                          <span style={styles.reportError}>{r.error}</span>
                        ) : r.periodMismatch ? (
                          <span style={styles.reportError}>
                            ⚠ NOT applied — file period {r.periodStart}–{r.periodEnd} doesn't match the selected Period
                            Start/Pay Period Date ({formatMMDDYYYYFromIso(payPeriodStart)}–{formatMMDDYYYYFromIso(payPeriodDate)})
                            {r.company && ` (file looks like ${r.company})`}. Fix the period above or re-upload the
                            correct file.
                          </span>
                        ) : r.company ? (
                          <span style={styles.reportOk}>
                            → {r.company} ({Object.keys(r.values).length}/{PAYROLL_FIELDS.length} fields)
                            {r.periodStart && r.periodEnd && ` · file period ${r.periodStart}–${r.periodEnd}`}
                            {r.unmatchedHeaders.length > 0 && ` — ignored unrecognized column(s): ${r.unmatchedHeaders.join(", ")}`}
                          </span>
                        ) : (
                          <label style={styles.reportAssign}>
                            Couldn't tell which company from the file name — pick one:
                            <select
                              style={styles.reportAssignSelect}
                              value=""
                              onChange={(e) => e.target.value && assignPayrollReportCompany(i, e.target.value)}
                            >
                              <option value="">— select —</option>
                              {companies.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {gridLoading && <div style={styles.info}>Loading…</div>}
              {saveError && <div style={styles.errorBanner}>{saveError}</div>}

              {!gridLoading && companies.length > 0 && (
                <>
                  <div style={styles.tableWrap}>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={{ ...styles.th, position: "sticky", left: 0, background: "var(--panel)" }}>Company</th>
                          {PAYROLL_FIELDS.map(({ key, label }) => (
                            <th key={key} style={styles.th}>
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {companies.map((company, rowIndex) => {
                          const periodMismatch = periodMismatchCompanies.has(company);
                          return (
                            <tr key={company} style={{ ...styles.tr, ...(periodMismatch ? styles.trMismatch : {}) }}>
                              <td
                                style={{
                                  ...styles.td,
                                  position: "sticky",
                                  left: 0,
                                  background: periodMismatch ? "var(--danger-bg)" : "var(--panel)",
                                  fontWeight: 600,
                                  color: periodMismatch ? "var(--danger)" : undefined,
                                }}
                              >
                                {company}
                                {periodMismatch && <span style={styles.mismatchBadge}> ⚠ period mismatch</span>}
                              </td>
                              {PAYROLL_FIELDS.map(({ key }, colIndex) => {
                                const isNegative = Number(companyRows[company]?.[key]) < 0;
                                return (
                                  <td key={key} style={styles.td}>
                                    <input
                                      id={`payroll-cell-${rowIndex}-${colIndex}`}
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      style={{ ...styles.numInput, ...(isNegative ? styles.numInputError : {}) }}
                                      value={companyRows[company]?.[key] ?? ""}
                                      onChange={(e) => handleCellChange(company, key, e.target.value)}
                                      onKeyDown={(e) => handleGridKeyDown(e, rowIndex, colIndex)}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div style={styles.actionsRow}>
                    <button style={styles.saveBtn} onClick={handleSave} disabled={saving}>
                      {saving ? "Saving…" : "Save"}
                    </button>
                    {saveMessage && <span style={styles.info}>{saveMessage}</span>}
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
              {storeHours && !timesheetError && (
                <div style={styles.info}>
                  {Object.keys(storeHours).length} store(s), {Object.values(storeHours).reduce((a, b) => a + b, 0).toFixed(2)}{" "}
                  total hours found.
                </div>
              )}
            </div>

            <div style={styles.card}>
              <h2 style={styles.h2}>3. Generate Journal Entry</h2>
              <button style={styles.generateBtn} onClick={handleGenerate} disabled={!canGenerate}>
                {generating ? "Generating…" : "Allocate & Generate Journal Entry"}
              </button>
              {generateError && <div style={styles.errorBanner}>{generateError}</div>}

              {result && result.zeroHourCompanies.length > 0 && (
                <div style={styles.warnBanner}>
                  {result.zeroHourCompanies.length} compan{result.zeroHourCompanies.length === 1 ? "y has" : "ies have"} no
                  hours in the uploaded timesheet, so no allocation could be made:{" "}
                  <strong>{result.zeroHourCompanies.join(", ")}</strong>.
                </div>
              )}
              {result && result.unmatchedTimesheetStores.length > 0 && (
                <div style={styles.warnBanner}>
                  {result.unmatchedTimesheetStores.length} store name(s) in the timesheet don't match any store's
                  Elevate Name in Store Master, so their hours were ignored:{" "}
                  <strong>{result.unmatchedTimesheetStores.join(", ")}</strong>.
                </div>
              )}
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

                        const expected = result.expectedTotals?.[company];
                        const matchesEntered = expected == null || Math.abs(totalDebit - expected) < 0.01;

                        const storeTotals = {};
                        const storeOrder = [];
                        for (const r of rows) {
                          if (!storeTotals[r.Class]) {
                            storeTotals[r.Class] = { debit: 0, credit: 0 };
                            storeOrder.push(r.Class);
                          }
                          storeTotals[r.Class].debit += Number(r.Debit) || 0;
                          storeTotals[r.Class].credit += Number(r.Credit) || 0;
                        }

                        return (
                          <div key={company} style={styles.previewGroup}>
                            <div style={styles.previewGroupHeader}>
                              <span style={styles.companyName}>{company}</span>
                              <span style={balanced && matchesEntered ? styles.balanceOk : styles.balanceBad}>
                                {expected != null && <>Entered {expected.toFixed(2)} · </>}
                                Dr {totalDebit.toFixed(2)} · Cr {totalCredit.toFixed(2)}
                                {!balanced && ` ⚠ Dr/Cr out of balance by ${(totalDebit - totalCredit).toFixed(2)}`}
                                {balanced && !matchesEntered && ` ⚠ Doesn't match entered amount`}
                                {balanced && matchesEntered && " ✓ Balanced"}
                              </span>
                            </div>
                            <div style={styles.info}>
                              Totals above are for on-screen verification only — not included in the XLSX/CSV download.
                            </div>

                            <div style={styles.previewWrap}>
                              <table style={styles.table}>
                                <thead>
                                  <tr>
                                    <th style={styles.th}>Store</th>
                                    <th style={styles.th}>Debit total</th>
                                    <th style={styles.th}>Credit total</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {storeOrder.map((store) => (
                                    <tr key={store} style={styles.tr}>
                                      <td style={styles.td}>{store}</td>
                                      <td style={styles.td}>{storeTotals[store].debit.toFixed(2)}</td>
                                      <td style={styles.td}>{storeTotals[store].credit.toFixed(2)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>

                            <div style={styles.previewSectionTitle}>Full JV detail</div>
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

        {activeTab === "arcade" && (
          <>
            <div style={styles.card}>
              <h2 style={styles.h2}>1. Pay period & company amounts</h2>
              <div style={styles.fieldRow}>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Pay Period Date</span>
                  <input
                    type="date"
                    style={styles.dateInput}
                    value={arcadePayPeriodDate}
                    onChange={(e) => setArcadePayPeriodDate(e.target.value)}
                  />
                </label>
              </div>

              {arcadeGridLoading && <div style={styles.info}>Loading…</div>}
              {arcadeSaveError && <div style={styles.errorBanner}>{arcadeSaveError}</div>}

              {!arcadeGridLoading && companies.length > 0 && (
                <>
                  <div style={styles.tableWrap}>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={{ ...styles.th, position: "sticky", left: 0, background: "var(--panel)" }}>Company</th>
                          {ARCADE_SUBCONTRACTOR_FIELDS.map(({ key, label }) => (
                            <th key={key} style={styles.th}>
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {companies.map((company, rowIndex) => (
                          <tr key={company} style={styles.tr}>
                            <td style={{ ...styles.td, position: "sticky", left: 0, background: "var(--panel)", fontWeight: 600 }}>
                              {company}
                            </td>
                            {ARCADE_SUBCONTRACTOR_FIELDS.map(({ key }, colIndex) => {
                              const isNegative = Number(arcadeCompanyRows[company]?.[key]) < 0;
                              return (
                                <td key={key} style={styles.td}>
                                  <input
                                    id={`arcade-cell-${rowIndex}-${colIndex}`}
                                    type="text"
                                    inputMode="decimal"
                                    style={{ ...styles.numInput, ...(isNegative ? styles.numInputError : {}) }}
                                    value={arcadeCompanyRows[company]?.[key] ?? ""}
                                    onChange={(e) => handleArcadeCellChange(company, key, e.target.value)}
                                    onKeyDown={(e) => handleArcadeGridKeyDown(e, rowIndex, colIndex)}
                                    onBlur={() => commitArcadeCellExpression(company, key)}
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div style={styles.actionsRow}>
                    <button style={styles.saveBtn} onClick={handleArcadeSave} disabled={arcadeSaving}>
                      {arcadeSaving ? "Saving…" : "Save"}
                    </button>
                    {arcadeSaveMessage && <span style={styles.info}>{arcadeSaveMessage}</span>}
                  </div>
                </>
              )}
            </div>

            <div style={styles.card}>
              <h2 style={styles.h2}>2. Employee Timesheet</h2>
              <input
                ref={arcadeTimesheetInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleArcadeTimesheetFileChange}
                style={{ display: "none" }}
              />
              <div
                style={{ ...styles.dropzone, ...(arcadeTimesheetDragOver ? styles.dropzoneActive : {}) }}
                onClick={() => arcadeTimesheetInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setArcadeTimesheetDragOver(true);
                }}
                onDragLeave={() => setArcadeTimesheetDragOver(false)}
                onDrop={handleArcadeTimesheetDrop}
              >
                <div style={styles.dropzoneIcon}>📄</div>
                <div style={styles.dropzoneText}>
                  {arcadeTimesheetFileName || "Choose or drop Employee Timesheet export (.xlsx/.csv)"}
                </div>
              </div>
              {arcadeTimesheetError && <div style={styles.errorBanner}>{arcadeTimesheetError}</div>}
              {arcadeStoreHours && !arcadeTimesheetError && (
                <div style={styles.info}>
                  {Object.keys(arcadeStoreHours).length} store(s),{" "}
                  {Object.values(arcadeStoreHours)
                    .reduce((a, b) => a + b, 0)
                    .toFixed(2)}{" "}
                  total hours found.
                </div>
              )}
            </div>

            <div style={styles.card}>
              <h2 style={styles.h2}>3. Generate Journal Entry</h2>
              <button style={styles.generateBtn} onClick={handleArcadeGenerate} disabled={!arcadeCanGenerate}>
                {arcadeGenerating ? "Generating…" : "Allocate & Generate Journal Entry"}
              </button>
              {arcadeGenerateError && <div style={styles.errorBanner}>{arcadeGenerateError}</div>}

              {arcadeResult && arcadeResult.zeroHourCompanies.length > 0 && (
                <div style={styles.warnBanner}>
                  {arcadeResult.zeroHourCompanies.length} compan{arcadeResult.zeroHourCompanies.length === 1 ? "y has" : "ies have"}{" "}
                  no hours in the uploaded timesheet, so no allocation could be made:{" "}
                  <strong>{arcadeResult.zeroHourCompanies.join(", ")}</strong>.
                </div>
              )}
              {arcadeResult && arcadeResult.unmatchedTimesheetStores.length > 0 && (
                <div style={styles.warnBanner}>
                  {arcadeResult.unmatchedTimesheetStores.length} store name(s) in the timesheet don't match any
                  store's Elevate Name in Store Master, so their hours were ignored:{" "}
                  <strong>{arcadeResult.unmatchedTimesheetStores.join(", ")}</strong>.
                </div>
              )}
            </div>

            {arcadeResult && arcadeTotalRows > 0 && (
              <>
                <div style={styles.actionsRow}>
                  <button style={styles.previewBtn} onClick={() => setArcadePreviewOpen((v) => !v)}>
                    👁 {arcadePreviewOpen ? "Hide preview" : "Preview selected"}
                  </button>
                  <button style={styles.xlsxBtn} onClick={() => downloadArcadeAllZip("xlsx")}>
                    📘 Download all (XLSX)
                  </button>
                  <button style={styles.csvBtnMuted} onClick={() => downloadArcadeAllZip("csv")}>
                    Download all (CSV)
                  </button>
                </div>

                <div style={styles.resultsHeader}>
                  <h2 style={styles.h2}>
                    {arcadeCompanyEntries.length} compan{arcadeCompanyEntries.length === 1 ? "y" : "ies"} ·{" "}
                    {arcadeTotalRows} JE line{arcadeTotalRows === 1 ? "" : "s"} · Total ${arcadeGrandTotal.toFixed(2)}
                  </h2>
                  <label style={styles.selectAllLabel}>
                    <input
                      type="checkbox"
                      checked={arcadeSelectedCompanies.size === arcadeCompanyEntries.length && arcadeCompanyEntries.length > 0}
                      onChange={(e) =>
                        toggleArcadeSelectAll(
                          arcadeCompanyEntries.map(([company]) => company),
                          e.target.checked
                        )
                      }
                    />
                    Select all
                  </label>
                </div>

                <div style={styles.companyGrid}>
                  {arcadeCompanyEntries.map(([company, rows]) => (
                    <div key={company} style={styles.companyCard}>
                      <label style={styles.companyCheckLabel}>
                        <input
                          type="checkbox"
                          checked={arcadeSelectedCompanies.has(company)}
                          onChange={() => toggleArcadeCompany(company)}
                        />
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={styles.companyName}>{company}</span>
                          <span style={styles.companyMeta}>
                            {rows.length} JE line(s) · ${debitTotal(rows).toFixed(2)}
                          </span>
                        </div>
                      </label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button style={styles.secondaryBtn} onClick={() => downloadArcadeCompanyXlsx(company, rows)}>
                          XLSX
                        </button>
                        <button style={styles.secondaryBtn} onClick={() => downloadArcadeCompanyCsv(company, rows)}>
                          CSV
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {arcadePreviewOpen && (
                  <div style={styles.previewGroups}>
                    {arcadeCompanyEntries
                      .filter(([company]) => arcadeSelectedCompanies.has(company))
                      .map(([company, rows]) => {
                        const totalDebit = rows.reduce((sum, r) => sum + (Number(r.Debit) || 0), 0);
                        const totalCredit = rows.reduce((sum, r) => sum + (Number(r.Credit) || 0), 0);
                        const balanced = Math.abs(totalDebit - totalCredit) < 0.01;

                        const expected = arcadeResult.expectedTotals?.[company];
                        const matchesEntered = expected == null || Math.abs(totalDebit - expected) < 0.01;

                        return (
                          <div key={company} style={styles.previewGroup}>
                            <div style={styles.previewGroupHeader}>
                              <span style={styles.companyName}>{company}</span>
                              <span style={balanced && matchesEntered ? styles.balanceOk : styles.balanceBad}>
                                {expected != null && <>Entered {expected.toFixed(2)} · </>}
                                Dr {totalDebit.toFixed(2)} · Cr {totalCredit.toFixed(2)}
                                {!balanced && ` ⚠ Dr/Cr out of balance by ${(totalDebit - totalCredit).toFixed(2)}`}
                                {balanced && !matchesEntered && ` ⚠ Doesn't match entered amount`}
                                {balanced && matchesEntered && " ✓ Balanced"}
                              </span>
                            </div>
                            <div style={styles.info}>
                              Totals above are for on-screen verification only — not included in the XLSX/CSV download.
                              "Arcade Payable"/"Subcontractor Payable" credit lines are one per company (no Class), not
                              per store.
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

  reportUploadBlock: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 },
  reportResultsList: { display: "flex", flexDirection: "column", gap: 6, marginTop: 4 },
  reportResultsHeader: { display: "flex", justifyContent: "flex-end" },
  clearAllBtn: {
    background: "transparent",
    color: "var(--danger)",
    border: "1px solid var(--danger)",
    borderRadius: 6,
    padding: "5px 12px",
    fontSize: 11.5,
    fontWeight: 600,
  },
  reportResultRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    padding: "6px 10px",
    borderRadius: 6,
    background: "var(--field)",
    border: "1px solid var(--line)",
  },
  reportFileName: { fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-soft)" },
  reportOk: { color: "var(--ledger)" },
  reportError: { color: "var(--danger)" },
  reportAssign: { display: "flex", alignItems: "center", gap: 8, color: "var(--warn-text)" },
  reportAssignSelect: {
    padding: "5px 8px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    fontSize: 12,
    background: "var(--field)",
    color: "var(--ink)",
  },
  trMismatch: { background: "var(--danger-bg)" },
  mismatchBadge: { color: "var(--danger)", fontSize: 10.5, fontWeight: 700, whiteSpace: "nowrap" },

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
  numInput: {
    width: 88,
    padding: "5px 6px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    background: "var(--field)",
    color: "var(--ink)",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
  },
  numInputError: { borderColor: "var(--danger)", boxShadow: "0 0 0 1px var(--danger)" },
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, alignItems: "center" },
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
  previewSectionTitle: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 12,
    color: "var(--ink-soft)",
    margin: "10px 0 6px",
  },
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
