import * as XLSX from "xlsx";

const VENDOR = "VIP Wireless";
const AP_ACCOUNT = "Accounts Payable";
const DEVICE_ACCOUNT = "All Devices";
const DEVICE_MEMO = "Mobile and Other Devices";
const SERVICE_ACCOUNT = "Other Services VIP";

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
 * Group raw Bill-sheet line items by (Door Number, Invoice Number, category).
 * A line is a "device" line when its Memo is just a restatement of the
 * Invoice Number (VIP's export does this for straight device sales) —
 * anything else (a real description like "Managed Services Fees…") is a
 * service line, kept under its own Expense Account and using that
 * description as the Expense Memo.
 */
export function aggregateBillLines(rawRows) {
  const groups = {}; // "door||invoice||category" -> { doorNumber, invoiceNo, category, date, amount, memo }

  for (const row of rawRows) {
    const doorNumber = row["Door Number"] != null ? String(row["Door Number"]).trim() : "";
    const invoiceNo = row["Invoice Number"] != null ? String(row["Invoice Number"]).trim() : "";
    if (!doorNumber || !invoiceNo) continue;

    const memoRaw = row["Memo"] != null ? String(row["Memo"]).trim() : "";
    const isDevice = memoRaw === invoiceNo;
    const category = isDevice ? "device" : "service";
    const key = `${doorNumber}||${invoiceNo}||${category}`;

    if (!groups[key]) {
      groups[key] = {
        doorNumber,
        invoiceNo,
        category,
        date: toDate(row["Tran Date"]),
        amount: 0,
        memo: isDevice ? DEVICE_MEMO : memoRaw || DEVICE_MEMO,
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
 * vip_website_no) and build the final Bill-import rows, grouped by Company.
 *
 * @param {Array} groupedLines - output of aggregateBillLines()
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {"all"|"device"|"service"} category - restrict to one line category
 * @returns {{ byCompany: Object<string, Array>, unmatchedDoors: string[] }}
 */
export function buildBillRows(groupedLines, storeMaster, category = "all") {
  const storeByDoorNumber = {};
  for (const s of storeMaster) {
    if (s.vip_website_no) storeByDoorNumber[String(s.vip_website_no).trim()] = s;
  }

  const byCompany = {};
  const unmatchedDoorsSet = new Set();

  for (const line of groupedLines) {
    if (category !== "all" && line.category !== category) continue;
    if (line.amount === 0) continue;
    const master = storeByDoorNumber[line.doorNumber];
    if (!master) {
      unmatchedDoorsSet.add(line.doorNumber);
      continue;
    }

    const company = master.company_name || "Unassigned";
    const qboClass = master.elevate_name_new_qbo_class || "";

    const row = {
      "Bill No": line.invoiceNo,
      Date: line.date ? formatMMDDYYYY(line.date) : "",
      "Expense Amount": line.amount,
      Vendor: VENDOR,
      "AP Account": AP_ACCOUNT,
      "Expense Account": line.category === "device" ? DEVICE_ACCOUNT : SERVICE_ACCOUNT,
      "Expense  Memo": line.memo,
      "Expense Class": qboClass,
    };

    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push(row);
  }

  return { byCompany, unmatchedDoors: Array.from(unmatchedDoorsSet) };
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
