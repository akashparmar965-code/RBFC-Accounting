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

/**
 * Distinct categories (target brands first, in the fixed order above, then
 * every other category found in the file sorted by row count descending),
 * distinct stores, and a upc -> {productDesc, category} index for the UPC
 * picker's search/autocomplete.
 */
export function buildCatalog(rows) {
  const categoryCounts = new Map();
  const stores = new Set();
  const upcIndex = new Map();

  for (const r of rows) {
    if (r.category) categoryCounts.set(r.category, (categoryCounts.get(r.category) || 0) + 1);
    if (r.store) stores.add(r.store);
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

  return {
    categories: [...targetOrder, ...otherCategories],
    categoryCounts,
    stores: Array.from(stores).sort(),
    upcIndex,
  };
}

/**
 * @param {Array} rows - normalized rows
 * @param {Object} filters
 * @param {Set<string>|null} filters.categories - lowercased category names, null = all
 * @param {Set<string>|null} filters.stores - exact store names, null = all
 * @param {Set<string>|null} filters.upcs - exact UPCs, null = all
 * @param {string} filters.search - substring match on Product Desc, case-insensitive
 */
export function filterRows(rows, filters = {}) {
  const { categories, stores, upcs, search } = filters;
  const searchLower = search ? search.trim().toLowerCase() : "";

  return rows.filter((r) => {
    if (categories && !categories.has(r.category.toLowerCase())) return false;
    if (stores && !stores.has(r.store)) return false;
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
