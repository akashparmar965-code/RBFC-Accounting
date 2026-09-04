import * as XLSX from "xlsx";

const VENDOR = "VIP Wireless";
const AP_ACCOUNT = "Accounts Payable";
const DEVICE_ACCOUNT = "All Devices";
const OTHER_CHARGES_ACCOUNT = "Other Services VIP";
const DEDUCTIONS_ACCOUNT = "Deductions";

/**
 * True if productLower matches m.product_prefix under m.match_type
 * ("starts_with" | "contains" | "exact"; missing/unknown defaults to
 * "starts_with" for backward compatibility with rules from before this
 * field existed).
 */
function productMatchesRule(productLower, m) {
  const prefixLower = String(m.product_prefix).toLowerCase();
  switch (m.match_type) {
    case "exact":
      return productLower === prefixLower;
    case "contains":
      return productLower.includes(prefixLower);
    case "starts_with":
    default:
      return productLower.startsWith(prefixLower);
  }
}

/**
 * Classify a Bill-sheet line by its Products text (not Memo — Memo is
 * often generic or inconsistent, e.g. just restating the Invoice Number).
 * Matched against product_mappings rows (from Supabase, editable on the
 * Mapping Master page) per each rule's own match_type. A line matching no
 * mapped rule is "unmapped".
 *
 * expenseMemo comes from the matched rule's own `expense_memo` field only
 * — falls back to the Expense Account name if that's not set, never to the
 * raw file's Products/Name/Memo text. Per explicit request: Expense Memo
 * must be sourced from Product Mapping, not derived from the file, even
 * though most rules don't have one filled in yet (2026-09-02).
 */
function classifyProduct(productRaw, productMappings) {
  const productLower = productRaw.toLowerCase();
  const rule = productMappings.find((m) => productMatchesRule(productLower, m));
  if (!rule) return { category: "unmapped" };
  return {
    category: rule.expense_account === DEVICE_ACCOUNT ? "device" : "service",
    expenseAccount: rule.expense_account,
    expenseMemo: rule.expense_memo || rule.expense_account,
  };
}

/**
 * VIP's own export occasionally has stray leading/trailing whitespace on a
 * header cell (seen on " Invoice Number" in a real May 2026 file, "Invoice
 * Number" every other month) — sheet_to_json uses header text verbatim as
 * each row's keys, so an untrimmed header silently made every row's
 * `row["Invoice Number"]` read undefined and the whole file got skipped
 * with no error. Trim every row's own keys so lookups like row["Invoice
 * Number"] work regardless of stray whitespace in the source file.
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
 * VIP reshaped the Bill sheet's export sometime around Aug 2026: "Invoice
 * Number" -> "Document", "Tran Date" -> "Invoice Date", "Products" -> "Name",
 * "Product Total" -> "Total", "Sub Amount" -> "Subtotal", "Shipping Cost" ->
 * "Shipping", and the "Memo" column was dropped entirely. Detected once per
 * file from whether the header row has "Document" (new) — both shapes are
 * supported since older files may still come in.
 * @param {Array} rawRows
 */
export function isNewBillFormat(rawRows) {
  return rawRows.length > 0 && "Document" in rawRows[0];
}

/** Column-name lookup for the detected Bill-sheet format. */
function billColumns(isNew) {
  return {
    invoiceNo: isNew ? "Document" : "Invoice Number",
    tranDate: isNew ? "Invoice Date" : "Tran Date",
    product: isNew ? "Name" : "Products",
    productTotal: isNew ? "Total" : "Product Total",
    shippingCost: isNew ? "Shipping" : "Shipping Cost",
  };
}

/**
 * Parse the uploaded VIP export (xlsx) and return rows from the "Bill" sheet
 * only — Payment and Credit Note sheets are not part of this feature.
 * @param {ArrayBuffer} arrayBuffer
 */
export function parseVipWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheetName =
    wb.SheetNames.find((n) => n.trim().toLowerCase() === "bill") || wb.SheetNames[0];
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
 * Group raw Bill-sheet line items by (Door Number, Invoice Number,
 * resolved Expense Account) — lines that map to the same account combine
 * into one output row per invoice, matching how VIP's own multi-line
 * invoices are meant to post. Unmapped lines are kept separate per unique
 * Products text so each distinct unmapped product is reported once.
 *
 * Also emits two extra lines per invoice, both posted every time even when
 * $0 (never skipped like a $0 product line would be): Other Cost + Shipping
 * Cost → OTHER_CHARGES_ACCOUNT, and −(Discount + Other Deductions) →
 * DEDUCTIONS_ACCOUNT (negative — a deduction reduces what's owed). Those 4
 * source columns are invoice-level values the raw export repeats
 * identically on every product line of that invoice (not a per-line
 * additive amount) — captured once per invoice, never summed across its
 * lines.
 *
 * Also detects a real VIP export anomaly seen in practice: an invoice
 * number that spans more than one Door Number, all sharing the exact same
 * Shipping Address/Entity/Order Number — i.e. one real transaction
 * misattributed to many doors instead of just its own true one (confirmed
 * on a real file: one $2.26-net invoice appeared under 109 different Door
 * Numbers). A legitimate invoice is always exactly one door. Rows under a
 * flagged invoice are held out of `groups` entirely (never posted, same
 * "don't guess" treatment as an unmapped product) and reported in
 * `sharedDocumentFlags` for manual review instead.
 *
 * @param {Array} rawRows
 * @param {Array} productMappings - rows from the `product_mappings` table
 * @returns {{ groups: Array, sharedDocumentFlags: Array }}
 */
export function aggregateBillLines(rawRows, productMappings) {
  const groups = {};
  const invoiceOtherCharges = {};
  const isNew = isNewBillFormat(rawRows);
  const cols = billColumns(isNew);

  const invoiceDoors = {};
  for (const row of rawRows) {
    const invoiceNo = row[cols.invoiceNo] != null ? String(row[cols.invoiceNo]).trim() : "";
    const doorNumber = row["Door Number"] != null ? String(row["Door Number"]).trim() : "";
    if (!invoiceNo || !doorNumber) continue;
    if (!invoiceDoors[invoiceNo]) invoiceDoors[invoiceNo] = new Set();
    invoiceDoors[invoiceNo].add(doorNumber);
  }
  const flaggedInvoices = new Set(
    Object.keys(invoiceDoors).filter((inv) => invoiceDoors[inv].size > 1)
  );
  const sharedDocumentFlags = [];
  const seenFlagged = new Set();

  for (const row of rawRows) {
    const doorNumber = row["Door Number"] != null ? String(row["Door Number"]).trim() : "";
    const invoiceNo = row[cols.invoiceNo] != null ? String(row[cols.invoiceNo]).trim() : "";
    if (!doorNumber || !invoiceNo) continue;

    if (flaggedInvoices.has(invoiceNo)) {
      if (!seenFlagged.has(invoiceNo)) {
        seenFlagged.add(invoiceNo);
        sharedDocumentFlags.push({
          invoiceNo,
          doorCount: invoiceDoors[invoiceNo].size,
          rowCount: rawRows.filter(
            (r) => (r[cols.invoiceNo] != null ? String(r[cols.invoiceNo]).trim() : "") === invoiceNo
          ).length,
        });
      }
      continue;
    }

    const productRaw = row[cols.product] != null ? String(row[cols.product]).trim() : "";
    // Only used for the Other Charges/Deductions lines' own memo below —
    // not for classifyProduct anymore (Expense Memo comes from Product
    // Mapping only, never derived from the file's Memo/Name text).
    const memoRaw = isNew ? "" : row["Memo"] != null ? String(row["Memo"]).trim() : "";
    const classified = classifyProduct(productRaw, productMappings);
    const key =
      classified.category === "unmapped"
        ? `${doorNumber}||${invoiceNo}||unmapped||${productRaw}`
        : `${doorNumber}||${invoiceNo}||${classified.category}||${classified.expenseAccount}`;

    if (!groups[key]) {
      groups[key] = {
        doorNumber,
        invoiceNo,
        category: classified.category,
        expenseAccount: classified.expenseAccount,
        date: toDate(row[cols.tranDate]),
        amount: 0,
        memo: classified.expenseMemo,
        product: productRaw,
      };
    }
    groups[key].amount += toNumber(row[cols.productTotal]);

    const invoiceKey = `${doorNumber}||${invoiceNo}`;
    if (!invoiceOtherCharges[invoiceKey]) {
      invoiceOtherCharges[invoiceKey] = {
        doorNumber,
        invoiceNo,
        date: toDate(row[cols.tranDate]),
        memo: memoRaw,
        otherCost: toNumber(row["Other Cost"]),
        otherDeductions: toNumber(row["Other Deductions"]),
        discount: toNumber(row["Discount"]),
        shippingCost: toNumber(row[cols.shippingCost]),
      };
    }
  }

  for (const inv of Object.values(invoiceOtherCharges)) {
    const otherChargesKey = `${inv.doorNumber}||${inv.invoiceNo}||otherCharges`;
    groups[otherChargesKey] = {
      doorNumber: inv.doorNumber,
      invoiceNo: inv.invoiceNo,
      category: "service",
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
      category: "service",
      expenseAccount: DEDUCTIONS_ACCOUNT,
      date: inv.date,
      amount: -(inv.discount + inv.otherDeductions),
      memo: inv.memo || "Deductions",
      product: "Deductions",
      alwaysPost: true,
    };
  }

  return {
    groups: Object.values(groups).map((g) => ({
      ...g,
      amount: Math.round(g.amount * 100) / 100,
    })),
    sharedDocumentFlags,
  };
}

/**
 * Match each grouped line to the Store Master (by Door Number ==
 * vip_website_no), falling back to door_mappings for door numbers not in
 * Store Master, and build the final Bill-import rows, grouped by Company.
 *
 * @param {Array} groupedLines - output of aggregateBillLines()
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {"all"|"device"|"service"} category - restrict to one line category
 * @param {Array} doorMappings - rows from the `door_mappings` table
 * @returns {{ byCompany: Object<string, Array>, unmatchedDoors: string[], unmappedProducts: Array }}
 */
export function buildBillRows(groupedLines, storeMaster, category = "all", doorMappings = []) {
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
    // every invoice's charge (or lack of one) is visible rather than
    // silently dropped.
    if (line.amount === 0 && !line.alwaysPost) continue;

    // Unknown product — flag it instead of guessing which Expense
    // Account/Memo it belongs to, regardless of the selected category.
    if (line.category === "unmapped") {
      unmappedProducts.push({
        doorNumber: line.doorNumber,
        invoiceNo: line.invoiceNo,
        product: line.product,
      });
      continue;
    }

    if (category !== "all" && line.category !== category) continue;

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

/** Flatten a byCompany map into one combined array (all companies together). */
export function buildAllInOneRows(byCompany) {
  return Object.values(byCompany).flat();
}

export const CSV_COLUMNS = [
  "Bill No",
  "Date",
  "Expense Amount",
  "Vendor",
  "AP Account",
  "Expense Account",
  "Expense  Memo",
  "Expense Class",
];

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows) {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c])).join(","));
  return [header, ...lines].join("\n");
}

/** Build an .xlsx file (as a Uint8Array) from rows, ready to hand to a Blob. */
export function rowsToXlsxBuffer(rows, sheetName = "Bills") {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: CSV_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
