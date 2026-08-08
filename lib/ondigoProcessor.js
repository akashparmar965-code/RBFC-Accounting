import * as XLSX from "xlsx";

const VENDOR = "Ondigo";
const AP_ACCOUNT = "Accounts Payable";
const EXPENSE_ACCOUNT = "Ondigo";

/** Parse the uploaded Ondigo invoices export (xlsx) — one row per invoice, no line-item breakdown. */
export function parseOndigoWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

function toNumber(v) {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : d;
}

function formatMMDDYYYY(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getFullYear()}`;
}

/** Everything before the first comma, trimmed + lowercased — the street-address portion of a full mailing address. */
function streetPrefix(address) {
  if (!address) return "";
  const s = String(address);
  const idx = s.indexOf(",");
  const street = idx === -1 ? s : s.slice(0, idx);
  return street.trim().toLowerCase();
}

/**
 * Build Bill-import rows from an Ondigo invoices export, same output shape
 * as VIP (`lib/billsProcessor.js`'s CSV_COLUMNS) so both tabs' downloads
 * are interchangeable in QuickBooks.
 *
 * Rules (confirmed with the user before building):
 *   - Store match is by street address, NOT Door Number — the export's
 *     "Store/Location" column is a full mailing address (street, city,
 *     state, zip, country); Store Master's "VIP Address" field is just the
 *     street portion, so only the text before the first comma is compared.
 *   - The file's own "Company"/"PO #"/"Due Date"/"Status" columns are
 *     ignored entirely — Company especially, since it's inconsistently
 *     spelled per row in the real export ("RB Firstconnect" vs "RB
 *     FIRSTCONNECT LLC DBA RBFC" vs ...) and Store Master is the real
 *     source of truth for which company a store belongs to.
 *   - One row per invoice — unlike VIP, Ondigo's export has no per-line
 *     product breakdown to classify, so every invoice posts as a single
 *     line to a fixed Vendor/Expense Account ("Ondigo" for both).
 *
 * @param {Array} rawRows
 * @param {Array} storeMaster - rows from the `stores` table
 * @returns {{ byCompany: Object<string, Array>, unmatchedAddresses: string[] }}
 */
export function buildOndigoBillRows(rawRows, storeMaster) {
  const storeByStreet = {};
  for (const s of storeMaster) {
    const prefix = streetPrefix(s.vip_address);
    if (prefix) storeByStreet[prefix] = s;
  }

  const byCompany = {};
  const unmatchedAddressesSet = new Set();

  for (const row of rawRows) {
    const invoiceNo = row["Invoice #"] != null ? String(row["Invoice #"]).trim() : "";
    const location = row["Store/Location"] != null ? String(row["Store/Location"]).trim() : "";
    const amount = toNumber(row["Amount"]);
    if (!invoiceNo || !location || !amount) continue;

    const master = storeByStreet[streetPrefix(location)];
    if (!master) {
      unmatchedAddressesSet.add(location);
      continue;
    }

    const date = toDate(row["Invoice Date"]);
    const company = master.company_name || "Unassigned";
    const qboClass = master.elevate_name_new_qbo_class || "";

    const outRow = {
      "Bill No": invoiceNo,
      Date: date ? formatMMDDYYYY(date) : "",
      "Expense Amount": Math.round(amount * 100) / 100,
      Vendor: VENDOR,
      "AP Account": AP_ACCOUNT,
      "Expense Account": EXPENSE_ACCOUNT,
      "Expense  Memo": "",
      "Expense Class": qboClass,
    };

    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push(outRow);
  }

  return { byCompany, unmatchedAddresses: Array.from(unmatchedAddressesSet) };
}
