import * as XLSX from "xlsx";

/**
 * The 15 payroll columns typed in manually per company per pay period,
 * matching `payroll_company_data` columns (key) and the source workbook's
 * "Update Data" sheet headers (label).
 */
export const PAYROLL_FIELDS = [
  { key: "regular_earnings", label: "Regular earnings" },
  { key: "bonus", label: "Bonus" },
  { key: "overtime_earnings", label: "Overtime earnings" },
  { key: "additional_earnings", label: "Additional earnings" },
  { key: "total_commission", label: "Total commission" },
  { key: "gross_earnings", label: "Gross earnings" },
  { key: "total_employee_deductions", label: "Total employee deductions" },
  { key: "total_employer_contributions", label: "Total employer contributions" },
  { key: "total_employee_taxes", label: "Total employee taxes" },
  { key: "total_employer_taxes", label: "Total employer taxes" },
  { key: "net_pay", label: "Net pay" },
  { key: "total_employer_cost", label: "Total employer cost" },
  { key: "check_amount", label: "Check amount" },
  { key: "garnishments", label: "Garnishments" },
  { key: "total_reimbursements", label: "Total reimbursements" },
];

/** Arcade & Subcontractor sub-tab: just two company-wise amounts. */
export const ARCADE_SUBCONTRACTOR_FIELDS = [
  { key: "arcade", label: "Arcade" },
  { key: "subcontractor", label: "Subcontractor" },
];

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Parse an uploaded Employee Timesheet export (xlsx/csv). */
export function parseTimesheetWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheetName =
    wb.SheetNames.find((n) => n.trim().toLowerCase() === "employee time sheet") || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

/** "YYYY-MM-DD" (HTML date input value) -> "MM/DD/YYYY" (matches source workbook's Journal Date format). */
export function formatMMDDYYYYFromIso(isoDateStr) {
  if (!isoDateStr) return "";
  const [y, m, d] = isoDateStr.split("-");
  if (!y || !m || !d) return "";
  return `${m}/${d}/${y}`;
}

/**
 * Pivot: sum "Total Working Time Decimal" per Store from the uploaded
 * timesheet. Store names here are expected to match Store Master's
 * `elevate_name` exactly (e.g. "AK - Union").
 */
export function buildStoreHours(timesheetRows) {
  const storeHours = {};
  for (const row of timesheetRows) {
    const store = row["Store"] != null ? String(row["Store"]).trim() : "";
    if (!store) continue;
    storeHours[store] = (storeHours[store] || 0) + toNumber(row["Total Working Time Decimal"]);
  }
  return storeHours;
}

/**
 * Allocate company-wise payroll to stores, weighted by each store's share
 * of its company's total timesheet hours. Direct port of the
 * "allocatePayrollByStoreHours" Apps Script: every store belonging to a
 * company gets a row (even at 0 hours -> 0 allocation), companies with no
 * hours at all are skipped and flagged rather than divided by zero.
 *
 * @param {Array} companyPayrollRows - payroll_company_data rows (snake_case keys)
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {Object} storeHours - output of buildStoreHours()
 * @param {Array} fields - which columns to allocate; defaults to PAYROLL_FIELDS
 */
export function allocatePayrollByHours(companyPayrollRows, storeMaster, storeHours, fields = PAYROLL_FIELDS) {
  const companyStores = {};
  const storeOutputName = {};
  const knownStores = new Set();

  for (const s of storeMaster) {
    const company = s.company_name ? String(s.company_name).trim() : "";
    const store = s.elevate_name ? String(s.elevate_name).trim() : "";
    if (!company || !store) continue;
    if (!companyStores[company]) companyStores[company] = [];
    companyStores[company].push(store);
    storeOutputName[store] = s.elevate_name_new_qbo_class || store;
    knownStores.add(store);
  }

  const zeroHourCompanies = [];
  const allocatedRows = [];

  for (const payrollRow of companyPayrollRows) {
    const company = payrollRow.company_name ? String(payrollRow.company_name).trim() : "";
    if (!company) continue;
    const stores = companyStores[company] || [];
    if (stores.length === 0) continue;

    let totalCompanyHours = 0;
    for (const store of stores) totalCompanyHours += Number(storeHours[store] || 0);

    if (totalCompanyHours === 0) {
      zeroHourCompanies.push(company);
      continue;
    }

    // Each store's share is its own weight * company amount, rounded
    // independently — a pure hours-weighted split. Summed across a
    // company's stores this can land a cent or two off the typed-in
    // total (normal rounding), which is expected and left as-is rather
    // than forced to reconcile onto one store.
    for (const store of stores) {
      const hours = Number(storeHours[store] || 0);
      const weight = hours / totalCompanyHours;

      const allocated = { company, store, storeLabel: storeOutputName[store] || store };
      for (const { key } of fields) {
        allocated[key] = round2(toNumber(payrollRow[key]) * weight);
      }
      allocatedRows.push(allocated);
    }
  }

  const unmatchedTimesheetStores = Object.keys(storeHours).filter((s) => !knownStores.has(s));
  const zeroHourStores = Array.from(knownStores).filter((s) => !(Number(storeHours[s]) > 0));

  return { allocatedRows, zeroHourCompanies, unmatchedTimesheetStores, zeroHourStores };
}

/**
 * Expected total Dr (= Cr) for a company's typed-in payroll, computed
 * straight from the entered numbers without going through store
 * allocation — same formula as buildFinalDataRows, just at the company
 * level. Used only for on-screen verification that the allocated,
 * per-store JV reconciles back to what was typed in; never part of the
 * export.
 */
export function expectedCompanyTotal(payrollRow) {
  const regularPay = round2(toNumber(payrollRow.regular_earnings) - toNumber(payrollRow.total_employee_deductions));
  const additionalEarnings = round2(toNumber(payrollRow.additional_earnings) + toNumber(payrollRow.total_commission));
  return round2(
    regularPay +
      toNumber(payrollRow.bonus) +
      toNumber(payrollRow.overtime_earnings) +
      additionalEarnings +
      toNumber(payrollRow.total_employer_taxes) +
      toNumber(payrollRow.total_reimbursements)
  );
}

/**
 * Store Payroll Allocation -> Final Data, per the user's formulas:
 *   Regular Pay = Regular earnings - Total employee deductions
 *   Additional Earnings = Additional earnings + Total commission
 *   Payroll Tax Liabilities = Total employee taxes + Total employer taxes
 *   Payroll Liabilities = Regular Pay + Bonus + Overtime Pay + Additional Earnings
 *                          + Reimbursement to Employees + Payroll Taxes-Employer
 *                          - Payroll Tax Liabilities
 * (Payroll Liabilities is the balancing figure: total debits minus the tax
 * liability credit, so the JV's total debits always equal its total credits.)
 */
export function buildFinalDataRows(allocatedRows) {
  return allocatedRows.map((r) => {
    const regularPay = round2(r.regular_earnings - r.total_employee_deductions);
    const bonus = r.bonus;
    const overtimePay = r.overtime_earnings;
    const additionalEarnings = round2(r.additional_earnings + r.total_commission);
    const payrollTaxesEmployer = r.total_employer_taxes;
    const reimbursementToEmployees = r.total_reimbursements;
    const payrollTaxLiabilities = round2(r.total_employee_taxes + r.total_employer_taxes);
    const payrollLiabilities = round2(
      regularPay + bonus + overtimePay + additionalEarnings + reimbursementToEmployees + payrollTaxesEmployer - payrollTaxLiabilities
    );

    return {
      storeName: r.storeLabel,
      companyName: r.company,
      regularPay,
      bonus,
      overtimePay,
      additionalEarnings,
      payrollTaxesEmployer,
      reimbursementToEmployees,
      payrollLiabilities,
      payrollTaxLiabilities,
    };
  });
}

export const JE_COLUMNS = ["Journal Date", "Account", "Debit", "Credit", "Class", "Memo"];

/**
 * Final Data -> QB Payroll JE lines, grouped by company. One debit line per
 * nonzero earning/employer-tax/reimbursement component, one credit line per
 * nonzero liability component. Direct port of "generatePayrollJEFile".
 *
 * @param {Array} finalDataRows - output of buildFinalDataRows()
 * @param {string} journalDate - "MM/DD/YYYY", the selected pay period date
 * @returns {Object<string, Array>} byCompany
 */
export function buildJournalEntryRows(finalDataRows, journalDate) {
  const byCompany = {};

  for (const r of finalDataRows) {
    if (!r.storeName || !r.companyName) continue;

    const lines = [];
    const debits = [
      ["Regular Pay", r.regularPay],
      ["Overtime Pay", r.overtimePay],
      ["Bonus", r.bonus],
      ["Additional Earnings", r.additionalEarnings],
      ["Payroll Taxes-Employer", r.payrollTaxesEmployer],
      ["Reimbursement to Employees", r.reimbursementToEmployees],
    ];
    const credits = [
      ["Payroll Liabilities", r.payrollLiabilities],
      ["Payroll Tax Liabilities", r.payrollTaxLiabilities],
    ];

    for (const [account, amount] of debits) {
      if (amount) lines.push({ "Journal Date": journalDate, Account: account, Debit: amount, Credit: "", Class: r.storeName, Memo: "" });
    }
    for (const [account, amount] of credits) {
      if (amount) lines.push({ "Journal Date": journalDate, Account: account, Debit: "", Credit: amount, Class: r.storeName, Memo: "" });
    }

    if (lines.length === 0) continue;
    if (!byCompany[r.companyName]) byCompany[r.companyName] = [];
    byCompany[r.companyName].push(...lines);
  }

  return byCompany;
}

/**
 * Store Payroll Allocation -> QB JE lines for Arcade & Subcontractor:
 * per store, one debit line per nonzero field (Class = store); per
 * company, one credit line per field that had any nonzero store amount
 * ("<Field> Payable", Class blank), whose amount is the sum of that
 * field's own debit lines — so Dr always equals Cr for that field even
 * if rounding drift moved it a cent or two from the typed-in total.
 * Direct port of the source workbook's PA/Youngstown/... company sheets.
 *
 * @param {Array} allocatedRows - output of allocatePayrollByHours(..., ARCADE_SUBCONTRACTOR_FIELDS)
 * @param {string} journalDate - "MM/DD/YYYY", the selected pay period date
 * @param {Array} fields - defaults to ARCADE_SUBCONTRACTOR_FIELDS
 * @returns {Object<string, Array>} byCompany
 */
export function buildArcadeSubcontractorJournalEntryRows(allocatedRows, journalDate, fields = ARCADE_SUBCONTRACTOR_FIELDS) {
  const grouped = {};
  for (const r of allocatedRows) {
    if (!r.company) continue;
    if (!grouped[r.company]) grouped[r.company] = [];
    grouped[r.company].push(r);
  }

  const byCompany = {};
  for (const [company, rows] of Object.entries(grouped)) {
    const lines = [];
    for (const { key, label } of fields) {
      let companyTotal = 0;
      for (const r of rows) {
        const amount = toNumber(r[key]);
        if (amount) {
          lines.push({ "Journal Date": journalDate, Account: label, Debit: amount, Credit: "", Class: r.storeLabel, Memo: "" });
        }
        companyTotal += amount;
      }
      companyTotal = round2(companyTotal);
      if (companyTotal) {
        lines.push({ "Journal Date": journalDate, Account: `${label} Payable`, Debit: "", Credit: companyTotal, Class: "", Memo: "" });
      }
    }
    if (lines.length > 0) byCompany[company] = lines;
  }

  return byCompany;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows) {
  const header = JE_COLUMNS.join(",");
  const lines = rows.map((r) => JE_COLUMNS.map((c) => csvEscape(r[c])).join(","));
  return [header, ...lines].join("\n");
}

/** Build an .xlsx file (as a Uint8Array) from JE rows, ready to hand to a Blob. */
export function rowsToXlsxBuffer(rows, sheetName = "Payroll JE") {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: JE_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
