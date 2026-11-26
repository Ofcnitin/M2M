-- 0017: Mature-media privacy migration bookkeeping + publish-time guard (v8 fix).
--
-- Bug: /api/media and /api/cover gated on series.content_rating, but bucket selection in
-- the app (and the public CDN) was decided by the `restricted/` storage-key prefix alone.
-- A mature-series asset with an ordinary key therefore lived in / was served from the
-- PUBLIC bucket and stayed directly reachable via the public CDN.
--
-- Fix strategy: privacy is decided by the DB rating end-to-end in the app/worker, and
-- existing mis-keyed mature assets are physically migrated (public bucket -> private
-- bucket, key rewritten to restricted/<old key>) by scripts/migrate-mature-media.mjs.
-- This migration adds:
--   1. mature_media_migration — the migration log the script writes (service-role only).
--   2. assert_series_media_private(p_series_id) — returns every asset of a MATURE series
--      whose storage key is missing or not restricted/ (chapter assets, cover, banner).
--      Used by the migration runbook, the SQL tests, and publish-time checks: a chapter
--      of a mature series must not be published while this returns rows.
-- Safe/reproducible: additive only, no existing rows are changed by this migration.

create table if not exists mature_media_migration (
  id uuid primary key default gen_random_uuid(),
  asset_kind text not null check (asset_kind in ('chapter_asset','cover','banner')),
  asset_id uuid,
  series_id uuid not null references series on delete cascade,
  old_key text,
  new_key text,
  status text not null default 'pending'
    check (status in ('pending','copied','verified','db_updated','deleted_public','failed','missing','rolled_back')),
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mmm_series_idx on mature_media_migration (series_id, status);
create index if not exists mmm_asset_idx on mature_media_migration (asset_id);

-- Service-role only: the migration script runs with the service key; no app user should
-- read or write the log (it contains storage keys for mature media).
alter table mature_media_migration enable row level security;
revoke all on mature_media_migration from anon, authenticated;
grant all on mature_media_migration to service_role;

-- ───────────────────── Publish-time / audit guard ─────────────────────
-- Returns one row per violating asset for a mature series: chapter assets whose
-- storage_key is null/empty/not restricted/, plus the series cover and banner under the
-- same rule (http(s) cover/banner URLs on a mature series also violate: they are not
-- storage keys at all and would be publicly reachable). Non-mature series return no rows.
create or replace function assert_series_media_private(p_series_id uuid)
returns table (asset_kind text, asset_id uuid, storage_key text)
language sql stable security definer set search_path = public as $$
  select 'chapter_asset'::text, a.id, a.storage_key
  from series s
  join chapters c on c.series_id = s.id
  join chapter_assets a on a.chapter_id = c.id
  where s.id = p_series_id and s.content_rating = 'mature'
    and (a.storage_key is null or a.storage_key = '' or a.storage_key not like 'restricted/%')
  union all
  select 'cover'::text, s.id, s.cover_url
  from series s
  where s.id = p_series_id and s.content_rating = 'mature'
    and s.cover_url is not null
    and (s.cover_url like 'http%' or s.cover_url not like 'restricted/%')
  union all
  select 'banner'::text, s.id, s.banner_url
  from series s
  where s.id = p_series_id and s.content_rating = 'mature'
    and s.banner_url is not null
    and (s.banner_url like 'http%' or s.banner_url not like 'restricted/%')
$$;
revoke execute on function assert_series_media_private(uuid) from public, anon;
grant execute on function assert_series_media_private(uuid) to authenticated, service_role;
-- Callers inside the app must additionally check staff/ownership as appropriate for
-- their route; the function only reports, it never blocks by itself. Publish flow
-- (ChapterBuilder -> publish_chapter) should be preceded by an app-side check that
-- assert_series_media_private(series_id) is empty for mature series.
