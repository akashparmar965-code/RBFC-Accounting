"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { createClient } from "@/lib/supabaseClient";

const FIELDS = [
  { key: "company_name", label: "Company Name" },
  { key: "elevate_name", label: "Elevate Name" },
  { key: "rbfc_market", label: "RBFC Market" },
  { key: "asm", label: "ASM" },
  { key: "epay", label: "Epay" },
  { key: "epay_address", label: "Epay Address" },
  { key: "vip_website_no", label: "VIP Website No." },
  { key: "vip_address", label: "VIP Address" },
  { key: "elevate_name_new_qbo_class", label: "QB Class Name" },
  { key: "ondigo_address", label: "Ondigo Address" },
  { key: "salesforce_id", label: "Salesforce ID" },
];

const TABLE_COLUMNS = ["elevate_name", "rbfc_market", "asm", "company_name", "epay", "vip_website_no"];

const emptyForm = () => FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: "" }), {});

export default function StoreMasterPanel() {
  const supabase = useMemo(() => createClient(), []);

  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [marketFilter, setMarketFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [companyOptions, setCompanyOptions] = useState([]);

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
    loadStores();
  }, [loadStores]);

  useEffect(() => {
    supabase
      .from("checklist_items")
      .select("company")
      .then(({ data, error }) => {
        if (error) return;
        const unique = Array.from(new Set((data || []).map((r) => r.company))).sort();
        setCompanyOptions(unique);
      });
  }, [supabase]);

  const markets = useMemo(() => {
    const set = new Set(stores.map((s) => (s.rbfc_market || "").trim()).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [stores]);

  const companies = useMemo(() => {
    const set = new Set(stores.map((s) => (s.company_name || "").trim()).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [stores]);

  const filtered = useMemo(() => {
    return stores.filter((s) => {
      if (marketFilter !== "all" && (s.rbfc_market || "").trim() !== marketFilter) return false;
      if (companyFilter !== "all" && (s.company_name || "").trim() !== companyFilter) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return FIELDS.some((f) => (s[f.key] || "").toString().toLowerCase().includes(q));
    });
  }, [stores, search, marketFilter, companyFilter]);

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

  return (
    <>
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
        <select style={styles.select} value={marketFilter} onChange={(e) => setMarketFilter(e.target.value)}>
          {markets.map((m) => (
            <option key={m} value={m}>
              {m === "all" ? "All markets" : m}
            </option>
          ))}
        </select>
        <select style={styles.select} value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}>
          {companies.map((c) => (
            <option key={c} value={c}>
              {c === "all" ? "All companies" : c}
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

      {modalOpen && (
        <div style={styles.overlay} onClick={() => setModalOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>{editingId ? "Edit store" : "Add store"}</h2>
            <form onSubmit={handleSave}>
              <div style={styles.formGrid}>
                {FIELDS.map((f) =>
                  f.key === "company_name" ? (
                    <label key={f.key} style={styles.formLabel}>
                      {f.label}
                      <select
                        style={styles.formInput}
                        value={form[f.key]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      >
                        <option value="">— Select company —</option>
                        {companyOptions.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                        {form[f.key] && !companyOptions.includes(form[f.key]) && (
                          <option value={form[f.key]}>{form[f.key]}</option>
                        )}
                      </select>
                    </label>
                  ) : (
                    <label key={f.key} style={styles.formLabel}>
                      {f.label}
                      <input
                        style={styles.formInput}
                        value={form[f.key]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      />
                    </label>
                  )
                )}
              </div>
              <div style={styles.modalActions}>
                <button type="button" style={styles.secondaryBtn} onClick={() => setModalOpen(false)}>
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
    </>
  );
}

const styles = {
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
    background: "var(--panel)",
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
    background: "var(--field)",
  },
  errorBanner: {
    background: "var(--danger-bg)",
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
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    zIndex: 50,
  },
  modal: {
    background: "var(--panel)",
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
