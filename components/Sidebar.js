"use client";

import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";

const NAV = [
  { href: "/stores", label: "Store Master", ready: true },
  { href: "/jv-entry", label: "JV Entry", ready: true },
  { href: "/bills", label: "Bills", ready: true },
  { href: "/checklist", label: "Checklist", ready: true },
  { href: "/mappings", label: "Mapping Master", ready: true },
  { href: "#", label: "Payroll Upload — soon", ready: false },
  { href: "#", label: "Expenses Upload — soon", ready: false },
];

export default function Sidebar({ userEmail }) {
  const router = useRouter();
  const pathname = usePathname();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <aside style={styles.sidebar}>
      <div style={styles.sidebarBrand}>
        <div style={styles.mark}>SO</div>
        <div>
          <div style={styles.brandTitle}>Store Ops</div>
          <div style={styles.brandSub}>{userEmail}</div>
        </div>
      </div>

      <nav style={styles.nav}>
        {NAV.map((item) =>
          item.ready ? (
            <div
              key={item.label}
              onClick={() => router.push(item.href)}
              style={{
                ...styles.navItem,
                ...(pathname === item.href ? styles.navItemActive : {}),
              }}
            >
              {item.label}
            </div>
          ) : (
            <div key={item.label} style={styles.navItemDisabled}>
              {item.label}
            </div>
          )
        )}
      </nav>

      <button onClick={handleSignOut} style={styles.signOutBtn}>
        Sign out
      </button>
    </aside>
  );
}

const styles = {
  sidebar: {
    width: 240,
    background: "var(--sidebar)",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    padding: "24px 18px",
    flexShrink: 0,
    minHeight: "100vh",
  },
  sidebarBrand: { display: "flex", alignItems: "center", gap: 10, marginBottom: 32 },
  mark: {
    width: 32,
    height: 32,
    borderRadius: 7,
    background: "var(--ledger)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    flexShrink: 0,
  },
  brandTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14 },
  brandSub: { fontSize: 11, color: "var(--sidebar-soft)", marginTop: 2, wordBreak: "break-all" },
  nav: { display: "flex", flexDirection: "column", gap: 4, flex: 1 },
  navItem: {
    padding: "9px 12px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    color: "var(--sidebar-soft)",
  },
  navItemActive: { background: "var(--ledger)", color: "#fff" },
  navItemDisabled: {
    padding: "9px 12px",
    borderRadius: 6,
    fontSize: 13,
    color: "#4a515e",
  },
  signOutBtn: {
    background: "none",
    border: "1px solid #2a303b",
    color: "var(--sidebar-soft)",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 13,
  },
};
