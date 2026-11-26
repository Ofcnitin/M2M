import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Admin" };

async function roleOf(sb: ReturnType<typeof supabaseServer>) {
  const { data: { user } } = await sb.auth.getUser();
  const { data: me } = user ? await sb.from("profiles").select("role,suspended").eq("id", user.id).single() : { data: null };
  return me && !me.suspended ? (me.role as string) : null;
}
// Moderators and admins work the queue; only admins suspend users. RLS and the RPCs enforce the same rules.
async function requireStaff() {
  const sb = supabaseServer();
  const r = await roleOf(sb);
  if (r !== "admin" && r !== "moderator") throw new Error("forbidden");
  return sb;
}
async function requireAdmin() {
  const sb = supabaseServer();
  if ((await roleOf(sb)) !== "admin") throw new Error("forbidden");
  return sb;
}

async function reportAction(fd: FormData) {
  "use server";
  const sb = await requireStaff();
  const id = String(fd.get("id")), type = String(fd.get("type")), target = String(fd.get("target")), act = String(fd.get("act"));
  const reason = String(fd.get("reason") ?? "").trim();
  if (act !== "dismiss") {
    // The RPC requires a reason, logs the action and keeps creators from undoing a removal.
    const { error } = await sb.rpc("mod_set_content", { p_type: type, p_target: target, p_remove: act !== "restore", p_reason: reason });
    if (error) throw new Error(error.message);
  }
  await sb.from("reports").update({ status: act === "archive" ? "actioned" : "dismissed" }).eq("id", id);
  revalidatePath("/admin");
}

async function copyrightAction(fd: FormData) {
  "use server";
  const sb = await requireStaff();
  const id = String(fd.get("id")), act = String(fd.get("act")), reason = String(fd.get("reason") ?? "").trim();
  const { error } = act === "review" || act === "takedown"
    ? await sb.rpc("copyright_review", { p_case: id, p_takedown: act === "takedown" })
    : await sb.rpc("copyright_decide", { p_case: id, p_outcome: act, p_reason: reason });
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
}

async function orphanAction(fd: FormData) {
  "use server";
  const sb = await requireAdmin();
  const { error } = await sb.rpc("orphan_approve", { p_key: String(fd.get("key")) });
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
}

async function ratingAction(fd: FormData) {
  "use server";
  const sb = await requireStaff();
  const { error } = await sb.rpc("admin_set_series_rating", { p_series: String(fd.get("series")), p_rating: String(fd.get("rating")), p_reason: String(fd.get("reason") ?? "") });
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
}

async function dobCorrectionAction(fd: FormData) {
  "use server";
  const sb = await requireAdmin();
  const { data: target } = await sb.from("profiles").select("id").eq("username", String(fd.get("username")).toLowerCase()).single();
  if (!target) throw new Error("user not found");
  const dob = String(fd.get("date_of_birth") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new Error("invalid date of birth");
  // admin_set_date_of_birth (migration 0023) validates plausibility, writes the audit
  // log, and clears the user's age-policy acceptance — they must confirm again on /age.
  const { error } = await sb.rpc("admin_set_date_of_birth", { p_user: target.id, p_dob: dob });
  if (error) throw new Error(error.message);
  revalidatePath("/admin");
}

async function suspendAction(fd: FormData) {
  "use server";
  const sb = await requireAdmin();
  await sb.from("profiles").update({ suspended: fd.get("on") === "1" }).eq("username", String(fd.get("username")).toLowerCase());
  revalidatePath("/admin");
}

export default async function Admin() {
  const sb = supabaseServer();
  const role = await roleOf(sb);
  if (role !== "admin" && role !== "moderator") notFound();
  const { data: cases } = await sb.rpc("staff_copyright_cases");
  const { data: orphans } = role === "admin" ? await sb.from("orphan_candidates").select("object_key,size_bytes,uploaded_at").eq("state", "candidate").order("uploaded_at").limit(50) : { data: null };
  const { data: reports } = await sb.from("reports").select("id,target_type,target_id,reason,description,status,created_at").in("status", ["open", "reviewing", "actioned"]).order("created_at", { ascending: false }).limit(50);
  return (
    <>
      <h1 className="mb-6 mt-4 text-3xl font-bold tracking-tight">Moderation</h1>
      <section>
        <h2 className="mb-3 text-lg font-semibold">Reports</h2>
        {reports?.length ? <ul className="grid gap-3">{reports.map((r) => (
          <li key={r.id} className="neu-sm flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span className="min-w-[10rem] flex-1"><b>{r.reason}</b> · {r.target_type}<span className="block text-xs text-mute">{r.status} · {new Date(r.created_at).toLocaleDateString()}</span></span>
            <form action={reportAction} className="flex gap-2">
              <input type="hidden" name="id" value={r.id} /><input type="hidden" name="type" value={r.target_type} /><input type="hidden" name="target" value={r.target_id} />
              <input name="reason" required minLength={3} placeholder="Reason" aria-label="Reason" className="neu-in bg-transparent px-3 py-1 text-sm" />
              {r.status === "actioned" ? <button name="act" value="restore" className="btn">Restore content</button>
                : <><button name="act" value="archive" className="btn">Remove content</button><button name="act" value="dismiss" className="btn">Dismiss</button></>}
            </form>
          </li>))}</ul> : <p className="neu-in p-8 text-center text-sm text-mute">No open reports.</p>}
      </section>
      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">Copyright cases</h2>
        {cases?.length ? <ul className="grid gap-3">{cases.map((c: any) => (
          <li key={c.id} className="neu-sm grid gap-2 px-5 py-3 text-sm">
            <span><b>{c.status}</b> · {c.claimant_name} ({c.claimant_email}) · {new Date(c.received_at).toLocaleDateString()}</span>
            <span className="text-xs text-mute">{c.work_description}</span>
            <span className="break-all text-xs">{(c.target_urls as string[]).join(" ")}</span>
            {c.creator_response && <span className="text-xs"><b>Creator response:</b> {c.creator_response}</span>}
            {!["reinstated", "rejected", "closed"].includes(c.status) && (
              <form action={copyrightAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={c.id} />
                <input name="reason" placeholder="Decision reason (10+ chars)" aria-label="Decision reason" className="neu-in min-w-[10rem] flex-1 bg-transparent px-3 py-1 text-sm" />
                {["received", "reviewing"].includes(c.status) && <><button name="act" value="review" className="btn">Start review</button><button name="act" value="takedown" className="btn">Take down + notify</button></>}
                <button name="act" value="uphold" className="btn">Uphold</button><button name="act" value="reinstate" className="btn">Reinstate</button><button name="act" value="reject" className="btn">Reject</button>
              </form>)}
          </li>))}</ul> : <p className="neu-in p-8 text-center text-sm text-mute">No copyright cases.</p>}
      </section>
      {role === "admin" && <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">Unreferenced media (dry run)</h2>
        {orphans?.length ? <ul className="grid gap-2">{orphans.map((o: any) => (
          <li key={o.object_key} className="neu-sm flex flex-wrap items-center gap-3 px-5 py-2 text-xs">
            <span className="min-w-[10rem] flex-1 break-all">{o.object_key} · {Math.round(o.size_bytes / 1024)} KB · {new Date(o.uploaded_at).toLocaleDateString()}</span>
            <form action={orphanAction}><input type="hidden" name="key" value={o.object_key} /><button className="btn">Queue deletion</button></form>
          </li>))}</ul> : <p className="neu-in p-6 text-center text-sm text-mute">No candidates.</p>}
      </section>}
      {role === "admin" && <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">Users</h2>
        <form action={suspendAction} className="neu flex flex-wrap items-center gap-3 p-5">
          <input name="username" required placeholder="Username" aria-label="Username" className="neu-in min-w-[10rem] flex-1 bg-transparent px-4 py-2 text-sm" />
          <button name="on" value="1" className="btn">Suspend</button><button name="on" value="0" className="btn">Restore</button>
        </form>
      </section>}
      <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">Content rating override (SEC-007)</h2>
        <form action={ratingAction} className="neu flex flex-wrap items-center gap-3 p-5">
          <input name="series" required placeholder="Series ID (uuid)" aria-label="Series ID" className="neu-in min-w-[12rem] flex-1 bg-transparent px-4 py-2 text-sm" />
          <select name="rating" aria-label="New rating" className="neu-in bg-transparent px-3 py-2 text-sm"><option value="everyone" className="text-black">everyone</option><option value="teen" className="text-black">teen</option><option value="mature" className="text-black">mature</option></select>
          <input name="reason" required minLength={3} placeholder="Reason" aria-label="Reason" className="neu-in min-w-[10rem] flex-1 bg-transparent px-4 py-2 text-sm" />
          <button className="btn">Change rating</button>
        </form>
        <p className="mt-2 text-xs text-mute">Recorded in the audit log via the admin_set_series_rating RPC. Use a series ID from a report or the series page URL in Studio.</p>
      </section>
      {role === "admin" && <section className="mt-10">
        <h2 className="mb-3 text-lg font-semibold">Date of birth correction (admin)</h2>
        <form action={dobCorrectionAction} className="neu flex flex-wrap items-center gap-3 p-5">
          <input name="username" required placeholder="Username" aria-label="Username" className="neu-in min-w-[10rem] flex-1 bg-transparent px-4 py-2 text-sm" />
          <input name="date_of_birth" type="date" required aria-label="Corrected date of birth" className="neu-in bg-transparent px-3 py-2 text-sm" />
          <button className="btn">Correct DOB</button>
        </form>
        <p className="mt-2 text-xs text-mute">Age access in v9 is self-declared: it comes from the date of birth on the profile plus the user&apos;s own recorded age-policy confirmation. Correcting a date of birth here is audit-logged and resets that user&apos;s confirmation — they must confirm again on the age page before mature content unlocks.</p>
      </section>}
      <p className="mt-8 text-sm text-mute"><Link href="/studio" className="underline">Back to Studio</Link></p>
    </>
  );
}
