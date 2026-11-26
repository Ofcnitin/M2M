-- SEC-007 checks, updated for the v9 SELF-DECLARATION model (migration 0023).
-- Run after all migrations on a LOCAL/STAGING db:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0015_sec007.sql
-- One transaction, rolled back.
begin;
create or replace function pg_temp.expect_fail(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'SHOULD HAVE FAILED: %', what;
end $$;

-- fixtures: an adult, an adult who never confirms, a minor
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000e1','adult@test.dev','{"username":"sec_adult","date_of_birth":"2000-01-01"}'),
  ('00000000-0000-0000-0000-0000000000e2','unver@test.dev','{"username":"sec_unver","date_of_birth":"2000-01-01"}'),
  ('00000000-0000-0000-0000-0000000000e3','minor@test.dev','{"username":"sec_minor","date_of_birth":"2012-01-01"}');
-- DOB was copied from metadata by handle_new_user
do $$ begin if not ((select date_of_birth from profiles where id='00000000-0000-0000-0000-0000000000e1') = date '2000-01-01') then raise exception 'ASSERT FAILED'; end if; end $$;
-- under-13 signup is rejected by the trigger
select pg_temp.expect_fail($$insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000e4','kid@test.dev','{"username":"sec_kid","date_of_birth":"2020-01-01"}')$$, 'under-13 registration');

-- v9: a DOB alone is NOT enough — nobody is eligible before recording an age-policy acceptance
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000e1')) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000e3')) then raise exception 'ASSERT FAILED'; end if; end $$;
-- the retired provider-era RPC now raises instead of recording anything
select pg_temp.expect_fail($$select record_age_verification('00000000-0000-0000-0000-0000000000e1','verified','webhook','ref-1','IN', now() + interval '1 year')$$, 'record_age_verification is retired in v9');

-- the adult records an age-policy acceptance as themselves -> eligible
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000e1','role','authenticated')::text, true);
set local role authenticated;
select record_age_policy_acceptance('2026-11-v1');
reset role;
do $$ begin if not (is_mature_eligible('00000000-0000-0000-0000-0000000000e1')) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not (exists (select 1 from age_policy_acceptances where user_id='00000000-0000-0000-0000-0000000000e1' and policy_version='2026-11-v1')) then raise exception 'ASSERT FAILED'; end if; end $$;
-- the adult who never confirmed stays ineligible
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000e2')) then raise exception 'ASSERT FAILED'; end if; end $$;
-- a minor can never become eligible, even after recording an acceptance
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000e3','role','authenticated')::text, true);
set local role authenticated;
select record_age_policy_acceptance('2026-11-v1');
reset role;
do $$ begin if not (not is_mature_eligible('00000000-0000-0000-0000-0000000000e3')) then raise exception 'ASSERT FAILED'; end if; end $$;

-- content warnings are constrained to the allowed set (v9 set includes the new values)
insert into creator_profiles (user_id, creator_slug, terms_accepted_at, terms_version) values ('00000000-0000-0000-0000-0000000000e1','sec-creator', now(), 'v1');
update profiles set role='creator' where id='00000000-0000-0000-0000-0000000000e1';
insert into series (id, creator_id, title, slug, visibility, content_rating, content_warnings)
  values ('10000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e1','M','sec-mature','published','mature', array['violence','gore']);
update series set content_warnings = array['graphic_violence','sexual_themes','disturbing_imagery'] where id='10000000-0000-0000-0000-0000000000e1';
select pg_temp.expect_fail($$insert into series (creator_id, title, slug, content_warnings) values ('00000000-0000-0000-0000-0000000000e1','X','sec-bad', array['bogus'])$$, 'invalid content warning');

-- contributor invite creates a notification for the invitee (0015)
insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000e5','inv@test.dev','{"username":"sec_invitee","date_of_birth":"2001-01-01"}');
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000e1','role','authenticated')::text, true);
set local role authenticated;
select invite_contributor('10000000-0000-0000-0000-0000000000e1','sec_invitee','analyst');
reset role;
do $$ begin if not (exists (select 1 from notifications where user_id='00000000-0000-0000-0000-0000000000e5' and type='contributor_invite')) then raise exception 'ASSERT FAILED'; end if; end $$;
-- an invited (not yet accepted) contributor cannot run series_analytics
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-0000000000e5','role','authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_fail($$select series_analytics('10000000-0000-0000-0000-0000000000e1', 30)$$, 'series_analytics as invited-only contributor');
reset role;
rollback;
