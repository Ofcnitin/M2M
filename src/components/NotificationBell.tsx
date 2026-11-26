"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export function NotificationBell() {
  const path = usePathname();
  const [n, setN] = useState(0);
  const load = useCallback(async () => {
    const { count } = await supabaseBrowser().from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
    setN(count ?? 0);
  }, []);
  useEffect(() => { load(); }, [load, path]);
  useEffect(() => {
    const t = setInterval(load, 60_000);
    addEventListener("m2m:notifications", load);
    return () => { clearInterval(t); removeEventListener("m2m:notifications", load); };
  }, [load]);
  return (
    <Link href="/notifications" className="btn" aria-label={n ? `Notifications, ${n} unread` : "Notifications"}>
      Alerts{n > 0 && <span className="ml-2 rounded-full bg-sky px-1.5 py-0.5 text-xs font-semibold text-black">{n > 99 ? "99+" : n}</span>}
    </Link>
  );
}
