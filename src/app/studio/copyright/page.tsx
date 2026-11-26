import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata = { title: "Copyright notices" };

async function respond(fd: FormData) {
  "use server";
  const sb = supabaseServer();
  const { error } = await sb.rpc("copyright_respond", { p_case: String(fd.get("id")), p_response: String(fd.get("response") ?? "") });
  if (error) throw new Error(error.message);
  revalidatePath("/studio/copyright");
}

export default async function CreatorCopyright() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/studio/copyright");
  // RLS and column grants limit this to cases against the creator's own series, without claimant contact details.
  const { data: cases } = await sb.from("copyright_cases")
    .select("id,work_description,target_urls,status,received_at,creator_response_due_at,creator_response,decision_reason").order("received_at", { ascending: false });
  return (
    <>
      <h1 className="mb-6 mt-4 text-3xl font-bold tracking-tight">Copyright notices</h1>
      {cases?.length ? <ul className="grid gap-4">{cases.map((c: any) => (
        <li key={c.id} className="neu-sm grid gap-2 px-5 py-4 text-sm">
          <span><b>{c.status.replace("_", " ")}</b> · received {new Date(c.received_at).toLocaleDateString()}{c.creator_response_due_at && ` · respond by ${new Date(c.creator_response_due_at).toLocaleDateString()}`}</span>
          <span className="text-xs text-mute">Claimed work: {c.work_description}</span>
          <span className="break-all text-xs">{(c.target_urls as string[]).join(" ")}</span>
          {c.decision_reason && <span className="text-xs"><b>Decision:</b> {c.decision_reason}</span>}
          {c.creator_response ? <span className="text-xs"><b>Your response:</b> {c.creator_response}</span>
            : ["reviewing", "content_removed"].includes(c.status) && (
              <form action={respond} className="grid gap-2">
                <input type="hidden" name="id" value={c.id} />
                <label className="grid gap-1 text-xs">Your response or appeal (20 to 4000 characters)
                  <textarea name="response" required minLength={20} maxLength={4000} rows={4} className="neu-in bg-transparent px-3 py-2 text-sm" /></label>
                <button className="btn">Send response</button>
              </form>)}
        </li>))}</ul> : <p className="neu-in p-8 text-center text-sm text-mute">No copyright notices.</p>}
      <p className="mt-8 text-sm text-mute"><Link href="/studio" className="underline">Back to Studio</Link></p>
    </>
  );
}
