"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { LikeButton } from "./LikeButton";

type C = { id: string; content: string; created_at: string; parent_comment_id: string | null; user_id: string; profiles: { display_name: string } | null };

export function Comments({ seriesId }: { seriesId: string }) {
  const router = useRouter();
  const [list, setList] = useState<C[]>([]);
  const [uid, setUid] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [newest, setNewest] = useState(false);

  const load = useCallback(async () => {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser(); setUid(user?.id ?? null);
    const { data } = await sb.from("comments").select("id,content,created_at,parent_comment_id,user_id,profiles(display_name)").eq("series_id", seriesId).order("created_at", { ascending: true }).limit(200);
    setList((data as any) ?? []);
  }, [seriesId]);
  useEffect(() => { load(); }, [load]);

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!uid) return router.push(`/login?next=${encodeURIComponent(location.pathname)}`);
    const { error } = await supabaseBrowser().from("comments").insert({ user_id: uid, series_id: seriesId, parent_comment_id: reply, content: text.trim() });
    if (error) return setMsg("Could not post your comment.");
    setText(""); setReply(null); setMsg(""); load();
  }
  async function remove(id: string) { await supabaseBrowser().from("comments").delete().eq("id", id); load(); }
  async function report(id: string) {
    if (!uid) return router.push("/login");
    const { error } = await supabaseBrowser().from("reports").insert({ reporter_id: uid, target_type: "comment", target_id: id, reason: "Harassment" });
    setMsg(error ? "Could not send the report." : "Report sent. Our team will review it.");
  }

  const top = list.filter((c) => !c.parent_comment_id);
  if (newest) top.reverse(); // list is loaded oldest first
  const item = (c: C, nested = false) => (
    <li key={c.id} className={`neu-sm p-4 text-sm ${nested ? "ml-6 mt-3" : ""}`}>
      <div className="flex items-baseline justify-between gap-3"><b>{c.profiles?.display_name ?? "Reader"}</b><time className="text-xs text-mute">{new Date(c.created_at).toLocaleDateString()}</time></div>
      <p className="mt-1 whitespace-pre-wrap break-words">{c.content}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <LikeButton type="comment" id={c.id} />
        {!nested && <button className="btn" onClick={() => setReply(c.id)}>Reply</button>}
        {c.user_id === uid ? <button className="btn" onClick={() => remove(c.id)}>Delete</button> : <button className="btn" onClick={() => report(c.id)}>Report</button>}
      </div>
      {!nested && list.filter((r) => r.parent_comment_id === c.id).map((r) => item(r, true))}
    </li>
  );
  return (
    <section id="comments" className="mt-10 scroll-mt-6" aria-label="Comments">
      <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Comments · {list.length}</h2>
        <select aria-label="Sort comments" value={newest ? "new" : "old"} onChange={(e) => setNewest(e.target.value === "new")} className="btn bg-transparent"><option value="old" className="text-black">Oldest first</option><option value="new" className="text-black">Newest first</option></select></div>
      <form onSubmit={post} className="neu grid gap-3 p-5">
        {reply && <p className="text-sm text-mute">Replying to a comment. <button type="button" className="underline" onClick={() => setReply(null)}>Cancel</button></p>}
        <textarea value={text} onChange={(e) => setText(e.target.value)} required maxLength={2000} rows={3} placeholder={uid ? "Share your thoughts" : "Sign in to comment"} aria-label="Comment" className="neu-in w-full bg-transparent px-4 py-3 text-sm outline-none" />
        <div className="flex items-center justify-between gap-3"><span role="status" className="text-sm text-mute">{msg}</span><button className="btn-primary">Post comment</button></div>
      </form>
      {top.length ? <ul className="mt-5 grid gap-4">{top.map((c) => item(c))}</ul> : <p className="neu-in mt-5 p-6 text-center text-sm text-mute">No comments yet. Be the first to share a thought.</p>}
    </section>
  );
}
