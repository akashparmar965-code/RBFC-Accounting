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
 * at the same flat rate: amount / total active stores, system-wide.
 *   split_per_store: one row per active store, Class = store. Every store
 *     gets the plain flat rate **except one**: the first store of the first
 *     company (whatever order Store Master/the timesheet naturally
 *     produced — not re-sorted; "first company" = first key of `byCompany`,
 *     same object as `activeStoreInfo`'s), which instead gets
 *     `amount − flatRate×(totalActive−1)` — absorbing that whole line's
 *     rounding remainder in one place, system-wide. This is a deliberate,
 *     explicitly-confirmed choice over scoping the fix per company: it
 *     guarantees each line's own grand total (summed across every store)
 *     always matches the amount actually entered, at the cost of every
 *     *other* company still carrying its own small Dr/Cr drift from each
 *     line rounding its flat rate independently (e.g. a company with N
 *     active stores can be off by roughly N cents) — same drift the
 *     pre-fix code had everywhere, now confined to companies other than
 *     the first. Only the first company's own Dr/Cr balances as a result.
 *   !split_per_store: one row per company at `flatRate × that company's
 *     store count`, Class blank — a company-level total, not per-store;
 *     untouched by the single-store adjustment above (there's no specific
 *     store to place it on in a collapsed line).
 *
 * @param {Array} jvLines - [{ account_name, debit, credit, split_per_store }]
 * @param {Object} activeStoreInfo - output of buildActiveStoreInfo()
 * @param {string} journalDate - "MM/DD/YYYY"
 * @returns {{ byCompany: Object<string, Array>, roundingAdjustments: Object<string, {store: string, total: number}> }}
 *   roundingAdjustments has at most one entry (the first company), summing
 *   how much extra (or less) than a plain flat share landed in its first
 *   store across every split_per_store line.
 */
export function buildManualJvJournalEntryRows(jvLines, activeStoreInfo, journalDate) {
  const { matchedStores, byCompany, storeLabel, storeCompany } = activeStoreInfo;
  const totalActive = matchedStores.length;
  const result = {};
  const roundingAdjustments = {};
  if (totalActive === 0) return { byCompany: result, roundingAdjustments };

  const companyNames = Object.keys(byCompany);
  const firstCompany = companyNames.length > 0 ? companyNames[0] : null;
  const firstStore = firstCompany && byCompany[firstCompany].length > 0 ? byCompany[firstCompany][0] : null;

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
      const othersTotal = round2(perStoreShare * (totalActive - 1));
      const firstStoreShare = firstStore ? round2(amount - othersTotal) : perStoreShare;

      for (const store of matchedStores) {
        const shareForStore = store === firstStore ? firstStoreShare : perStoreShare;
        addLine(storeCompany[store], {
          "Journal Date": journalDate,
          Account: line.account_name,
          Debit: isDebit ? shareForStore : "",
          Credit: isDebit ? "" : shareForStore,
          Class: storeLabel[store],
          Memo: "",
        });
      }

      if (firstStore) {
        const delta = round2(firstStoreShare - perStoreShare);
        if (delta !== 0) {
          if (!roundingAdjustments[firstCompany]) {
            roundingAdjustments[firstCompany] = { store: storeLabel[firstStore], total: 0 };
          }
          roundingAdjustments[firstCompany].total = round2(roundingAdjustments[firstCompany].total + delta);
        }
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

  return { byCompany: result, roundingAdjustments };
}

/**
 * Group Store Master's Active stores by company, for the Company Split
 * tab — this is a flat "every Active store counts equally", no Employee
 * Timesheet involved (unlike the main Manual JV tab's "active this period"
 * hours-based signal).
 *
 * @param {Array} storeMaster - rows from the `stores` table
 * @returns {Object<string, Array<{store, label}>>} byCompany
 */
export function buildCompanyActiveStores(storeMaster) {
  const byCompany = {};
  for (const s of storeMaster) {
    if (s.status !== "Active") continue;
    const store = s.elevate_name ? String(s.elevate_name).trim() : "";
    const company = s.company_name ? String(s.company_name).trim() : "";
    if (!store || !company) continue;
    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push({ store, label: s.elevate_name_new_qbo_class || store });
  }
  return byCompany;
}

/**
 * Allocate company-wise JV lines across that company's Active stores
 * (e.g. $1200 for a company with 12 Active stores -> $100/store),
 * independent per line — no cross-company blending.
 *   split_per_store: one row per Active store in that company, Class = store.
 *     Every store except the last one in `byCompany`'s order gets the plain
 *     round2 fair share; that last store gets amount minus the others'
 *     total, absorbing the rounding remainder so the JE always reconciles
 *     to the entered amount exactly instead of drifting a cent or two when
 *     the store count doesn't divide it evenly. "Last" is whatever order
 *     buildCompanyActiveStores/Store Master naturally returned — not
 *     re-sorted — so it's stable across a given company's stores, but not
 *     a specific named store.
 *   !split_per_store: one row for the full amount, Class blank — a
 *     company-level total, not per-store.
 *
 * @param {Array} lines - [{ account_name, company_name, debit, credit, split_per_store }]
 * @param {Object} byCompany - output of buildCompanyActiveStores()
 * @param {string} journalDate - "MM/DD/YYYY"
 * @returns {{ byCompany: Object<string, Array>, skippedCompanies: string[], roundingAdjustments: Object<string, {store: string, total: number}> }}
 *   skippedCompanies = company names referenced by a line that has zero
 *   Active stores (that line is excluded, never guessed).
 *   roundingAdjustments = per company with a split_per_store line and more
 *   than one Active store, how much extra (or less) than a plain fair share
 *   was placed in the absorbing store, summed across all of that company's
 *   lines.
 */
export function buildCompanySplitJournalEntryRows(lines, byCompany, journalDate) {
  const result = {};
  const skippedCompanies = new Set();
  const roundingAdjustments = {};

  const addLine = (company, line) => {
    if (!result[company]) result[company] = [];
    result[company].push(line);
  };

  for (const line of lines) {
    const debit = toNumber(line.debit);
    const credit = toNumber(line.credit);
    const isDebit = debit > 0;
    const amount = isDebit ? debit : credit;
    if (!amount) continue;

    const stores = byCompany[line.company_name] || [];
    if (stores.length === 0) {
      skippedCompanies.add(line.company_name);
      continue;
    }

    if (line.split_per_store) {
      if (stores.length > 1) {
        const fairShare = round2(amount / stores.length);
        const otherStores = stores.slice(0, -1);
        const roundingStore = stores[stores.length - 1];
        const otherStoresTotal = round2(fairShare * otherStores.length);
        const roundingShare = round2(amount - otherStoresTotal);

        for (const { label } of otherStores) {
          addLine(line.company_name, {
            "Journal Date": journalDate,
            Account: line.account_name,
            Debit: isDebit ? fairShare : "",
            Credit: isDebit ? "" : fairShare,
            Class: label,
            Memo: "",
          });
        }
        addLine(line.company_name, {
          "Journal Date": journalDate,
          Account: line.account_name,
          Debit: isDebit ? roundingShare : "",
          Credit: isDebit ? "" : roundingShare,
          Class: roundingStore.label,
          Memo: "",
        });

        if (!roundingAdjustments[line.company_name]) {
          roundingAdjustments[line.company_name] = { store: roundingStore.label, total: 0 };
        }
        roundingAdjustments[line.company_name].total = round2(
          roundingAdjustments[line.company_name].total + (roundingShare - fairShare)
        );
      } else {
        const perStoreShare = round2(amount / stores.length);
        for (const { label } of stores) {
          addLine(line.company_name, {
            "Journal Date": journalDate,
            Account: line.account_name,
            Debit: isDebit ? perStoreShare : "",
            Credit: isDebit ? "" : perStoreShare,
            Class: label,
            Memo: "",
          });
        }
      }
    } else {
      addLine(line.company_name, {
        "Journal Date": journalDate,
        Account: line.account_name,
        Debit: isDebit ? amount : "",
        Credit: isDebit ? "" : amount,
        Class: "",
        Memo: "",
      });
    }
  }

  return { byCompany: result, skippedCompanies: Array.from(skippedCompanies), roundingAdjustments };
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
