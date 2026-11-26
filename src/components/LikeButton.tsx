"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export function LikeButton({ type, id }: { type: "series" | "comment"; id: string }) {
  const router = useRouter();
  const [n, setN] = useState(0);
  const [mine, setMine] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  useEffect(() => { (async () => {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser(); setUid(user?.id ?? null);
    const { data } = await sb.from("likes").select("user_id").eq("target_type", type).eq("target_id", id);
    setN(data?.length ?? 0); setMine(!!user && !!data?.some((l) => l.user_id === user.id));
  })(); }, [type, id]);
  async function toggle() {
    if (!uid) return router.push(`/login?next=${encodeURIComponent(location.pathname)}`);
    const sb = supabaseBrowser();
    if (mine) await sb.from("likes").delete().eq("target_type", type).eq("target_id", id);
    else await sb.from("likes").insert({ user_id: uid, target_type: type, target_id: id });
    setMine(!mine); setN(n + (mine ? -1 : 1));
  }
  return <button className="btn" aria-pressed={mine} onClick={toggle}>{mine ? "Liked" : "Like"} · {n}</button>;
}
