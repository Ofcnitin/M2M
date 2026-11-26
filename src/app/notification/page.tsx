import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { describe, type Notif } from "@/lib/notifications";
import { CONTENT_WARNINGS, sanitizeContentWarnings } from "@/lib/age-core";
import { timeAgo } from "@/lib/format";
import { MarkRead } from "@/components/MarkRead";

export const metadata = { title: "Notifications" };

const PREFS = [["new_chapter", "New chapters from creators and series I follow"], ["comment_reply", "Replies to my comments"], ["series_comment", "Comments on my series"], ["new_follower", "New followers"]] as const;

async function savePrefs(fd: FormData) {
  "use server";
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  await sb.from("notification_preferences").upsert(PREFS.map(([type]) => ({ user_id: user.id, type, enabled: fd.get(type) === "on" })));
  revalidatePath("/notifications");
}

// Content preferences live on the user's own profiles row (0024). The RLS client is
// enough: profiles_update_own allows a user to update their own row, and the
// profiles_guard trigger pins only DOB/verification columns (plus role/suspended
// changes) — it does not revert show_mature_content or excluded_warnings.
async function saveContentPrefs(fd: FormData) {
  "use server";
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  await sb.from("profiles").update({
    show_mature_content: fd.get("show_mature_content") === "on",
    excluded_warnings: sanitizeContentWarnings(fd.getAll("excluded_warning").map(String)),
  }).eq("id", user.id);
  revalidatePath("/notifications");
}

export default async function Notifications() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/notifications");
  const { data } = await sb.from("notifications")
    .select("id,type,read_at,created_at,series_id,chapter_id,actor:profiles!actor_id(display_name),series(slug,title),chapters(chapter_number)")
    .order("created_at", { ascending: false }).limit(50);
  const list = (data as unknown as Notif[]) ?? [];
  const { data: prefRows } = await sb.from("notification_preferences").select("type,enabled");
  const off = new Set((prefRows ?? []).filter((p) => !p.enabled).map((p) => p.type));
  const { data: profile } = await sb.from("profiles").select("show_mature_content,excluded_warnings").eq("id", user.id).maybeSingle();
  const cp = profile as unknown as { show_mature_content?: boolean | null; excluded_warnings?: string[] | null } | null;
  const showMaturePref = cp?.show_mature_content === true;
  const excludedWarnings = new Set<string>(cp?.excluded_warnings ?? []);
  const unread = list.some((n) => !n.read_at);
  return (
    <>
      <h1 className="mb-6 mt-4 text-3xl font-bold tracking-tight">Notifications</h1>
      <MarkRead unread={unread} />
      {list.length ? (
        <ul className="grid gap-3">{list.map((n) => {
          const d = describe(n);
          return (
            <li key={n.id}><Link href={d.href} className="neu-sm flex items-start justify-between gap-4 px-5 py-4 text-sm">
              <span className="flex items-start gap-3">
                {!n.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky" aria-label="New" />}
                <span className={n.read_at ? "text-mute" : "font-semibold"}>{d.text}</span>
              </span>
              <time dateTime={n.created_at} className="shrink-0 text-xs text-mute">{timeAgo(n.created_at)}</time></Link></li>);
        })}</ul>
      ) : <p className="neu-in p-10 text-center text-mute">You&apos;re all caught up. Follow creators or add series to your library to hear about new chapters.</p>}
      <form action={savePrefs} className="neu-sm mt-8 grid gap-3 p-5 text-sm">
        <h2 className="font-semibold">Notification settings</h2>
        {PREFS.map(([type, label]) => (
          <label key={type} className="flex items-center gap-3"><input type="checkbox" name={type} defaultChecked={!off.has(type)} />{label}</label>
        ))}
        <button className="btn w-fit">Save settings</button>
      </form>
      <form action={saveContentPrefs} className="neu-sm mt-8 grid gap-3 p-5 text-sm">
        <h2 className="font-semibold">Content preferences</h2>
        <label className="flex items-center gap-3"><input type="checkbox" name="show_mature_content" defaultChecked={showMaturePref} />Show Mature 18+ series in discovery and search</label>
        <fieldset>
          <legend className="mb-2 text-mute">Hide series with these themes from my discovery</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {CONTENT_WARNINGS.map((w) => (
              <label key={w.value} className="flex items-center gap-2"><input type="checkbox" name="excluded_warning" value={w.value} defaultChecked={excludedWarnings.has(w.value)} />{w.label}</label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-mute">These preferences only affect discovery and search listings. They do not change what you can open directly, and showing mature series still requires age verification.</p>
        <button className="btn w-fit">Save content preferences</button>
      </form>
      <p className="mt-6 text-xs text-mute">Notifications are kept for 90 days.</p>
    </>
  );
}
