// Shared fallback for raw store names that don't exactly match Store
// Master's Elevate Name (renames, typos, casing drift) — used by Payroll's
// timesheet upload, Change in Inventory's Opening/Closing uploads, and
// Store Transfer's From/To columns. Backed by the `store_name_mappings`
// table (raw_name -> elevate_name), edited on the Mapping Master page.

/** Build a { [raw_name]: elevate_name } lookup from `store_name_mappings` rows. */
export function buildStoreNameMap(storeNameMappings) {
  const map = {};
  for (const m of storeNameMappings || []) {
    const raw = m.raw_name != null ? String(m.raw_name).trim() : "";
    const elevate = m.elevate_name != null ? String(m.elevate_name).trim() : "";
    if (raw && elevate) map[raw] = elevate;
  }
  return map;
}

/**
 * Return new row objects with `field` remapped through the raw-name ->
 * elevate-name lookup wherever a mapping exists; rows with no matching
 * mapping are returned unchanged (same object reference).
 */
export function remapStoreNamesInRows(rows, field, storeNameMap) {
  if (!rows || !rows.length || !storeNameMap || Object.keys(storeNameMap).length === 0) return rows;
  return rows.map((r) => {
    const raw = r[field] != null ? String(r[field]).trim() : "";
    const mapped = storeNameMap[raw];
    if (!mapped || mapped === raw) return r;
    return { ...r, [field]: mapped };
  });
}
