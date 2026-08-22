import * as XLSX from "xlsx";

const VENDOR = "VIP Wireless";
const AP_ACCOUNT = "Accounts Payable";
const OTHER_CHARGES_ACCOUNT = "Other Services VIP";
const DEDUCTIONS_ACCOUNT = "Deductions";

/**
 * True if textLower matches m.product_prefix under m.match_type
 * ("starts_with" | "contains" | "exact"; missing/unknown defaults to
 * "starts_with"). Mirrors billsProcessor.js's productMatchesRule.
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
 * Classify a Credit Note-sheet line by its Memo text, against
 * credit_note_mappings — a dedicated mapping table, deliberately separate
 * from Bills' product_mappings. Classified by Memo, not Products, per
 * explicit correction: confirmed against both real files that Memo is
 * consistently invoice-level (every line of a given credit memo shares
 * the exact same Memo text — 0 of 1,848 real credit memos had it vary
 * across their own lines) and far more structured than Products (128
 * distinct Memo values vs. 779 distinct Products values across the same
 * two files) — e.g. "Weekly Incentive Credit - <date range>", "Xfinity
 * Activation Bounty $25 <date range>", "transfer commission withhold
 * earned on <date> due to OC <name> <date>". "contains"/"starts_with" on
 * a stable prefix like "Weekly Incentive Credit" or "transfer commission
 * withhold" is expected to bucket the large majority of real memos
 * despite the embedded dates/names making exact matches useless. A line
 * matching no mapped rule is "unmapped". A rule with `ignore` set drops
 * the whole credit memo from file generation entirely (e.g. "Weekly
 * Incentive Credit" isn't meant to post at all) — distinct from
 * "unmapped", which still flags the line for review; an ignored line is
 * silently excluded, never flagged.
 */
function classifyCreditNoteMemo(memoRaw, creditNoteMappings) {
  const memoLower = memoRaw.toLowerCase();
  const rule = creditNoteMappings.find((m) => textMatchesRule(memoLower, m));
  if (!rule) return { category: "unmapped" };
  if (rule.ignore) return { ignored: true };
  return {
    expenseAccount: rule.expense_account,
    expenseMemo: rule.expense_memo || memoRaw || rule.expense_account,
  };
}

/**
 * VIP's own export occasionally has stray whitespace on a header cell
 * (confirmed on the Bill sheet's " Invoice Number" in a real May 2026
 * file) — trim every row's own keys so a lookup like row["Invoice
 * Number"] doesn't silently break on a stray space, same fix as
 * billsProcessor.js's parseVipWorkbook.
 */
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
 * Parse the uploaded VIP export (xlsx) and return rows from the "Credit
 * Note" sheet only — same workbook shape as the Bill sheet (Door Number,
 * Invoice Number [reads "Credit Memo ######" here], Shipping Address,
 * Tran Date, Memo, Products, Product Total, Sub Amount, Other Cost, Other
 * Deductions, Discount, Shipping Cost), confirmed against real Jan/Mar-Apr
 * 2026 files.
 * @param {ArrayBuffer} arrayBuffer
 */
export function parseVipCreditNoteWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheetName =
    wb.SheetNames.find((n) => n.trim().toLowerCase() === "credit note") || wb.SheetNames[0];
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
 * Group raw Credit Note-sheet line items by (Door Number, Invoice Number,
 * resolved Expense Account) — classified by **Memo**, not Products (see
 * classifyCreditNoteMemo above for why). Since Memo is invoice-level (every
 * line of a credit memo shares the same Memo text), this means every line
 * of a given credit memo resolves to the same rule and merges into one
 * output line — a whole credit memo posts as a single Expense Amount, not
 * split per Products sub-line the way it briefly was before this
 * correction.
 *
 * Also emits the same Other Services VIP / Deductions split as
 * billsProcessor.js's aggregateBillLines (Other Cost + Shipping Cost, and
 * −(Discount + Other Deductions), both invoice-level values captured once
 * per invoice, never summed across its lines — confirmed the raw export
 * repeats them identically per line here too, same as the Bill sheet). Per
 * explicit instruction, Credit Note line amounts are NOT sign-flipped —
 * every Product Total in the real files is already a positive credit
 * magnitude, and the file is imported into QuickBooks as its own "Credit
 * Note" transaction type, which is what actually applies the credit
 * direction (the Deductions line itself is still negative — same formula
 * as Bills, unchanged, per explicit confirmation to keep the split
 * identical).
 *
 * A credit_note_mappings rule with `ignore` set drops its whole credit
 * memo from output silently — no group, no Other Services VIP/Deductions
 * lines, no unmapped flag (e.g. "Weekly Incentive Credit" memos aren't
 * meant to post at all).
 *
 * @param {Array} rawRows
 * @param {Array} creditNoteMappings - rows from the `credit_note_mappings` table
 */
export function aggregateCreditNoteLines(rawRows, creditNoteMappings) {
  const groups = {};
  const invoiceOtherCharges = {};

  for (const row of rawRows) {
    const doorNumber = row["Door Number"] != null ? String(row["Door Number"]).trim() : "";
    const invoiceNo = row["Invoice Number"] != null ? String(row["Invoice Number"]).trim() : "";
    if (!doorNumber || !invoiceNo) continue;

    const memoRaw = row["Memo"] != null ? String(row["Memo"]).trim() : "";
    const classified = classifyCreditNoteMemo(memoRaw, creditNoteMappings);
    // Ignored -- drop this line (and, since every line of a credit memo
    // shares the same Memo, effectively the whole credit memo, including
    // its Other Services VIP/Deductions split below, which is never
    // captured for an invoice whose every row hits this continue) before
    // it's flagged as unmapped or grouped at all.
    if (classified.ignored) continue;
    const key =
      classified.expenseAccount == null
        ? `${doorNumber}||${invoiceNo}||unmapped||${memoRaw}`
        : `${doorNumber}||${invoiceNo}||${classified.expenseAccount}`;

    if (!groups[key]) {
      groups[key] = {
        doorNumber,
        invoiceNo,
        unmapped: classified.expenseAccount == null,
        expenseAccount: classified.expenseAccount,
        date: toDate(row["Tran Date"]),
        amount: 0,
        memo: classified.expenseMemo || memoRaw,
        product: memoRaw,
      };
    }
    groups[key].amount += toNumber(row["Product Total"]);

    const invoiceKey = `${doorNumber}||${invoiceNo}`;
    if (!invoiceOtherCharges[invoiceKey]) {
      invoiceOtherCharges[invoiceKey] = {
        doorNumber,
        invoiceNo,
        date: toDate(row["Tran Date"]),
        memo: memoRaw,
        otherCost: toNumber(row["Other Cost"]),
        otherDeductions: toNumber(row["Other Deductions"]),
        discount: toNumber(row["Discount"]),
        shippingCost: toNumber(row["Shipping Cost"]),
      };
    }
  }

  for (const inv of Object.values(invoiceOtherCharges)) {
    const otherChargesKey = `${inv.doorNumber}||${inv.invoiceNo}||otherCharges`;
    groups[otherChargesKey] = {
      doorNumber: inv.doorNumber,
      invoiceNo: inv.invoiceNo,
      unmapped: false,
      expenseAccount: OTHER_CHARGES_ACCOUNT,
      date: inv.date,
      amount: inv.otherCost + inv.shippingCost,
      memo: inv.memo || "Other Charges",
      product: "Other Charges",
      alwaysPost: true,
    };

    const deductionsKey = `${inv.doorNumber}||${inv.invoiceNo}||deductions`;
    groups[deductionsKey] = {
      doorNumber: inv.doorNumber,
      invoiceNo: inv.invoiceNo,
      unmapped: false,
      expenseAccount: DEDUCTIONS_ACCOUNT,
      date: inv.date,
      amount: -(inv.discount + inv.otherDeductions),
      memo: inv.memo || "Deductions",
      product: "Deductions",
      alwaysPost: true,
    };
  }

  return Object.values(groups).map((g) => ({
    ...g,
    amount: Math.round(g.amount * 100) / 100,
  }));
}

/**
 * Match each grouped line to the Store Master (by Door Number ==
 * vip_website_no), falling back to door_mappings for door numbers not in
 * Store Master, and build the final Credit Note-import rows, grouped by
 * Company — mirrors billsProcessor.js's buildBillRows, minus the
 * device/service category split (credit_note_mappings has no equivalent
 * of Bills' "All Devices" device-account concept to split on, same as
 * Epay/Ondigo's simpler single-category output).
 *
 * @param {Array} groupedLines - output of aggregateCreditNoteLines()
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {Array} doorMappings - rows from the `door_mappings` table
 * @returns {{ byCompany: Object<string, Array>, unmatchedDoors: string[], unmappedProducts: Array }}
 */
export function buildCreditNoteRows(groupedLines, storeMaster, doorMappings = []) {
  const storeByDoorNumber = {};
  for (const s of storeMaster) {
    if (s.vip_website_no) storeByDoorNumber[String(s.vip_website_no).trim()] = s;
  }
  const doorMapByNumber = {};
  for (const d of doorMappings) {
    if (d.door_number) doorMapByNumber[String(d.door_number).trim()] = d;
  }

  const byCompany = {};
  const unmatchedDoorsSet = new Set();
  const unmappedProducts = [];

  for (const line of groupedLines) {
    // Other Charges / Deductions lines always post, even at $0 net, so
    // every credit memo's charge (or lack of one) is visible rather than
    // silently dropped.
    if (line.amount === 0 && !line.alwaysPost) continue;

    // Unknown product — flag it instead of guessing which Expense
    // Account/Memo it belongs to.
    if (line.unmapped) {
      unmappedProducts.push({
        doorNumber: line.doorNumber,
        invoiceNo: line.invoiceNo,
        product: line.product,
      });
      continue;
    }

    const master = storeByDoorNumber[line.doorNumber];
    let company;
    let qboClass;
    if (master) {
      company = master.company_name || "Unassigned";
      qboClass = master.elevate_name_new_qbo_class || "";
    } else {
      const mapped = doorMapByNumber[line.doorNumber];
      if (mapped) {
        company = mapped.company_name;
        qboClass = mapped.qbo_class;
      } else {
        unmatchedDoorsSet.add(line.doorNumber);
        continue;
      }
    }

    const row = {
      "Bill No": line.invoiceNo,
      Date: line.date ? formatMMDDYYYY(line.date) : "",
      "Expense Amount": line.amount,
      Vendor: VENDOR,
      "AP Account": AP_ACCOUNT,
      "Expense Account": line.expenseAccount,
      "Expense  Memo": line.memo,
      "Expense Class": qboClass,
    };

    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push(row);
  }

  return {
    byCompany,
    unmatchedDoors: Array.from(unmatchedDoorsSet),
    unmappedProducts,
  };
}
