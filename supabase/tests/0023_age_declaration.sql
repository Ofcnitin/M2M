-- Age self-declaration checks for migration 0023 (v9). Run after all migrations on a
-- LOCAL/STAGING db:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0023_age_declaration.sql
-- One transaction, rolled back.
begin;
create or replace function pg_temp.expect_fail(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'SHOULD HAVE FAILED: %', what;
end $$;

-- fixtures: adult a1, adult a2 (acceptance target for forgery checks), minor a3,
-- adult a4 (DOB-correction target), admin a9
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1','a1@test.dev','{"username":"dec_adult1","date_of_birth":"2000-01-01"}'),
  ('00000000-0000-0000-0000-0000000000a2','a2@test.dev','{"username":"dec_adult2","date_of_birth":"1995-05-05"}'),
  ('00000000-0000-0000-0000-0000000000a3','a3@test.dev','{"username":"dec_minor","date_of_birth":"2012-01-01"}'),
  ('00000000-0000-0000-0000-0000000000a4','a4@test.dev','{"username":"dec_adult4","date_of_birth":"1990-01-01"}'),
  ('00000000-0000-0000-0000-0000000000a9','a9@test.dev','{"username":"dec_admin","date_of_birth":"1985-01-01"}');
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a9';

-- ── record_age_policy_acceptance(): auth + version required ──
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_fail($$select record_age_policy_acceptance('2026-11-v1')$$, 'acceptance without a signed-in user');
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000a1','role','authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_fail($$select record_age_policy_acceptance('')$$, 'acceptance with an empty policy version');
select pg_temp.expect_fail($$select record_age_policy_acceptance(null)$$, 'acceptance with a null policy version');
reset role;

-- ── eligibility matrix: acceptance flow ──
-- no acceptance -> not eligible (even for an adult)
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000a1')) then raise exception 'ASSERT FAILED'; end if; end $$;
-- acceptance recorded -> eligible
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000a1','role','authenticated')::text, true);
set local role authenticated;
select record_age_policy_acceptance('2026-11-v1');
reset role;
do $$ begin if not (is_mature_eligible('00000000-0000-0000-0000-0000000000a1')) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not ((select age_policy_version from profiles where id='00000000-0000-0000-0000-0000000000a1') = '2026-11-v1'
                     and (select age_policy_accepted_at from profiles where id='00000000-0000-0000-0000-0000000000a1') is not null
                     and exists (select 1 from age_policy_acceptances where user_id='00000000-0000-0000-0000-0000000000a1' and policy_version='2026-11-v1'))
  then raise exception 'ASSERT FAILED'; end if; end $$;
-- under-18 with acceptance -> not eligible
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000a3','role','authenticated')::text, true);
set local role authenticated;
select record_age_policy_acceptance('2026-11-v1');
reset role;
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000a3')) then raise exception 'ASSERT FAILED'; end if; end $$;
-- suspended adult with acceptance -> not eligible
update profiles set suspended = true where id = '00000000-0000-0000-0000-0000000000a1';
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000a1')) then raise exception 'ASSERT FAILED'; end if; end $$;
update profiles set suspended = false where id = '00000000-0000-0000-0000-0000000000a1';

-- ── forgery: a direct profile update cannot set the acceptance columns ──
-- a2 has no acceptance; forging one via UPDATE is silently reverted by profiles_guard
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000a2','role','authenticated')::text, true);
set local role authenticated;
update profiles set age_policy_version = '2026-11-v1', age_policy_accepted_at = now() where id = '00000000-0000-0000-0000-0000000000a2';
reset role;
do $$ begin if not ((select age_policy_version from profiles where id='00000000-0000-0000-0000-0000000000a2') is null
                     and (select age_policy_accepted_at from profiles where id='00000000-0000-0000-0000-0000000000a2') is null)
  then raise exception 'ASSERT FAILED: forged acceptance was not reverted by profiles_guard'; end if; end $$;
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000a2')) then raise exception 'ASSERT FAILED'; end if; end $$;
-- a1's real acceptance cannot be overwritten with a forged version either
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000a1','role','authenticated')::text, true);
set local role authenticated;
update profiles set age_policy_version = 'forged-version' where id = '00000000-0000-0000-0000-0000000000a1';
reset role;
do $$ begin if not ((select age_policy_version from profiles where id='00000000-0000-0000-0000-0000000000a1') = '2026-11-v1') then raise exception 'ASSERT FAILED: acceptance version overwrite was not reverted'; end if; end $$;

-- ── admin_set_date_of_birth(): admin only, resets acceptance, audit-logged ──
-- give a4 an acceptance first
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000a4','role','authenticated')::text, true);
set local role authenticated;
select record_age_policy_acceptance('2026-11-v1');
reset role;
do $$ begin if not (is_mature_eligible('00000000-0000-0000-0000-0000000000a4')) then raise exception 'ASSERT FAILED'; end if; end $$;
-- a non-admin cannot call it
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000a1','role','authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_fail($$select admin_set_date_of_birth('00000000-0000-0000-0000-0000000000a4', date '1990-01-01')$$, 'admin_set_date_of_birth as non-admin');
reset role;
-- implausible DOBs are rejected even for admins
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000a9','role','authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_fail($$select admin_set_date_of_birth('00000000-0000-0000-0000-0000000000a4', current_date + 1)$$, 'admin_set_date_of_birth with a future DOB');
select pg_temp.expect_fail($$select admin_set_date_of_birth('00000000-0000-0000-0000-0000000000a4', current_date - interval '121 years')$$, 'admin_set_date_of_birth with an implausible DOB');
-- the admin correction succeeds, updates the DOB, clears the acceptance, and is audited
select admin_set_date_of_birth('00000000-0000-0000-0000-0000000000a4', date '2012-06-01');
reset role;
do $$ begin if not ((select date_of_birth from profiles where id='00000000-0000-0000-0000-0000000000a4') = date '2012-06-01'
                     and (select age_policy_version from profiles where id='00000000-0000-0000-0000-0000000000a4') is null
                     and (select age_policy_accepted_at from profiles where id='00000000-0000-0000-0000-0000000000a4') is null)
  then raise exception 'ASSERT FAILED: DOB correction did not reset acceptance'; end if; end $$;
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000a4')) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not (exists (select 1 from admin_audit_log where action='admin_date_of_birth_corrected' and target_id='00000000-0000-0000-0000-0000000000a4')) then raise exception 'ASSERT FAILED: DOB correction not audit-logged'; end if; end $$;

-- ── signup metadata acceptance (handle_new_user, migration 0023) ──
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b1','b1@test.dev','{"username":"dec_signup","date_of_birth":"2000-01-01","age_policy_accepted":"true","age_policy_version":"2026-11-v1"}');
do $$ begin if not (is_mature_eligible('00000000-0000-0000-0000-0000000000b1')
                     and exists (select 1 from age_policy_acceptances where user_id='00000000-0000-0000-0000-0000000000b1' and policy_version='2026-11-v1'))
  then raise exception 'ASSERT FAILED: signup acceptance not recorded'; end if; end $$;
-- a signup without the acceptance metadata gets no acceptance
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2','b2@test.dev','{"username":"dec_signup2","date_of_birth":"2000-01-01"}');
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000b2')) then raise exception 'ASSERT FAILED'; end if; end $$;

rollback;
