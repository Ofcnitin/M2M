import { trackEvent } from "@/lib/analytics";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { canAccessMature, type SupabaseLike } from "@/lib/age";
import { coverUrlForSeries } from "@/lib/cdn";
import { SeriesActions } from "@/components/SeriesActions";
import { LikeButton } from "@/components/LikeButton";
import { RatingStars } from "@/components/RatingStars";
import { TagList } from "@/components/TagList";
import { Comments } from "@/components/Comments";

export default async function SeriesPage({ params, searchParams }: { params: { slug: string }; searchParams: { order?: string } }) {
  const sb = supabaseServer();
  const { data: s } = await sb.from("series")
    .select("id,creator_id,title,synopsis,cover_url,content_format,publication_status,content_rating,content_warnings,view_count,release_schedule,tags,rating_avg,rating_count,profiles(display_name,creator_profiles(creator_slug)),series_genres(genres(name,slug)),series_contributors(display_name,contribution_role)")
    .eq("slug", params.slug).single();
  if (!s) notFound();
  if (s.content_rating === "mature" && !(await canAccessMature(sb as unknown as SupabaseLike))) redirect(`/age?next=${encodeURIComponent(`/series/${params.slug}`)}`);

  const { data: { user } } = await sb.auth.getUser();
  const { data: list } = await sb.from("chapters").select("id,chapter_number,title,published_at")
    .eq("series_id", s.id).eq("publication_status", "published").order("chapter_number", { ascending: true });
  const asc = list ?? [];
  const asNewest = searchParams.order !== "asc";
  const chapters = asNewest ? [...asc].reverse() : asc;
  const first = asc[0];

  // "Continue reading": the chapter in progress, or the one after a finished chapter.
  let resume: { id: string; n: number } | null = null;
  if (user) {
    const { data: prog } = await sb.from("reading_progress").select("chapter_id,completed").eq("series_id", s.id).maybeSingle();
    const i = prog ? asc.findIndex((c) => c.id === prog.chapter_id) : -1;
    const target = i >= 0 ? (prog!.completed ? asc[i + 1] : asc[i]) : undefined;
    if (target) resume = { id: target.id, n: Number(target.chapter_number) };
  }

  await trackEvent("series_view", s.id, null, user?.id ?? null);

  const a = s as any;
  const cp = Array.isArray(a.profiles?.creator_profiles) ? a.profiles.creator_profiles[0] : a.profiles?.creator_profiles;
  const genres = (a.series_genres ?? []).map((g: any) => g.genres).filter(Boolean);
  const credits = (a.series_contributors ?? []).map((c: any) => `${c.display_name} (${c.contribution_role})`).join(" · ");
  const byline = a.profiles?.display_name;
  return (
    <article className="mt-4">
      <div className="neu grid gap-6 p-8 sm:grid-cols-[180px_1fr]">
        <div className="aspect-[3/4] w-40 overflow-hidden rounded-2xl bg-wash sm:w-full">
          {s.cover_url && /* eslint-disable-next-line @next/next/no-img-element */
            <img src={coverUrlForSeries(s) ?? ""} alt={`Cover of ${s.title}`} className="h-full w-full object-cover" />}
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{s.title}</h1>
          <p className="mt-1 text-sm text-mute">
            {cp?.creator_slug ? <Link href={`/creator/${cp.creator_slug}`} className="underline">{byline}</Link> : byline} · {s.content_format} · {s.publication_status} · {s.content_rating === "mature" ? "mature 18+" : s.content_rating}
          </p>
          <p className="mt-1 text-xs text-mute">Ratings are M2M platform classifications, not official Indian statutory ratings.</p>
          {credits && <p className="mt-1 text-xs text-mute">{credits}</p>}
          {Array.isArray((s as { content_warnings?: string[] }).content_warnings) && (s as { content_warnings?: string[] }).content_warnings!.length > 0 && (
            <p className="mt-2 text-xs"><span className="font-semibold">Content warnings:</span> {(s as { content_warnings?: string[] }).content_warnings!.join(", ").replaceAll("_", " ")}</p>)}
          <div className="mt-4"><RatingStars seriesId={s.id} creatorId={s.creator_id} avg={Number(s.rating_avg)} count={s.rating_count} /></div>
          <TagList genres={genres} tags={s.tags} />
          <p className="mt-4 max-w-2xl whitespace-pre-line">{s.synopsis}</p>
          {s.release_schedule && <p className="mt-2 text-sm text-mute">Updates: {s.release_schedule}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {resume ? <Link href={`/read/${resume.id}`} className="btn-primary">Continue · Chapter {resume.n}</Link>
              : first && <Link href={`/read/${first.id}`} className="btn-primary">Start reading</Link>}
            {resume && first && <Link href={`/read/${first.id}`} className="btn">Start from the beginning</Link>}
            <LikeButton type="series" id={s.id} />
          </div>
          <SeriesActions seriesId={s.id} creatorId={s.creator_id} />
        </div>
      </div>
      <div className="mb-4 mt-9 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Chapters</h2>
        {asc.length > 1 && <Link href={`/series/${params.slug}?order=${asNewest ? "asc" : "desc"}`} className="btn" scroll={false}>{asNewest ? "Newest first" : "Oldest first"}</Link>}
      </div>
      {chapters.length ? (
        <ul className="grid gap-3">
          {chapters.map((c) => (
            <li key={c.id}><Link href={`/read/${c.id}`} className="neu-sm flex justify-between px-5 py-3 text-sm">
              <span>Chapter {Number(c.chapter_number)}{c.title ? ` · ${c.title}` : ""}</span>
              <span className="text-mute">{c.published_at ? new Date(c.published_at).toLocaleDateString() : ""}</span></Link></li>))}
        </ul>
      ) : <p className="neu-in p-8 text-center text-mute">No chapters yet. Check back soon.</p>}
      <Comments seriesId={s.id} />
    </article>
  );
}
