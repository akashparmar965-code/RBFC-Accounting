"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  loadPendingMappings,
  removePendingDoor,
  removePendingAccount,
  removePendingProductsMatching,
} from "@/lib/pendingMappings";

const emptyProductDraft = { product_prefix: "", expense_account: "", expense_memo: "", notes: "" };
const emptyDoorDraft = { door_number: "", company_name: "", qbo_class: "", notes: "" };
const emptyAccountDraft = { account_number: "", company_name: "", qbo_class: "", notes: "" };

export default function MappingsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [session, setSession] = useState(undefined);
  const [productRows, setProductRows] = useState([]);
  const [doorRows, setDoorRows] = useState([]);
  const [accountRows, setAccountRows] = useState([]);
  const [companyOptions, setCompanyOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [productDraft, setProductDraft] = useState(emptyProductDraft);
  const [doorDraft, setDoorDraft] = useState(emptyDoorDraft);
  const [accountDraft, setAccountDraft] = useState(emptyAccountDraft);
  const [confirmDelete, setConfirmDelete] = useState(null); // { table, id }
  const [pendingDoors, setPendingDoors] = useState([]);
  const [pendingProducts, setPendingProducts] = useState([]);
  const [pendingAccounts, setPendingAccounts] = useState([]);

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

  useEffect(() => {
    const pending = loadPendingMappings();
    setPendingDoors(pending.unmatchedDoors);
    setPendingProducts(pending.unmappedProducts);
    setPendingAccounts(pending.unmatchedAccounts);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    const [productRes, doorRes, accountRes, checklistRes] = await Promise.all([
      supabase.from("product_mappings").select("*").order("product_prefix", { ascending: true }),
      supabase.from("door_mappings").select("*").order("door_number", { ascending: true }),
      supabase.from("epay_account_mappings").select("*").order("account_number", { ascending: true }),
      supabase.from("checklist_items").select("company"),
    ]);
    if (productRes.error) setError(productRes.error.message);
    else setProductRows(productRes.data || []);
    if (doorRes.error) setError(doorRes.error.message);
    else setDoorRows(doorRes.data || []);
    if (accountRes.error) setError(accountRes.error.message);
    else setAccountRows(accountRes.data || []);
    if (!checklistRes.error) {
      setCompanyOptions(Array.from(new Set((checklistRes.data || []).map((r) => r.company))).sort());
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (session) loadAll();
  }, [session, loadAll]);

  async function updateProductField(id, field, value) {
    setProductRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("product_mappings")
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

  async function addProductRow() {
    if (!productDraft.product_prefix.trim() || !productDraft.expense_account.trim()) {
      setError("Product Prefix and Expense Account are required.");
      return;
    }
    const { data, error } = await supabase
      .from("product_mappings")
      .insert([
        {
          product_prefix: productDraft.product_prefix.trim(),
          expense_account: productDraft.expense_account.trim(),
          expense_memo: productDraft.expense_memo.trim() || null,
          notes: productDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setProductRows((prev) => [...prev, ...(data || [])]);
    const addedPrefix = productDraft.product_prefix.trim();
    setProductDraft(emptyProductDraft);
    removePendingProductsMatching(addedPrefix);
    setPendingProducts((prev) => prev.filter((p) => !p.product.toLowerCase().startsWith(addedPrefix.toLowerCase())));
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
    const addedDoor = doorDraft.door_number.trim();
    setDoorDraft(emptyDoorDraft);
    removePendingDoor(addedDoor);
    setPendingDoors((prev) => prev.filter((d) => d !== addedDoor));
  }

  async function updateAccountField(id, field, value) {
    setAccountRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("epay_account_mappings")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function addAccountRow() {
    if (!accountDraft.account_number.trim() || !accountDraft.company_name.trim() || !accountDraft.qbo_class.trim()) {
      setError("Account Number, Company Name, and QBO Class are required.");
      return;
    }
    const { data, error } = await supabase
      .from("epay_account_mappings")
      .insert([
        {
          account_number: accountDraft.account_number.trim(),
          company_name: accountDraft.company_name.trim(),
          qbo_class: accountDraft.qbo_class.trim(),
          notes: accountDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setAccountRows((prev) => [...prev, ...(data || [])]);
    const addedAccount = accountDraft.account_number.trim();
    setAccountDraft(emptyAccountDraft);
    removePendingAccount(addedAccount);
    setPendingAccounts((prev) => prev.filter((a) => a !== addedAccount));
  }

  function useAccountSuggestion(accountNumber) {
    setAccountDraft((d) => ({ ...d, account_number: accountNumber }));
  }

  function dismissPendingAccount(accountNumber) {
    removePendingAccount(accountNumber);
    setPendingAccounts((prev) => prev.filter((a) => a !== accountNumber));
  }

  function useDoorSuggestion(doorNumber) {
    setDoorDraft((d) => ({ ...d, door_number: doorNumber }));
  }

  function dismissPendingDoor(doorNumber) {
    removePendingDoor(doorNumber);
    setPendingDoors((prev) => prev.filter((d) => d !== doorNumber));
  }

  function useProductSuggestion(product) {
    setProductDraft((d) => ({ ...d, product_prefix: product }));
  }

  function dismissPendingProduct(item) {
    removePendingProductsMatching(item.product);
    setPendingProducts((prev) => prev.filter((p) => p !== item));
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    const { table, id } = confirmDelete;
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) setError(error.message);
    if (table === "product_mappings") setProductRows((prev) => prev.filter((r) => r.id !== id));
    else if (table === "door_mappings") setDoorRows((prev) => prev.filter((r) => r.id !== id));
    else setAccountRows((prev) => prev.filter((r) => r.id !== id));
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
              The lookup tables Bills and JV Entry use to classify VIP line items and match door numbers —
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
              <div style={styles.sectionTitle}>Product Mapping</div>
              <div style={styles.sectionSub}>
                A VIP Bill line is classified by its <strong>Products</strong> text (not Memo, which is
                often generic or inconsistent) — whichever prefix it starts with (case-insensitive)
                determines the Expense Account. A line matching no prefix is skipped and flagged.
              </div>

              {pendingProducts.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  {pendingProducts.map((p, i) => (
                    <span key={i} style={styles.chip}>
                      <button
                        style={styles.chipMain}
                        title={`Door ${p.doorNumber} · ${p.invoiceNo}`}
                        onClick={() => useProductSuggestion(p.product)}
                      >
                        {p.product}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingProduct(p)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Product Prefix</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Expense Account</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Expense Memo (override)</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {productRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.product_prefix}
                            onBlur={(e) => updateProductField(r.id, "product_prefix", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.expense_account}
                            onBlur={(e) => updateProductField(r.id, "expense_account", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder="(uses raw memo text)"
                            defaultValue={r.expense_memo || ""}
                            onBlur={(e) => updateProductField(r.id, "expense_memo", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateProductField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "product_mappings" && confirmDelete.id === r.id ? (
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
                              onClick={() => setConfirmDelete({ table: "product_mappings", id: r.id })}
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
                          placeholder="e.g. Vantedge Program Membership Fees"
                          value={productDraft.product_prefix}
                          onChange={(e) => setProductDraft((d) => ({ ...d, product_prefix: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Other Services VIP"
                          value={productDraft.expense_account}
                          onChange={(e) => setProductDraft((d) => ({ ...d, expense_account: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={productDraft.expense_memo}
                          onChange={(e) => setProductDraft((d) => ({ ...d, expense_memo: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={productDraft.notes}
                          onChange={(e) => setProductDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addProductRow}>
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

              {pendingDoors.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  {pendingDoors.map((d) => (
                    <span key={d} style={styles.chip}>
                      <button style={styles.chipMain} onClick={() => useDoorSuggestion(d)}>
                        {d}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingDoor(d)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

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

            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Epay Account Mapping</div>
              <div style={styles.sectionSub}>
                A fallback for Epay Account Numbers that aren't in Store Master's "Epay" field yet — lets
                an Epay invoice still match a Company and QBO Class without adding a full store record.
              </div>

              {pendingAccounts.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  {pendingAccounts.map((a) => (
                    <span key={a} style={styles.chip}>
                      <button style={styles.chipMain} onClick={() => useAccountSuggestion(a)}>
                        {a}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingAccount(a)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Account Number</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Company Name</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>QBO Class</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.account_number}
                            onBlur={(e) => updateAccountField(r.id, "account_number", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.company_name}
                            onChange={(e) => updateAccountField(r.id, "company_name", e.target.value)}
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
                            onBlur={(e) => updateAccountField(r.id, "qbo_class", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateAccountField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "epay_account_mappings" && confirmDelete.id === r.id ? (
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
                              onClick={() => setConfirmDelete({ table: "epay_account_mappings", id: r.id })}
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
                          placeholder="e.g. 502329"
                          value={accountDraft.account_number}
                          onChange={(e) => setAccountDraft((d) => ({ ...d, account_number: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={accountDraft.company_name}
                          onChange={(e) => setAccountDraft((d) => ({ ...d, company_name: e.target.value }))}
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
                          placeholder="e.g. SP - Bridgeville-2307"
                          value={accountDraft.qbo_class}
                          onChange={(e) => setAccountDraft((d) => ({ ...d, qbo_class: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={accountDraft.notes}
                          onChange={(e) => setAccountDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addAccountRow}>
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
  pendingRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
    padding: "10px 12px",
    background: "var(--warn-bg)",
    borderRadius: 8,
  },
  pendingLabel: { fontSize: 11.5, fontWeight: 700, color: "var(--warn-text)", marginRight: 2 },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    background: "var(--field)",
    border: "1px solid var(--line)",
    borderRadius: 6,
    overflow: "hidden",
  },
  chipMain: {
    background: "transparent",
    border: "none",
    color: "var(--ink)",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    padding: "5px 8px",
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipDismiss: {
    background: "transparent",
    border: "none",
    borderLeft: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontSize: 12,
    padding: "5px 8px",
  },
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
