# Deployment Runbook — v9 (production provisioning, in order)

Do these steps **in order**. Mature content stays **disabled** until the legal
review (`docs/AGE_POLICY.md`) is complete **and** the media migration has been
executed (`docs/MEDIA_MIGRATION_REPORT.md`).

## 1. Supabase project

1. Create the production Supabase project; record the project URL and anon key.
2. Apply migrations `0001`–`0024` in numeric order (note: `0012` may need
   `alter type user_role add value 'moderator'` committed first if the SQL
   runner wraps the file in one transaction).
3. Run the SQL suites against the **real** Supabase project with
   `scripts/test-db.sh` (needs Docker / Supabase CLI) and record the result —
   the local stub-harness pass does not substitute for this.
4. Confirm RLS is enabled on all tables.
5. Auth configuration:
   - Set redirect URLs, including the site URL and `/auth/callback`.
   - Configure email confirmation (sender/SMTP, templates) and test a full
     register → confirm → sign-in round trip.
6. Enable scheduled backups (PITR if available) and verify a backup exists
   before go-live. See `docs/BACKUP_RECOVERY_RUNBOOK.md`.
7. Make the first admin: `update profiles set role = 'admin' where username = '<username>';`

## 2. Cloudflare R2 + CDN

1. Create the **public** bucket (`R2_BUCKET`, default `m2m-media`) and bind a
   public custom domain (CDN) to it for general/teen media.
2. Create the **private** bucket (`R2_PRIVATE_BUCKET`, Worker binding
   `MEDIA_PRIVATE`). It must **not** be bound to any public domain.
3. **The CDN domain must NOT serve the `restricted/` prefix.** If a single
   bucket is ever used, verify by requesting a `restricted/…` URL on the CDN
   domain and confirming it is not served; the two-bucket setup is preferred.
4. Configure bucket CORS: allow `PUT` from the site origin with the
   `Content-Type` header (uploads are signed server-side; credentials never
   reach the browser).
5. Optional: enable Cloudflare Image Transformations on the media domain,
   then set `NEXT_PUBLIC_IMAGE_TRANSFORMS=true`. Restricted keys can never use
   this path (`cdnUrl()` throws on them).

## 3. Worker (`workers/processor`)

1. Create the queues: `wrangler queues create m2m-uploads` and
   `wrangler queues create m2m-uploads-dlq` (dead-letter queue).
2. Set secrets/vars: `wrangler secret put SUPABASE_SERVICE_KEY`; set
   `SUPABASE_URL` in `wrangler.toml` `[vars]`.
3. Confirm bucket bindings: `MEDIA` (public) and `MEDIA_PRIVATE` (private) in
   `wrangler.toml`.
4. Add the R2 **object-create notification** to the uploads queue:
   `wrangler r2 bucket notification create m2m-media --event-type object-create --queue m2m-uploads`
   (and the equivalent for the private bucket if uploads land there directly).
5. Deploy: `wrangler deploy`.
6. Verify **both crons** are active:
   - `*/5 * * * *` — scheduled publishing (`run_scheduled_jobs()`), cleanup
     queue drain, notification outbox. **Without this cron, scheduled chapters
     never go live.**
   - `0 3 * * *` — orphan-object scan (dry run only; candidates are reviewed
     in `/admin`, never auto-deleted).

## 4. Environment variables

### Public (browser-exposed; safe to publish)

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Production project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key only — never the service key |
| `NEXT_PUBLIC_CDN_URL` | Public media domain; must not serve `restricted/` |
| `NEXT_PUBLIC_IMAGE_TRANSFORMS` | `true` only after step 2.5 |

### Server-only (never prefix with `NEXT_PUBLIC_`, never commit)

| Variable | Notes |
|---|---|
| `SUPABASE_SERVICE_KEY` | App server + Worker secret; bypasses RLS |
| `ANALYTICS_SALT` | Daily-rotating analytics hash salt |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3 credentials |
| `R2_BUCKET` | Public bucket (default `m2m-media`) |
| `R2_PRIVATE_BUCKET` | Private bucket for restricted media |
| `RATE_LIMIT_TRACK_LIMIT`, `RATE_LIMIT_TRACK_WINDOW_MS`, `RATE_LIMIT_PROGRESS_LIMIT`, `RATE_LIMIT_PROGRESS_WINDOW_MS` | Optional; in-memory, per-instance (see `docs/SECURITY.md`) |

### Removed in v9

`AGE_ASSURANCE_PROVIDER`, `AGE_ASSURANCE_PROVIDER_NAME`,
`AGE_ASSURANCE_API_KEY`, and `AGE_ASSURANCE_WEBHOOK_SECRET` are **removed in
v9** with the provider-verification machinery (self-declaration model,
`docs/AGE_POLICY.md`). Do not set them in production; remove them from any
environment copied from v8, and remove the corresponding block from
`.env.example` when the age workstream's cleanup lands.

## 5. App deploy + go-live smoke checklist

Deploy the Next.js build (`npm ci && npm run build`), set every variable
above, then verify:

- [ ] Register with DOB (under-13 rejected; under-18 account works for
  non-mature content), email confirmation round trip, sign in/out.
- [ ] Creator onboarding (terms version recorded), series create/edit with
  rating + warnings, cover upload.
- [ ] Chapter upload → Worker validation → publish; scheduled chapter goes
  live via the 5-minute cron.
- [ ] Reading on a phone-width viewport (vertical + page modes), progress sync.
- [ ] Library, follow, comments, ratings, notifications.
- [ ] Admin: report handling, content remove/restore, user suspend/restore,
  DOB change (confirm it resets the user's policy acceptance).
- [ ] Age gate: mature series hidden from listings/search for ineligible
  users; `/age` flow records acceptance (version + timestamp); cookie forgery
  (`m2m_adult=1`) grants nothing.
- [ ] Media: public asset loads via CDN; mature asset as ineligible user →
  403 from `/api/media/[assetId]` and `/api/cover/[seriesId]`; old public URL
  for restricted media is not served.
- [ ] Copyright form submits and appears in staff review.
- [ ] Security headers present on a page response (nosniff, DENY, CSP).

## 6. Mature-content enablement gate (separate, later decision)

Mature stays **disabled** until ALL of these are done:

- [ ] Qualified Indian legal review completed (`docs/AGE_POLICY.md` checklist).
- [ ] Media migration executed against production and verified
  (`docs/MEDIA_MIGRATION_REPORT.md` deploy-time commands; failed = 0,
  remaining public references = 0 or individually explained).
- [ ] Private bucket / CDN split verified in production (step 2.3).
