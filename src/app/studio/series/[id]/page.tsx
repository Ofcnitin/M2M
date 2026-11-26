import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { SeriesManager } from "@/components/SeriesManager";

export const metadata = { title: "Manage series" };
export default async function ManageSeries({ params }: { params: { id: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: role } = await sb.rpc("series_member_role", { sid: params.id });
  if (role && role !== "owner") {
    // Contributors get a chapter list only; series settings, deletion and the team stay with the owner.
    const { data: t } = await sb.from("series").select("id,title").eq("id", params.id).single();
    const { data: chs } = await sb.from("chapters").select("id,chapter_number,title,publication_status").eq("series_id", params.id).order("chapter_number", { ascending: false });
    if (!t) notFound();
    return (
      <>
        <h1 className="mb-1 mt-4 text-3xl font-bold tracking-tight">{t.title}</h1>
        <p className="mb-6 text-sm text-mute">You are an {role} on this series.</p>
        {role === "analyst" ? <p className="neu-in p-6 text-sm text-mute">Analysts can view analytics only. <Link href={`/studio/series/${t.id}/analytics`} className="underline">Open this series&apos; analytics</Link></p> :
          <ul className="grid gap-3">{(chs ?? []).map((c: any) => <li key={c.id}><Link href={`/studio/series/${t.id}/chapters/${c.id}`} className="neu-sm flex justify-between px-5 py-3 text-sm"><span>Chapter {c.chapter_number}{c.title ? ` · ${c.title}` : ""}</span><span className="text-mute">{c.publication_status}</span></Link></li>)}</ul>}
      </>
    );
  }
  const { data: s } = await sb.from("series")
    .select("id,title,synopsis,publication_status,visibility,cover_url,alternative_titles,content_format,content_rating,language,release_schedule,tags,removed_by_moderation,content_warnings")
    .eq("id", params.id).eq("creator_id", user.id).single();
  if (!s) notFound();
  const [{ data: chapters }, { data: genres }, { data: sg }, { data: people }] = await Promise.all([
    sb.from("chapters").select("id,chapter_number,title,publication_status").eq("series_id", s.id).order("chapter_number", { ascending: false }),
    sb.from("genres").select("id,name").order("name"),
    sb.from("series_genres").select("genre_id").eq("series_id", s.id),
    sb.from("series_contributors").select("contribution_role,display_name").eq("series_id", s.id),
  ]);
  return <><p className="mt-4 flex gap-4 text-sm"><Link href={`/studio/series/${s.id}/team`} className="underline">Manage team</Link><Link href={`/studio/series/${s.id}/analytics`} className="underline">Series analytics</Link></p><SeriesManager series={s} chapters={chapters ?? []} genres={genres ?? []} selectedGenres={(sg ?? []).map((g) => g.genre_id)} people={people ?? []} /></>;
}
