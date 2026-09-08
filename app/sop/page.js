"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import { sharedPageStyles } from "@/lib/pageStyles";
import { sortRows, toggleSort, sortArrow } from "@/lib/sorting";

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
const BANK_RULES_TAB = "__bankrules__";
const emptyBankMemoDraft = { bank_memo: "", account_name: "", notes: "" };
const emptyBankRuleDraft = { bank_memo_prefix: "", match_type: "starts_with", account_name: "", notes: "" };
const MATCH_TYPE_OPTIONS = [
  { value: "starts_with", label: "Starts with" },
  { value: "contains", label: "Contains" },
  { value: "exact", label: "Fully matching" },
];

// Top-level tabs with too many flat entries got grouped into parent tabs
// with their own sub-tab row, added 2026-09-08 -- Sales/AR Deposits/Shared
// Concepts stay standalone (only 3 items, no need to nest them). Children
// are either a real sop_sections `key`, or one of the special tab
// constants above (the "Bank Classification Rules" group -- Utilities +
// the actual bank-rules table, relabeled "Other Classifications" as its
// own sub-tab per explicit request -- has no DB section backing it at
// all, it's purely these two special constants).
const TAB_GROUPS = [
  { key: "bills", label: "Bills", children: ["bills-vip", "bills-epay", "bills-ondigo", "bills-creditnote"] },
  { key: "payroll", label: "Payroll", children: ["payroll-main", "payroll-arcade"] },
  {
    key: "inventory",
    label: "Inventory",
    children: ["inventory-change", "devices-lost", "stock-transfer", "inventory-flow"],
  },
  { key: "manualjv", label: "Manual JV", children: ["manual-jv-main", "manual-jv-company-split"] },
  { key: "otherclass", label: "Bank Classification Rules", children: [UTILITIES_TAB, BANK_RULES_TAB] },
];

/** "Bills -- VIP" -> "VIP" for the sub-tab button; titles with no " -- " (Inventory Flow etc.) pass through as-is. */
function subTabLabel(sectionOrKey, sections) {
  if (sectionOrKey === UTILITIES_TAB) return "Utilities";
  if (sectionOrKey === BANK_RULES_TAB) return "Other Classifications";
  const s = sections.find((sec) => sec.key === sectionOrKey);
  if (!s) return sectionOrKey;
  const parts = s.title.split(" -- ");
  return parts.length > 1 ? parts[1] : s.title;
}

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
  const [accountOptions, setAccountOptions] = useState([]); // [{ account_name }] from chart_of_accounts, Expense category only
  const [confirmDeleteBankMemoId, setConfirmDeleteBankMemoId] = useState(null);
  const [bankMemoSort, setBankMemoSort] = useState({ column: "bank_memo", direction: "asc" });
  const sortedBankMemoRows = useMemo(() => sortRows(bankMemoRows, bankMemoSort), [bankMemoRows, bankMemoSort]);

  const [bankRuleRows, setBankRuleRows] = useState([]);
  const [bankRuleDraft, setBankRuleDraft] = useState(emptyBankRuleDraft);
  const [confirmDeleteBankRuleId, setConfirmDeleteBankRuleId] = useState(null);
  const [bankRuleSort, setBankRuleSort] = useState({ column: "bank_memo_prefix", direction: "asc" });
  const sortedBankRuleRows = useMemo(() => sortRows(bankRuleRows, bankRuleSort), [bankRuleRows, bankRuleSort]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [supabase, router]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    const [conceptsRes, sectionsRes, bankMemoRes, bankRuleRes, accountsRes] = await Promise.all([
      supabase.from("sop_shared_concepts").select("*").order("sort_order", { ascending: true }),
      supabase.from("sop_sections").select("*").order("sort_order", { ascending: true }),
      supabase.from("bank_memo_accounts").select("*").order("bank_memo", { ascending: true }),
      supabase.from("bank_classification_rules").select("*").order("bank_memo_prefix", { ascending: true }),
      supabase
        .from("chart_of_accounts")
        .select("account_name")
        .eq("category", "Expense")
        .order("account_name"),
    ]);
    if (conceptsRes.error) setError(conceptsRes.error.message);
    else setConcepts(conceptsRes.data || []);
    if (sectionsRes.error) setError(sectionsRes.error.message);
    else setSections(sectionsRes.data || []);
    if (bankMemoRes.error) setError(bankMemoRes.error.message);
    else setBankMemoRows(bankMemoRes.data || []);
    if (bankRuleRes.error) setError(bankRuleRes.error.message);
    else setBankRuleRows(bankRuleRes.data || []);
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

  // ---- Bank Classification Rules: prefix/contains/exact match on a Bank
  // Memo -> Account Name, same rule shape as Mapping Master's Product/
  // Credit Note Mapping (unlike Utilities' exact 1:1 lookup above, this
  // buckets a whole family of memo text like "SP FUEL DEPOT #..." under
  // one rule) ----

  async function updateBankRuleField(id, field, value) {
    setBankRuleRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("bank_classification_rules")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function addBankRuleRow() {
    if (!bankRuleDraft.bank_memo_prefix.trim()) {
      setError("Bank Memo Prefix is required.");
      return;
    }
    const { data, error } = await supabase
      .from("bank_classification_rules")
      .insert([
        {
          bank_memo_prefix: bankRuleDraft.bank_memo_prefix.trim(),
          match_type: bankRuleDraft.match_type,
          account_name: bankRuleDraft.account_name.trim() || null,
          notes: bankRuleDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setBankRuleRows((prev) => [...prev, ...(data || [])]);
    setBankRuleDraft(emptyBankRuleDraft);
  }

  async function deleteBankRuleRow(id) {
    const { error } = await supabase.from("bank_classification_rules").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    setBankRuleRows((prev) => prev.filter((r) => r.id !== id));
    setConfirmDeleteBankRuleId(null);
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
              {sections
                .filter((s) => !TAB_GROUPS.some((g) => g.children.includes(s.key)))
                .map((s) => (
                  <button
                    key={s.key}
                    style={activeTab === s.key ? styles.tabActive : styles.tab}
                    onClick={() => switchTab(s.key)}
                  >
                    {s.title}
                  </button>
                ))}
              {TAB_GROUPS.map((g) => (
                <button
                  key={g.key}
                  style={g.children.includes(activeTab) ? styles.tabActive : styles.tab}
                  onClick={() => switchTab(g.children[0])}
                >
                  {g.label}
                </button>
              ))}
            </div>

            {(() => {
              const activeGroup = TAB_GROUPS.find((g) => g.children.includes(activeTab));
              if (!activeGroup) return null;
              return (
                <div style={styles.subTabRow}>
                  {activeGroup.children.map((childKey) => (
                    <button
                      key={childKey}
                      style={activeTab === childKey ? styles.subTabActive : styles.subTab}
                      onClick={() => switchTab(childKey)}
                    >
                      {subTabLabel(childKey, sections)}
                    </button>
                  ))}
                </div>
              );
            })()}

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
                  generation elsewhere in the app. Account Name only lists accounts from Mapping Master's
                  Accounts tab in the <strong>Expense</strong> category, since that's what this table is for.
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
                            onClick={() => toggleSort(setBankMemoSort, column)}
                            title="Click to sort"
                          >
                            {label}
                            {sortArrow(bankMemoSort, column)}
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

            {activeTab === BANK_RULES_TAB && (
              <div style={styles.card}>
                <h2 style={styles.h2}>Bank Classification Rules</h2>
                <p style={styles.sectionSub}>
                  A rule-based version of the Utilities lookup above: match a Bank Memo by{" "}
                  <strong>prefix, contains, or exact text</strong> (same Match Type as Mapping Master's Product/
                  Credit Note Mapping) instead of an exact 1:1 memo, so one rule can bucket a whole family of
                  memo text — e.g. &quot;SP FUEL DEPOT&quot; (Starts with) catches every &quot;SP FUEL DEPOT
                  #4412&quot;, &quot;#7789&quot;, etc. The first rule a memo matches (case-insensitive) determines
                  the Account Name. Personal reference for bifurcating Expenses during reconciliation, same as
                  Utilities — not tied to any upload or JE generation elsewhere in the app. Account Name only
                  lists accounts from Mapping Master's Accounts tab in the <strong>Expense</strong> category.
                </p>

                <div style={styles.tableWrap}>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        {[
                          { column: "bank_memo_prefix", label: "Bank Memo Prefix" },
                          { column: "match_type", label: "Match Type" },
                          { column: "account_name", label: "Account Name" },
                          { column: "notes", label: "Notes" },
                        ].map(({ column, label }) => (
                          <th
                            key={column}
                            style={{ ...styles.th, textAlign: "left", cursor: "pointer", userSelect: "none" }}
                            onClick={() => toggleSort(setBankRuleSort, column)}
                            title="Click to sort"
                          >
                            {label}
                            {sortArrow(bankRuleSort, column)}
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
                            placeholder="e.g. SP FUEL DEPOT"
                            value={bankRuleDraft.bank_memo_prefix}
                            onChange={(e) => setBankRuleDraft((d) => ({ ...d, bank_memo_prefix: e.target.value }))}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={bankRuleDraft.match_type}
                            onChange={(e) => setBankRuleDraft((d) => ({ ...d, match_type: e.target.value }))}
                          >
                            {MATCH_TYPE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            list="bank-rule-account-datalist"
                            placeholder="Type to search…"
                            value={bankRuleDraft.account_name}
                            onChange={(e) => setBankRuleDraft((d) => ({ ...d, account_name: e.target.value }))}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder="(optional)"
                            value={bankRuleDraft.notes}
                            onChange={(e) => setBankRuleDraft((d) => ({ ...d, notes: e.target.value }))}
                          />
                        </td>
                        <td style={styles.td}>
                          <button style={styles.addBtn} onClick={addBankRuleRow}>
                            + Add
                          </button>
                        </td>
                      </tr>
                      {sortedBankRuleRows.map((r) => (
                        <tr key={r.id} style={styles.tr}>
                          <td style={styles.td}>
                            <input
                              style={styles.cellInput}
                              defaultValue={r.bank_memo_prefix}
                              onBlur={(e) => updateBankRuleField(r.id, "bank_memo_prefix", e.target.value)}
                            />
                          </td>
                          <td style={styles.td}>
                            <select
                              style={styles.cellInput}
                              value={r.match_type || "starts_with"}
                              onChange={(e) => updateBankRuleField(r.id, "match_type", e.target.value)}
                            >
                              {MATCH_TYPE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={styles.td}>
                            <input
                              style={styles.cellInput}
                              list="bank-rule-account-datalist"
                              defaultValue={r.account_name || ""}
                              onBlur={(e) => updateBankRuleField(r.id, "account_name", e.target.value)}
                            />
                          </td>
                          <td style={styles.td}>
                            <input
                              style={styles.cellInput}
                              defaultValue={r.notes || ""}
                              onBlur={(e) => updateBankRuleField(r.id, "notes", e.target.value)}
                            />
                          </td>
                          <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                            {confirmDeleteBankRuleId === r.id ? (
                              <>
                                <button
                                  style={{ ...styles.linkBtn, color: "var(--danger)" }}
                                  onClick={() => deleteBankRuleRow(r.id)}
                                >
                                  Confirm
                                </button>
                                <button style={styles.linkBtn} onClick={() => setConfirmDeleteBankRuleId(null)}>
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                style={{ ...styles.linkBtn, color: "var(--danger)" }}
                                onClick={() => setConfirmDeleteBankRuleId(r.id)}
                              >
                                Delete
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {bankRuleRows.length === 0 && (
                        <tr>
                          <td style={styles.td} colSpan={5}>
                            <span style={styles.emptyField}>— nothing added yet —</span>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <datalist id="bank-rule-account-datalist">
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
  subTabRow: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    margin: "-8px 0 20px",
    paddingLeft: 14,
    borderLeft: "2px solid var(--line)",
  },
  subTab: {
    background: "transparent",
    color: "var(--ink-soft)",
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: "5px 12px",
    fontSize: 11.5,
    fontWeight: 600,
  },
  subTabActive: {
    background: "var(--ledger-dark)",
    color: "#fff",
    border: "1px solid var(--ledger-dark)",
    borderRadius: 6,
    padding: "5px 12px",
    fontSize: 11.5,
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
