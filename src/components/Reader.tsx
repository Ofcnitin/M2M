"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Asset = { id: string; src: string; w: number | null; h: number | null };
type Props = {
  chapterId: string; seriesId: string; mode: string; title: string; seriesHref: string;
  prevHref: string | null; nextHref: string | null; assets: Asset[]; initialPos: number | null;
};
type Settings = { width: "narrow" | "medium" | "wide"; bg: "theme" | "dark" | "black" | "white"; gap: boolean; fit: "width" | "screen" };

const DEFAULTS: Settings = { width: "medium", bg: "theme", gap: false, fit: "width" };
const WIDTH = { narrow: 560, medium: 720, wide: 960 };
const BG: Record<Settings["bg"], string | undefined> = { theme: undefined, dark: "#15181d", black: "#000", white: "#fff" };
const SETTINGS_KEY = "m2m:reader:v1";

function Img({ a, n, total, fit }: { a: Asset; n: number; total: number; fit?: "width" | "screen" }) {
  const [failed, setFailed] = useState(0);
  // width/height reserve space so the strip never shifts while images load.
  return failed > 2 ? (
    <button className="btn m-4" onClick={() => setFailed(0)}>Image failed to load. Retry</button>
  ) : (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img key={failed} src={a.src} width={a.w ?? undefined} height={a.h ?? undefined} loading="lazy" decoding="async" alt={`Page ${n} of ${total}`}
      onError={() => setTimeout(() => setFailed((x) => x + 1), 800 * 2 ** failed)}
      style={fit === "screen" ? { maxHeight: "calc(100vh - 8rem)", width: "auto", height: "auto", margin: "0 auto" } : { width: "100%", height: "auto", display: "block" }}
      className={`block ${fit === "screen" ? "" : "h-auto w-full"}`} data-asset={a.id} />
  );
}

export function Reader({ chapterId, seriesId, mode, title, seriesHref, prevHref, nextHref, assets, initialPos }: Props) {
  const router = useRouter();
  const [view, setView] = useState<"v" | "p">(mode === "vertical" ? "v" : "p");
  const [rtl, setRtl] = useState(mode === "page_rtl");
  const [page, setPage] = useState(0);
  const [pct, setPct] = useState(0);
  const [panel, setPanel] = useState(false);
  const [cfg, setCfg] = useState<Settings>(DEFAULTS);
  const [note, setNote] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const sent = useRef(false);
  const pending = useRef<{ position: number; assetId: string | null; done: boolean } | null>(null);
  const doneRef = useRef(false);
  const visible = useRef(new Set<string>());
  const touch = useRef<number | null>(null);
  const resumed = useRef(false);

  // Reading preferences persist on this device only.
  useEffect(() => { try { const raw = localStorage.getItem(SETTINGS_KEY); if (raw) setCfg({ ...DEFAULTS, ...JSON.parse(raw) }); } catch {} }, []);
  const update = (patch: Partial<Settings>) => setCfg((c) => { const n = { ...c, ...patch }; try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(n)); } catch {} return n; });

  // Sends the latest pending position. keepalive lets the request finish while the page is closing.
  const flush = useCallback(async () => {
    const p = pending.current; if (!p) return; pending.current = null;
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) { try { localStorage.setItem(`m2m:p:${seriesId}`, JSON.stringify({ chapterId, position: p.position })); } catch {} return; }
    if (p.done && !sent.current) { sent.current = true; fetch("/api/track", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seriesId, chapterId }) }).catch(() => {}); }
    fetch("/api/progress", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesId, chapterId, assetId: p.assetId, position: p.position, completed: p.done }) })
      .then((r) => { if (!r.ok) pending.current ??= p; }).catch(() => { pending.current ??= p; }); // keep it for the next flush if the request failed
  }, [chapterId, seriesId]);

  // Debounced progress sync. Completion is sticky within a visit: scrolling back up does not un-finish a chapter.
  const save = useCallback((position: number, assetId: string | null, done: boolean) => {
    doneRef.current = doneRef.current || done;
    pending.current = { position, assetId, done: doneRef.current };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1200);
  }, [flush]);

  // Final flush when the tab is hidden or closed, and when leaving the reader.
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") { clearTimeout(timer.current); flush(); } };
    document.addEventListener("visibilitychange", hide);
    addEventListener("pagehide", hide as any);
    return () => { document.removeEventListener("visibilitychange", hide); removeEventListener("pagehide", hide as any); clearTimeout(timer.current); flush(); };
  }, [flush]);

  // Track which images are on screen so progress also records a stable asset cursor, not only a scroll fraction.
  useEffect(() => {
    if (view !== "v") return;
    const io = new IntersectionObserver((es) => es.forEach((e) => { const id = (e.target as HTMLElement).dataset.asset!; e.isIntersecting ? visible.current.add(id) : visible.current.delete(id); }), { rootMargin: "0px" });
    document.querySelectorAll("[data-asset]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [view, assets.length]);
  const topAsset = () => assets.find((a) => visible.current.has(a.id))?.id ?? null;

  // Resume where the reader left off: server value for signed-in users, localStorage for guests.
  useEffect(() => {
    if (resumed.current) return; resumed.current = true;
    let pos = initialPos;
    if (pos == null) { try { const raw = localStorage.getItem(`m2m:p:${seriesId}`); const j = raw ? JSON.parse(raw) : null; if (j?.chapterId === chapterId) pos = Number(j.position); } catch {} }
    if (!pos || !(pos > 0.02 && pos < 0.97)) return;
    const p = pos;
    if (view === "v") requestAnimationFrame(() => { scrollTo(0, p * Math.max(0, document.documentElement.scrollHeight - innerHeight)); });
    else setPage(Math.min(assets.length - 1, Math.round(p * assets.length)));
    setNote("Resumed where you left off.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view !== "v") return;
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      const p = max > 0 ? scrollY / max : 0;
      setPct(p); save(p, topAsset(), p > 0.97);
    };
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [view, save, assets]);

  useEffect(() => {
    if (view !== "p") return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("select,input,textarea")) return;
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) go(rtl ? -d : d);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });

  // Preload the next pages so turning is instant, without loading the whole chapter.
  useEffect(() => { if (view === "p") [1, 2, -1].forEach((d) => { const a = assets[page + d]; if (a) { const im = new Image(); im.src = a.src; } }); }, [view, page, assets]);
  const toggleFullscreen = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => setNote("Fullscreen is not available here.")); };
  const go = (d: number) => setPage((p) => { const n = Math.max(0, Math.min(assets.length - 1, p + d)); setPct((n + 1) / assets.length); save(n / assets.length, assets[n]?.id ?? null, n === assets.length - 1); return n; });
  const startOver = () => { setNote(""); if (view === "v") scrollTo(0, 0); else setPage(0); };

  async function report(reason: string) {
    if (!reason) return;
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return router.push(`/login?next=${encodeURIComponent(location.pathname)}`);
    const { error } = await sb.from("reports").insert({ reporter_id: user.id, target_type: "chapter", target_id: chapterId, reason });
    setNote(error ? "Could not send the report." : "Report sent. Our team will review it.");
  }

  const seg = (on: boolean) => `btn ${on ? "font-semibold [box-shadow:inset_4px_4px_9px_var(--lo),inset_-4px_-4px_9px_var(--hi)]" : ""}`;
  const nav = (
    <div className="flex flex-wrap justify-center gap-3 p-8">
      {prevHref && <Link href={prevHref} className="btn">Previous chapter</Link>}
      <Link href={seriesHref} className="btn">Back to series</Link>
      {nextHref && <Link href={nextHref} className="btn-primary">Next chapter</Link>}
    </div>
  );
  const maxW = WIDTH[cfg.width];
  return (
    <div className="-mx-5 min-h-screen">
      <div className="sticky top-0 z-10 bg-bg/95 px-5 pb-2 pt-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={seriesHref} className="btn">Back to series</Link>
          <span className="min-w-[8rem] flex-1 font-semibold">{title}</span>
          <button className="btn" aria-pressed={view === "v"} onClick={() => setView("v")}>Vertical</button>
          <button className="btn" aria-pressed={view === "p"} onClick={() => setView("p")}>Page</button>
          {view === "p" && <button className="btn" onClick={() => setRtl(!rtl)}>{rtl ? "Right to left" : "Left to right"}</button>}
          {view === "p" && <button className="btn" aria-pressed={cfg.fit === "screen"} onClick={() => update({ fit: cfg.fit === "screen" ? "width" : "screen" })}>{cfg.fit === "screen" ? "Fit screen" : "Fit width"}</button>}
          <button className="btn" onClick={toggleFullscreen}>Fullscreen</button>
          <button className="btn" aria-expanded={panel} aria-controls="reader-settings" onClick={() => setPanel(!panel)}>Settings</button>
        </div>
        {panel && (
          <div id="reader-settings" className="neu-sm mt-3 grid gap-4 p-4 text-sm sm:grid-cols-3">
            <div role="group" aria-label="Width"><b className="mb-2 block text-xs text-mute">Width</b>
              <div className="flex flex-wrap gap-2">{(["narrow", "medium", "wide"] as const).map((w) => <button key={w} aria-pressed={cfg.width === w} className={seg(cfg.width === w)} onClick={() => update({ width: w })}>{w}</button>)}</div></div>
            <div role="group" aria-label="Background"><b className="mb-2 block text-xs text-mute">Background</b>
              <div className="flex flex-wrap gap-2">{(["theme", "dark", "black", "white"] as const).map((b) => <button key={b} aria-pressed={cfg.bg === b} className={seg(cfg.bg === b)} onClick={() => update({ bg: b })}>{b}</button>)}</div></div>
            <div role="group" aria-label="Spacing"><b className="mb-2 block text-xs text-mute">Space between images</b>
              <div className="flex gap-2"><button aria-pressed={!cfg.gap} className={seg(!cfg.gap)} onClick={() => update({ gap: false })}>None</button><button aria-pressed={cfg.gap} className={seg(cfg.gap)} onClick={() => update({ gap: true })}>Small</button></div></div>
            <div className="sm:col-span-3"><select aria-label="Report chapter" defaultValue="" onChange={(e) => { report(e.target.value); e.target.value = ""; }} className="btn bg-transparent">
              <option value="" className="text-black">Report this chapter</option>
              {["Copyright", "Prohibited content", "Harassment", "Spam"].map((r) => <option key={r} value={r} className="text-black">{r}</option>)}</select></div>
          </div>)}
        <div className="neu-in mt-3 h-1.5 overflow-hidden"><i className="block h-full bg-sky" style={{ width: `${pct * 100}%` }} /></div>
        {note && <p role="status" className="mt-2 text-xs text-mute">{note} {note.startsWith("Resumed") && <button className="underline" onClick={startOver}>Start over</button>}</p>}
      </div>
      <div style={{ background: BG[cfg.bg] }} className="min-h-screen">
        {!assets.length ? <p className="p-10 text-center text-mute">This chapter has no pages yet.</p> : view === "v" ? (
          <div data-reader-strip className={`w-full ${cfg.gap ? "grid gap-2" : "grid gap-0"}`} style={{ ["--reader-max" as string]: `${maxW}px` }}>
            <style>{`@media (min-width: 640px){[data-reader-strip]{max-width:var(--reader-max);margin-inline:auto}}`}</style>
            {assets.map((a, i) => (
              <div key={a.id} style={{ contentVisibility: "auto", containIntrinsicSize: a.w && a.h ? `auto ${Math.round((a.h / a.w) * maxW)}px` : undefined, lineHeight: 0 }}>
                <Img a={a} n={i + 1} total={assets.length} />
              </div>))}
            {nav}
          </div>
        ) : (
          <div className="mx-auto px-5 py-4" style={{ maxWidth: cfg.fit === "screen" ? undefined : Math.min(maxW, 720), touchAction: "pan-y" }}
            onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
            onTouchEnd={(e) => { if (touch.current == null) return; const dx = e.changedTouches[0].clientX - touch.current; touch.current = null; if (Math.abs(dx) > 50) go((dx < 0 ? 1 : -1) * (rtl ? -1 : 1)); }}>
            <Img a={assets[page]} n={page + 1} total={assets.length} fit={cfg.fit} />
            <div className="flex items-center justify-center gap-4 p-4 text-sm text-mute">
              <button className="btn" onClick={() => go(rtl ? 1 : -1)}>{rtl ? "Next" : "Previous"}</button>
              <span>{page + 1} / {assets.length}</span>
              <button className="btn" onClick={() => go(rtl ? -1 : 1)}>{rtl ? "Previous" : "Next"}</button>
            </div>
            {page === assets.length - 1 && nav}
          </div>
        )}
      </div>
    </div>
  );
}
