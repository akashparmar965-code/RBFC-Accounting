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

export default function SopPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [session, setSession] = useState(undefined);
  const [concepts, setConcepts] = useState([]);
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openSections, setOpenSections] = useState(new Set());

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
  }, [supabase, router]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    const [conceptsRes, sectionsRes] = await Promise.all([
      supabase.from("sop_shared_concepts").select("*").order("sort_order", { ascending: true }),
      supabase.from("sop_sections").select("*").order("sort_order", { ascending: true }),
    ]);
    if (conceptsRes.error) setError(conceptsRes.error.message);
    else setConcepts(conceptsRes.data || []);
    if (sectionsRes.error) setError(sectionsRes.error.message);
    else setSections(sectionsRes.data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (session) loadAll();
  }, [session, loadAll]);

  async function updateConceptField(id, field, value) {
    setConcepts((prev) => prev.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
    const { error } = await supabase.from("sop_shared_concepts").update({ [field]: value }).eq("id", id);
    if (error) setError(error.message);
  }

  async function updateSectionField(id, field, value) {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
    const { error } = await supabase.from("sop_sections").update({ [field]: value }).eq("id", id);
    if (error) setError(error.message);
  }

  function toggleSection(key) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function expandAll() {
    setOpenSections(new Set(sections.map((s) => s.key)));
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
            How each accounting entry flows in this dashboard — where the source file comes from, what to include
            or exclude when creating it, why the entry exists, and how the finished entry gets built and imported
            into QuickBooks. Every field below is editable — click in and type, it saves when you click away.
          </p>
        </div>

        {error && <div style={styles.errorBanner}>{error}</div>}

        {loading ? (
          <div style={styles.emptyState}>Loading…</div>
        ) : (
          <>
            <div style={styles.card}>
              <h2 style={styles.h2}>Shared concepts</h2>
              <p style={styles.sectionSub}>
                These ideas show up on almost every page below — understand these first and the rest reads much
                faster.
              </p>
              <div style={styles.conceptGrid}>
                {concepts.map((c) => (
                  <div key={c.id} style={styles.conceptCard}>
                    <input
                      style={styles.conceptTermInput}
                      defaultValue={c.term}
                      onBlur={(e) => updateConceptField(c.id, "term", e.target.value)}
                    />
                    <textarea
                      style={styles.conceptBodyInput}
                      defaultValue={c.body}
                      onBlur={(e) => updateConceptField(c.id, "body", e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div style={styles.jumpRow}>
              <span style={styles.jumpLabel}>Jump to:</span>
              {sections.map((s) => (
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

            {sections.map((s) => (
              <div key={s.key} id={s.key} style={styles.sectionCard}>
                <div style={styles.sectionHeader} onClick={() => toggleSection(s.key)}>
                  <div style={{ flex: 1 }}>
                    <input
                      style={styles.titleInput}
                      defaultValue={s.title}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => updateSectionField(s.id, "title", e.target.value)}
                    />
                    <input
                      style={styles.summaryInput}
                      defaultValue={s.summary}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => updateSectionField(s.id, "summary", e.target.value)}
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {s.route && (
                      <Link href={s.route} style={styles.pageLink} onClick={(e) => e.stopPropagation()}>
                        Open page →
                      </Link>
                    )}
                    <span style={styles.chevron}>{openSections.has(s.key) ? "▾" : "▸"}</span>
                  </div>
                </div>

                {openSections.has(s.key) && (
                  <div style={styles.sectionBody}>
                    {SECTION_FIELDS.map((f) => (
                      <div key={f.key} style={styles.subSection}>
                        <div style={styles.subSectionTitle}>{f.label}</div>
                        <div style={styles.subSectionHint}>{f.hint}</div>
                        <textarea
                          style={styles.fieldTextarea}
                          defaultValue={s[f.key] || ""}
                          onBlur={(e) => updateSectionField(s.id, f.key, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
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
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  conceptTermInput: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 13,
    background: "transparent",
    border: "none",
    borderBottom: "1px solid var(--line)",
    padding: "2px 0 6px",
    color: "var(--ink)",
  },
  conceptBodyInput: {
    fontSize: 12,
    color: "var(--ink)",
    lineHeight: 1.55,
    background: "transparent",
    border: "none",
    resize: "vertical",
    minHeight: 90,
    fontFamily: "var(--font-body)",
    padding: 0,
  },

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
  titleInput: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 15,
    background: "transparent",
    border: "none",
    color: "var(--ink)",
    width: "100%",
    padding: "2px 0",
  },
  summaryInput: {
    fontSize: 12.5,
    color: "var(--ink-soft)",
    background: "transparent",
    border: "none",
    width: "100%",
    padding: "2px 0",
  },
  chevron: { color: "var(--ink-soft)", fontSize: 12 },
  pageLink: { fontSize: 12, color: "var(--ledger)", fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" },

  sectionBody: { padding: "0 18px 18px" },
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
};
