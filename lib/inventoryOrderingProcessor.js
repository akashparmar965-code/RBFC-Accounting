import * as XLSX from "xlsx";

// The 6 device brands the user wants surfaced by default for reorder
// decisions. Matched case-insensitively — the source file mixes casing
// ("Samsung" vs "SAMSUNG") for the same brand.
export const TARGET_CATEGORIES = ["Apple", "Quality One", "Samsung", "Motorola", "Google", "Tcl"];
const TARGET_CATEGORIES_LOWER = new Set(TARGET_CATEGORIES.map((c) => c.toLowerCase()));

function str(v) {
  return v == null ? "" : String(v).trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Parse an "Inventory Reorder by Store" export (xlsx) — one row per store/SKU. */
export function parseInventoryReorderWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

export function normalizeRows(rawRows) {
  return rawRows
    .map((r) => ({
      store: str(r["Store"]),
      dealerCode: str(r["Dealer Code"]),
      category: str(r["Category"]),
      productId: str(r["Product ID"]),
      eol: str(r["EOL"]),
      productDesc: str(r["Product Desc"]),
      avgCost: num(r["Avg Cost"]),
      inStock: num(r["In Stock"]),
      onOrder: num(r["On Order"]),
      transferIn: num(r["Transfer In"]),
      reorder: num(r["Reorder"]),
      minQty: num(r["Min Qty"]),
      avgDay: num(r["Avg/Day"]),
      avgWeek: num(r["Avg/Week"]),
      sales7: num(r["Sales 7D"]),
      sales14: num(r["Sales 14D"]),
      sales30: num(r["Sales Last 30 Days"]),
      upc: str(r["UPC"]),
    }))
    .filter((r) => r.upc);
}

export function isTargetCategory(category) {
  return TARGET_CATEGORIES_LOWER.has(String(category || "").trim().toLowerCase());
}

// The Quantity-by-Date export's "Bin" values include real sellable stock
// (Retail) alongside non-sellable/adjustment states (RMA, DEMO, Transit,
// <Negative Stock>, PAD bins, Ineligibles) — only Retail counts as stock
// actually in hand. Confirmed against a real file: summing Retail-bin Qty
// by Store+UPC reproduces the Reorder-by-Store file's own In Stock number
// almost exactly (2,518 vs 2,520 units across 1,219 real store/SKU rows).
export const SELLABLE_BIN = "Retail";

/** Parse an "Inventory Quantity by Date" export (xlsx) — one row per on-hand line, some serialized (Serial 1 populated), most accessories not. */
export function parseQuantityWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

export function normalizeQuantityRows(rawRows) {
  return rawRows
    .map((r) => ({
      store: str(r["Store"]),
      vendor: str(r["Vendor"]),
      bin: str(r["Bin"]),
      productId: str(r["Product ID"]),
      productDescFull: str(r["Product Desc Full"]),
      serial: str(r["Serial 1"]),
      qty: num(r["Qty"]),
      totalCost: num(r["Total Cost"]),
      upc: str(r["UPC"]),
    }))
    .filter((r) => r.upc);
}

/**
 * Sum Retail-bin Qty/Total Cost by Store+UPC — the verified current
 * on-hand count. `requireSerial: true` (used for the reorder-decision view)
 * additionally drops lines with no Serial 1, since an un-serialized line
 * under a device category isn't a trackable unit worth reordering against.
 */
export function buildOnHandByStoreUpc(quantityRows, { requireSerial = false } = {}) {
  const map = new Map();
  for (const r of quantityRows) {
    if (r.bin !== SELLABLE_BIN) continue;
    if (requireSerial && !r.serial) continue;
    const key = r.store + "||" + r.upc;
    let agg = map.get(key);
    if (!agg) {
      agg = { qty: 0, totalCost: 0, lineCount: 0 };
      map.set(key, agg);
    }
    agg.qty += r.qty;
    agg.totalCost += r.totalCost;
    agg.lineCount += 1;
  }
  return map;
}

/** Replace each reorder row's `inStock` with the verified on-hand count for that Store+UPC (0 if the Quantity-by-Date file has nothing there — it's a full snapshot, so "absent" genuinely means zero). On Order/Transfer In/Reorder/Min Qty/Sales figures are left untouched — they still come from the Reorder-by-Store file since Quantity-by-Date doesn't carry them. */
export function mergeOnHandIntoReorderRows(reorderRows, onHandByStoreUpc) {
  return reorderRows.map((r) => {
    const onHand = onHandByStoreUpc.get(r.store + "||" + r.upc);
    return { ...r, inStock: onHand ? onHand.qty : 0 };
  });
}

/** upc -> {category, productDesc, avgCost} from the Reorder-by-Store file's full row set (every category, not just the 6 targets) — lets the on-hand browser classify UPCs the Quantity-by-Date file itself has no Category column for. */
export function buildUpcReference(reorderRows) {
  const map = new Map();
  for (const r of reorderRows) {
    if (r.upc && !map.has(r.upc)) {
      map.set(r.upc, { category: r.category, productDesc: r.productDesc, avgCost: r.avgCost });
    }
  }
  return map;
}

export const UNCLASSIFIED_CATEGORY = "Unclassified";

/** One row per Store+UPC of Retail-bin on-hand stock (serialized or not — the broad "what's available" browser, unlike the reorder-decision view, doesn't require a serial), classified via the Reorder file's UPC reference where possible. */
export function buildOnHandCatalogRows(quantityRows, upcReference) {
  const rows = [];
  for (const r of quantityRows) {
    if (r.bin !== SELLABLE_BIN) continue;
    const ref = upcReference.get(r.upc);
    rows.push({
      store: r.store,
      upc: r.upc,
      productDesc: ref && ref.productDesc ? ref.productDesc : r.productDescFull,
      category: ref && ref.category ? ref.category : UNCLASSIFIED_CATEGORY,
      avgCost: ref && ref.avgCost ? ref.avgCost : r.qty ? round2(r.totalCost / r.qty) : 0,
      qty: r.qty,
      totalCost: r.totalCost,
      hasSerial: !!r.serial,
      vendor: r.vendor,
    });
  }
  return rows;
}

/** Collapse on-hand rows into one line per UPC across whichever stores are in scope. */
export function aggregateOnHandByUpc(rows) {
  const byUpc = new Map();

  for (const r of rows) {
    let agg = byUpc.get(r.upc);
    if (!agg) {
      agg = {
        upc: r.upc,
        productDesc: r.productDesc,
        category: r.category,
        stores: new Set(),
        qty: 0,
        totalCost: 0,
        serialCount: 0,
        lineCount: 0,
        avgCost: r.avgCost,
      };
      byUpc.set(r.upc, agg);
    }
    if (r.store) agg.stores.add(r.store);
    agg.qty += r.qty;
    agg.totalCost += r.totalCost;
    agg.lineCount += 1;
    if (r.hasSerial) agg.serialCount += 1;
    if (!agg.avgCost && r.avgCost) agg.avgCost = r.avgCost;
    if (!agg.productDesc && r.productDesc) agg.productDesc = r.productDesc;
  }

  return Array.from(byUpc.values())
    .map((agg) => ({
      upc: agg.upc,
      productDesc: agg.productDesc,
      category: agg.category,
      storeCount: agg.stores.size,
      qty: agg.qty,
      totalCost: round2(agg.totalCost),
      avgCost: agg.avgCost,
      serialTracked: agg.serialCount > 0,
    }))
    .sort((a, b) => b.qty - a.qty);
}

export function onHandSummaryStats(aggRows, filteredRows) {
  const storeSet = new Set(filteredRows.map((r) => r.store).filter(Boolean));
  return {
    skuCount: aggRows.length,
    storeCount: storeSet.size,
    totalQty: aggRows.reduce((s, r) => s + r.qty, 0),
    totalValue: round2(aggRows.reduce((s, r) => s + r.totalCost, 0)),
  };
}

// Sentinel ASM labels — kept distinct so the filter can tell "this store
// really has no ASM in Store Master" apart from "this store isn't in Store
// Master at all" instead of lumping both into one bucket.
export const UNASSIGNED_ASM = "Unassigned";
export const UNMATCHED_ASM = "Unmatched store";

/**
 * Look up each row's Store against Store Master (falling back to
 * `store_name_mappings`, same convention every other upload page uses) and
 * attach an `asm` field — the real ASM name, `UNASSIGNED_ASM` if the store
 * matched but has no ASM set, or `UNMATCHED_ASM` if the store isn't in
 * Store Master at all (even after the rename fallback).
 */
export function attachStoreAttributes(rows, storeMaster, storeNameMap = {}) {
  const elevateMap = new Map();
  for (const s of storeMaster || []) {
    const elevateName = s.elevate_name ? String(s.elevate_name).trim() : "";
    if (!elevateName) continue;
    elevateMap.set(elevateName, s.asm ? String(s.asm).trim() : "");
  }

  const unmatchedStores = new Set();
  const annotated = rows.map((r) => {
    const mapped = storeNameMap[r.store] || r.store;
    if (!elevateMap.has(mapped)) {
      if (r.store) unmatchedStores.add(r.store);
      return { ...r, asm: UNMATCHED_ASM };
    }
    const asm = elevateMap.get(mapped);
    return { ...r, asm: asm || UNASSIGNED_ASM };
  });

  return { rows: annotated, unmatchedStores: Array.from(unmatchedStores) };
}

/**
 * Distinct categories (target brands first, in the fixed order above, then
 * every other category found in the file sorted by row count descending),
 * distinct stores, distinct ASMs (real names first, `UNASSIGNED_ASM`/
 * `UNMATCHED_ASM` sorted last), and a upc -> {productDesc, category} index
 * for the UPC picker's search/autocomplete.
 */
export function buildCatalog(rows) {
  const categoryCounts = new Map();
  const stores = new Set();
  const asms = new Set();
  const upcIndex = new Map();

  for (const r of rows) {
    if (r.category) categoryCounts.set(r.category, (categoryCounts.get(r.category) || 0) + 1);
    if (r.store) stores.add(r.store);
    if (r.asm) asms.add(r.asm);
    if (r.upc && !upcIndex.has(r.upc)) {
      upcIndex.set(r.upc, { upc: r.upc, productDesc: r.productDesc, category: r.category });
    }
  }

  const targetOrder = TARGET_CATEGORIES.filter((c) =>
    Array.from(categoryCounts.keys()).some((k) => k.toLowerCase() === c.toLowerCase())
  );
  const targetLower = new Set(targetOrder.map((c) => c.toLowerCase()));
  const otherCategories = Array.from(categoryCounts.entries())
    .filter(([name]) => !targetLower.has(name.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  const sentinelRank = { [UNASSIGNED_ASM]: 1, [UNMATCHED_ASM]: 2 };
  const asmList = Array.from(asms).sort((a, b) => {
    const ra = sentinelRank[a] || 0;
    const rb = sentinelRank[b] || 0;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  return {
    categories: [...targetOrder, ...otherCategories],
    categoryCounts,
    stores: Array.from(stores).sort(),
    asms: asmList,
    upcIndex,
  };
}

/**
 * @param {Array} rows - normalized rows
 * @param {Object} filters
 * @param {Set<string>|null} filters.categories - lowercased category names, null = all
 * @param {Set<string>|null} filters.stores - exact store names, null = all
 * @param {Set<string>|null} filters.asms - exact ASM labels (incl. UNASSIGNED_ASM/UNMATCHED_ASM), null = all
 * @param {Set<string>|null} filters.upcs - exact UPCs, null = all
 * @param {string} filters.search - substring match on Product Desc, case-insensitive
 */
export function filterRows(rows, filters = {}) {
  const { categories, stores, asms, upcs, search } = filters;
  const searchLower = search ? search.trim().toLowerCase() : "";

  return rows.filter((r) => {
    if (categories && !categories.has(r.category.toLowerCase())) return false;
    if (stores && !stores.has(r.store)) return false;
    if (asms && !asms.has(r.asm)) return false;
    if (upcs && !upcs.has(r.upc)) return false;
    if (searchLower && !r.productDesc.toLowerCase().includes(searchLower)) return false;
    return true;
  });
}

function computeStatus(inStock, sales30, daysOfStock) {
  if (inStock <= 0 && sales30 > 0) return "Stockout";
  if (sales30 <= 0) return "No sales";
  if (daysOfStock != null && daysOfStock < 14) return "Low";
  if (daysOfStock != null && daysOfStock > 60) return "Excess";
  return "OK";
}

/** Collapse per-store rows into one line per UPC across whatever rows were passed in (already filtered to the scope/stores the user wants summed). */
export function aggregateByUpc(rows) {
  const byUpc = new Map();

  for (const r of rows) {
    let agg = byUpc.get(r.upc);
    if (!agg) {
      agg = {
        upc: r.upc,
        productDesc: r.productDesc,
        category: r.category,
        stores: new Set(),
        inStock: 0,
        onOrder: 0,
        transferIn: 0,
        reorder: 0,
        minQty: 0,
        sales7: 0,
        sales14: 0,
        sales30: 0,
        avgCost: r.avgCost,
      };
      byUpc.set(r.upc, agg);
    }
    if (r.store) agg.stores.add(r.store);
    agg.inStock += r.inStock;
    agg.onOrder += r.onOrder;
    agg.transferIn += r.transferIn;
    agg.reorder += r.reorder;
    agg.minQty += r.minQty;
    agg.sales7 += r.sales7;
    agg.sales14 += r.sales14;
    agg.sales30 += r.sales30;
    if (!agg.avgCost && r.avgCost) agg.avgCost = r.avgCost;
    if (!agg.productDesc && r.productDesc) agg.productDesc = r.productDesc;
  }

  return Array.from(byUpc.values())
    .map((agg) => {
      const daysOfStock = agg.sales30 > 0 ? round1(agg.inStock / (agg.sales30 / 30)) : null;
      return {
        upc: agg.upc,
        productDesc: agg.productDesc,
        category: agg.category,
        storeCount: agg.stores.size,
        inStock: agg.inStock,
        onOrder: agg.onOrder,
        transferIn: agg.transferIn,
        reorder: agg.reorder,
        minQty: agg.minQty,
        sales7: agg.sales7,
        sales14: agg.sales14,
        sales30: agg.sales30,
        avgCost: agg.avgCost,
        daysOfStock,
        status: computeStatus(agg.inStock, agg.sales30, daysOfStock),
      };
    })
    .sort((a, b) => b.sales30 - a.sales30);
}

export function summaryStats(aggRows, filteredRawRows) {
  const storeSet = new Set(filteredRawRows.map((r) => r.store).filter(Boolean));
  return {
    skuCount: aggRows.length,
    storeCount: storeSet.size,
    totalInStock: aggRows.reduce((s, r) => s + r.inStock, 0),
    totalOnOrder: aggRows.reduce((s, r) => s + r.onOrder, 0),
    totalSales30: aggRows.reduce((s, r) => s + r.sales30, 0),
    stockoutCount: aggRows.filter((r) => r.status === "Stockout").length,
    lowCount: aggRows.filter((r) => r.status === "Low").length,
    excessCount: aggRows.filter((r) => r.status === "Excess").length,
  };
}

export function topByMetric(aggRows, metric, n = 15) {
  return [...aggRows].sort((a, b) => b[metric] - a[metric]).slice(0, n);
}
