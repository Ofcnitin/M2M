# M2M

Independent comic publishing and reading platform. Next.js 14, Supabase, Cloudflare R2.

## Setup
1. `npm install`
2. Create a Supabase project and run every file in `supabase/migrations/` in numeric order (`0001` to `0024`). Run `0012` with `alter type user_role add value 'moderator'` committed first if your SQL runner wraps the file in one transaction.
3. Create an R2 bucket with a public custom domain (CDN) and a bucket CORS rule allowing PUT from your site origin.
4. Copy `.env.example` to `.env.local` and fill it in.
5. `npm run dev`
6. `npm test` runs the unit tests (tags, redirects, notification text, image header parsing, rate limiting, reader contract). `npm run typecheck` runs `tsc`. `npm run lint` runs ESLint (`next lint` with `.eslintrc.json` extending `next/core-web-vitals`; config in `.eslintrc.json`, ignores in `.eslintignore`).

## What is built
- Schema (`0001` onwards): tables, row-level security, `publish_chapter()` (blocks until every asset is ready), `become_creator()`, `reorder_chapter_assets()`, full-text search, ratings, notifications, scheduled jobs
- Auth: sign in, register (13+ confirmation, optional 18+), email confirmation callback, protected `/studio`, `/library`, `/notifications`, `/admin`
- Creator: onboarding, series create and full edit (format, rating, tags, genres, credits, schedule), delete series, cover upload, chapters, Chapter Builder (drag and drop upload, progress, retry, reorder, replace a single image, remove, preview, schedule, publish, unpublish, delete)
- Reader: home shelves (trending, top rated, recently updated, recently published), discover with search, genre/format/status/content-rating/tag filters and sorting (updated, published, popular, highest rated, A to Z), series page (cover, rating, genres, tags, credits, library, follow, share, report, chapter order toggle, continue reading), creator pages, vertical and page reader with progress sync, resume from last position, reading settings (width, background, spacing), previous/next chapter, report chapter
- Ratings: 1 to 5 stars, one per user, private individual scores, weighted "highest rated" rank so a single vote cannot top the list
- Tags: normalised on save (lowercase, max 10, max 30 chars), clickable everywhere, popular tags on Discover, `?tag=` filter
- Age policy (v9 self-declaration, `0015` + `0023`–`0024`): registration requires a date of birth and rejects under-13s in the database trigger. v9 replaces provider age verification with **self-declaration**: age is calculated server-side from the profile date of birth, and mature access also requires a recorded acceptance of the age/mature-content policy (policy version + timestamp). DOB changes are admin-only and reset the acceptance; DOB access is restricted by RLS/guard. The `m2m_adult` cookie is only a UX hint and is not an authorization signal. Mature series are hidden from listings/search for ineligible users. Mature chapter pages, covers and assets are served through gated endpoints (`/api/media/[assetId]`, `/api/cover/[seriesId]`) that 302 to <=5-minute signed R2 URLs; mature assets are stored under the `restricted/` key prefix. See `docs/AGE_POLICY.md` — whether self-declared age is legally sufficient in India is UNCONFIRMED pending qualified legal review, and mature must not be enabled publicly until that review is completed.
- Notifications: new chapter (followers and library readers), replies to your comment, comments on your series, new followers, moderation removal. Bell with unread count, `/notifications` page, 90 day retention
- Library with status tabs, sorting and continue reading
- Admin: review reports, remove or restore content (creators cannot undo a removal), suspend or restore users
- Comments with replies, sort order, likes, report; likes on series
- Creator analytics: views, signed-in readers, completion rate, followers, comments, daily chart, top chapters
- `workers/processor`: validates uploads (signature, dimensions, size), and a 5 minute cron that publishes due scheduled chapters

## Finish setup
1. Make yourself an admin: `update profiles set role = 'admin' where username = 'your_username';`
2. Deploy the Worker: create the queue, set `SUPABASE_SERVICE_KEY`, add the R2 object-create notification (see `wrangler.toml`). The Worker also carries the cron trigger that publishes scheduled chapters. Without it scheduled chapters never go live. If you prefer pg_cron, see the comment at the end of `0004`.
3. R2 bucket CORS: allow `PUT` from your site origin with the `Content-Type` header.
4. Optional: enable Cloudflare Image Transformations on the media domain, then set `NEXT_PUBLIC_IMAGE_TRANSFORMS=true` for responsive variants.

## Fixed while finishing
- Every page view used to move a series to the top of "Recently updated". Stats-only updates now leave `updated_at` alone.
- Adding images to a published chapter used to silently unpublish it. Only drafts move to "uploading" now.
- Uploading after removing an image could collide on `display_order`. New uploads continue after the highest order.
- Removing an image or replacing one now deletes the file from R2 too.
- Creators could edit their own `view_count` and republish content an admin had removed. Stats and moderation flags are now writable only by admins and the service role.
- `?next=` redirects accept same-site paths only.

## Known limits
- The v9 age gate is **self-declaration, not age verification**: eligibility rests on the DOB declared at registration plus a recorded policy acceptance. Whether self-declared age is sufficient for this service and content category in India is UNCONFIRMED pending qualified Indian legal review — mature content must not be enabled publicly until that review is completed (see `docs/AGE_POLICY.md`). The v8 provider machinery (`AGE_ASSURANCE_*`, verification sessions, provider callback) is removed in v9. Restricted media protection also requires the R2 setup in the deployment checklist (private bucket or a `restricted/` prefix that is NOT served by the public CDN domain); with a single public bucket/domain, direct object URLs would still be guessable in principle, though the app never publishes them.
- The SQL suites pass on a local PostgreSQL 16 stub harness (`scripts/test-db-local.sh`, v8: migrations 0001–0022, 6/6 suites), but a confirmation run on **real Supabase** (`scripts/test-db.sh`, needs Docker) with migrations `0001`–`0024` is still required before launch.
- Rate limiting is in-memory and per-instance (`src/lib/rate-limit.ts`): limits reset on restart and are not shared across instances; a multi-instance production deployment needs a shared store.
- No production Supabase project, R2 buckets, or Worker deployment exists yet, and the mature-media migration has only been mock-run (`docs/MEDIA_MIGRATION_REPORT.md`) — production execution is blocked until provisioning exists. No browser/Android end-to-end testing was run in the build environment.
- Deleting a chapter or series removes database rows but leaves its files in R2. A periodic cleanup job is the next step.
- Chapter notifications are written one row per recipient when a chapter goes live. Fine for thousands of followers; move to a queue if a single creator reaches hundreds of thousands.
- Replacing an image in a live chapter hides that page until it passes validation again.
- Tests cover the pure logic. There are no end-to-end tests against Supabase yet.

## Hardening log (blueprint work)
- `0005`: creators can no longer write chapter publication state or `chapter_assets`; publish/unpublish/asset RPCs; server-only deduplicated analytics.
- `0006`: covers and banners are set only by the media Worker after byte validation.
- `0007`: durable R2 cleanup queue (`cleanup_jobs`) drained by the Worker cron with retries and backoff.
- Worker: every Supabase response is checked, retryable and permanent failures are separated, large JPEG metadata is handled, retries back off, and a dead-letter queue is configured.
- Run `supabase/tests/0005_lockdown.sql` against a local or staging database after applying migrations. Required new env: `SUPABASE_SERVICE_KEY`, `ANALYTICS_SALT` (Next.js server); create the `m2m-uploads-dlq` queue for the Worker.
- `0008`: same-key upload re-signing (`/api/uploads/resign`), stale pending uploads failed after two hours, Chapter Builder uses bounded parallel uploads and warns before leaving mid-upload.
- `0009`: creator terms consent is recorded with a version (`become_creator(slug, terms_version)`); `admin_audit_log` is append-only and filled by triggers on admin moderation actions.
- `0010`: chapter notifications go through `notification_outbox` (one event per chapter, delivered in batches of 1000 with retries and backoff, suspended users and opted-out users skipped); `notification_preferences` with a settings form on `/notifications`; scheduled publishing uses `FOR UPDATE SKIP LOCKED`; the schedule field shows the browser time zone (all times are stored as UTC).
- Reader: progress is flushed on tab hide/close (keepalive `/api/progress`) and records a visible-asset cursor; completion is sticky; page mode has swipe, preloading, fullscreen and fit-width/fit-screen; strip images use `content-visibility`, descriptive alt text and exponential retry. `0011` adds catalog sort/filter indexes.
- `0012`: `moderator` role (works the report queue and copyright cases; cannot suspend users or change roles); `mod_set_content` requires a reason and logs to `admin_audit_log`; `copyright_cases` with public `/copyright` form (service-role RPC, per-email limit, honeypot), staff review/takedown/decision RPCs, creator response RPC (`copyright_respond`, UI at `/studio/copyright`) and column grants hiding claimant contact from creators. Tests: `supabase/tests/qa001_rls_matrix.sql`. Deadlines and notice wording need counsel review.
- `0013`: orphan-object scanner. A daily 03:00 UTC Worker cron lists R2 keys older than a day and records unreferenced ones in `orphan_candidates` (dry run, never deletes). Admins review them in `/admin` and queue deletion, which goes through the normal `cleanup_jobs` grace period and re-check; objects younger than 7 days cannot be approved. Very large buckets need a stored scan cursor (the scan stops after 40 pages per run).
- `0014`: contributor permissions (`contributor_permissions`; roles editor, uploader, analyst), separate from the public credit list. Owner invites by username (`/studio/series/[id]/team`); invitee accepts in `/studio`; either side can end access. Asset, publish and unpublish RPCs now check `can_edit_assets` / `can_upload_assets` / `can_publish_chapters` / `can_unpublish_chapters` on every call, so revoked, suspended or restricted accounts stop immediately. Series settings, chapter creation, deletion, covers and team stay owner-only. Known gaps: no invitation notification, and analysts have read access in RLS but no per-series dashboard yet (`creator_analytics` is owner-wide).
- QA-001: `supabase/tests/qa001_rls_matrix.sql` is a role-matrix test (guest, reader, owner, other creator, suspended, restricted, moderator, admin, editor, uploader, analyst, pending invitee) run through real role switches. `scripts/test-db.sh` applies all migrations to a local Supabase and runs both SQL suites; `.github/workflows/ci.yml` runs typecheck, unit tests and the database suites. The suites have not been executed yet; expect to fix fixture details on the first run.

## v7 changes (SEC-007 + reader + creator gaps)
- TypeScript: Supabase SSR cookie adapters are properly typed (`CookieOptions`); `npm run typecheck` passes. `package-lock.json` is committed and CI uses `npm ci`, runs typecheck + unit tests + a production build, and keeps the database job.
- Reader: vertical mode is full viewport width on mobile (`width:100%`, `height:auto`, aspect ratio preserved, zero gap by default, no horizontal padding); the narrow/medium/wide preference only caps width at the `sm` breakpoint and up. Page mode is unchanged.
- Creator: series forms require a content rating plus content warnings (violence, gore, nudity, strong language, psychological, other) and a content-policy confirmation (`policy_confirmed_at`). Contributor invitations now create a `contributor_invite` notification. Analysts/owners get a per-series dashboard at `/studio/series/[id]/analytics` backed by the `series_analytics()` RPC (gated by `can_view_analytics()`).
- Admin: rating override form (RPC `admin_set_series_rating`, audit-logged) and an admin age-verification record form (RPC `record_age_verification`). Draft `/privacy` and `/terms` pages exist and are marked as needing legal review.

## v8 changes (security + tooling + docs)
- Lint: ESLint 8 + `eslint-config-next` 14 are devDependencies; `npm run lint` runs non-interactively.
- Security headers on all routes (`next.config.mjs`): `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a conservative Content-Security-Policy, and `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- Rate limiting: dependency-free in-memory baseline (`src/lib/rate-limit.ts`) on the authenticated `/api/track` and `/api/progress` routes (per-user, env-tunable via `RATE_LIMIT_*`). Caveat: in-memory state is per-instance — a multi-instance production deployment needs a shared store (Upstash/DB); this is a baseline, not a complete abuse-prevention claim.
- Docs: see `docs/PRELAUNCH_CHECKLIST.md` (authoritative P0/P1/P2 launch checklist), `docs/SECURITY.md` (SEC-007 v8 model), and `docs/MEDIA_MIGRATION.md` (runbook for `scripts/migrate-mature-media.mjs`).

## v9 changes (self-declaration age model + docs)

- Age: provider verification (registry, sessions/nonces, HMAC callback, `AGE_ASSURANCE_*` env) is removed; eligibility is self-declaration — server-side age from the registered DOB plus a recorded policy acceptance (version + timestamp). DOB changes are admin-only and reset acceptance. See `docs/AGE_POLICY.md`. Mature stays disabled publicly until qualified Indian legal review confirms self-declaration is sufficient.
- Docs: `docs/DEPLOYMENT_RUNBOOK.md` (ordered production provisioning), `docs/BACKUP_RECOVERY_RUNBOOK.md` (backup/restore, R2 recovery, incident response, rollback), `docs/MEDIA_MIGRATION_REPORT.md` (mock run + production BLOCKED status), and `docs/PRELAUNCH_CHECKLIST.md` is the single authoritative v9 checklist.

## Production deployment checklist

The authoritative, ordered runbook is `docs/DEPLOYMENT_RUNBOOK.md`; summary:

1. Supabase: create the production project, apply migrations `0001`-`0024` in order, run `scripts/test-db.sh` on real Supabase, set Auth redirect URLs (including `/auth/callback`), configure email confirmation, confirm RLS is on, schedule backups, and keep `SUPABASE_SERVICE_KEY` server-only (never `NEXT_PUBLIC_`).
2. R2: create the public bucket + public custom domain for general/teen media. Create a PRIVATE bucket (`R2_PRIVATE_BUCKET`) for restricted media — the CDN domain must NOT serve the `restricted/` prefix. Configure bucket CORS for PUT from your site origin. Bind `MEDIA_PRIVATE` in the Worker.
3. Age (v9): there is no provider to configure and no `AGE_ASSURANCE_*` variables (removed in v9). Mature content stays disabled until the Indian legal review in `docs/AGE_POLICY.md` is completed and the media migration has been executed.
4. Worker: `wrangler queues create m2m-uploads` and `m2m-uploads-dlq`, set the `SUPABASE_SERVICE_KEY` secret, add the R2 object-create notification, deploy, and verify both crons: `*/5 * * * *` (scheduled publishing via `run_scheduled_jobs()` + cleanup) and `0 3 * * *` (orphan scan, dry run). Without the Worker cron, scheduled chapters never go live.
5. Orphan scanner: it only records candidates. An admin reviews them in `/admin` and queues deletion; deletion goes through `cleanup_jobs` with its grace period and referenced-key re-check, and objects younger than 7 days cannot be approved.
6. App: set every variable in `.env.example` (minus the removed `AGE_ASSURANCE_*` block), deploy the Next.js build, and smoke-test per `docs/DEPLOYMENT_RUNBOOK.md` §5: register (DOB required), creator onboarding, series + chapter upload/publish, reading on a phone-width viewport, admin report handling, and a mature series as an ineligible and an eligible (accepted, 18+ DOB) account.
7. Legal: have the privacy policy, terms, content policy and copyright notice/deadline wording reviewed before public launch. The in-repo pages are drafts.
