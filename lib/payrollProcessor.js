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
 */
export function allocatePayrollByHours(companyPayrollRows, storeMaster, storeHours) {
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

    for (const store of stores) {
      const hours = Number(storeHours[store] || 0);
      const weight = hours / totalCompanyHours;

      const allocated = { company, store, storeLabel: storeOutputName[store] || store };
      for (const { key } of PAYROLL_FIELDS) {
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
 * Store Payroll Allocation -> Final Data, verified formula-for-formula
 * against the source workbook's sample rows:
 *   Regular Pay = Regular earnings - Total employee deductions - Garnishments
 *   Payroll Tax Liabilities = Total employee taxes + Total employer taxes
 *   Payroll Liabilities = Check Amount = Check amount
 */
export function buildFinalDataRows(allocatedRows) {
  return allocatedRows.map((r) => ({
    storeName: r.storeLabel,
    companyName: r.company,
    regularPay: round2(r.regular_earnings - r.total_employee_deductions - r.garnishments),
    bonus: r.bonus,
    overtimePay: r.overtime_earnings,
    additionalEarnings: r.additional_earnings,
    payrollTaxesEmployer: r.total_employer_taxes,
    reimbursementToEmployees: r.total_reimbursements,
    payrollLiabilities: r.check_amount,
    payrollTaxLiabilities: round2(r.total_employee_taxes + r.total_employer_taxes),
    checkAmount: r.check_amount,
  }));
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
