import * as XLSX from "xlsx";

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Parse the uploaded Store Transfer Receiving Details export (xlsx/csv). */
export function parseStoreTransferWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

/**
 * Match each transfer row's "From"/"To" store to Store Master (exact
 * `elevate_name`, no fallback table — same convention as Payroll/
 * Inventory). A row is dropped (and both raw names flagged) unless BOTH
 * sides match, since a one-sided entry can't be classified same-company
 * vs inter-company or given a safe Class.
 *
 * @param {Array} rawRows - output of parseStoreTransferWorkbook()
 * @param {Array} storeMaster - rows from the `stores` table
 * @returns {{ transferRows: Array, unmatchedStores: string[] }}
 */
export function buildTransferRows(rawRows, storeMaster) {
  const companyByStore = {};
  const qboByStore = {};
  for (const s of storeMaster) {
    const store = s.elevate_name ? String(s.elevate_name).trim() : "";
    if (!store) continue;
    companyByStore[store] = s.company_name ? String(s.company_name).trim() : "";
    qboByStore[store] = s.elevate_name_new_qbo_class || store;
  }

  const unmatchedSet = new Set();
  const transferRows = [];

  for (const row of rawRows) {
    const from = row["From"] != null ? String(row["From"]).trim() : "";
    const to = row["To"] != null ? String(row["To"]).trim() : "";
    const ext = toNumber(row["Ext Cost"]);
    if (!from || !to || !ext) continue;

    const fromKnown = Object.prototype.hasOwnProperty.call(companyByStore, from);
    const toKnown = Object.prototype.hasOwnProperty.call(companyByStore, to);
    if (!fromKnown) unmatchedSet.add(from);
    if (!toKnown) unmatchedSet.add(to);
    if (!fromKnown || !toKnown) continue;

    transferRows.push({
      from,
      fromCompany: companyByStore[from],
      fromLabel: qboByStore[from],
      to,
      toCompany: companyByStore[to],
      toLabel: qboByStore[to],
      ext: round2(ext),
    });
  }

  return { transferRows, unmatchedStores: Array.from(unmatchedSet) };
}

/**
 * Store-to-store pivots for on-screen verification, mirroring the user's
 * own "Device Transfer Out"/"Device Transfer In" pivot tables: grouped by
 * the store on this side, then by the counterpart store, summing Ext Cost.
 */
export function buildDeviceTransferPivots(transferRows) {
  const outByStore = {}; // { [from]: { total, counterparts: [{ store, company, amount }] } }
  const inByStore = {}; // { [to]: { total, counterparts: [{ store, company, amount }] } }

  for (const r of transferRows) {
    if (!outByStore[r.from]) outByStore[r.from] = { company: r.fromCompany, label: r.fromLabel, total: 0, counterparts: {} };
    outByStore[r.from].total = round2(outByStore[r.from].total + r.ext);
    const outKey = r.to;
    if (!outByStore[r.from].counterparts[outKey]) outByStore[r.from].counterparts[outKey] = { store: r.to, company: r.toCompany, amount: 0 };
    outByStore[r.from].counterparts[outKey].amount = round2(outByStore[r.from].counterparts[outKey].amount + r.ext);

    if (!inByStore[r.to]) inByStore[r.to] = { company: r.toCompany, label: r.toLabel, total: 0, counterparts: {} };
    inByStore[r.to].total = round2(inByStore[r.to].total + r.ext);
    const inKey = r.from;
    if (!inByStore[r.to].counterparts[inKey]) inByStore[r.to].counterparts[inKey] = { store: r.from, company: r.fromCompany, amount: 0 };
    inByStore[r.to].counterparts[inKey].amount = round2(inByStore[r.to].counterparts[inKey].amount + r.ext);
  }

  const toSortedArray = (byStore) =>
    Object.entries(byStore)
      .map(([store, v]) => ({
        store,
        company: v.company,
        label: v.label,
        total: v.total,
        counterparts: Object.values(v.counterparts).sort((a, b) => a.store.localeCompare(b.store)),
      }))
      .sort((a, b) => a.store.localeCompare(b.store));

  return { outRows: toSortedArray(outByStore), inRows: toSortedArray(inByStore) };
}

/** Company x company matrix of total Ext Cost transferred, for the Inter-Company Summary. */
export function buildInterCompanySummary(transferRows) {
  const matrix = {}; // { [fromCompany]: { [toCompany]: amount } }
  for (const r of transferRows) {
    if (!matrix[r.fromCompany]) matrix[r.fromCompany] = {};
    matrix[r.fromCompany][r.toCompany] = round2((matrix[r.fromCompany][r.toCompany] || 0) + r.ext);
  }
  return matrix;
}

export const JE_COLUMNS = ["Date", "Account", "Debit", "Credit", "Class"];

/**
 * Store Transfer JE, grouped by company. For every store, its transfers
 * are grouped by counterpart company: same-company transfers combine into
 * one "Store Transfer" line, each different company gets its own
 * "Store Transfer: <Company>" line (so inter-company balances are
 * trackable; intra-company transfers don't touch the balance sheet). The
 * natural movement account (Device Transfer Out for the sending store,
 * Device Transfer In for the receiving store) stays as ONE combined line
 * per store — only the Store Transfer side is split by company.
 *
 *   Out (sender S, own company C_S): Cr Device Transfer Out [store total];
 *     per destination-company group: Dr "Store Transfer[: <company>]" [group total]
 *   In (receiver T, own company C_T): Dr Device Transfer In [store total];
 *     per source-company group: Cr "Store Transfer[: <company>]" [group total]
 *
 * Every line's Class = the store whose books the line belongs to (S for
 * Out lines, T for In lines); each line is added to that store's OWN
 * company's JE.
 *
 * @param {Array} transferRows - output of buildTransferRows().transferRows
 * @param {string} journalDate - "MM/DD/YYYY", the selected JE date
 * @returns {Object<string, Array>} byCompany
 */
export function buildStoreTransferJournalEntryRows(transferRows, journalDate) {
  const byCompany = {};
  const addLine = (company, line) => {
    if (!byCompany[company]) byCompany[company] = [];
    byCompany[company].push(line);
  };

  // ---- Out side, grouped by sender store ----
  const outGroups = {}; // { [from]: { label, company, total, byDestCompany: { [key]: amount } } }
  for (const r of transferRows) {
    if (!outGroups[r.from]) outGroups[r.from] = { label: r.fromLabel, company: r.fromCompany, total: 0, byDestCompany: {} };
    const g = outGroups[r.from];
    g.total = round2(g.total + r.ext);
    const key = r.toCompany === r.fromCompany ? "" : r.toCompany;
    g.byDestCompany[key] = round2((g.byDestCompany[key] || 0) + r.ext);
  }
  for (const g of Object.values(outGroups)) {
    if (g.total) addLine(g.company, { Date: journalDate, Account: "Device Transfer Out", Debit: "", Credit: g.total, Class: g.label });
    for (const [destCompany, amount] of Object.entries(g.byDestCompany)) {
      if (!amount) continue;
      const account = destCompany ? `Store Transfer: ${destCompany}` : "Store Transfer";
      addLine(g.company, { Date: journalDate, Account: account, Debit: amount, Credit: "", Class: g.label });
    }
  }

  // ---- In side, grouped by receiver store ----
  const inGroups = {}; // { [to]: { label, company, total, bySourceCompany: { [key]: amount } } }
  for (const r of transferRows) {
    if (!inGroups[r.to]) inGroups[r.to] = { label: r.toLabel, company: r.toCompany, total: 0, bySourceCompany: {} };
    const g = inGroups[r.to];
    g.total = round2(g.total + r.ext);
    const key = r.fromCompany === r.toCompany ? "" : r.fromCompany;
    g.bySourceCompany[key] = round2((g.bySourceCompany[key] || 0) + r.ext);
  }
  for (const g of Object.values(inGroups)) {
    if (g.total) addLine(g.company, { Date: journalDate, Account: "Device Transfer In", Debit: g.total, Credit: "", Class: g.label });
    for (const [sourceCompany, amount] of Object.entries(g.bySourceCompany)) {
      if (!amount) continue;
      const account = sourceCompany ? `Store Transfer: ${sourceCompany}` : "Store Transfer";
      addLine(g.company, { Date: journalDate, Account: account, Debit: "", Credit: amount, Class: g.label });
    }
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
export function rowsToXlsxBuffer(rows, sheetName = "Store Transfer JE") {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: JE_COLUMNS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
