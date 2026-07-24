const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function safeName(s) {
  return String(s).replace(/[^a-z0-9]+/gi, "_");
}

/** Find the latest parseable date among rows[dateKey] (each a "MM/DD/YYYY" string). */
export function latestDateFromRows(rows, dateKey) {
  let latest = null;
  for (const r of rows) {
    const raw = r[dateKey];
    if (!raw) continue;
    const d = new Date(raw);
    if (!isNaN(d) && (!latest || d > latest)) latest = d;
  }
  return latest;
}

function monthYearLabel(date) {
  if (!date) return "Undated";
  return `${MONTH_NAMES[date.getMonth()]}_${date.getFullYear()}`;
}

/**
 * Build "{Company}_{Exp|Sale}_{Month}_{Year}.{ext}" using the latest date
 * found in the given rows.
 */
export function buildExportFileName(company, kind, rows, dateKey, ext) {
  const label = monthYearLabel(latestDateFromRows(rows, dateKey));
  return `${safeName(company)}_${kind}_${label}.${ext}`;
}
