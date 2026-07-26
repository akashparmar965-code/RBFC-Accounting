import * as XLSX from "xlsx";

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Parse a single opening- or closing-inventory export (xlsx/csv) into row
 * objects. Prefers a sheet literally named "opening"/"closing" if present
 * (matches a combined Stock Trigger File), otherwise falls back to the
 * first sheet (a standalone single-sheet export).
 */
export function parseInventorySheet(arrayBuffer, preferredName) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const preferred = preferredName && wb.SheetNames.find((n) => n.trim().toLowerCase() === preferredName);
  const sheetName = preferred || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
}

/** Sum "Total Cost" grouped by "Store" (raw stock-system store name). */
export function sumCostByStore(rows) {
  const sums = {};
  for (const row of rows) {
    const store = row["Store"] != null ? String(row["Store"]).trim() : "";
    if (!store) continue;
    sums[store] = (sums[store] || 0) + toNumber(row["Total Cost"]);
  }
  return sums;
}

/**
 * Build per-store Opening/Closing/Change-in-Inventory rows, matched to
 * Store Master by exact `elevate_name` (no fallback mapping table, same
 * as the Payroll timesheet match — unmatched raw store names are flagged
 * and excluded, never guessed).
 *
 * Change in Inventory = Opening Stock − Closing Stock (positive when
 * inventory decreased over the period; matches the source workbook).
 *
 * @param {Object} openingByStore - output of sumCostByStore(openingRows)
 * @param {Object} closingByStore - output of sumCostByStore(closingRows)
 * @param {Array} storeMaster - rows from the `stores` table
 */
export function buildInventoryChangeRows(openingByStore, closingByStore, storeMaster) {
  const knownStores = new Set();
  const changeRows = [];

  for (const s of storeMaster) {
    const company = s.company_name ? String(s.company_name).trim() : "";
    const store = s.elevate_name ? String(s.elevate_name).trim() : "";
    if (!company || !store) continue;
    knownStores.add(store);

    const opening = round2(openingByStore[store] || 0);
    const closing = round2(closingByStore[store] || 0);

    changeRows.push({
      company,
      store,
      storeLabel: s.elevate_name_new_qbo_class || store,
      opening,
      closing,
      change: round2(opening - closing),
    });
  }

  const allRawStores = new Set([...Object.keys(openingByStore), ...Object.keys(closingByStore)]);
  const unmatchedStores = Array.from(allRawStores).filter((s) => !knownStores.has(s));

  return { changeRows, unmatchedStores };
}

export const JE_COLUMNS = ["Date", "Account", "Debit", "Credit", "Class"];

/**
 * Change rows -> Inventory JE lines, grouped by company. Direct port of
 * "buildAllInventoryJEs": every store with a valid (non-NaN) change gets a
 * debit/credit pair — including an exact-zero change, which the source
 * script also emits (it only skips a missing Class or a NaN amount, never
 * a zero one).
 *   change > 0 (inventory decreased): Dr Change in Inventory, Cr Inventory
 *   change < 0 (inventory increased): Dr Inventory, Cr Change in Inventory
 *
 * @param {Array} changeRows - output of buildInventoryChangeRows().changeRows
 * @param {string} journalDate - "MM/DD/YYYY", the selected JE date
 * @returns {Object<string, Array>} byCompany
 */
export function buildInventoryJournalEntryRows(changeRows, journalDate) {
  const byCompany = {};

  for (const r of changeRows) {
    if (!r.storeLabel || !r.company) continue;
    const amt = round2(Math.abs(r.change));
    const invFirst = r.change < 0; // increase -> Debit Inventory first; decrease/zero -> Debit Change in Inventory first
    const lines = invFirst
      ? [
          { Date: journalDate, Account: "Inventory", Debit: amt, Credit: "", Class: r.storeLabel },
          { Date: journalDate, Account: "Change in Inventory", Debit: "", Credit: amt, Class: r.storeLabel },
        ]
      : [
          { Date: journalDate, Account: "Change in Inventory", Debit: amt, Credit: "", Class: r.storeLabel },
          { Date: journalDate, Account: "Inventory", Debit: "", Credit: amt, Class: r.storeLabel },
        ];

    if (!byCompany[r.company]) byCompany[r.company] = [];
    byCompany[r.company].push(...lines);
  }

  return byCompany;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows) {
  const header = JE_COLUMNS.join(",");
  const lines = rows.map((r) => JE_COLUMNS.map((c) => csvEscape(r[c])).join(","));
  return [header, ...lines].join("\n");
}

/** Build an .xlsx file (as a Uint8Array) from JE rows, ready to hand to a Blob. */
export function rowsToXlsxBuffer(rows, sheetName = "Inventory JE") {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: JE_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
