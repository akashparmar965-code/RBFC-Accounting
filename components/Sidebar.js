"use client";

import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { clearPendingMappings } from "@/lib/pendingMappings";

const NAV = [
  { href: "/sales", label: "Sales", ready: true },
  { href: "/bills", label: "Bills", ready: true },
  { href: "/checklist", label: "Checklist", ready: true },
  { href: "/payroll", label: "Payroll", ready: true },
  { href: "/inventory", label: "Change in Inventory", ready: true },
  { href: "/store-transfer", label: "Store Transfer", ready: true },
  { href: "#", label: "Expenses Upload — soon", ready: false },
];

const UTILITY_NAV = [{ href: "/mappings", label: "Mapping Master", ready: true }];

export default function Sidebar({ userEmail }) {
  const router = useRouter();
  const pathname = usePathname();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    clearPendingMappings();
    router.push("/login");
  }

  function renderItem(item) {
    return item.ready ? (
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
    );
  }

  return (
    <aside style={styles.sidebar}>
      <div style={styles.sidebarBrand}>
        <div style={styles.mark}>AD</div>
        <div>
          <div style={styles.brandTitle}>Accounting Dashboard</div>
          <div style={styles.brandSub}>{userEmail}</div>
        </div>
      </div>

      <nav style={styles.nav}>{NAV.map(renderItem)}</nav>

      <div style={styles.utilityNav}>
        {UTILITY_NAV.map(renderItem)}
        <button onClick={handleSignOut} style={styles.signOutBtn}>
          Sign out
        </button>
      </div>
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
    height: "100vh",
    position: "sticky",
    top: 0,
    alignSelf: "flex-start",
    overflowY: "auto",
  },
  sidebarBrand: { display: "flex", alignItems: "center", gap: 10, marginBottom: 32, flexShrink: 0 },
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
    fontWeight: 600,
    fontSize: 12,
    flexShrink: 0,
  },
  brandTitle: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 14.5, color: "#fff", letterSpacing: "0.01em" },
  brandSub: { fontSize: 11, color: "var(--sidebar-soft)", marginTop: 3, wordBreak: "break-all", lineHeight: 1.4 },
  nav: { display: "flex", flexDirection: "column", gap: 3, flex: 1 },
  navItem: {
    padding: "10px 14px",
    borderRadius: 7,
    fontSize: 13.5,
    fontWeight: 500,
    lineHeight: 1.3,
    cursor: "pointer",
    color: "var(--sidebar-soft)",
    letterSpacing: "0.005em",
  },
  navItemActive: { background: "var(--ledger)", color: "#fff", fontWeight: 600 },
  navItemDisabled: {
    padding: "10px 14px",
    borderRadius: 7,
    fontSize: 13.5,
    fontWeight: 500,
    color: "#454b57",
  },
  utilityNav: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    paddingTop: 14,
    marginTop: 14,
    borderTop: "1px solid #1c212b",
    flexShrink: 0,
  },
  signOutBtn: {
    background: "none",
    border: "1px solid #2a303b",
    color: "var(--sidebar-soft)",
    borderRadius: 7,
    padding: "9px 14px",
    fontSize: 13.5,
    fontWeight: 500,
    fontFamily: "var(--font-body)",
  },
};
