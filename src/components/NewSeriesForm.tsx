"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { slugify } from "@/lib/slug";
import { normalizeTags } from "@/lib/tags";
import { CONTENT_WARNINGS } from "@/lib/age-core";

type Genre = { id: number; name: string };
const list = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function NewSeriesForm({ genres }: { genres: Genre[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser(); if (!user) return;
    const title = String(f.get("title"));
    const { data: s, error } = await sb.from("series").insert({
      creator_id: user.id, title, slug: slugify(title), alternative_titles: list(f.get("alt")), synopsis: f.get("synopsis"),
      content_format: f.get("format"), content_rating: f.get("rating"), publication_status: f.get("status"), language: f.get("language") || "en",
      release_schedule: f.get("schedule") || null, tags: normalizeTags(String(f.get("tags") ?? "")),
      content_warnings: f.getAll("warning").map(String), policy_confirmed_at: new Date().toISOString(),
    }).select("id").single();
    if (error || !s) return setMsg("Could not create the series. Check your creator profile is active.");
    const gids = f.getAll("genre").map(Number);
    if (gids.length) await sb.from("series_genres").insert(gids.map((genre_id) => ({ series_id: s.id, genre_id })));
    const people = [["author", f.get("author")], ["artist", f.get("artist")]].filter(([, n]) => n).map(([r, n]) => ({ series_id: s.id, display_name: String(n), contribution_role: String(r) }));
    if (people.length) await sb.from("series_contributors").insert(people);
    router.push(`/studio/series/${s.id}`);
  }
  const field = "neu-in w-full bg-transparent px-4 py-3 text-sm outline-none focus:outline-2 focus:outline-sky";
  const opts = (a: string[]) => a.map((o) => <option key={o} value={o} className="text-black">{o}</option>);
  return (
    <form onSubmit={submit} className="neu mt-6 grid gap-4 p-8 sm:grid-cols-2">
      <h1 className="text-2xl font-bold sm:col-span-2">Create a series</h1>
      <input name="title" required placeholder="Series title" aria-label="Series title" className={`${field} sm:col-span-2`} />
      <input name="alt" placeholder="Alternative titles, comma separated" aria-label="Alternative titles" className={`${field} sm:col-span-2`} />
      <textarea name="synopsis" rows={4} required placeholder="Synopsis" aria-label="Synopsis" className={`${field} sm:col-span-2`} />
      <input name="author" placeholder="Author" aria-label="Author" className={field} />
      <input name="artist" placeholder="Artist" aria-label="Artist" className={field} />
      <select name="format" aria-label="Format" className={field}>{opts(["webtoon", "manhwa", "manga", "western", "other"])}</select>
      <select name="rating" aria-label="Content rating" className={field}>{opts(["everyone", "teen", "mature"])}</select>
      <select name="status" aria-label="Publication status" className={field}>{opts(["ongoing", "completed", "hiatus", "cancelled"])}</select>
      <input name="language" defaultValue="en" aria-label="Language" className={field} />
      <input name="schedule" placeholder="Release schedule, for example Weekly on Fridays" aria-label="Release schedule" className={`${field} sm:col-span-2`} />
      <input name="tags" placeholder="Tags, comma separated (up to 10), for example time travel, found family" aria-label="Tags" className={`${field} sm:col-span-2`} />
      <fieldset className="sm:col-span-2"><legend className="mb-2 text-sm text-mute">Content warnings (shown on the series page; they do not replace the rating)</legend>
        <div className="flex flex-wrap gap-3">{CONTENT_WARNINGS.map((w) => <label key={w.value} className="neu-sm flex items-center gap-2 px-3 py-1.5 text-sm"><input type="checkbox" name="warning" value={w.value} />{w.label}</label>)}</div></fieldset>
      <label className="flex items-start gap-3 text-sm sm:col-span-2"><input type="checkbox" name="policy" required className="mt-1" /><span>I confirm this rating is accurate and the series complies with the M2M content policy (no explicit pornography, no sexual content involving minors, no non-consensual sexual content).</span></label>
      <fieldset className="sm:col-span-2"><legend className="mb-2 text-sm text-mute">Genres</legend>
        <div className="flex flex-wrap gap-3">{genres.map((g) => <label key={g.id} className="neu-sm flex items-center gap-2 px-3 py-1.5 text-sm"><input type="checkbox" name="genre" value={g.id} />{g.name}</label>)}</div></fieldset>
      {msg && <p role="alert" className="text-sm sm:col-span-2">{msg}</p>}
      <button className="btn-primary sm:col-span-2">Create series</button>
    </form>
  );
}
