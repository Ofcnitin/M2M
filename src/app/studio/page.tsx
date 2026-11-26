import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Creator Studio" };

async function respondInvite(fd: FormData) {
  "use server";
  const sb = supabaseServer();
  const { error } = await sb.rpc("respond_contributor_invite", { p_id: String(fd.get("id")), p_accept: fd.get("accept") === "1" });
  if (error) throw new Error(error.message);
  revalidatePath("/studio");
}

export default async function Studio() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/studio");
  const { data: me } = await sb.from("profiles").select("role,display_name").eq("id", user.id).single();
  const { data: perms } = await sb.from("contributor_permissions").select("id,role,status,series_id").eq("user_id", user.id).in("status", ["invited", "active"]);
  const permSeries = perms?.length ? (await sb.from("series").select("id,title").in("id", perms.map((p) => p.series_id))).data ?? [] : [];
  const titleOf = (id: string) => permSeries.find((x) => x.id === id)?.title ?? "Series";
  if (me?.role === "reader" && !perms?.length) return (
    <section className="neu mt-4 p-8"><h1 className="text-2xl font-bold">Start publishing</h1>
      <p className="mt-2 text-mute">Activate your creator profile to create series and upload chapters.</p>
      <Link href="/studio/onboard" className="btn-primary mt-5 inline-block">Set up creator profile</Link></section>
  );
  const { data: series } = await sb.from("series").select("id,title,visibility,chapters(count)").eq("creator_id", user.id).order("updated_at", { ascending: false });
  return (
    <>
      <h1 className="mb-6 mt-4 text-3xl font-bold tracking-tight">Creator Studio</h1>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="neu-in p-6"><b className="block text-3xl">{series?.length ?? 0}</b><span className="text-sm text-mute">Series</span></div>
        <div className="neu-in p-6"><b className="block text-3xl">{series?.reduce((n, s: any) => n + (s.chapters?.[0]?.count ?? 0), 0) ?? 0}</b><span className="text-sm text-mute">Chapters</span></div>
      </div>
      <div className="mb-4 mt-9 flex items-center justify-between"><h2 className="text-lg font-semibold">My series</h2><div className="flex gap-3"><Link href="/studio/copyright" className="btn">Copyright</Link><Link href="/studio/analytics" className="btn">Analytics</Link><Link href="/studio/series/new" className="btn-primary">Create series</Link></div></div>
      {series?.length ? <ul className="grid gap-3">{series.map((s: any) => (
        <li key={s.id}><Link href={`/studio/series/${s.id}`} className="neu-sm flex justify-between px-5 py-3 text-sm"><span>{s.title}</span><span className="text-mute">{s.visibility}</span></Link></li>))}</ul>
        : <p className="neu-in p-8 text-center text-mute">No series yet. Create your first series to begin.</p>}
      {perms?.length ? <>
        <h2 className="mb-4 mt-9 text-lg font-semibold">Shared with me</h2>
        <ul className="grid gap-3">{perms.map((p: any) => (
          <li key={p.id} className="neu-sm flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            {p.status === "active" ? <Link href={`/studio/series/${p.series_id}`} className="min-w-[10rem] flex-1">{titleOf(p.series_id)} <span className="text-mute">· {p.role}</span></Link>
              : <><span className="min-w-[10rem] flex-1">Invitation: {titleOf(p.series_id)} <span className="text-mute">· {p.role}</span></span>
                <form action={respondInvite} className="flex gap-2"><input type="hidden" name="id" value={p.id} /><button name="accept" value="1" className="btn-primary">Accept</button><button name="accept" value="0" className="btn">Decline</button></form></>}
          </li>))}</ul></> : null}
    </>
  );
}
