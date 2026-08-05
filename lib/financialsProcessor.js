import * as XLSX from "xlsx";

const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * These P&L-by-Class exports are named like "PA_JAN_2026.CSV" — a company
 * prefix, then a 3-letter month, then a 4-digit year, hyphen/underscore
 * separated. Returns null if the name doesn't match (never guessed).
 */
export function parsePeriodFromFileName(fileName) {
  const match = fileName.match(/[_-](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[_-](\d{4})/i);
  if (!match) return null;
  const month = MONTH_ABBR[match[1].toLowerCase()];
  const year = Number(match[2]);
  if (!month || !year) return null;
  return { year, month, label: monthLabel(year, month) };
}

export function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** "YYYY-MM" (HTML month input value) -> { year, month }. */
export function parseYearMonthIso(yearMonth) {
  const [y, m] = (yearMonth || "").split("-").map(Number);
  if (!y || !m) return null;
  return { year: y, month: m };
}

const SECTION_HEADERS = {
  "income": "Income",
  "cost of goods sold": "COGS",
  "expense": "Expense",
  "other income": "Other Income",
  "other expense": "Other Expense",
};

const SUMMARY_SECTIONS = {
  "gross profit": "Gross Profit",
  "net ordinary income": "Net Ordinary Income",
  "net other income": "Net Other Income",
  "net income": "Net Income",
};

function isSubtotalLabel(name) {
  const n = name.trim().toLowerCase();
  return n.startsWith("total ") || Boolean(SUMMARY_SECTIONS[n]);
}

function toNumber(v) {
  if (v == null || v === "") return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Parse an uploaded P&L-by-Class export (xlsx/csv) into raw sheet rows (array of arrays). */
export function parsePLWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
}

/**
 * Parse the raw sheet rows (output of parsePLWorkbook) into store columns
 * + line items. A row is a "line" only if it has a value in at least one
 * store column — every blank-across-the-board row is a section/grouping
 * label (e.g. "Ordinary Income/Expense", "Devices", "Payroll Expenses")
 * and is skipped entirely, never stored. Top-level section headers
 * (Income/Cost of Goods Sold/Expense/Other Income/Other Expense) update
 * `currentSection` for every line that follows until the next one; nested
 * grouping labels (Devices, Payroll Expenses, ...) don't change it, so a
 * line nested two levels deep still inherits the correct top section.
 * "Total .../Gross Profit/Net ..." rows are flagged `isSubtotal` and, for
 * the 4 P&L-wide summary rows, get their own dedicated `section` instead
 * of inheriting whatever top section happened to be current.
 *
 * @param {Array<Array>} rows
 * @returns {{ storeColumns: string[], lines: Array<{ accountName, section, isSubtotal, sortOrder, values: Object<string, number> }> }}
 */
export function parsePLRows(rows) {
  if (!rows || !rows.length) throw new Error("No rows found in this file.");
  const headerRow = (rows[0] || []).map((c) => (c != null ? String(c).trim() : ""));
  const lastIsTotal = headerRow.length > 1 && headerRow[headerRow.length - 1].toLowerCase() === "total";
  const storeColumns = headerRow.slice(1, lastIsTotal ? headerRow.length - 1 : headerRow.length).filter(Boolean);
  if (storeColumns.length === 0) {
    throw new Error('Couldn\'t find any store columns in the header row — expected Class labels like "CL - Erie-1675".');
  }

  let currentSection = null;
  const lines = [];
  let sortOrder = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const accountName = row[0] != null ? String(row[0]).trim() : "";
    if (!accountName) continue;

    const hasAnyValue = storeColumns.some((_, idx) => {
      const v = row[idx + 1];
      return v != null && String(v).trim() !== "";
    });

    if (!hasAnyValue) {
      const key = accountName.toLowerCase();
      if (SECTION_HEADERS[key]) currentSection = SECTION_HEADERS[key];
      continue;
    }

    const summaryKey = accountName.toLowerCase();
    const section = SUMMARY_SECTIONS[summaryKey] || currentSection;
    if (!section) continue; // malformed export — a line before any section header; skip defensively

    const values = {};
    storeColumns.forEach((store, idx) => {
      values[store] = toNumber(row[idx + 1]);
    });

    lines.push({ accountName, section, isSubtotal: isSubtotalLabel(accountName), sortOrder: sortOrder++, values });
  }

  return { storeColumns, lines };
}

/**
 * Resolve each store Class label (P&L column header) to a real Store
 * Master row — first by exact `elevate_name_new_qbo_class` match (the
 * expected format, e.g. "CL - Erie-1675"), then by exact `elevate_name`
 * match (in case an export uses the plain name instead), then through
 * the shared `store_name_mappings` fallback (raw_name -> elevate_name,
 * same table Payroll/Inventory/Sales/Store Transfer already use) resolved
 * back to Store Master. Still-unmatched labels are flagged, never guessed.
 *
 * @param {string[]} storeColumns
 * @param {Array} storeMaster - rows from the `stores` table
 * @param {Object} storeNameMap - output of buildStoreNameMap()
 * @returns {{ storeIdByColumn: Object<string,string>, unmatchedColumns: string[] }}
 */
export function resolveStoreColumns(storeColumns, storeMaster, storeNameMap) {
  const byQboClass = {};
  const byElevateName = {};
  for (const s of storeMaster) {
    if (s.elevate_name_new_qbo_class) byQboClass[String(s.elevate_name_new_qbo_class).trim()] = s.id;
    if (s.elevate_name) byElevateName[String(s.elevate_name).trim()] = s.id;
  }

  const storeIdByColumn = {};
  const unmatchedColumns = [];
  for (const col of storeColumns) {
    if (byQboClass[col]) {
      storeIdByColumn[col] = byQboClass[col];
      continue;
    }
    if (byElevateName[col]) {
      storeIdByColumn[col] = byElevateName[col];
      continue;
    }
    const mapped = storeNameMap[col];
    if (mapped && byElevateName[mapped]) {
      storeIdByColumn[col] = byElevateName[mapped];
      continue;
    }
    unmatchedColumns.push(col);
  }
  return { storeIdByColumn, unmatchedColumns };
}
