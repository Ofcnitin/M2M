-- 0015: SEC-007 — mature-content access & age policy.
-- Adds server-side date of birth, age-verification state, content warnings, rating-change
-- tracking, moderation status, an age-verification record table, contributor-invite
-- notifications, an admin rating-override RPC, and a per-series analytics RPC.
-- Safe/reproducible: additive columns with defaults, no destructive changes, existing rows
-- keep working (profiles without a DOB simply cannot access mature content — fail closed).
-- NOTE: metadata trust — handle_new_user() only copies a *parseable* DOB from signup
-- metadata and derives age from it; it never trusts an "adult_confirmed=true" flag to
-- grant mature access. Mature access additionally needs age_verification_status='verified'
-- (set only by an admin/provider flow) — see is_mature_eligible() and src/lib/age-core.ts.

-- ───────────────────────── Profiles: DOB + verification ─────────────────────────
alter table profiles
  add column if not exists date_of_birth date,
  add column if not exists age_verification_status text not null default 'unverified'
    check (age_verification_status in ('unverified','pending','verified','failed','expired','revoked')),
  add column if not exists age_verification_provider text,
  add column if not exists age_verified_at timestamptz,
  add column if not exists age_verification_expires_at timestamptz;

-- A DOB, when present, must be in the past and plausible. (Under-13 rejection happens in
-- handle_new_user() and in the app registration path so the error reaches the user.)
alter table profiles drop constraint if exists profiles_dob_plausible;
alter table profiles add constraint profiles_dob_plausible
  check (date_of_birth is null or (date_of_birth <= current_date and date_of_birth > current_date - interval '120 years'));

-- Users must never be able to write their own verification state or DOB after signup via
-- the generic profile update policy: profiles_guard strips those columns for non-admins.
create or replace function profiles_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and not coalesce(is_admin(), false) then
    new.date_of_birth := old.date_of_birth;
    new.age_verification_status := old.age_verification_status;
    new.age_verification_provider := old.age_verification_provider;
    new.age_verified_at := old.age_verified_at;
    new.age_verification_expires_at := old.age_verification_expires_at;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on profiles;
create trigger profiles_guard before update on profiles for each row execute function profiles_guard();

-- ───────────────────────── Age verification records ─────────────────────────
create table if not exists age_verification_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  status text not null check (status in ('pending','verified','failed','expired','revoked')),
  jurisdiction text,
  provider text not null,
  provider_reference text,
  verified_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists avr_user_idx on age_verification_records (user_id, created_at desc);
alter table age_verification_records enable row level security;
drop policy if exists avr_own_read on age_verification_records;
create policy avr_own_read on age_verification_records for select using (user_id = auth.uid() or is_admin());
revoke all on age_verification_records from anon, authenticated;
grant select on age_verification_records to authenticated;
-- Writes happen only through record_age_verification() (admin / service role).

create or replace function record_age_verification(
  p_user uuid, p_status text, p_provider text, p_reference text default null,
  p_jurisdiction text default null, p_expires_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if not (coalesce(is_admin(), false) or auth.role() = 'service_role') then
    raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('pending','verified','failed','expired','revoked') then raise exception 'invalid status'; end if;
  insert into age_verification_records (user_id, status, provider, provider_reference, jurisdiction, verified_at, expires_at)
  values (p_user, p_status, p_provider, p_reference, p_jurisdiction,
          case when p_status = 'verified' then now() end, p_expires_at)
  returning id into rid;
  update profiles set
    age_verification_status = p_status,
    age_verification_provider = p_provider,
    age_verified_at = case when p_status = 'verified' then now() else age_verified_at end,
    age_verification_expires_at = p_expires_at
  where id = p_user;
  begin
    perform _audit('age_verification_' || p_status, 'user', p_user::text,
      jsonb_build_object('provider', p_provider, 'record', rid));
  exception when others then null; -- audit actor is auth.uid(); service-role calls have none
  end;
  return rid;
end $$;
revoke execute on function record_age_verification(uuid, text, text, text, text, timestamptz) from public, anon;
grant execute on function record_age_verification(uuid, text, text, text, text, timestamptz) to authenticated, service_role;

-- DB-level eligibility mirror of src/lib/age-core.ts (provider configuration is an app-env
-- concern and is enforced additionally in the app/media layer).
create or replace function is_mature_eligible(uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    where p.id = uid and not p.suspended
      and p.date_of_birth is not null
      and p.date_of_birth <= current_date - interval '18 years'
      and p.age_verification_status = 'verified'
      and (p.age_verification_expires_at is null or p.age_verification_expires_at > now())
  ) $$;
revoke execute on function is_mature_eligible(uuid) from public, anon;
grant execute on function is_mature_eligible(uuid) to authenticated, service_role;

-- ───────────────────────── Signup: DOB in, under-13 rejected ─────────────────────────
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare dob date;
begin
  begin
    dob := nullif(new.raw_user_meta_data->>'date_of_birth', '')::date;
  exception when others then
    raise exception 'invalid date_of_birth';
  end;
  if dob is not null then
    if dob > current_date - interval '13 years' then raise exception 'users must be 13 or older'; end if;
    if dob <= current_date - interval '120 years' then raise exception 'invalid date_of_birth'; end if;
  end if;
  insert into profiles (id, username, display_name, age_confirmed_at, adult_confirmed_at, date_of_birth)
  values (new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(replace(new.id::text,'-',''),1,10)),
    coalesce(new.raw_user_meta_data->>'display_name', 'New reader'),
    case when dob is not null or new.raw_user_meta_data->>'age_confirmed' = 'true' then now() end,
    -- adult_confirmed_at is kept only as a legacy informational timestamp. It grants NOTHING:
    -- mature access requires DOB >= 18 AND verified status (is_mature_eligible).
    case when new.raw_user_meta_data->>'adult_confirmed' = 'true' then now() end,
    dob);
  return new;
end $$;

-- ───────────────────────── Series: warnings, rating history, moderation ─────────────────────────
alter table series
  add column if not exists content_warnings text[] not null default '{}',
  add column if not exists rating_changed_at timestamptz,
  add column if not exists moderation_status text not null default 'clear'
    check (moderation_status in ('clear','flagged','restricted','removed')),
  add column if not exists policy_confirmed_at timestamptz;

alter table series drop constraint if exists series_content_warnings_valid;
alter table series add constraint series_content_warnings_valid
  check (content_warnings <@ array['violence','gore','nudity','strong_language','psychological','other']::text[]);

-- Keep moderation_status in step with the existing removed_by_moderation flag, and stamp
-- rating changes. Runs alongside (not instead of) the existing series guards.
create or replace function series_sec007_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.content_rating is distinct from old.content_rating then new.rating_changed_at := now(); end if;
    if new.removed_by_moderation and not old.removed_by_moderation then new.moderation_status := 'removed';
    elsif not new.removed_by_moderation and old.removed_by_moderation then new.moderation_status := 'clear'; end if;
  end if;
  return new;
end $$;
drop trigger if exists series_sec007_guard on series;
create trigger series_sec007_guard before insert or update on series for each row execute function series_sec007_guard();

-- Admin/staff rating override with a mandatory reason, written to the audit log.
create or replace function admin_set_series_rating(p_series uuid, p_rating content_rating, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(is_staff(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required'; end if;
  update series set content_rating = p_rating, rating_changed_at = now() where id = p_series;
  if not found then raise exception 'series not found'; end if;
  perform _audit('series_rating_changed', 'series', p_series::text,
    jsonb_build_object('rating', p_rating::text, 'reason', left(p_reason, 500)));
end $$;
revoke execute on function admin_set_series_rating(uuid, content_rating, text) from public, anon;
grant execute on function admin_set_series_rating(uuid, content_rating, text) to authenticated;

-- ───────────────────────── Contributor invitation notifications ─────────────────────────
-- notifications.type and notification_preferences.type gain 'contributor_invite'.
alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('new_chapter','comment_reply','series_comment','new_follower','content_removed','contributor_invite'));
alter table notification_preferences drop constraint if exists notification_preferences_type_check;
alter table notification_preferences add constraint notification_preferences_type_check
  check (type in ('new_chapter','comment_reply','series_comment','new_follower','contributor_invite'));

-- invite_contributor(): same permission checks as 0014, plus a notification for the invitee.
create or replace function invite_contributor(p_series uuid, p_username text, p_role text) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid; pid uuid;
begin
  if not owns_series(p_series) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_role not in ('editor','uploader','analyst') then raise exception 'invalid role'; end if;
  select id into uid from profiles where username = lower(trim(p_username)) and not suspended;
  if uid is null then raise exception 'user not found'; end if;
  if uid = auth.uid() then raise exception 'you already own this series'; end if;
  if (select count(*) from contributor_permissions where series_id = p_series and status in ('invited','active')) >= 20 then
    raise exception 'too many contributors'; end if;
  insert into contributor_permissions (series_id, user_id, role, invited_by) values (p_series, uid, p_role, auth.uid()) returning id into pid;
  -- Notification (honours the invitee's preferences; a failure here must never lose the invite).
  begin
    if notif_enabled(uid, 'contributor_invite') then
      insert into notifications (user_id, type, actor_id, series_id) values (uid, 'contributor_invite', auth.uid(), p_series);
    end if;
  exception when others then null;
  end;
  return pid;
end $$;
revoke execute on function invite_contributor(uuid, text, text) from public, anon;
grant execute on function invite_contributor(uuid, text, text) to authenticated;

-- ───────────────────────── Per-series analytics (owner + analyst + editor) ─────────────────────────
-- Mirrors creator_analytics() but scoped to ONE series and gated by can_view_analytics(),
-- so analysts see only the series they were invited to — never a creator's other series.
create or replace function series_analytics(p_series uuid, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not can_view_analytics(p_series) then raise exception 'not allowed' using errcode = '42501'; end if;
  with rng as (select least(greatest(p_days, 1), 365) as n),
  ev as (
    select e.* from analytics_events e, rng
    where e.series_id = p_series and e.created_at >= now() - make_interval(days => rng.n)
  ),
  days as (select d::date as day from rng, generate_series((now() - make_interval(days => rng.n))::date, now()::date, interval '1 day') d)
  select jsonb_build_object(
    'series_views', (select count(*) from ev where event_type = 'series_view'),
    'chapter_views', (select count(*) from ev where event_type = 'chapter_view'),
    'completions', (select count(*) from ev where event_type = 'chapter_complete'),
    'unique_readers', (select count(distinct user_id) from ev where user_id is not null),
    'followers', (select count(*) from follows f join series s on s.id = p_series where f.creator_id = s.creator_id),
    'comments', (select count(*) from comments c, rng where c.series_id = p_series and c.created_at >= now() - make_interval(days => rng.n)),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'views', coalesce(c.n, 0)) order by d.day), '[]'::jsonb)
              from days d left join (select created_at::date as day, count(*) n from ev where event_type in ('series_view','chapter_view') group by 1) c on c.day = d.day),
    'top_chapters', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
        select ch.id, s.title as series, ch.chapter_number, count(*) as views
        from ev join chapters ch on ch.id = ev.chapter_id join series s on s.id = ch.series_id
        where ev.event_type = 'chapter_view' group by 1, 2, 3 order by views desc limit 5) t)
  ) into result;
  return result;
end $$;
revoke execute on function series_analytics(uuid, int) from public, anon;
grant execute on function series_analytics(uuid, int) to authenticated;

-- ───────────────── Restricted storage keys for mature series (SEC-007 §4.4) ─────────────────
-- Re-issued from 0014 with one change: assets of mature-rated series are stored under the
-- `restricted/` prefix (private bucket / non-CDN namespace in production). Permission checks
-- (can_upload_assets) are unchanged. Covers follow the same rule in /api/uploads/cover.
create or replace function register_chapter_assets(p_chapter uuid, p_files jsonb)
returns table (id uuid, storage_key text, display_order int, mime_type text)
language plpgsql security definer set search_path = public as $$
declare sid uuid; s_rating content_rating; key_prefix text := ''; start_ord int; n int; existing int; f jsonb; i int := 0; ext text; mt text; sz bigint;
begin
  select series_id into sid from chapters where chapters.id = p_chapter for update;
  select content_rating into s_rating from series where id = sid;
  if s_rating = 'mature' then key_prefix := 'restricted/'; end if;
  if sid is null or not can_upload_assets(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_files) <> 'array' then raise exception 'invalid files'; end if;
  n := jsonb_array_length(p_files);
  select count(*), coalesce(max(a.display_order) + 1, 0) into existing, start_ord from chapter_assets a where a.chapter_id = p_chapter;
  if n < 1 or existing + n > 300 then raise exception 'invalid file count'; end if;
  for f in select * from jsonb_array_elements(p_files) loop
    mt := f->>'type'; sz := (f->>'size')::bigint;
    ext := case mt when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else null end;
    if ext is null or sz is null or sz <= 0 or sz > 15 * 1024 * 1024 then raise exception 'invalid file'; end if;
    id := gen_random_uuid(); storage_key := key_prefix || sid || '/' || p_chapter || '/' || gen_random_uuid() || '.' || ext;
    display_order := start_ord + i; mime_type := mt; i := i + 1;
    insert into chapter_assets (id, chapter_id, storage_key, display_order, mime_type, file_size)
      values (register_chapter_assets.id, p_chapter, register_chapter_assets.storage_key, register_chapter_assets.display_order, mt, sz);
    return next;
  end loop;
  update chapters set publication_status = 'uploading' where chapters.id = p_chapter and publication_status = 'draft';
end $$;

create or replace function replace_chapter_asset(p_asset uuid, p_type text, p_size bigint)
returns table (new_key text, old_key text)
language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid; s_rating content_rating; ext text; old text; nk text;
begin
  select a.chapter_id, a.storage_key into cid, old from chapter_assets a where a.id = p_asset for update;
  select series_id into sid from chapters where chapters.id = cid;
  select content_rating into s_rating from series where id = sid;
  if cid is null or not can_upload_assets(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  ext := case p_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else null end;
  if ext is null or p_size is null or p_size <= 0 or p_size > 15 * 1024 * 1024 then raise exception 'invalid file'; end if;
  nk := (case when s_rating = 'mature' then 'restricted/' else '' end) || sid || '/' || cid || '/' || gen_random_uuid() || '.' || ext;
  update chapter_assets set storage_key = nk, mime_type = p_type, file_size = p_size,
    processing_status = 'pending', original_width = null, original_height = null where id = p_asset;
  new_key := nk; old_key := old; return next;
end $$;
