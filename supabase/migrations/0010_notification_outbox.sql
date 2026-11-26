-- 0010: notification outbox + preferences (MED-008, MED-009). Publishing no longer fans out one row per follower inside
-- the publish transaction; it records one outbox event that is delivered in batches, with retries, preferences and
-- suspended-user exclusion. Scheduled publishing also becomes safe against overlapping cron runs.

create table notification_preferences (
  user_id uuid not null references profiles on delete cascade,
  type text not null check (type in ('new_chapter','comment_reply','series_comment','new_follower')),
  enabled boolean not null default true,
  primary key (user_id, type)
);
alter table notification_preferences enable row level security;
create policy np_own on notification_preferences for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- No row means enabled.
create function notif_enabled(uid uuid, t text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from notification_preferences where user_id = uid and type = t), true) $$;
revoke execute on function notif_enabled(uuid, text) from public, anon, authenticated;

create table notification_outbox (
  id bigserial primary key,
  event_type text not null check (event_type in ('new_chapter')),
  chapter_id uuid not null references chapters on delete cascade,
  series_id uuid not null references series on delete cascade,
  actor_id uuid not null,
  state text not null default 'pending' check (state in ('pending','done','failed')),
  cursor uuid,                         -- last recipient delivered, for resumable batching
  delivered int not null default 0,
  attempts int not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (event_type, chapter_id)      -- one event per chapter, however many times it is published
);
create index notification_outbox_due on notification_outbox (next_attempt_at) where state = 'pending';
alter table notification_outbox enable row level security; -- no policies: internal
revoke all on notification_outbox from anon, authenticated;

create or replace function notify_chapter_published() returns trigger language plpgsql security definer set search_path = public as $$
declare s record;
begin
  if new.publication_status <> 'published' or (tg_op = 'UPDATE' and old.publication_status = 'published') then return null; end if;
  select id, creator_id, visibility into s from series where id = new.series_id;
  if s.visibility <> 'published' then return null; end if;
  insert into notification_outbox (event_type, chapter_id, series_id, actor_id) values ('new_chapter', new.id, s.id, s.creator_id)
  on conflict (event_type, chapter_id) do nothing;
  return null;
end $$;

-- Delivers one batch of one pending event. Returns the number of recipients handled (0 = nothing to do).
-- On error the batch rolls back, attempts/backoff are recorded, and after 8 attempts the event is marked failed (visible, replayable).
create function deliver_outbox(p_batch int default 1000) returns int language plpgsql security definer set search_path = public as $$
declare ev notification_outbox; last_u uuid; n int := 0;
begin
  select * into ev from notification_outbox where state = 'pending' and next_attempt_at <= now()
    order by id limit 1 for update skip locked;
  if not found then return 0; end if;
  begin
    with recipients as (
      select u.user_id from (
        select f.user_id from follows f where f.creator_id = ev.actor_id
        union
        select l.user_id from library l where l.series_id = ev.series_id and l.reading_status in ('reading','plan_to_read','on_hold')
      ) u
      join profiles p on p.id = u.user_id and not p.suspended
      where u.user_id <> ev.actor_id and (ev.cursor is null or u.user_id > ev.cursor) and notif_enabled(u.user_id, 'new_chapter')
      order by u.user_id limit p_batch
    ), ins as (
      insert into notifications (user_id, type, actor_id, series_id, chapter_id)
      select user_id, 'new_chapter', ev.actor_id, ev.series_id, ev.chapter_id from recipients
      on conflict do nothing returning 1
    )
    select (array_agg(user_id order by user_id desc))[1], count(*) into last_u, n from recipients;
    if n < p_batch then
      update notification_outbox set state = 'done', delivered = delivered + n, cursor = coalesce(last_u, cursor), last_error = null where id = ev.id;
    else
      update notification_outbox set delivered = delivered + n, cursor = last_u where id = ev.id;
    end if;
    return greatest(n, 1);
  exception when others then
    update notification_outbox set attempts = attempts + 1, last_error = left(sqlerrm, 300),
      state = case when attempts + 1 >= 8 then 'failed' else 'pending' end,
      next_attempt_at = now() + (least(3600, 30 * power(2, attempts)))::int * interval '1 second' where id = ev.id;
    return 1;
  end;
end $$;
revoke execute on function deliver_outbox(int) from public, anon, authenticated;
grant execute on function deliver_outbox(int) to service_role;

-- Other notification types honour preferences too.
create or replace function notify_comment() returns trigger language plpgsql security definer set search_path = public as $$
declare series_owner uuid; parent_author uuid;
begin
  if new.parent_comment_id is not null then
    select user_id into parent_author from comments where id = new.parent_comment_id;
    if parent_author is not null and parent_author <> new.user_id and notif_enabled(parent_author, 'comment_reply') then
      insert into notifications (user_id, type, actor_id, series_id, comment_id)
      values (parent_author, 'comment_reply', new.user_id, new.series_id, new.id);
    end if;
  else
    select creator_id into series_owner from series where id = new.series_id;
    if series_owner is not null and series_owner <> new.user_id and notif_enabled(series_owner, 'series_comment') then
      insert into notifications (user_id, type, actor_id, series_id, comment_id)
      values (series_owner, 'series_comment', new.user_id, new.series_id, new.id);
    end if;
  end if;
  return null;
end $$;
create or replace function notify_follow() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if notif_enabled(new.creator_id, 'new_follower') then
    insert into notifications (user_id, type, actor_id) values (new.creator_id, 'new_follower', new.user_id) on conflict do nothing;
  end if;
  return null;
end $$;

-- Scheduled publishing: skip locked rows so overlapping or late cron runs can never publish the same chapter twice.
create or replace function publish_due_chapters() returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with due as (
    select c.id from chapters c
    where c.publication_status = 'scheduled' and c.scheduled_at <= now() and not c.removed_by_moderation
      and exists (select 1 from chapter_assets a where a.chapter_id = c.id)
      and not exists (select 1 from chapter_assets a where a.chapter_id = c.id and a.processing_status <> 'ready')
    for update skip locked
  ), pub as (
    update chapters c set publication_status = 'published', published_at = now(), scheduled_at = null
    from due where c.id = due.id returning c.series_id
  ), touched as (
    update series set updated_at = now() where id in (select series_id from pub) returning 1
  )
  select count(*) into n from pub;
  return n;
end $$;

create or replace function run_scheduled_jobs() returns jsonb language plpgsql security definer set search_path = public as $$
declare published int; pruned int; expired int; delivered int := 0; r int; i int;
begin
  published := publish_due_chapters();
  expired := expire_stale_uploads();
  for i in 1..20 loop
    r := deliver_outbox(); exit when r = 0; delivered := delivered + r;
  end loop;
  delete from notifications where created_at < now() - interval '90 days';
  get diagnostics pruned = row_count;
  return jsonb_build_object('published', published, 'pruned', pruned, 'expired_uploads', expired, 'notified', delivered);
end $$;
