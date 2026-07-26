import * as XLSX from "xlsx";

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export const JE_COLUMNS = ["Journal Date", "Account", "Debit", "Credit", "Class", "Memo"];

/**
 * Match the uploaded timesheet's active stores (any store with nonzero
 * hours — same "active this period" signal as Payroll, but no fallback
 * table here: use the shared store_name_mappings remap on the raw rows
 * before calling this) against Store Master, grouped by company.
 *
 * @param {Object} storeHours - output of buildStoreHours() (from payrollProcessor)
 * @param {Array} storeMaster - rows from the `stores` table
 */
export function buildActiveStoreInfo(storeHours, storeMaster) {
  const knownStores = new Set();
  const storeCompany = {};
  const storeLabel = {};
  for (const s of storeMaster) {
    const store = s.elevate_name ? String(s.elevate_name).trim() : "";
    if (!store) continue;
    knownStores.add(store);
    storeCompany[store] = s.company_name ? String(s.company_name).trim() : "";
    storeLabel[store] = s.elevate_name_new_qbo_class || store;
  }

  const activeRaw = Object.keys(storeHours).filter((s) => Number(storeHours[s]) > 0);
  const matchedStores = [];
  const unmatchedStores = [];
  for (const name of activeRaw) {
    if (knownStores.has(name)) matchedStores.push(name);
    else unmatchedStores.push(name);
  }

  const byCompany = {};
  for (const store of matchedStores) {
    const company = storeCompany[store];
    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push(store);
  }

  return { matchedStores, unmatchedStores, byCompany, storeLabel, storeCompany };
}

/**
 * Allocate freeform manual JV lines across active stores, grouped by
 * company. Every line (Debit or Credit, whichever is nonzero) is allocated
 * at the same rate: amount / total active stores, system-wide.
 *   split_per_store: one row per active store at that rate, Class = store.
 *   !split_per_store: one row per company at (rate * that company's active
 *     store count), Class blank — a company-level total, not per-store.
 *
 * @param {Array} jvLines - [{ account_name, debit, credit, split_per_store }]
 * @param {Object} activeStoreInfo - output of buildActiveStoreInfo()
 * @param {string} journalDate - "MM/DD/YYYY"
 * @returns {Object<string, Array>} byCompany
 */
export function buildManualJvJournalEntryRows(jvLines, activeStoreInfo, journalDate) {
  const { matchedStores, byCompany, storeLabel, storeCompany } = activeStoreInfo;
  const totalActive = matchedStores.length;
  const result = {};
  if (totalActive === 0) return result;

  const addLine = (company, line) => {
    if (!result[company]) result[company] = [];
    result[company].push(line);
  };

  for (const line of jvLines) {
    const debit = toNumber(line.debit);
    const credit = toNumber(line.credit);
    const isDebit = debit > 0;
    const amount = isDebit ? debit : credit;
    if (!amount) continue;
    const perStoreShare = round2(amount / totalActive);

    if (line.split_per_store) {
      for (const store of matchedStores) {
        addLine(storeCompany[store], {
          "Journal Date": journalDate,
          Account: line.account_name,
          Debit: isDebit ? perStoreShare : "",
          Credit: isDebit ? "" : perStoreShare,
          Class: storeLabel[store],
          Memo: "",
        });
      }
    } else {
      for (const [company, stores] of Object.entries(byCompany)) {
        const companyAmount = round2(perStoreShare * stores.length);
        if (!companyAmount) continue;
        addLine(company, {
          "Journal Date": journalDate,
          Account: line.account_name,
          Debit: isDebit ? companyAmount : "",
          Credit: isDebit ? "" : companyAmount,
          Class: "",
          Memo: "",
        });
      }
    }
  }

  return result;
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
export function rowsToXlsxBuffer(rows, sheetName = "Manual JV") {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: JE_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
