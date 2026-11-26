-- 0016: Age-assurance hardening (v8) — verification sessions + manual-provider lockdown.
--
-- Why: in v7 the `manual` admin-attestation stub was a registered provider and
-- isAgeAssuranceConfigured() returned true for ANY registered name, so
-- AGE_ASSURANCE_PROVIDER=manual plus a profile marked verified via manual attestation
-- satisfied mature eligibility. The app layer now requires a REAL provider both as the
-- configured provider and as the provider that verified the profile
-- (src/lib/age-core.ts: 'provider_not_real'). This migration adds the database side:
--
--   1. age_verification_sessions: single-use, expiring sessions for the real-provider
--      verification flow (/api/age/verify/start + /api/age/verify/callback). Only the
--      SHA-256 hash of the nonce/state is stored. Service-role only: RLS is enabled
--      with NO client policies and all grants revoked from anon/authenticated.
--   2. record_age_verification() is hardened: recording status='verified' with
--      provider='manual' now RAISES instead of writing. ADMIN UI IMPACT: any admin
--      flow that records a manual attestation as 'verified' will now fail with a
--      clear error; admins must record manual attestations as 'pending' (bookkeeping
--      only) — a 'verified' status can only come from a real provider. Audit behaviour
--      is unchanged: successful calls still write age_verification_records (inside the
--      function) and the _audit() entry.
--   3. is_mature_eligible() mirror updated to exclude provider='manual' verifications,
--      so the DB layer agrees with the app layer even for rows written before 0016.

-- ───────────────────────── Verification sessions ─────────────────────────
create table if not exists age_verification_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  provider text not null,
  nonce_hash text not null,
  status text not null default 'pending' check (status in ('pending','consumed','expired','failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  unique (nonce_hash)
);
create index if not exists avs_user_status_idx on age_verification_sessions (user_id, status);

alter table age_verification_sessions enable row level security;
-- No policies on purpose: anon/authenticated get nothing; only the service role
-- (which bypasses RLS) may read or write sessions, via the server API routes.
revoke all on age_verification_sessions from anon, authenticated;
grant all on age_verification_sessions to service_role;

-- ───────────────── record_age_verification(): manual can never verify ─────────────────
-- Same signature/body as 0015, plus the manual guard immediately after the status check.
create or replace function record_age_verification(
  p_user uuid, p_status text, p_provider text, p_reference text default null,
  p_jurisdiction text default null, p_expires_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if not (coalesce(is_admin(), false) or auth.role() = 'service_role') then
    raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('pending','verified','failed','expired','revoked') then raise exception 'invalid status'; end if;
  -- v8 hardening: 'manual' is an admin attestation stub, NOT a real age-assurance
  -- provider. It must never produce a 'verified' status (see header: admin UI impact).
  if p_status = 'verified' and lower(coalesce(p_provider, '')) = 'manual' then
    raise exception 'manual attestation cannot verify age: a real age-assurance provider is required'
      using errcode = '42501'; end if;
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

-- ───────────────── is_mature_eligible(): exclude manual verifications ─────────────────
create or replace function is_mature_eligible(uid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    where p.id = uid and not p.suspended
      and p.date_of_birth is not null
      and p.date_of_birth <= current_date - interval '18 years'
      and p.age_verification_status = 'verified'
      and p.age_verification_provider is not null
      and lower(p.age_verification_provider) <> 'manual'
      and (p.age_verification_expires_at is null or p.age_verification_expires_at > now())
  ) $$;
revoke execute on function is_mature_eligible(uuid) from public, anon;
grant execute on function is_mature_eligible(uuid) to authenticated, service_role;
