import * as XLSX from "xlsx";

const VENDOR = "VIP Wireless";
const AP_ACCOUNT = "Accounts Payable";
const OTHER_CHARGES_ACCOUNT = "Other Services VIP";
const DEDUCTIONS_ACCOUNT = "Deductions";

/**
 * Same structure and formula as creditNoteProcessor.js — this file mirrors
 * it exactly, just pointed at the VIP export's "Incentives" sheet and its
 * own `incentive_mappings` table instead of Credit Note's.
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
 * Classify an Incentives-sheet line against incentive_mappings — same
 * hybrid rule shape as classifyCreditNoteRule in creditNoteProcessor.js:
 * `textRaw` is the invoice's Memo when it has one, or a single Products
 * line's text when the whole invoice has a blank Memo.
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

/**
 * Same stray-header-whitespace guard as billsProcessor.js/creditNoteProcessor.js.
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

/** Same old/new VIP export format auto-detection as the Credit Note sheet. */
export function isNewIncentiveFormat(rawRows) {
  return rawRows.length > 0 && "Document" in rawRows[0];
}

/** Column-name lookup for the detected Incentives-sheet format. */
function incentiveColumns(isNew) {
  return {
    invoiceNo: isNew ? "Document" : "Invoice Number",
    tranDate: isNew ? "Date" : "Tran Date",
    subAmount: isNew ? "Sub Total" : "Sub Amount",
    shippingCost: isNew ? "Shipping" : "Shipping Cost",
    productTotal: isNew ? "Total" : "Product Total",
  };
}

/**
 * Parse the uploaded VIP export (xlsx) and return rows from the
 * "Incentives" sheet — same workbook column shape as the Credit Note
 * sheet (Door Number, Invoice Number/Document, Tran Date/Date, Memo,
 * Products, Product Total/Total, Sub Amount/Sub Total, Other Cost, Other
 * Deductions, Discount, Shipping Cost/Shipping). Both old and new column
 * shapes are supported, auto-detected per file, same as Credit Note.
 * @param {ArrayBuffer} arrayBuffer
 */
export function parseVipIncentiveWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheetName =
    wb.SheetNames.find((n) => n.trim().toLowerCase() === "incentives" || n.trim().toLowerCase() === "incentive") ||
    wb.SheetNames[0];
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
 * Build output lines per invoice (Door Number, Invoice Number), plus the
 * same Other Services VIP / Deductions split — identical formula to
 * aggregateCreditNoteLines in creditNoteProcessor.js, against
 * incentive_mappings instead of credit_note_mappings.
 *
 * An invoice with a real (non-blank) Memo is classified by Memo — one main
 * line, amount = the invoice's own Sub Amount. A blank-Memo invoice is
 * classified per line by Products against the same incentive_mappings
 * table, combining lines that resolve to the same Expense Account. Other
 * Cost + Shipping Cost, and −(Discount + Other Deductions), are
 * invoice-level values captured once per invoice for either path. Amounts
 * are not sign-flipped, same as Credit Note. Other Services VIP/Deductions
 * only post if the invoice has at least one real posted line. A rule with
 * `ignore` set drops the whole invoice (Memo path) or just that one line
 * (blank-Memo Products path) silently.
 *
 * @param {Array} rawRows
 * @param {Array} incentiveMappings - rows from the `incentive_mappings` table (both paths)
 * @returns {{ groups: Array, discountOrShippingFlags: Array }}
 */
export function aggregateIncentiveLines(rawRows, incentiveMappings) {
  const invoices = {};
  const linesByInvoice = {};
  const cols = incentiveColumns(isNewIncentiveFormat(rawRows));

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
        discount: toNumber(row["Discount"]),
        shippingCost: toNumber(row[cols.shippingCost]),
      };
      linesByInvoice[invoiceKey] = [];
    }
    linesByInvoice[invoiceKey].push({
      productRaw: row["Products"] != null ? String(row["Products"]).trim() : "",
      total: toNumber(row[cols.productTotal]),
    });
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
    const invoiceKey = `${inv.doorNumber}||${inv.invoiceNo}`;
    let hasPostedLine = false;

    if (inv.memo !== "") {
      // ---- Memo path ----
      const classified = classifyIncentiveRule(inv.memo, incentiveMappings);
      if (classified.category === "ignored") continue;

      if (classified.category === "unmapped") {
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
      hasPostedLine = true;
    } else {
      // ---- Blank-Memo Products fallback (same incentive_mappings table) ----
      const accountGroups = {};
      const unmappedGroups = {};
      for (const line of linesByInvoice[invoiceKey]) {
        const classified = classifyIncentiveRule(line.productRaw, incentiveMappings);
        if (classified.category === "ignored") continue;
        if (classified.category === "unmapped") {
          if (!unmappedGroups[line.productRaw]) {
            unmappedGroups[line.productRaw] = { product: line.productRaw, amount: 0 };
          }
          unmappedGroups[line.productRaw].amount += line.total;
          continue;
        }
        if (!accountGroups[classified.expenseAccount]) {
          accountGroups[classified.expenseAccount] = {
            expenseAccount: classified.expenseAccount,
            memo: classified.expenseMemo,
            product: line.productRaw,
            amount: 0,
          };
        }
        accountGroups[classified.expenseAccount].amount += line.total;
        hasPostedLine = true;
      }

      for (const g of Object.values(accountGroups)) {
        groups.push({
          doorNumber: inv.doorNumber,
          invoiceNo: inv.invoiceNo,
          unmapped: false,
          expenseAccount: g.expenseAccount,
          date: inv.date,
          amount: g.amount,
          memo: g.memo,
          product: g.product,
        });
      }
      for (const u of Object.values(unmappedGroups)) {
        groups.push({
          doorNumber: inv.doorNumber,
          invoiceNo: inv.invoiceNo,
          unmapped: true,
          expenseAccount: null,
          date: inv.date,
          amount: u.amount,
          memo: u.product,
          product: u.product,
        });
      }
    }

    if (!hasPostedLine) continue;

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
 * Store Master, and build the final Incentives-import rows, grouped by
 * Company — identical to buildCreditNoteRows in creditNoteProcessor.js.
 *
 * @param {Array} groupedLines - output of aggregateIncentiveLines()
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {Array} doorMappings - rows from the `door_mappings` table
 * @returns {{ byCompany: Object<string, Array>, unmatchedDoors: string[], unmappedProducts: Array }}
 */
export function buildIncentiveRows(groupedLines, storeMaster, doorMappings = []) {
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
    if (line.amount === 0 && !line.alwaysPost) continue;

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
