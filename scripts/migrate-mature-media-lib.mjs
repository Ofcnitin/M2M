// Pure planning logic for scripts/migrate-mature-media.mjs — dependency-free and
// side-effect-free so tests/migrate-mature-media.test.ts can import it directly.
// Importing this module never runs the migration.

export const RESTRICTED_PREFIX = "restricted/";

export const isRestrictedKey = (key) => typeof key === "string" && key.startsWith(RESTRICTED_PREFIX);

export const restrictedKeyFor = (key) => (isRestrictedKey(key) ? key : `${RESTRICTED_PREFIX}${key}`);

/** Classify one stored key/value for a MATURE series. */
export function classifyKey(key) {
  if (typeof key !== "string" || key.length === 0) return "missing";
  if (key.startsWith("http://") || key.startsWith("https://")) return "external";
  return isRestrictedKey(key) ? "restricted" : "public";
}

/**
 * Flatten DB rows into a uniform asset inventory for mature series only.
 * seriesRows: [{ id, content_rating, cover_url, banner_url }]
 * chapterRows: [{ id, series_id }]
 * assetRows:  [{ id, chapter_id, storage_key }]
 * Returns [{ assetKind: 'chapter_asset'|'cover'|'banner', assetId, seriesId, key }]
 * (for cover/banner, assetId is the series id — that is how the migration log records them).
 */
export function buildInventory(seriesRows, chapterRows, assetRows) {
  const mature = new Map((seriesRows ?? []).filter((s) => s.content_rating === "mature").map((s) => [s.id, s]));
  const out = [];
  for (const s of mature.values()) {
    if (s.cover_url != null) out.push({ assetKind: "cover", assetId: s.id, seriesId: s.id, key: s.cover_url });
    if (s.banner_url != null) out.push({ assetKind: "banner", assetId: s.id, seriesId: s.id, key: s.banner_url });
  }
  const chapterSeries = new Map((chapterRows ?? []).filter((c) => mature.has(c.series_id)).map((c) => [c.id, c.series_id]));
  for (const a of assetRows ?? []) {
    const seriesId = chapterSeries.get(a.chapter_id);
    if (seriesId) out.push({ assetKind: "chapter_asset", assetId: a.id, seriesId, key: a.storage_key });
  }
  return out;
}

/**
 * Plan for one inventory (mature assets only, from buildInventory).
 * Each item gets exactly one action:
 *   copy    — public key: copy public->private under restrictedKeyFor(key), verify, update DB, delete public
 *   skip    — already restricted
 *   missing — no key recorded (nothing to copy; needs manual follow-up)
 *   manual  — external http(s) URL (not a storage key; needs manual follow-up, never auto-copied)
 */
export function planMigration(inventory) {
  return (inventory ?? []).map((item) => {
    const cls = classifyKey(item.key);
    if (cls === "restricted") return { ...item, action: "skip", oldKey: item.key, newKey: item.key };
    if (cls === "missing") return { ...item, action: "missing", oldKey: item.key ?? null, newKey: null };
    if (cls === "external") return { ...item, action: "manual", oldKey: item.key, newKey: null };
    return { ...item, action: "copy", oldKey: item.key, newKey: restrictedKeyFor(item.key) };
  });
}

/**
 * Final report shape (also written to migrate-mature-media-report.json by the script).
 * outcomes: optional Map/object assetId -> 'migrated'|'failed'|'missing' from a real run;
 * without outcomes (dry-run) copy-plans count as planned-migrations and every public or
 * external reference counts as remaining.
 */
export function buildReport({ matureSeriesCount, inventory, plan, outcomes }) {
  const byId = outcomes instanceof Map ? outcomes : new Map(Object.entries(outcomes ?? {}));
  const hasOutcomes = byId.size > 0;
  let migrated = 0, failed = 0, missing = 0, remainingPublicReferences = 0;
  for (const p of plan ?? []) {
    const outcome = byId.get(`${p.assetKind}:${p.assetId}`) ?? byId.get(p.assetId);
    if (p.action === "missing" || outcome === "missing") missing += 1;
    if (outcome === "failed") failed += 1;
    if (hasOutcomes ? outcome === "migrated" : p.action === "copy") migrated += 1;
    if ((p.action === "copy" || p.action === "manual") && outcome !== "migrated") remainingPublicReferences += 1;
  }
  return {
    totalMatureSeries: matureSeriesCount ?? 0,
    totalMatureAssets: (inventory ?? []).length,
    migrated,
    failed,
    missing,
    remainingPublicReferences,
  };
}

/**
 * Rollback plan from mature_media_migration rows. Only rows whose public copy still
 * exists can be rolled back (status pending/copied/verified/db_updated): copy the object
 * back private->public and revert the DB key. Rows already 'deleted_public' are excluded
 * (the public copy is gone — restoring them is a separate, manual decision), as are
 * 'missing'/'failed'/'rolled_back' rows.
 */
export function planRollback(rows) {
  return (rows ?? [])
    .filter((r) => ["pending", "copied", "verified", "db_updated"].includes(r.status) && r.old_key && r.new_key && r.old_key !== r.new_key)
    .map((r) => ({
      migrationId: r.id ?? null,
      assetKind: r.asset_kind,
      assetId: r.asset_id,
      seriesId: r.series_id,
      fromKey: r.new_key,
      toKey: r.old_key,
      revertDb: r.status === "db_updated",
    }));
}
