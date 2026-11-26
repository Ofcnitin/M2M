# Security — v9 model

## Age gate & mature content (v9: self-declaration)

- v9 replaces the v8 third-party age-assurance **provider verification** model with **self-declaration**. See `docs/AGE_POLICY.md` for the full policy.
- Eligibility is decided **server-side only**, from: signed-in user + profile date of birth (age calculated server-side; 18+ for mature) + a recorded **policy acceptance** (policy version + timestamp) + not suspended.
- **DOB guard:** date of birth is collected at registration (under-13s are rejected in the database). Users cannot change their own DOB; DOB changes are **admin-only**, and an admin DOB change **resets the policy acceptance**, so mature access requires a fresh acceptance afterwards. DOB reads/writes are restricted by RLS and the profile guard in the database.
- **Acceptance records:** each acceptance stores the policy version and timestamp. An acceptance for a superseded policy version does not count.
- The legacy `m2m_adult` cookie is a UX hint only. It grants nothing; forging it has no effect. It is **not** an authorization signal.
- M2M stores no identity documents or biometric data for age purposes — there is no provider and no document check in v9.
- **Legal caveat:** whether self-declared age is sufficient for this service and content category is UNCONFIRMED pending qualified Indian legal review. Mature content must not be enabled publicly until that review is completed (`docs/AGE_POLICY.md`).

### Callback / provider attack surface — removed in v9

- The v8 provider flow is removed in this release (verified in-tree 2026-11-26 after the age workstream landed): `/api/age/verify/start` and `/api/age/verify/callback` (HMAC-signed provider callback) and the verification session/nonce machinery (`src/lib/age-session.ts`, plus its test) are **deleted**; the provider registry in `src/lib/age-assurance.ts` is removed and that file remains only as an unused, unimported future-extension seam (interface + comments, no runtime behaviour, no env config). There is therefore **no age-verification webhook/callback endpoint** to forge, replay, or misconfigure, and no `AGE_ASSURANCE_*` configuration (the vars are also removed from `.env.example`). Do not set `AGE_ASSURANCE_*` variables.
- Remaining callbacks in the codebase are unrelated to age: the Supabase Auth email-confirmation callback (`/auth/callback`) and ordinary React `useCallback` hooks. A repo grep for `webhook` after the v9 removal should return no application endpoint (only historical docs/migrations/tests may mention the old provider flow).
- Copyright claims carry an "electronic signature" form field (the claimant's typed full name, `src/app/copyright/page.tsx`); it is not a cryptographic signature and no webhook receives it.

## Private media by database rating (unchanged from v8)

- Whether an asset/cover is restricted is derived from the **database**: the series' `content_rating = 'mature'` OR a `restricted/` storage key.
- Public media: `/api/media/[assetId]` and `/api/cover/[seriesId]` 302 to the public CDN.
- Restricted media: eligibility is checked on every request; eligible users get a 302 to a ≤5-minute (≤300s, clamped in `src/lib/r2.ts`) signed R2 URL with `Cache-Control: private, no-store`. Ineligible users get 403.
- A mature asset whose key lacks the `restricted/` prefix is **rejected** (403) — never signed out of, or redirected to, the public bucket/CDN. Such rows are data bugs for `scripts/migrate-mature-media.mjs` to fix (see `docs/MEDIA_MIGRATION_REPORT.md`).
- `cdnUrl()` in `src/lib/cdn.ts` throws on restricted keys, so the `NEXT_PUBLIC_IMAGE_TRANSFORMS` (`cdn-cgi/image/...`) path can never produce a public transformed URL for restricted media.
- Restricted objects must live in a private bucket (`R2_PRIVATE_BUCKET`) or under a `restricted/` prefix that the public CDN domain does not serve. See `docs/MEDIA_MIGRATION.md` for moving pre-existing mature objects.

## Other controls

- **Auth:** upload, progress and tracking APIs require a Supabase session (401 otherwise); authorization for mutations is enforced by RPCs/RLS (ownership, contributor permissions) in the database, not by the client.
- **Service key:** `SUPABASE_SERVICE_KEY` is server-only, used only in server code (verified by grep in the v9 re-check: `src/lib/analytics.ts` — server-only module; the copyright **server action** in `src/app/copyright/page.tsx`). It is never prefixed `NEXT_PUBLIC_`, and no `"use client"` component references it. The public anon key is the only Supabase key exposed to the browser. (The age-callback/start routes that also used it in v8 are removed in v9.)
- **Open redirects:** `?next=` values pass through `safeNext()` in `src/lib/url.ts` (same-site relative paths only; `//` and `/\` rejected).
- **Security headers:** all routes get `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a conservative CSP (see `next.config.mjs`), and `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- **Rate limiting (baseline, limitation noted):** in-memory per-user limits on `/api/track` (default 60/min) and `/api/progress` (default 120/min), tunable via `RATE_LIMIT_TRACK_*` / `RATE_LIMIT_PROGRESS_*`. **In-memory state is per-instance**: limits reset on restart/redeploy and are not shared across instances, so a multi-instance production deployment can exceed the nominal limits and needs a shared store (Upstash/DB). This is a baseline, not a complete abuse-prevention claim. The copyright form keeps its existing per-email limit.
- **Analytics dedup:** `track_event` is service-role-only and deduplicates in the database (migration 0005); the browser can only request `chapter_complete` for a validated series/chapter pair.
- **Notifications:** rows are protected by RLS (`user_id = auth.uid()` for select/update/delete, migration 0004); inserts happen via database functions/outbox, not direct client writes.
- **XSS surface:** no `dangerouslySetInnerHTML` anywhere in `src/` (verified by grep in the v9 re-check, 2026-11-26).
- **SQL injection surface:** no raw SQL is executed from application code; data access goes through Supabase/PostgREST parameterised queries and RPCs. The v9 grep found no SQL string interpolation in `src/` (template strings found are URL paths and a fixed PostgREST select-column string in `src/app/discover/page.tsx`, not user-controlled SQL).
