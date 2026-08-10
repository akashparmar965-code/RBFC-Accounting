"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  TARGET_CATEGORIES,
  parseInventoryReorderWorkbook,
  normalizeRows,
  buildCatalog,
  filterRows,
  aggregateByUpc,
  summaryStats,
  topByMetric,
} from "@/lib/inventoryOrderingProcessor";
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

  const [fileName, setFileName] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState(null); // normalized rows
  const [catalog, setCatalog] = useState(null);

  const [selectedCategories, setSelectedCategories] = useState(TARGET_CATEGORIES_LOWER);
  const [storeSearch, setStoreSearch] = useState("");
  const [selectedStores, setSelectedStores] = useState(null); // null = all stores
  const [productSearch, setProductSearch] = useState("");
  const [upcText, setUpcText] = useState("");
  const [sort, setSort] = useState({ key: "sales30", dir: "desc" });
  const [hover, setHover] = useState(null); // { x, y, row, metric }

  const fileInputRef = useRef(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  const processFile = useCallback(async (file) => {
    setError("");
    setRows(null);
    setCatalog(null);
    try {
      const buffer = await file.arrayBuffer();
      const raw = parseInventoryReorderWorkbook(buffer);
      if (!raw.length) throw new Error("No rows found in this file.");
      const normalized = normalizeRows(raw);
      if (!normalized.length) throw new Error("No rows with a UPC were found in this file.");
      const cat = buildCatalog(normalized);
      setRows(normalized);
      setCatalog(cat);
      setSelectedCategories(TARGET_CATEGORIES_LOWER);
      setSelectedStores(null);
      setProductSearch("");
      setUpcText("");
    } catch (e) {
      setError(e.message || String(e));
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
      upcs: upcSet,
      search: productSearch,
    });
  }, [rows, selectedCategories, selectedStores, upcSet, productSearch]);

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

  const visibleStores = useMemo(() => {
    if (!catalog) return [];
    const q = storeSearch.trim().toLowerCase();
    return q ? catalog.stores.filter((s) => s.toLowerCase().includes(q)) : catalog.stores;
  }, [catalog, storeSearch]);

  function toggleCategory(cat) {
    setSelectedCategories((prev) => {
      const key = cat.toLowerCase();
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleStore(store) {
    setSelectedStores((prev) => {
      const base = prev ? new Set(prev) : new Set(catalog.stores);
      if (base.has(store)) base.delete(store);
      else base.add(store);
      return base;
    });
  }
  function resetFilters() {
    setSelectedCategories(TARGET_CATEGORIES_LOWER);
    setSelectedStores(null);
    setProductSearch("");
    setUpcText("");
    setStoreSearch("");
  }
  function toggleSort(key) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const storesActiveCount = selectedStores ? selectedStores.size : catalog?.stores.length ?? 0;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Inventory Ordering</h1>
          <p style={styles.pageSub}>
            Upload an Inventory Reorder by Store export to see stock, on-order, and recent sales by SKU —
            filtered to Apple, Quality One, Samsung, Motorola, Google and TCL by default, with the option to
            widen to any category in the file. For deciding what to reorder, not for booking any entry.
          </p>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>1. Upload</h2>
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
          {rows && !error && (
            <div style={styles.info}>
              {rows.length.toLocaleString()} SKU/store row(s) loaded · {catalog.stores.length} stores ·{" "}
              {catalog.upcIndex.size.toLocaleString()} distinct UPCs.
            </div>
          )}
          {error && <div style={styles.errorBanner}>{error}</div>}
        </div>

        {rows && catalog && (
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
                  <span style={styles.fieldLabel}>Categories</span>
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
                  <span style={styles.fieldLabel}>
                    Stores ({storesActiveCount} of {catalog.stores.length} selected)
                  </span>
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
                  </div>
                  {selectedStores && (
                    <button style={styles.linkBtn} onClick={() => setSelectedStores(null)}>
                      Clear store filter (show all)
                    </button>
                  )}
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
              <StatCard label="Total In Stock" value={fmtInt(stats.totalInStock)} />
              <StatCard label="Total On Order" value={fmtInt(stats.totalOnOrder)} />
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
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 760, lineHeight: 1.5 },

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

  filtersHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  filtersGrid: { display: "grid", gridTemplateColumns: "1fr 1fr 1.2fr", gap: 24 },
  filterBlock: { display: "flex", flexDirection: "column", gap: 8 },
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
