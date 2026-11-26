-- 0024 — Content ratings, warnings & user discovery preferences (v9, workstream B).
--
-- (a) EXPANDED CONTENT WARNINGS: series_content_warnings_valid (0015) allowed only
--     violence / gore / nudity / strong_language / psychological / other. The platform
--     warning set is now ten values, adding graphic_violence, sexual_themes,
--     substance_use and disturbing_imagery. The old six values are a strict subset of
--     the new ten, so every existing series row already satisfies the new constraint —
--     NO data migration is needed; this only swaps the check constraint.
--
-- (b) USER DISCOVERY PREFERENCES on profiles:
--       show_mature_content boolean not null default false — an eligible (verified 18+)
--         user must ALSO opt in here before mature series appear in discovery/search
--         listings. Eligibility alone never puts mature series in listings, and this
--         preference alone never grants access (direct series/chapter pages still use
--         eligibility only — see src/lib/discovery.ts).
--       excluded_warnings text[] not null default '{}' — warnings the user wants hidden
--         from their discovery listings; constrained to the same ten-value set.
--
-- (c) PROFILES GUARD: no change needed. profiles_guard() (0015, re-issued in 0021)
--     works by pinning a FIXED list of protected columns (date_of_birth,
--     age_verification_status, age_verification_provider, age_verified_at,
--     age_verification_expires_at) and by raising only when role/suspended CHANGE.
--     It does not pin or revert any other column, so a user updating their OWN
--     show_mature_content / excluded_warnings passes through untouched. The existing
--     profiles_update_own RLS policy (0001: id = auth.uid(), role unchanged,
--     suspended = false) likewise permits these preference updates.
--
-- Ratings note: content_rating values remain everyone / teen / mature. They are M2M
-- platform classifications, NOT official Indian statutory ratings; this migration does
-- not change the rating enum.
--
-- Idempotent: safe to re-run.

-- ───────────────────────── (a) Expanded series content warnings ─────────────────────────
alter table series drop constraint if exists series_content_warnings_valid;
alter table series add constraint series_content_warnings_valid
  check (content_warnings <@ array[
    'violence','graphic_violence','gore','nudity','strong_language',
    'sexual_themes','psychological','substance_use','disturbing_imagery','other'
  ]::text[]);

-- ───────────────────────── (b) Profile discovery preferences ─────────────────────────
alter table profiles
  add column if not exists show_mature_content boolean not null default false,
  add column if not exists excluded_warnings text[] not null default '{}';

alter table profiles drop constraint if exists profiles_excluded_warnings_valid;
alter table profiles add constraint profiles_excluded_warnings_valid
  check (excluded_warnings <@ array[
    'violence','graphic_violence','gore','nudity','strong_language',
    'sexual_themes','psychological','substance_use','disturbing_imagery','other'
  ]::text[]);
