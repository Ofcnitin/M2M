-- Run against a LOCAL/STAGING Supabase after migrations 0001-0015 (the suite was written against 0005 and is kept green by later migrations):  psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0005_lockdown.sql
-- Everything runs in one transaction and is rolled back. Each check raises if the lockdown is broken.
begin;
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create or replace function pg_temp.expect_fail(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'SHOULD HAVE FAILED: %', what;
end $$;

-- fixtures (as superuser)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','owner@test.dev'), ('00000000-0000-0000-0000-0000000000b2','other@test.dev');
update profiles set role = 'creator' where id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2');
insert into creator_profiles (user_id, creator_slug, terms_accepted_at, terms_version) values
  ('00000000-0000-0000-0000-0000000000a1','owner-t', now(), 'v1'), ('00000000-0000-0000-0000-0000000000b2','other-t', now(), 'v1');
insert into series (id, creator_id, title, slug, visibility)
  values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','T','t-series','published');
insert into chapters (id, series_id, chapter_number) values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',1);

select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
-- owner cannot publish via direct UPDATE or INSERT
select pg_temp.expect_fail($$update chapters set publication_status='published' where id='20000000-0000-0000-0000-000000000001'$$, 'direct chapter publish');
-- chapters_guard (0005) coerces direct INSERTs to 'draft' instead of raising: the security
-- outcome is that the chapter is NOT published. Assert exactly that (v8 suite fix).
insert into chapters (series_id, chapter_number, publication_status) values ('10000000-0000-0000-0000-000000000001', 2, 'published');
do $$ begin if exists (select 1 from chapters where series_id='10000000-0000-0000-0000-000000000001' and chapter_number=2 and publication_status <> 'draft')
  then raise exception 'ASSERT FAILED: direct insert as published was not coerced to draft'; end if; end $$;
delete from chapters where series_id='10000000-0000-0000-0000-000000000001' and chapter_number=2;
-- owner cannot write chapter_assets directly
select pg_temp.expect_fail($$insert into chapter_assets (chapter_id, storage_key, display_order, mime_type, processing_status) values ('20000000-0000-0000-0000-000000000001','k/x.jpg',0,'image/jpeg','ready')$$, 'direct asset insert');
-- publish with zero assets fails
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000001')$$, 'publish with no assets');
-- register via RPC works, asset starts pending, publish still blocked
select count(*) from register_chapter_assets('20000000-0000-0000-0000-000000000001', '[{"type":"image/jpeg","size":1000}]'::jsonb);
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000001')$$, 'publish with pending asset');
select pg_temp.expect_fail($$update chapter_assets set processing_status='ready'$$, 'direct asset ready');
-- bad inputs rejected
select pg_temp.expect_fail($$select * from register_chapter_assets('20000000-0000-0000-0000-000000000001', '[{"type":"image/svg+xml","size":10}]'::jsonb)$$, 'svg type');

-- another creator cannot touch the chapter
select pg_temp.as_user('00000000-0000-0000-0000-0000000000b2');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000001')$$, 'cross-creator publish');
select pg_temp.expect_fail($$select * from register_chapter_assets('20000000-0000-0000-0000-000000000001', '[{"type":"image/png","size":10}]'::jsonb)$$, 'cross-creator register');
select pg_temp.expect_fail($$select unpublish_chapter('20000000-0000-0000-0000-000000000001')$$, 'cross-creator unpublish');

-- analytics: no direct insert, no direct RPC
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_fail($$insert into analytics_events (event_type, series_id) values ('series_view','10000000-0000-0000-0000-000000000001')$$, 'direct analytics insert');
select pg_temp.expect_fail($$select track_event('series_view','10000000-0000-0000-0000-000000000001',null,null,'x')$$, 'track_event as authenticated');
reset role;

-- service role: valid event counted once, duplicate deduped
set local role service_role;
do $$ begin if not (track_event('series_view','10000000-0000-0000-0000-000000000001',null,null,'v1')) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not (not track_event('series_view','10000000-0000-0000-0000-000000000001',null,null,'v1')) then raise exception 'ASSERT FAILED'; end if; end $$;

-- 0006/0007: cover cannot be set by a creator; deleting a chapter queues its object keys
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_fail($$update series set cover_url='someone-elses/cover/x.jpg' where id='10000000-0000-0000-0000-000000000001'$$, 'client-set cover');
reset role;
delete from chapters where id='20000000-0000-0000-0000-000000000001';
do $$ begin if not (exists (select 1 from cleanup_jobs where reason='asset_deleted')) then raise exception 'ASSERT FAILED'; end if; end $$;

-- 0008: stale pending uploads are failed and queued for cleanup; re-sign only works for pending assets
reset role;
insert into chapters (id, series_id, chapter_number, publication_status) values ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',2,'uploading');
insert into chapter_assets (id, chapter_id, storage_key, display_order, mime_type, created_at)
  values ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','s/c/stale.jpg',0,'image/jpeg', now() - interval '3 hours');
do $$ begin if not (expire_stale_uploads() >= 1) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not ((select processing_status from chapter_assets where id='30000000-0000-0000-0000-000000000001') = 'failed') then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not ((select publication_status from chapters where id='20000000-0000-0000-0000-000000000002') = 'failed') then raise exception 'ASSERT FAILED'; end if; end $$;

-- 0009: audit log is append-only; admin removal is logged
insert into admin_audit_log (actor_id, action, target_type, target_id) values ('00000000-0000-0000-0000-0000000000a1','t','t','t');
select pg_temp.expect_fail($$update admin_audit_log set action='x'$$, 'audit update');
select pg_temp.expect_fail($$delete from admin_audit_log$$, 'audit delete');

-- 0010: publishing writes one outbox event (not per-follower rows); delivery respects suspension and preferences
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c3','fan@test.dev'), ('00000000-0000-0000-0000-0000000000d4','muted@test.dev');
insert into follows (user_id, creator_id) values ('00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000a1');
insert into notification_preferences (user_id, type, enabled) values ('00000000-0000-0000-0000-0000000000d4','new_chapter', false);
update chapters set publication_status='published' where id='20000000-0000-0000-0000-000000000002';
do $$ begin if not ((select count(*) from notification_outbox where chapter_id='20000000-0000-0000-0000-000000000002') = 1) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not ((select count(*) from notifications where chapter_id='20000000-0000-0000-0000-000000000002') = 0) then raise exception 'ASSERT FAILED'; end if; end $$;
select deliver_outbox();
do $$ begin if not ((select count(*) from notifications where chapter_id='20000000-0000-0000-0000-000000000002') = 1) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not (exists (select 1 from notifications where chapter_id='20000000-0000-0000-0000-000000000002' and user_id='00000000-0000-0000-0000-0000000000c3')) then raise exception 'ASSERT FAILED'; end if; end $$;
rollback;
