# Pre-launch Checklist (authoritative, v9)

This is the **single authoritative** pre-launch checklist for v9. It supersedes the v8 checklist and any launch claims in older reports.

Status key: **OPEN** = blocks the scope noted · **DONE** = verified in repo · **PENDING** = awaiting final verification by the release owner.

## v9 age model — self-declaration (replaces provider verification)

- [x] **DONE (design/docs) — Self-declaration model documented** in `docs/AGE_POLICY.md` and `docs/SECURITY.md`: DOB collected at registration, age calculated server-side, policy acceptance recorded with version + timestamp, DOB changes admin-only and reset acceptance, DOB access restricted by RLS/guard, cookie is not an authorization signal.
- [ ] **PENDING — Self-declaration implementation verified end-to-end** by the release owner once the v9 age workstream and migrations 0023–0024 land: register (DOB required, under-13 rejected), acceptance recording, admin DOB change resetting acceptance, mature hidden for ineligible users, cookie forgery grants nothing.
- [x] **DONE — Provider machinery removed (verified in-tree 2026-11-26):** `/api/age/verify/*` and `src/lib/age-session.ts` deleted, provider registry removed (`src/lib/age-assurance.ts` remains only as an unused future-extension seam), `AGE_ASSURANCE_*` removed from `.env.example`, migrations `0023_age_self_declaration.sql` + `0024_content_ratings_preferences.sql` present. A `webhook` grep over `src/` returns no application endpoint (only a comment in the seam file noting the vars are gone).
- [ ] **OPEN (mature scope only) — Legal sufficiency UNCONFIRMED.** Whether self-declared age is sufficient for this service and content category is UNCONFIRMED pending qualified Indian legal review. **Mature content must not be enabled publicly until that review is completed.** Platform is launchable with mature content disabled. See the India checklist in `docs/AGE_POLICY.md` (DPDP Act 2023, IT Act/IT Rules 2021 + Grievance Officer, minors/age-restricted content, intermediary vs publisher).
- [ ] **OPEN — Expanded content warnings & preferences verified in the release build** (owned by the forms/listings workstreams): series forms carry the expanded warning set, reader/listing preferences behave as designed, and ratings are presented as M2M platform classifications — not official Indian statutory ratings.

## P0 — blockers (carried over / external)

- [x] **DONE (harness) — SQL test suites EXECUTED and PASSING (v8 baseline).** All 6 suites (0005, 0012, qa001, 0015, 0016, 0017) pass on a clean PostgreSQL 16 via `scripts/test-db-local.sh` (Supabase stub), 2026-11-26, after migrations 0001–0022. Execution exposed and fixed 4 real production bugs — see FINAL_REPORT_V8.md.
- [ ] **OPEN — Real-Supabase suite run still required.** Run `scripts/test-db.sh` against real Supabase with migrations `0001`–`0024` (including the v9 suites for 0023–0024) before launch; the local stub harness does not substitute.
- [ ] **OPEN — Production provisioning not done.** No production Supabase project, R2 buckets, or Worker deployment exists in evidence. Follow `docs/DEPLOYMENT_RUNBOOK.md` in order (Supabase + migrations 0001–0024, auth redirect URLs + email config, backups; R2 public + private buckets with the CDN domain NOT serving `restricted/`; Worker queues/DLQ, object-create notification, both crons).
- [ ] **OPEN — Private media bucket / CDN split not verified in production.** Restricted media requires `R2_PRIVATE_BUCKET` (or a `restricted/` prefix NOT served by the public CDN domain); otherwise direct object URLs are guessable in principle.
- [ ] **OPEN — Worker not deployed (in-repo evidence).** Queues `m2m-uploads` + `m2m-uploads-dlq`, `SUPABASE_SERVICE_KEY` secret, R2 object-create notification, both crons (`*/5 * * * *`, `0 3 * * *`). Without the 5-minute cron, scheduled chapters never go live.
- [ ] **OPEN — Mature-media migration not executed (mock only).** `node scripts/migrate-mature-media.mjs --mock` was run 2026-11-26 and plans correctly (see `docs/MEDIA_MIGRATION_REPORT.md`), but **no production R2 bucket/inventory exists yet**, so execution against production is BLOCKED. Deploy-time dry-run → `--execute` → verification must be completed and the report retained before mature is enabled.
- [ ] **OPEN — Legal review (general).** Privacy policy, terms, content policy, and copyright notice/deadline wording are drafts needing counsel review, in addition to the age-specific review above.
- [ ] **OPEN — Browser / Android E2E not run in this environment.** No end-to-end tests against Supabase, and no browser or Android-device verification was performed in the build environment. The go-live smoke checklist in `docs/DEPLOYMENT_RUNBOOK.md` §5 must be run on real browsers/devices before launch.

## P1 — should fix before launch

- [x] **DONE (v8 pipeline, re-verify for v9) — Lint / typecheck / production build** passed in the final v8 pipeline 2026-11-26; the release owner re-runs all three on the final v9 tree.
- [x] **DONE — Security headers** on all routes via `next.config.mjs` `headers()` (nosniff, Referrer-Policy, X-Frame-Options DENY, CSP, Permissions-Policy).
- [x] **DONE (baseline) — Rate limiting** on authenticated `/api/track` and `/api/progress` via in-memory `src/lib/rate-limit.ts`. **Limitation:** in-memory = per-instance; production multi-instance enforcement needs a shared store — see `docs/SECURITY.md`.
- [x] **DONE (v9 re-check, 2026-11-26) — Security greps:** no `dangerouslySetInnerHTML` in `src/`; `SUPABASE_SERVICE_KEY` only in server code, never `NEXT_PUBLIC_`, never in a client component; no raw SQL string interpolation in `src/`; media delivery verified rating-driven with signed TTL ≤ 300s (see `docs/MEDIA_MIGRATION_REPORT.md`).
- [ ] **OPEN — Backup/restore test.** Follow `docs/BACKUP_RECOVERY_RUNBOOK.md`: backups scheduled and at least one restore test recorded before launch.

## P2 — post-launch / improvements

- [ ] Tighten CSP from `'unsafe-inline'` to nonces/hashes.
- [ ] Move rate limiting to a shared store (Upstash/DB).
- [ ] Periodic R2 cleanup for files orphaned by chapter/series deletion (orphan scanner records candidates; admin review required).
- [ ] Notification fan-out via queue if a creator reaches hundreds of thousands of followers.
- [ ] Stored cursor for orphan scan on very large buckets (scan stops after 40 pages/run).
- [ ] Add a real `--help` to `scripts/migrate-mature-media.mjs` (currently `--help` falls through to a real run and exits 2 for missing env).
