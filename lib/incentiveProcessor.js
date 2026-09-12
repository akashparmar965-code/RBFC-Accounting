import * as XLSX from "xlsx";

const VENDOR = "VIP Wireless";
const AP_ACCOUNT = "Accounts Payable";
// Every Incentive credit memo posts to this one fixed company, regardless of
// which store it came from -- confirmed explicitly ("There is one company
// for incentive tab only so no need to devide it just do it in PA"). Not
// derived from Store Master/door matching at all, unlike every other Bills
// tab. No single QBO Class applies across all of RBFC PA LLC's stores, so
// "Expense Class" is left blank on every Incentive row.
const COMPANY_NAME = "RBFC PA LLC";

/**
 * Real source file: a "Credit Memo" export from VIP's own Credit Memo
 * module (e.g. "Credit Memo (5).xlsx") -- genuinely different from the main
 * VIP Bill/Credit Note export workbook, not a sheet within it. One row per
 * credit memo already (no per-line Products breakdown, no Door Number, no
 * Other Cost/Shipping Cost/Discount/Other Deductions columns), single sheet
 * named "DataSheet" with columns: CompanyName (a multi-line dealer
 * name+address, not the real posting company -- see COMPANY_NAME above),
 * CreditMemoNumber, Memo, Status ("Fully Applied"/"Voided"), GrandTotal,
 * AmountLinked, Balance, CreatedOn.
 */
function textMatchesRule(textLower, m) {
  const prefixLower = String(m.product_prefix).toLowerCase();
  switch (m.match_type) {
    case "exact":
      return textLower === prefixLower;
    case "contains":
      return textLower.includes(prefixLower);
    case "starts_with":
    default:
      return textLower.startsWith(prefixLower);
  }
}

/**
 * Classify a credit memo's Memo text against incentive_mappings -- same
 * shape as creditNoteProcessor.js's classifyCreditNoteRule (starts_with/
 * contains/exact, `ignore` drops it silently, no match is "unmapped").
 */
function classifyIncentiveRule(textRaw, incentiveMappings) {
  const textLower = textRaw.toLowerCase();
  const rule = incentiveMappings.find((m) => textMatchesRule(textLower, m));
  if (!rule) return { category: "unmapped" };
  if (rule.ignore) return { category: "ignored" };
  return {
    category: "mapped",
    expenseAccount: rule.expense_account,
    expenseMemo: rule.expense_memo || textRaw || rule.expense_account,
  };
}

function trimRowKeys(rows) {
  return rows.map((row) => {
    const trimmed = {};
    for (const key of Object.keys(row)) {
      trimmed[typeof key === "string" ? key.trim() : key] = row[key];
    }
    return trimmed;
  });
}

/**
 * Parse the uploaded Credit Memo export (xlsx). Matches a sheet named
 * "DataSheet" (the real sample's own sheet name), falling back to the
 * workbook's first sheet like every other parser in this app.
 * @param {ArrayBuffer} arrayBuffer
 */
export function parseVipIncentiveWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === "datasheet") || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  return trimRowKeys(XLSX.utils.sheet_to_json(sheet, { defval: null }));
}

function toNumber(v) {
  const n = Number(v);
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
 * Classify each credit memo row by its Memo text against incentive_mappings
 * -- one row per credit memo already, so unlike Credit Note there's no
 * per-invoice line grouping and no Sub Amount/Product Total distinction:
 * the memo's own GrandTotal is the Expense Amount directly (confirmed
 * explicitly: "Grand Total should be consider for memo"). "Voided" credit
 * memos are dropped outright -- a voided document isn't a real transaction.
 * A memo matching no incentive_mappings rule is held for review; a rule
 * with `ignore` set drops it silently, same as Credit Note.
 *
 * @param {Array} rawRows
 * @param {Array} incentiveMappings - rows from the `incentive_mappings` table
 * @returns {{ groups: Array, unmappedProducts: Array }}
 */
export function aggregateIncentiveLines(rawRows, incentiveMappings) {
  const groups = [];
  const unmappedProducts = [];

  for (const row of rawRows) {
    const creditMemoNumber = row["CreditMemoNumber"] != null ? String(row["CreditMemoNumber"]).trim() : "";
    if (!creditMemoNumber) continue;
    if (row["Status"] === "Voided") continue;

    const memoText = row["Memo"] != null ? String(row["Memo"]).trim() : "";
    const amount = toNumber(row["GrandTotal"]);
    const date = toDate(row["CreatedOn"]);

    const classified = classifyIncentiveRule(memoText, incentiveMappings);
    if (classified.category === "ignored") continue;

    if (classified.category === "unmapped") {
      unmappedProducts.push({ creditMemoNumber, memo: memoText });
      continue;
    }

    if (amount === 0) continue;

    groups.push({
      creditMemoNumber,
      date,
      amount,
      expenseAccount: classified.expenseAccount,
      memo: classified.expenseMemo || memoText,
    });
  }

  return {
    groups: groups.map((g) => ({ ...g, amount: Math.round(g.amount * 100) / 100 })),
    unmappedProducts,
  };
}

/**
 * Build the final Incentives-import rows -- every group posts to the one
 * fixed COMPANY_NAME (see note above), so there's no Store Master/door
 * matching step here at all, unlike every other Bills tab.
 * @param {Array} groupedLines - output of aggregateIncentiveLines()'s `groups`
 * @returns {{ byCompany: Object<string, Array> }}
 */
export function buildIncentiveRows(groupedLines) {
  const rows = groupedLines.map((line) => ({
    "Bill No": line.creditMemoNumber,
    Date: line.date ? formatMMDDYYYY(line.date) : "",
    "Expense Amount": line.amount,
    Vendor: VENDOR,
    "AP Account": AP_ACCOUNT,
    "Expense Account": line.expenseAccount,
    "Expense  Memo": line.memo,
    "Expense Class": "",
  }));

  return { byCompany: rows.length > 0 ? { [COMPANY_NAME]: rows } : {} };
}
