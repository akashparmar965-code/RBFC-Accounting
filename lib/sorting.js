// Shared clickable-column-header sorting for Mapping Master / SOP Utilities'
// CRUD tables. A sort state is { column, direction } | null; null means
// "leave rows in their natural (usually DB query .order()) order".

/**
 * Sort rows by sortState.column, case-insensitive string comparison.
 * Missing/null values normalize to "" and sort together. Returns a new
 * array (never mutates rows) or the original array reference when
 * sortState is null, so callers can pass this straight to .map().
 */
export function sortRows(rows, sortState) {
  if (!sortState) return rows;
  const { column, direction } = sortState;
  const sorted = [...rows].sort((a, b) => {
    const av = (a[column] ?? "").toString().toLowerCase();
    const bv = (b[column] ?? "").toString().toLowerCase();
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  return direction === "asc" ? sorted : sorted.reverse();
}

/** Click handler for a sortable <th>: same column toggles asc/desc, a new column starts at asc. */
export function toggleSort(setSortState, column) {
  setSortState((prev) =>
    prev?.column === column ? { column, direction: prev.direction === "asc" ? "desc" : "asc" } : { column, direction: "asc" }
  );
}

/** " ▲" / " ▼" / "" for a <th>'s label, depending on whether it's the active sort column. */
export function sortArrow(sortState, column) {
  if (sortState?.column !== column) return "";
  return sortState.direction === "asc" ? " ▲" : " ▼";
}
