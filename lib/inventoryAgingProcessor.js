import * as XLSX from "xlsx";

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Parse an "Inventory Aging" export (xlsx) — Product ID/Store/Product Desc Full/Bin/Serial 1/Qty/Cost/Age in Store/Age in Company. */
export function parseInventoryAgingWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

/**
 * Sum Cost×Qty by raw Store name for rows whose entry date — the report's
 * as-of date minus that row's "Age in Store" day count — falls inside the
 * selected month. This is how a device's Aging snapshot ("it's been sitting
 * for N days") gets turned into "it entered this status in month X".
 *
 * @param {Array} rows - parsed aging rows
 * @param {string} reportDateIso - "YYYY-MM-DD", the aging report's as-of date
 * @param {string} selectedMonth - "YYYY-MM"
 */
export function sumAgingLossByRawStore(rows, reportDateIso, selectedMonth) {
  const sums = {};
  if (!reportDateIso || !selectedMonth) return sums;
  const reportDate = new Date(reportDateIso + "T00:00:00");
  if (Number.isNaN(reportDate.getTime())) return sums;

  for (const row of rows) {
    const store = row["Store"] != null ? String(row["Store"]).trim() : "";
    if (!store) continue;
    const age = row["Age in Store"];
    if (age == null || !Number.isFinite(Number(age))) continue;

    const entryDate = new Date(reportDate);
    entryDate.setDate(entryDate.getDate() - Number(age));
    const entryMonth = `${entryDate.getFullYear()}-${String(entryDate.getMonth() + 1).padStart(2, "0")}`;
    if (entryMonth !== selectedMonth) continue;

    const amount = toNumber(row["Cost"]) * toNumber(row["Qty"] ?? 1);
    sums[store] = round2((sums[store] || 0) + amount);
  }
  return sums;
}

/**
 * Match raw per-store loss totals to Store Master (exact `elevate_name`,
 * same as Change in Inventory — no `store_name_mappings` fallback needed
 * here since the caller already remaps raw rows before summing, matching
 * every other upload page's convention).
 *
 * Unlike Change in Inventory (which emits every store, including exact
 * zero, since a month-end balance of $0 is still a meaningful fact), a
 * store with no loss this month has nothing to book — only nonzero
 * amounts produce a row here.
 */
export function matchAgingLossToStores(lossByRawStore, storeMaster) {
  const knownStores = new Set();
  const lossRows = [];

  for (const s of storeMaster) {
    const company = s.company_name ? String(s.company_name).trim() : "";
    const store = s.elevate_name ? String(s.elevate_name).trim() : "";
    if (!company || !store) continue;
    knownStores.add(store);

    const amount = round2(lossByRawStore[store] || 0);
    if (!amount) continue;

    lossRows.push({
      company,
      store,
      storeLabel: s.elevate_name_new_qbo_class || store,
      amount,
    });
  }

  const unmatchedStores = Object.keys(lossByRawStore).filter((s) => !knownStores.has(s));
  return { lossRows, unmatchedStores };
}

/**
 * Devices Lost -> 2 JV pairs per store, matching the user's worked example
 * exactly (kept as 2 separate JVs rather than collapsed into one, even
 * though the Inventory debit/credit cancel out across them):
 *   JV 1: Dr Inventory / Cr Change in Inventory
 *   JV 2: Dr Devices Lost / Cr Inventory
 *
 * @param {Array} lossRows - output of matchAgingLossToStores().lossRows
 * @param {string} journalDate - "MM/DD/YYYY", the selected JE date
 * @returns {Object<string, Array>} byCompany
 */
export function buildDevicesLostJournalEntryRows(lossRows, journalDate) {
  const byCompany = {};

  for (const r of lossRows) {
    if (!r.storeLabel || !r.company || !r.amount) continue;
    const lines = [
      { Date: journalDate, Account: "Inventory", Debit: r.amount, Credit: "", Class: r.storeLabel },
      { Date: journalDate, Account: "Change in Inventory", Debit: "", Credit: r.amount, Class: r.storeLabel },
      { Date: journalDate, Account: "Devices Lost", Debit: r.amount, Credit: "", Class: r.storeLabel },
      { Date: journalDate, Account: "Inventory", Debit: "", Credit: r.amount, Class: r.storeLabel },
    ];

    if (!byCompany[r.company]) byCompany[r.company] = [];
    byCompany[r.company].push(...lines);
  }

  return byCompany;
}
