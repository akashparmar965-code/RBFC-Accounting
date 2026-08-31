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
  isNewBillFormat,
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
import { parseVipCreditNoteWorkbook, aggregateCreditNoteLines, buildCreditNoteRows } from "@/lib/creditNoteProcessor";
import { buildExportFileName, dateRangeFromRows, isFileRangeWithinMonth, currentMonthIso } from "@/lib/fileNaming";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";
import { triggerDownload } from "@/lib/download";
import { checkRawRowsUsable } from "@/lib/validation";
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
  const [vipPeriodMonth, setVipPeriodMonth] = useState(saved?.vipPeriodMonth ?? currentMonthIso());
  const [vipPeriodMode, setVipPeriodMode] = useState(saved?.vipPeriodMode ?? "accounting"); // "accounting" | "reconciliation"
  const fileInputRef = useRef(null);
  const lastFileRef = useRef(null);

  // ---- Epay tab state ----
  const [epayFileName, setEpayFileName] = useState(saved?.epayFileName ?? null);
  const [epayDragOver, setEpayDragOver] = useState(false);
  const [epayProcessing, setEpayProcessing] = useState(false);
  const [epayError, setEpayError] = useState("");
  const [epayResult, setEpayResult] = useState(saved?.epayResult ?? null); // { incomeByCompany, purchaseByCompany, unmatchedAccounts }
  const [epayPreviewOpen, setEpayPreviewOpen] = useState(saved?.epayPreviewOpen ?? false);
  const [epaySelectedCompanies, setEpaySelectedCompanies] = useState(new Set(saved?.epaySelectedCompanies ?? []));
  const [epayPeriodMonth, setEpayPeriodMonth] = useState(saved?.epayPeriodMonth ?? currentMonthIso());
  const [epayPeriodMode, setEpayPeriodMode] = useState(saved?.epayPeriodMode ?? "accounting");
  const epayFileInputRef = useRef(null);
  const lastEpayFileRef = useRef(null);

  // ---- Ondigo tab state ----
  const [ondigoFileName, setOndigoFileName] = useState(saved?.ondigoFileName ?? null);
  const [ondigoDragOver, setOndigoDragOver] = useState(false);
  const [ondigoProcessing, setOndigoProcessing] = useState(false);
  const [ondigoError, setOndigoError] = useState("");
  const [ondigoResult, setOndigoResult] = useState(saved?.ondigoResult ?? null); // { byCompany, unmatchedAddresses }
  const [ondigoPreviewOpen, setOndigoPreviewOpen] = useState(saved?.ondigoPreviewOpen ?? false);
  const [ondigoSelectedCompanies, setOndigoSelectedCompanies] = useState(new Set(saved?.ondigoSelectedCompanies ?? []));
  const [ondigoPeriodMonth, setOndigoPeriodMonth] = useState(saved?.ondigoPeriodMonth ?? currentMonthIso());
  const [ondigoPeriodMode, setOndigoPeriodMode] = useState(saved?.ondigoPeriodMode ?? "accounting");
  const ondigoFileInputRef = useRef(null);
  const lastOndigoFileRef = useRef(null);

  // ---- Credit Note tab state ----
  const [creditNoteFileName, setCreditNoteFileName] = useState(saved?.creditNoteFileName ?? null);
  const [creditNoteDragOver, setCreditNoteDragOver] = useState(false);
  const [creditNoteProcessing, setCreditNoteProcessing] = useState(false);
  const [creditNoteError, setCreditNoteError] = useState("");
  const [creditNoteResult, setCreditNoteResult] = useState(saved?.creditNoteResult ?? null); // { byCompany, unmatched, unmappedProducts }
  const [creditNotePreviewOpen, setCreditNotePreviewOpen] = useState(saved?.creditNotePreviewOpen ?? false);
  const [creditNoteSelectedCompanies, setCreditNoteSelectedCompanies] = useState(
    new Set(saved?.creditNoteSelectedCompanies ?? [])
  );
  const [creditNotePeriodMonth, setCreditNotePeriodMonth] = useState(saved?.creditNotePeriodMonth ?? currentMonthIso());
  const [creditNotePeriodMode, setCreditNotePeriodMode] = useState(saved?.creditNotePeriodMode ?? "accounting");
  const creditNoteFileInputRef = useRef(null);
  const lastCreditNoteFileRef = useRef(null);

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
      vipPeriodMonth,
      vipPeriodMode,
      epayFileName,
      epayResult,
      epayPreviewOpen,
      epaySelectedCompanies: Array.from(epaySelectedCompanies),
      epayPeriodMonth,
      epayPeriodMode,
      ondigoFileName,
      ondigoResult,
      ondigoPreviewOpen,
      ondigoSelectedCompanies: Array.from(ondigoSelectedCompanies),
      ondigoPeriodMonth,
      ondigoPeriodMode,
      creditNoteFileName,
      creditNoteResult,
      creditNotePreviewOpen,
      creditNoteSelectedCompanies: Array.from(creditNoteSelectedCompanies),
      creditNotePeriodMonth,
      creditNotePeriodMode,
    });
  }, [
    activeTab,
    fileName,
    result,
    previewOpen,
    selectedCompanies,
    vipPeriodMonth,
    vipPeriodMode,
    epayFileName,
    epayResult,
    epayPreviewOpen,
    epaySelectedCompanies,
    epayPeriodMonth,
    epayPeriodMode,
    ondigoFileName,
    ondigoResult,
    ondigoPreviewOpen,
    ondigoSelectedCompanies,
    ondigoPeriodMonth,
    ondigoPeriodMode,
    creditNoteFileName,
    creditNoteResult,
    creditNotePreviewOpen,
    creditNoteSelectedCompanies,
    creditNotePeriodMonth,
    creditNotePeriodMode,
  ]);

  // ===================== VIP =====================

  const processFile = useCallback(async (file, monthStr, mode) => {
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
      // VIP reshaped the Bill sheet's export around Aug 2026 (Invoice
      // Number -> Document, Tran Date -> Invoice Date); both shapes are
      // supported since older files may still come in.
      const isNewFormat = isNewBillFormat(rawRows);
      const usableIssue = checkRawRowsUsable(
        rawRows,
        ["Door Number", isNewFormat ? "Document" : "Invoice Number"],
        "VIP Bill sheet"
      );
      if (usableIssue) throw new Error(usableIssue);
      // Reconciliation mode skips the Month-range gate so a year-to-date
      // or any-date-range file can load for cross-checking — Accounting
      // mode keeps the normal single-month guard for actual JE booking.
      if (mode !== "reconciliation") {
        const { start, end } = dateRangeFromRows(rawRows, isNewFormat ? "Invoice Date" : "Tran Date");
        if (start && end && !isFileRangeWithinMonth(start, end, monthStr)) {
          throw new Error(
            `This file's dates (${start}–${end}) don't fall within the selected Month (${monthStr}) — not loaded. Pick the correct Month, upload the correct file, or switch to Reconciliation mode.`
          );
        }
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
    lastFileRef.current = file;
    processFile(file, vipPeriodMonth, vipPeriodMode);
  }

  function handleFileChange(e) {
    handleFile(e.target.files?.[0]);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  function handleVipMonthChange(e) {
    const next = e.target.value;
    setVipPeriodMonth(next);
    if (lastFileRef.current) processFile(lastFileRef.current, next, vipPeriodMode);
  }

  function handleVipModeChange(next) {
    setVipPeriodMode(next);
    if (lastFileRef.current) processFile(lastFileRef.current, vipPeriodMonth, next);
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

  const processEpayFile = useCallback(async (file, monthStr, mode) => {
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
      const usableIssue = checkRawRowsUsable(rawRows, ["Account Number", "Invoice Number"], "Epay export");
      if (usableIssue) throw new Error(usableIssue);
      if (mode !== "reconciliation") {
        const { start, end } = dateRangeFromRows(rawRows, "Invoice Date");
        if (start && end && !isFileRangeWithinMonth(start, end, monthStr)) {
          throw new Error(
            `This file's dates (${start}–${end}) don't fall within the selected Month (${monthStr}) — not loaded. Pick the correct Month, upload the correct file, or switch to Reconciliation mode.`
          );
        }
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
    lastEpayFileRef.current = file;
    processEpayFile(file, epayPeriodMonth, epayPeriodMode);
  }

  function handleEpayFileChange(e) {
    handleEpayFile(e.target.files?.[0]);
  }

  function handleEpayDrop(e) {
    e.preventDefault();
    setEpayDragOver(false);
    handleEpayFile(e.dataTransfer.files?.[0]);
  }

  function handleEpayMonthChange(e) {
    const next = e.target.value;
    setEpayPeriodMonth(next);
    if (lastEpayFileRef.current) processEpayFile(lastEpayFileRef.current, next, epayPeriodMode);
  }

  function handleEpayModeChange(next) {
    setEpayPeriodMode(next);
    if (lastEpayFileRef.current) processEpayFile(lastEpayFileRef.current, epayPeriodMonth, next);
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

  const processOndigoFile = useCallback(async (file, monthStr, mode) => {
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
      const usableIssue = checkRawRowsUsable(rawRows, ["Invoice #", "Store/Location"], "Ondigo export");
      if (usableIssue) throw new Error(usableIssue);
      if (mode !== "reconciliation") {
        const { start, end } = dateRangeFromRows(rawRows, "Invoice Date");
        if (start && end && !isFileRangeWithinMonth(start, end, monthStr)) {
          throw new Error(
            `This file's dates (${start}–${end}) don't fall within the selected Month (${monthStr}) — not loaded. Pick the correct Month, upload the correct file, or switch to Reconciliation mode.`
          );
        }
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
    lastOndigoFileRef.current = file;
    processOndigoFile(file, ondigoPeriodMonth, ondigoPeriodMode);
  }

  function handleOndigoFileChange(e) {
    handleOndigoFile(e.target.files?.[0]);
  }

  function handleOndigoDrop(e) {
    e.preventDefault();
    setOndigoDragOver(false);
    handleOndigoFile(e.dataTransfer.files?.[0]);
  }

  function handleOndigoMonthChange(e) {
    const next = e.target.value;
    setOndigoPeriodMonth(next);
    if (lastOndigoFileRef.current) processOndigoFile(lastOndigoFileRef.current, next, ondigoPeriodMode);
  }

  function handleOndigoModeChange(next) {
    setOndigoPeriodMode(next);
    if (lastOndigoFileRef.current) processOndigoFile(lastOndigoFileRef.current, ondigoPeriodMonth, next);
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

  // ===================== Credit Note =====================

  const processCreditNoteFile = useCallback(async (file, monthStr, mode) => {
    setCreditNoteProcessing(true);
    setCreditNoteError("");
    setCreditNoteResult(null);
    setCreditNotePreviewOpen(false);
    try {
      const supabase = createClient();
      const { data: storeMaster, error: smError } = await supabase.from("stores").select("*");
      if (smError) throw new Error("Could not load Store Master: " + smError.message);
      const { data: creditNoteMappings, error: cmError } = await supabase
        .from("credit_note_mappings")
        .select("*");
      if (cmError) throw new Error("Could not load Credit Note mappings: " + cmError.message);
      const { data: doorMappings, error: dmError } = await supabase.from("door_mappings").select("*");
      if (dmError) throw new Error("Could not load door mappings: " + dmError.message);

      const buffer = await file.arrayBuffer();
      const rawRows = parseVipCreditNoteWorkbook(buffer);
      if (!rawRows.length) throw new Error("No rows found in the Credit Note sheet of this file.");
      if (!("Door Number" in rawRows[0])) {
        throw new Error(
          "This file doesn't look like a VIP export — no 'Door Number' column found in the Credit Note sheet."
        );
      }
      const usableIssue = checkRawRowsUsable(rawRows, ["Door Number", "Invoice Number"], "VIP Credit Note sheet");
      if (usableIssue) throw new Error(usableIssue);
      // Reconciliation mode skips the Month-range gate so a year-to-date
      // or any-date-range file can load for cross-checking — Accounting
      // mode keeps the normal single-month guard for actual JE booking.
      if (mode !== "reconciliation") {
        const { start, end } = dateRangeFromRows(rawRows, "Tran Date");
        if (start && end && !isFileRangeWithinMonth(start, end, monthStr)) {
          throw new Error(
            `This file's dates (${start}–${end}) don't fall within the selected Month (${monthStr}) — not loaded. Pick the correct Month, upload the correct file, or switch to Reconciliation mode.`
          );
        }
      }

      const { groups: groupedLines, discountOrShippingFlags } = aggregateCreditNoteLines(
        rawRows,
        creditNoteMappings || []
      );
      const { byCompany, unmatchedDoors, unmappedProducts } = buildCreditNoteRows(
        groupedLines,
        storeMaster,
        doorMappings || []
      );
      setCreditNoteResult({ byCompany, unmatched: unmatchedDoors, unmappedProducts, discountOrShippingFlags });
      setCreditNoteSelectedCompanies(new Set(Object.keys(byCompany)));
      savePendingMappings({ unmatchedDoors, unmappedCreditNoteProducts: unmappedProducts });
    } catch (e) {
      setCreditNoteError(e.message || String(e));
    } finally {
      setCreditNoteProcessing(false);
    }
  }, []);

  function handleCreditNoteFile(file) {
    if (!file) return;
    setCreditNoteFileName(file.name);
    lastCreditNoteFileRef.current = file;
    processCreditNoteFile(file, creditNotePeriodMonth, creditNotePeriodMode);
  }

  function handleCreditNoteFileChange(e) {
    handleCreditNoteFile(e.target.files?.[0]);
  }

  function handleCreditNoteDrop(e) {
    e.preventDefault();
    setCreditNoteDragOver(false);
    handleCreditNoteFile(e.dataTransfer.files?.[0]);
  }

  function handleCreditNoteMonthChange(e) {
    const next = e.target.value;
    setCreditNotePeriodMonth(next);
    if (lastCreditNoteFileRef.current) processCreditNoteFile(lastCreditNoteFileRef.current, next, creditNotePeriodMode);
  }

  function handleCreditNoteModeChange(next) {
    setCreditNotePeriodMode(next);
    if (lastCreditNoteFileRef.current) processCreditNoteFile(lastCreditNoteFileRef.current, creditNotePeriodMonth, next);
  }

  async function downloadCreditNoteCompanyXlsx(company, rows) {
    const buf = rowsToXlsxBuffer(rows, company);
    triggerDownload(
      new Blob([buf], { type: XLSX_MIME }),
      buildExportFileName(company, "CreditNote", rows, "Date", "xlsx")
    );
  }

  function downloadCreditNoteCompanyCsv(company, rows) {
    triggerDownload(
      new Blob([rowsToCsv(rows)], { type: CSV_MIME }),
      buildExportFileName(company, "CreditNote", rows, "Date", "csv")
    );
  }

  async function downloadAllCreditNoteZip(format) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const [company, rows] of Object.entries(creditNoteResult.byCompany)) {
      if (format === "xlsx") {
        zip.file(buildExportFileName(company, "CreditNote", rows, "Date", "xlsx"), rowsToXlsxBuffer(rows, company));
      } else {
        zip.file(buildExportFileName(company, "CreditNote", rows, "Date", "csv"), rowsToCsv(rows));
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Bills-CreditNote-AllCompanies-${format}.zip`);
  }

  function toggleCreditNoteCompany(company) {
    setCreditNoteSelectedCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(company)) next.delete(company);
      else next.add(company);
      return next;
    });
  }

  function toggleCreditNoteSelectAll(allCompanyNames, checked) {
    setCreditNoteSelectedCompanies(checked ? new Set(allCompanyNames) : new Set());
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const companyEntries = result ? Object.entries(result.byCompany) : [];
  const totalRows = companyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const rowsTotal = (rows) => rows.reduce((sum, r) => sum + (Number(r["Expense Amount"]) || 0), 0);
  const grandTotal = companyEntries.reduce((sum, [, rows]) => sum + rowsTotal(rows), 0);

  const epayCompanyNames = epayResult
    ? Array.from(new Set([...Object.keys(epayResult.incomeByCompany), ...Object.keys(epayResult.purchaseByCompany)])).sort()
    : [];
  const epayTotalRows = epayCompanyNames.reduce(
    (sum, c) =>
      sum + (epayResult.incomeByCompany[c]?.length || 0) + (epayResult.purchaseByCompany[c]?.length || 0),
    0
  );
  // Epay amounts are formatted with thousands commas ("1,234.56"), and each
  // row only ever populates one of the two amount columns — strip commas
  // before parsing back to a number.
  const epayRowsTotal = (rows, field) =>
    rows.reduce((sum, r) => sum + (Number(String(r[field] || "0").replace(/,/g, "")) || 0), 0);
  const epayIncomeGrandTotal = epayCompanyNames.reduce(
    (sum, c) => sum + epayRowsTotal(epayResult.incomeByCompany[c] || [], "Product/Service Amount"),
    0
  );
  const epayPurchaseGrandTotal = epayCompanyNames.reduce(
    (sum, c) => sum + epayRowsTotal(epayResult.purchaseByCompany[c] || [], "Expense Amount"),
    0
  );

  const ondigoCompanyEntries = ondigoResult ? Object.entries(ondigoResult.byCompany) : [];
  const ondigoTotalRows = ondigoCompanyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const ondigoGrandTotal = ondigoCompanyEntries.reduce((sum, [, rows]) => sum + rowsTotal(rows), 0);

  const creditNoteCompanyEntries = creditNoteResult ? Object.entries(creditNoteResult.byCompany) : [];
  const creditNoteTotalRows = creditNoteCompanyEntries.reduce((sum, [, rows]) => sum + rows.length, 0);
  const creditNoteGrandTotal = creditNoteCompanyEntries.reduce((sum, [, rows]) => sum + rowsTotal(rows), 0);
  // Guards a stale cached creditNoteResult from sessionStorage (saved by an
  // older version of this page, before this field existed) from crashing
  // render — `?? []` only covers null/undefined, not "field never existed",
  // so this needs its own fallback rather than relying on optional chaining
  // at each call site.
  const creditNoteDiscountOrShippingFlags = creditNoteResult?.discountOrShippingFlags || [];

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
                : activeTab === "ondigo"
                ? "Upload the Ondigo invoices export — matched by store address, one file per company"
                : "Upload the VIP export's Credit Note sheet — classified by Credit Note Mapping, one file per company"}
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
          <button
            style={activeTab === "creditnote" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("creditnote")}
          >
            Credit Note
          </button>
        </div>

        {activeTab === "vip" && (
          <>
            <div style={styles.card}>
              <div style={styles.fieldRow}>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Month</span>
                  <input
                    type="month"
                    style={styles.dateInput}
                    value={vipPeriodMonth}
                    onChange={handleVipMonthChange}
                    disabled={vipPeriodMode === "reconciliation"}
                  />
                </label>
                <div style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Mode</span>
                  <div style={styles.modeToggleRow}>
                    <button
                      style={{ ...styles.modeBtn, ...(vipPeriodMode === "accounting" ? styles.modeBtnActive : {}) }}
                      onClick={() => handleVipModeChange("accounting")}
                    >
                      Accounting
                    </button>
                    <button
                      style={{ ...styles.modeBtn, ...(vipPeriodMode === "reconciliation" ? styles.modeBtnActive : {}) }}
                      onClick={() => handleVipModeChange("reconciliation")}
                    >
                      Reconciliation
                    </button>
                  </div>
                </div>
              </div>
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
              {vipPeriodMode === "reconciliation" && (
                <div style={styles.reconciliationNote}>
                  Reconciliation mode — the Month check is skipped, so a year-to-date or any-date-range file
                  will load.
                </div>
              )}
            </div>

            {processing && <div style={styles.info}>Processing…</div>}
            {error && <div style={styles.errorBanner}>{error}</div>}

            {result && result.unmatched.length > 0 && (
              <div style={styles.warnBanner}>
                {result.unmatched.length} door number(s) in the file don't match any store in your Store
                Master, so they were skipped: <strong>{result.unmatched.join(", ")}</strong>. Add them in{" "}
                <Link href="/mappings?tab=vip#door-mapping" style={styles.inlineLink}>
                  Door Mapping
                </Link>{" "}
                or add the store in Store Master, then re-upload.
              </div>
            )}

            {result && result.unmappedProducts.length > 0 && (
              <div style={styles.errorBanner}>
                {result.unmappedProducts.length} line(s) have a Product that doesn't match a known mapping,
                so they were skipped. Add the product text below to{" "}
                <Link href="/mappings?tab=vip" style={styles.inlineLink}>
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
                    bill line{totalRows === 1 ? "" : "s"} · Total ${grandTotal.toFixed(2)}
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
                          <span style={styles.companyMeta}>
                            {rows.length} bill line(s) · ${rowsTotal(rows).toFixed(2)}
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
                      .map(([company, rows]) => (
                        <div key={company} style={styles.previewGroup}>
                          <div style={styles.previewGroupHeader}>
                            <span style={styles.companyName}>{company}</span>
                            <span style={styles.previewMeta}>
                              {rows.length} bill line{rows.length === 1 ? "" : "s"} · ${rowsTotal(rows).toFixed(2)}
                            </span>
                          </div>
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
                                {rows.map((r, i) => (
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
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {activeTab === "epay" && (
          <>
            <div style={styles.card}>
              <div style={styles.fieldRow}>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Month</span>
                  <input
                    type="month"
                    style={styles.dateInput}
                    value={epayPeriodMonth}
                    onChange={handleEpayMonthChange}
                    disabled={epayPeriodMode === "reconciliation"}
                  />
                </label>
                <div style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Mode</span>
                  <div style={styles.modeToggleRow}>
                    <button
                      style={{ ...styles.modeBtn, ...(epayPeriodMode === "accounting" ? styles.modeBtnActive : {}) }}
                      onClick={() => handleEpayModeChange("accounting")}
                    >
                      Accounting
                    </button>
                    <button
                      style={{ ...styles.modeBtn, ...(epayPeriodMode === "reconciliation" ? styles.modeBtnActive : {}) }}
                      onClick={() => handleEpayModeChange("reconciliation")}
                    >
                      Reconciliation
                    </button>
                  </div>
                </div>
              </div>
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
              {epayPeriodMode === "reconciliation" && (
                <div style={styles.reconciliationNote}>
                  Reconciliation mode — the Month check is skipped, so a year-to-date or any-date-range file
                  will load.
                </div>
              )}
            </div>

            {epayProcessing && <div style={styles.info}>Processing…</div>}
            {epayError && <div style={styles.errorBanner}>{epayError}</div>}

            {epayResult && epayResult.unmatchedAccounts.length > 0 && (
              <div style={styles.warnBanner}>
                {epayResult.unmatchedAccounts.length} account number(s) in the file don't match any store's
                "Epay" field, so they were skipped: <strong>{epayResult.unmatchedAccounts.join(", ")}</strong>.
                Add them in{" "}
                <Link href="/mappings?tab=epay" style={styles.inlineLink}>
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
                    {epayTotalRows} line{epayTotalRows === 1 ? "" : "s"} · Income ${epayIncomeGrandTotal.toFixed(2)} ·
                    Purchase ${epayPurchaseGrandTotal.toFixed(2)}
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
                              {incomeRows.length} income (${epayRowsTotal(incomeRows, "Product/Service Amount").toFixed(2)}) ·{" "}
                              {purchaseRows.length} purchase (${epayRowsTotal(purchaseRows, "Expense Amount").toFixed(2)})
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
                  <div style={styles.previewGroups}>
                    {epayCompanyNames
                      .filter((c) => epaySelectedCompanies.has(c))
                      .map((company) => {
                        const incomeRows = epayResult.incomeByCompany[company] || [];
                        const purchaseRows = epayResult.purchaseByCompany[company] || [];
                        if (incomeRows.length === 0 && purchaseRows.length === 0) return null;
                        return (
                          <div key={company} style={styles.previewGroup}>
                            <div style={styles.previewGroupHeader}>
                              <span style={styles.companyName}>{company}</span>
                            </div>
                            {incomeRows.length > 0 && (
                              <>
                                <div style={styles.previewSectionTitle}>
                                  Income · {incomeRows.length} line{incomeRows.length === 1 ? "" : "s"} · $
                                  {epayRowsTotal(incomeRows, "Product/Service Amount").toFixed(2)}
                                </div>
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
                                      {incomeRows.map((r, i) => (
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
                              </>
                            )}
                            {purchaseRows.length > 0 && (
                              <>
                                <div style={styles.previewSectionTitle}>
                                  Purchase · {purchaseRows.length} line{purchaseRows.length === 1 ? "" : "s"} · $
                                  {epayRowsTotal(purchaseRows, "Expense Amount").toFixed(2)}
                                </div>
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
                                      {purchaseRows.map((r, i) => (
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
                          </div>
                        );
                      })}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {activeTab === "ondigo" && (
          <>
            <div style={styles.card}>
              <div style={styles.fieldRow}>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Month</span>
                  <input
                    type="month"
                    style={styles.dateInput}
                    value={ondigoPeriodMonth}
                    onChange={handleOndigoMonthChange}
                    disabled={ondigoPeriodMode === "reconciliation"}
                  />
                </label>
                <div style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Mode</span>
                  <div style={styles.modeToggleRow}>
                    <button
                      style={{ ...styles.modeBtn, ...(ondigoPeriodMode === "accounting" ? styles.modeBtnActive : {}) }}
                      onClick={() => handleOndigoModeChange("accounting")}
                    >
                      Accounting
                    </button>
                    <button
                      style={{ ...styles.modeBtn, ...(ondigoPeriodMode === "reconciliation" ? styles.modeBtnActive : {}) }}
                      onClick={() => handleOndigoModeChange("reconciliation")}
                    >
                      Reconciliation
                    </button>
                  </div>
                </div>
              </div>
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
              {ondigoPeriodMode === "reconciliation" && (
                <div style={styles.reconciliationNote}>
                  Reconciliation mode — the Month check is skipped, so a year-to-date or any-date-range file
                  will load.
                </div>
              )}
            </div>

            {ondigoProcessing && <div style={styles.info}>Processing…</div>}
            {ondigoError && <div style={styles.errorBanner}>{ondigoError}</div>}

            {ondigoResult && ondigoResult.unmatchedAddresses.length > 0 && (
              <div style={styles.warnBanner}>
                {ondigoResult.unmatchedAddresses.length} invoice(s) have a Store/Location address that doesn't
                match any store's VIP Address in Store Master (matched on the street portion only), so they were
                skipped: <strong>{ondigoResult.unmatchedAddresses.join(" · ")}</strong>. Add them in{" "}
                <Link href="/mappings?tab=ondigo" style={styles.inlineLink}>
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
                    {ondigoTotalRows} bill line{ondigoTotalRows === 1 ? "" : "s"} · Total ${ondigoGrandTotal.toFixed(2)}
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
                          <span style={styles.companyMeta}>
                            {rows.length} bill line(s) · ${rowsTotal(rows).toFixed(2)}
                          </span>
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
                  <div style={styles.previewGroups}>
                    {ondigoCompanyEntries
                      .filter(([company]) => ondigoSelectedCompanies.has(company))
                      .map(([company, rows]) => (
                        <div key={company} style={styles.previewGroup}>
                          <div style={styles.previewGroupHeader}>
                            <span style={styles.companyName}>{company}</span>
                            <span style={styles.previewMeta}>
                              {rows.length} bill line{rows.length === 1 ? "" : "s"} · ${rowsTotal(rows).toFixed(2)}
                            </span>
                          </div>
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
                                {rows.map((r, i) => (
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
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {activeTab === "creditnote" && (
          <>
            <div style={styles.card}>
              <div style={styles.fieldRow}>
                <label style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Month</span>
                  <input
                    type="month"
                    style={styles.dateInput}
                    value={creditNotePeriodMonth}
                    onChange={handleCreditNoteMonthChange}
                    disabled={creditNotePeriodMode === "reconciliation"}
                  />
                </label>
                <div style={styles.fieldBlock}>
                  <span style={styles.fieldLabel}>Mode</span>
                  <div style={styles.modeToggleRow}>
                    <button
                      style={{
                        ...styles.modeBtn,
                        ...(creditNotePeriodMode === "accounting" ? styles.modeBtnActive : {}),
                      }}
                      onClick={() => handleCreditNoteModeChange("accounting")}
                    >
                      Accounting
                    </button>
                    <button
                      style={{
                        ...styles.modeBtn,
                        ...(creditNotePeriodMode === "reconciliation" ? styles.modeBtnActive : {}),
                      }}
                      onClick={() => handleCreditNoteModeChange("reconciliation")}
                    >
                      Reconciliation
                    </button>
                  </div>
                </div>
              </div>
              <input
                ref={creditNoteFileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleCreditNoteFileChange}
                style={{ display: "none" }}
              />
              <div
                style={{ ...styles.dropzone, ...(creditNoteDragOver ? styles.dropzoneActive : {}) }}
                onClick={() => creditNoteFileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setCreditNoteDragOver(true);
                }}
                onDragLeave={() => setCreditNoteDragOver(false)}
                onDrop={handleCreditNoteDrop}
              >
                <div style={styles.dropzoneIcon}>📄</div>
                <div style={styles.dropzoneText}>
                  {creditNoteFileName || "Choose or drop VIP export (reads the Credit Note sheet)"}
                </div>
              </div>
              {creditNotePeriodMode === "reconciliation" && (
                <div style={styles.reconciliationNote}>
                  Reconciliation mode — the Month check is skipped, so a year-to-date or any-date-range file
                  will load.
                </div>
              )}
            </div>

            {creditNoteProcessing && <div style={styles.info}>Processing…</div>}
            {creditNoteError && <div style={styles.errorBanner}>{creditNoteError}</div>}

            {creditNoteResult && creditNoteResult.unmatched.length > 0 && (
              <div style={styles.warnBanner}>
                {creditNoteResult.unmatched.length} door number(s) in the file don't match any store in your
                Store Master, so they were skipped: <strong>{creditNoteResult.unmatched.join(", ")}</strong>.
                Add them in{" "}
                <Link href="/mappings?tab=vip#door-mapping" style={styles.inlineLink}>
                  Door Mapping
                </Link>{" "}
                or add the store in Store Master, then re-upload.
              </div>
            )}

            {creditNoteResult && creditNoteResult.unmappedProducts.length > 0 && (
              <div style={styles.errorBanner}>
                {creditNoteResult.unmappedProducts.length} credit memo(s) have a Memo that doesn't match a
                known mapping, so they were skipped. Add the memo text below to{" "}
                <Link href="/mappings?tab=creditnote" style={styles.inlineLink}>
                  Credit Note Mapping
                </Link>{" "}
                and re-upload:
                <ul style={styles.unmappedList}>
                  {creditNoteResult.unmappedProducts.map((m, i) => (
                    <li key={i}>
                      Door {m.doorNumber} · {m.invoiceNo} · "{m.product}"
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {creditNoteDiscountOrShippingFlags.length > 0 && (
              <div style={styles.warnBanner}>
                {creditNoteDiscountOrShippingFlags.length} credit memo(s) have a nonzero{" "}
                <strong>Discount</strong> or <strong>Shipping Cost</strong> — every real file this formula was
                verified against had both at $0, so this hasn't been confirmed on a real example yet. They
                still posted using the same +Shipping Cost/−Discount formula as Other Cost/Other Deductions,
                but review these manually:
                <ul style={styles.unmappedList}>
                  {creditNoteDiscountOrShippingFlags.map((f, i) => (
                    <li key={i}>
                      Door {f.doorNumber} · {f.invoiceNo} · Discount ${f.discount.toFixed(2)} · Shipping Cost $
                      {f.shippingCost.toFixed(2)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {creditNoteResult && creditNoteTotalRows > 0 && (
              <>
                <div style={styles.actionsRow}>
                  <button style={styles.previewBtn} onClick={() => setCreditNotePreviewOpen((v) => !v)}>
                    👁 {creditNotePreviewOpen ? "Hide preview" : "Preview selected"}
                  </button>
                  <button style={styles.xlsxBtn} onClick={() => downloadAllCreditNoteZip("xlsx")}>
                    📘 Download all (XLSX)
                  </button>
                  <button style={styles.csvBtnMuted} onClick={() => downloadAllCreditNoteZip("csv")}>
                    Download all (CSV)
                  </button>
                </div>

                <div style={styles.resultsHeader}>
                  <h2 style={styles.h2}>
                    {creditNoteCompanyEntries.length} compan{creditNoteCompanyEntries.length === 1 ? "y" : "ies"}{" "}
                    · {creditNoteTotalRows} line{creditNoteTotalRows === 1 ? "" : "s"} · Total $
                    {creditNoteGrandTotal.toFixed(2)}
                  </h2>
                  <label style={styles.selectAllLabel}>
                    <input
                      type="checkbox"
                      checked={
                        creditNoteSelectedCompanies.size === creditNoteCompanyEntries.length &&
                        creditNoteCompanyEntries.length > 0
                      }
                      onChange={(e) =>
                        toggleCreditNoteSelectAll(
                          creditNoteCompanyEntries.map(([company]) => company),
                          e.target.checked
                        )
                      }
                    />
                    Select all
                  </label>
                </div>

                <div style={styles.companyGrid}>
                  {creditNoteCompanyEntries.map(([company, rows]) => (
                    <div key={company} style={styles.companyCard}>
                      <label style={styles.companyCheckLabel}>
                        <input
                          type="checkbox"
                          checked={creditNoteSelectedCompanies.has(company)}
                          onChange={() => toggleCreditNoteCompany(company)}
                        />
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={styles.companyName}>{company}</span>
                          <span style={styles.companyMeta}>
                            {rows.length} line(s) · ${rowsTotal(rows).toFixed(2)}
                          </span>
                        </div>
                      </label>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          style={styles.secondaryBtn}
                          onClick={() => downloadCreditNoteCompanyXlsx(company, rows)}
                        >
                          XLSX
                        </button>
                        <button
                          style={styles.secondaryBtn}
                          onClick={() => downloadCreditNoteCompanyCsv(company, rows)}
                        >
                          CSV
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {creditNotePreviewOpen && (
                  <div style={styles.previewGroups}>
                    {creditNoteCompanyEntries
                      .filter(([company]) => creditNoteSelectedCompanies.has(company))
                      .map(([company, rows]) => (
                        <div key={company} style={styles.previewGroup}>
                          <div style={styles.previewGroupHeader}>
                            <span style={styles.companyName}>{company}</span>
                            <span style={styles.previewMeta}>
                              {rows.length} line{rows.length === 1 ? "" : "s"} · ${rowsTotal(rows).toFixed(2)}
                            </span>
                          </div>
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
                                {rows.map((r, i) => (
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
                        </div>
                      ))}
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
  previewMeta: { fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-soft)" },
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
