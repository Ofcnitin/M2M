import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { hideMature, type SupabaseLike } from "@/lib/age";
import { getDiscoveryPrefs, matureVisibleInDiscovery, filterExcludedWarnings } from "@/lib/discovery";
import { normalizeTag, tagHref } from "@/lib/tags";
import { SeriesCard } from "@/components/SeriesCard";

export const metadata = { title: "Discover" };
type SP = { q?: string; genre?: string; format?: string; status?: string; rating?: string; tag?: string; sort?: string; page?: string };
const PAGE = 20;
const SORTS = [["updated", "Recently updated"], ["new", "Recently published"], ["popular", "Most popular"], ["rated", "Highest rated"], ["alpha", "Alphabetical"]];

export default async function Discover({ searchParams: sp }: { searchParams: SP }) {
  const sb = supabaseServer();
  // Listings rule (discovery.ts): mature shows only for eligible users who opted in.
  const prefs = await getDiscoveryPrefs(sb as unknown as SupabaseLike);
  const adult = matureVisibleInDiscovery(prefs.eligible, prefs.showMature);
  const tag = sp.tag ? normalizeTag(sp.tag) : "";
  const [{ data: genres }, { data: popular }] = await Promise.all([
    sb.from("genres").select("name,slug").order("name"),
    sb.rpc("popular_tags", { p_limit: 14, p_include_mature: adult }),
  ]);
  const COLS = "id,slug,title,cover_url,content_format,content_rating,content_warnings,rating_avg,rating_count,profiles(display_name)";
  let q: any = sb.from("series").select(sp.genre ? `${COLS},series_genres!inner(genres!inner(slug))` : COLS, { count: "exact" }).eq("visibility", "published");
  q = hideMature(q, adult);
  if (sp.genre) q = q.eq("series_genres.genres.slug", sp.genre);
  if (sp.format) q = q.eq("content_format", sp.format);
  if (sp.status) q = q.eq("publication_status", sp.status);
  if (sp.rating && (sp.rating !== "mature" || adult)) q = q.eq("content_rating", sp.rating);
  if (tag) q = q.contains("tags", [tag]);
  const clean = (sp.q ?? "").replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  if (clean) {
    const { data: people } = await sb.from("profiles").select("id").ilike("display_name", `%${clean}%`).limit(50);
    const ids = (people ?? []).map((p) => p.id).join(",");
    q = q.or(`search.wfts(simple).${clean}${ids ? `,creator_id.in.(${ids})` : ""}`);
  }
  const sort = SORTS.some(([v]) => v === sp.sort) ? sp.sort! : "updated";
  q = sort === "popular" ? q.order("view_count", { ascending: false })
    : sort === "rated" ? q.gt("rating_count", 0).order("rating_rank", { ascending: false }).order("rating_count", { ascending: false })
    : sort === "new" ? q.order("created_at", { ascending: false })
    : sort === "alpha" ? q.order("title") : q.order("updated_at", { ascending: false });
  const page = Math.max(1, Number(sp.page) || 1);
  const { data, count } = await q.range((page - 1) * PAGE, page * PAGE - 1);
  // Excluded-warning filtering is in memory, so a page can show fewer than PAGE rows
  // and `count` (used only for the Next link) still reflects the unfiltered total.
  const rows = filterExcludedWarnings((data ?? []) as any[], prefs.excludedWarnings);

  const qs = (o: Partial<SP>) => { const p = new URLSearchParams(Object.entries({ ...sp, ...o }).filter(([, v]) => v) as [string, string][]); return `/discover?${p}`; };
  const sel = "neu-in bg-transparent px-3 py-2 text-sm";
  const o = (v: string, l: string) => <option key={v} value={v} className="text-black">{l}</option>;
  return (
    <>
      <h1 className="mb-5 mt-4 text-3xl font-bold tracking-tight">Discover</h1>
      <form className="mb-5 flex flex-wrap gap-3">
        <input name="q" defaultValue={sp.q} placeholder="Search" aria-label="Search" className={`${sel} min-w-[12rem] flex-1`} />
        {tag && <input type="hidden" name="tag" value={tag} />}
        <select name="genre" defaultValue={sp.genre ?? ""} aria-label="Genre" className={sel}>{o("", "All genres")}{genres?.map((g) => o(g.slug, g.name))}</select>
        <select name="format" defaultValue={sp.format ?? ""} aria-label="Format" className={sel}>{o("", "All formats")}{["manhwa", "manga", "webtoon", "western", "other"].map((v) => o(v, v))}</select>
        <select name="status" defaultValue={sp.status ?? ""} aria-label="Status" className={sel}>{o("", "Any status")}{["ongoing", "completed", "hiatus", "cancelled"].map((v) => o(v, v))}</select>
        <select name="rating" defaultValue={sp.rating ?? ""} aria-label="Content rating" className={sel}>{o("", "Any content rating")}{["everyone", "teen", ...(adult ? ["mature"] : [])].map((v) => o(v, v))}</select>
        <select name="sort" defaultValue={sort} aria-label="Sort" className={sel}>{SORTS.map(([v, l]) => o(v, l))}</select>
        <button className="btn-primary">Apply</button>
      </form>
      <div className="mb-8 flex flex-wrap items-center gap-2 text-xs">
        {tag && <Link href={qs({ tag: undefined, page: undefined })} className="btn font-semibold" aria-label={`Remove tag filter ${tag}`}>#{tag} ×</Link>}
        {(popular as { tag: string }[] | null)?.filter((t) => t.tag !== tag).map((t) => <Link key={t.tag} href={tagHref(t.tag)} className="neu-sm px-3 py-1">#{t.tag}</Link>)}
      </div>
      {rows.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-5">{rows.map((s: any) => <SeriesCard key={s.slug} s={s} />)}</div>
        : <p className="neu-in p-10 text-center text-mute">{sort === "rated" ? "No rated series match yet. Rate a series you've read to get this list started." : "No series match your search. Try different words or clear a filter."}</p>}
      <div className="mt-8 flex justify-center gap-3">
        {page > 1 && <Link className="btn" href={qs({ page: String(page - 1) })}>Previous</Link>}
        {(count ?? 0) > page * PAGE && <Link className="btn" href={qs({ page: String(page + 1) })}>Next</Link>}
      </div>
    </>
  );
}
