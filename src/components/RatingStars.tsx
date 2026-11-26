"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { formatRating } from "@/lib/format";

// Readers rate 1 to 5. Creators cannot rate their own series (enforced by RLS too).
export function RatingStars({ seriesId, creatorId, avg, count }: { seriesId: string; creatorId: string; avg: number; count: number }) {
  const router = useRouter();
  const [uid, setUid] = useState<string | null>(null);
  const [mine, setMine] = useState(0);
  const [hover, setHover] = useState(0);
  const [msg, setMsg] = useState("");

  useEffect(() => { (async () => {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser(); if (!user) return; setUid(user.id);
    const { data } = await sb.from("ratings").select("score").eq("series_id", seriesId).maybeSingle();
    setMine(data?.score ?? 0);
  })(); }, [seriesId]);

  async function rate(score: number) {
    if (!uid) return router.push(`/login?next=${encodeURIComponent(location.pathname)}`);
    const sb = supabaseBrowser();
    const clear = score === mine; // tapping your current score removes it
    const { error } = clear
      ? await sb.from("ratings").delete().eq("series_id", seriesId).eq("user_id", uid)
      : await sb.from("ratings").upsert({ user_id: uid, series_id: seriesId, score, updated_at: new Date().toISOString() });
    if (error) return setMsg("Could not save your rating.");
    setMsg(clear ? "Rating removed." : "Thanks for rating."); setMine(clear ? 0 : score); router.refresh();
  }

  const own = uid === creatorId, shown = hover || mine;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div role="radiogroup" aria-label="Your rating" className="flex" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={mine === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} disabled={own}
            onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)} onClick={() => rate(n)}
            className={`px-0.5 text-2xl leading-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky disabled:opacity-40 ${n <= shown ? "text-sky" : "text-mute"}`}>
            {n <= shown ? "★" : "☆"}
          </button>))}
      </div>
      <span className="text-sm text-mute">{formatRating(avg, count)}</span>
      {own && <span className="text-xs text-mute">You can&apos;t rate your own series.</span>}
      {msg && <span role="status" className="text-xs text-mute">{msg}</span>}
    </div>
  );
}
