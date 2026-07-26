// Shared validation for manual numeric-entry grids (Payroll, Arcade &
// Subcontractor, Manual JV) — none of these amounts should ever be
// negative, and a stray negative number should block Save/Generate with a
// clear message instead of silently vanishing from the output.

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
