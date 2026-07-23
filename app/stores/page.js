"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";

const FIELDS = [
  { key: "company_name", label: "Company Name" },
  { key: "elevate_name", label: "Elevate Name" },
  { key: "rbfc_market", label: "RBFC Market" },
  { key: "asm", label: "ASM" },
  { key: "epay", label: "Epay" },
  { key: "epay_address", label: "Epay Address" },
  { key: "vip_website_no", label: "VIP Website No." },
  { key: "vip_address", label: "VIP Address" },
  { key: "company", label: "Company" },
  { key: "qbo_class_name", label: "QBO Class Name" },
  { key: "new_qbo_class", label: "New QBO Class" },
  { key: "elevate_name_new_qbo_class", label: "Elevate Name-New QBO Class" },
  { key: "ondigo_address", label: "Ondigo Address" },
  { key: "salesforce_id", label: "Salesforce ID" },
];

const TABLE_COLUMNS = ["elevate_name", "rbfc_market", "asm", "qbo_class_name", "epay", "vip_website_no"];

const emptyForm = () =>
  FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: "" }), {});

export default function StoresPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [marketFilter, setMarketFilter] = useState("all");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // auth guard
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

  const loadStores = useCallback(async () => {
    setLoading(true);
    setError("");
    const { data, error } = await supabase
      .from("stores")
      .select("*")
      .order("elevate_name", { ascending: true });
    if (error) setError(error.message);
    else setStores(data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (session) loadStores();
  }, [session, loadStores]);

  const markets = useMemo(() => {
    const set = new Set(stores.map((s) => s.rbfc_market).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [stores]);

  const filtered = useMemo(() => {
    return stores.filter((s) => {
      if (marketFilter !== "all" && s.rbfc_market !== marketFilter) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return FIELDS.some((f) => (s[f.key] || "").toString().toLowerCase().includes(q));
    });
  }, [stores, search, marketFilter]);

  function openAdd() {
    setEditingId(null);
    setForm(emptyForm());
    setModalOpen(true);
  }

  function openEdit(store) {
    setEditingId(store.id);
    const next = emptyForm();
    FIELDS.forEach((f) => (next[f.key] = store[f.key] || ""));
    setForm(next);
    setModalOpen(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    let res;
    if (editingId) {
      res = await supabase.from("stores").update(form).eq("id", editingId);
    } else {
      res = await supabase.from("stores").insert([form]);
    }
    setSaving(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setModalOpen(false);
    loadStores();
  }

  async function handleDelete(id) {
    setError("");
    const { error } = await supabase.from("stores").delete().eq("id", id);
    if (error) setError(error.message);
    setConfirmDeleteId(null);
    loadStores();
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
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
            <h1 style={styles.h1}>Store Master</h1>
            <p style={styles.pageSub}>
              {stores.length} store{stores.length === 1 ? "" : "s"} · edits apply immediately to
              every upload that references them
            </p>
          </div>
          <button style={styles.primaryBtn} onClick={openAdd}>
            + Add store
          </button>
        </div>

        <div style={styles.filterRow}>
          <input
            style={styles.searchInput}
            placeholder="Search any field…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            style={styles.select}
            value={marketFilter}
            onChange={(e) => setMarketFilter(e.target.value)}
          >
            {markets.map((m) => (
              <option key={m} value={m}>
                {m === "all" ? "All markets" : m}
              </option>
            ))}
          </select>
        </div>

        {error && <div style={styles.errorBanner}>{error}</div>}

        <div style={styles.tableWrap}>
          {loading ? (
            <div style={styles.emptyState}>Loading stores…</div>
          ) : filtered.length === 0 ? (
            <div style={styles.emptyState}>
              No stores match. {stores.length === 0 && "Add your first store to get started."}
            </div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  {TABLE_COLUMNS.map((key) => (
                    <th key={key} style={styles.th}>
                      {FIELDS.find((f) => f.key === key)?.label}
                    </th>
                  ))}
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id} style={styles.tr}>
                    {TABLE_COLUMNS.map((key) => (
                      <td key={key} style={styles.td}>
                        {s[key] || <span style={styles.dash}>—</span>}
                      </td>
                    ))}
                    <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                      <button style={styles.linkBtn} onClick={() => openEdit(s)}>
                        Edit
                      </button>
                      {confirmDeleteId === s.id ? (
                        <>
                          <button
                            style={{ ...styles.linkBtn, color: "var(--danger)" }}
                            onClick={() => handleDelete(s.id)}
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
                          onClick={() => setConfirmDeleteId(s.id)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {modalOpen && (
        <div style={styles.overlay} onClick={() => setModalOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>{editingId ? "Edit store" : "Add store"}</h2>
            <form onSubmit={handleSave}>
              <div style={styles.formGrid}>
                {FIELDS.map((f) => (
                  <label key={f.key} style={styles.formLabel}>
                    {f.label}
                    <input
                      style={styles.formInput}
                      value={form[f.key]}
                      onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <div style={styles.modalActions}>
                <button
                  type="button"
                  style={styles.secondaryBtn}
                  onClick={() => setModalOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} style={styles.primaryBtn}>
                  {saving ? "Saving…" : editingId ? "Save changes" : "Add store"}
                </button>
              </div>
            </form>
          </div>
        </div>
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
    fontFamily: "var(--font-body)",
  },
  shell: { display: "flex", minHeight: "100vh" },
  sidebar: {
    width: 240,
    background: "var(--sidebar)",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    padding: "24px 18px",
    flexShrink: 0,
  },
  sidebarBrand: { display: "flex", alignItems: "center", gap: 10, marginBottom: 32 },
  mark: {
    width: 32,
    height: 32,
    borderRadius: 7,
    background: "var(--ledger)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    flexShrink: 0,
  },
  brandTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14 },
  brandSub: { fontSize: 11, color: "var(--sidebar-soft)", marginTop: 2, wordBreak: "break-all" },
  nav: { display: "flex", flexDirection: "column", gap: 4, flex: 1 },
  navItem: {
    padding: "9px 12px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  navItemActive: { background: "var(--ledger)", color: "#fff" },
  navItemDisabled: {
    padding: "9px 12px",
    borderRadius: 6,
    fontSize: 13,
    color: "var(--sidebar-soft)",
  },
  signOutBtn: {
    background: "none",
    border: "1px solid #2a303b",
    color: "var(--sidebar-soft)",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 13,
  },
  main: { flex: 1, padding: "36px 44px", maxWidth: 1200 },
  topRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
    gap: 16,
  },
  h1: { fontFamily: "var(--font-display)", fontSize: 26, margin: 0 },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0" },
  primaryBtn: {
    background: "var(--ledger)",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  secondaryBtn: {
    background: "#fff",
    color: "var(--ink)",
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
  },
  filterRow: { display: "flex", gap: 10, marginBottom: 18 },
  searchInput: {
    flex: 1,
    maxWidth: 320,
    padding: "9px 12px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    fontSize: 13,
  },
  select: {
    padding: "9px 12px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    fontSize: 13,
    background: "#fff",
  },
  errorBanner: {
    background: "#fbeeea",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
  },
  tableWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "11px 16px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid var(--line)" },
  td: {
    padding: "11px 16px",
    fontFamily: "var(--font-mono)",
    fontSize: 12.5,
    whiteSpace: "nowrap",
  },
  dash: { color: "#c3c7c2" },
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
  emptyState: { padding: "48px 16px", textAlign: "center", color: "var(--ink-soft)", fontSize: 13 },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(18,22,28,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 50,
  },
  modal: {
    background: "#fff",
    borderRadius: 10,
    padding: 28,
    width: 640,
    maxWidth: "100%",
    maxHeight: "88vh",
    overflow: "auto",
  },
  modalTitle: { fontFamily: "var(--font-display)", fontSize: 19, margin: "0 0 18px" },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 },
  formLabel: { display: "flex", flexDirection: "column", gap: 5, fontSize: 12, fontWeight: 600, color: "var(--ink-soft)" },
  formInput: {
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    color: "var(--ink)",
  },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 22 },
};
