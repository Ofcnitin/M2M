# Media Migration Report — v9 Mock Run

Date of mock run: 2026-11-26 (this environment). Script: `scripts/migrate-mature-media.mjs`.
Runbook: `docs/MEDIA_MIGRATION.md`.

## Production status — BLOCKED

**No production R2 bucket / production inventory exists yet. No production
credentials are configured in this environment** (no `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY`, no `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY`, no production Supabase project). Execution against
production is therefore **BLOCKED** until production provisioning is complete
(see `docs/DEPLOYMENT_RUNBOOK.md`). Nothing in this report is a production
result.

The script has no `--help` flag: `node scripts/migrate-mature-media.mjs --help`
is treated as a real (non-mock) run and exits 2 with
`Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or use --mock fixtures.json). Nothing done.`
Usage was confirmed by reading the script header / `parseArgs` in
`scripts/migrate-mature-media.mjs`: `--mock <fixtures.json>`, `--dry-run`
(default), `--execute`, `--rollback [--execute]`.

## Mock run — verbatim output

Command (from repo root, after `npm ci`; fixture is the same shape as
`tests/migrate-mature-media.test.ts`: 1 mature series with 1 public-key asset,
1 already-restricted asset, 1 missing key, plus 1 non-mature series that must
be excluded):

```bash
node scripts/migrate-mature-media.mjs --mock /tmp/m2m-mock-fixtures.json
```

Verbatim stdout (exit code 0):

```json
{
  "mode": "mock-dry-run",
  "plan": [
    {
      "assetKind": "chapter_asset",
      "assetId": "a-public",
      "seriesId": "11111111-1111-1111-1111-111111111111",
      "key": "11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/page1.jpg",
      "action": "copy",
      "oldKey": "11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/page1.jpg",
      "newKey": "restricted/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/page1.jpg"
    },
    {
      "assetKind": "chapter_asset",
      "assetId": "a-restricted",
      "seriesId": "11111111-1111-1111-1111-111111111111",
      "key": "restricted/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/page2.jpg",
      "action": "skip",
      "oldKey": "restricted/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/page2.jpg",
      "newKey": "restricted/11111111-1111-1111-1111-111111111111/33333333-3333-3333-3333-333333333333/page2.jpg"
    },
    {
      "assetKind": "chapter_asset",
      "assetId": "a-missing",
      "seriesId": "11111111-1111-1111-1111-111111111111",
      "key": null,
      "action": "missing",
      "oldKey": null,
      "newKey": null
    }
  ],
  "report": {
    "totalMatureSeries": 1,
    "totalMatureAssets": 3,
    "migrated": 1,
    "failed": 0,
    "missing": 1,
    "remainingPublicReferences": 1
  }
}
```

The mock also wrote `migrate-mature-media-report.json` with the `report`
object above (deleted after capture so no mock artefact is mistaken for a
production report). Interpretation of the **mock only**: plan = 1 `copy`,
1 `skip` (already restricted), 1 `missing`; the non-mature series was correctly
excluded. These are fixture numbers, **not** production numbers.

## Required production report fields

| Field | Production value |
|---|---|
| Total mature series | Not measurable until production inventory exists |
| Total mature assets | Not measurable until production inventory exists |
| Migrated | Not measurable until production inventory exists |
| Failed | Not measurable until production inventory exists |
| Missing | Not measurable until production inventory exists |
| Remaining public references | Not measurable until production inventory exists |

No production numbers are invented here. They come from the real run's
`migrate-mature-media-report.json` (fields: `totalMatureSeries`,
`totalMatureAssets`, `migrated`, `failed`, `missing`,
`remainingPublicReferences`).

## Exact deploy-time commands

Run from the repo root, in the environment that holds the server-only
production credentials (`SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY`, `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
`R2_PRIVATE_BUCKET`). Take a DB backup / export of
`chapter_assets.storage_key` and `series.cover_url` / `banner_url` first.

```bash
# 1. Dry run (default — no writes). Review candidate count vs expectation.
node scripts/migrate-mature-media.mjs --dry-run

# 2. Execute (copy public -> private under restricted/, verify size/ETag,
#    update DB keys, only then delete the public copy; logged to
#    mature_media_migration, migration 0017).
node scripts/migrate-mature-media.mjs --execute

# 3. Verification
cat migrate-mature-media-report.json   # migrated + skipped + failed = dry-run candidates; failed must be 0
# Spot-checks (see docs/MEDIA_MIGRATION.md §3):
#  - mature asset via /api/media/[assetId] as ineligible user -> 403; as eligible adult -> 302 to <=5-min signed URL
#  - old public CDN URL for a migrated object -> 404 / not served
#  - public (non-mature) asset still redirects to the CDN unchanged

# Rollback if needed (dry-run first, then --execute):
node scripts/migrate-mature-media.mjs --rollback
node scripts/migrate-mature-media.mjs --rollback --execute
```

Retain the production run report (timestamp, mode, candidate / migrated /
skipped / failed counts with per-object errors, source→destination mapping)
with the release record.

## Code verification (read-only, 2026-11-26)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Delivery privacy decided by DB rating | PASS | `src/lib/media-keys.ts:47-60` `deliveryDecision({rating, storageKey})` — `rating === "mature"` is authoritative; called with `series.content_rating` at `src/app/api/media/[assetId]/route.ts:30` and `src/app/api/cover/[seriesId]/route.ts:25` |
| 2 | Restricted / mismatched keys rejected, no public fallback | PASS | `src/lib/media-keys.ts:52-55` mature + non-restricted key → `reject`; routes return 403 with no CDN redirect (`media route.ts:31-33`, `cover route.ts:26-28`). Non-mature `restricted/` key still gets signed-private, never CDN downgrade (`media-keys.ts:58`) |
| 3 | Signed URL TTL ≤ 300s | PASS | Both routes call `signDownloadForPrivacy(key, "private", 300)` (`media route.ts:43`, `cover route.ts:34`); `src/lib/r2.ts:34` `clampExpiry` caps at 300 and `r2.ts:52-53` applies it. (Upload URLs are 600s at `r2.ts:40` — that is an upload PUT, not a download; downloads are capped.) |
| 4 | `NEXT_PUBLIC_IMAGE_TRANSFORMS` path cannot transform restricted keys | PASS | `src/lib/cdn.ts:9-14` `cdnUrl()` throws on `isRestrictedKey(key)` before the `cdn-cgi/image/...` transform branch is reached; `mediaUrlForAsset` / `coverUrlForSeries` / `bannerUrlForSeries` (`cdn.ts:21-38`) route mature/restricted via the gated API, never `cdnUrl` |
| 5 | Worker bucket resolution by rating | PASS (with legacy fallback noted) | `workers/processor/src/index.ts:64-69` `resolveBucket()` fetches series rating (`ratingForSeries` L49-52 / `ratingForChapterAsset` L56-60): mature → private bucket, restricted key → private, known non-mature → `MEDIA`, unknown rating + ordinary key → `null` (skip + log, fail closed, L99/L120). Legacy prefix-only `bucketFor` (L11) remains only as a fallback for cleanup of rows already gone (L131, L158) — see coordinator note in the workstream report |
