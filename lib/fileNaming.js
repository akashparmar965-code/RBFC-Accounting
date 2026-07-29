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

/**
 * Several of the source system's exports (Payroll's Custom Reports and
 * Employee Timesheets, Sales, Store Transfer, ...) carry the period they
 * cover in the file name as two 8-digit MMDDYYYY blocks joined by a
 * hyphen (e.g. "Bookkeeping_Sale_Details_06012026-06302026 (4).xlsx" or
 * "Employee_time_Sheet-Payroll_01012026-01312026 (2).xlsx"). Returns
 * "MM/DD/YYYY" strings, or both null if the name doesn't contain that
 * pattern — nothing to check against in that case, never guessed.
 *
 * @param {string} fileName
 * @returns {{ start: string|null, end: string|null }}
 */
export function parseDateRangeFromFileName(fileName) {
  const match = fileName.match(/(\d{8})-(\d{8})/);
  if (!match) return { start: null, end: null };
  const toMMDDYYYY = (s) => `${s.slice(0, 2)}/${s.slice(2, 4)}/${s.slice(4, 8)}`;
  return { start: toMMDDYYYY(match[1]), end: toMMDDYYYY(match[2]) };
}

/** "MM/DD/YYYY" -> zero-padded "YYYYMMDD", for safe string comparison without `Date` parsing ambiguity. */
function mmddyyyyToComparable(mmddyyyy) {
  const [m, d, y] = mmddyyyy.split("/");
  return `${y}${m.padStart(2, "0")}${d.padStart(2, "0")}`;
}

/**
 * Whether an ISO "YYYY-MM-DD" date falls within an [startMMDDYYYY,
 * endMMDDYYYY] range (inclusive), both "MM/DD/YYYY" strings. Compares as
 * zero-padded "YYYYMMDD" strings rather than parsing with `Date` to avoid
 * any locale/timezone ambiguity. Returns true (nothing to reject) if any
 * input is missing.
 */
export function isIsoDateWithinRange(isoDate, startMMDDYYYY, endMMDDYYYY) {
  if (!isoDate || !startMMDDYYYY || !endMMDDYYYY) return true;
  const isoComparable = isoDate.replace(/-/g, "");
  return isoComparable >= mmddyyyyToComparable(startMMDDYYYY) && isoComparable <= mmddyyyyToComparable(endMMDDYYYY);
}

/**
 * Whether a file's whole declared date range ([startMMDDYYYY,
 * endMMDDYYYY], both "MM/DD/YYYY") falls entirely inside a selected
 * calendar month ("YYYY-MM", an HTML `<input type="month">` value) — not
 * just overlapping it. Returns true (nothing to reject) if any input is
 * missing.
 */
export function isFileRangeWithinMonth(startMMDDYYYY, endMMDDYYYY, yearMonth) {
  if (!startMMDDYYYY || !endMMDDYYYY || !yearMonth) return true;
  const [y, m] = yearMonth.split("-");
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  const monthStart = `${y}${m.padStart(2, "0")}01`;
  const monthEnd = `${y}${m.padStart(2, "0")}${String(lastDay).padStart(2, "0")}`;
  const fileStart = mmddyyyyToComparable(startMMDDYYYY);
  const fileEnd = mmddyyyyToComparable(endMMDDYYYY);
  return fileStart >= monthStart && fileEnd <= monthEnd;
}

/** Current month as an HTML `<input type="month">` value, "YYYY-MM". */
export function currentMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
