#!/usr/bin/env node
// migrate-mature-media.mjs — move mature-series media out of the public bucket.
//
// WHY: before the v8 fix, bucket selection followed the `restricted/` key prefix, so a
// mature-series asset with an ordinary key lived in the PUBLIC bucket and was directly
// reachable via the public CDN. This script physically migrates those assets:
//   copy (public bucket -> private bucket, key rewritten to restricted/<old key>)
//   -> verify (HeadObject: ContentLength match, ETag compare when both sides report one)
//   -> update DB storage_key / cover_url / banner_url
//   -> ONLY THEN delete the public copy.
// Every step is logged to the mature_media_migration table (migration 0017).
//
// Usage:
//   node scripts/migrate-mature-media.mjs --mock fixtures.json [--dry-run]
//   node scripts/migrate-mature-media.mjs --dry-run            (default; needs env below)
//   node scripts/migrate-mature-media.mjs --execute            (actually copy/update/delete)
//   node scripts/migrate-mature-media.mjs --rollback [--execute]
// Env (real mode): SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
// (or SUPABASE_SERVICE_KEY), R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET (public, default m2m-media), R2_PRIVATE_BUCKET (private; falls back to R2_BUCKET).
//
// --mock reads a fixtures JSON: { series: [...], chapters: [...], chapterAssets: [...],
// migrationRows?: [...] } and only plans (no credentials, no network).
// The final report is printed and written to migrate-mature-media-report.json.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildInventory, planMigration, planRollback, buildReport } from "./migrate-mature-media-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry an async op up to 3 times with exponential backoff (250ms, 500ms, 1000ms). */
export async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      console.warn(`[retry] ${label} attempt ${attempt} failed: ${e?.message ?? e}`);
      if (attempt < 3) await sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

function parseArgs(argv) {
  const args = { dryRun: true, execute: false, rollback: false, mock: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--execute") { args.execute = true; args.dryRun = false; }
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--rollback") args.rollback = true;
    else if (argv[i] === "--mock") args.mock = argv[++i];
  }
  return args;
}

// ── Supabase REST (service role) ──────────────────────────────────────────────
function supabase(env) {
  const base = `${env.SUPABASE_URL}/rest/v1`;
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
  const call = async (path, init = {}) => {
    const res = await fetch(`${base}/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) throw new Error(`supabase ${init.method ?? "GET"} ${path.split("?")[0]} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    get: (path) => withRetry(() => call(path), `GET ${path.split("?")[0]}`),
    patch: (path, body) => withRetry(() => call(path, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) }), `PATCH ${path.split("?")[0]}`),
    post: (path, body) => withRetry(() => call(path, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) }), `POST ${path.split("?")[0]}`),
  };
}

async function fetchInventory(sb) {
  const series = await sb.get("series?content_rating=eq.mature&select=id,content_rating,cover_url,banner_url");
  const ids = series.map((s) => s.id);
  if (!ids.length) return { series, chapters: [], assets: [] };
  const chapters = await sb.get(`chapters?series_id=in.(${ids.join(",")})&select=id,series_id`);
  const chapterIds = chapters.map((c) => c.id);
  const assets = chapterIds.length
    ? await sb.get(`chapter_assets?chapter_id=in.(${chapterIds.join(",")})&select=id,chapter_id,storage_key`)
    : [];
  return { series, chapters, assets };
}

async function updateDbKey(sb, item, newKey) {
  if (item.assetKind === "chapter_asset") await sb.patch(`chapter_assets?id=eq.${item.assetId}`, { storage_key: newKey });
  else if (item.assetKind === "cover") await sb.patch(`series?id=eq.${item.seriesId}`, { cover_url: newKey });
  else await sb.patch(`series?id=eq.${item.seriesId}`, { banner_url: newKey });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mock) {
    const fixture = JSON.parse(await readFile(args.mock, "utf8"));
    if (args.rollback) {
      const plan = planRollback(fixture.migrationRows ?? []);
      console.log(JSON.stringify({ mode: "mock-rollback", plan }, null, 2));
      return;
    }
    const inventory = buildInventory(fixture.series ?? [], fixture.chapters ?? [], fixture.chapterAssets ?? []);
    const plan = planMigration(inventory);
    const report = buildReport({ matureSeriesCount: (fixture.series ?? []).filter((s) => s.content_rating === "mature").length, inventory, plan });
    console.log(JSON.stringify({ mode: "mock-dry-run", plan, report }, null, 2));
    await writeFile("migrate-mature-media-report.json", JSON.stringify(report, null, 2));
    return;
  }

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY,
  };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or use --mock fixtures.json). Nothing done.");
    process.exitCode = 2;
    return;
  }
  const sb = supabase(env);

  if (args.rollback) {
    const rows = await sb.get("mature_media_migration?status=in.(pending,copied,verified,db_updated)&select=*");
    const plan = planRollback(rows);
    console.log(JSON.stringify({ mode: args.execute ? "rollback" : "rollback-dry-run", plan }, null, 2));
    if (!args.execute) return;
    const { S3Client, CopyObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = makeS3Impl();
    const pub = publicBucketName(), priv = privateBucketName();
    for (const step of plan) {
      await withRetry(() => s3.send(new CopyObjectCommand({ Bucket: pub, CopySource: `${priv}/${encodeURIComponent(step.fromKey)}`, Key: step.toKey })), `rollback copy ${step.fromKey}`);
      await withRetry(() => s3.send(new HeadObjectCommand({ Bucket: pub, Key: step.toKey })), `rollback verify ${step.toKey}`);
      if (step.revertDb) await updateDbKey(sb, { assetKind: step.assetKind, assetId: step.assetId, seriesId: step.seriesId }, step.toKey);
      if (step.migrationId) await sb.patch(`mature_media_migration?id=eq.${step.migrationId}`, { status: "rolled_back", updated_at: new Date().toISOString() });
      console.log(`[rollback] ${step.assetKind} ${step.assetId}: ${step.fromKey} -> ${step.toKey}`);
    }
    return;
  }

  const { series, chapters, assets } = await fetchInventory(sb);
  const inventory = buildInventory(series, chapters, assets);
  const plan = planMigration(inventory);
  const outcomes = new Map();
  console.log(`Mature series: ${series.length}; mature assets: ${inventory.length}; mode: ${args.execute ? "EXECUTE" : "dry-run"}`);

  if (args.execute) {
    const { S3Client, CopyObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = makeS3Impl();
    const pub = publicBucketName(), priv = privateBucketName();
    const head = (Bucket, Key) => withRetry(() => s3.send(new HeadObjectCommand({ Bucket, Key })), `head ${Key}`);
    for (const item of plan) {
      const outKey = `${item.assetKind}:${item.assetId}`;
      if (item.action === "skip") continue;
      if (item.action === "missing") { outcomes.set(outKey, "missing"); continue; }
      if (item.action === "manual") { outcomes.set(outKey, "failed"); console.warn(`[manual] external URL needs manual handling: ${item.oldKey}`); continue; }
      let logRow = null;
      try {
        [logRow] = await sb.post("mature_media_migration", { asset_kind: item.assetKind, asset_id: item.assetId, series_id: item.seriesId, old_key: item.oldKey, new_key: item.newKey, status: "pending" });
        let src;
        try { src = await head(pub, item.oldKey); }
        catch { outcomes.set(outKey, "missing"); if (logRow) await sb.patch(`mature_media_migration?id=eq.${logRow.id}`, { status: "missing", detail: "source object not found in public bucket", updated_at: new Date().toISOString() }); continue; }
        // CopyObject first; fall back to Get+Put if the copy is refused (cross-account etc.).
        try {
          await withRetry(() => s3.send(new CopyObjectCommand({ Bucket: priv, CopySource: `${pub}/${encodeURIComponent(item.oldKey)}`, Key: item.newKey })), `copy ${item.oldKey}`);
        } catch {
          const obj = await withRetry(() => s3.send(new GetObjectCommand({ Bucket: pub, Key: item.oldKey })), `get ${item.oldKey}`);
          const body = Buffer.from(await obj.Body.transformToByteArray());
          await withRetry(() => s3.send(new PutObjectCommand({ Bucket: priv, Key: item.newKey, Body: body, ContentType: obj.ContentType })), `put ${item.newKey}`);
        }
        if (logRow) await sb.patch(`mature_media_migration?id=eq.${logRow.id}`, { status: "copied", updated_at: new Date().toISOString() });
        const dst = await head(priv, item.newKey);
        const sizeOk = dst.ContentLength === src.ContentLength;
        const etagOk = !src.ETag || !dst.ETag || src.ETag === dst.ETag;
        if (!sizeOk || !etagOk) throw new Error(`verify failed for ${item.newKey}: size ${src.ContentLength}->${dst.ContentLength}, etag ${src.ETag}->${dst.ETag}`);
        if (logRow) await sb.patch(`mature_media_migration?id=eq.${logRow.id}`, { status: "verified", updated_at: new Date().toISOString() });
        await updateDbKey(sb, item, item.newKey);
        if (logRow) await sb.patch(`mature_media_migration?id=eq.${logRow.id}`, { status: "db_updated", updated_at: new Date().toISOString() });
        // Public copy is deleted ONLY after the copy is verified AND the DB points at the new key.
        await withRetry(() => s3.send(new DeleteObjectCommand({ Bucket: pub, Key: item.oldKey })), `delete public ${item.oldKey}`);
        if (logRow) await sb.patch(`mature_media_migration?id=eq.${logRow.id}`, { status: "deleted_public", updated_at: new Date().toISOString() });
        outcomes.set(outKey, "migrated");
        console.log(`[migrated] ${item.assetKind} ${item.assetId}: ${item.oldKey} -> ${item.newKey}`);
      } catch (e) {
        outcomes.set(outKey, "failed");
        console.error(`[failed] ${item.assetKind} ${item.assetId}: ${e?.message ?? e}`);
        if (logRow) await sb.patch(`mature_media_migration?id=eq.${logRow.id}`, { status: "failed", detail: String(e?.message ?? e).slice(0, 500), updated_at: new Date().toISOString() }).catch(() => {});
      }
    }
  }

  const report = buildReport({ matureSeriesCount: series.length, inventory, plan, outcomes: args.execute ? outcomes : undefined });
  console.log(JSON.stringify(report, null, 2));
  await writeFile("migrate-mature-media-report.json", JSON.stringify(report, null, 2));
}

function publicBucketName() { return process.env.R2_BUCKET ?? "m2m-media"; }
function privateBucketName() { return process.env.R2_PRIVATE_BUCKET || publicBucketName(); }

// S3 client factory (only constructed in --execute paths, so --mock/--dry-run never need R2 credentials).
import { S3Client } from "@aws-sdk/client-s3";
function makeS3Impl() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
