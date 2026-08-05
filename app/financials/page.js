"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import {
  parsePLWorkbook,
  parsePLRows,
  parsePeriodFromFileName,
  parseYearMonthIso,
  monthLabel,
  resolveStoreColumns,
} from "@/lib/financialsProcessor";
import { currentMonthIso } from "@/lib/fileNaming";
import { buildStoreNameMap } from "@/lib/storeNameMapping";
import { savePendingMappings } from "@/lib/pendingMappings";
import { savePageState, loadPageState } from "@/lib/pageState";
import { sharedPageStyles } from "@/lib/pageStyles";

const STATE_KEY = "financials";

export default function FinancialsPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const saved = useRef(loadPageState(STATE_KEY)).current;

  const [periodMonth, setPeriodMonth] = useState(saved?.periodMonth ?? currentMonthIso());
  const [storeMaster, setStoreMaster] = useState(null);
  const [storeMasterError, setStoreMasterError] = useState("");
  const [storeNameMap, setStoreNameMap] = useState({});

  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const [uploadResults, setUploadResults] = useState([]); // [{ fileName, error, filePeriod, storesTotal, storesMatched, unmatchedColumns, linesImported, newAccountsAdded }]
  const fileInputRef = useRef(null);

  useEffect(() => {
    savePageState(STATE_KEY, { periodMonth });
  }, [periodMonth]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("stores")
      .select("*")
      .then(({ data, error }) => {
        if (error) setStoreMasterError("Could not load Store Master: " + error.message);
        else setStoreMaster(data || []);
      });
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const supabase = createClient();
    supabase
      .from("store_name_mappings")
      .select("*")
      .then(({ data, error }) => {
        if (error) return;
        setStoreNameMap(buildStoreNameMap(data || []));
      });
  }, [session]);

  const handleFinancialFiles = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const expected = parseYearMonthIso(periodMonth);
      if (!expected) return;
      if (!storeMaster) {
        setProcessError("Store Master hasn't loaded yet — try again in a moment.");
        return;
      }

      setProcessing(true);
      setProcessError("");
      const supabase = createClient();
      const results = [];

      try {
        let periodId;
        const { data: existingPeriod, error: periodFetchError } = await supabase
          .from("fin_periods")
          .select("id")
          .eq("period_year", expected.year)
          .eq("period_month", expected.month)
          .maybeSingle();
        if (periodFetchError) throw new Error(periodFetchError.message);
        if (existingPeriod) {
          periodId = existingPeriod.id;
        } else {
          const { data: createdPeriod, error: periodInsertError } = await supabase
            .from("fin_periods")
            .insert([
              {
                period_year: expected.year,
                period_month: expected.month,
                period_label: monthLabel(expected.year, expected.month),
              },
            ])
            .select()
            .single();
          if (periodInsertError) throw new Error(periodInsertError.message);
          periodId = createdPeriod.id;
        }

        const { data: accountRows, error: accountsError } = await supabase.from("fin_accounts").select("*");
        if (accountsError) throw new Error(accountsError.message);
        const accountsByName = {};
        for (const a of accountRows || []) accountsByName[a.account_name.toLowerCase()] = a;

        for (const file of files) {
          try {
            const buffer = await file.arrayBuffer();
            const rawRows = parsePLWorkbook(buffer);
            const { storeColumns, lines } = parsePLRows(rawRows);

            const filePeriod = parsePeriodFromFileName(file.name);
            if (filePeriod && (filePeriod.year !== expected.year || filePeriod.month !== expected.month)) {
              throw new Error(
                `This file's period (${filePeriod.label}) doesn't match the selected Month (${monthLabel(
                  expected.year,
                  expected.month
                )}) — not loaded. Pick the correct Month or upload the correct file.`
              );
            }

            const { storeIdByColumn, unmatchedColumns } = resolveStoreColumns(storeColumns, storeMaster, storeNameMap);

            const seen = new Set();
            const toInsert = [];
            for (const line of lines) {
              const key = line.accountName.toLowerCase();
              if (accountsByName[key] || seen.has(key)) continue;
              seen.add(key);
              toInsert.push({
                account_name: line.accountName,
                section: line.section,
                is_subtotal: line.isSubtotal,
                sort_order: line.sortOrder,
              });
            }
            if (toInsert.length > 0) {
              const { data: insertedAccounts, error: acctError } = await supabase.from("fin_accounts").insert(toInsert).select();
              if (acctError) throw new Error(acctError.message);
              for (const a of insertedAccounts) accountsByName[a.account_name.toLowerCase()] = a;
            }

            const statementRows = [];
            for (const line of lines) {
              const account = accountsByName[line.accountName.toLowerCase()];
              for (const [storeCol, amount] of Object.entries(line.values)) {
                const storeId = storeIdByColumn[storeCol];
                if (!storeId) continue;
                statementRows.push({ period_id: periodId, store_id: storeId, account_id: account.id, amount });
              }
            }
            if (statementRows.length > 0) {
              const { error: upsertError } = await supabase
                .from("fin_statement_lines")
                .upsert(statementRows, { onConflict: "period_id,store_id,account_id" });
              if (upsertError) throw new Error(upsertError.message);
            }

            results.push({
              fileName: file.name,
              error: null,
              filePeriod,
              storesTotal: storeColumns.length,
              storesMatched: storeColumns.length - unmatchedColumns.length,
              unmatchedColumns,
              linesImported: statementRows.length,
              newAccountsAdded: toInsert.map((a) => a.account_name),
            });
            if (unmatchedColumns.length > 0) savePendingMappings({ unmatchedStoreNames: unmatchedColumns });
          } catch (e) {
            results.push({ fileName: file.name, error: e.message || String(e) });
          }
        }
      } catch (e) {
        setProcessError(e.message || String(e));
      } finally {
        setUploadResults((prev) => [...results, ...prev]);
        setProcessing(false);
      }
    },
    [periodMonth, storeMaster, storeNameMap]
  );

  function handleFileChange(e) {
    handleFinancialFiles(e.target.files);
    e.target.value = "";
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFinancialFiles(e.dataTransfer.files);
  }

  function handleClearResults() {
    setUploadResults([]);
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
            <h1 style={styles.h1}>Financial Statements</h1>
            <p style={styles.pageSub}>
              Upload monthly P&amp;L-by-Class exports to build the data behind a financial analysis dashboard.
              This page loads the raw numbers in — the dashboard views come next once a few months of data are
              in.
            </p>
          </div>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>1. Month &amp; upload</h2>
          <div style={styles.fieldRow}>
            <label style={styles.fieldBlock}>
              <span style={styles.fieldLabel}>Month</span>
              <input type="month" style={styles.dateInput} value={periodMonth} onChange={(e) => setPeriodMonth(e.target.value)} />
            </label>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            multiple
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
            <div style={styles.dropzoneIcon}>📄</div>
            <div style={styles.dropzoneText}>
              Choose or drop one or more P&amp;L-by-Class exports (.xlsx/.csv) — one file per company, e.g.
              "PA_JAN_2026.CSV"
            </div>
          </div>
          <div style={styles.info}>
            Each file's own period (from its file name) is checked against the selected Month; a mismatch is
            rejected, not loaded. Store columns are matched to Store Master (falling back to Store Mapping) —
            unmatched columns are flagged, never guessed. New account names are added to Mapping Master's
            "Financial Accounts" tab automatically the first time they're seen.
          </div>

          {storeMasterError && <div style={styles.errorBanner}>{storeMasterError}</div>}
          {processError && <div style={styles.errorBanner}>{processError}</div>}
          {processing && <div style={styles.info}>Processing…</div>}

          {uploadResults.length > 0 && (
            <div style={styles.resultsList}>
              <div style={styles.resultsHeader}>
                <button style={styles.clearAllBtn} onClick={handleClearResults}>
                  Clear list
                </button>
              </div>
              {uploadResults.map((r, i) => (
                <div key={i} style={styles.resultRow}>
                  <span style={styles.resultFileName}>{r.fileName}</span>
                  {r.error ? (
                    <span style={styles.resultError}>{r.error}</span>
                  ) : (
                    <span style={styles.resultOk}>
                      → {r.storesMatched}/{r.storesTotal} store(s) matched · {r.linesImported} line(s) imported
                      {r.filePeriod && ` · ${r.filePeriod.label}`}
                      {r.newAccountsAdded.length > 0 && ` · ${r.newAccountsAdded.length} new account(s) added`}
                      {r.unmatchedColumns.length > 0 &&
                        ` — ⚠ ${r.unmatchedColumns.length} unmatched store column(s): ${r.unmatchedColumns.join(", ")}`}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {uploadResults.some((r) => r.unmatchedColumns?.length > 0) && (
            <div style={styles.warnBanner}>
              Some store columns didn't match any store — add them in{" "}
              <Link href="/mappings" style={styles.inlineLink}>
                Store Mapping
              </Link>{" "}
              (or add the store in Store Master), then re-upload.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const styles = {
  ...sharedPageStyles,

  main: { flex: 1, padding: "36px 44px", maxWidth: 1200 },

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

  info: { fontSize: 13, color: "var(--ink-soft)", marginTop: 12 },
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
    background: "var(--warn-bg)",
    color: "var(--warn-text)",
    padding: "12px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginTop: 12,
    lineHeight: 1.5,
  },
  inlineLink: { textDecoration: "underline", fontWeight: 600 },

  resultsList: { display: "flex", flexDirection: "column", gap: 6, marginTop: 14 },
  resultsHeader: { display: "flex", justifyContent: "flex-end" },
  clearAllBtn: {
    background: "transparent",
    color: "var(--danger)",
    border: "1px solid var(--danger)",
    borderRadius: 6,
    padding: "5px 12px",
    fontSize: 11.5,
    fontWeight: 600,
  },
  resultRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    padding: "6px 10px",
    borderRadius: 6,
    background: "var(--field)",
    border: "1px solid var(--line)",
  },
  resultFileName: { fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--ink-soft)" },
  resultOk: { color: "var(--ledger)" },
  resultError: { color: "var(--danger)" },
};
