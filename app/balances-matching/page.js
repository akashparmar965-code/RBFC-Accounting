"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import { savePageState, loadPageState } from "@/lib/pageState";
import { todayIso } from "@/lib/download";
import { sharedPageStyles } from "@/lib/pageStyles";

const STATE_KEY = "balancesMatching";

function pairKey(a, b) {
  return `${a}||${b}`;
}

function emptyPairRow() {
  return { amountA: "", amountB: "", notes: "" };
}

export default function BalancesMatchingPage() {
  const router = useRouter();
  const saved = useRef(loadPageState(STATE_KEY)).current;
  const [session, setSession] = useState(undefined);

  const [companies, setCompanies] = useState([]);
  const [asOfDate, setAsOfDate] = useState(saved?.asOfDate ?? todayIso());
  const [showOnlyMismatches, setShowOnlyMismatches] = useState(saved?.showOnlyMismatches ?? false);

  const [pairRows, setPairRows] = useState({}); // { [pairKey]: { amountA, amountB, notes } }
  const [gridLoading, setGridLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  useEffect(() => {
    savePageState(STATE_KEY, { asOfDate, showOnlyMismatches });
  }, [asOfDate, showOnlyMismatches]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("stores")
      .select("company_name")
      .order("company_name", { ascending: true })
      .then(({ data, error }) => {
        if (error) return;
        const unique = Array.from(new Set((data || []).map((r) => r.company_name).filter(Boolean)));
        setCompanies(unique);
      });
  }, [session]);

  // All unordered company pairs -- a fixed set generated from Store
  // Master, not a user-curated add/delete list like Product Mapping.
  // Missing a real pair here would silently hide a genuine intercompany
  // mismatch, so every company always gets matched against every other.
  const pairs = useMemo(() => {
    const list = [];
    for (let i = 0; i < companies.length; i++) {
      for (let j = i + 1; j < companies.length; j++) {
        list.push([companies[i], companies[j]]);
      }
    }
    return list;
  }, [companies]);

  const loadGrid = useCallback(async (dateStr, pairList) => {
    if (!dateStr || pairList.length === 0) return;
    setGridLoading(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("intercompany_balance_matching")
        .select("*")
        .eq("as_of_date", dateStr);
      if (error) throw new Error(error.message);
      const existingByPair = {};
      for (const row of data || []) existingByPair[pairKey(row.company_a, row.company_b)] = row;

      const next = {};
      for (const [a, b] of pairList) {
        const key = pairKey(a, b);
        const existing = existingByPair[key];
        next[key] = existing
          ? {
              amountA: existing.amount_a != null ? String(existing.amount_a) : "",
              amountB: existing.amount_b != null ? String(existing.amount_b) : "",
              notes: existing.notes || "",
            }
          : emptyPairRow();
      }
      setPairRows(next);
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setGridLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pairs.length > 0) loadGrid(asOfDate, pairs);
  }, [pairs, asOfDate, loadGrid]);

  function handleCellChange(key, field, value) {
    setPairRows((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const supabase = createClient();
      const rows = pairs.map(([a, b]) => {
        const key = pairKey(a, b);
        const row = pairRows[key] || emptyPairRow();
        const amountA = Number(row.amountA);
        const amountB = Number(row.amountB);
        return {
          as_of_date: asOfDate,
          company_a: a,
          company_b: b,
          amount_a: Number.isFinite(amountA) ? amountA : 0,
          amount_b: Number.isFinite(amountB) ? amountB : 0,
          notes: row.notes?.trim() || null,
        };
      });
      const { error } = await supabase
        .from("intercompany_balance_matching")
        .upsert(rows, { onConflict: "as_of_date,company_a,company_b" });
      if (error) throw new Error(error.message);
      setSaveMessage("Saved.");
    } catch (e) {
      setSaveError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  // Resets this date's grid back to blank -- doesn't touch anything
  // already Saved to Supabase until Save is clicked again.
  function handleClearData() {
    const next = {};
    for (const [a, b] of pairs) next[pairKey(a, b)] = emptyPairRow();
    setPairRows(next);
    setSaveMessage("");
    setSaveError("");
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  const pairsWithMismatch = pairs.filter(([a, b]) => {
    const row = pairRows[pairKey(a, b)];
    if (!row) return false;
    const amountA = Number(row.amountA) || 0;
    const amountB = Number(row.amountB) || 0;
    return Math.abs(amountA - amountB) >= 0.01;
  });

  const visiblePairs = showOnlyMismatches ? pairsWithMismatch : pairs;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <h1 style={styles.h1}>Balances Matching</h1>
          <p style={styles.pageSub}>
            Type in what each company's own books show as the intercompany balance with every other company, as of
            a date — pairs where the two sides don't agree are highlighted red below, by name.
          </p>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>1. As of Date & company-pair balances</h2>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>As of Date</span>
              <input
                type="date"
                style={styles.dateInput}
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
              />
            </label>
          </div>

          {gridLoading && <div style={styles.info}>Loading…</div>}
          {saveError && <div style={styles.errorBanner}>{saveError}</div>}

          {pairsWithMismatch.length > 0 && (
            <div style={styles.warnBanner}>
              {pairsWithMismatch.length} company pair(s) don't match:
              <ul style={styles.mismatchList}>
                {pairsWithMismatch.map(([a, b]) => {
                  const row = pairRows[pairKey(a, b)];
                  const amountA = Number(row.amountA) || 0;
                  const amountB = Number(row.amountB) || 0;
                  return (
                    <li key={pairKey(a, b)}>
                      <strong>{a}</strong> ↔ <strong>{b}</strong> — {amountA.toFixed(2)} vs {amountB.toFixed(2)} (off
                      by {(amountA - amountB).toFixed(2)})
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={showOnlyMismatches}
              onChange={(e) => setShowOnlyMismatches(e.target.checked)}
            />
            Show only mismatches
          </label>

          {!gridLoading && companies.length > 0 && (
            <>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Company A</th>
                      <th style={styles.th}>Company B</th>
                      <th style={styles.th}>Amount per Company A</th>
                      <th style={styles.th}>Amount per Company B</th>
                      <th style={styles.th}>Difference</th>
                      <th style={styles.th}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePairs.length === 0 ? (
                      <tr>
                        <td style={styles.td} colSpan={6}>
                          <span style={styles.info}>
                            {showOnlyMismatches ? "No mismatches — everything reconciles." : "No company pairs."}
                          </span>
                        </td>
                      </tr>
                    ) : (
                      visiblePairs.map(([a, b]) => {
                        const key = pairKey(a, b);
                        const row = pairRows[key] || emptyPairRow();
                        const amountA = Number(row.amountA) || 0;
                        const amountB = Number(row.amountB) || 0;
                        const mismatch = Math.abs(amountA - amountB) >= 0.01;
                        return (
                          <tr key={key} style={{ ...styles.tr, ...(mismatch ? styles.trMismatch : {}) }}>
                            <td
                              style={{ ...styles.td, fontWeight: 600, color: mismatch ? "var(--danger)" : undefined }}
                            >
                              {a}
                            </td>
                            <td
                              style={{ ...styles.td, fontWeight: 600, color: mismatch ? "var(--danger)" : undefined }}
                            >
                              {b}
                            </td>
                            <td style={styles.td}>
                              <input
                                type="number"
                                step="0.01"
                                style={styles.numInput}
                                value={row.amountA}
                                onChange={(e) => handleCellChange(key, "amountA", e.target.value)}
                              />
                            </td>
                            <td style={styles.td}>
                              <input
                                type="number"
                                step="0.01"
                                style={styles.numInput}
                                value={row.amountB}
                                onChange={(e) => handleCellChange(key, "amountB", e.target.value)}
                              />
                            </td>
                            <td
                              style={{
                                ...styles.td,
                                color: mismatch ? "var(--danger)" : undefined,
                                fontWeight: mismatch ? 700 : 400,
                              }}
                            >
                              {(amountA - amountB).toFixed(2)}
                              {mismatch && " ⚠"}
                            </td>
                            <td style={styles.td}>
                              <input
                                type="text"
                                style={styles.notesInput}
                                value={row.notes}
                                onChange={(e) => handleCellChange(key, "notes", e.target.value)}
                              />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              <div style={styles.actionsRow}>
                <button style={styles.saveBtn} onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                <button style={styles.clearAllBtn} onClick={handleClearData}>
                  Clear data
                </button>
                {saveMessage && <span style={styles.info}>{saveMessage}</span>}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

const styles = {
  ...sharedPageStyles,

  main: { flex: 1, padding: "36px 44px", maxWidth: 1300 },
  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 14px" },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 760 },

  fieldRow: { display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16 },
  fieldBlock: { display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 180 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    color: "var(--ink-soft)",
  },
  dateInput: {
    padding: "11px 12px",
    borderRadius: 8,
    border: "1px solid var(--line)",
    fontSize: 14,
    background: "var(--field)",
    color: "var(--ink)",
    maxWidth: 220,
  },

  info: { fontSize: 13, color: "var(--ink-soft)" },
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
    background: "var(--danger-bg)",
    color: "var(--danger)",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginTop: 12,
    marginBottom: 12,
    lineHeight: 1.5,
  },
  mismatchList: { margin: "8px 0 0", paddingLeft: 20, lineHeight: 1.6 },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    color: "var(--ink-soft)",
    fontWeight: 600,
    margin: "12px 0",
    cursor: "pointer",
  },

  tableWrap: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "auto",
    marginBottom: 14,
    maxHeight: 460,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: {
    textAlign: "left",
    padding: "9px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "6px 8px",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    whiteSpace: "nowrap",
  },
  trMismatch: { background: "var(--danger-bg)" },
  numInput: {
    width: 100,
    padding: "5px 6px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    background: "var(--field)",
    color: "var(--ink)",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
  },
  notesInput: {
    width: 160,
    padding: "5px 6px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    background: "var(--field)",
    color: "var(--ink)",
    fontFamily: "var(--font-body)",
    fontSize: 11.5,
  },

  actionsRow: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 6, alignItems: "center" },
  saveBtn: {
    background: "var(--ledger)",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "10px 18px",
    fontSize: 13,
    fontWeight: 600,
  },
  clearAllBtn: {
    background: "transparent",
    color: "var(--danger)",
    border: "1px solid var(--danger)",
    borderRadius: 6,
    padding: "5px 12px",
    fontSize: 11.5,
    fontWeight: 600,
  },
};
