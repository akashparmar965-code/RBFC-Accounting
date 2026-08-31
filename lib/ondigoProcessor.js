import * as XLSX from "xlsx";

// Fallbacks only — the real values come from the `ondigo_defaults` table
// (Mapping Master's Ondigo tab), same pattern as AR Deposits' Defaults.
const DEFAULT_VENDOR = "Ondigo";
const DEFAULT_EXPENSE_ACCOUNT = "Ondigo";
const AP_ACCOUNT = "Accounts Payable";

/**
 * Parse the uploaded Ondigo statement export (xlsx) and return rows from its
 * "Data" sheet — the export also carries TranslationData/CaptionData/
 * "Aggregated Metadata" sheets that aren't real transaction rows.
 */
export function parseOndigoWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === "data") || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
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

/**
 * Build Bill-import rows from an Ondigo statement export, same output shape
 * as VIP (`lib/billsProcessor.js`'s CSV_COLUMNS) so both tabs' downloads
 * are interchangeable in QuickBooks.
 *
 * Rules (confirmed with the user before building):
 *   - One row per ledger entry — each real invoice appears twice in the raw
 *     export (an "Invoice" entry and its matching "Payment" entry, same
 *     DocumentNo-adjacent pair). Only DocumentType === "Invoice" rows are
 *     posted; "Payment" rows are ignored entirely.
 *   - DocumentNo ("PSI1041979"-style, unique per invoice) → Bill No.
 *     PostingDate → Date. AmountLCY → Expense Amount. EntryDescription
 *     ("Order SO1125873"-style) → Expense Memo.
 *   - Store match is by **ChildCustNo against Store Master's new
 *     `ondigo_number` field** — no address-based fallback (explicitly
 *     dropped in favor of this exact code match). ParentCustName/
 *     ChildCustName are NOT used for Company — confirmed inconsistently
 *     spelled per row in the real export ("RB Firstconnect" vs "RB
 *     FIRSTCONNECT TN LLC" vs a typo "RB FirstConect OH LLC"), same
 *     unreliability the old format's "Company" column had; Store Master
 *     stays the source of truth for which company/QBO class a store
 *     belongs to.
 *   - A ChildCustNo with no matching `ondigo_number` in Store Master is
 *     skipped and flagged — no fallback mapping table, unlike VIP's Door
 *     Mapping; resolve by adding the Ondigo Number to that store directly.
 *
 * @param {Array} rawRows
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {{vendor?: string, expenseAccount?: string}} defaults - from `ondigo_defaults`
 * @returns {{ byCompany: Object<string, Array>, unmatchedOndigoNumbers: string[] }}
 */
export function buildOndigoBillRows(rawRows, storeMaster, defaults = {}) {
  const vendor = defaults.vendor || DEFAULT_VENDOR;
  const expenseAccount = defaults.expenseAccount || DEFAULT_EXPENSE_ACCOUNT;

  const storeByOndigoNumber = {};
  for (const s of storeMaster) {
    const num = s.ondigo_number != null ? String(s.ondigo_number).trim() : "";
    if (num) storeByOndigoNumber[num] = s;
  }

  const byCompany = {};
  const unmatchedOndigoNumbersSet = new Set();

  for (const row of rawRows) {
    if (row["DocumentType"] !== "Invoice") continue;

    const invoiceNo = row["DocumentNo"] != null ? String(row["DocumentNo"]).trim() : "";
    const ondigoNumber = row["ChildCustNo"] != null ? String(row["ChildCustNo"]).trim() : "";
    const amount = toNumber(row["AmountLCY"]);
    if (!invoiceNo || !ondigoNumber || !amount) continue;

    const master = storeByOndigoNumber[ondigoNumber];
    if (!master) {
      unmatchedOndigoNumbersSet.add(ondigoNumber);
      continue;
    }
    const company = master.company_name || "Unassigned";
    const qboClass = master.elevate_name_new_qbo_class || "";

    const date = toDate(row["PostingDate"]);
    const memo = row["EntryDescription"] != null ? String(row["EntryDescription"]).trim() : "";

    const outRow = {
      "Bill No": invoiceNo,
      Date: date ? formatMMDDYYYY(date) : "",
      "Expense Amount": Math.round(amount * 100) / 100,
      Vendor: vendor,
      "AP Account": AP_ACCOUNT,
      "Expense Account": expenseAccount,
      "Expense  Memo": memo,
      "Expense Class": qboClass,
    };

    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push(outRow);
  }

  return { byCompany, unmatchedOndigoNumbers: Array.from(unmatchedOndigoNumbersSet) };
}
