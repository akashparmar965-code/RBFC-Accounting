"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  TARGET_CATEGORIES,
  parseInventoryReorderWorkbook,
  normalizeRows,
  attachStoreAttributes,
  buildCatalog,
  filterRows,
  aggregateByUpc,
  summaryStats,
  topByMetric,
  parseQuantityWorkbook,
  normalizeQuantityRows,
  buildOnHandByStoreUpc,
  mergeOnHandIntoReorderRows,
  buildUpcReference,
  buildOnHandCatalogRows,
  aggregateOnHandByUpc,
  onHandSummaryStats,
} from "@/lib/inventoryOrderingProcessor";
import { buildStoreNameMap } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";
import { sharedPageStyles } from "@/lib/pageStyles";

const TARGET_CATEGORIES_LOWER = new Set(TARGET_CATEGORIES.map((c) => c.toLowerCase()));

const STATUS_STYLE = {
  Stockout: { background: "var(--danger-bg)", color: "var(--danger)" },
  Low: { background: "var(--warn-bg)", color: "var(--warn-text)" },
  OK: { background: "rgba(34,163,123,0.14)", color: "var(--ledger)" },
  Excess: { background: "rgba(109,106,232,0.14)", color: "var(--accent-purple)" },
  "No sales": { background: "transparent", color: "var(--ink-soft)" },
};

const COLUMNS = [
  { key: "productDesc", label: "Product" },
  { key: "upc", label: "UPC" },
  { key: "category", label: "Category" },
  { key: "storeCount", label: "Stores" },
  { key: "inStock", label: "In Stock" },
  { key: "onOrder", label: "On Order" },
  { key: "transferIn", label: "Transfer In" },
  { key: "sales7", label: "Sales 7D" },
  { key: "sales14", label: "Sales 14D" },
  { key: "sales30", label: "Sales 30D" },
  { key: "avgCost", label: "Avg Cost" },
  { key: "daysOfStock", label: "Days of Stock" },
  { key: "status", label: "Status" },
];

const ONHAND_COLUMNS = [
  { key: "productDesc", label: "Product" },
  { key: "upc", label: "UPC" },
  { key: "category", label: "Category" },
  { key: "storeCount", label: "Stores" },
  { key: "qty", label: "Qty On Hand" },
  { key: "totalCost", label: "Total Value" },
  { key: "avgCost", label: "Avg Cost" },
  { key: "serialTracked", label: "Serial-tracked" },
];

function fmtInt(n) {
  return Number(n || 0).toLocaleString();
}
function fmtMoney(n) {
  return n == null ? "—" : `$${Number(n).toFixed(2)}`;
}
function fmtDays(n) {
  return n == null ? "—" : n.toLocaleString();
}

function parseUpcList(text) {
  return new Set(
    text
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export default function InventoryOrderingPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);

  const [pageTab, setPageTab] = useState("reorder"); // "reorder" | "onhand"

  const [fileName, setFileName] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [normalizedRows, setNormalizedRows] = useState(null); // reorder file, parsed, no ASM yet
  const [reorderAsmRows, setReorderAsmRows] = useState(null); // reorder file + ASM, all categories, In Stock not yet corrected
  const [unmatchedStores, setUnmatchedStores] = useState([]);

  const [quantityFileName, setQuantityFileName] = useState(null);
  const [quantityDragOver, setQuantityDragOver] = useState(false);
  const [quantityError, setQuantityError] = useState("");
  const [quantityNormalizedRows, setQuantityNormalizedRows] = useState(null); // Inventory Quantity by Date file, parsed

  const [rows, setRows] = useState(null); // reorderAsmRows with In Stock replaced by verified on-hand (serial-required) — feeds the Reorder Analysis tab
  const [catalog, setCatalog] = useState(null);

  const [onHandRows, setOnHandRows] = useState(null); // broad on-hand rows (every category, no serial requirement) + ASM attached
  const [onHandCatalog, setOnHandCatalog] = useState(null);

  const [storeMaster, setStoreMaster] = useState(null);
  const [storeMasterError, setStoreMasterError] = useState("");
  const [storeNameMap, setStoreNameMap] = useState({});

  const [selectedCategories, setSelectedCategories] = useState(TARGET_CATEGORIES_LOWER);
  const [storeSearch, setStoreSearch] = useState("");
  const [selectedStores, setSelectedStores] = useState(null); // null = all stores
  const [selectedAsms, setSelectedAsms] = useState(null); // null = all ASMs
  const [productSearch, setProductSearch] = useState("");
  const [upcText, setUpcText] = useState("");
  const [sort, setSort] = useState({ key: "sales30", dir: "desc" });
  const [hover, setHover] = useState(null); // { x, y, row, metric }

  const [ohSelectedCategories, setOhSelectedCategories] = useState(null); // null = all categories
  const [ohStoreSearch, setOhStoreSearch] = useState("");
  const [ohSelectedStores, setOhSelectedStores] = useState(null);
  const [ohSelectedAsms, setOhSelectedAsms] = useState(null);
  const [ohProductSearch, setOhProductSearch] = useState("");
  const [ohSort, setOhSort] = useState({ key: "qty", dir: "desc" });

  const fileInputRef = useRef(null);
  const quantityFileInputRef = useRef(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("stores")
      .select("*")
      .then(({ data, error }) => {
        if (error) setStoreMasterError("Could not load Store Master: " + error.message);
        else setStoreMaster(data || []);
      });
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("store_name_mappings")
      .select("*")
      .then(({ data, error }) => {
        if (error) return;
        setStoreNameMap(buildStoreNameMap(data || []));
      });
  }, [session]);

  // Attach each row's ASM once both the reorder file and Store Master are
  // loaded — whichever arrives second triggers this (order isn't guaranteed).
  useEffect(() => {
    if (!normalizedRows || !storeMaster) return;
    const { rows: annotated, unmatchedStores: unmatched } = attachStoreAttributes(
      normalizedRows,
      storeMaster,
      storeNameMap
    );
    setReorderAsmRows(annotated);
    setUnmatchedStores(unmatched);
    if (unmatched.length) savePendingMappings({ unmatchedStoreNames: unmatched });
  }, [normalizedRows, storeMaster, storeNameMap]);

  // Once the Quantity-by-Date file is also loaded, replace In Stock on the
  // reorder rows with the verified, serial-tracked on-hand count (Retail
  // bin only) — never the reorder file's own In Stock/On Order figures.
  useEffect(() => {
    if (!reorderAsmRows || !quantityNormalizedRows) return;
    const onHandMap = buildOnHandByStoreUpc(quantityNormalizedRows, { requireSerial: true });
    const merged = mergeOnHandIntoReorderRows(reorderAsmRows, onHandMap);
    setRows(merged);
    setCatalog(buildCatalog(merged));
  }, [reorderAsmRows, quantityNormalizedRows]);

  // Broad on-hand browser: every Retail-bin line in the Quantity-by-Date
  // file (serialized or not), classified via the reorder file's UPC ->
  // Category/Product Desc/Avg Cost reference where one exists.
  useEffect(() => {
    if (!quantityNormalizedRows || !storeMaster) return;
    const upcReference = buildUpcReference(reorderAsmRows || []);
    const catalogRowsRaw = buildOnHandCatalogRows(quantityNormalizedRows, upcReference);
    const { rows: annotated } = attachStoreAttributes(catalogRowsRaw, storeMaster, storeNameMap);
    setOnHandRows(annotated);
    setOnHandCatalog(buildCatalog(annotated));
  }, [quantityNormalizedRows, reorderAsmRows, storeMaster, storeNameMap]);

  const processFile = useCallback(async (file) => {
    setError("");
    setNormalizedRows(null);
    setReorderAsmRows(null);
    setRows(null);
    setCatalog(null);
    setUnmatchedStores([]);
    try {
      const buffer = await file.arrayBuffer();
      const raw = parseInventoryReorderWorkbook(buffer);
      if (!raw.length) throw new Error("No rows found in this file.");
      const normalized = normalizeRows(raw);
      if (!normalized.length) throw new Error("No rows with a UPC were found in this file.");
      setNormalizedRows(normalized);
      setSelectedCategories(TARGET_CATEGORIES_LOWER);
      setSelectedStores(null);
      setSelectedAsms(null);
      setProductSearch("");
      setUpcText("");
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  const processQuantityFile = useCallback(async (file) => {
    setQuantityError("");
    setQuantityNormalizedRows(null);
    setRows(null);
    setCatalog(null);
    setOnHandRows(null);
    setOnHandCatalog(null);
    try {
      const buffer = await file.arrayBuffer();
      const raw = parseQuantityWorkbook(buffer);
      if (!raw.length) throw new Error("No rows found in this file.");
      const normalized = normalizeQuantityRows(raw);
      if (!normalized.length) throw new Error("No rows with a UPC were found in this file.");
      setQuantityNormalizedRows(normalized);
    } catch (e) {
      setQuantityError(e.message || String(e));
    }
  }, []);

  function handleFile(file) {
    if (!file) return;
    setFileName(file.name);
    processFile(file);
  }
  function handleFileChange(e) {
    handleFile(e.target.files?.[0]);
  }
  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  }

  function handleQuantityFile(file) {
    if (!file) return;
    setQuantityFileName(file.name);
    processQuantityFile(file);
  }
  function handleQuantityFileChange(e) {
    handleQuantityFile(e.target.files?.[0]);
  }
  function handleQuantityDrop(e) {
    e.preventDefault();
    setQuantityDragOver(false);
    handleQuantityFile(e.dataTransfer.files?.[0]);
  }

  const upcSet = useMemo(() => (upcText.trim() ? parseUpcList(upcText) : null), [upcText]);
  const upcMatchInfo = useMemo(() => {
    if (!upcSet || !catalog) return null;
    let matched = 0;
    const unmatched = [];
    for (const u of upcSet) {
      if (catalog.upcIndex.has(u)) matched += 1;
      else unmatched.push(u);
    }
    return { matched, unmatched };
  }, [upcSet, catalog]);

  const filteredRows = useMemo(() => {
    if (!rows) return [];
    return filterRows(rows, {
      categories: selectedCategories,
      stores: selectedStores,
      asms: selectedAsms,
      upcs: upcSet,
      search: productSearch,
    });
  }, [rows, selectedCategories, selectedStores, selectedAsms, upcSet, productSearch]);

  const aggRows = useMemo(() => aggregateByUpc(filteredRows), [filteredRows]);
  const stats = useMemo(() => summaryStats(aggRows, filteredRows), [aggRows, filteredRows]);

  const sortedAgg = useMemo(() => {
    const list = [...aggRows];
    const { key, dir } = sort;
    list.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let cmp;
      if (typeof av === "string" || typeof bv === "string") {
        cmp = String(av ?? "").localeCompare(String(bv ?? ""));
      } else {
        cmp = (av ?? -Infinity) - (bv ?? -Infinity);
      }
      return dir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [aggRows, sort]);

  const top15 = useMemo(() => topByMetric(aggRows, "sales30", 15), [aggRows]);
  const chartMax = useMemo(
    () => top15.reduce((m, r) => Math.max(m, r.inStock, r.sales30), 0) || 1,
    [top15]
  );

  // Store -> ASM is a fixed 1:1 relationship (from Store Master), so each
  // filter can scope the other's *options*, not just the resulting rows —
  // picking an ASM narrows which stores show up in the Store list, and
  // picking specific stores narrows which ASMs show up in the ASM list.
  const storeAsmMap = useMemo(() => {
    const map = new Map();
    if (!rows) return map;
    for (const r of rows) if (r.store && !map.has(r.store)) map.set(r.store, r.asm);
    return map;
  }, [rows]);

  const storesInAsmScope = useMemo(() => {
    if (!catalog) return [];
    if (!selectedAsms) return catalog.stores;
    return catalog.stores.filter((s) => selectedAsms.has(storeAsmMap.get(s)));
  }, [catalog, selectedAsms, storeAsmMap]);

  const asmsInStoreScope = useMemo(() => {
    if (!catalog) return [];
    if (!selectedStores) return catalog.asms;
    const present = new Set();
    for (const s of selectedStores) {
      const a = storeAsmMap.get(s);
      if (a) present.add(a);
    }
    return catalog.asms.filter((a) => present.has(a));
  }, [catalog, selectedStores, storeAsmMap]);

  const visibleStores = useMemo(() => {
    const q = storeSearch.trim().toLowerCase();
    return q ? storesInAsmScope.filter((s) => s.toLowerCase().includes(q)) : storesInAsmScope;
  }, [storesInAsmScope, storeSearch]);

  function toggleCategory(cat) {
    setSelectedCategories((prev) => {
      const key = cat.toLowerCase();
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function selectAllCategories() {
    setSelectedCategories(new Set(catalog.categories.map((c) => c.toLowerCase())));
  }
  function clearAllCategories() {
    setSelectedCategories(new Set());
  }

  function toggleStore(store) {
    setSelectedStores((prev) => {
      const base = prev ? new Set(prev) : new Set(catalog.stores);
      if (base.has(store)) base.delete(store);
      else base.add(store);
      return base;
    });
  }
  function selectAllStores() {
    setSelectedStores(new Set(storesInAsmScope));
  }
  function clearAllStores() {
    setSelectedStores(new Set());
  }

  function toggleAsm(asm) {
    setSelectedAsms((prev) => {
      const base = prev ? new Set(prev) : new Set(catalog.asms);
      if (base.has(asm)) base.delete(asm);
      else base.add(asm);
      return base;
    });
  }
  function selectAllAsms() {
    setSelectedAsms(new Set(asmsInStoreScope));
  }
  function clearAllAsms() {
    setSelectedAsms(new Set());
  }

  function resetFilters() {
    setSelectedCategories(TARGET_CATEGORIES_LOWER);
    setSelectedStores(null);
    setSelectedAsms(null);
    setProductSearch("");
    setUpcText("");
    setStoreSearch("");
  }
  function toggleSort(key) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }

  // --- On-Hand Inventory tab: same filter/cross-scoping shape as above, own state ---
  const filteredOnHandRows = useMemo(() => {
    if (!onHandRows) return [];
    return filterRows(onHandRows, {
      categories: ohSelectedCategories,
      stores: ohSelectedStores,
      asms: ohSelectedAsms,
      search: ohProductSearch,
    });
  }, [onHandRows, ohSelectedCategories, ohSelectedStores, ohSelectedAsms, ohProductSearch]);

  const ohAggRows = useMemo(() => aggregateOnHandByUpc(filteredOnHandRows), [filteredOnHandRows]);
  const ohStats = useMemo(() => onHandSummaryStats(ohAggRows, filteredOnHandRows), [ohAggRows, filteredOnHandRows]);

  const sortedOnHandAgg = useMemo(() => {
    const list = [...ohAggRows];
    const { key, dir } = ohSort;
    list.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      let cmp;
      if (typeof av === "string" || typeof bv === "string") {
        cmp = String(av ?? "").localeCompare(String(bv ?? ""));
      } else if (typeof av === "boolean" || typeof bv === "boolean") {
        cmp = (av ? 1 : 0) - (bv ? 1 : 0);
      } else {
        cmp = (av ?? -Infinity) - (bv ?? -Infinity);
      }
      return dir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [ohAggRows, ohSort]);

  const ohStoreAsmMap = useMemo(() => {
    const map = new Map();
    if (!onHandRows) return map;
    for (const r of onHandRows) if (r.store && !map.has(r.store)) map.set(r.store, r.asm);
    return map;
  }, [onHandRows]);

  const ohStoresInAsmScope = useMemo(() => {
    if (!onHandCatalog) return [];
    if (!ohSelectedAsms) return onHandCatalog.stores;
    return onHandCatalog.stores.filter((s) => ohSelectedAsms.has(ohStoreAsmMap.get(s)));
  }, [onHandCatalog, ohSelectedAsms, ohStoreAsmMap]);

  const ohAsmsInStoreScope = useMemo(() => {
    if (!onHandCatalog) return [];
    if (!ohSelectedStores) return onHandCatalog.asms;
    const present = new Set();
    for (const s of ohSelectedStores) {
      const a = ohStoreAsmMap.get(s);
      if (a) present.add(a);
    }
    return onHandCatalog.asms.filter((a) => present.has(a));
  }, [onHandCatalog, ohSelectedStores, ohStoreAsmMap]);

  const ohVisibleStores = useMemo(() => {
    const q = ohStoreSearch.trim().toLowerCase();
    return q ? ohStoresInAsmScope.filter((s) => s.toLowerCase().includes(q)) : ohStoresInAsmScope;
  }, [ohStoresInAsmScope, ohStoreSearch]);

  function ohToggleCategory(cat) {
    setOhSelectedCategories((prev) => {
      const key = cat.toLowerCase();
      const base = prev ? new Set(prev) : new Set(onHandCatalog.categories.map((c) => c.toLowerCase()));
      if (base.has(key)) base.delete(key);
      else base.add(key);
      return base;
    });
  }
  function ohSelectAllCategories() {
    setOhSelectedCategories(new Set(onHandCatalog.categories.map((c) => c.toLowerCase())));
  }
  function ohClearAllCategories() {
    setOhSelectedCategories(new Set());
  }

  function ohToggleStore(store) {
    setOhSelectedStores((prev) => {
      const base = prev ? new Set(prev) : new Set(onHandCatalog.stores);
      if (base.has(store)) base.delete(store);
      else base.add(store);
      return base;
    });
  }
  function ohSelectAllStores() {
    setOhSelectedStores(new Set(ohStoresInAsmScope));
  }
  function ohClearAllStores() {
    setOhSelectedStores(new Set());
  }

  function ohToggleAsm(asm) {
    setOhSelectedAsms((prev) => {
      const base = prev ? new Set(prev) : new Set(onHandCatalog.asms);
      if (base.has(asm)) base.delete(asm);
      else base.add(asm);
      return base;
    });
  }
  function ohSelectAllAsms() {
    setOhSelectedAsms(new Set(ohAsmsInStoreScope));
  }
  function ohClearAllAsms() {
    setOhSelectedAsms(new Set());
  }

  function ohResetFilters() {
    setOhSelectedCategories(null);
    setOhSelectedStores(null);
    setOhSelectedAsms(null);
    setOhProductSearch("");
    setOhStoreSearch("");
  }
  function ohToggleSort(key) {
    setOhSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const storesActiveCount = storesInAsmScope.filter((s) => !selectedStores || selectedStores.has(s)).length;
  const asmsActiveCount = asmsInStoreScope.filter((a) => !selectedAsms || selectedAsms.has(a)).length;

  const ohStoresActiveCount = ohStoresInAsmScope.filter((s) => !ohSelectedStores || ohSelectedStores.has(s)).length;
  const ohAsmsActiveCount = ohAsmsInStoreScope.filter((a) => !ohSelectedAsms || ohSelectedAsms.has(a)).length;
  const ohCategoriesActiveCount = onHandCatalog
    ? onHandCatalog.categories.filter((c) => !ohSelectedCategories || ohSelectedCategories.has(c.toLowerCase())).length
    : 0;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Inventory Ordering</h1>
          <p style={styles.pageSub}>
            Upload both exports below: the Reorder-by-Store file supplies Category, Avg Cost and Sales trend; the
            Quantity-by-Date file supplies verified, serial-tracked current on-hand counts. Stock figures always
            come from the Quantity-by-Date file — never from the Reorder file's own In Stock/On Order.
          </p>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>1. Upload</h2>
          <div style={styles.uploadPairGrid}>
            <div>
              <div style={styles.fieldLabel}>Reorder by Store (reference data)</div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
              <div
                style={{ ...styles.dropzone, ...(dragOver ? styles.dropzoneActive : {}) }}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <div style={styles.dropzoneIcon}>📦</div>
                <div style={styles.dropzoneText}>{fileName || "Choose or drop Inventory Reorder by Store export"}</div>
              </div>
              {reorderAsmRows && !error && (
                <div style={styles.info}>
                  {reorderAsmRows.length.toLocaleString()} SKU/store row(s) loaded.
                </div>
              )}
              {error && <div style={styles.errorBanner}>{error}</div>}
            </div>

            <div>
              <div style={styles.fieldLabel}>Quantity by Date (verified on-hand)</div>
              <input
                ref={quantityFileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleQuantityFileChange}
                style={{ display: "none" }}
              />
              <div
                style={{ ...styles.dropzone, ...(quantityDragOver ? styles.dropzoneActive : {}) }}
                onClick={() => quantityFileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setQuantityDragOver(true);
                }}
                onDragLeave={() => setQuantityDragOver(false)}
                onDrop={handleQuantityDrop}
              >
                <div style={styles.dropzoneIcon}>📥</div>
                <div style={styles.dropzoneText}>{quantityFileName || "Choose or drop Inventory Quantity by Date export"}</div>
              </div>
              {quantityNormalizedRows && !quantityError && (
                <div style={styles.info}>{quantityNormalizedRows.length.toLocaleString()} on-hand line(s) loaded.</div>
              )}
              {quantityError && <div style={styles.errorBanner}>{quantityError}</div>}
            </div>
          </div>

          {storeMasterError && <div style={styles.errorBanner}>{storeMasterError}</div>}
          {unmatchedStores.length > 0 && (
            <div style={styles.warnBanner}>
              {unmatchedStores.length} store name(s) in the Reorder file don't match any store's Elevate Name in
              Store Master, so they show up under "Unmatched store" in the ASM filter instead of a real ASM:{" "}
              <strong>{unmatchedStores.join(", ")}</strong>. Add a mapping on Mapping Master's Store Mapping tab if
              one of these is a rename.
            </div>
          )}
        </div>

        <div style={styles.pageTabRow}>
          <button
            style={{ ...styles.pageTabBtn, ...(pageTab === "reorder" ? styles.pageTabBtnActive : {}) }}
            onClick={() => setPageTab("reorder")}
          >
            Reorder Analysis
          </button>
          <button
            style={{ ...styles.pageTabBtn, ...(pageTab === "onhand" ? styles.pageTabBtnActive : {}) }}
            onClick={() => setPageTab("onhand")}
          >
            On-Hand Inventory
          </button>
        </div>

        {pageTab === "reorder" && !(rows && catalog) && (
          <div style={styles.card}>
            <div style={styles.info}>
              {reorderAsmRows && quantityNormalizedRows
                ? "Building the reorder view…"
                : "Upload both files above to see reorder analysis — stock figures need the Quantity-by-Date file to be verified."}
            </div>
          </div>
        )}

        {pageTab === "reorder" && rows && catalog && (
          <>
            <div style={styles.card}>
              <div style={styles.filtersHeader}>
                <h2 style={styles.h2}>2. Filters</h2>
                <button style={styles.secondaryBtn} onClick={resetFilters}>
                  Reset to defaults
                </button>
              </div>

              <div style={styles.filtersGrid}>
                <div style={styles.filterBlock}>
                  <div style={styles.filterBlockHeader}>
                    <span style={styles.fieldLabel}>Categories</span>
                    <span>
                      <button style={styles.linkBtn} onClick={selectAllCategories}>
                        Select all
                      </button>{" "}
                      <button style={styles.linkBtn} onClick={clearAllCategories}>
                        Clear all
                      </button>
                    </span>
                  </div>
                  <div style={styles.checkList}>
                    {catalog.categories.map((c) => (
                      <label key={c} style={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={selectedCategories.has(c.toLowerCase())}
                          onChange={() => toggleCategory(c)}
                        />
                        <span>
                          {c}{" "}
                          <span style={styles.checkCount}>({catalog.categoryCounts.get(c) || 0})</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div style={styles.filterBlock}>
                  <div style={styles.filterBlockHeader}>
                    <span style={styles.fieldLabel}>
                      Stores ({storesActiveCount} of {storesInAsmScope.length}
                      {selectedAsms ? ` — scoped to ${asmsActiveCount} ASM(s)` : ""} selected)
                    </span>
                    <span>
                      <button style={styles.linkBtn} onClick={selectAllStores}>
                        Select all
                      </button>{" "}
                      <button style={styles.linkBtn} onClick={clearAllStores}>
                        Clear all
                      </button>
                    </span>
                  </div>
                  <input
                    style={styles.textInput}
                    placeholder="Search stores…"
                    value={storeSearch}
                    onChange={(e) => setStoreSearch(e.target.value)}
                  />
                  <div style={styles.checkListScroll}>
                    {visibleStores.map((s) => (
                      <label key={s} style={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={selectedStores ? selectedStores.has(s) : true}
                          onChange={() => toggleStore(s)}
                        />
                        <span>{s}</span>
                      </label>
                    ))}
                    {visibleStores.length === 0 && <span style={styles.checkCount}>No stores in the current ASM selection.</span>}
                  </div>
                </div>

                <div style={styles.filterBlock}>
                  <div style={styles.filterBlockHeader}>
                    <span style={styles.fieldLabel}>
                      ASM ({asmsActiveCount} of {asmsInStoreScope.length}
                      {selectedStores ? ` — scoped to selected stores` : ""} selected)
                    </span>
                    <span>
                      <button style={styles.linkBtn} onClick={selectAllAsms}>
                        Select all
                      </button>{" "}
                      <button style={styles.linkBtn} onClick={clearAllAsms}>
                        Clear all
                      </button>
                    </span>
                  </div>
                  <div style={styles.checkListScroll}>
                    {asmsInStoreScope.map((a) => (
                      <label key={a} style={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={selectedAsms ? selectedAsms.has(a) : true}
                          onChange={() => toggleAsm(a)}
                        />
                        <span>{a}</span>
                      </label>
                    ))}
                    {asmsInStoreScope.length === 0 && <span style={styles.checkCount}>No ASMs among the currently selected stores.</span>}
                  </div>
                </div>

                <div style={styles.filterBlock}>
                  <span style={styles.fieldLabel}>Product search</span>
                  <input
                    style={styles.textInput}
                    placeholder="Search product description…"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                  />

                  <span style={{ ...styles.fieldLabel, marginTop: 14 }}>UPC selection (optional)</span>
                  <textarea
                    style={styles.textarea}
                    placeholder="Paste specific UPCs — separated by commas, spaces or new lines — to narrow everything below to just those SKUs."
                    value={upcText}
                    onChange={(e) => setUpcText(e.target.value)}
                    rows={3}
                  />
                  {upcMatchInfo && (
                    <div style={styles.info}>
                      {upcMatchInfo.matched} UPC(s) matched.
                      {upcMatchInfo.unmatched.length > 0 && (
                        <span style={{ color: "var(--warn-text)" }}>
                          {" "}
                          {upcMatchInfo.unmatched.length} not found in this file:{" "}
                          {upcMatchInfo.unmatched.slice(0, 10).join(", ")}
                          {upcMatchInfo.unmatched.length > 10 ? "…" : ""}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={styles.statsGrid}>
              <StatCard label="SKUs in view" value={fmtInt(stats.skuCount)} />
              <StatCard label="Stores in view" value={fmtInt(stats.storeCount)} />
              <StatCard label="Total In Stock (verified, serial-tracked)" value={fmtInt(stats.totalInStock)} />
              <StatCard label="Total On Order (from Reorder file)" value={fmtInt(stats.totalOnOrder)} />
              <StatCard label="Sales — Last 30D" value={fmtInt(stats.totalSales30)} />
              <StatCard label="Stockout (0 in stock, selling)" value={fmtInt(stats.stockoutCount)} tone="danger" />
              <StatCard label="Low (< 14 days of stock)" value={fmtInt(stats.lowCount)} tone="warn" />
              <StatCard label="Excess (> 60 days of stock)" value={fmtInt(stats.excessCount)} tone="purple" />
            </div>

            {top15.length > 0 && (
              <div style={styles.card}>
                <h2 style={styles.h2}>Top 15 SKUs by Sales — Last 30 Days</h2>
                <div style={styles.legendRow}>
                  <span style={styles.legendItem}>
                    <span style={{ ...styles.legendSwatch, background: "var(--ledger)" }} /> In Stock
                  </span>
                  <span style={styles.legendItem}>
                    <span style={{ ...styles.legendSwatch, background: "var(--accent-purple)" }} /> Sales 30D
                  </span>
                </div>
                <div style={styles.chart}>
                  {top15.map((r) => (
                    <div key={r.upc} style={styles.chartRow}>
                      <div style={styles.chartLabel} title={r.productDesc}>
                        <div style={styles.chartLabelName}>{r.productDesc}</div>
                        <div style={styles.chartLabelUpc}>{r.upc}</div>
                      </div>
                      <div style={styles.chartBars}>
                        <BarTrack
                          value={r.inStock}
                          max={chartMax}
                          color="var(--ledger)"
                          onHover={(e) => setHover({ x: e.clientX, y: e.clientY, row: r, metric: "In Stock", value: r.inStock })}
                          onLeave={() => setHover(null)}
                        />
                        <BarTrack
                          value={r.sales30}
                          max={chartMax}
                          color="var(--accent-purple)"
                          onHover={(e) => setHover({ x: e.clientX, y: e.clientY, row: r, metric: "Sales 30D", value: r.sales30 })}
                          onLeave={() => setHover(null)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                {hover && (
                  <div style={{ ...styles.tooltip, left: hover.x + 14, top: hover.y + 14 }}>
                    <div style={styles.tooltipTitle}>{hover.row.productDesc}</div>
                    <div>
                      {hover.metric}: <strong>{fmtInt(hover.value)}</strong>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div style={styles.card}>
              <h2 style={styles.h2}>
                {sortedAgg.length} SKU{sortedAgg.length === 1 ? "" : "s"} in view
              </h2>
              <div style={styles.previewWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {COLUMNS.map((c) => (
                        <th key={c.key} style={styles.th} onClick={() => toggleSort(c.key)}>
                          {c.label}
                          {sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAgg.map((r) => (
                      <tr key={r.upc} style={styles.tr}>
                        <td style={{ ...styles.td, whiteSpace: "normal", minWidth: 200 }}>{r.productDesc}</td>
                        <td style={styles.td}>{r.upc}</td>
                        <td style={styles.td}>{r.category}</td>
                        <td style={styles.td}>{r.storeCount}</td>
                        <td style={styles.td}>{fmtInt(r.inStock)}</td>
                        <td style={styles.td}>{fmtInt(r.onOrder)}</td>
                        <td style={styles.td}>{fmtInt(r.transferIn)}</td>
                        <td style={styles.td}>{fmtInt(r.sales7)}</td>
                        <td style={styles.td}>{fmtInt(r.sales14)}</td>
                        <td style={styles.td}>{fmtInt(r.sales30)}</td>
                        <td style={styles.td}>{fmtMoney(r.avgCost)}</td>
                        <td style={styles.td}>{fmtDays(r.daysOfStock)}</td>
                        <td style={styles.td}>
                          <span style={{ ...styles.statusBadge, ...(STATUS_STYLE[r.status] || {}) }}>{r.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {pageTab === "onhand" && !(onHandRows && onHandCatalog) && (
          <div style={styles.card}>
            <div style={styles.info}>
              Upload the Quantity by Date file above to browse what's currently on hand — every category, not just
              the 6 reorder-target brands. (The Reorder file is optional here; without it, SKUs show as
              "Unclassified" instead of their real category.)
            </div>
          </div>
        )}

        {pageTab === "onhand" && onHandRows && onHandCatalog && (
          <>
            <div style={styles.card}>
              <div style={styles.filtersHeader}>
                <h2 style={styles.h2}>Filters</h2>
                <button style={styles.secondaryBtn} onClick={ohResetFilters}>
                  Reset to defaults
                </button>
              </div>

              <div style={styles.filtersGrid}>
                <div style={styles.filterBlock}>
                  <div style={styles.filterBlockHeader}>
                    <span style={styles.fieldLabel}>
                      Categories ({ohCategoriesActiveCount} of {onHandCatalog.categories.length} selected)
                    </span>
                    <span>
                      <button style={styles.linkBtn} onClick={ohSelectAllCategories}>
                        Select all
                      </button>{" "}
                      <button style={styles.linkBtn} onClick={ohClearAllCategories}>
                        Clear all
                      </button>
                    </span>
                  </div>
                  <div style={styles.checkList}>
                    {onHandCatalog.categories.map((c) => (
                      <label key={c} style={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={ohSelectedCategories ? ohSelectedCategories.has(c.toLowerCase()) : true}
                          onChange={() => ohToggleCategory(c)}
                        />
                        <span>
                          {c} <span style={styles.checkCount}>({onHandCatalog.categoryCounts.get(c) || 0})</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                <div style={styles.filterBlock}>
                  <div style={styles.filterBlockHeader}>
                    <span style={styles.fieldLabel}>
                      Stores ({ohStoresActiveCount} of {ohStoresInAsmScope.length}
                      {ohSelectedAsms ? ` — scoped to ${ohAsmsActiveCount} ASM(s)` : ""} selected)
                    </span>
                    <span>
                      <button style={styles.linkBtn} onClick={ohSelectAllStores}>
                        Select all
                      </button>{" "}
                      <button style={styles.linkBtn} onClick={ohClearAllStores}>
                        Clear all
                      </button>
                    </span>
                  </div>
                  <input
                    style={styles.textInput}
                    placeholder="Search stores…"
                    value={ohStoreSearch}
                    onChange={(e) => setOhStoreSearch(e.target.value)}
                  />
                  <div style={styles.checkListScroll}>
                    {ohVisibleStores.map((s) => (
                      <label key={s} style={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={ohSelectedStores ? ohSelectedStores.has(s) : true}
                          onChange={() => ohToggleStore(s)}
                        />
                        <span>{s}</span>
                      </label>
                    ))}
                    {ohVisibleStores.length === 0 && (
                      <span style={styles.checkCount}>No stores in the current ASM selection.</span>
                    )}
                  </div>
                </div>

                <div style={styles.filterBlock}>
                  <div style={styles.filterBlockHeader}>
                    <span style={styles.fieldLabel}>
                      ASM ({ohAsmsActiveCount} of {ohAsmsInStoreScope.length}
                      {ohSelectedStores ? ` — scoped to selected stores` : ""} selected)
                    </span>
                    <span>
                      <button style={styles.linkBtn} onClick={ohSelectAllAsms}>
                        Select all
                      </button>{" "}
                      <button style={styles.linkBtn} onClick={ohClearAllAsms}>
                        Clear all
                      </button>
                    </span>
                  </div>
                  <div style={styles.checkListScroll}>
                    {ohAsmsInStoreScope.map((a) => (
                      <label key={a} style={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={ohSelectedAsms ? ohSelectedAsms.has(a) : true}
                          onChange={() => ohToggleAsm(a)}
                        />
                        <span>{a}</span>
                      </label>
                    ))}
                    {ohAsmsInStoreScope.length === 0 && (
                      <span style={styles.checkCount}>No ASMs among the currently selected stores.</span>
                    )}
                  </div>
                </div>

                <div style={styles.filterBlock}>
                  <span style={styles.fieldLabel}>Product search</span>
                  <input
                    style={styles.textInput}
                    placeholder="Search product description…"
                    value={ohProductSearch}
                    onChange={(e) => setOhProductSearch(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div style={styles.statsGrid}>
              <StatCard label="SKUs in view" value={fmtInt(ohStats.skuCount)} />
              <StatCard label="Stores in view" value={fmtInt(ohStats.storeCount)} />
              <StatCard label="Total Qty On Hand" value={fmtInt(ohStats.totalQty)} />
              <StatCard label="Total Value On Hand" value={fmtMoney(ohStats.totalValue)} />
            </div>

            <div style={styles.card}>
              <h2 style={styles.h2}>
                {sortedOnHandAgg.length} SKU{sortedOnHandAgg.length === 1 ? "" : "s"} in view
              </h2>
              <div style={styles.previewWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      {ONHAND_COLUMNS.map((c) => (
                        <th key={c.key} style={styles.th} onClick={() => ohToggleSort(c.key)}>
                          {c.label}
                          {ohSort.key === c.key ? (ohSort.dir === "asc" ? " ▲" : " ▼") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedOnHandAgg.map((r) => (
                      <tr key={r.upc} style={styles.tr}>
                        <td style={{ ...styles.td, whiteSpace: "normal", minWidth: 200 }}>{r.productDesc}</td>
                        <td style={styles.td}>{r.upc}</td>
                        <td style={styles.td}>{r.category}</td>
                        <td style={styles.td}>{r.storeCount}</td>
                        <td style={styles.td}>{fmtInt(r.qty)}</td>
                        <td style={styles.td}>{fmtMoney(r.totalCost)}</td>
                        <td style={styles.td}>{fmtMoney(r.avgCost)}</td>
                        <td style={styles.td}>{r.serialTracked ? "Yes" : "No"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, tone }) {
  const toneColor =
    tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn-text)" : tone === "purple" ? "var(--accent-purple)" : "var(--ink)";
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ ...styles.statValue, color: toneColor }}>{value}</div>
    </div>
  );
}

function BarTrack({ value, max, color, onHover, onLeave }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 1.5 : 0) : 0;
  return (
    <div style={styles.barTrack} onMouseMove={onHover} onMouseLeave={onLeave}>
      <div style={{ ...styles.barFill, width: `${pct}%`, background: color }} />
      <span style={styles.barValue}>{value.toLocaleString()}</span>
    </div>
  );
}

const styles = {
  ...sharedPageStyles,

  main: { flex: 1, padding: "36px 44px", maxWidth: 1400 },

  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 14px" },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 780, lineHeight: 1.5 },

  uploadPairGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20, marginBottom: 4 },

  pageTabRow: { display: "flex", gap: 8, marginBottom: 20 },
  pageTabBtn: {
    background: "var(--panel)",
    color: "var(--ink-soft)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: "9px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  pageTabBtnActive: { background: "var(--ledger)", color: "#fff", borderColor: "var(--ledger)" },

  dropzone: {
    border: "1px dashed var(--line)",
    borderRadius: 8,
    padding: "22px 12px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    cursor: "pointer",
    textAlign: "center",
  },
  dropzoneIcon: { fontSize: 22 },
  info: { fontSize: 12.5, color: "var(--ink-soft)", marginTop: 10, lineHeight: 1.5 },
  errorBanner: {
    background: "var(--danger-bg)",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginTop: 12,
    lineHeight: 1.5,
  },
  warnBanner: {
    background: "var(--warn-bg)",
    color: "var(--warn-text)",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginTop: 12,
    lineHeight: 1.5,
  },

  filtersHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  filtersGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 24 },
  filterBlock: { display: "flex", flexDirection: "column", gap: 8 },
  filterBlockHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--ink-soft)",
  },
  checkList: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" },
  checkListScroll: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 160,
    overflowY: "auto",
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: 8,
  },
  checkRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 },
  checkCount: { color: "var(--ink-soft)", fontSize: 11 },
  textInput: {
    padding: "9px 10px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    fontSize: 12.5,
    background: "var(--field)",
    color: "var(--ink)",
  },
  textarea: {
    padding: "9px 10px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    fontSize: 12.5,
    background: "var(--field)",
    color: "var(--ink)",
    fontFamily: "var(--font-mono)",
    resize: "vertical",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--accent-purple)",
    fontSize: 11.5,
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    textAlign: "left",
  },

  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 12,
    marginBottom: 20,
  },
  statCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    padding: "14px 16px",
  },
  statLabel: { fontSize: 10.5, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 },
  statValue: { fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 600, marginTop: 6 },

  legendRow: { display: "flex", gap: 18, marginBottom: 14 },
  legendItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-soft)" },
  legendSwatch: { width: 10, height: 10, borderRadius: 3, display: "inline-block" },

  chart: { display: "flex", flexDirection: "column", gap: 10 },
  chartRow: { display: "flex", alignItems: "center", gap: 14 },
  chartLabel: { width: 260, flexShrink: 0, overflow: "hidden" },
  chartLabelName: {
    fontSize: 12,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  chartLabelUpc: { fontSize: 10.5, color: "var(--ink-soft)", fontFamily: "var(--font-mono)" },
  chartBars: { flex: 1, display: "flex", flexDirection: "column", gap: 2 },
  barTrack: { position: "relative", height: 12, display: "flex", alignItems: "center" },
  barFill: { height: 8, borderRadius: 4, minWidth: 2, transition: "width 0.2s" },
  barValue: { fontSize: 10.5, color: "var(--ink-soft)", marginLeft: 8, fontFamily: "var(--font-mono)" },

  tooltip: {
    position: "fixed",
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
    pointerEvents: "none",
    zIndex: 50,
    maxWidth: 260,
  },
  tooltipTitle: { fontWeight: 600, marginBottom: 4 },

  previewWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    maxHeight: 520,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 11.5 },
  th: {
    textAlign: "left",
    padding: "9px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 9.5,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
    position: "sticky",
    top: 0,
    background: "var(--panel)",
    cursor: "pointer",
  },
  td: {
    padding: "6px 10px",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    whiteSpace: "nowrap",
  },
  statusBadge: {
    padding: "2px 8px",
    borderRadius: 20,
    fontSize: 10.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
};
