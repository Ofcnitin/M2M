import { createClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";

export const metadata = { title: "Copyright complaint" };

// Server action: validates input, applies a per-email limit and calls the service-role-only RPC.
async function submitClaim(fd: FormData) {
  "use server";
  if (String(fd.get("website") ?? "") !== "") redirect("/copyright?sent=1"); // honeypot
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  const urls = s("urls").split(/\s+/).filter(Boolean).slice(0, 20);
  const valid = urls.length > 0 && urls.every((u) => { try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:"; } catch { return false; } });
  const email = s("email");
  if (!valid || s("name").length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || s("work").length < 10 || s("signature").length < 2
      || fd.get("owner") !== "on" || fd.get("good_faith") !== "on") redirect("/copyright?error=1");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } });
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await sb.from("copyright_cases").select("id", { count: "exact", head: true }).eq("claimant_email", email).gte("received_at", since);
  if ((count ?? 0) >= 5) redirect("/copyright?error=limit");
  // Resolve the targeted series/chapter from the M2M URLs so the case reaches the right creator.
  let seriesId: string | null = null, chapterId: string | null = null;
  for (const u of urls) {
    const p = new URL(u).pathname.split("/").filter(Boolean);
    if (p[0] === "read" && p[1] && !chapterId) chapterId = /^[0-9a-f-]{36}$/i.test(p[1]) ? p[1] : null;
    if (p[0] === "series" && p[1] && !seriesId) { const { data } = await sb.from("series").select("id").eq("slug", p[1]).maybeSingle(); seriesId = data?.id ?? null; }
  }
  const { error } = await sb.rpc("submit_copyright_claim", { p_name: s("name"), p_email: email, p_org: s("org"), p_work: s("work"), p_urls: urls, p_series: seriesId, p_chapter: chapterId, p_owner: true, p_good_faith: true, p_signature: s("signature") });
  redirect(error ? "/copyright?error=1" : "/copyright?sent=1");
}

export default function Copyright({ searchParams }: { searchParams: { sent?: string; error?: string } }) {
  const field = "neu-in w-full bg-transparent px-4 py-2 text-sm";
  return (
    <>
      <h1 className="mb-2 mt-4 text-3xl font-bold tracking-tight">Copyright complaint</h1>
      <p className="mb-6 text-sm text-mute">Use this form if you believe work on M2M infringes your copyright. False claims can have legal consequences. Wording and deadlines on this page need review by qualified counsel before launch.</p>
      {searchParams.sent && <p role="status" className="neu-in mb-4 p-4 text-sm">Your complaint was received. We will contact you at the email you gave.</p>}
      {searchParams.error && <p role="alert" className="neu-in mb-4 p-4 text-sm">{searchParams.error === "limit" ? "Too many complaints from this email today." : "Please complete every required field with valid values."}</p>}
      <form action={submitClaim} className="neu grid gap-4 p-5">
        <input name="website" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" />
        <label className="grid gap-1 text-sm">Your full name<input name="name" required className={field} /></label>
        <label className="grid gap-1 text-sm">Email<input name="email" type="email" required className={field} /></label>
        <label className="grid gap-1 text-sm">Organisation (optional)<input name="org" className={field} /></label>
        <label className="grid gap-1 text-sm">The work you own<textarea name="work" required minLength={10} rows={3} className={field} /></label>
        <label className="grid gap-1 text-sm">M2M URL(s), one per line<textarea name="urls" required rows={3} className={field} /></label>
        <label className="flex gap-2 text-sm"><input type="checkbox" name="owner" required /> I own, or am authorised to act for the owner of, the copyright in this work.</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" name="good_faith" required /> I have a good-faith belief the use is not authorised, and this information is accurate.</label>
        <label className="grid gap-1 text-sm">Electronic signature (full name)<input name="signature" required className={field} /></label>
        <button className="btn">Submit complaint</button>
      </form>
    </>
  );
}
