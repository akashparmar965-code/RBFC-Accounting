"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/stores");
    router.refresh();
  }

  return (
    <main style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.brandRow}>
          <div style={styles.mark}>SO</div>
          <div>
            <div style={styles.brandTitle}>Store Ops</div>
            <div style={styles.brandSub}>Ledger &amp; store master</div>
          </div>
        </div>

        <h1 style={styles.heading}>Sign in</h1>
        <p style={styles.subheading}>Use the team login your admin set up in Supabase.</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={styles.input}
              placeholder="you@company.com"
            />
          </label>
          <label style={styles.label}>
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={styles.input}
              placeholder="••••••••"
            />
          </label>

          {error && <div style={styles.error}>{error}</div>}

          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p style={styles.hint}>
          No account yet? Add team members from Supabase Dashboard → Authentication → Users →
          Add user.
        </p>
      </div>
    </main>
  );
}

const styles = {
  wrap: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--paper)",
    padding: 24,
  },
  card: {
    width: 380,
    maxWidth: "100%",
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    padding: 32,
  },
  brandRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 28 },
  mark: {
    width: 36,
    height: 36,
    borderRadius: 8,
    background: "var(--ledger)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    fontWeight: 500,
  },
  brandTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15 },
  brandSub: { fontSize: 12, color: "var(--ink-soft)" },
  heading: { fontFamily: "var(--font-display)", fontSize: 22, margin: "0 0 4px" },
  subheading: { fontSize: 13, color: "var(--ink-soft)", margin: "0 0 24px" },
  form: { display: "flex", flexDirection: "column", gap: 16 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 500 },
  input: {
    padding: "10px 12px",
    borderRadius: 6,
    border: "1px solid var(--line)",
    fontSize: 14,
    fontFamily: "var(--font-body)",
  },
  error: {
    fontSize: 13,
    color: "var(--danger)",
    background: "#fbeeea",
    padding: "8px 10px",
    borderRadius: 6,
  },
  button: {
    marginTop: 4,
    padding: "11px 16px",
    borderRadius: 6,
    border: "none",
    background: "var(--ledger)",
    color: "#fff",
    fontWeight: 600,
    fontSize: 14,
  },
  hint: { fontSize: 12, color: "var(--ink-soft)", marginTop: 20, lineHeight: 1.5 },
};
