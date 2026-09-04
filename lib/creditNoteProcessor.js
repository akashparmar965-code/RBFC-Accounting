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
 * VIP reshaped the Credit Note sheet's export around the same time as the
 * Bill sheet (Aug/Sep 2026): "Invoice Number" -> "Document", "Tran Date"
 * -> "Date", "Product Total" -> "Total", "Sub Amount" -> "Sub Total",
 * "Shipping Cost" -> "Shipping" — same renames as billsProcessor.js. Memo
 * and Products are unchanged. The **Discount column was dropped
 * entirely** in the new format; confirmed against a real 585-credit-memo
 * file that Sub Total + Other Cost + Shipping − Other Deductions equals
 * Grand Total exactly with no Discount term at all (0 mismatches) — no
 * special-casing needed since `toNumber(row["Discount"])` already
 * resolves to 0 when that key is simply absent from the row.
 * @param {Array} rawRows
 */
export function isNewCreditNoteFormat(rawRows) {
  return rawRows.length > 0 && "Document" in rawRows[0];
}

/** Column-name lookup for the detected Credit Note-sheet format. */
function creditNoteColumns(isNew) {
  return {
    invoiceNo: isNew ? "Document" : "Invoice Number",
    tranDate: isNew ? "Date" : "Tran Date",
    subAmount: isNew ? "Sub Total" : "Sub Amount",
    shippingCost: isNew ? "Shipping" : "Shipping Cost",
  };
}

/**
 * Parse the uploaded VIP export (xlsx) and return rows from the "Credit
 * Note" sheet only — same workbook shape as the Bill sheet (Door Number,
 * Invoice Number [reads "Credit Memo ######" here], Shipping Address,
 * Tran Date, Memo, Products, Product Total, Sub Amount, Other Cost, Other
 * Deductions, Discount, Shipping Cost), confirmed against real Jan/Mar-Apr
 * 2026 files. Both this old shape and the new one above are supported,
 * auto-detected per file.
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
 * Build one output line per credit memo (Door Number, Invoice Number),
 * classified by **Memo**, not Products (see classifyCreditNoteMemo above
 * for why), plus the same Other Services VIP / Deductions split as
 * billsProcessor.js's aggregateBillLines.
 *
 * The main line's amount is the invoice's own **Sub Amount**, captured
 * once per invoice — NOT a sum of that invoice's Product Total lines.
 * Confirmed against both real files (Sub Amount never varies across a
 * credit memo's own lines, 0 exceptions) that most real credit memos
 * (471/593 in the Jan 2026 file, 1,053/1,255 in Mar-Apr — 79-84%) carry a
 * redundant line item (typically "ROI Account", sometimes a bare store
 * name) whose own Product Total equals the *entire* Sub Amount by
 * itself, sitting alongside the real itemized breakdown lines that
 * separately sum to that same Sub Amount — e.g. one real credit memo had
 * "ROI Account" = $860.09 plus "Dealer Weekly Incentive Credit -
 * Postpaid" = $8.20 and "...-Prepaid" = $851.89 ($8.20 + $851.89 =
 * $860.09 = the "ROI Account" line on its own). Summing every line's
 * Product Total therefore double-counts nearly every credit memo; Sub
 * Amount is the one number every line already agrees is the true total,
 * so it's used directly instead of re-deriving it from the (unreliable)
 * line items.
 *
 * Other Cost + Shipping Cost, and −(Discount + Other Deductions), are
 * also invoice-level values captured once per invoice, never summed
 * across its lines — confirmed the raw export repeats them identically
 * per line here too, same as the Bill sheet. Per explicit instruction,
 * Credit Note line amounts are NOT sign-flipped — every Sub Amount in the
 * real files is already a positive credit magnitude, and the file is
 * imported into QuickBooks as its own "Credit Note" transaction type,
 * which is what actually applies the credit direction (the Deductions
 * line itself is still negative — same formula as Bills, unchanged, per
 * explicit confirmation to keep the split identical).
 *
 * A credit_note_mappings rule with `ignore` set drops its whole credit
 * memo from output silently — no group, no Other Services VIP/Deductions
 * lines, no unmapped flag (e.g. "Weekly Incentive Credit" memos aren't
 * meant to post at all). A Memo matching **no** rule holds the whole
 * credit memo for review the same way — only the single "unmapped" record
 * is emitted, no Other Services VIP/Deductions lines — since those used to
 * post unconditionally even when the main line was held, producing a lone
 * unbalanced −$X "Deductions" (or +$X "Other Services VIP") line with
 * nothing offsetting it for a credit memo that really nets to $0.
 *
 * Discount and Shipping Cost were $0 on every row of both real files this
 * feature was first built against, so −Discount and +Shipping Cost above
 * were unverified against a real nonzero example — since confirmed on a
 * real 2026-09-02 file with 13 nonzero-Shipping credit memos, where
 * Sub Total + Other Cost + Shipping − Other Deductions reconciled exactly
 * to Grand Total for every one. Per explicit request, any invoice with a
 * nonzero Discount or Shipping Cost is still
 * collected into `discountOrShippingFlags` (regardless of mapped/
 * unmapped/ignored status — this is a data/formula flag, not a posting
 * decision) so the page can surface it for manual review; the line still
 * posts using the same formula as Other Cost/Other Deductions, it's just
 * flagged, not excluded.
 *
 * @param {Array} rawRows
 * @param {Array} creditNoteMappings - rows from the `credit_note_mappings` table
 * @returns {{ groups: Array, discountOrShippingFlags: Array }}
 */
export function aggregateCreditNoteLines(rawRows, creditNoteMappings) {
  const invoices = {};
  const cols = creditNoteColumns(isNewCreditNoteFormat(rawRows));

  for (const row of rawRows) {
    const doorNumber = row["Door Number"] != null ? String(row["Door Number"]).trim() : "";
    const invoiceNo = row[cols.invoiceNo] != null ? String(row[cols.invoiceNo]).trim() : "";
    if (!doorNumber || !invoiceNo) continue;

    const invoiceKey = `${doorNumber}||${invoiceNo}`;
    if (!invoices[invoiceKey]) {
      invoices[invoiceKey] = {
        doorNumber,
        invoiceNo,
        date: toDate(row[cols.tranDate]),
        memo: row["Memo"] != null ? String(row["Memo"]).trim() : "",
        subAmount: toNumber(row[cols.subAmount]),
        otherCost: toNumber(row["Other Cost"]),
        otherDeductions: toNumber(row["Other Deductions"]),
        // New format dropped Discount entirely -- toNumber(undefined)
        // already resolves to 0 when the key is simply absent.
        discount: toNumber(row["Discount"]),
        shippingCost: toNumber(row[cols.shippingCost]),
      };
    }
  }

  const discountOrShippingFlags = [];
  for (const inv of Object.values(invoices)) {
    if (inv.discount !== 0 || inv.shippingCost !== 0) {
      discountOrShippingFlags.push({
        doorNumber: inv.doorNumber,
        invoiceNo: inv.invoiceNo,
        discount: inv.discount,
        shippingCost: inv.shippingCost,
      });
    }
  }

  const groups = [];
  for (const inv of Object.values(invoices)) {
    const classified = classifyCreditNoteMemo(inv.memo, creditNoteMappings);
    // Ignored -- drop the whole credit memo (main line + its Other
    // Services VIP/Deductions split) before anything is flagged unmapped
    // or emitted.
    if (classified.ignored) continue;

    if (classified.expenseAccount == null) {
      // Unmapped -- hold the *whole* credit memo for review, not just the
      // main line. The Other Services VIP/Deductions lines used to post
      // unconditionally (alwaysPost) even when the main line was held,
      // which produced a lone unbalanced Deductions/Other Services VIP
      // entry with nothing offsetting it once the memo got mapped later
      // (a real credit memo netting to $0.00 showed up as a standalone
      // −$X "Deductions" line with no counterpart). Emitting only this one
      // "unmapped" record means nothing for this invoice posts at all
      // until its Memo has a Credit Note Mapping rule.
      groups.push({
        doorNumber: inv.doorNumber,
        invoiceNo: inv.invoiceNo,
        unmapped: true,
        expenseAccount: null,
        date: inv.date,
        amount: inv.subAmount,
        memo: inv.memo,
        product: inv.memo,
      });
      continue;
    }

    groups.push({
      doorNumber: inv.doorNumber,
      invoiceNo: inv.invoiceNo,
      unmapped: false,
      expenseAccount: classified.expenseAccount,
      date: inv.date,
      amount: inv.subAmount,
      memo: classified.expenseMemo || inv.memo,
      product: inv.memo,
    });

    groups.push({
      doorNumber: inv.doorNumber,
      invoiceNo: inv.invoiceNo,
      unmapped: false,
      expenseAccount: OTHER_CHARGES_ACCOUNT,
      date: inv.date,
      amount: inv.otherCost + inv.shippingCost,
      memo: inv.memo || "Other Charges",
      product: "Other Charges",
      alwaysPost: true,
    });

    groups.push({
      doorNumber: inv.doorNumber,
      invoiceNo: inv.invoiceNo,
      unmapped: false,
      expenseAccount: DEDUCTIONS_ACCOUNT,
      date: inv.date,
      amount: -(inv.discount + inv.otherDeductions),
      memo: inv.memo || "Deductions",
      product: "Deductions",
      alwaysPost: true,
    });
  }

  return {
    groups: groups.map((g) => ({
      ...g,
      amount: Math.round(g.amount * 100) / 100,
    })),
    discountOrShippingFlags,
  };
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
