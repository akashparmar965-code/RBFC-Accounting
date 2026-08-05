"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  parseInventorySnapshotWorkbook,
  parseTransferWorkbook,
  buildInventoryFlowReport,
  rowsToCsvGeneric,
} from "@/lib/inventoryFlowProcessor";
import { parseSalesWorkbook } from "@/lib/salesProcessor";
import { triggerDownload, todayIso } from "@/lib/download";
import { savePageState, loadPageState } from "@/lib/pageState";
import { sharedPageStyles } from "@/lib/pageStyles";

const STATE_KEY = "inventory-flow";
const CSV_MIME = "text/csv;charset=utf-8;";

const SLOTS = [
  {
    key: "opening",
    label: "Opening Inventory",
    hint: "Inventory Quantity by Date export — start of month",
    parser: "snapshot",
    requiredCol: "Serial 1",
    required: true,
  },
  {
    key: "closing",
    label: "Closing Inventory",
    hint: "Inventory Quantity by Date export — end of month",
    parser: "snapshot",
    requiredCol: "Serial 1",
    required: true,
  },
  {
    key: "poReceiving",
    label: "Purchase Order Receiving",
    hint: "Optional — new stock received this month",
    parser: "transfer",
    requiredCol: "Serial #",
    required: false,
  },
  {
    key: "shipment",
    label: "Store Transfer Shipment",
    hint: "Optional — devices shipped out to another store",
    parser: "transfer",
    requiredCol: "Serial #",
    required: false,
  },
  {
    key: "receiving",
    label: "Store Transfer Receiving",
    hint: "Optional — devices received from another store",
    parser: "transfer",
    requiredCol: "Serial #",
    required: false,
  },
  {
    key: "sales",
    label: "Sales",
    hint: "Bookkeeping Sale Details export — Sale/Return/Exchange lines",
    parser: "sales",
    requiredCol: "Serial 1",
    required: true,
  },
];

function formatCell(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v == null ? "" : String(v);
}

function buildFlatSections(result) {
  if (!result) return [];

  const missingFlat = result.missing.map((m) => ({
    Serial: m.serial,
    Product: m.productDesc,
    "Last Known Store": m.lastKnownStore || "",
    Timeline: m.events
      .map((e) => `${e.type}@${e.store || "-"}${e.date ? " " + formatCell(e.date) : ""}`)
      .join(" → "),
  }));

  const inTransitFlat = result.inTransit.map((t) => ({
    Serial: t.serial,
    Product: t.productDesc,
    From: t.from || "",
    To: t.to || "",
    "Shipped Date": formatCell(t.shippedDate),
  }));

  const storeMismatchFlat = result.storeMismatch.map((m) => ({
    Serial: m.serial,
    Product: m.productDesc,
    "Expected Store": m.expectedStore || "",
    "Found Store": m.foundStore || "",
  }));

  const unexplainedNewFlat = result.unexplainedNew.map((u) => ({
    Serial: u.serial,
    Product: u.productDesc,
    Store: u.store || "",
    Note: u.note || "",
  }));

  const soldAnomaliesFlat = result.soldAnomalies.map((a) => ({
    Serial: a.serial,
    Product: a.productDesc,
    Store: a.store || "",
    Note: a.note || "",
  }));

  const flowByRouteFlat = result.flowByRoute
    .slice()
    .sort((a, b) => b.serialCount - a.serialCount)
    .map((r) => ({
      From: r.from || "",
      To: r.to || "",
      Type: r.kind,
      "Serial Count": r.serialCount,
      "Line Count": r.lineCount,
      "Total Ext Cost": r.totalExtCost,
    }));

  return [
    {
      key: "missing",
      title: "Missing",
      desc: "Known this month (Opening / Purchase / Transfer-in) but not sold, not found in Closing Inventory, and not explained by an outstanding shipment.",
      rows: missingFlat,
      severe: true,
    },
    {
      key: "storeMismatch",
      title: "Store Mismatch",
      desc: "Found in Closing Inventory at a different store than expected.",
      rows: storeMismatchFlat,
      severe: true,
    },
    {
      key: "soldAnomalies",
      title: "Sold Anomalies",
      desc: "Sold this period but still appears in Closing Inventory — data inconsistency to check.",
      rows: soldAnomaliesFlat,
      severe: true,
    },
    {
      key: "inTransit",
      title: "In Transit",
      desc: "Shipped out (Store Transfer Shipment) but not yet confirmed received this period.",
      rows: inTransitFlat,
      severe: false,
    },
    {
      key: "unexplainedNew",
      title: "Unexplained New",
      desc: "Appeared in Sales or Closing Inventory with no Opening/Purchase/Transfer-in record this month — informational, likely sourced outside these files.",
      rows: unexplainedNewFlat,
      severe: false,
    },
    {
      key: "flowByRoute",
      title: "Transfer & Purchase Flow",
      desc: "Volume moved this month by route (serial counts + dollar totals).",
      rows: flowByRouteFlat,
      severe: false,
    },
  ];
}

export default function InventoryFlowPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;

  const [fileMeta, setFileMeta] = useState(saved?.fileMeta ?? {});
  const [dragOverKey, setDragOverKey] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(saved?.result ?? null);
  const [openSections, setOpenSections] = useState(new Set(saved?.openSections ?? ["missing", "storeMismatch", "soldAnomalies"]));

  const rowsRef = useRef({});
  const fileInputRefs = useRef({});

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  useEffect(() => {
    savePageState(STATE_KEY, { fileMeta, result, openSections: Array.from(openSections) });
  }, [fileMeta, result, openSections]);

  const handleSlotFile = useCallback(async (slot, file) => {
    if (!file) return;
    setError("");
    setFileMeta((prev) => ({ ...prev, [slot.key]: { fileName: file.name, error: "", rowCount: null } }));
    try {
      const buffer = await file.arrayBuffer();
      let rows;
      if (slot.parser === "snapshot") rows = parseInventorySnapshotWorkbook(buffer);
      else if (slot.parser === "transfer") rows = parseTransferWorkbook(buffer);
      else rows = parseSalesWorkbook(buffer);

      if (!rows.length) throw new Error("No rows found in this file.");
      if (!(slot.requiredCol in rows[0])) {
        throw new Error(`This file doesn't look right — no "${slot.requiredCol}" column found.`);
      }

      rowsRef.current[slot.key] = rows;
      setFileMeta((prev) => ({ ...prev, [slot.key]: { fileName: file.name, error: "", rowCount: rows.length } }));
    } catch (e) {
      rowsRef.current[slot.key] = null;
      setFileMeta((prev) => ({
        ...prev,
        [slot.key]: { fileName: file.name, error: e.message || String(e), rowCount: null },
      }));
    }
  }, []);

  function handleDrop(slot, e) {
    e.preventDefault();
    setDragOverKey(null);
    handleSlotFile(slot, e.dataTransfer.files?.[0]);
  }

  function runAnalysis() {
    setError("");
    setResult(null);
    const missingRequired = SLOTS.filter((s) => s.required && !rowsRef.current[s.key]);
    if (missingRequired.length) {
      setError(`Upload required file(s) first: ${missingRequired.map((s) => s.label).join(", ")}.`);
      return;
    }
    setProcessing(true);
    try {
      const report = buildInventoryFlowReport({
        openingRows: rowsRef.current.opening || [],
        closingRows: rowsRef.current.closing || [],
        poReceivingRows: rowsRef.current.poReceiving || [],
        shipmentRows: rowsRef.current.shipment || [],
        receivingRows: rowsRef.current.receiving || [],
        salesRows: rowsRef.current.sales || [],
      });
      setResult(report);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setProcessing(false);
    }
  }

  function clearAll() {
    rowsRef.current = {};
    setFileMeta({});
    setResult(null);
    setError("");
  }

  function toggleSection(key) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function downloadSectionCsv(section) {
    if (!section.rows.length) return;
    const columns = Object.keys(section.rows[0]);
    triggerDownload(
      new Blob([rowsToCsvGeneric(section.rows, columns)], { type: CSV_MIME }),
      `Inventory-Flow-${section.key}-${todayIso()}.csv`
    );
  }

  async function downloadAllZip() {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const section of sections) {
      if (!section.rows.length) continue;
      const columns = Object.keys(section.rows[0]);
      zip.file(`Inventory-Flow-${section.key}.csv`, rowsToCsvGeneric(section.rows, columns));
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, `Inventory-Flow-${todayIso()}.zip`);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const sections = buildFlatSections(result);
  const anyFileLoaded = Object.values(fileMeta).some((m) => m?.rowCount);

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Inventory Flow</h1>
          <p style={styles.pageSub}>
            Serial-level month-over-month reconciliation — trace every device from Opening Inventory through
            transfers, purchases and sales into Closing Inventory, and flag what doesn't add up.
          </p>
        </div>

        <div style={styles.slotGrid}>
          {SLOTS.map((slot) => {
            const meta = fileMeta[slot.key];
            return (
              <div key={slot.key} style={styles.slotCard}>
                <div style={styles.slotLabel}>
                  {slot.label}
                  {slot.required ? <span style={styles.requiredMark}> *</span> : null}
                </div>
                <div style={styles.slotHint}>{slot.hint}</div>
                <input
                  ref={(el) => (fileInputRefs.current[slot.key] = el)}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => handleSlotFile(slot, e.target.files?.[0])}
                  style={{ display: "none" }}
                />
                <div
                  style={{
                    ...styles.dropzone,
                    ...(dragOverKey === slot.key ? styles.dropzoneActive : {}),
                  }}
                  onClick={() => fileInputRefs.current[slot.key]?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverKey(slot.key);
                  }}
                  onDragLeave={() => setDragOverKey(null)}
                  onDrop={(e) => handleDrop(slot, e)}
                >
                  <div style={styles.dropzoneText}>{meta?.fileName || "Choose or drop file"}</div>
                  {meta?.rowCount ? <div style={styles.slotRowCount}>{meta.rowCount.toLocaleString()} rows loaded</div> : null}
                  {meta?.error ? <div style={styles.slotError}>{meta.error}</div> : null}
                </div>
              </div>
            );
          })}
        </div>

        <div style={styles.actionsRow}>
          <button style={styles.runBtn} onClick={runAnalysis} disabled={processing}>
            {processing ? "Running…" : "Run Analysis"}
          </button>
          {anyFileLoaded && (
            <button style={styles.csvBtnMuted} onClick={clearAll}>
              Clear all
            </button>
          )}
        </div>

        {error && <div style={styles.errorBanner}>{error}</div>}

        {result && (
          <>
            <div style={styles.statsRow}>
              <div style={styles.statChip}>
                <div style={styles.statValue}>{result.stats.totalSerialsTracked.toLocaleString()}</div>
                <div style={styles.statLabel}>Serials tracked</div>
              </div>
              <div style={{ ...styles.statChip, ...styles.statChipSevere }}>
                <div style={styles.statValue}>{result.stats.totalMissing}</div>
                <div style={styles.statLabel}>Missing</div>
              </div>
              <div style={{ ...styles.statChip, ...styles.statChipSevere }}>
                <div style={styles.statValue}>{result.stats.totalStoreMismatch}</div>
                <div style={styles.statLabel}>Store mismatch</div>
              </div>
              <div style={{ ...styles.statChip, ...styles.statChipSevere }}>
                <div style={styles.statValue}>{result.stats.totalSoldAnomalies}</div>
                <div style={styles.statLabel}>Sold anomalies</div>
              </div>
              <div style={styles.statChip}>
                <div style={styles.statValue}>{result.stats.totalInTransit}</div>
                <div style={styles.statLabel}>In transit</div>
              </div>
              <div style={styles.statChip}>
                <div style={styles.statValue}>{result.stats.totalUnexplainedNew}</div>
                <div style={styles.statLabel}>Unexplained new</div>
              </div>
            </div>

            <div style={styles.actionsRow}>
              <button style={styles.xlsxBtn} onClick={downloadAllZip}>
                📘 Download all (ZIP of CSVs)
              </button>
            </div>

            {sections.map((section) => (
              <div key={section.key} style={styles.sectionCard}>
                <div style={styles.sectionHeader} onClick={() => toggleSection(section.key)}>
                  <div>
                    <div style={styles.sectionTitle}>
                      {section.title} <span style={styles.sectionCount}>({section.rows.length})</span>
                    </div>
                    <div style={styles.sectionDesc}>{section.desc}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {section.rows.length > 0 && (
                      <button
                        style={styles.secondaryBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadSectionCsv(section);
                        }}
                      >
                        CSV
                      </button>
                    )}
                    <span style={styles.chevron}>{openSections.has(section.key) ? "▾" : "▸"}</span>
                  </div>
                </div>

                {openSections.has(section.key) && section.rows.length > 0 && (
                  <div style={styles.previewWrap}>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          {Object.keys(section.rows[0]).map((c) => (
                            <th key={c} style={styles.th}>
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {section.rows.map((r, i) => (
                          <tr key={i} style={styles.tr}>
                            {Object.keys(section.rows[0]).map((c) => (
                              <td key={c} style={styles.td}>
                                {r[c]}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {openSections.has(section.key) && section.rows.length === 0 && (
                  <div style={styles.emptyNote}>Nothing to flag here.</div>
                )}
              </div>
            ))}
          </>
        )}
      </main>
    </div>
  );
}

const styles = {
  ...sharedPageStyles,

  main: { flex: 1, padding: "36px 44px", maxWidth: 1200 },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 720, lineHeight: 1.5 },

  slotGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 14,
    marginBottom: 20,
  },
  slotCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 14,
  },
  slotLabel: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13, marginBottom: 3 },
  requiredMark: { color: "var(--danger)" },
  slotHint: { fontSize: 11, color: "var(--ink-soft)", marginBottom: 10, lineHeight: 1.4 },
  slotRowCount: { fontSize: 11, color: "var(--ledger)", fontWeight: 600, marginTop: 4 },
  slotError: { fontSize: 11, color: "var(--danger)", marginTop: 4, lineHeight: 1.4 },

  dropzone: {
    border: "1px dashed var(--line)",
    borderRadius: 8,
    padding: "16px 10px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    cursor: "pointer",
    textAlign: "center",
    minHeight: 44,
  },

  runBtn: {
    background: "var(--ledger)",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "10px 20px",
    fontSize: 13,
    fontWeight: 600,
  },
  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20, alignItems: "center" },

  errorBanner: {
    background: "var(--danger-bg)",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
    lineHeight: 1.5,
  },

  statsRow: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 },
  statChip: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    padding: "10px 18px",
    minWidth: 100,
    textAlign: "center",
  },
  statChipSevere: { borderColor: "var(--danger)" },
  statValue: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20 },
  statLabel: { fontSize: 10.5, color: "var(--ink-soft)", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.03em" },

  sectionCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    marginBottom: 12,
    overflow: "hidden",
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    cursor: "pointer",
    gap: 12,
  },
  sectionTitle: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 14 },
  sectionCount: { color: "var(--ink-soft)", fontWeight: 500 },
  sectionDesc: { fontSize: 11.5, color: "var(--ink-soft)", marginTop: 3, lineHeight: 1.4, maxWidth: 640 },
  chevron: { color: "var(--ink-soft)", fontSize: 12 },
  emptyNote: { fontSize: 12, color: "var(--ink-soft)", padding: "0 16px 14px" },

  previewWrap: {
    borderTop: "1px solid var(--line)",
    overflow: "auto",
    maxHeight: 340,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 11.5 },
  th: {
    textAlign: "left",
    padding: "7px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 9.5,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    position: "sticky",
    top: 0,
    background: "var(--panel)",
  },
  td: {
    padding: "6px 10px",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    whiteSpace: "nowrap",
  },
};
