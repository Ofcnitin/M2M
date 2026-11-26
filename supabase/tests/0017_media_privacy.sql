-- Media-privacy checks for migration 0017. Run after migrations 0001-0017 on a LOCAL/STAGING db:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0017_media_privacy.sql
-- One transaction, rolled back. NOT YET EXECUTED on the build VM (no Docker/Supabase CLI /
-- Postgres there) — written in the style of supabase/tests/0015_sec007.sql, unexecuted.
begin;

-- fixtures: a creator, one mature series, one public series
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000017','mig@test.dev','{"username":"mig_creator","date_of_birth":"2000-01-01"}');
insert into creator_profiles (user_id, creator_slug, terms_accepted_at, terms_version)
  values ('00000000-0000-0000-0000-000000000017','mig-creator', now(), 'v1');
update profiles set role='creator' where id='00000000-0000-0000-0000-000000000017';

insert into series (id, creator_id, title, slug, visibility, content_rating, cover_url, banner_url) values
  ('10000000-0000-0000-0000-000000000017','00000000-0000-0000-0000-000000000017','M','mig-mature','published','mature',
   '10000000-0000-0000-0000-000000000017/cover/plain.jpg', 'restricted/10000000-0000-0000-0000-000000000017/banner/b.jpg'),
  ('10000000-0000-0000-0000-000000000018','00000000-0000-0000-0000-000000000017','P','mig-public','published','everyone',
   '10000000-0000-0000-0000-000000000018/cover/plain.jpg', null);

insert into chapters (id, series_id, title, chapter_number, publication_status) values
  ('20000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000017','C1',1,'draft'),
  ('20000000-0000-0000-0000-000000000018','10000000-0000-0000-0000-000000000018','C1',1,'draft');
insert into chapter_assets (id, chapter_id, storage_key, display_order, mime_type) values
  ('30000000-0000-0000-0000-000000000017','20000000-0000-0000-0000-000000000017',
   '10000000-0000-0000-0000-000000000017/20000000-0000-0000-0000-000000000017/page.jpg', 0, 'image/jpeg'),
  ('30000000-0000-0000-0000-000000000019','20000000-0000-0000-0000-000000000017',
   'restricted/10000000-0000-0000-0000-000000000017/20000000-0000-0000-0000-000000000017/page2.jpg', 1, 'image/jpeg'),
  ('30000000-0000-0000-0000-000000000018','20000000-0000-0000-0000-000000000018',
   '10000000-0000-0000-0000-000000000018/20000000-0000-0000-0000-000000000018/page.jpg', 0, 'image/jpeg');

-- mature series: exactly 2 violations — the ordinary-key chapter asset and the plain cover.
-- (the restricted/ chapter asset and restricted/ banner are compliant)
do $$ begin if not ((select count(*) from assert_series_media_private('10000000-0000-0000-0000-000000000017')) = 2) then raise exception 'ASSERT FAILED'; end if; end $$;
do $$ begin if not (exists (select 1 from assert_series_media_private('10000000-0000-0000-0000-000000000017')
  where asset_kind='chapter_asset' and asset_id='30000000-0000-0000-0000-000000000017')) then raise exception 'ASSERT FAILED: exists (select 1 from assert_series_media_private(''10000000-0000-0000-0000-000000000017'')
  where asset_kind=''chapter'; end if; end $$;
do $$ begin if not (exists (select 1 from assert_series_media_private('10000000-0000-0000-0000-000000000017')
  where asset_kind='cover')) then raise exception 'ASSERT FAILED: exists (select 1 from assert_series_media_private(''10000000-0000-0000-0000-000000000017'')
  where asset_kind=''cover'''; end if; end $$;

-- public series: ordinary keys are fine — no violations
do $$ begin if not ((select count(*) from assert_series_media_private('10000000-0000-0000-0000-000000000018')) = 0) then raise exception 'ASSERT FAILED'; end if; end $$;

-- after "migration" (keys rewritten to restricted/), the mature series is clean
update chapter_assets set storage_key = 'restricted/' || storage_key where id='30000000-0000-0000-0000-000000000017';
update series set cover_url = 'restricted/' || cover_url where id='10000000-0000-0000-0000-000000000017';
do $$ begin if not ((select count(*) from assert_series_media_private('10000000-0000-0000-0000-000000000017')) = 0) then raise exception 'ASSERT FAILED'; end if; end $$;

-- an http cover on a mature series is a violation (publicly reachable, not a storage key)
update series set cover_url = 'https://cdn.example.com/cover.jpg' where id='10000000-0000-0000-0000-000000000017';
do $$ begin if not (exists (select 1 from assert_series_media_private('10000000-0000-0000-0000-000000000017') where asset_kind='cover')) then raise exception 'ASSERT FAILED'; end if; end $$;

-- migration log: status check constraint + service-role-only RLS shape
insert into mature_media_migration (asset_kind, asset_id, series_id, old_key, new_key, status)
  values ('chapter_asset','30000000-0000-0000-0000-000000000017','10000000-0000-0000-0000-000000000017','a/b.jpg','restricted/a/b.jpg','db_updated');
create or replace function pg_temp.expect_fail(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'SHOULD HAVE FAILED: %', what;
end $$;
select pg_temp.expect_fail($$insert into mature_media_migration (asset_kind, series_id, status) values ('cover','10000000-0000-0000-0000-000000000017','bogus')$$, 'invalid migration status');
do $$ begin if not (select relrowsecurity from pg_class where relname='mature_media_migration') then raise exception 'ASSERT FAILED: mature_media_migration must have RLS enabled'; end if; end $$;

rollback;
