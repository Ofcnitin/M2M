import { trackEvent } from "@/lib/analytics";
import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { canAccessMature, type SupabaseLike } from "@/lib/age";
import { mediaUrlForAsset } from "@/lib/cdn";
import { Reader } from "@/components/Reader";

export default async function ReadPage({ params }: { params: { chapterId: string } }) {
  const sb = supabaseServer();
  const { data: ch } = await sb.from("chapters").select("id,series_id,chapter_number,title,reading_mode,series(slug,title,content_rating)").eq("id", params.chapterId).single();
  if (!ch) notFound(); // RLS hides drafts and unpublished chapters
  const series = (ch as any).series;
  if (series.content_rating === "mature" && !(await canAccessMature(sb as unknown as SupabaseLike))) redirect(`/age?next=${encodeURIComponent(`/read/${params.chapterId}`)}`);

  const { data: { user } } = await sb.auth.getUser();
  await trackEvent("chapter_view", ch.series_id, ch.id, user?.id ?? null);
  const [{ data: assets }, { data: next }, { data: prev }, prog] = await Promise.all([
    sb.from("chapter_assets").select("id,storage_key,original_width,original_height").eq("chapter_id", ch.id).eq("processing_status", "ready").order("display_order"),
    sb.from("chapters").select("id").eq("series_id", ch.series_id).eq("publication_status", "published").gt("chapter_number", ch.chapter_number).order("chapter_number").limit(1),
    sb.from("chapters").select("id").eq("series_id", ch.series_id).eq("publication_status", "published").lt("chapter_number", ch.chapter_number).order("chapter_number", { ascending: false }).limit(1),
    user ? sb.from("reading_progress").select("chapter_id,scroll_position,completed").eq("series_id", ch.series_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const p = prog.data as { chapter_id: string; scroll_position: number; completed: boolean } | null;
  const initialPos = p && p.chapter_id === ch.id && !p.completed ? p.scroll_position : null;
  return (
    <Reader
      chapterId={ch.id} seriesId={ch.series_id} mode={ch.reading_mode} initialPos={initialPos}
      title={`${series.title} · Chapter ${Number(ch.chapter_number)}`} seriesHref={`/series/${series.slug}`}
      prevHref={prev?.[0] ? `/read/${prev[0].id}` : null} nextHref={next?.[0] ? `/read/${next[0].id}` : null}
      assets={(assets ?? []).map((a) => ({ id: a.id, src: mediaUrlForAsset(a, series.content_rating, 1080), w: a.original_width, h: a.original_height }))}
    />
  );
}
