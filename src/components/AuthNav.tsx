"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { NotificationBell } from "./NotificationBell";

export function AuthNav() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const sb = supabaseBrowser();
    sb.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setEmail(s?.user.email ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  if (email === undefined) return null;
  return email ? (
    <div className="flex gap-2">
      <NotificationBell />
      <button className="btn" onClick={async () => { await supabaseBrowser().auth.signOut(); router.push("/"); router.refresh(); }}>Sign out</button>
    </div>
  ) : <Link href="/login" className="btn">Sign in</Link>;
}
