-- QA-001: role matrix for RLS, grants and RPCs, run through real role switches (not the service role).
-- Run on a LOCAL/STAGING database after migrations 0001-0015:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/qa001_rls_matrix.sql
-- Everything runs in one transaction and is rolled back. Any broken rule raises an exception naming the check.
begin;

create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'reset role'; execute 'set local role authenticated';
end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'reset role'; execute 'set local role anon';
end $$;
create or replace function pg_temp.as_su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', true); end $$;
create or replace function pg_temp.expect_fail(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'SHOULD HAVE FAILED: %', what;
end $$;
create or replace function pg_temp.expect_ok(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise exception 'SHOULD HAVE WORKED: % (%)', what, sqlerrm; end;
end $$;
-- An UPDATE is "blocked" if it raises or touches no rows (RLS filtering or a guard trigger).
create or replace function pg_temp.expect_blocked(sql text, what text) returns void language plpgsql as $$
declare got int;
begin
  begin execute sql; get diagnostics got = row_count; exception when others then return; end;
  if got <> 0 then raise exception 'SHOULD HAVE BEEN BLOCKED: % (% rows changed)', what, got; end if;
end $$;
-- Row count of a statement (select/update/delete). Used for "sees nothing" and "changes nothing" checks.
create or replace function pg_temp.expect_rows(sql text, n int, what text) returns void language plpgsql as $$
declare got int;
begin
  execute sql; get diagnostics got = row_count;
  if got <> n then raise exception 'WRONG ROW COUNT for %: expected %, got %', what, n, got; end if;
end $$;

-- ───────── fixtures (superuser) ─────────
-- 01 owner, 02 other creator, 03 reader, 04 suspended creator, 05 restricted creator, 06 moderator, 07 admin,
-- 08 editor, 09 uploader, 0a analyst, 0b invited-only stranger
insert into auth.users (id, email) select ('00000000-0000-0000-0000-0000000000' || h)::uuid, 'u' || h || '@test.dev'
  from unnest(array['01','02','03','04','05','06','07','08','09','0a','0b']) h;
update profiles set username = 'u' || right(id::text, 2) where id::text like '00000000-0000-0000-0000-0000000000%';
update profiles set role = 'creator' where id in (select ('00000000-0000-0000-0000-0000000000' || h)::uuid from unnest(array['01','02','04','05','08','09','0a']) h);
update profiles set role = 'admin' where id = '00000000-0000-0000-0000-000000000007';
update profiles set suspended = true where id = '00000000-0000-0000-0000-000000000004';
update profiles set role = (select 'moderator'::user_role) where id = '00000000-0000-0000-0000-000000000006';
insert into creator_profiles (user_id, creator_slug, terms_accepted_at, terms_version, publishing_status) values
  ('00000000-0000-0000-0000-000000000001','c-owner', now(), 'v1', 'active'),
  ('00000000-0000-0000-0000-000000000002','c-other', now(), 'v1', 'active'),
  ('00000000-0000-0000-0000-000000000004','c-susp',  now(), 'v1', 'active'),
  ('00000000-0000-0000-0000-000000000005','c-restr', now(), 'v1', 'restricted');
insert into series (id, creator_id, title, slug, visibility) values
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Owned','s-owned','published'),
  ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000005','Restricted','s-restr','published'),
  ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Hidden draft','s-draft','draft'),
  ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000004','Suspended','s-susp','published');
-- ch1 draft (ready asset) · ch2 published · ch3 published in restricted series · ch4 draft for contributor tests · ch5 suspended owner's draft
insert into chapters (id, series_id, chapter_number, publication_status, published_at) values
  ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',1,'draft',null),
  ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001',2,'published',now()),
  ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002',1,'published',now()),
  ('20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001',3,'draft',null),
  ('20000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000004',1,'draft',null);
insert into chapter_assets (id, chapter_id, storage_key, display_order, mime_type, processing_status)
select ('30000000-0000-0000-0000-00000000000' || n)::uuid, ('20000000-0000-0000-0000-00000000000' || n)::uuid, 'k/' || n || '.jpg', 0, 'image/jpeg', 'ready'
from generate_series(1,5) n;
insert into contributor_permissions (series_id, user_id, role, status, invited_by) values
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000008','editor','active','00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000009','uploader','active','00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','analyst','active','00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000b','editor','invited','00000000-0000-0000-0000-000000000001');
insert into analytics_events (event_type, series_id) values ('series_view','10000000-0000-0000-0000-000000000001');
insert into copyright_cases (claimant_name, claimant_email, work_description, target_urls, series_id, ownership_statement, good_faith_statement, signature)
  values ('Claimant','claimant@test.dev','My original work here','{https://m2m.test/series/s-owned}','10000000-0000-0000-0000-000000000001',true,true,'Claimant');
insert into reports (reporter_id, target_type, target_id, reason) values ('00000000-0000-0000-0000-000000000003','series','10000000-0000-0000-0000-000000000001','spam');

-- ───────── guest (anon) ─────────
select pg_temp.as_anon();
select pg_temp.expect_rows($$select 1 from series where id='10000000-0000-0000-0000-000000000001'$$, 1, 'guest sees published series');
select pg_temp.expect_rows($$select 1 from series where id='10000000-0000-0000-0000-000000000003'$$, 0, 'guest must not see draft series');
select pg_temp.expect_rows($$select 1 from chapters where id='20000000-0000-0000-0000-000000000001'$$, 0, 'guest must not see draft chapter');
select pg_temp.expect_rows($$select 1 from chapter_assets where chapter_id='20000000-0000-0000-0000-000000000002'$$, 1, 'guest sees ready assets of a published chapter');
select pg_temp.expect_rows($$select 1 from chapter_assets where chapter_id='20000000-0000-0000-0000-000000000001'$$, 0, 'guest must not see draft assets');
select pg_temp.expect_fail($$insert into analytics_events (event_type, series_id) values ('series_view','10000000-0000-0000-0000-000000000001')$$, 'anon analytics insert');
select pg_temp.expect_fail($$insert into reports (target_type, target_id, reason) values ('series','10000000-0000-0000-0000-000000000001','x')$$, 'anon report');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000001')$$, 'anon publish');
select pg_temp.expect_fail($$select * from copyright_cases$$, 'anon reads copyright cases');
select pg_temp.expect_fail($$select submit_copyright_claim('A B','a@b.co',null,'a work here ok',array['https://x.y'],null,null,true,true,'A B')$$, 'anon calls claim RPC directly');
select pg_temp.expect_fail($$select * from cleanup_jobs$$, 'anon reads cleanup_jobs');

-- ───────── reader ─────────
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select pg_temp.expect_blocked($$update profiles set role='admin' where id='00000000-0000-0000-0000-000000000003'$$, 'reader self-promotes to admin');
-- A no-op write (suspended=false on an already-unsuspended row) touches a row but changes
-- nothing; assert the VALUES are unchanged instead of counting rows (v8 suite fix). The real
-- attack — a suspended user flipping their own flag — is checked immediately below.
update profiles set suspended=false where id='00000000-0000-0000-0000-000000000003';
do $$ begin if exists (select 1 from profiles where id='00000000-0000-0000-0000-000000000003' and (suspended or role <> 'reader'))
  then raise exception 'ASSERT FAILED: reader suspension/role values changed'; end if; end $$;
-- the real attack (v8, caught by executing this suite): a SUSPENDED user un-suspending themselves.
-- profiles_guard (0021) raises on any non-admin change to role/suspended.
select pg_temp.as_user('00000000-0000-0000-0000-000000000004');
select pg_temp.expect_blocked($$update profiles set suspended=false where id='00000000-0000-0000-0000-000000000004'$$, 'suspended user un-suspends themselves');
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select pg_temp.expect_blocked($$update series set title='x' where id='10000000-0000-0000-0000-000000000001'$$, 'reader edits a series');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000001')$$, 'reader publishes');
select pg_temp.expect_fail($$select register_chapter_assets('20000000-0000-0000-0000-000000000001','[{"type":"image/png","size":10}]')$$, 'reader registers assets');
select pg_temp.expect_fail($$select mod_set_content('series','10000000-0000-0000-0000-000000000001',true,'valid reason')$$, 'reader moderates');
select pg_temp.expect_fail($$select invite_contributor('10000000-0000-0000-0000-000000000001','u02','editor')$$, 'reader invites contributor');
select pg_temp.expect_fail($$select track_event('series_view','10000000-0000-0000-0000-000000000001',null,null,'k')$$, 'reader calls track_event');
select pg_temp.expect_rows($$select 1 from admin_audit_log$$, 0, 'reader reads audit log');
select pg_temp.expect_rows($$select 1 from copyright_cases$$, 0, 'reader reads copyright cases');
select pg_temp.expect_rows($$select 1 from staff_copyright_cases()$$, 0, 'reader reads staff case list');
select pg_temp.expect_rows($$select 1 from orphan_candidates$$, 0, 'reader reads orphan candidates');
select pg_temp.expect_fail($$select * from cleanup_jobs$$, 'reader reads cleanup_jobs');
select pg_temp.expect_rows($$select 1 from analytics_events$$, 0, 'reader reads analytics');
select pg_temp.expect_fail($$select become_creator('c-reader', null)$$, 'become creator without terms version');
select pg_temp.expect_ok($$insert into reports (reporter_id, target_type, target_id, reason) values ('00000000-0000-0000-0000-000000000003','series','10000000-0000-0000-0000-000000000001','copyright')$$, 'reader files a report as themselves');
select pg_temp.expect_fail($$insert into reports (reporter_id, target_type, target_id, reason) values ('00000000-0000-0000-0000-000000000001','series','10000000-0000-0000-0000-000000000001','spoof')$$, 'reader files a report as someone else');

-- ───────── owner ─────────
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select pg_temp.expect_ok($$update chapters set title='Allowed title' where id='20000000-0000-0000-0000-000000000001'$$, 'owner edits chapter metadata');
select pg_temp.expect_fail($$update chapters set publication_status='published' where id='20000000-0000-0000-0000-000000000001'$$, 'owner direct publish');
-- chapters_guard coerces direct INSERTs to 'draft' (see 0005 suite): assert the outcome, not an exception (v8).
insert into chapters (series_id, chapter_number, publication_status) values ('10000000-0000-0000-0000-000000000001', 9, 'published');
do $$ begin if exists (select 1 from chapters where series_id='10000000-0000-0000-0000-000000000001' and chapter_number=9 and publication_status <> 'draft')
  then raise exception 'ASSERT FAILED: owner direct insert was not coerced to draft'; end if; end $$;
delete from chapters where series_id='10000000-0000-0000-0000-000000000001' and chapter_number=9;
select pg_temp.expect_fail($$insert into chapter_assets (chapter_id, storage_key, display_order, mime_type, processing_status) values ('20000000-0000-0000-0000-000000000001','k/x.jpg',5,'image/jpeg','ready')$$, 'owner inserts asset directly');
select pg_temp.expect_fail($$update chapter_assets set processing_status='ready' where id='30000000-0000-0000-0000-000000000001'$$, 'owner marks asset ready');
select pg_temp.expect_fail($$update series set cover_url='https://evil.example/x.jpg' where id='10000000-0000-0000-0000-000000000001'$$, 'owner sets arbitrary cover');
do $$ begin
  begin update series set view_count = 999999 where id = '10000000-0000-0000-0000-000000000001'; exception when others then null; end;
  if (select view_count from series where id = '10000000-0000-0000-0000-000000000001') = 999999 then raise exception 'owner set view_count'; end if;
end $$;
select pg_temp.expect_ok($$select publish_chapter('20000000-0000-0000-0000-000000000001')$$, 'owner publishes via RPC');
select pg_temp.expect_ok($$select unpublish_chapter('20000000-0000-0000-0000-000000000001')$$, 'owner unpublishes via RPC');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000005')$$, 'owner publishes a chapter of someone else''s series');
select pg_temp.expect_fail($$select * from cleanup_jobs$$, 'owner reads cleanup_jobs');
select pg_temp.expect_fail($$select claimant_email from copyright_cases$$, 'owner reads claimant contact');
select pg_temp.expect_rows($$select work_description from copyright_cases$$, 1, 'owner sees cases against own series');
select pg_temp.expect_ok($$select invite_contributor('10000000-0000-0000-0000-000000000001','u03','analyst')$$, 'owner invites');
select pg_temp.expect_fail($$select invite_contributor('10000000-0000-0000-0000-000000000001','u03','analyst')$$, 'duplicate open invite');
select pg_temp.expect_fail($$select invite_contributor('10000000-0000-0000-0000-000000000001','u01','editor')$$, 'owner invites self');
select pg_temp.expect_fail($$select invite_contributor('10000000-0000-0000-0000-000000000001','u03','admin')$$, 'invalid contributor role');

-- ───────── other creator ─────────
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
select pg_temp.expect_blocked($$update series set title='hijack' where id='10000000-0000-0000-0000-000000000001'$$, 'other creator edits series');
select pg_temp.expect_blocked($$update chapters set title='hijack' where id='20000000-0000-0000-0000-000000000001'$$, 'other creator edits chapter');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000001')$$, 'other creator publishes');
select pg_temp.expect_fail($$select remove_chapter_asset('30000000-0000-0000-0000-000000000001')$$, 'other creator removes asset');
select pg_temp.expect_fail($$select reorder_chapter_assets('20000000-0000-0000-0000-000000000001', array['30000000-0000-0000-0000-000000000001'::uuid])$$, 'other creator reorders');
select pg_temp.expect_rows($$select 1 from analytics_events where series_id='10000000-0000-0000-0000-000000000001'$$, 0, 'other creator reads analytics');
select pg_temp.expect_rows($$select 1 from copyright_cases$$, 0, 'other creator sees foreign cases');
select pg_temp.expect_fail($$select copyright_respond((select id from staff_copyright_cases() limit 1), 'a long enough response text here')$$, 'other creator responds to foreign case');

-- ───────── suspended and restricted creators ─────────
select pg_temp.as_user('00000000-0000-0000-0000-000000000004');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000005')$$, 'suspended creator publishes');
select pg_temp.expect_fail($$select register_chapter_assets('20000000-0000-0000-0000-000000000005','[{"type":"image/png","size":10}]')$$, 'suspended creator uploads');
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
select pg_temp.expect_fail($$select register_chapter_assets('20000000-0000-0000-0000-000000000003','[{"type":"image/png","size":10}]')$$, 'restricted creator uploads');
select pg_temp.expect_ok($$select unpublish_chapter('20000000-0000-0000-0000-000000000003')$$, 'restricted creator can still unpublish');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000003')$$, 'restricted creator republishes');

-- ───────── contributors ─────────
select pg_temp.as_user('00000000-0000-0000-0000-000000000009'); -- uploader
select pg_temp.expect_ok($$select reorder_chapter_assets('20000000-0000-0000-0000-000000000004', array['30000000-0000-0000-0000-000000000004'::uuid])$$, 'uploader reorders');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000004')$$, 'uploader publishes');
select pg_temp.expect_fail($$select unpublish_chapter('20000000-0000-0000-0000-000000000002')$$, 'uploader unpublishes');
select pg_temp.expect_blocked($$update series set title='x' where id='10000000-0000-0000-0000-000000000001'$$, 'uploader edits series settings');
select pg_temp.expect_fail($$select invite_contributor('10000000-0000-0000-0000-000000000001','u03','editor')$$, 'uploader invites');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000a'); -- analyst
select pg_temp.expect_fail($$select reorder_chapter_assets('20000000-0000-0000-0000-000000000004', array['30000000-0000-0000-0000-000000000004'::uuid])$$, 'analyst reorders');
select pg_temp.expect_rows($$select 1 from analytics_events where series_id='10000000-0000-0000-0000-000000000001'$$, 1, 'analyst reads analytics');
select pg_temp.as_user('00000000-0000-0000-0000-00000000000b'); -- invited, not accepted
select pg_temp.expect_fail($$select register_chapter_assets('20000000-0000-0000-0000-000000000004','[{"type":"image/png","size":10}]')$$, 'pending invitee uploads');
select pg_temp.expect_rows($$select 1 from chapters where id='20000000-0000-0000-0000-000000000004'$$, 0, 'pending invitee reads draft chapter');
select pg_temp.as_user('00000000-0000-0000-0000-000000000008'); -- editor
select pg_temp.expect_ok($$select publish_chapter('20000000-0000-0000-0000-000000000004')$$, 'editor publishes');
select pg_temp.expect_ok($$select unpublish_chapter('20000000-0000-0000-0000-000000000004')$$, 'editor unpublishes');
select pg_temp.as_user('00000000-0000-0000-0000-000000000001'); -- owner revokes the editor
select pg_temp.expect_ok($$select revoke_contributor((select id from contributor_permissions where user_id='00000000-0000-0000-0000-000000000008' and status='active'))$$, 'owner revokes editor');
select pg_temp.as_user('00000000-0000-0000-0000-000000000008');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000004')$$, 'revoked editor publishes');
select pg_temp.as_su();
update profiles set suspended = true where id = '00000000-0000-0000-0000-000000000009';
select pg_temp.as_user('00000000-0000-0000-0000-000000000009');
select pg_temp.expect_fail($$select reorder_chapter_assets('20000000-0000-0000-0000-000000000004', array['30000000-0000-0000-0000-000000000004'::uuid])$$, 'suspended uploader reorders');

-- ───────── moderator ─────────
select pg_temp.as_user('00000000-0000-0000-0000-000000000006');
select pg_temp.expect_fail($$select mod_set_content('chapter','20000000-0000-0000-0000-000000000002',true,'')$$, 'moderation without reason');
select pg_temp.expect_ok($$select mod_set_content('chapter','20000000-0000-0000-0000-000000000002',true,'policy violation')$$, 'moderator removes chapter');
select pg_temp.expect_blocked($$update profiles set suspended=true where id='00000000-0000-0000-0000-000000000003'$$, 'moderator suspends a user');
select pg_temp.expect_blocked($$update profiles set role='admin' where id='00000000-0000-0000-0000-000000000003'$$, 'moderator changes a role');
select pg_temp.expect_rows($$select 1 from reports$$, 2, 'moderator reads the report queue');
select pg_temp.expect_ok($$select 1 from staff_copyright_cases()$$, 'moderator lists cases');
select pg_temp.expect_fail($$select orphan_approve('some/key.jpg')$$, 'moderator approves orphan deletion');
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select pg_temp.expect_fail($$select unpublish_chapter('20000000-0000-0000-0000-000000000002')$$, 'creator touches a moderated chapter');
select pg_temp.expect_fail($$select publish_chapter('20000000-0000-0000-0000-000000000002')$$, 'creator restores a moderated chapter');
do $$ begin
  update chapters set removed_by_moderation = false where id = '20000000-0000-0000-0000-000000000002';
  if not (select removed_by_moderation from chapters where id = '20000000-0000-0000-0000-000000000002') then
    raise exception 'creator cleared removed_by_moderation';
  end if;
end $$;
select pg_temp.as_anon();
select pg_temp.expect_rows($$select 1 from chapters where id='20000000-0000-0000-0000-000000000002'$$, 0, 'removed chapter still public');

-- ───────── admin ─────────
select pg_temp.as_user('00000000-0000-0000-0000-000000000007');
select pg_temp.expect_ok($$select 1 from admin_audit_log$$, 'admin reads audit');
select pg_temp.expect_rows($$select 1 from admin_audit_log where action = 'mod_removed'$$, 1, 'moderation action was audited');
select pg_temp.expect_fail($$update admin_audit_log set action='tampered'$$, 'audit log update');
select pg_temp.expect_fail($$delete from admin_audit_log$$, 'audit log delete');
select pg_temp.expect_fail($$select orphan_approve('not/a/candidate.jpg')$$, 'approving a non-candidate');

-- the blocked updates above must not have changed anything
select pg_temp.as_su();
do $$ begin
  if exists (select 1 from profiles where id = '00000000-0000-0000-0000-000000000003' and (role::text <> 'reader' or suspended)) then
    raise exception 'a reader profile was changed by a blocked update';
  end if;
end $$;

rollback;
\echo 'QA-001 matrix: all checks passed'
