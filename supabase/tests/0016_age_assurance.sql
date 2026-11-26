-- Age-declaration checks — REPURPOSED for v9 (migration 0023). This file was the
-- 0016 age-assurance (provider/session) suite; the provider model is retired, so the
-- suite now asserts the self-declaration rules and the retirement itself. Filename
-- kept so suite lists and history stay stable.
-- Run after all migrations on a LOCAL/STAGING db:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0016_age_assurance.sql
-- One transaction, rolled back.
begin;
create or replace function pg_temp.expect_fail(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'SHOULD HAVE FAILED: %', what;
end $$;

-- fixtures: an adult and a minor
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1','age16@test.dev','{"username":"age16_adult","date_of_birth":"2000-01-01"}'),
  ('00000000-0000-0000-0000-0000000000f2','age16m@test.dev','{"username":"age16_minor","date_of_birth":"2012-01-01"}');

-- ── retirement: sessions table is gone, records table (audit history) is retained ──
do $$ begin
  if to_regclass('public.age_verification_sessions') is not null
  then raise exception 'ASSERT FAILED: age_verification_sessions must be dropped in v9'; end if;
end $$;
do $$ begin
  if to_regclass('public.age_verification_records') is null
  then raise exception 'ASSERT FAILED: age_verification_records must be retained as audit history'; end if;
end $$;

-- ── record_age_verification() raises for every caller/shape ──
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.expect_fail($$select record_age_verification('00000000-0000-0000-0000-0000000000f1','verified','manual','ref-m', 'IN', now() + interval '1 year')$$,
  'record_age_verification retired (manual)');
select pg_temp.expect_fail($$select record_age_verification('00000000-0000-0000-0000-0000000000f1','verified','mockreal','ref-r', 'IN', now() + interval '1 year')$$,
  'record_age_verification retired (any provider)');
select pg_temp.expect_fail($$select record_age_verification('00000000-0000-0000-0000-0000000000f1','pending','manual','ref-m2','IN', null)$$,
  'record_age_verification retired (pending bookkeeping)');
-- the failed calls must not have changed the profile
do $$ begin if not ((select age_verification_status from profiles where id='00000000-0000-0000-0000-0000000000f1') = 'unverified') then raise exception 'ASSERT FAILED'; end if; end $$;

-- ── declaration flow: no acceptance -> not eligible; acceptance -> eligible (18+) ──
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000f1')) then raise exception 'ASSERT FAILED'; end if; end $$;
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000f1','role','authenticated')::text, true);
set local role authenticated;
select record_age_policy_acceptance('2026-11-v1');
reset role;
do $$ begin if not (is_mature_eligible('00000000-0000-0000-0000-0000000000f1')) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not ((select age_policy_version from profiles where id='00000000-0000-0000-0000-0000000000f1') = '2026-11-v1'
                     and (select age_policy_accepted_at from profiles where id='00000000-0000-0000-0000-0000000000f1') is not null)
  then raise exception 'ASSERT FAILED'; end if; end $$;

-- under-18 with an acceptance is still not eligible
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000f2','role','authenticated')::text, true);
set local role authenticated;
select record_age_policy_acceptance('2026-11-v1');
reset role;
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000f2')) then raise exception 'ASSERT FAILED'; end if; end $$;

-- a suspended adult is not eligible even with an acceptance
update profiles set suspended = true where id='00000000-0000-0000-0000-0000000000f1';
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000f1')) then raise exception 'ASSERT FAILED'; end if; end $$;
update profiles set suspended = false where id='00000000-0000-0000-0000-0000000000f1';
do $$ begin if not (is_mature_eligible('00000000-0000-0000-0000-0000000000f1')) then raise exception 'ASSERT FAILED'; end if; end $$;

-- ── acceptances table: clients can read their own rows but never write directly ──
do $$ begin
  if has_table_privilege('anon', 'age_policy_acceptances', 'select')
     or has_table_privilege('authenticated', 'age_policy_acceptances', 'insert')
     or not has_table_privilege('authenticated', 'age_policy_acceptances', 'select')
  then raise exception 'ASSERT FAILED: age_policy_acceptances privileges wrong'; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000f1','role','authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_fail($$insert into age_policy_acceptances (user_id, policy_version) values ('00000000-0000-0000-0000-0000000000f1','forged')$$,
  'direct insert into age_policy_acceptances');
do $$ begin if not (exists (select 1 from age_policy_acceptances where user_id='00000000-0000-0000-0000-0000000000f1')) then raise exception 'ASSERT FAILED: own acceptance rows readable'; end if; end $$;
do $$ begin if (exists (select 1 from age_policy_acceptances where user_id='00000000-0000-0000-0000-0000000000f2')) then raise exception 'ASSERT FAILED: other users acceptance rows hidden'; end if; end $$;
reset role;

rollback;
