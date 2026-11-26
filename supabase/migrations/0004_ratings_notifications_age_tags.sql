-- 0004: ratings, notifications, age confirmation, tags, scheduled publishing, moderation guards

-- ───────────────────────── Age confirmation ─────────────────────────
alter table profiles
  add column age_confirmed_at timestamptz,    -- confirmed 13+ at sign-up
  add column adult_confirmed_at timestamptz;  -- confirmed 18+ (mature content)

create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, username, display_name, age_confirmed_at, adult_confirmed_at)
  values (new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(replace(new.id::text,'-',''),1,10)),
    coalesce(new.raw_user_meta_data->>'display_name', 'New reader'),
    case when new.raw_user_meta_data->>'age_confirmed' = 'true' then now() end,
    case when new.raw_user_meta_data->>'adult_confirmed' = 'true' then now() end);
  return new;
end $$;

-- ───────────────────────── Series columns ─────────────────────────
alter table series
  add column rating_avg numeric(3,2) not null default 0,
  add column rating_count int not null default 0,
  add column rating_rank real not null default 0,          -- weighted score used for "highest rated"
  add column removed_by_moderation boolean not null default false;
alter table chapters add column removed_by_moderation boolean not null default false;

create index series_rank_idx on series (visibility, rating_rank desc);
create index series_tags_idx on series using gin (tags);

-- Stats-only updates (views, ratings) must not bump updated_at or rebuild the search vector.
-- Before this, every page view moved a series to the top of "Recently updated".
create or replace function series_before_write() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and
     (new.title, new.alternative_titles, new.synopsis, new.cover_url, new.banner_url, new.language, new.content_format,
      new.content_rating, new.publication_status, new.release_schedule, new.visibility, new.tags)
     is not distinct from
     (old.title, old.alternative_titles, old.synopsis, old.cover_url, old.banner_url, old.language, old.content_format,
      old.content_rating, old.publication_status, old.release_schedule, old.visibility, old.tags)
  then
    return new; -- keeps any updated_at the statement set explicitly (publish_chapter does)
  end if;
  new.updated_at := now();
  new.search := setweight(to_tsvector('simple', coalesce(new.title,'')), 'A')
    || setweight(to_tsvector('simple', array_to_string(new.alternative_titles,' ')), 'B')
    || setweight(to_tsvector('simple', array_to_string(new.tags,' ')), 'C')
    || setweight(to_tsvector('simple', coalesce(new.synopsis,'')), 'D');
  return new;
end $$;

-- ───────────────────────── Moderation guards ─────────────────────────
-- Creators could previously write their own view_count and undo an admin removal. Stats and the
-- moderation flag are now writable only by admins, the service role and security-definer functions.
create function series_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and not coalesce(is_admin(), false) then
    if tg_op = 'INSERT' then
      new.view_count := 0; new.rating_avg := 0; new.rating_count := 0; new.rating_rank := 0; new.removed_by_moderation := false;
    else
      new.view_count := old.view_count; new.rating_avg := old.rating_avg; new.rating_count := old.rating_count;
      new.rating_rank := old.rating_rank; new.removed_by_moderation := old.removed_by_moderation;
      if old.removed_by_moderation then new.visibility := old.visibility; end if;
    end if;
  end if;
  return new;
end $$;
create trigger series_guard before insert or update on series for each row execute function series_guard();

create function chapters_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and not coalesce(is_admin(), false) then
    if tg_op = 'INSERT' then
      new.removed_by_moderation := false;
    else
      new.removed_by_moderation := old.removed_by_moderation;
      if old.removed_by_moderation then
        new.publication_status := old.publication_status; new.scheduled_at := old.scheduled_at; new.published_at := old.published_at;
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger chapters_guard before insert or update on chapters for each row execute function chapters_guard();

create or replace function publish_chapter(p_chapter uuid, p_at timestamptz default null) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid; total int; ready int; removed boolean;
begin
  select series_id, removed_by_moderation into sid, removed from chapters where id = p_chapter;
  if sid is null or not owns_series(sid) then raise exception 'not allowed'; end if;
  if removed then raise exception 'removed by moderation'; end if;
  select count(*), count(*) filter (where processing_status = 'ready') into total, ready
    from chapter_assets where chapter_id = p_chapter;
  if total = 0 or total <> ready then raise exception 'assets not ready'; end if;
  if p_at is not null and p_at > now() then
    update chapters set publication_status = 'scheduled', scheduled_at = p_at where id = p_chapter;
  else
    update chapters set publication_status = 'published', published_at = now(), scheduled_at = null where id = p_chapter;
    update series set updated_at = now() where id = sid;
  end if;
end $$;

-- ───────────────────────── Ratings ─────────────────────────
create table ratings (
  user_id uuid not null references profiles on delete cascade,
  series_id uuid not null references series on delete cascade,
  score smallint not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, series_id)
);
create index on ratings (series_id);
alter table ratings enable row level security;

-- Individual scores are private; everyone sees only the aggregate on series.
create policy ratings_read_own on ratings for select using (user_id = auth.uid());
create policy ratings_insert on ratings for insert with check (
  user_id = auth.uid() and series_is_public(series_id) and not owns_series(series_id)
  and not exists (select 1 from profiles where id = auth.uid() and suspended));
create policy ratings_update on ratings for update using (user_id = auth.uid())
  with check (user_id = auth.uid() and not owns_series(series_id));
create policy ratings_delete on ratings for delete using (user_id = auth.uid());

create function refresh_series_rating(sid uuid) returns void language plpgsql security definer set search_path = public as $$
declare n int; a numeric;
begin
  select count(*), coalesce(avg(score), 0) into n, a from ratings where series_id = sid;
  -- Weighted rank (m = 5 votes, prior = 3.5) so a single 5-star vote cannot top "highest rated".
  update series set rating_count = n, rating_avg = round(a, 2),
    rating_rank = case when n = 0 then 0 else ((n::numeric / (n + 5)) * a + (5.0 / (n + 5)) * 3.5)::real end
  where id = sid;
end $$;
revoke all on function refresh_series_rating(uuid) from public, anon, authenticated;

create function ratings_changed() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform refresh_series_rating(coalesce(new.series_id, old.series_id));
  return null;
end $$;
create trigger ratings_after after insert or update or delete on ratings for each row execute function ratings_changed();

-- ───────────────────────── Notifications ─────────────────────────
create table notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles on delete cascade,
  type text not null check (type in ('new_chapter','comment_reply','series_comment','new_follower','content_removed')),
  actor_id uuid references profiles on delete set null,
  series_id uuid references series on delete cascade,
  chapter_id uuid references chapters on delete cascade,
  comment_id uuid references comments on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_unread_idx on notifications (user_id) where read_at is null;
-- Unpublish/republish or follow/unfollow cycles must not spam people.
create unique index notifications_chapter_once on notifications (user_id, chapter_id) where type = 'new_chapter';
create unique index notifications_follower_once on notifications (user_id, actor_id) where type = 'new_follower';

alter table notifications enable row level security;
create policy notif_read on notifications for select using (user_id = auth.uid());
create policy notif_update on notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notif_delete on notifications for delete using (user_id = auth.uid());
-- No insert policy: rows are created only by the security-definer triggers below.

create function notify_chapter_published() returns trigger language plpgsql security definer set search_path = public as $$
declare s record;
begin
  if new.publication_status <> 'published' or (tg_op = 'UPDATE' and old.publication_status = 'published') then return null; end if;
  select id, creator_id, visibility into s from series where id = new.series_id;
  if s.visibility <> 'published' then return null; end if;
  insert into notifications (user_id, type, actor_id, series_id, chapter_id)
  select u.user_id, 'new_chapter', s.creator_id, s.id, new.id
  from (
    select user_id from follows where creator_id = s.creator_id
    union
    select user_id from library where series_id = s.id and reading_status in ('reading','plan_to_read','on_hold')
  ) u
  where u.user_id <> s.creator_id
  on conflict do nothing;
  return null;
end $$;
create trigger chapters_notify after insert or update of publication_status on chapters
  for each row execute function notify_chapter_published();

create function notify_comment() returns trigger language plpgsql security definer set search_path = public as $$
declare series_owner uuid; parent_author uuid;
begin
  if new.parent_comment_id is not null then
    select user_id into parent_author from comments where id = new.parent_comment_id;
    if parent_author is not null and parent_author <> new.user_id then
      insert into notifications (user_id, type, actor_id, series_id, comment_id)
      values (parent_author, 'comment_reply', new.user_id, new.series_id, new.id);
    end if;
  else
    select creator_id into series_owner from series where id = new.series_id;
    if series_owner is not null and series_owner <> new.user_id then
      insert into notifications (user_id, type, actor_id, series_id, comment_id)
      values (series_owner, 'series_comment', new.user_id, new.series_id, new.id);
    end if;
  end if;
  return null;
end $$;
create trigger comments_notify after insert on comments for each row execute function notify_comment();

create function notify_follow() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, type, actor_id) values (new.creator_id, 'new_follower', new.user_id) on conflict do nothing;
  return null;
end $$;
create trigger follows_notify after insert on follows for each row execute function notify_follow();

create function notify_series_removed() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (user_id, type, series_id) values (new.creator_id, 'content_removed', new.id);
  return null;
end $$;
create trigger series_removed_notify after update of removed_by_moderation on series
  for each row when (new.removed_by_moderation and not old.removed_by_moderation)
  execute function notify_series_removed();

-- ───────────────────────── Tags ─────────────────────────
create function popular_tags(p_limit int default 20, p_include_mature boolean default false)
returns table (tag text, uses bigint) language sql stable security invoker as $$
  select t as tag, count(*) as uses
  from series s, unnest(s.tags) as t
  where s.visibility = 'published' and (p_include_mature or s.content_rating <> 'mature')
  group by t order by uses desc, t
  limit least(greatest(p_limit, 1), 50)
$$;

-- ───────────────────────── Scheduled jobs ─────────────────────────
-- Scheduled chapters previously never went live because nothing flipped them. The Worker's cron
-- trigger (or pg_cron) calls run_scheduled_jobs() every few minutes.
create function publish_due_chapters() returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with due as (
    update chapters c set publication_status = 'published', published_at = now(), scheduled_at = null
    where c.publication_status = 'scheduled' and c.scheduled_at <= now() and not c.removed_by_moderation
      and exists (select 1 from chapter_assets a where a.chapter_id = c.id)
      and not exists (select 1 from chapter_assets a where a.chapter_id = c.id and a.processing_status <> 'ready')
    returning c.series_id
  ), touched as (
    update series set updated_at = now() where id in (select series_id from due) returning 1
  )
  select count(*) into n from due;
  return n;
end $$;

create function run_scheduled_jobs() returns jsonb language plpgsql security definer set search_path = public as $$
declare published int; pruned int;
begin
  published := publish_due_chapters();
  delete from notifications where created_at < now() - interval '90 days';
  get diagnostics pruned = row_count;
  return jsonb_build_object('published', published, 'pruned', pruned);
end $$;

revoke all on function publish_due_chapters() from public, anon, authenticated;
revoke all on function run_scheduled_jobs() from public, anon, authenticated;
grant execute on function run_scheduled_jobs() to service_role;
grant execute on function publish_due_chapters() to service_role;

-- Optional alternative to the Worker cron, if pg_cron is enabled on your project:
--   select cron.schedule('m2m-scheduled', '*/5 * * * *', $$select run_scheduled_jobs()$$);
