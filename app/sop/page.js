"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import { sharedPageStyles } from "@/lib/pageStyles";

const SECTION_FIELDS = [
  { key: "source_of_file", label: "Source of File", hint: "Where this file comes from and how to pull it." },
  {
    key: "file_creation_notes",
    label: "File Creation Notes — What to Include / Exclude",
    hint: "What to include or leave out when creating/pulling the source file itself.",
  },
  { key: "columns_include", label: "Columns to Include", hint: "Which columns in the export this entry actually needs." },
  { key: "columns_exclude", label: "Columns to Exclude", hint: "Columns present in the export but not needed (or that must NOT be included)." },
  { key: "purpose_of_entry", label: "Purpose of Entry", hint: "Why this entry exists — what it accomplishes in the books." },
  { key: "processing", label: "Processing to Raw Data", hint: "How the app turns the source file into the entry." },
  { key: "finalize", label: "Finalize & Upload to QuickBooks", hint: "The final steps to generate and import the entry." },
  { key: "watch_for", label: "Watch For", hint: "Real gotchas — check these every run." },
];

const CONCEPTS_TAB = "__concepts__";
const UTILITIES_TAB = "__utilities__";
const emptyBankMemoDraft = { bank_memo: "", account_name: "", notes: "" };

function Bulleted({ text }) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return <div style={styles.emptyField}>— nothing written yet —</div>;
  return (
    <ul style={styles.readList}>
      {lines.map((line, i) => (
        <li key={i} style={styles.readListItem}>
          {line}
        </li>
      ))}
    </ul>
  );
}

export default function SopPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [session, setSession] = useState(undefined);
  const [concepts, setConcepts] = useState([]);
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState(CONCEPTS_TAB);

  const [editingConceptId, setEditingConceptId] = useState(null);
  const [conceptDraft, setConceptDraft] = useState(null);

  const [editingSectionId, setEditingSectionId] = useState(null);
  const [sectionDraft, setSectionDraft] = useState(null);

  const [bankMemoRows, setBankMemoRows] = useState([]);
  const [bankMemoDraft, setBankMemoDraft] = useState(emptyBankMemoDraft);
  const [accountOptions, setAccountOptions] = useState([]); // [{ account_name }] from chart_of_accounts
  const [confirmDeleteBankMemoId, setConfirmDeleteBankMemoId] = useState(null);
  const [bankMemoSort, setBankMemoSort] = useState({ column: "bank_memo", direction: "asc" });

  function toggleBankMemoSort(column) {
    setBankMemoSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" }
    );
  }

  const sortedBankMemoRows = useMemo(() => {
    const { column, direction } = bankMemoSort;
    const sorted = [...bankMemoRows].sort((a, b) => {
      const av = (a[column] || "").toString().toLowerCase();
      const bv = (b[column] || "").toString().toLowerCase();
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    return direction === "asc" ? sorted : sorted.reverse();
  }, [bankMemoRows, bankMemoSort]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [supabase, router]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    const [conceptsRes, sectionsRes, bankMemoRes, accountsRes] = await Promise.all([
      supabase.from("sop_shared_concepts").select("*").order("sort_order", { ascending: true }),
      supabase.from("sop_sections").select("*").order("sort_order", { ascending: true }),
      supabase.from("bank_memo_accounts").select("*").order("bank_memo", { ascending: true }),
      supabase.from("chart_of_accounts").select("account_name").order("category").order("account_name"),
    ]);
    if (conceptsRes.error) setError(conceptsRes.error.message);
    else setConcepts(conceptsRes.data || []);
    if (sectionsRes.error) setError(sectionsRes.error.message);
    else setSections(sectionsRes.data || []);
    if (bankMemoRes.error) setError(bankMemoRes.error.message);
    else setBankMemoRows(bankMemoRes.data || []);
    if (!accountsRes.error) setAccountOptions(accountsRes.data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (session) loadAll();
  }, [session, loadAll]);

  // ---- Shared concepts edit/save/cancel ----

  function startEditConcept(c) {
    setEditingConceptId(c.id);
    setConceptDraft({ term: c.term, body: c.body });
  }

  function cancelEditConcept() {
    setEditingConceptId(null);
    setConceptDraft(null);
  }

  async function saveEditConcept(id) {
    const { error } = await supabase.from("sop_shared_concepts").update(conceptDraft).eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setConcepts((prev) => prev.map((c) => (c.id === id ? { ...c, ...conceptDraft } : c)));
    setEditingConceptId(null);
    setConceptDraft(null);
  }

  // ---- Sections edit/save/cancel ----

  function startEditSection(s) {
    setEditingSectionId(s.id);
    const draft = { title: s.title, summary: s.summary };
    for (const f of SECTION_FIELDS) draft[f.key] = s[f.key] || "";
    setSectionDraft(draft);
  }

  function cancelEditSection() {
    setEditingSectionId(null);
    setSectionDraft(null);
  }

  async function saveEditSection(id) {
    const { error } = await supabase.from("sop_sections").update(sectionDraft).eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...sectionDraft } : s)));
    setEditingSectionId(null);
    setSectionDraft(null);
  }

  function switchTab(tab) {
    // Leaving a tab mid-edit discards the unsaved draft, same as clicking Cancel.
    if (editingConceptId) cancelEditConcept();
    if (editingSectionId) cancelEditSection();
    setActiveTab(tab);
  }

  // ---- Utilities: Bank Memo -> Account Name reference ----

  async function updateBankMemoField(id, field, value) {
    setBankMemoRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("bank_memo_accounts")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function addBankMemoRow() {
    if (!bankMemoDraft.bank_memo.trim() || !bankMemoDraft.account_name.trim()) {
      setError("Bank Memo and Account Name are required.");
      return;
    }
    const { data, error } = await supabase
      .from("bank_memo_accounts")
      .insert([
        {
          bank_memo: bankMemoDraft.bank_memo.trim(),
          account_name: bankMemoDraft.account_name.trim(),
          notes: bankMemoDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setBankMemoRows((prev) => [...prev, ...(data || [])]);
    setBankMemoDraft(emptyBankMemoDraft);
  }

  async function deleteBankMemoRow(id) {
    const { error } = await supabase.from("bank_memo_accounts").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setBankMemoRows((prev) => prev.filter((r) => r.id !== id));
    setConfirmDeleteBankMemoId(null);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const activeSection = sections.find((s) => s.key === activeTab) || null;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>SOP</h1>
          <p style={styles.pageSub}>
            How each accounting entry flows in this dashboard — where the source file comes from, what to include
            or exclude when creating it, why the entry exists, and how the finished entry gets built and imported
            into QuickBooks. Click Edit on any card to change it.
          </p>
        </div>

        {error && <div style={styles.errorBanner}>{error}</div>}

        {loading ? (
          <div style={styles.emptyState}>Loading…</div>
        ) : (
          <>
            <div style={styles.tabRow}>
              <button
                style={activeTab === CONCEPTS_TAB ? styles.tabActive : styles.tab}
                onClick={() => switchTab(CONCEPTS_TAB)}
              >
                Shared Concepts
              </button>
              {sections.map((s) => (
                <button key={s.key} style={activeTab === s.key ? styles.tabActive : styles.tab} onClick={() => switchTab(s.key)}>
                  {s.title}
                </button>
              ))}
              <button
                style={activeTab === UTILITIES_TAB ? styles.tabActive : styles.tab}
                onClick={() => switchTab(UTILITIES_TAB)}
              >
                Utilities
              </button>
            </div>

            {activeTab === CONCEPTS_TAB && (
              <div style={styles.card}>
                <h2 style={styles.h2}>Shared concepts</h2>
                <p style={styles.sectionSub}>
                  These ideas show up on almost every page — understand these first and the rest reads much faster.
                </p>
                <div style={styles.conceptGrid}>
                  {concepts.map((c) => {
                    const isEditing = editingConceptId === c.id;
                    return (
                      <div key={c.id} style={styles.conceptCard}>
                        {isEditing ? (
                          <>
                            <input
                              style={styles.conceptTermInput}
                              value={conceptDraft.term}
                              onChange={(e) => setConceptDraft((d) => ({ ...d, term: e.target.value }))}
                            />
                            <textarea
                              style={styles.conceptBodyInput}
                              value={conceptDraft.body}
                              onChange={(e) => setConceptDraft((d) => ({ ...d, body: e.target.value }))}
                            />
                            <div style={styles.editActionsRow}>
                              <button style={styles.saveBtn} onClick={() => saveEditConcept(c.id)}>
                                Save
                              </button>
                              <button style={styles.cancelBtn} onClick={cancelEditConcept}>
                                Cancel
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={styles.conceptTermRead}>{c.term}</div>
                            <div style={styles.conceptBodyRead}>{c.body}</div>
                            <button style={styles.editBtn} onClick={() => startEditConcept(c)}>
                              ✎ Edit
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeSection &&
              (() => {
                const s = activeSection;
                const isEditing = editingSectionId === s.id;
                return (
                  <div style={styles.sectionCard}>
                    <div style={styles.sectionHeader}>
                      <div style={{ flex: 1 }}>
                        {isEditing ? (
                          <input
                            style={styles.titleInput}
                            value={sectionDraft.title}
                            onChange={(e) => setSectionDraft((d) => ({ ...d, title: e.target.value }))}
                          />
                        ) : (
                          <div style={styles.titleRead}>{s.title}</div>
                        )}
                        {isEditing ? (
                          <input
                            style={styles.summaryInput}
                            value={sectionDraft.summary}
                            onChange={(e) => setSectionDraft((d) => ({ ...d, summary: e.target.value }))}
                          />
                        ) : (
                          <div style={styles.summaryRead}>{s.summary}</div>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {!isEditing && s.route && (
                          <Link href={s.route} style={styles.pageLink}>
                            Open page →
                          </Link>
                        )}
                        {!isEditing && (
                          <button style={styles.editBtn} onClick={() => startEditSection(s)}>
                            ✎ Edit
                          </button>
                        )}
                      </div>
                    </div>

                    <div style={styles.sectionBody}>
                      {SECTION_FIELDS.map((f) => (
                        <div key={f.key} style={styles.subSection}>
                          <div style={styles.subSectionTitle}>{f.label}</div>
                          <div style={styles.subSectionHint}>{f.hint}</div>
                          {isEditing ? (
                            <textarea
                              style={styles.fieldTextarea}
                              value={sectionDraft[f.key]}
                              onChange={(e) => setSectionDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                            />
                          ) : (
                            <Bulleted text={s[f.key]} />
                          )}
                        </div>
                      ))}

                      {isEditing && (
                        <div style={styles.editActionsRow}>
                          <button style={styles.saveBtn} onClick={() => saveEditSection(s.id)}>
                            Save
                          </button>
                          <button style={styles.cancelBtn} onClick={cancelEditSection}>
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

            {activeTab === UTILITIES_TAB && (
              <div style={styles.card}>
                <h2 style={styles.h2}>Utilities</h2>
                <p style={styles.sectionSub}>
                  A personal reference: the description text a bank statement shows for a transaction (its
                  Bank Memo), mapped to which Account Name that transaction usually gets booked to — a quick
                  lookup when bifurcating Expenses during reconciliation, not tied to any upload or JE
                  generation elsewhere in the app.
                </p>

                <div style={styles.tableWrap}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        {[
                          { column: "bank_memo", label: "Bank Memo" },
                          { column: "account_name", label: "Account Name" },
                          { column: "notes", label: "Notes" },
                        ].map(({ column, label }) => (
                          <th
                            key={column}
                            style={{ ...styles.th, textAlign: "left", cursor: "pointer", userSelect: "none" }}
                            onClick={() => toggleBankMemoSort(column)}
                            title="Click to sort"
                          >
                            {label}
                            {bankMemoSort.column === column && (bankMemoSort.direction === "asc" ? " ▲" : " ▼")}
                          </th>
                        ))}
                        <th style={styles.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder="e.g. SP FUEL DEPOT #4412"
                            value={bankMemoDraft.bank_memo}
                            onChange={(e) => setBankMemoDraft((d) => ({ ...d, bank_memo: e.target.value }))}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            list="bank-memo-account-datalist"
                            placeholder="Type to search…"
                            value={bankMemoDraft.account_name}
                            onChange={(e) => setBankMemoDraft((d) => ({ ...d, account_name: e.target.value }))}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder="(optional)"
                            value={bankMemoDraft.notes}
                            onChange={(e) => setBankMemoDraft((d) => ({ ...d, notes: e.target.value }))}
                          />
                        </td>
                        <td style={styles.td}>
                          <button style={styles.addBtn} onClick={addBankMemoRow}>
                            + Add
                          </button>
                        </td>
                      </tr>
                      {sortedBankMemoRows.map((r) => (
                        <tr key={r.id} style={styles.tr}>
                          <td style={styles.td}>
                            <input
                              style={styles.cellInput}
                              defaultValue={r.bank_memo}
                              onBlur={(e) => updateBankMemoField(r.id, "bank_memo", e.target.value)}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              style={styles.cellInput}
                              list="bank-memo-account-datalist"
                              defaultValue={r.account_name}
                              onBlur={(e) => updateBankMemoField(r.id, "account_name", e.target.value)}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              style={styles.cellInput}
                              defaultValue={r.notes || ""}
                              onBlur={(e) => updateBankMemoField(r.id, "notes", e.target.value)}
                            />
                          </td>
                          <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                            {confirmDeleteBankMemoId === r.id ? (
                              <>
                                <button
                                  style={{ ...styles.linkBtn, color: "var(--danger)" }}
                                  onClick={() => deleteBankMemoRow(r.id)}
                                >
                                  Confirm
                                </button>
                                <button style={styles.linkBtn} onClick={() => setConfirmDeleteBankMemoId(null)}>
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                style={{ ...styles.linkBtn, color: "var(--danger)" }}
                                onClick={() => setConfirmDeleteBankMemoId(r.id)}
                              >
                                Delete
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {bankMemoRows.length === 0 && (
                        <tr>
                          <td style={styles.td} colSpan={4}>
                            <span style={styles.emptyField}>— nothing added yet —</span>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <datalist id="bank-memo-account-datalist">
                  {accountOptions.map((a) => (
                    <option key={a.account_name} value={a.account_name} />
                  ))}
                </datalist>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const styles = {
  ...sharedPageStyles,

  main: { flex: 1, padding: "36px 44px", maxWidth: 1100 },

  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 6px" },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 760, lineHeight: 1.6 },

  errorBanner: {
    background: "var(--danger-bg)",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
  },
  emptyState: { padding: "48px 16px", textAlign: "center", color: "var(--ink-soft)", fontSize: 13 },
  emptyField: { fontSize: 12.5, color: "var(--ink-soft)", fontStyle: "italic" },

  tableWrap: { overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: {
    textAlign: "center",
    padding: "8px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  },
  td: { padding: "6px 8px" },
  cellInput: {
    width: "100%",
    minWidth: 140,
    padding: "6px 8px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    fontSize: 12.5,
    fontFamily: "var(--font-mono)",
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
  addBtn: {
    background: "transparent",
    color: "var(--ledger)",
    border: "1px solid var(--ledger)",
    borderRadius: 5,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },

  sectionSub: { fontSize: 12.5, color: "var(--ink-soft)", marginBottom: 14, lineHeight: 1.5, maxWidth: 720 },

  tabRow: { display: "flex", gap: 8, flexWrap: "wrap", margin: "20px 0" },
  tab: {
    background: "transparent",
    color: "var(--ink-soft)",
    border: "1px solid var(--line)",
    borderRadius: 7,
    padding: "8px 16px",
    fontSize: 12.5,
    fontWeight: 600,
  },
  tabActive: {
    background: "var(--ledger)",
    color: "#fff",
    border: "1px solid var(--ledger)",
    borderRadius: 7,
    padding: "8px 16px",
    fontSize: 12.5,
    fontWeight: 600,
  },

  conceptGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 12,
  },
  conceptCard: {
    background: "var(--field)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  conceptTermRead: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13 },
  conceptBodyRead: { fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.55, whiteSpace: "pre-wrap" },
  conceptTermInput: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 13,
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 5,
    padding: "6px 8px",
    color: "var(--ink)",
  },
  conceptBodyInput: {
    fontSize: 12,
    color: "var(--ink)",
    lineHeight: 1.55,
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 5,
    resize: "vertical",
    minHeight: 90,
    fontFamily: "var(--font-body)",
    padding: "6px 8px",
  },

  editBtn: {
    background: "transparent",
    color: "var(--ledger)",
    border: "1px solid var(--ledger)",
    borderRadius: 5,
    padding: "5px 12px",
    fontSize: 11.5,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  saveBtn: {
    background: "var(--ledger)",
    color: "#fff",
    border: "none",
    borderRadius: 5,
    padding: "7px 16px",
    fontSize: 12.5,
    fontWeight: 600,
  },
  cancelBtn: {
    background: "transparent",
    color: "var(--ink-soft)",
    border: "1px solid var(--line)",
    borderRadius: 5,
    padding: "7px 16px",
    fontSize: 12.5,
    fontWeight: 600,
  },
  editActionsRow: { display: "flex", gap: 10, marginTop: 8 },

  sectionCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "hidden",
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 18px",
    gap: 12,
    borderBottom: "1px solid var(--line)",
  },
  titleRead: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 16, marginBottom: 3 },
  summaryRead: { fontSize: 12.5, color: "var(--ink-soft)" },
  titleInput: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 15,
    background: "var(--field)",
    border: "1px solid var(--line)",
    borderRadius: 5,
    color: "var(--ink)",
    width: "100%",
    padding: "5px 8px",
    marginBottom: 4,
  },
  summaryInput: {
    fontSize: 12.5,
    color: "var(--ink)",
    background: "var(--field)",
    border: "1px solid var(--line)",
    borderRadius: 5,
    width: "100%",
    padding: "5px 8px",
  },
  pageLink: { fontSize: 12, color: "var(--ledger)", fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" },

  sectionBody: { padding: "18px" },
  subSection: { marginBottom: 16 },
  subSectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--ink-soft)",
    marginBottom: 3,
  },
  subSectionHint: { fontSize: 11, color: "var(--ink-soft)", opacity: 0.75, marginBottom: 6, fontStyle: "italic" },
  fieldTextarea: {
    width: "100%",
    minHeight: 70,
    resize: "vertical",
    background: "var(--field)",
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: "8px 10px",
    fontSize: 13,
    lineHeight: 1.6,
    color: "var(--ink)",
    fontFamily: "var(--font-body)",
  },
  readList: { margin: 0, paddingLeft: 20 },
  readListItem: { fontSize: 13, lineHeight: 1.6, marginBottom: 5 },
};
