"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import StoreMasterPanel from "@/components/StoreMasterPanel";

export default function StoresPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out

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

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />
      <main style={styles.main}>
        <StoreMasterPanel />
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
    fontFamily: "var(--font-body)",
  },
  shell: { display: "flex", minHeight: "100vh" },
  main: { flex: 1, padding: "36px 44px", maxWidth: 1200 },
};
