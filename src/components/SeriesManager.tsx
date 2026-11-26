"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { normalizeTags } from "@/lib/tags";
import { CONTENT_WARNINGS } from "@/lib/age-core";

type S = {
  id: string; title: string; synopsis: string | null; publication_status: string; visibility: string; cover_url: string | null;
  alternative_titles: string[]; content_format: string; content_rating: string; language: string; release_schedule: string | null;
  tags: string[]; removed_by_moderation: boolean; content_warnings?: string[];
};
type C = { id: string; chapter_number: number; title: string | null; publication_status: string };
type Genre = { id: number; name: string };
type Person = { contribution_role: string; display_name: string };

const csv = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function SeriesManager({ series, chapters, genres, selectedGenres, people }: { series: S; chapters: C[]; genres: Genre[]; selectedGenres: number[]; people: Person[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  const sb = supabaseBrowser();
  const field = "neu-in w-full bg-transparent px-4 py-3 text-sm outline-none focus:outline-2 focus:outline-sky";
  const person = (role: string) => people.find((p) => p.contribution_role === role)?.display_name ?? "";

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const patch: Record<string, unknown> = {
      title: f.get("title"), synopsis: f.get("synopsis"), alternative_titles: csv(f.get("alt")), publication_status: f.get("status"),
      content_format: f.get("format"), content_rating: f.get("rating"), language: f.get("language") || "en",
      release_schedule: f.get("schedule") || null, tags: normalizeTags(String(f.get("tags") ?? "")),
      content_warnings: f.getAll("warning").map(String), policy_confirmed_at: new Date().toISOString(),
    };
    if (!series.removed_by_moderation) patch.visibility = f.get("visibility");
    const { error } = await sb.from("series").update(patch).eq("id", series.id);
    if (error) return setMsg("Could not save changes.");

    // Genres and credits are replaced as a set.
    await sb.from("series_genres").delete().eq("series_id", series.id);
    const gids = f.getAll("genre").map(Number);
    if (gids.length) await sb.from("series_genres").insert(gids.map((genre_id) => ({ series_id: series.id, genre_id })));
    await sb.from("series_contributors").delete().eq("series_id", series.id).in("contribution_role", ["author", "artist"]);
    const credits = [["author", f.get("author")], ["artist", f.get("artist")]].filter(([, n]) => n).map(([r, n]) => ({ series_id: series.id, display_name: String(n), contribution_role: String(r) }));
    if (credits.length) await sb.from("series_contributors").insert(credits);
    setMsg("Saved."); router.refresh();
  }
  async function cover(file: File) {
    const r = await fetch("/api/uploads/cover", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seriesId: series.id, type: file.type, size: file.size }) });
    const j = await r.json(); if (!r.ok) return setMsg(j.error);
    const put = await fetch(j.url, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
    if (!put.ok) return setMsg("Cover upload failed. Try again.");
    // The media processor validates the file and then sets the cover; the client never writes cover_url.
    setMsg("Cover uploaded. It will appear once it passes validation."); setTimeout(() => router.refresh(), 4000);
  }
  async function addChapter(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { data, error } = await sb.from("chapters").insert({ series_id: series.id, chapter_number: Number(f.get("num")), title: f.get("ctitle") || null, reading_mode: f.get("mode") }).select("id").single();
    if (error || !data) return setMsg("That chapter number already exists in this series.");
    router.push(`/studio/series/${series.id}/chapters/${data.id}`);
  }
  async function del() {
    if (!confirm(`Delete "${series.title}", all its chapters, comments and ratings? This cannot be undone.`)) return;
    const { error } = await sb.from("series").delete().eq("id", series.id);
    if (error) return setMsg("Could not delete the series.");
    router.push("/studio"); router.refresh();
  }
  const opt = (a: string[]) => a.map((o) => <option key={o} value={o} className="text-black">{o}</option>);
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <form onSubmit={save} className="neu grid gap-4 p-7">
        <h1 className="text-2xl font-bold">Series settings</h1>
        {series.removed_by_moderation && <p role="alert" className="neu-in p-4 text-sm">This series was removed by moderators and cannot be republished. Contact support to appeal.</p>}
        <input name="title" defaultValue={series.title} required aria-label="Title" className={field} />
        <input name="alt" defaultValue={series.alternative_titles.join(", ")} placeholder="Alternative titles, comma separated" aria-label="Alternative titles" className={field} />
        <textarea name="synopsis" rows={4} defaultValue={series.synopsis ?? ""} aria-label="Synopsis" className={field} />
        <div className="grid grid-cols-2 gap-4">
          <input name="author" defaultValue={person("author")} placeholder="Author" aria-label="Author" className={field} />
          <input name="artist" defaultValue={person("artist")} placeholder="Artist" aria-label="Artist" className={field} />
          <select name="format" defaultValue={series.content_format} aria-label="Format" className={field}>{opt(["webtoon", "manhwa", "manga", "western", "other"])}</select>
          <select name="rating" defaultValue={series.content_rating} aria-label="Content rating" className={field}>{opt(["everyone", "teen", "mature"])}</select>
          <select name="status" defaultValue={series.publication_status} aria-label="Publication status" className={field}>{opt(["ongoing", "completed", "hiatus", "cancelled"])}</select>
          <select name="visibility" defaultValue={series.visibility} disabled={series.removed_by_moderation} aria-label="Visibility" className={field}>{opt(["draft", "published", "unlisted", "archived"])}</select>
          <input name="language" defaultValue={series.language} aria-label="Language" className={field} />
          <input name="schedule" defaultValue={series.release_schedule ?? ""} placeholder="Release schedule" aria-label="Release schedule" className={field} />
        </div>
        <input name="tags" defaultValue={series.tags.join(", ")} placeholder="Tags, comma separated (up to 10)" aria-label="Tags" className={field} />
        <fieldset><legend className="mb-2 text-sm text-mute">Content warnings</legend>
          <div className="flex flex-wrap gap-3">{CONTENT_WARNINGS.map((w) => <label key={w.value} className="neu-sm flex items-center gap-2 px-3 py-1.5 text-sm"><input type="checkbox" name="warning" value={w.value} defaultChecked={series.content_warnings?.includes(w.value)} />{w.label}</label>)}</div></fieldset>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" name="policy" required className="mt-1" /><span>I confirm this rating is accurate and complies with the M2M content policy.</span></label>
        <fieldset><legend className="mb-2 text-sm text-mute">Genres</legend>
          <div className="flex flex-wrap gap-3">{genres.map((g) => <label key={g.id} className="neu-sm flex items-center gap-2 px-3 py-1.5 text-sm"><input type="checkbox" name="genre" value={g.id} defaultChecked={selectedGenres.includes(g.id)} />{g.name}</label>)}</div></fieldset>
        <label className="text-sm text-mute">Cover image<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && cover(e.target.files[0])} className="mt-2 block text-sm" /></label>
        {msg && <p role="status" className="text-sm">{msg}</p>}
        <button className="btn-primary">Save changes</button>
        <button type="button" className="btn" onClick={del}>Delete series</button>
      </form>
      <div className="grid content-start gap-6">
        <form onSubmit={addChapter} className="neu grid gap-3 p-7 sm:grid-cols-2">
          <h2 className="text-lg font-semibold sm:col-span-2">New chapter</h2>
          <input name="num" type="number" step="0.5" min="0" required placeholder="Chapter number" aria-label="Chapter number" className={field} />
          <select name="mode" aria-label="Reading format" className={field}><option value="vertical" className="text-black">Vertical strip</option><option value="page_ltr" className="text-black">Pages, left to right</option><option value="page_rtl" className="text-black">Pages, right to left</option></select>
          <input name="ctitle" placeholder="Chapter title (optional)" aria-label="Chapter title" className={`${field} sm:col-span-2`} />
          <button className="btn-primary sm:col-span-2">Create chapter</button>
        </form>
        <section><h2 className="mb-3 text-lg font-semibold">Chapters</h2>
          {chapters.length ? <ul className="grid gap-3">{chapters.map((c) => (
            <li key={c.id}><Link href={`/studio/series/${series.id}/chapters/${c.id}`} className="neu-sm flex justify-between px-5 py-3 text-sm">
              <span>Chapter {Number(c.chapter_number)}{c.title ? ` · ${c.title}` : ""}</span><span className="text-mute">{c.publication_status}</span></Link></li>))}</ul>
            : <p className="neu-in p-6 text-center text-sm text-mute">No chapters yet. Create your first chapter to start uploading.</p>}</section>
      </div>
    </div>
  );
}
