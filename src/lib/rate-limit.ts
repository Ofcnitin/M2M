// Dependency-free in-memory rate limiting (baseline only).
//
// LIMITATION: state lives in this process's memory. In a multi-instance /
// serverless production deployment each instance has its own buckets, so the
// effective limit is (limit x instance count) and buckets reset on restart.
// For real production enforcement use a shared store (e.g. Upstash Redis or a
// database table) behind this same interface. Do not treat this helper alone
// as a complete abuse-prevention claim.
//
// Algorithm: fixed sliding-window approximation via per-key timestamp log.
// Entries older than windowMs are pruned on every call.

type Bucket = { hits: number[] };
const buckets = new Map<string, Bucket>();

export type RateLimitOptions = { limit: number; windowMs: number };
export type RateLimitResult = { ok: boolean; retryAfterSeconds: number };

export function rateLimit(key: string, opts: RateLimitOptions, now: number = Date.now()): RateLimitResult {
  const limit = Math.max(1, Math.floor(opts.limit));
  const windowMs = Math.max(1, Math.floor(opts.windowMs));
  const cutoff = now - windowMs;
  let bucket = buckets.get(key);
  if (!bucket) { bucket = { hits: [] }; buckets.set(key, bucket); }
  bucket.hits = bucket.hits.filter((t) => t > cutoff);
  if (bucket.hits.length >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.hits[0] + windowMs - now) / 1000));
    return { ok: false, retryAfterSeconds };
  }
  bucket.hits.push(now);
  return { ok: true, retryAfterSeconds: 0 };
}

/** Test / maintenance helper: clears all buckets. */
export function resetRateLimits(): void { buckets.clear(); }

/** Best-effort client key from proxy headers (first x-forwarded-for hop). */
export function clientKey(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Env-tunable limit helper: RATE_LIMIT_<NAME>_LIMIT / _WINDOW_MS, with defaults. */
export function rateLimitFromEnv(name: string, fallback: RateLimitOptions): RateLimitOptions {
  const limit = Number(process.env[`RATE_LIMIT_${name}_LIMIT`]);
  const windowMs = Number(process.env[`RATE_LIMIT_${name}_WINDOW_MS`]);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : fallback.limit,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : fallback.windowMs,
  };
}
