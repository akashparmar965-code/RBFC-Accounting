import * as XLSX from "xlsx";

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Short company labels used specifically by the AR Deposits output (its
 * per-company tabs and "Comapny" column — confirmed against the user's real
 * reference file, which names its 9 company tabs exactly this way; this is
 * NOT the same as Store Master's `company_name`, e.g. "RBFC YOUNGSTOWN LLC").
 */
export const COMPANY_SHORT_LABELS = {
  "RBFC SC LLC": "SC",
  "RBFC NC LLC": "NC",
  "RBFC KNOXVILLE LLC": "Knoxville",
  "RBFC CLEVELAND LLC": "Cleveland",
  "RBFC COLUMBUS LLC": "Columbus",
  "RBFC PA LLC": "PA",
  "RBFC NASHVILLE LLC": "Nashville",
  "RBFC INDIANA LLC": "Indiana",
  "RBFC YOUNGSTOWN LLC": "Youngstown",
};

/**
 * Parse an "X-Report" export (xlsx) — one sheet per store (sheet name =
 * Store Master's Elevate Name), each with a "Tendered Amounts" section
 * containing a "Tender Types" table. Mirrors the source Google Apps Script
 * exactly: find the first cell in column A reading "Tender Types" (there
 * are two — a section label and, one row below it, the real header row),
 * find "Sub Net" in that header row, then read tender name / amount pairs
 * down column A until a blank tender name.
 */
export function parseXReportWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const results = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    let firstIdx = -1;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const row = grid[i];
      if (row && row[0] != null && String(row[0]).trim() === "Tender Types") {
        firstIdx = i;
        break;
      }
    }
    if (firstIdx === -1) continue; // not a store sheet (no Tendered Amounts section)

    const headerRow = grid[firstIdx + 1] || [];
    const subNetColIdx = headerRow.findIndex((v) => v != null && String(v).trim() === "Sub Net");
    if (subNetColIdx === -1) continue;

    let r = firstIdx + 2;
    while (r < grid.length) {
      const row = grid[r] || [];
      const tenderName = row[0] != null ? String(row[0]).trim() : "";
      if (!tenderName) break;
      results.push({ store: sheetName, tenderType: tenderName, amount: toNumber(row[subNetColIdx]) });
      r++;
    }
  }

  return results;
}

/**
 * Turn raw {store, tenderType, amount} rows into full AR Deposit rows,
 * matched to Store Master and the `deposit_account_mappings` table.
 *
 * Rules (confirmed against the user's real reference workbook before
 * building):
 *   - A zero-amount tender line is dropped — a $0 deposit isn't a real
 *     event (confirmed: the reference file's raw per-tender-type rows
 *     include zeros, but its final All_Data/per-company output doesn't).
 *   - Store match: Elevate Name (the X-Report's sheet name), falling back
 *     to `store_name_mappings` like every other upload page. Still
 *     unmatched -> excluded + flagged, never guessed.
 *   - "Deposit To Account"/"Payment Method" come from `deposit_account_mappings`
 *     keyed by Tender Type. A Tender Type with no mapping row gets
 *     `""`/`" "` (matching the source formulas' own fallback) and is
 *     flagged as unmatched rather than guessed.
 *   - "Class" = Store Master's QBO class (`elevate_name_new_qbo_class`,
 *     same convention as every other JE-generating page in this app).
 *   - "Comapny" (this exact spelling — matches the user's own QuickBooks
 *     import template header, not a typo to "fix") = the short company
 *     label via COMPANY_SHORT_LABELS, not the full `company_name`.
 *   - "Received From"/"From Account"/"Memo" are page-level constants
 *     applied to every row (confirmed constant across the entire real
 *     reference file — "ELEVATE"/"Accounts Receivable"/"Deposit").
 *
 * @param {Array} rawRows - output of parseXReportWorkbook()
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {Object} storeNameMap - from buildStoreNameMap(store_name_mappings)
 * @param {Array} accountMappings - rows from `deposit_account_mappings`
 * @param {string} depositDate - "MM/DD/YYYY"
 * @param {{receivedFrom: string, fromAccount: string, memo: string}} globals
 */
export function buildDepositRows(rawRows, storeMaster, storeNameMap, accountMappings, depositDate, globals) {
  const storeByElevate = new Map();
  for (const s of storeMaster) {
    const elevate = s.elevate_name ? String(s.elevate_name).trim() : "";
    if (!elevate) continue;
    storeByElevate.set(elevate, s);
  }

  const accountByTenderType = new Map();
  for (const m of accountMappings) {
    const t = m.tender_type ? String(m.tender_type).trim() : "";
    if (!t) continue;
    accountByTenderType.set(t, m);
  }

  const rows = [];
  const unmatchedStoresSet = new Set();
  const unmatchedTenderTypesSet = new Set();

  for (const raw of rawRows) {
    const amount = round2(raw.amount);
    if (!amount) continue;

    const rawStore = String(raw.store).trim();
    const mappedStore = storeNameMap[rawStore] || rawStore;
    const storeRow = storeByElevate.get(mappedStore);
    if (!storeRow) {
      unmatchedStoresSet.add(rawStore);
      continue;
    }

    const mapping = accountByTenderType.get(raw.tenderType);
    if (!mapping) unmatchedTenderTypesSet.add(raw.tenderType);

    const companyFull = storeRow.company_name ? String(storeRow.company_name).trim() : "";
    const companyShort = COMPANY_SHORT_LABELS[companyFull] || companyFull;

    rows.push({
      "Deposit Date": depositDate,
      Store_Name: mappedStore,
      Tender_Type: raw.tenderType,
      "Deposit Amount": amount,
      Class: storeRow.elevate_name_new_qbo_class || mappedStore,
      Comapny: companyShort,
      "Deposit To Account": mapping ? mapping.deposit_to_account : "",
      "Received From": globals.receivedFrom,
      "From Account": globals.fromAccount,
      "Payment Method": mapping ? mapping.payment_method : " ",
      Memo: globals.memo,
    });
  }

  const byCompany = {};
  for (const row of rows) {
    if (!byCompany[row.Comapny]) byCompany[row.Comapny] = [];
    byCompany[row.Comapny].push(row);
  }

  return {
    rows,
    byCompany,
    unmatchedStores: Array.from(unmatchedStoresSet),
    unmatchedTenderTypes: Array.from(unmatchedTenderTypesSet),
  };
}

export const ALL_DATA_COLUMNS = [
  "Deposit Date",
  "Store_Name",
  "Tender_Type",
  "Deposit Amount",
  "Class",
  "Comapny",
  "Deposit To Account",
  "Received From",
  "From Account",
  "Payment Method",
  "Memo",
];

export const COMPANY_COLUMNS = [
  "Deposit Date",
  "Deposit Amount",
  "Class",
  "Deposit To Account",
  "Received From",
  "From Account",
  "Payment Method",
  "Memo",
];

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows, columns) {
  const header = columns.join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(","));
  return [header, ...lines].join("\n");
}

/** Build an .xlsx file (as a Uint8Array) from rows, ready to hand to a Blob. */
export function rowsToXlsxBuffer(rows, columns, sheetName = "Deposits") {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
