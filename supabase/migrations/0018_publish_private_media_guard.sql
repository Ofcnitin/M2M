-- 0018 — Publish-time private-media guard (SEC-007 v8, directive §3.7).
--
-- Delivery (0017/v8 routes) already rejects mature assets whose storage_key is not under
-- `restricted/`. This migration closes the other end: a mature chapter whose assets include
-- ANY missing/non-restricted key (e.g. legacy assets minted before 0015 added the prefix)
-- cannot be published or scheduled at all, and the scheduled-publishing sweep skips such
-- chapters instead of publishing them. Run scripts/migrate-mature-media.mjs to fix the keys.
--
-- publish_chapter() is re-issued verbatim from 0014 with ONE added guard;
-- publish_due_chapters() is re-issued verbatim from 0010 with ONE added exclusion.

create or replace function publish_chapter(p_chapter uuid, p_at timestamptz default null) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid; st chapter_status; total int; ready int; removed boolean; s_removed boolean; s_vis visibility; s_rating content_rating;
begin
  select series_id, publication_status, removed_by_moderation into sid, st, removed
    from chapters where id = p_chapter for update;
  if sid is null or not can_publish_chapters(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  if removed then raise exception 'removed by moderation'; end if;
  select removed_by_moderation, visibility, content_rating into s_removed, s_vis, s_rating from series where id = sid;
  if s_removed or s_vis = 'archived' then raise exception 'series not publishable'; end if;
  if st not in ('draft','uploading','processing','unpublished','scheduled') then raise exception 'invalid state: %', st; end if;
  -- lock the asset set so none can be replaced or removed between validation and publication
  perform 1 from chapter_assets where chapter_id = p_chapter for update;
  select count(*), count(*) filter (where processing_status = 'ready') into total, ready
    from chapter_assets where chapter_id = p_chapter;
  if total = 0 or total <> ready then raise exception 'assets not ready'; end if;
  -- v8 guard: mature chapters may only publish when every asset lives in private storage.
  if s_rating = 'mature' and exists (
    select 1 from chapter_assets a where a.chapter_id = p_chapter
      and (a.storage_key is null or a.storage_key not like 'restricted/%')
  ) then raise exception 'mature assets must use private (restricted/) storage; run the media migration' using errcode = '42501'; end if;
  if p_at is not null and p_at > now() then
    update chapters set publication_status = 'scheduled', scheduled_at = p_at where id = p_chapter;
  else
    update chapters set publication_status = 'published', published_at = now(), scheduled_at = null where id = p_chapter;
    update series set updated_at = now() where id = sid;
  end if;
end $$;

create or replace function publish_due_chapters() returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with due as (
    select c.id from chapters c
    where c.publication_status = 'scheduled' and c.scheduled_at <= now() and not c.removed_by_moderation
      and exists (select 1 from chapter_assets a where a.chapter_id = c.id)
      and not exists (select 1 from chapter_assets a where a.chapter_id = c.id and a.processing_status <> 'ready')
      -- v8 guard: never auto-publish a mature chapter with non-private assets.
      and not exists (
        select 1 from series s join chapter_assets a on a.chapter_id = c.id
        where s.id = c.series_id and s.content_rating = 'mature'
          and (a.storage_key is null or a.storage_key not like 'restricted/%')
      )
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
