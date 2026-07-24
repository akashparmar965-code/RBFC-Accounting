import * as XLSX from "xlsx";

// Accessory distributors -> "Accessories" bucket. Add new vendor names
// here if the business starts stocking from another accessory supplier.
const ACCESSORIES_VENDORS = ["Ondigo", "C2 Wireless", "VoiceComm"];
// Bill-payment processor -> "Bill Payment-Epay" bucket.
const EPAY_VENDOR = "ePay";
// Everything else (blank vendor, Boost Mobile, etc.) falls into "Device".

/**
 * Parse the uploaded raw sales export (xlsx) into an array of row objects.
 * @param {ArrayBuffer} arrayBuffer
 */
export function parseSalesWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function bucketForVendor(vendor) {
  if (ACCESSORIES_VENDORS.includes(vendor)) return "accessories";
  if (vendor === EPAY_VENDOR) return "epay";
  return "device";
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function formatMMDD(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

function formatMMDDYYYY(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getFullYear()}`;
}

/**
 * Aggregate raw sales rows per store into { device, deviceTax, accessories,
 * accessoriesTax, epay } totals, excluding voided transactions.
 */
export function aggregateByStore(rawRows) {
  const totals = {}; // store -> { device, deviceTax, accessories, accessoriesTax, epay }
  let latestDate = null;

  for (const row of rawRows) {
    const store = row["Store"];
    if (!store) continue;
    if (row["Voided"]) continue; // exclude voided lines

    const vendor = row["Vendor"];
    const extPrice = toNumber(row["Ext Price"]);
    const tax = toNumber(row["Tax"]);
    const bucket = bucketForVendor(vendor);

    if (!totals[store]) {
      totals[store] = { device: 0, deviceTax: 0, accessories: 0, accessoriesTax: 0, epay: 0 };
    }

    if (bucket === "device") {
      totals[store].device += extPrice;
      totals[store].deviceTax += tax;
    } else if (bucket === "accessories") {
      totals[store].accessories += extPrice;
      totals[store].accessoriesTax += tax;
    } else if (bucket === "epay") {
      totals[store].epay += extPrice;
    }

    const rawDate = row["Trans Date Time"];
    if (rawDate) {
      const d = rawDate instanceof Date ? rawDate : new Date(rawDate);
      if (!isNaN(d) && (!latestDate || d > latestDate)) latestDate = d;
    }
  }

  // round to cents to avoid floating point noise
  for (const store of Object.keys(totals)) {
    for (const key of Object.keys(totals[store])) {
      totals[store][key] = Math.round(totals[store][key] * 100) / 100;
    }
  }

  return { totals, latestDate };
}

/**
 * Build the final QBO-import-ready rows, grouped by Company, using the
 * store master (from Supabase) to resolve QBO Class and Company for each
 * store (matched by Elevate Name).
 *
 * @param {Object} totals - output of aggregateByStore().totals
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {Date} invoiceDate - date to stamp on every row
 * @returns {{ byCompany: Object<string, Array>, unmatchedStores: string[] }}
 */
export function buildJournalRows(totals, storeMaster, invoiceDate) {
  const storeByElevateName = {};
  for (const s of storeMaster) {
    if (s.elevate_name) storeByElevateName[s.elevate_name] = s;
  }

  const grouped = {}; // company -> array of {store, class, ...totals}
  const unmatchedStores = [];

  for (const [storeName, t] of Object.entries(totals)) {
    const master = storeByElevateName[storeName];
    if (!master) {
      unmatchedStores.push(storeName);
      continue;
    }
    const company = master.company_name || "Unassigned";
    if (!grouped[company]) grouped[company] = [];
    grouped[company].push({
      store: storeName,
      qboClass: master.elevate_name_new_qbo_class || storeName,
      ...t,
    });
  }

  const mmdd = formatMMDD(invoiceDate);
  const invoiceDateStr = formatMMDDYYYY(invoiceDate);

  const byCompany = {};

  for (const [company, stores] of Object.entries(grouped)) {
    const rows = [];
    const makeRow = (prefix, seq, qboClass, product, description, amount) => ({
      "Product/Service Class": qboClass,
      "Invoice No": `${prefix}-${mmdd}-${pad3(seq)}`,
      Customer: "Elevate",
      "Invoice Date": invoiceDateStr,
      Memo: "",
      Class: "",
      "Product/Service": product,
      "Product/Service Description": description,
      "Product/Service Amount": amount.toFixed(2),
      "Product/Service Sales Tax": "Non",
      "Sales Tax": "Non",
      "Customer Sales Tax Code": "Non",
    });

    // Device rows (skip zero amounts)
    let seq = 1;
    for (const s of stores) {
      if (s.device !== 0) rows.push(makeRow("D", seq++, s.qboClass, "Device", "Device", s.device));
    }
    seq = 1;
    for (const s of stores) {
      if (s.deviceTax !== 0)
        rows.push(makeRow("DT", seq++, s.qboClass, "Sales Tax", "Device", s.deviceTax));
    }
    seq = 1;
    for (const s of stores) {
      if (s.accessories !== 0)
        rows.push(makeRow("A", seq++, s.qboClass, "Accessories", "Accessories", s.accessories));
    }
    seq = 1;
    for (const s of stores) {
      if (s.accessoriesTax !== 0)
        rows.push(makeRow("AT", seq++, s.qboClass, "Sales Tax", "Accessories", s.accessoriesTax));
    }
    seq = 1;
    for (const s of stores) {
      if (s.epay !== 0)
        rows.push(
          makeRow("E", seq++, s.qboClass, "Bill Payment-Epay", "Bill Payment-Epay", s.epay)
        );
    }

    byCompany[company] = rows;
  }

  return { byCompany, unmatchedStores };
}

export const CSV_COLUMNS = [
  "Product/Service Class",
  "Invoice No",
  "Customer",
  "Invoice Date",
  "Memo",
  "Class",
  "Product/Service",
  "Product/Service Description",
  "Product/Service Amount",
  "Product/Service Sales Tax",
  "Sales Tax",
  "Customer Sales Tax Code",
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

/** Flatten a byCompany map into one combined array (all companies together). */
export function buildAllInOneRows(byCompany) {
  return Object.values(byCompany).flat();
}

/** Build an .xlsx file (as a Uint8Array) from rows, ready to hand to a Blob. */
export function rowsToXlsxBuffer(rows, sheetName = "Sales") {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: CSV_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
