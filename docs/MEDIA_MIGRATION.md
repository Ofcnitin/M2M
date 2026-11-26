# Media Migration Runbook — `scripts/migrate-mature-media.mjs`

Purpose: move mature (restricted) media objects that were stored in the public
bucket / public key space into the private bucket (or the `restricted/` prefix
that is not served by the public CDN), so gated delivery (`/api/media/[assetId]`,
`/api/cover/[seriesId]`) is the only path to them. The script name and path are
fixed: `scripts/migrate-mature-media.mjs`.

> Verify the script's actual flags (`--help` / source) before running — this
> runbook describes the required operating procedure around it, not a guarantee
> of its internal implementation.

## Preconditions

- Migrations applied; you know which series/assets are rated `mature`.
- `R2_PRIVATE_BUCKET` configured (or the `restricted/` prefix confirmed NOT reachable via the public CDN domain).
- Server-only R2 credentials available to the script's environment; never commit them.
- A recent database backup / export of `chapter_assets.storage_key` and `series.cover_url` values.

## 1. Dry run (default, no writes)

```bash
node scripts/migrate-mature-media.mjs --dry-run
```

Review the report: candidate objects, source key, destination key, and any
skips/errors. Confirm the candidate count matches the expected number of mature
assets/covers. Do not proceed on unexplained mismatches.

## 2. Execute

```bash
node scripts/migrate-mature-media.mjs --execute
```

The script copies each object to its restricted destination and updates the
stored key/reference where required. Run it once; re-runs should be idempotent
(already-migrated objects reported as skipped — verify this in the report).

## 3. Verify

- Report totals: migrated + skipped + failed = candidates from the dry run; failed must be 0 (investigate and re-run otherwise).
- Spot-check: a mature asset via `/api/media/[assetId]` as an ineligible user returns 403; as an eligible verified adult it 302s to a short-lived signed URL.
- Spot-check: the old public CDN URL for a migrated object returns 404 / is not served.
- Spot-check: a public (non-mature) asset still redirects to the CDN unchanged.

## 4. Rollback

- Before deleting any source objects, rollback is: point the stored keys back to the original values (from the pre-migration backup/report mapping) — destinations are copies.
- If source objects were already deleted, restore them by copying back from the private destination using the report's source→destination mapping, then restore the original stored keys.
- Re-run the verification spot-checks for public access after any rollback.

## Report fields to retain

Keep the run report with the release record. It should include, per run:
timestamp, mode (dry-run/execute), candidate count, migrated count, skipped
count, failed count with per-object errors, and the source→destination key
mapping for every migrated object (needed for rollback).
