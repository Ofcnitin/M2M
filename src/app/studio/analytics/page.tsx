import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Analytics" };
type Data = { series_views: number; chapter_views: number; completions: number; unique_readers: number; followers: number; comments: number; daily: { day: string; views: number }[]; top_chapters: { id: string; series: string; chapter_number: number; views: number }[] };

export default async function Analytics({ searchParams }: { searchParams: { days?: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/studio/analytics");
  const days = [7, 30, 90].includes(Number(searchParams.days)) ? Number(searchParams.days) : 30;
  const { data } = await sb.rpc("creator_analytics", { p_days: days });
  const d = data as Data | null;
  const rate = d && d.chapter_views ? Math.round((d.completions / d.chapter_views) * 100) : 0;
  const max = Math.max(1, ...(d?.daily.map((x) => x.views) ?? [1]));
  const stat = (v: number | string, l: string) => <div className="neu-in p-5"><b className="block text-2xl">{v}</b><span className="text-sm text-mute">{l}</span></div>;
  return (
    <>
      <div className="mb-6 mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
        <div className="flex gap-2">{[7, 30, 90].map((n) => <Link key={n} href={`/studio/analytics?days=${n}`} aria-current={n === days} className={`btn ${n === days ? "font-semibold [box-shadow:inset_4px_4px_9px_var(--lo),inset_-4px_-4px_9px_var(--hi)]" : ""}`}>{n} days</Link>)}</div>
      </div>
      {d ? <>
        <div className="grid grid-cols-2 gap-5 md:grid-cols-3">
          {stat(d.series_views.toLocaleString(), "Series views")}{stat(d.chapter_views.toLocaleString(), "Chapter views")}{stat(d.unique_readers.toLocaleString(), "Signed-in readers")}
          {stat(`${rate}%`, "Completion rate")}{stat(d.followers.toLocaleString(), "Followers")}{stat(d.comments.toLocaleString(), "Comments")}
        </div>
        <section className="neu mt-8 p-7"><h2 className="font-semibold">Views over time</h2>
          <div className="mt-5 flex h-40 items-end gap-1" role="img" aria-label={`Daily views over the last ${days} days`}>
            {d.daily.map((x) => <div key={x.day} title={`${x.day}: ${x.views}`} className="min-w-[2px] flex-1 rounded-t bg-sky" style={{ height: `${Math.max(2, (x.views / max) * 100)}%` }} />)}
          </div></section>
        <section className="mt-8"><h2 className="mb-3 text-lg font-semibold">Top chapters</h2>
          {d.top_chapters.length ? <ul className="grid gap-3">{d.top_chapters.map((c) => <li key={c.id} className="neu-sm flex justify-between px-5 py-3 text-sm"><span>{c.series} · Chapter {Number(c.chapter_number)}</span><span className="text-mute">{c.views} views</span></li>)}</ul>
            : <p className="neu-in p-6 text-center text-sm text-mute">No chapter views in this period.</p>}</section>
        <p className="mt-6 text-xs text-mute">Unique readers counts signed-in readers only. Guests are counted in views but cannot be identified.</p>
      </> : <p className="neu-in p-8 text-center text-mute">Analytics are unavailable right now. Try again shortly.</p>}
    </>
  );
}
