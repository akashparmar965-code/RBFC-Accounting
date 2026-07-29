"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";

const MONTHS = [
  { key: "jan", label: "Jan" },
  { key: "feb", label: "Feb" },
  { key: "mar", label: "Mar" },
  { key: "apr", label: "Apr" },
  { key: "may", label: "May" },
  { key: "jun", label: "Jun" },
  { key: "jul", label: "Jul" },
  { key: "aug", label: "Aug" },
  { key: "sep", label: "Sep" },
  { key: "oct", label: "Oct" },
  { key: "nov", label: "Nov" },
  { key: "dec", label: "Dec" },
];

const STATUS_OPTIONS = [
  { value: "Done", bg: "#d7f2d1", color: "#2e7d32" },
  { value: "No", bg: "#c0392b", color: "#ffffff" },
  { value: "Import", bg: "#e6d6f5", color: "#6a3fa0" },
  { value: "Categorized", bg: "#f8d3b0", color: "#a15c1e" },
  { value: "Pending", bg: "#6b4423", color: "#ffffff" },
];

function statusStyle(value) {
  return STATUS_OPTIONS.find((o) => o.value === value);
}

export default function ChecklistPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [session, setSession] = useState(undefined);
  const [companies, setCompanies] = useState([]);
  const [company, setCompany] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [newItemText, setNewItemText] = useState({}); // section -> draft text
  const [openCell, setOpenCell] = useState(null); // { itemId, monthKey, top, left }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      if (!sess) router.push("/login");
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase, router]);

  const loadCompanies = useCallback(async () => {
    const { data, error } = await supabase
      .from("checklist_items")
      .select("company")
      .order("company", { ascending: true });
    if (error) {
      setError(error.message);
      return;
    }
    const unique = Array.from(new Set((data || []).map((r) => r.company)));
    setCompanies(unique);
    if (unique.length && !company) setCompany(unique[0]);
  }, [supabase, company]);

  const loadItems = useCallback(
    async (companyName) => {
      if (!companyName) return;
      setLoading(true);
      setError("");
      const { data, error } = await supabase
        .from("checklist_items")
        .select("*")
        .eq("company", companyName)
        .order("section_order", { ascending: true })
        .order("sort_order", { ascending: true });
      if (error) setError(error.message);
      else setItems(data || []);
      setLoading(false);
    },
    [supabase]
  );

  useEffect(() => {
    if (session) loadCompanies();
  }, [session, loadCompanies]);

  useEffect(() => {
    if (session && company) loadItems(company);
  }, [session, company, loadItems]);

  const sections = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      if (!map.has(item.section)) map.set(item.section, []);
      map.get(item.section).push(item);
    }
    return Array.from(map.entries()); // [ [sectionName, items[]], ... ]
  }, [items]);

  function openStatusMenu(e, item, monthKey) {
    const rect = e.currentTarget.getBoundingClientRect();
    setOpenCell({
      itemId: item.id,
      monthKey,
      top: rect.bottom + window.scrollY + 4,
      left: rect.left + window.scrollX,
    });
  }

  async function selectStatus(itemId, monthKey, value) {
    setOpenCell(null);
    setItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, [monthKey]: value } : i)));
    const { error } = await supabase
      .from("checklist_items")
      .update({ [monthKey]: value || null })
      .eq("id", itemId);
    if (error) setError(error.message);
  }

  async function handleAddItem(section, sectionItems) {
    const text = (newItemText[section] || "").trim();
    if (!text) return;
    const nextSortOrder = sectionItems.length
      ? Math.max(...sectionItems.map((i) => i.sort_order)) + 1
      : 0;
    const sectionOrder = sectionItems[0]?.section_order ?? sections.length;
    const { data, error } = await supabase
      .from("checklist_items")
      .insert([{ company, section, item_name: text, sort_order: nextSortOrder, section_order: sectionOrder }])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setItems((prev) => [...prev, ...(data || [])]);
    setNewItemText((prev) => ({ ...prev, [section]: "" }));
  }

  async function handleDelete(id) {
    setError("");
    const { error } = await supabase.from("checklist_items").delete().eq("id", id);
    if (error) setError(error.message);
    setItems((prev) => prev.filter((i) => i.id !== id));
    setConfirmDeleteId(null);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <div>
            <h1 style={styles.h1}>Accounting Checklist</h1>
            <p style={styles.pageSub}>Monthly reconciliation & task tracker, editable per company</p>
          </div>
          <select style={styles.companySelect} value={company} onChange={(e) => setCompany(e.target.value)}>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {error && <div style={styles.errorBanner}>{error}</div>}

        {loading ? (
          <div style={styles.emptyState}>Loading checklist…</div>
        ) : sections.length === 0 ? (
          <div style={styles.emptyState}>No checklist items for this company yet.</div>
        ) : (
          sections.map(([sectionName, sectionItems]) => (
            <div key={sectionName} style={styles.sectionCard}>
              <div style={styles.sectionTitle}>{sectionName}</div>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left", minWidth: 200 }}>Item</th>
                      {MONTHS.map((m) => (
                        <th key={m.key} style={styles.th}>
                          {m.label}
                        </th>
                      ))}
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sectionItems.map((item) => (
                      <tr key={item.id} style={styles.tr}>
                        <td style={{ ...styles.td, textAlign: "left" }}>{item.item_name}</td>
                        {MONTHS.map((m) => {
                          const st = statusStyle(item[m.key]);
                          return (
                            <td key={m.key} style={styles.td}>
                              <button
                                style={
                                  st
                                    ? { ...styles.monthPill, background: st.bg, color: st.color }
                                    : styles.monthEmpty
                                }
                                onClick={(e) => openStatusMenu(e, item, m.key)}
                                title={item[m.key] || "Set status"}
                              >
                                {item[m.key] || ""}
                              </button>
                            </td>
                          );
                        })}
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDeleteId === item.id ? (
                            <>
                              <button
                                style={{ ...styles.linkBtn, color: "var(--danger)" }}
                                onClick={() => handleDelete(item.id)}
                              >
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDeleteId(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDeleteId(item.id)}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={{ ...styles.td, textAlign: "left" }} colSpan={14}>
                        <div style={styles.addRow}>
                          <input
                            style={styles.addInput}
                            placeholder="Add item…"
                            value={newItemText[sectionName] || ""}
                            onChange={(e) =>
                              setNewItemText((prev) => ({ ...prev, [sectionName]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleAddItem(sectionName, sectionItems);
                            }}
                          />
                          <button
                            style={styles.addBtn}
                            onClick={() => handleAddItem(sectionName, sectionItems)}
                          >
                            + Add item
                          </button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </main>

      {openCell && (
        <>
          <div style={styles.menuOverlay} onClick={() => setOpenCell(null)} />
          <div style={{ ...styles.statusMenu, top: openCell.top, left: openCell.left }}>
            {STATUS_OPTIONS.map((o) => (
              <button
                key={o.value}
                style={{ ...styles.statusMenuOption, background: o.bg, color: o.color }}
                onClick={() => selectStatus(openCell.itemId, openCell.monthKey, o.value)}
              >
                {o.value}
              </button>
            ))}
            <button
              style={styles.statusMenuClear}
              onClick={() => selectStatus(openCell.itemId, openCell.monthKey, "")}
            >
              — Clear —
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  loadingScreen: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--ink-soft)",
  },
  shell: { display: "flex", minHeight: "100vh" },
  main: { flex: 1, padding: "36px 44px", maxWidth: 1300 },
  topRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 24,
    gap: 16,
    flexWrap: "wrap",
  },
  h1: { fontFamily: "var(--font-display)", fontSize: 26, margin: 0 },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0" },
  companySelect: {
    padding: "10px 14px",
    borderRadius: 8,
    border: "1px solid var(--line)",
    fontSize: 13,
    fontWeight: 600,
    background: "var(--field)",
    color: "var(--ink)",
    minWidth: 220,
  },
  errorBanner: {
    background: "var(--danger-bg)",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
  },
  emptyState: { padding: "48px 16px", textAlign: "center", color: "var(--ink-soft)", fontSize: 13 },
  sectionCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    marginBottom: 18,
    overflow: "hidden",
  },
  sectionTitle: {
    padding: "12px 18px",
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 14,
    borderBottom: "1px solid var(--line)",
  },
  tableWrap: { overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: {
    textAlign: "center",
    padding: "9px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid var(--line)" },
  td: {
    padding: "8px 10px",
    fontSize: 12.5,
    textAlign: "center",
    whiteSpace: "nowrap",
  },
  monthPill: {
    minWidth: 78,
    height: 28,
    borderRadius: 6,
    border: "none",
    fontWeight: 600,
    fontSize: 11.5,
    padding: "0 10px",
  },
  monthEmpty: {
    minWidth: 78,
    height: 28,
    borderRadius: 6,
    border: "1px solid var(--line)",
    background: "transparent",
  },
  menuOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 90,
  },
  statusMenu: {
    position: "absolute",
    zIndex: 100,
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: 6,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 140,
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  },
  statusMenuClear: {
    textAlign: "left",
    padding: "7px 10px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    background: "transparent",
    color: "var(--ink-soft)",
    fontSize: 12.5,
    fontWeight: 600,
  },
  statusMenuOption: {
    textAlign: "left",
    padding: "7px 10px",
    borderRadius: 6,
    border: "none",
    fontSize: 12.5,
    fontWeight: 600,
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--ledger)",
    fontSize: 12,
    fontWeight: 600,
    marginRight: 12,
    padding: 0,
    fontFamily: "var(--font-body)",
  },
  addRow: { display: "flex", gap: 10, padding: "6px 0" },
  addInput: {
    flex: 1,
    maxWidth: 320,
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    fontSize: 13,
  },
  addBtn: {
    background: "transparent",
    color: "var(--ledger)",
    border: "1px solid var(--ledger)",
    borderRadius: 6,
    padding: "8px 14px",
    fontSize: 12.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
};
