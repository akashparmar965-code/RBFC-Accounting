// Carries unmatched-door/unmapped-product/unmatched-account/unmatched-
// store-name results from an upload over to the Mapping Master page, so
// they don't vanish when you navigate away to go fix them. Lives in
// sessionStorage (survives page navigation within the tab) and is
// explicitly cleared on sign-out.
const KEY = "rbfc_pending_mappings";

const EMPTY = { unmatchedDoors: [], unmappedProducts: [], unmatchedAccounts: [], unmatchedStoreNames: [] };

function isBrowser() {
  return typeof window !== "undefined";
}

export function loadPendingMappings() {
  if (!isBrowser()) return { ...EMPTY };
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    return {
      unmatchedDoors: Array.isArray(parsed.unmatchedDoors) ? parsed.unmatchedDoors : [],
      unmappedProducts: Array.isArray(parsed.unmappedProducts) ? parsed.unmappedProducts : [],
      unmatchedAccounts: Array.isArray(parsed.unmatchedAccounts) ? parsed.unmatchedAccounts : [],
      unmatchedStoreNames: Array.isArray(parsed.unmatchedStoreNames) ? parsed.unmatchedStoreNames : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

function save(data) {
  if (!isBrowser()) return;
  window.sessionStorage.setItem(KEY, JSON.stringify(data));
}

/** Merge new unmatched doors / unmapped products / unmatched accounts / unmatched store names in from a fresh upload. */
export function savePendingMappings({ unmatchedDoors = [], unmappedProducts = [], unmatchedAccounts = [], unmatchedStoreNames = [] }) {
  if (!isBrowser()) return;
  const existing = loadPendingMappings();
  const doors = Array.from(new Set([...existing.unmatchedDoors, ...unmatchedDoors]));
  const accounts = Array.from(new Set([...existing.unmatchedAccounts, ...unmatchedAccounts]));
  const storeNames = Array.from(new Set([...existing.unmatchedStoreNames, ...unmatchedStoreNames]));

  const productKey = (p) => `${p.doorNumber}||${p.invoiceNo}||${p.product}`;
  const productMap = new Map(existing.unmappedProducts.map((p) => [productKey(p), p]));
  for (const p of unmappedProducts) productMap.set(productKey(p), p);

  save({
    unmatchedDoors: doors,
    unmappedProducts: Array.from(productMap.values()),
    unmatchedAccounts: accounts,
    unmatchedStoreNames: storeNames,
  });
}

export function removePendingDoor(doorNumber) {
  if (!isBrowser()) return;
  const existing = loadPendingMappings();
  save({
    ...existing,
    unmatchedDoors: existing.unmatchedDoors.filter((d) => d !== doorNumber),
  });
}

export function removePendingAccount(accountNumber) {
  if (!isBrowser()) return;
  const existing = loadPendingMappings();
  save({
    ...existing,
    unmatchedAccounts: existing.unmatchedAccounts.filter((a) => a !== accountNumber),
  });
}

export function removePendingStoreName(storeName) {
  if (!isBrowser()) return;
  const existing = loadPendingMappings();
  save({
    ...existing,
    unmatchedStoreNames: existing.unmatchedStoreNames.filter((s) => s !== storeName),
  });
}

/** Drop any pending unmapped products whose text starts with the prefix just mapped. */
export function removePendingProductsMatching(prefix) {
  if (!isBrowser()) return;
  const existing = loadPendingMappings();
  const lower = prefix.toLowerCase();
  save({
    ...existing,
    unmappedProducts: existing.unmappedProducts.filter((p) => !p.product.toLowerCase().startsWith(lower)),
  });
}

export function clearPendingMappings() {
  if (!isBrowser()) return;
  window.sessionStorage.removeItem(KEY);
}
