import Link from "next/link";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { SeriesCard } from "@/components/SeriesCard";

export const metadata = { title: "Library" };
const TABS = [["reading", "Reading"], ["plan_to_read", "Plan to read"], ["completed", "Completed"], ["on_hold", "On hold"], ["dropped", "Dropped"]];
const SORTS = [["added", "Recently added"], ["updated", "Recently updated"], ["title", "Title"], ["rating", "Highest rated"]];

export default async function Library({ searchParams }: { searchParams: { s?: string; sort?: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/library");
  const status = TABS.some(([v]) => v === searchParams.s) ? searchParams.s! : "reading";
  const sort = SORTS.some(([v]) => v === searchParams.sort) ? searchParams.sort! : "added";
  const { data } = await sb.from("library")
    .select("added_at,series(id,slug,title,cover_url,content_format,content_rating,rating_avg,rating_count,updated_at,profiles(display_name))")
    .eq("reading_status", status).order("added_at", { ascending: false });
  const rows = ((data as any[]) ?? []).filter((r) => r.series); // a series can disappear (archived) while still in a library
  // A library is small, so sorting in memory is simpler than ordering across the join.
  if (sort === "title") rows.sort((a, b) => a.series.title.localeCompare(b.series.title));
  else if (sort === "updated") rows.sort((a, b) => +new Date(b.series.updated_at) - +new Date(a.series.updated_at));
  else if (sort === "rating") rows.sort((a, b) => Number(b.series.rating_avg) - Number(a.series.rating_avg));
  const { data: hist } = await sb.from("reading_progress").select("chapter_id,updated_at,series(title)").eq("completed", false).order("updated_at", { ascending: false }).limit(5);
  const tab = (v: string) => `/library?s=${v}${sort !== "added" ? `&sort=${sort}` : ""}`;
  return (
    <>
      <h1 className="mb-5 mt-4 text-3xl font-bold tracking-tight">Your library</h1>
      {!!hist?.length && <section className="mb-8"><h2 className="mb-3 text-lg font-semibold">Continue reading</h2>
        <div className="flex flex-wrap gap-3">{hist.map((h: any) => <Link key={h.chapter_id} href={`/read/${h.chapter_id}`} className="neu-sm px-4 py-2 text-sm">{h.series?.title}</Link>)}</div></section>}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {TABS.map(([v, l]) => <Link key={v} href={tab(v)} aria-current={v === status} className={`btn ${v === status ? "font-semibold [box-shadow:inset_4px_4px_9px_var(--lo),inset_-4px_-4px_9px_var(--hi)]" : ""}`}>{l}</Link>)}
        <form className="ml-auto"><input type="hidden" name="s" value={status} />
          <select name="sort" defaultValue={sort} aria-label="Sort library" className="btn bg-transparent">{SORTS.map(([v, l]) => <option key={v} value={v} className="text-black">{l}</option>)}</select>
          <button className="btn ml-2">Sort</button></form>
      </div>
      {rows.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-5">{rows.map((r) => <SeriesCard key={r.series.slug} s={r.series} />)}</div>
        : <p className="neu-in p-10 text-center text-mute">Nothing here yet. Add a series from Discover.</p>}
    </>
  );
}
