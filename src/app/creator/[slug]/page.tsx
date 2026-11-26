import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { hideMature, type SupabaseLike } from "@/lib/age";
import { getDiscoveryPrefs, matureVisibleInDiscovery, filterExcludedWarnings } from "@/lib/discovery";
import { SeriesCard } from "@/components/SeriesCard";
import { FollowButton } from "@/components/FollowButton";

export default async function Creator({ params }: { params: { slug: string } }) {
  const sb = supabaseServer();
  const { data: cp } = await sb.from("creator_profiles").select("user_id,portfolio_url,profiles(display_name,biography)").eq("creator_slug", params.slug).single();
  if (!cp) notFound();
  const p = cp.profiles as any;
  // Listings rule (discovery.ts): mature shows only for eligible users who opted in.
  const prefs = await getDiscoveryPrefs(sb as unknown as SupabaseLike);
  let q: any = sb.from("series").select("id,slug,title,cover_url,content_format,content_rating,content_warnings,rating_avg,rating_count,profiles(display_name)").eq("creator_id", cp.user_id).eq("visibility", "published");
  q = hideMature(q, matureVisibleInDiscovery(prefs.eligible, prefs.showMature));
  const { data } = await q.order("updated_at", { ascending: false });
  const series = filterExcludedWarnings((data ?? []) as any[], prefs.excludedWarnings);
  return (
    <>
      <section className="neu mt-4 p-8">
        <h1 className="text-3xl font-bold tracking-tight">{p?.display_name}</h1>
        {p?.biography && <p className="mt-3 max-w-2xl whitespace-pre-line text-mute">{p.biography}</p>}
        <div className="mt-5 flex flex-wrap gap-3">
          <FollowButton creatorId={cp.user_id} />
          {cp.portfolio_url && <a href={cp.portfolio_url} rel="noopener noreferrer nofollow" target="_blank" className="btn">Portfolio</a>}
        </div>
      </section>
      <h2 className="mb-4 mt-9 text-lg font-semibold">Series</h2>
      {series.length ? <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 md:grid-cols-5">{series.map((s: any) => <SeriesCard key={s.slug} s={s} />)}</div>
        : <p className="neu-in p-8 text-center text-mute">No published series yet.</p>}
    </>
  );
}
