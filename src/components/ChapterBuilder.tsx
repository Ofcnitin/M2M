"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

type A = { id: string; storage_key: string; processing_status: string };
type Ch = { id: string; series_id: string; chapter_number: number; publication_status: string; reading_mode: string };
const CDN = process.env.NEXT_PUBLIC_CDN_URL;
const OK = ["image/jpeg", "image/png", "image/webp"];
const MAX = 15 * 1024 * 1024;
const PARALLEL = 3; // bounded concurrency: unbounded Promise.all exhausts mobile memory and connections

// Runs async jobs with at most `limit` in flight, preserving start order.
async function pool<T>(items: T[], limit: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

export function ChapterBuilder({ chapter, initial }: { chapter: Ch; initial: A[] }) {
  const router = useRouter();
  const sb = supabaseBrowser();
  const [assets, setAssets] = useState(initial);
  const [prog, setProg] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState("");
  const [preview, setPreview] = useState(false);
  const [when, setWhen] = useState("");
  const retry = useRef<Record<string, { file: File }>>({});
  const active = useRef(0);
  const [busy, setBusy] = useState(false);
  const drag = useRef<number | null>(null);

  useEffect(() => setAssets(initial), [initial]);
  // Poll while the processing Worker is still validating images.
  useEffect(() => {
    if (!assets.some((a) => a.processing_status === "pending" || a.processing_status === "processing")) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [assets, router]);

  // Warn before leaving mid-upload: unfinished files stay pending and are failed automatically after two hours.
  useEffect(() => {
    if (!busy) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [busy]);

  // A signed URL expires after 10 minutes, so a retry always asks for a fresh one for the same asset.
  async function retryUpload(id: string) {
    const r = retry.current[id]; if (!r) return setMsg("Select the file again with Replace.");
    const res = await fetch("/api/uploads/resign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: id }) });
    const j = await res.json().catch(() => null);
    if (!res.ok) return setMsg(j?.error ?? "Could not retry this upload.");
    setBusy(true); active.current++;
    try { await put(id, j.url, r.file); } finally { if (--active.current === 0) setBusy(false); }
    router.refresh();
  }
  function put(id: string, url: string, file: File) {
    retry.current[id] = { file };
    return new Promise<void>((done) => {
      const x = new XMLHttpRequest();
      x.open("PUT", url); x.setRequestHeader("Content-Type", file.type);
      x.upload.onprogress = (e) => setProg((p) => ({ ...p, [id]: e.loaded / e.total }));
      x.onload = () => { const ok = x.status < 300; if (ok) delete retry.current[id]; setProg((p) => ({ ...p, [id]: ok ? 1 : -1 })); done(); };
      x.onerror = () => { setProg((p) => ({ ...p, [id]: -1 })); done(); };
      x.send(file);
    });
  }
  async function upload(list: FileList | File[]) {
    if (busy) return setMsg("Wait for the current uploads to finish."); // also stops double-click duplicates
    const files = Array.from(list), ok = files.filter((f) => OK.includes(f.type) && f.size <= MAX);
    setMsg(ok.length < files.length ? "Some files were skipped. Use JPEG, PNG or WebP up to 15 MB." : "");
    if (!ok.length) return;
    const r = await fetch("/api/uploads/sign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapterId: chapter.id, files: ok.map((f) => ({ type: f.type, size: f.size })) }) });
    const j = await r.json(); if (!r.ok) return setMsg(j.error);
    const ups = [...j.uploads].sort((a: any, b: any) => a.order - b.order);
    setBusy(true); active.current++;
    try { await pool(ups, PARALLEL, (u: any, i: number) => put(u.id, u.url, ok[i])); } finally { if (--active.current === 0) setBusy(false); }
    router.refresh();
  }
  async function move(from: number, to: number) {
    if (to < 0 || to >= assets.length || from === to) return;
    const next = [...assets]; next.splice(to, 0, next.splice(from, 1)[0]); setAssets(next);
    const { error } = await sb.rpc("reorder_chapter_assets", { p_chapter: chapter.id, p_ids: next.map((a) => a.id) });
    if (error) { setMsg("Could not save the new order."); router.refresh(); }
  }
  // Goes through the API so the file is deleted from storage as well as the database row.
  async function remove(id: string) {
    const r = await fetch("/api/uploads/asset", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: id }) });
    if (!r.ok) return setMsg((await r.json().catch(() => null))?.error ?? "Could not remove the image.");
    setAssets(assets.filter((a) => a.id !== id));
  }
  // Replace one image in place: same position, new file. It is hidden from readers until validated again.
  async function replace(a: A, file: File) {
    if (!OK.includes(file.type) || file.size > MAX) return setMsg("Use a JPEG, PNG or WebP up to 15 MB.");
    const r = await fetch("/api/uploads/asset", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: a.id, type: file.type, size: file.size }) });
    const j = await r.json(); if (!r.ok) return setMsg(j.error);
    setAssets((list) => list.map((x) => (x.id === a.id ? { ...x, processing_status: "pending" } : x)));
    await put(a.id, j.url, file);
    router.refresh();
  }
  async function publish() {
    const { error } = await sb.rpc("publish_chapter", { p_chapter: chapter.id, p_at: when ? new Date(when).toISOString() : null });
    setMsg(error ? (error.message.includes("not ready") ? "Publishing is blocked until every image has finished processing." : "Could not publish this chapter.") : when ? "Chapter scheduled." : "Chapter published.");
    router.refresh();
  }
  async function unpublish() { const { error } = await sb.rpc("unpublish_chapter", { p_chapter: chapter.id }); setMsg(error ? "Could not unpublish this chapter." : "Chapter unpublished."); router.refresh(); }
  async function del() {
    if (!confirm("Delete this chapter and all its images? This cannot be undone.")) return;
    await sb.from("chapters").delete().eq("id", chapter.id); router.push(`/studio/series/${chapter.series_id}`);
  }

  const ready = assets.length > 0 && assets.every((a) => a.processing_status === "ready");
  const failed = assets.filter((a) => a.processing_status === "failed").length;
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="neu p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Chapter {Number(chapter.chapter_number)}</h1>
          <span className="neu-in px-3 py-1 text-xs">{chapter.publication_status}</span>
        </div>
        <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }} className="neu-in mt-5 p-8 text-center text-sm text-mute">
          Drag images here, or
          <label className="btn-primary ml-2 inline-block cursor-pointer">Choose images<input type="file" multiple accept={OK.join(",")} className="sr-only" onChange={(e) => e.target.files && upload(e.target.files)} /></label>
        </div>
        {msg && <p role="status" className="mt-4 text-sm">{msg}</p>}
        {chapter.publication_status === "published" && <p className="mt-2 text-xs text-mute">This chapter is live. Replaced or added images stay hidden from readers until they finish validating.</p>}
        {failed > 0 && <p role="alert" className="mt-2 text-sm">{failed} image(s) failed validation. Remove them and upload valid files.</p>}
        {assets.length ? (
          <ol className="mt-5 grid gap-3">
            {assets.map((a, i) => (
              <li key={a.id} draggable onDragStart={() => (drag.current = i)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.stopPropagation(); if (drag.current !== null) move(drag.current, i); drag.current = null; }} className="neu-sm flex items-center gap-3 p-2.5">
                <div className="h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-wash">
                  {a.processing_status === "ready" && /* eslint-disable-next-line @next/next/no-img-element */ <img src={`${CDN}/${a.storage_key}`} alt="" loading="lazy" className="h-full w-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <b>Image {i + 1}</b>
                  <span className="block text-xs text-mute">
                    {prog[a.id] === -1 ? "Upload failed" : prog[a.id] !== undefined && prog[a.id] < 1 ? `Uploading ${Math.round(prog[a.id] * 100)}%` : a.processing_status}</span>
                </div>
                {prog[a.id] === -1 && <button className="btn" onClick={() => retryUpload(a.id)}>Retry</button>}
                <button className="btn" aria-label="Move up" onClick={() => move(i, i - 1)}>Up</button>
                <button className="btn" aria-label="Move down" onClick={() => move(i, i + 1)}>Down</button>
                <label className="btn cursor-pointer">Replace<input type="file" accept={OK.join(",")} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) replace(a, f); }} /></label>
                <button className="btn" onClick={() => remove(a.id)}>Remove</button>
              </li>))}
          </ol>) : <p className="mt-5 text-center text-sm text-mute">No images yet. Upload your pages to begin.</p>}
      </section>
      <aside className="neu grid content-start gap-4 p-7">
        <h2 className="text-lg font-semibold">Publish</h2>
        <button className="btn" onClick={() => setPreview(!preview)} disabled={!assets.length}>{preview ? "Close preview" : "Preview chapter"}</button>
        <label className="text-sm text-mute">Schedule (optional, your local time: {Intl.DateTimeFormat().resolvedOptions().timeZone})<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="neu-in mt-2 w-full bg-transparent px-3 py-2 text-sm" /></label>
        <button className="btn-primary disabled:opacity-40" disabled={!ready} onClick={publish}>{when ? "Schedule chapter" : "Publish chapter"}</button>
        {!ready && <p className="text-xs text-mute">Publishing unlocks when every image is uploaded and validated.</p>}
        {(chapter.publication_status === "published" || chapter.publication_status === "scheduled") && <button className="btn" onClick={unpublish}>Unpublish</button>}
        <button className="btn" onClick={del}>Delete chapter</button>
      </aside>
      {preview && (
        <div className="fixed inset-0 z-30 overflow-y-auto bg-bg p-5" role="dialog" aria-label="Chapter preview">
          <button className="btn sticky top-0 mb-4" onClick={() => setPreview(false)}>Close preview</button>
          <div className={`mx-auto ${chapter.reading_mode === "vertical" ? "max-w-[720px]" : "grid max-w-[520px] gap-6"}`}>
            {assets.filter((a) => a.processing_status === "ready").map((a) => /* eslint-disable-next-line @next/next/no-img-element */ <img key={a.id} src={`${CDN}/${a.storage_key}`} alt="" className="block w-full" />)}
          </div>
        </div>)}
    </div>
  );
}
