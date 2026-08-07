"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import { SHARED_CONCEPTS, SOP_SECTIONS } from "@/lib/sopContent";
import { sharedPageStyles } from "@/lib/pageStyles";

export default function SopPage() {
  const router = useRouter();
  const [session, setSession] = useState(undefined);
  const [openSections, setOpenSections] = useState(new Set());

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [router]);

  function toggleSection(key) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function expandAll() {
    setOpenSections(new Set(SOP_SECTIONS.map((s) => s.key)));
  }

  function collapseAll() {
    setOpenSections(new Set());
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
          <h1 style={styles.h1}>SOP</h1>
          <p style={styles.pageSub}>
            How each accounting entry flows in this dashboard — where the source file comes from, how it's turned
            into raw data, and how the finished entry gets built and imported into QuickBooks. Written so anyone
            doing entry for RBFC can follow the logic, not just the clicks.
          </p>
        </div>

        <div style={styles.card}>
          <h2 style={styles.h2}>Shared concepts</h2>
          <p style={styles.sectionSub}>
            These ideas show up on almost every page below — understand these first and the rest reads much faster.
          </p>
          <div style={styles.conceptGrid}>
            {SHARED_CONCEPTS.map((c) => (
              <div key={c.term} style={styles.conceptCard}>
                <div style={styles.conceptTerm}>{c.term}</div>
                <div style={styles.conceptBody}>{c.body}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={styles.jumpRow}>
          <span style={styles.jumpLabel}>Jump to:</span>
          {SOP_SECTIONS.map((s) => (
            <a key={s.key} href={`#${s.key}`} style={styles.jumpLink}>
              {s.title}
            </a>
          ))}
        </div>

        <div style={styles.actionsRow}>
          <button style={styles.secondaryBtn} onClick={expandAll}>
            Expand all
          </button>
          <button style={styles.secondaryBtn} onClick={collapseAll}>
            Collapse all
          </button>
        </div>

        {SOP_SECTIONS.map((s) => (
          <div key={s.key} id={s.key} style={styles.sectionCard}>
            <div style={styles.sectionHeader} onClick={() => toggleSection(s.key)}>
              <div>
                <div style={styles.sectionTitle}>{s.title}</div>
                <div style={styles.sectionSub}>{s.summary}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Link href={s.route} style={styles.pageLink} onClick={(e) => e.stopPropagation()}>
                  Open page →
                </Link>
                <span style={styles.chevron}>{openSections.has(s.key) ? "▾" : "▸"}</span>
              </div>
            </div>

            {openSections.has(s.key) && (
              <div style={styles.sectionBody}>
                <div style={styles.subSection}>
                  <div style={styles.subSectionTitle}>1. Source</div>
                  <ul style={styles.list}>
                    {s.source.map((line, i) => (
                      <li key={i} style={styles.listItem}>
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>

                <div style={styles.subSection}>
                  <div style={styles.subSectionTitle}>2. Processing to raw data</div>
                  <ul style={styles.list}>
                    {s.processing.map((line, i) => (
                      <li key={i} style={styles.listItem}>
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>

                <div style={styles.subSection}>
                  <div style={styles.subSectionTitle}>3. Finalize & upload to QuickBooks</div>
                  <ul style={styles.list}>
                    {s.finalize.map((line, i) => (
                      <li key={i} style={styles.listItem}>
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>

                {s.watchFor && s.watchFor.length > 0 && (
                  <div style={styles.watchForBox}>
                    <div style={styles.watchForTitle}>⚠ Watch for</div>
                    <ul style={styles.list}>
                      {s.watchFor.map((line, i) => (
                        <li key={i} style={styles.listItem}>
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </main>
    </div>
  );
}

const styles = {
  ...sharedPageStyles,

  main: { flex: 1, padding: "36px 44px", maxWidth: 1100 },

  h2: { fontFamily: "var(--font-display)", fontSize: 16, margin: "0 0 6px" },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 760, lineHeight: 1.6 },

  sectionSub: { fontSize: 12.5, color: "var(--ink-soft)", marginBottom: 14, lineHeight: 1.5, maxWidth: 720 },

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
  },
  conceptTerm: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13, marginBottom: 4 },
  conceptBody: { fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.55 },

  jumpRow: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "20px 0 14px" },
  jumpLabel: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-soft)" },
  jumpLink: {
    fontSize: 12.5,
    color: "var(--ledger)",
    textDecoration: "none",
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: "4px 10px",
  },

  actionsRow: { display: "flex", gap: 10, marginBottom: 16 },
  secondaryBtn: {
    background: "transparent",
    color: "var(--ink)",
    border: "1px solid var(--line)",
    borderRadius: 5,
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
  },

  sectionCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    marginBottom: 12,
    overflow: "hidden",
    scrollMarginTop: 20,
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 18px",
    cursor: "pointer",
    gap: 12,
  },
  sectionTitle: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, marginBottom: 3 },
  chevron: { color: "var(--ink-soft)", fontSize: 12 },
  pageLink: { fontSize: 12, color: "var(--ledger)", fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" },

  sectionBody: { padding: "0 18px 18px" },
  subSection: { marginBottom: 14 },
  subSectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--ink-soft)",
    marginBottom: 6,
  },
  list: { margin: 0, paddingLeft: 20 },
  listItem: { fontSize: 13, lineHeight: 1.6, marginBottom: 5 },

  watchForBox: {
    background: "var(--warn-bg)",
    borderRadius: 8,
    padding: "12px 14px",
    marginTop: 4,
  },
  watchForTitle: { fontSize: 11.5, fontWeight: 700, color: "var(--warn-text)", marginBottom: 6 },
};
