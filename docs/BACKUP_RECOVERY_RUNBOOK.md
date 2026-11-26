# Backup & Recovery Runbook — v9

## 1. Database (Supabase / PostgreSQL)

### Backups

- Enable scheduled backups on the production Supabase project (daily at
  minimum; point-in-time recovery if the plan offers it) **before** go-live.
- Before any risky operation (migration batch, media migration `--execute`,
  bulk admin action), take an explicit export in addition to the schedule:
  - Schema + data dump: `pg_dump "$DATABASE_URL" > backup-$(date +%F-%H%M).sql`
    (connection string from the Supabase dashboard; store the dump outside the
    repo, access-controlled, never committed).
  - For the media migration specifically, also export the key columns:
    `chapter_assets.storage_key`, `series.cover_url`, `series.banner_url`.

### Restore procedure

1. Decide scope: full-project restore (Supabase dashboard restore / new
   project from backup) vs table-level restore from a `pg_dump`.
2. For a new-project restore: create the project, restore the dump, re-apply
   any migrations newer than the backup, then re-point the app's
   `NEXT_PUBLIC_SUPABASE_URL` / keys and the Worker's `SUPABASE_URL` /
   `SUPABASE_SERVICE_KEY` secret.
3. For a table-level restore: restore into a scratch database/schema first,
   diff against production, then copy only the intended rows in a transaction.
4. After any restore: re-check RLS is enabled, re-run the smoke checklist in
   `docs/DEPLOYMENT_RUNBOOK.md` §5, and confirm auth redirect URLs still match
   the (possibly new) project.

### Restore test (required, not optional)

- At least once before launch, and after any backup-configuration change:
  restore the latest backup into a **scratch** project, apply nothing else,
  sign in with a test account, and open a series + chapter. Record the date,
  backup used, and result here/in the release record. An untested backup is
  assumed not to work.

## 2. R2 object recovery

- R2 objects are not versioned by default in this setup: a deleted object is
  gone unless it exists in the other bucket or a local copy exists. Treat
  deletions as destructive.
- Safety nets already in the system:
  - Chapter/series deletion queues objects through `cleanup_jobs` with a
    grace period and a referenced-key re-check before deletion.
  - The orphan scanner (daily 03:00 UTC cron) only **records** candidates; it
    never deletes. Admin approval is required, and objects younger than 7 days
    cannot be approved.
  - The media migration copies → verifies (size/ETag) → updates DB → **only
    then** deletes the public copy, and logs every step to
    `mature_media_migration`.
- Recovery cases:
  - **Wrongly migrated object:** use the migration report's
    source→destination mapping; run
    `node scripts/migrate-mature-media.mjs --rollback` (dry run) then
    `--rollback --execute` for rows whose public copy still exists; for
    `deleted_public` rows, copy back manually from the private bucket and
    restore the original DB key from the pre-migration export.
  - **Wrongly deleted public object:** re-upload from the creator's original
    via the Chapter Builder / cover upload (the Worker re-validates it), or
    restore from the private-bucket copy if one exists.
  - **Bucket loss/corruption:** recreate buckets per
    `docs/DEPLOYMENT_RUNBOOK.md` §2, re-upload from creator originals; there
    is no cross-region replica unless one is configured separately — note this
    as an accepted risk or add replication before launch.

## 3. Incident response outline

1. **Detect & declare:** name one incident owner; note start time, symptoms,
   and affected scope (auth, reads, uploads, media delivery).
2. **Contain first:** examples — disable mature content (gate off), suspend
   compromised accounts, rotate a leaked secret (`SUPABASE_SERVICE_KEY`, R2
   keys) in Supabase/Cloudflare **and** in the app + Worker, take the Worker
   offline if it is damaging data.
3. **Preserve evidence:** export relevant logs (app, Worker, Supabase),
   `admin_audit_log`, and the current DB state before fixing forward.
4. **Eradicate & recover:** fix the cause; restore from backup only if data
   loss/corruption requires it (§1); re-run the smoke checklist.
5. **Notify:** users/regulators as required by law and policy — in India this
   includes DPDP Act breach notification obligations (confirm current
   requirements with counsel; see `docs/AGE_POLICY.md`). The Grievance Officer
   channel must be monitored during an incident affecting users.
6. **Post-incident:** short written review (timeline, root cause, fix,
   follow-ups) filed with the release record.

## 4. Rollback plan for a bad release

1. **App:** redeploy the previous known-good build (keep the previous build
   artefact / deployment immutable and addressable). App rollback is safe when
   the release changed no migrations.
2. **Migrations:** migrations are forward-only in this project. If a release
   with migrations 0023/0024 (or any new migration) misbehaves:
   - Prefer a **fix-forward** corrective migration over hand-editing the
     production database.
   - If the bad migration must be undone, restore the pre-release backup into
     a new project (§1) and re-point the app/Worker — accept the data written
     since the backup is lost, and say so explicitly in the incident record.
   - Never edit an already-applied migration file in place and re-run it.
3. **Worker:** `wrangler rollback` (or redeploy the previous Worker version);
   check the `m2m-uploads-dlq` for poison messages before resuming the queue
   consumer, and confirm both crons after rollback.
4. **Config:** revert env changes with the release (notably: do not re-add
   `AGE_ASSURANCE_*` variables — v9 removed them). Keep a copy of the
   pre-release env (names + which were set, not secret values in the repo).
5. **Verify after rollback:** full smoke checklist
   (`docs/DEPLOYMENT_RUNBOOK.md` §5) plus a check that scheduled publishing
   resumes (5-minute cron) and no chapter is stuck in `uploading`.
