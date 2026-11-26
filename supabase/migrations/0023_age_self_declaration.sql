-- 0023: Age access by SELF-DECLARATION (v9) — replaces third-party age verification.
--
-- Product decision: there is no age-assurance provider in v9 (no real one, no manual
-- stub, no fake verification). Mature (18+) eligibility is:
--   signed-in + not suspended + profile date_of_birth proves age >= 18
--   + a recorded acceptance of the current age policy (this migration).
-- Acceptance is recorded ONLY through record_age_policy_acceptance() (or at signup by
-- handle_new_user() from sign-up metadata): profiles_guard() pins the acceptance
-- columns against direct profile updates, so users cannot forge an acceptance.
-- The DB mirror is_mature_eligible() checks that SOME acceptance is recorded
-- (version non-null + timestamp present); equality with the app's current policy
-- version (src/lib/age-policy.ts CURRENT_AGE_POLICY_VERSION) is enforced in the app
-- layer, because SQL cannot know the code constant — the record function stores
-- whatever version the app passes, and the app only ever passes the current one.
--
-- Retired by this migration:
--   - record_age_verification() now raises (kept, same signature, so old callers fail
--     loudly instead of silently writing meaningless rows). The historical
--     age_verification_records table is RETAINED as audit history — do not drop it.
--   - age_verification_sessions is dropped: it held only transient single-use nonces
--     (hashes) for the removed provider flow and has no audit value.
-- Also here: series content-warning constraint expanded to the v9 warning set in
-- src/lib/age-core.ts (CONTENT_WARNINGS).

-- ───────────────────────── Profiles: policy acceptance ─────────────────────────
alter table profiles
  add column if not exists age_policy_version text,
  add column if not exists age_policy_accepted_at timestamptz;

-- ───────────────────────── Acceptance audit trail ─────────────────────────
create table if not exists age_policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  policy_version text not null,
  accepted_at timestamptz not null default now()
);
create index if not exists age_policy_acceptances_user_idx on age_policy_acceptances (user_id, accepted_at desc);
alter table age_policy_acceptances enable row level security;
drop policy if exists age_policy_acceptances_own_read on age_policy_acceptances;
create policy age_policy_acceptances_own_read on age_policy_acceptances for select using (user_id = auth.uid() or is_admin());
revoke all on age_policy_acceptances from anon, authenticated;
grant select on age_policy_acceptances to authenticated;
-- Writes happen only through record_age_policy_acceptance() / handle_new_user().

-- ───────────────────────── Guard: acceptance cannot be forged ─────────────────────────
-- Re-issued from 0021 (role/suspension raise + pinned DOB/verification columns) with
-- age_policy_version / age_policy_accepted_at added to the pinned list. The guard only
-- applies when current_user is a client role (authenticated/anon) and the caller is not
-- an admin; SECURITY DEFINER functions such as record_age_policy_acceptance() run as
-- the function owner, so their updates pass — exactly the mechanism that already lets
-- record_age_verification() update the pinned age_verification_* columns.
create or replace function profiles_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and not coalesce(is_admin(), false) then
    if new.role is distinct from old.role or new.suspended is distinct from old.suspended then
      raise exception 'role and suspension are managed by administrators' using errcode = '42501';
    end if;
    new.date_of_birth := old.date_of_birth;
    new.age_verification_status := old.age_verification_status;
    new.age_verification_provider := old.age_verification_provider;
    new.age_verified_at := old.age_verified_at;
    new.age_verification_expires_at := old.age_verification_expires_at;
    new.age_policy_version := old.age_policy_version;
    new.age_policy_accepted_at := old.age_policy_accepted_at;
  end if;
  return new;
end $$;

-- ───────────────────────── Record acceptance (self-service) ─────────────────────────
create or replace function record_age_policy_acceptance(p_version text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); ts timestamptz := now();
begin
  if uid is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_version is null or length(trim(p_version)) = 0 then raise exception 'policy version required'; end if;
  insert into age_policy_acceptances (user_id, policy_version, accepted_at) values (uid, p_version, ts);
  update profiles set age_policy_version = p_version, age_policy_accepted_at = ts where id = uid;
  if not found then raise exception 'profile not found'; end if;
end $$;
revoke execute on function record_age_policy_acceptance(text) from public, anon;
grant execute on function record_age_policy_acceptance(text) to authenticated;

-- ───────────────────────── Admin DOB correction ─────────────────────────
-- Correcting a DOB invalidates the declaration made against the old one, so the
-- acceptance stamp is cleared and the user must confirm again on /age. Audit-logged
-- via _audit() like the other admin functions (0009/0015).
create or replace function admin_set_date_of_birth(p_user uuid, p_dob date) returns void
language plpgsql security definer set search_path = public as $$
declare old_dob date;
begin
  if not coalesce(is_admin(), false) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_dob is null or p_dob > current_date or p_dob <= current_date - interval '120 years' then
    raise exception 'invalid date_of_birth'; end if;
  select date_of_birth into old_dob from profiles where id = p_user;
  if not found then raise exception 'user not found'; end if;
  update profiles set date_of_birth = p_dob, age_policy_version = null, age_policy_accepted_at = null
  where id = p_user;
  perform _audit('admin_date_of_birth_corrected', 'user', p_user::text,
    jsonb_build_object('date_of_birth', p_dob, 'previous_date_of_birth', old_dob));
end $$;
revoke execute on function admin_set_date_of_birth(uuid, date) from public, anon;
grant execute on function admin_set_date_of_birth(uuid, date) to authenticated, service_role;

-- ───────────────────────── Eligibility mirror (self-declaration) ─────────────────────────
-- Suspension column is profiles.suspended (as in 0015/0016). Version equality with the
-- app's CURRENT_AGE_POLICY_VERSION is enforced in the app layer (see header): the DB
-- checks that an acceptance was recorded (non-null version + timestamp).
create or replace function is_mature_eligible(uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    where p.id = uid and not p.suspended
      and p.date_of_birth is not null
      and p.date_of_birth <= current_date - interval '18 years'
      and p.age_policy_version is not null
      and p.age_policy_accepted_at is not null
  ) $$;
revoke execute on function is_mature_eligible(uuid) from public, anon;
grant execute on function is_mature_eligible(uuid) to authenticated, service_role;

-- ───────────────────────── Retire record_age_verification ─────────────────────────
-- Same signature as 0015/0016; the body only raises, so any stale caller (old admin
-- UI, old API route) fails loudly. Grants kept as they were.
create or replace function record_age_verification(
  p_user uuid, p_status text, p_provider text, p_reference text default null,
  p_jurisdiction text default null, p_expires_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = public as $$
begin
  raise exception 'record_age_verification retired in v9: age access uses self-declaration (migration 0023)';
end $$;
revoke execute on function record_age_verification(uuid, text, text, text, text, timestamptz) from public, anon;
grant execute on function record_age_verification(uuid, text, text, text, text, timestamptz) to authenticated, service_role;

-- Sessions held transient nonces only — no audit value. Drop them.
drop table if exists age_verification_sessions;

-- ───────────────────────── Signup: record acceptance from metadata ─────────────────────────
-- Re-issued from 0019 (collision-safe usernames) with one addition: when sign-up
-- metadata carries age_policy_accepted='true' and a non-empty age_policy_version
-- (AuthForm's required declaration checkbox), the acceptance is recorded on the new
-- profile and in age_policy_acceptances. The /age page remains the canonical
-- acceptance point for everyone else (older accounts, version bumps, DOB corrections).
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare dob date; uname text; attempt int := 0;
  accepted boolean := (new.raw_user_meta_data->>'age_policy_accepted' = 'true'
                       and coalesce(new.raw_user_meta_data->>'age_policy_version', '') <> '');
  pversion text := nullif(new.raw_user_meta_data->>'age_policy_version', '');
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
  uname := coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(replace(new.id::text,'-',''),1,10));
  loop
    begin
      insert into profiles (id, username, display_name, age_confirmed_at, adult_confirmed_at, date_of_birth, age_policy_version, age_policy_accepted_at)
      values (new.id,
        uname,
        coalesce(new.raw_user_meta_data->>'display_name', 'New reader'),
        case when dob is not null or new.raw_user_meta_data->>'age_confirmed' = 'true' then now() end,
        case when new.raw_user_meta_data->>'adult_confirmed' = 'true' then now() end,
        dob,
        case when accepted then pversion end,
        case when accepted then now() end);
      if accepted then
        insert into age_policy_acceptances (user_id, policy_version) values (new.id, pversion);
      end if;
      exit;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 5 then raise; end if;
      uname := left(uname, 24) || '_' || substr(md5(random()::text || new.id::text), 1, 6);
    end;
  end loop;
  return new;
end $$;

-- ───────────────────────── Content warnings: v9 set ─────────────────────────
-- Matches CONTENT_WARNINGS in src/lib/age-core.ts.
alter table series drop constraint if exists series_content_warnings_valid;
alter table series add constraint series_content_warnings_valid
  check (content_warnings <@ array['violence','graphic_violence','gore','nudity','strong_language','sexual_themes','psychological','substance_use','disturbing_imagery','other']::text[]);
