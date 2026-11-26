import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";
import { hideMature, type SupabaseLike } from "@/lib/age";
import { getDiscoveryPrefs, matureVisibleInDiscovery, filterExcludedWarnings } from "@/lib/discovery";
import { SeriesCard } from "@/components/SeriesCard";

const COLS = "id,slug,title,cover_url,content_format,content_rating,content_warnings,rating_avg,rating_count,profiles(display_name)";
type Order = "updated_at" | "created_at" | "view_count" | "rating_rank";

async function shelf(title: string, order: Order, showMature: boolean, excludedWarnings: string[], href: string) {
  let q: any = supabaseServer().from("series").select(COLS).eq("visibility", "published");
  q = hideMature(q, showMature);
  if (order === "rating_rank") q = q.gt("rating_count", 0);
  const { data } = await q.order(order, { ascending: false }).limit(10);
  const rows = filterExcludedWarnings((data ?? []) as any[], excludedWarnings);
  if (!rows.length) return null;
  return (
    <section key={title}>
      <div className="mb-4 mt-9 flex items-baseline justify-between"><h2 className="text-lg font-semibold">{title}</h2><Link href={href} className="text-sm text-mute underline">See all</Link></div>
      <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-5">{rows.map((s: any) => <SeriesCard key={s.slug} s={s} />)}</div>
    </section>
  );
}

export default async function Home() {
  const sb0 = supabaseServer();
  // Listings rule (discovery.ts): mature shows only for eligible users who opted in.
  const prefs = await getDiscoveryPrefs(sb0 as unknown as SupabaseLike);
  const showMature = matureVisibleInDiscovery(prefs.eligible, prefs.showMature);
  return (
    <>
      <section className="neu p-8">
        <h1 className="max-w-xl text-4xl font-bold leading-tight tracking-tight">Read independent comics. Publish your own.</h1>
        <p className="mt-3 max-w-md text-mute">Webtoons, manga and manhwa from creators you can follow directly.</p>
      </section>
      {await shelf("Trending", "view_count", showMature, prefs.excludedWarnings, "/discover?sort=popular")}
      {await shelf("Top rated", "rating_rank", showMature, prefs.excludedWarnings, "/discover?sort=rated")}
      {await shelf("Recently updated", "updated_at", showMature, prefs.excludedWarnings, "/discover?sort=updated")}
      {await shelf("Recently published", "created_at", showMature, prefs.excludedWarnings, "/discover?sort=new")}
    </>
  );
}
