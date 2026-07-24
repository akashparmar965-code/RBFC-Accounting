"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";

const emptyMemoDraft = { memo_prefix: "", expense_account: "", expense_memo: "", notes: "" };
const emptyDoorDraft = { door_number: "", company_name: "", qbo_class: "", notes: "" };

export default function MappingsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [session, setSession] = useState(undefined);
  const [memoRows, setMemoRows] = useState([]);
  const [doorRows, setDoorRows] = useState([]);
  const [companyOptions, setCompanyOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [memoDraft, setMemoDraft] = useState(emptyMemoDraft);
  const [doorDraft, setDoorDraft] = useState(emptyDoorDraft);
  const [confirmDelete, setConfirmDelete] = useState(null); // { table, id }

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

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    const [memoRes, doorRes, checklistRes] = await Promise.all([
      supabase.from("memo_mappings").select("*").order("memo_prefix", { ascending: true }),
      supabase.from("door_mappings").select("*").order("door_number", { ascending: true }),
      supabase.from("checklist_items").select("company"),
    ]);
    if (memoRes.error) setError(memoRes.error.message);
    else setMemoRows(memoRes.data || []);
    if (doorRes.error) setError(doorRes.error.message);
    else setDoorRows(doorRes.data || []);
    if (!checklistRes.error) {
      setCompanyOptions(Array.from(new Set((checklistRes.data || []).map((r) => r.company))).sort());
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (session) loadAll();
  }, [session, loadAll]);

  async function updateMemoField(id, field, value) {
    setMemoRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("memo_mappings")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function updateDoorField(id, field, value) {
    setDoorRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("door_mappings")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function addMemoRow() {
    if (!memoDraft.memo_prefix.trim() || !memoDraft.expense_account.trim()) {
      setError("Memo Prefix and Expense Account are required.");
      return;
    }
    const { data, error } = await supabase
      .from("memo_mappings")
      .insert([
        {
          memo_prefix: memoDraft.memo_prefix.trim(),
          expense_account: memoDraft.expense_account.trim(),
          expense_memo: memoDraft.expense_memo.trim() || null,
          notes: memoDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setMemoRows((prev) => [...prev, ...(data || [])]);
    setMemoDraft(emptyMemoDraft);
  }

  async function addDoorRow() {
    if (!doorDraft.door_number.trim() || !doorDraft.company_name.trim() || !doorDraft.qbo_class.trim()) {
      setError("Door Number, Company Name, and QBO Class are required.");
      return;
    }
    const { data, error } = await supabase
      .from("door_mappings")
      .insert([
        {
          door_number: doorDraft.door_number.trim(),
          company_name: doorDraft.company_name.trim(),
          qbo_class: doorDraft.qbo_class.trim(),
          notes: doorDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setDoorRows((prev) => [...prev, ...(data || [])]);
    setDoorDraft(emptyDoorDraft);
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    const { table, id } = confirmDelete;
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) setError(error.message);
    if (table === "memo_mappings") setMemoRows((prev) => prev.filter((r) => r.id !== id));
    else setDoorRows((prev) => prev.filter((r) => r.id !== id));
    setConfirmDelete(null);
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
            <h1 style={styles.h1}>Mapping Master</h1>
            <p style={styles.pageSub}>
              The lookup tables Bills and JV Entry use to classify VIP memos and match door numbers —
              edit them here instead of in code
            </p>
          </div>
        </div>

        {error && <div style={styles.errorBanner}>{error}</div>}

        {loading ? (
          <div style={styles.emptyState}>Loading…</div>
        ) : (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Memo Mapping</div>
              <div style={styles.sectionSub}>
                A VIP Bill line whose Memo starts with one of these prefixes is classified as that Expense
                Account (device lines, where Memo restates the Invoice Number, are handled automatically).
              </div>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Memo Prefix</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Expense Account</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Expense Memo (override)</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {memoRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.memo_prefix}
                            onBlur={(e) => updateMemoField(r.id, "memo_prefix", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.expense_account}
                            onBlur={(e) => updateMemoField(r.id, "expense_account", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder="(uses raw memo text)"
                            defaultValue={r.expense_memo || ""}
                            onBlur={(e) => updateMemoField(r.id, "expense_memo", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateMemoField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "memo_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "memo_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Vantedge Program Fees"
                          value={memoDraft.memo_prefix}
                          onChange={(e) => setMemoDraft((d) => ({ ...d, memo_prefix: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Other Services VIP"
                          value={memoDraft.expense_account}
                          onChange={(e) => setMemoDraft((d) => ({ ...d, expense_account: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={memoDraft.expense_memo}
                          onChange={(e) => setMemoDraft((d) => ({ ...d, expense_memo: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={memoDraft.notes}
                          onChange={(e) => setMemoDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addMemoRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Door Mapping</div>
              <div style={styles.sectionSub}>
                A fallback for VIP Door Numbers that aren't in Store Master yet — lets a bill still match a
                Company and QBO Class without adding a full store record.
              </div>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Door Number</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Company Name</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>QBO Class</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {doorRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.door_number}
                            onBlur={(e) => updateDoorField(r.id, "door_number", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.company_name}
                            onChange={(e) => updateDoorField(r.id, "company_name", e.target.value)}
                          >
                            <option value="">— Select —</option>
                            {companyOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            {r.company_name && !companyOptions.includes(r.company_name) && (
                              <option value={r.company_name}>{r.company_name}</option>
                            )}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.qbo_class}
                            onBlur={(e) => updateDoorField(r.id, "qbo_class", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateDoorField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "door_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "door_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. 7483262"
                          value={doorDraft.door_number}
                          onChange={(e) => setDoorDraft((d) => ({ ...d, door_number: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={doorDraft.company_name}
                          onChange={(e) => setDoorDraft((d) => ({ ...d, company_name: e.target.value }))}
                        >
                          <option value="">— Select —</option>
                          {companyOptions.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. EP - Monroeville-9097"
                          value={doorDraft.qbo_class}
                          onChange={(e) => setDoorDraft((d) => ({ ...d, qbo_class: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={doorDraft.notes}
                          onChange={(e) => setDoorDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addDoorRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
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
  topRow: { marginBottom: 24 },
  h1: { fontFamily: "var(--font-display)", fontSize: 26, margin: 0 },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 720 },
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
    marginBottom: 20,
    padding: 18,
  },
  sectionTitle: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, marginBottom: 6 },
  sectionSub: { fontSize: 12.5, color: "var(--ink-soft)", marginBottom: 14, lineHeight: 1.5 },
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
  tr: { borderBottom: "1px solid var(--line)" },
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
};
