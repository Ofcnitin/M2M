"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

const STATUSES = [["reading", "Reading"], ["plan_to_read", "Plan to read"], ["completed", "Completed"], ["on_hold", "On hold"], ["dropped", "Dropped"]];

export function SeriesActions({ seriesId, creatorId }: { seriesId: string; creatorId: string }) {
  const router = useRouter();
  const sb = supabaseBrowser();
  const [uid, setUid] = useState<string | null>(null);
  const [lib, setLib] = useState<string>("");
  const [following, setFollowing] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => { (async () => {
    const { data: { user } } = await sb.auth.getUser(); if (!user) return; setUid(user.id);
    const { data: l } = await sb.from("library").select("reading_status").eq("series_id", seriesId).maybeSingle(); setLib(l?.reading_status ?? "");
    const { data: f } = await sb.from("follows").select("creator_id").eq("creator_id", creatorId).maybeSingle(); setFollowing(!!f);
  })(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const need = () => { if (!uid) { router.push(`/login?next=${encodeURIComponent(location.pathname)}`); return true; } return false; };
  async function setStatus(v: string) {
    if (need()) return;
    if (!v) await sb.from("library").delete().eq("series_id", seriesId);
    else await sb.from("library").upsert({ user_id: uid!, series_id: seriesId, reading_status: v });
    setLib(v);
  }
  async function follow() {
    if (need()) return;
    if (following) await sb.from("follows").delete().eq("creator_id", creatorId);
    else await sb.from("follows").insert({ user_id: uid!, creator_id: creatorId });
    setFollowing(!following);
  }
  async function report(reason: string) {
    if (!reason || need()) return;
    const { error } = await sb.from("reports").insert({ reporter_id: uid!, target_type: "series", target_id: seriesId, reason });
    setMsg(error ? "Could not send the report." : "Report sent. Our team will review it.");
  }
  const sel = "btn bg-transparent";
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <select aria-label="Library status" value={lib} onChange={(e) => setStatus(e.target.value)} className={sel}>
        <option value="" className="text-black">Add to library</option>
        {STATUSES.map(([v, l]) => <option key={v} value={v} className="text-black">{l}</option>)}
      </select>
      <button className="btn" onClick={follow} aria-pressed={following}>{following ? "Following" : "Follow creator"}</button>
      <button className="btn" onClick={async () => { try { await navigator.share?.({ url: location.href, title: document.title }); } catch {} }}>Share</button>
      <select aria-label="Report publication" defaultValue="" onChange={(e) => { report(e.target.value); e.target.value = ""; }} className={sel}>
        <option value="" className="text-black">Report</option>
        {["Copyright", "Prohibited content", "Harassment", "Spam"].map((r) => <option key={r} value={r} className="text-black">{r}</option>)}
      </select>
      {msg && <span role="status" className="text-sm text-mute">{msg}</span>}
    </div>
  );
}
