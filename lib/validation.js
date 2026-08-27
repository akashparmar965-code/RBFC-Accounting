// Shared validation for manual numeric-entry grids (Payroll, Arcade &
// Subcontractor, Manual JV) — none of these amounts should ever be
// negative, and a stray negative number should block Save/Generate with a
// clear message instead of silently vanishing from the output.

/**
 * Detects the "file uploaded but every row got silently skipped" failure
 * class — usually a source export's column header got renamed, mistyped,
 * or picked up stray whitespace (seen for real: VIP's own May 2026 export
 * shipped " Invoice Number" with a leading space instead of "Invoice
 * Number", which made every row's lookup read undefined and the whole
 * file quietly produced zero rows with no error at all). Compares the raw
 * parsed row count against how many rows actually have a non-empty value
 * in every required column; if the file has rows but none clear that bar,
 * a column mapping is almost certainly broken, not the data itself.
 *
 * @param {Array} rawRows - rows straight from the parser, before any grouping/filtering
 * @param {string[]} requiredColumns - column names the caller's own code reads via row[name]
 * @param {string} sourceLabel - shown in the message, e.g. "VIP Bill sheet"
 * @returns {string|null} an alert message, or null if the file looks usable
 */
export function checkRawRowsUsable(rawRows, requiredColumns, sourceLabel) {
  if (!rawRows || rawRows.length === 0) return null;
  const usableCount = rawRows.filter((row) =>
    requiredColumns.every((col) => row[col] != null && String(row[col]).trim() !== "")
  ).length;
  if (usableCount > 0) return null;
  return `${sourceLabel}: found ${rawRows.length} row(s) in the file, but none had a value in the expected column(s) (${requiredColumns.join(
    ", "
  )}). This usually means a column header in the file doesn't match what's expected (renamed, extra whitespace, or wrong sheet) — check the raw file's header row before re-uploading.`;
}

/**
 * Evaluate a simple +/- arithmetic expression typed into a numeric grid
 * cell, e.g. "100+150" -> 250, "100+150-20" -> 230 — so a cell can be
 * committed on Enter/blur without requiring the user to pre-total
 * multiple amounts in their head before typing. A plain number passes
 * through unchanged. Returns null (leave the cell's raw text alone,
 * don't silently blank it) for anything that isn't a clean plain number
 * or +/- expression — stray characters, a bare operator, "1.2.3", etc.
 * Deliberately only +/- (per explicit request), not a general
 * expression evaluator — no eval(), no operator precedence to get
 * wrong, no injection surface.
 * @param {string|number} text
 * @returns {number|null}
 */
export function evaluateAddSubtractExpression(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  const compact = trimmed.replace(/\s+/g, "");
  // Each term must be an explicit +/- away from the last one -- without
  // this the loose "does it only contain digits/./+/-" check let something
  // like "1.2.3" slip through as two adjacent numbers ("1.2" + ".3") with
  // no operator between them, silently summing to a meaningless 1.5.
  if (!/^[+-]?\d+(\.\d+)?([+-]\d+(\.\d+)?)*$/.test(compact)) return null;
  const tokens = compact.match(/[+-]?\d+(\.\d+)?/g);
  const sum = tokens.reduce((acc, t) => acc + parseFloat(t), 0);
  return Math.round(sum * 100) / 100;
}

/**
 * Gate keystrokes into a numeric-expression grid cell (paired with
 * evaluateAddSubtractExpression above) so only digits, ".", "+", "-" can be
 * typed at all, and no term can carry more than 2 decimal digits — checked
 * on every keystroke (an onChange filter that rejects the whole new value
 * if it fails this), not just on commit, so a stray letter or a 3rd
 * decimal digit never appears in the field even for an instant. Allows
 * legitimately in-progress states a full expression wouldn't yet satisfy
 * (empty string, a trailing "+"/"-" while the next term hasn't been typed
 * yet, a bare "-" as the whole value) — evaluateAddSubtractExpression is
 * still the authority on whether the final result is well-formed.
 * @param {string} text
 * @returns {boolean}
 */
export function isValidNumericExpressionInput(text) {
  if (text === "") return true;
  if (!/^[0-9.+-]*$/.test(text)) return false;
  for (const term of text.split(/[+-]/)) {
    if ((term.match(/\./g) || []).length > 1) return false;
    const decimals = term.split(".")[1];
    if (decimals && decimals.length > 2) return false;
  }
  return true;
}

/**
 * Scan a { [company]: { [fieldKey]: string } } grid (Payroll/Arcade shape)
 * for negative values.
 * @param {Object} companyRows
 * @param {Array} fields - [{ key, label }]
 * @returns {string[]} human-readable "Company — Field" descriptions
 */
export function findNegativeGridEntries(companyRows, fields) {
  const bad = [];
  for (const [company, row] of Object.entries(companyRows || {})) {
    for (const { key, label } of fields) {
      const n = Number(row?.[key]);
      if (Number.isFinite(n) && n < 0) bad.push(`${company} — ${label}`);
    }
  }
  return bad;
}

/**
 * Validate a Manual JV line list: no negative Debit/Credit, and no line
 * with both Debit and Credit filled in (a line is either a debit or a
 * credit, never both).
 * @param {Array} jvLines - [{ account_name, debit, credit, split_per_store }]
 * @returns {string[]} human-readable per-line error messages
 */
export function validateManualJvLines(jvLines) {
  const errors = [];
  jvLines.forEach((line, i) => {
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    const hasDebit = Number.isFinite(debit) && debit !== 0;
    const hasCredit = Number.isFinite(credit) && credit !== 0;
    const rowLabel = line.account_name?.trim() ? `Row ${i + 1} (${line.account_name.trim()})` : `Row ${i + 1}`;

    if ((Number.isFinite(debit) && debit < 0) || (Number.isFinite(credit) && credit < 0)) {
      errors.push(`${rowLabel}: amounts can't be negative.`);
    }
    if (hasDebit && hasCredit) {
      errors.push(`${rowLabel}: enter only one of Debit or Credit, not both.`);
    }
  });
  return errors;
}
