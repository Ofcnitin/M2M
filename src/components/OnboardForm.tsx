"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { TERMS_VERSION } from "@/lib/terms";

export function OnboardForm({ username, displayName }: { username: string; displayName: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget), sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser(); if (!user) return;
    if (f.get("terms") !== "on") return setMsg("Accept the publishing terms to continue.");
    const slug = String(f.get("slug")).toLowerCase().replace(/[^a-z0-9-]/g, "");
    const { error: e1 } = await sb.from("profiles").update({ display_name: f.get("display_name"), username: String(f.get("username")).toLowerCase(), biography: f.get("bio") }).eq("id", user.id);
    if (e1) return setMsg("That username is taken or invalid. Use 3 to 30 letters, numbers or underscores.");
    const { error: e2 } = await sb.rpc("become_creator", { p_slug: slug, p_terms_version: TERMS_VERSION });
    if (e2) return setMsg("That creator URL is already taken. Try another.");
    await sb.from("creator_profiles").update({ portfolio_url: f.get("portfolio") || null }).eq("user_id", user.id);
    router.push("/studio"); router.refresh();
  }
  const field = "neu-in w-full bg-transparent px-4 py-3 text-sm outline-none focus:outline-2 focus:outline-sky";
  return (
    <form onSubmit={submit} className="neu mx-auto mt-6 grid max-w-lg gap-4 p-8">
      <h1 className="text-2xl font-bold">Set up your creator profile</h1>
      <input name="display_name" required defaultValue={displayName} placeholder="Display name" aria-label="Display name" className={field} />
      <input name="username" required defaultValue={username} placeholder="Username" aria-label="Username" className={field} />
      <input name="slug" required placeholder="Creator URL, for example aiko-tan" aria-label="Creator URL" className={field} />
      <textarea name="bio" rows={3} placeholder="Short biography" aria-label="Biography" className={field} />
      <input name="portfolio" type="url" placeholder="Portfolio link (optional)" aria-label="Portfolio link" className={field} />
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" name="terms" required className="mt-1" />
        <span>I accept the publishing terms and confirm I own the rights to everything I upload.</span></label>
      {msg && <p role="alert" className="text-sm">{msg}</p>}
      <button className="btn-primary">Activate creator profile</button>
    </form>
  );
}
