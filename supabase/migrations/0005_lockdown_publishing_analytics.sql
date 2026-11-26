-- 0005: close the publishing / asset / analytics bypasses found in the audit (SEC-001..004, SEC-008).
-- Forward-only. Security-definer functions run as the owning role, so the guards below
-- (which only apply to current_user in ('authenticated','anon')) never block them or the service role.

-- ───────────── 1. chapters: creators can no longer write publication state ─────────────
create or replace function chapters_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and not coalesce(is_admin(), false) then
    if tg_op = 'INSERT' then
      new.removed_by_moderation := false;
      new.publication_status := 'draft'; new.published_at := null; new.scheduled_at := null;
    else
      new.removed_by_moderation := old.removed_by_moderation;
      if new.publication_status is distinct from old.publication_status
         or new.published_at is distinct from old.published_at
         or new.scheduled_at is distinct from old.scheduled_at then
        raise exception 'publication state is managed by publish_chapter / unpublish_chapter' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;

-- ───────────── 2. chapter_assets: no direct creator writes ─────────────
-- Reads stay available through ca_read. All writes go through the RPCs below or the service role.
drop policy if exists ca_write on chapter_assets;
revoke insert, update, delete on chapter_assets from anon, authenticated;

create or replace function _creator_can_publish() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p join creator_profiles c on c.user_id = p.id
    where p.id = auth.uid() and p.role in ('creator','admin') and not p.suspended and c.publishing_status = 'active') $$;

-- Register upload slots. Storage keys are generated here, never supplied by the client.
create or replace function register_chapter_assets(p_chapter uuid, p_files jsonb)
returns table (id uuid, storage_key text, display_order int, mime_type text)
language plpgsql security definer set search_path = public as $$
declare sid uuid; start_ord int; n int; existing int; f jsonb; i int := 0; ext text; mt text; sz bigint;
begin
  select series_id into sid from chapters where chapters.id = p_chapter for update;
  if sid is null or not owns_series(sid) or not _creator_can_publish() then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_files) <> 'array' then raise exception 'invalid files'; end if;
  n := jsonb_array_length(p_files);
  select count(*), coalesce(max(a.display_order) + 1, 0) into existing, start_ord from chapter_assets a where a.chapter_id = p_chapter;
  if n < 1 or existing + n > 300 then raise exception 'invalid file count'; end if;
  for f in select * from jsonb_array_elements(p_files) loop
    mt := f->>'type'; sz := (f->>'size')::bigint;
    ext := case mt when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else null end;
    if ext is null or sz is null or sz <= 0 or sz > 15 * 1024 * 1024 then raise exception 'invalid file'; end if;
    id := gen_random_uuid(); storage_key := sid || '/' || p_chapter || '/' || gen_random_uuid() || '.' || ext;
    display_order := start_ord + i; mime_type := mt; i := i + 1;
    insert into chapter_assets (id, chapter_id, storage_key, display_order, mime_type, file_size)
      values (register_chapter_assets.id, p_chapter, register_chapter_assets.storage_key, register_chapter_assets.display_order, mt, sz);
    return next;
  end loop;
  update chapters set publication_status = 'uploading' where chapters.id = p_chapter and publication_status = 'draft';
end $$;

-- Replace one image in place. Returns the old key so the caller can delete the old object.
create or replace function replace_chapter_asset(p_asset uuid, p_type text, p_size bigint)
returns table (new_key text, old_key text)
language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid; ext text; old text; nk text;
begin
  select a.chapter_id, a.storage_key into cid, old from chapter_assets a where a.id = p_asset for update;
  select series_id into sid from chapters where chapters.id = cid;
  if cid is null or not owns_series(sid) or not _creator_can_publish() then raise exception 'not allowed' using errcode = '42501'; end if;
  ext := case p_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else null end;
  if ext is null or p_size is null or p_size <= 0 or p_size > 15 * 1024 * 1024 then raise exception 'invalid file'; end if;
  nk := sid || '/' || cid || '/' || gen_random_uuid() || '.' || ext;
  update chapter_assets set storage_key = nk, mime_type = p_type, file_size = p_size,
    processing_status = 'pending', original_width = null, original_height = null where id = p_asset;
  new_key := nk; old_key := old; return next;
end $$;

create or replace function remove_chapter_asset(p_asset uuid) returns text
language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid; k text;
begin
  select a.chapter_id, a.storage_key into cid, k from chapter_assets a where a.id = p_asset for update;
  select series_id into sid from chapters where chapters.id = cid;
  if cid is null or not owns_series(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from chapter_assets where id = p_asset;
  return k;
end $$;

-- ───────────── 3. publish / unpublish: the only creator routes to publication state ─────────────
create or replace function publish_chapter(p_chapter uuid, p_at timestamptz default null) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid; st chapter_status; total int; ready int; removed boolean; s_removed boolean; s_vis visibility;
begin
  select series_id, publication_status, removed_by_moderation into sid, st, removed
    from chapters where id = p_chapter for update;
  if sid is null or not owns_series(sid) or not _creator_can_publish() then raise exception 'not allowed' using errcode = '42501'; end if;
  if removed then raise exception 'removed by moderation'; end if;
  select removed_by_moderation, visibility into s_removed, s_vis from series where id = sid;
  if s_removed or s_vis = 'archived' then raise exception 'series not publishable'; end if;
  if st not in ('draft','uploading','processing','unpublished','scheduled') then raise exception 'invalid state: %', st; end if;
  -- lock the asset set so none can be replaced or removed between validation and publication
  perform 1 from chapter_assets where chapter_id = p_chapter for update;
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

create or replace function unpublish_chapter(p_chapter uuid) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid; st chapter_status; removed boolean;
begin
  select series_id, publication_status, removed_by_moderation into sid, st, removed from chapters where id = p_chapter for update;
  if sid is null or not owns_series(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  if removed then raise exception 'removed by moderation'; end if;
  if st not in ('published','scheduled') then raise exception 'invalid state: %', st; end if;
  update chapters set publication_status = 'unpublished', scheduled_at = null where id = p_chapter;
end $$;

-- ───────────── 4. analytics: server-only, validated, deduplicated ─────────────
alter table analytics_events add column if not exists visitor_key text;
create index if not exists analytics_dedup_idx on analytics_events (event_type, series_id, chapter_id, created_at desc);
drop policy if exists ae_insert on analytics_events;
revoke insert, update, delete on analytics_events from anon, authenticated;

-- Callable only by the service role (the Next.js server), which supplies a hashed visitor key.
create or replace function track_event(p_type text, p_series uuid, p_chapter uuid, p_user uuid, p_visitor text)
returns boolean language plpgsql security definer set search_path = public as $$
declare win interval; dup boolean;
begin
  if p_type not in ('series_view','chapter_view','chapter_complete') then return false; end if;
  if p_series is null or not series_is_public(p_series) then return false; end if;
  if p_type <> 'series_view' then
    if p_chapter is null or not exists (select 1 from chapters where id = p_chapter and series_id = p_series and publication_status = 'published') then return false; end if;
  else p_chapter := null; end if;
  if p_type = 'chapter_complete' and p_user is null then return false; end if;
  if p_user is null and p_visitor is null then return false; end if;
  win := case p_type when 'chapter_complete' then interval '24 hours' else interval '30 minutes' end;
  select exists (select 1 from analytics_events e
    where e.event_type = p_type and e.series_id = p_series and e.chapter_id is not distinct from p_chapter
      and e.created_at > now() - win
      and ((p_user is not null and e.user_id = p_user) or (p_visitor is not null and e.visitor_key = p_visitor))) into dup;
  if dup then return false; end if;
  insert into analytics_events (event_type, user_id, series_id, chapter_id, visitor_key) values (p_type, p_user, p_series, p_chapter, p_visitor);
  return true;
end $$;

-- ───────────── 5. function privileges ─────────────
revoke execute on function track_event(text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function track_event(text, uuid, uuid, uuid, text) to service_role;
revoke execute on function register_chapter_assets(uuid, jsonb), replace_chapter_asset(uuid, text, bigint), remove_chapter_asset(uuid),
  publish_chapter(uuid, timestamptz), unpublish_chapter(uuid), _creator_can_publish() from public, anon;
grant execute on function register_chapter_assets(uuid, jsonb), replace_chapter_asset(uuid, text, bigint), remove_chapter_asset(uuid),
  publish_chapter(uuid, timestamptz), unpublish_chapter(uuid), _creator_can_publish() to authenticated;
