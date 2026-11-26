// Validates each uploaded image (signature, dimensions, size) and records the result. Trusted: uses the service key.
import { inspect } from "./image";

export interface Env { MEDIA: R2Bucket; MEDIA_PRIVATE?: R2Bucket; SUPABASE_URL: string; SUPABASE_SERVICE_KEY: string }
// SEC-007: restricted (mature) objects live under `restricted/`. When a separate private
// bucket is bound as MEDIA_PRIVATE it is used for those keys; otherwise they share MEDIA
// and MUST be kept off the public CDN domain by prefix (see README deployment checklist).
// LEGACY prefix-only fallback — used ONLY where no DB rating can be determined (cleanup of
// objects whose rows are already gone). Normal processing resolves the bucket from the
// series' DB content_rating via resolveBucket() below (v8 privacy fix).
const bucketFor = (env: Env, key: string): R2Bucket => (key.startsWith("restricted/") && env.MEDIA_PRIVATE ? env.MEDIA_PRIVATE : env.MEDIA);
const privateBucketFor = (env: Env): R2Bucket => env.MEDIA_PRIVATE ?? env.MEDIA;
type Msg = { action: string; object: { key: string; size: number } };

const CHAPTER_MAX = 15 * 1024 * 1024, COVER_MAX = 8 * 1024 * 1024;
const MAX_PIXELS = 80_000_000;
const HEAD = 256 * 1024, HEAD_MAX = 4 * 1024 * 1024; // widen the header read for images with large metadata, but stay bounded
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CHAPTER_KEY = new RegExp(`^(?:restricted/)?(${UUID})/(${UUID})/${UUID}\\.(jpg|png|webp)$`);
const COVER_KEY = new RegExp(`^(?:restricted/)?(${UUID})/cover/${UUID}\\.(jpg|png|webp)$`);

// Permanent = the input is bad or the request can never succeed; the message is acknowledged. Anything else is retried.
class Retryable extends Error {}

const rest = (env: Env, path: string, init: RequestInit = {}) =>
  fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json", ...init.headers } });

// Every Supabase call goes through here: a non-2xx response throws, so a failed state update is never treated as success.
async function db<T = unknown>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try { res = await rest(env, path, init); } catch (e) { throw new Retryable(`supabase unreachable: ${e}`); }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const msg = `supabase ${init.method ?? "GET"} ${path.split("?")[0]} -> ${res.status} ${body}`;
    if (res.status >= 500 || res.status === 429 || res.status === 408) throw new Retryable(msg);
    throw new Error(msg);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ── Rating-driven bucket resolution (v8 privacy fix) ──────────────────────────
// Privacy is decided by the owning series' content_rating fetched from Supabase, NOT by
// the key prefix alone: a mature asset is read/deleted from the PRIVATE binding even if
// its key lacks the restricted/ prefix (the bytes were signed into the private bucket by
// the app). Fail closed: if the rating lookup fails, restricted/ keys still resolve to
// the private binding, and an ordinary key with an unknown rating resolves to null —
// the caller skips + logs rather than touching the public bucket on a guess.
async function ratingForSeries(env: Env, seriesId: string): Promise<string | null> {
  try {
    const rows = await db<{ content_rating: string }[]>(env, `series?id=eq.${seriesId}&select=content_rating`);
    return rows[0]?.content_rating ?? null;
  } catch { return null; }
}

async function ratingForChapterAsset(env: Env, key: string): Promise<string | null> {
  try {
    const rows = await db<{ chapters: { series: { content_rating: string } | null } | null }[]>(
      env, `chapter_assets?storage_key=eq.${encodeURIComponent(key)}&select=chapters(series(content_rating))`);
    return rows[0]?.chapters?.series?.content_rating ?? null;
  } catch { return null; }
}

async function resolveBucket(env: Env, key: string, seriesId?: string): Promise<R2Bucket | null> {
  const rating = seriesId ? await ratingForSeries(env, seriesId) : await ratingForChapterAsset(env, key);
  if (rating === "mature") return privateBucketFor(env);
  if (key.startsWith("restricted/")) return privateBucketFor(env); // object physically lives in the private bucket
  if (rating !== null) return env.MEDIA;
  return null; // ambiguous: unknown rating + ordinary key — skip + log (fail closed)
}

async function readHead(env: Env, key: string, bucket: R2Bucket): Promise<{ info: ReturnType<typeof inspect>; size: number } | null> {
  let len = HEAD;
  while (true) {
    const obj = await bucket.get(key, { range: { offset: 0, length: len } });
    if (!obj) return null;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const info = inspect(bytes);
    if (info.status === "need_more" && len < HEAD_MAX && obj.size > len) { len = Math.min(HEAD_MAX, Math.max(len * 2, info.needed)); continue; }
    return { info: info.status === "need_more" ? { status: "invalid" } : info, size: obj.size };
  }
}

function acceptable(info: ReturnType<typeof inspect>, size: number, maxBytes: number, minSide: number, maxW: number, maxH: number) {
  if (info.status !== "ok") return null;
  const { w, h } = info;
  if (size > maxBytes || w < minSide || h < minSide || w > maxW || h > maxH || w * h > MAX_PIXELS) return null;
  return info;
}

async function processChapterAsset(env: Env, key: string) {
  const rows = await db<{ id: string; chapter_id: string; mime_type: string; processing_status: string }[]>(
    env, `chapter_assets?storage_key=eq.${encodeURIComponent(key)}&select=id,chapter_id,mime_type,processing_status`);
  const row = rows[0];
  if (!row) { console.warn(JSON.stringify({ evt: "unknown_object", key })); return; } // replaced or deleted before the event arrived
  if (row.processing_status === "ready" || row.processing_status === "failed") return; // duplicate delivery: already decided

  const bucket = await resolveBucket(env, key);
  if (!bucket) { console.warn(JSON.stringify({ evt: "bucket_unresolved_skip", key })); return; } // fail closed: never guess the public bucket
  const head = await readHead(env, key, bucket);
  if (!head) return; // object already gone
  const good = acceptable(head.info, head.size, CHAPTER_MAX, 100, 8000, 30000);
  const ok = !!good && good.mime === row.mime_type; // the bytes must match what the upload was authorised as
  const patch = ok ? { processing_status: "ready", original_width: good!.w, original_height: good!.h, file_size: head.size, mime_type: good!.mime }
                   : { processing_status: "failed" };
  const updated = await db<unknown[]>(env, `chapter_assets?storage_key=eq.${encodeURIComponent(key)}&processing_status=in.(pending,processing)`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
  if (!ok && updated.length) await bucket.delete(key); // rejected files are removed once the failure is recorded

  const all = await db<{ processing_status: string }[]>(env, `chapter_assets?chapter_id=eq.${row.chapter_id}&select=processing_status`);
  const gate = `chapters?id=eq.${row.chapter_id}&publication_status=in.(uploading,processing,failed)`;
  if (all.some((r) => r.processing_status === "failed")) await db(env, gate, { method: "PATCH", body: JSON.stringify({ publication_status: "failed" }) });
  else if (all.length && all.every((r) => r.processing_status === "ready")) await db(env, gate, { method: "PATCH", body: JSON.stringify({ publication_status: "draft" }) });
}

// Covers get the same byte-level checks. Only after they pass is the series row pointed at the new key,
// and the previous cover object is deleted.
async function processCover(env: Env, key: string, seriesId: string) {
  const bucket = await resolveBucket(env, key, seriesId);
  if (!bucket) { console.warn(JSON.stringify({ evt: "bucket_unresolved_skip", key })); return; } // fail closed
  const head = await readHead(env, key, bucket);
  if (!head) return;
  const good = acceptable(head.info, head.size, COVER_MAX, 200, 6000, 9000);
  if (!good) { await bucket.delete(key); console.warn(JSON.stringify({ evt: "cover_rejected", key })); return; }
  const cur = await db<{ cover_url: string | null }[]>(env, `series?id=eq.${seriesId}&select=cover_url`);
  if (!cur.length) { await bucket.delete(key); return; } // series deleted
  if (cur[0].cover_url === key) return;
  await db(env, `series?id=eq.${seriesId}`, { method: "PATCH", body: JSON.stringify({ cover_url: key }) });
  if (cur[0].cover_url) {
    // The previous cover belongs to the same series: resolve its bucket by that rating too.
    const oldBucket = (await resolveBucket(env, cur[0].cover_url, seriesId)) ?? bucketFor(env, cur[0].cover_url);
    await oldBucket.delete(cur[0].cover_url);
  }
}

async function processKey(env: Env, key: string) {
  const cover = COVER_KEY.exec(key);
  if (cover) return processCover(env, key, cover[1]);
  if (CHAPTER_KEY.test(key)) return processChapterAsset(env, key);
  console.warn(JSON.stringify({ evt: "unexpected_key", key })); // not an app-issued key; leave it for the orphan scanner
}

type Job = { id: number; object_key: string };

// Drains cleanup_jobs: deletes R2 objects whose database rows are gone. Deleting a missing object counts as success,
// a key that is referenced again is skipped, and failures are retried with exponential backoff (see cleanup_finish).
async function runCleanup(env: Env) {
  const jobs = await db<Job[]>(env, "rpc/cleanup_due", { method: "POST", body: JSON.stringify({ p_limit: 200 }) });
  for (const j of jobs) {
    try {
      const ref = await db<boolean>(env, "rpc/cleanup_is_referenced", { method: "POST", body: JSON.stringify({ k: j.object_key }) });
      if (!ref) {
        // The owning row is gone by design here, so resolve by the series id embedded in
        // the key (<seriesId>/... or restricted/<seriesId>/...); if the series is gone too,
        // fall back to the prefix rule — deleting from the wrong bucket is a no-op orphan,
        // never a privacy leak (cleanup only deletes, it never publishes).
        const seg = j.object_key.replace(/^restricted\//, "").split("/")[0];
        const bucket = (await resolveBucket(env, j.object_key, seg)) ?? bucketFor(env, j.object_key);
        await bucket.delete(j.object_key);
      }
      await db(env, "rpc/cleanup_finish", { method: "POST", body: JSON.stringify({ p_id: j.id }) });
    } catch (e) {
      console.error(JSON.stringify({ evt: "cleanup_failed", key: j.object_key, error: String(e) }));
      await db(env, "rpc/cleanup_finish", { method: "POST", body: JSON.stringify({ p_id: j.id, p_error: String(e).slice(0, 300) }) }).catch(() => {});
    }
  }
  await db(env, "rpc/cleanup_prune", { method: "POST", body: "{}" });
}

// Dry-run orphan scan (MED-002): lists R2 keys a page at a time, records unreferenced ones as candidates. Never deletes.
// A key must also be older than a day so an object whose database row is still being written is not flagged.
async function runOrphanScan(env: Env) {
  let cursor: string | undefined, seen = 0, pages = 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  do {
    const list = await env.MEDIA.list({ cursor, limit: 500 });
    const old = list.objects.filter((o) => o.uploaded.getTime() < cutoff);
    if (old.length) {
      const orphans = await db<string[]>(env, "rpc/orphan_filter", { method: "POST", body: JSON.stringify({ p_keys: old.map((o) => o.key) }) });
      const set = new Set(orphans);
      for (const o of old) if (set.has(o.key)) await db(env, "rpc/orphan_record", { method: "POST", body: JSON.stringify({ p_key: o.key, p_size: o.size, p_uploaded: o.uploaded.toISOString() }) });
      const referenced = old.filter((o) => !set.has(o.key)).map((o) => o.key);
      if (referenced.length) await db(env, "rpc/orphan_resolve", { method: "POST", body: JSON.stringify({ p_keys: referenced }) });
    }
    seen += list.objects.length;
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor && ++pages < 40); // bounded per run; the next daily run continues from the start, so very large buckets need a stored cursor
  console.log(JSON.stringify({ evt: "orphan_scan_done", seen, pages }));
}

export default {
  // Cron trigger (see wrangler.toml): publishes scheduled chapters that are due and prunes old notifications.
  async scheduled(event: ScheduledController, env: Env) {
    if (event.cron === "0 3 * * *") { await runOrphanScan(env); return; }
    const results = await Promise.allSettled([
      db(env, "rpc/run_scheduled_jobs", { method: "POST", body: "{}" }),
      runCleanup(env),
    ]);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason; // surfaces in Worker logs and cron failure metrics
  },
  async queue(batch: MessageBatch<Msg>, env: Env) {
    for (const m of batch.messages) {
      try {
        if (m.body.action === "PutObject" || m.body.action === "CompleteMultipartUpload") await processKey(env, m.body.object.key);
        m.ack();
      } catch (e) {
        // Retryable infrastructure errors back off; permanent errors are retried a few times then land in the dead-letter queue.
        console.error(JSON.stringify({ evt: "process_failed", key: m.body.object?.key, attempts: m.attempts, error: String(e) }));
        m.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(m.attempts, 6)) });
      }
    }
  },
};
