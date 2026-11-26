import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Team" };

async function invite(fd: FormData) {
  "use server";
  const sb = supabaseServer();
  const id = String(fd.get("series"));
  const { error } = await sb.rpc("invite_contributor", { p_series: id, p_username: String(fd.get("username") ?? ""), p_role: String(fd.get("role")) });
  if (error) redirect(`/studio/series/${id}/team?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/studio/series/${id}/team`);
}
async function revoke(fd: FormData) {
  "use server";
  const sb = supabaseServer();
  const { error } = await sb.rpc("revoke_contributor", { p_id: String(fd.get("id")) });
  if (error) throw new Error(error.message);
  revalidatePath(`/studio/series/${String(fd.get("series"))}/team`);
}

export default async function Team({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: role } = await sb.rpc("series_member_role", { sid: params.id });
  if (role !== "owner") notFound();
  const [{ data: s }, { data: team }] = await Promise.all([
    sb.from("series").select("title").eq("id", params.id).single(),
    sb.from("contributor_permissions").select("id,role,status,user_id,profiles!contributor_permissions_user_id_fkey(username,display_name)").eq("series_id", params.id).in("status", ["invited", "active"]),
  ]);
  return (
    <>
      <h1 className="mb-1 mt-4 text-3xl font-bold tracking-tight">Team</h1>
      <p className="mb-6 text-sm text-mute">{s?.title}. Editors can edit and publish chapters, uploaders can only add and arrange images, analysts see analytics. Credits shown to readers are separate and managed in series settings.</p>
      {searchParams.error && <p role="alert" className="neu-in mb-4 p-4 text-sm">{searchParams.error}</p>}
      <form action={invite} className="neu mb-6 flex flex-wrap items-center gap-3 p-5">
        <input type="hidden" name="series" value={params.id} />
        <input name="username" required placeholder="Username" aria-label="Username" className="neu-in min-w-[10rem] flex-1 bg-transparent px-4 py-2 text-sm" />
        <select name="role" aria-label="Role" className="neu-in bg-transparent px-3 py-2 text-sm"><option value="editor">Editor</option><option value="uploader">Uploader</option><option value="analyst">Analyst</option></select>
        <button className="btn">Invite</button>
      </form>
      {team?.length ? <ul className="grid gap-3">{team.map((m: any) => (
        <li key={m.id} className="neu-sm flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
          <span className="min-w-[10rem] flex-1">{m.profiles?.display_name ?? m.profiles?.username}<span className="block text-xs text-mute">{m.role} · {m.status}</span></span>
          <form action={revoke}><input type="hidden" name="id" value={m.id} /><input type="hidden" name="series" value={params.id} /><button className="btn">{m.status === "invited" ? "Cancel invite" : "Revoke access"}</button></form>
        </li>))}</ul> : <p className="neu-in p-8 text-center text-sm text-mute">No team members yet.</p>}
      <p className="mt-8 text-sm text-mute"><Link href={`/studio/series/${params.id}`} className="underline">Back to series</Link></p>
    </>
  );
}
