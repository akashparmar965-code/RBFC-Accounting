import * as XLSX from "xlsx";

const AP_ACCOUNT = "Accounts Payable";
const EXPENSE_ACCOUNT = "Bill Payment-Epay";
const VENDOR = "PAYSPOT INC";
const CUSTOMER = "PAYSPOT INC SALES";
const PRODUCT_SERVICE = "Rebate";

/**
 * Parse the uploaded Epay invoices export (csv or xlsx) — same generic
 * reader as the other processors, format-agnostic.
 * @param {ArrayBuffer} arrayBuffer
 */
export function parseEpayWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

function toNumber(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  // strip a leading "Weekday, " prefix, e.g. "Monday, June 29, 2026"
  const cleaned = String(v).trim().replace(/^[A-Za-z]+,\s*/, "");
  const d = new Date(cleaned);
  return isNaN(d) ? null : d;
}

function formatMMDDYYYY(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getFullYear()}`;
}

function formatAmount(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Split raw Epay invoice rows into Income (Credit Amount > 0) and Purchase
 * (Debit Amount > 0) rows, grouped by Company — matched via Store Master's
 * `epay` field (falling back to epay_account_mappings) to the same
 * elevate_name_new_qbo_class used by VIP.
 *
 * @param {Array} rawRows
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {Array} accountMappings - rows from the `epay_account_mappings` table
 * @returns {{ incomeByCompany: Object, purchaseByCompany: Object, unmatchedAccounts: string[] }}
 */
export function buildEpayRows(rawRows, storeMaster, accountMappings = []) {
  const storeByAccount = {};
  for (const s of storeMaster) {
    if (s.epay) storeByAccount[String(s.epay).trim()] = s;
  }
  const mappingByAccount = {};
  for (const m of accountMappings) {
    if (m.account_number) mappingByAccount[String(m.account_number).trim()] = m;
  }

  const incomeByCompany = {};
  const purchaseByCompany = {};
  const unmatchedAccountsSet = new Set();

  for (const row of rawRows) {
    const accountNumber = row["Account Number"] != null ? String(row["Account Number"]).trim() : "";
    const invoiceNo = row["Invoice Number"] != null ? String(row["Invoice Number"]).trim() : "";
    if (!accountNumber || !invoiceNo) continue;

    const credit = toNumber(row["Credit Amount"]);
    const debit = toNumber(row["Debit Amount"]);
    if (credit === 0 && debit === 0) continue;

    const date = toDate(row["Invoice Date"]);
    const dateStr = date ? formatMMDDYYYY(date) : "";

    const master = storeByAccount[accountNumber];
    let company;
    let qboClass;
    if (master) {
      company = master.company_name || "Unassigned";
      qboClass = master.elevate_name_new_qbo_class || "";
    } else {
      const mapped = mappingByAccount[accountNumber];
      if (mapped) {
        company = mapped.company_name;
        qboClass = mapped.qbo_class;
      } else {
        unmatchedAccountsSet.add(accountNumber);
        continue;
      }
    }

    if (credit > 0) {
      const incomeRow = {
        "Invoice Date": dateStr,
        "Invoice No": invoiceNo,
        "Product/Service Amount": formatAmount(credit),
        "Product/Service Class": qboClass,
        Customer: CUSTOMER,
        "Product/Service": PRODUCT_SERVICE,
        "Product/Service Sales Tax": "Non",
        "Sales Tax": "Non",
        "Customer Sales Tax Code": "Non",
      };
      if (!incomeByCompany[company]) incomeByCompany[company] = [];
      incomeByCompany[company].push(incomeRow);
    }
    if (debit > 0) {
      const purchaseRow = {
        Date: dateStr,
        "Bill No": invoiceNo,
        "Expense Amount": formatAmount(debit),
        "Expense Class": qboClass,
        "AP Account": AP_ACCOUNT,
        "Expense Account": EXPENSE_ACCOUNT,
        Vendor: VENDOR,
      };
      if (!purchaseByCompany[company]) purchaseByCompany[company] = [];
      purchaseByCompany[company].push(purchaseRow);
    }
  }

  return {
    incomeByCompany,
    purchaseByCompany,
    unmatchedAccounts: Array.from(unmatchedAccountsSet),
  };
}

/** Flatten a byCompany map into one combined array (all companies together). */
export function buildAllInOneRows(byCompany) {
  return Object.values(byCompany).flat();
}

export const INCOME_COLUMNS = [
  "Invoice Date",
  "Invoice No",
  "Product/Service Amount",
  "Product/Service Class",
  "Customer",
  "Product/Service",
  "Product/Service Sales Tax",
  "Sales Tax",
  "Customer Sales Tax Code",
];

export const PURCHASE_COLUMNS = [
  "Date",
  "Bill No",
  "Expense Amount",
  "Expense Class",
  "AP Account",
  "Expense Account",
  "Vendor",
];

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows, columns) {
  const header = columns.join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(","));
  return [header, ...lines].join("\n");
}

/** Build an .xlsx file (as a Uint8Array) from rows, ready to hand to a Blob. */
export function rowsToXlsxBuffer(rows, columns, sheetName = "Epay") {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
