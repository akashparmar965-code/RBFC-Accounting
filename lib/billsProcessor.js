import * as XLSX from "xlsx";

const VENDOR = "VIP Wireless";
const AP_ACCOUNT = "Accounts Payable";
const DEVICE_ACCOUNT = "All Devices";
const DEVICE_MEMO = "Mobile and Other Devices";

/**
 * Classify a Bill-sheet line by Memo, using memo_mappings rows (loaded
 * from Supabase, editable on the Mapping Master page) instead of a
 * hardcoded list. A line is "device" when its Memo just restates the
 * Invoice Number (VIP does this for straight device sales); else, if its
 * Memo starts with a mapped prefix, it's "service" using that rule's
 * Expense Account/Memo; otherwise it's "unmapped".
 */
function classifyMemo(memoRaw, invoiceNo, memoMappings) {
  if (memoRaw === invoiceNo) return { category: "device" };
  const rule = memoMappings.find((m) => memoRaw.startsWith(m.memo_prefix));
  if (rule) {
    return {
      category: "service",
      expenseAccount: rule.expense_account,
      expenseMemo: rule.expense_memo || memoRaw,
    };
  }
  return { category: "unmapped" };
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
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
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
 * Group raw Bill-sheet line items by (Door Number, Invoice Number, Memo).
 * Each group carries its resolved category ("device"/"service"/"unmapped")
 * plus the Expense Account/Memo to use, resolved via classifyMemo().
 *
 * @param {Array} rawRows
 * @param {Array} memoMappings - rows from the `memo_mappings` table
 */
export function aggregateBillLines(rawRows, memoMappings) {
  const groups = {}; // "door||invoice||memo" -> { doorNumber, invoiceNo, category, expenseAccount, date, amount, memo }

  for (const row of rawRows) {
    const doorNumber = row["Door Number"] != null ? String(row["Door Number"]).trim() : "";
    const invoiceNo = row["Invoice Number"] != null ? String(row["Invoice Number"]).trim() : "";
    if (!doorNumber || !invoiceNo) continue;

    const memoRaw = row["Memo"] != null ? String(row["Memo"]).trim() : "";
    const classified = classifyMemo(memoRaw, invoiceNo, memoMappings);
    const key = `${doorNumber}||${invoiceNo}||${memoRaw}`;

    if (!groups[key]) {
      const isDevice = classified.category === "device";
      groups[key] = {
        doorNumber,
        invoiceNo,
        category: classified.category,
        expenseAccount: isDevice ? DEVICE_ACCOUNT : classified.expenseAccount,
        date: toDate(row["Tran Date"]),
        amount: 0,
        memo: isDevice ? DEVICE_MEMO : classified.expenseMemo || memoRaw || DEVICE_MEMO,
      };
    }
    groups[key].amount += toNumber(row["Product Total"]);
  }

  return Object.values(groups).map((g) => ({
    ...g,
    amount: Math.round(g.amount * 100) / 100,
  }));
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
 * @returns {{ byCompany: Object<string, Array>, unmatchedDoors: string[], unmappedMemos: Array }}
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
  const unmappedMemos = [];

  for (const line of groupedLines) {
    if (line.amount === 0) continue;

    // Unknown memo pattern — flag it instead of guessing which Expense
    // Account/Memo it belongs to, regardless of the selected category.
    if (line.category === "unmapped") {
      unmappedMemos.push({
        doorNumber: line.doorNumber,
        invoiceNo: line.invoiceNo,
        memo: line.memo,
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
    unmappedMemos,
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
