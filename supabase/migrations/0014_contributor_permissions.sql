-- 0014: contributor permissions, separate from public credits (CR-002).
-- series_contributors stays a display-only credit list. Access is granted through contributor_permissions:
--   editor   edit chapter metadata, upload/reorder/replace/remove images, publish, schedule, unpublish
--   uploader upload/reorder/replace/remove images only (cannot publish)
--   analyst  read the series analytics only
-- The series owner alone invites, revokes, creates chapters, deletes and edits series settings. Access is
-- revocable at any time and the member can leave. Suspended users and users of a suspended or restricted owner
-- lose upload/publish rights immediately (checked on every call).

create table contributor_permissions (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references series on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  role text not null check (role in ('editor','uploader','analyst')),
  status text not null default 'invited' check (status in ('invited','active','declined','revoked')),
  invited_by uuid not null references profiles on delete cascade,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz
);
create unique index contributor_open_idx on contributor_permissions (series_id, user_id) where status in ('invited','active');
create index on contributor_permissions (user_id, status);
alter table contributor_permissions enable row level security;
create policy cperm_read on contributor_permissions for select using (user_id = auth.uid() or owns_series(series_id) or is_admin());
revoke all on contributor_permissions from anon, authenticated;
grant select on contributor_permissions to authenticated; -- writes only through the functions below

create function series_member_role(sid uuid) returns text language sql stable security definer set search_path = public as $$
  select case when owns_series(sid) then 'owner' else
    (select cp.role from contributor_permissions cp join profiles p on p.id = cp.user_id
      where cp.series_id = sid and cp.user_id = auth.uid() and cp.status = 'active' and not p.suspended) end $$;

create function owner_publishing_active(sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from series s join profiles p on p.id = s.creator_id join creator_profiles c on c.user_id = p.id
    where s.id = sid and not p.suspended and c.publishing_status = 'active') $$;
create function can_edit_assets(sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(series_member_role(sid) in ('owner','editor','uploader'), false) $$;
create function can_upload_assets(sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select can_edit_assets(sid) and owner_publishing_active(sid) $$;
create function can_unpublish_chapters(sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(series_member_role(sid) in ('owner','editor'), false) $$;
create function can_publish_chapters(sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select can_unpublish_chapters(sid) and owner_publishing_active(sid) $$;
create function can_view_analytics(sid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(series_member_role(sid) in ('owner','editor','analyst'), false) $$;
revoke execute on function series_member_role(uuid), owner_publishing_active(uuid), can_edit_assets(uuid), can_upload_assets(uuid),
  can_unpublish_chapters(uuid), can_publish_chapters(uuid), can_view_analytics(uuid) from public, anon;
grant execute on function series_member_role(uuid), owner_publishing_active(uuid), can_edit_assets(uuid), can_upload_assets(uuid),
  can_unpublish_chapters(uuid), can_publish_chapters(uuid), can_view_analytics(uuid) to authenticated;

-- Members can read what they work on (including drafts) and analysts can read analytics. Read-only: writes go through RPCs.
create policy series_member_read on series for select using (series_member_role(id) is not null);
create policy ch_member_read on chapters for select using (series_member_role(series_id) is not null);
create policy ca_member_read on chapter_assets for select using (
  exists (select 1 from chapters c where c.id = chapter_id and can_edit_assets(c.series_id)));
create policy ae_member_read on analytics_events for select using (can_view_analytics(series_id));
-- Editors may update chapter metadata; chapters_guard still blocks publication and moderation fields for non-admins.
create policy ch_editor_update on chapters for update using (series_member_role(series_id) in ('owner','editor'))
  with check (series_member_role(series_id) in ('owner','editor'));

create function invite_contributor(p_series uuid, p_username text, p_role text) returns uuid
language plpgsql security definer set search_path = public as $$
declare uid uuid; pid uuid;
begin
  if not owns_series(p_series) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_role not in ('editor','uploader','analyst') then raise exception 'invalid role'; end if;
  select id into uid from profiles where username = lower(trim(p_username)) and not suspended;
  if uid is null then raise exception 'user not found'; end if;
  if uid = auth.uid() then raise exception 'you already own this series'; end if;
  if (select count(*) from contributor_permissions where series_id = p_series and status in ('invited','active')) >= 20 then
    raise exception 'too many contributors'; end if;
  insert into contributor_permissions (series_id, user_id, role, invited_by) values (p_series, uid, p_role, auth.uid()) returning id into pid;
  return pid;
end $$;

create function respond_contributor_invite(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update contributor_permissions set status = case when p_accept then 'active' else 'declined' end,
    accepted_at = case when p_accept then now() else null end
  where id = p_id and user_id = auth.uid() and status = 'invited';
  if not found then raise exception 'invitation not found'; end if;
end $$;

-- The owner can revoke anyone; a member can remove themselves.
create function revoke_contributor(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  update contributor_permissions set status = 'revoked', revoked_at = now()
  where id = p_id and status in ('invited','active') and (user_id = auth.uid() or owns_series(series_id));
  if not found then raise exception 'not found'; end if;
end $$;
revoke execute on function invite_contributor(uuid, text, text), respond_contributor_invite(uuid, boolean), revoke_contributor(uuid) from public, anon;
grant execute on function invite_contributor(uuid, text, text), respond_contributor_invite(uuid, boolean), revoke_contributor(uuid) to authenticated;

-- Permission checks in the existing RPCs now use the role helpers (bodies otherwise unchanged).
create or replace function register_chapter_assets(p_chapter uuid, p_files jsonb)
returns table (id uuid, storage_key text, display_order int, mime_type text)
language plpgsql security definer set search_path = public as $$
declare sid uuid; start_ord int; n int; existing int; f jsonb; i int := 0; ext text; mt text; sz bigint;
begin
  select series_id into sid from chapters where chapters.id = p_chapter for update;
  if sid is null or not can_upload_assets(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
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

create or replace function replace_chapter_asset(p_asset uuid, p_type text, p_size bigint)
returns table (new_key text, old_key text)
language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid; ext text; old text; nk text;
begin
  select a.chapter_id, a.storage_key into cid, old from chapter_assets a where a.id = p_asset for update;
  select series_id into sid from chapters where chapters.id = cid;
  if cid is null or not can_upload_assets(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  ext := case p_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else null end;
  if ext is null or p_size is null or p_size <= 0 or p_size > 15 * 1024 * 1024 then raise exception 'invalid file'; end if;
  nk := sid || '/' || cid || '/' || gen_random_uuid() || '.' || ext;
  update chapter_assets set storage_key = nk, mime_type = p_type, file_size = p_size,
    processing_status = 'pending', original_width = null, original_height = null where id = p_asset;
  new_key := nk; old_key := old; return next;
end $$;

create or replace function resign_chapter_asset(p_asset uuid) returns table (storage_key text, mime_type text)
language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid; st asset_status; k text; mt text;
begin
  select a.chapter_id, a.processing_status, a.storage_key, a.mime_type into cid, st, k, mt from chapter_assets a where a.id = p_asset;
  select series_id into sid from chapters where chapters.id = cid;
  if cid is null or not can_upload_assets(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  if st <> 'pending' then raise exception 'asset is not awaiting upload'; end if;
  storage_key := k; mime_type := mt; return next;
end $$;

create or replace function remove_chapter_asset(p_asset uuid) returns text
language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid; k text;
begin
  select a.chapter_id, a.storage_key into cid, k from chapter_assets a where a.id = p_asset for update;
  select series_id into sid from chapters where chapters.id = cid;
  if cid is null or not can_edit_assets(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from chapter_assets where id = p_asset;
  return k;
end $$;

create or replace function reorder_chapter_assets(p_chapter uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  select series_id into sid from chapters where id = p_chapter;
  if sid is null or not can_edit_assets(sid) then raise exception 'not allowed'; end if;
  update chapter_assets a set display_order = o.ord - 1
  from unnest(p_ids) with ordinality as o(id, ord)
  where a.id = o.id and a.chapter_id = p_chapter;
end $$;

create or replace function publish_chapter(p_chapter uuid, p_at timestamptz default null) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid; st chapter_status; total int; ready int; removed boolean; s_removed boolean; s_vis visibility;
begin
  select series_id, publication_status, removed_by_moderation into sid, st, removed
    from chapters where id = p_chapter for update;
  if sid is null or not can_publish_chapters(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
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
  if sid is null or not can_unpublish_chapters(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  if removed then raise exception 'removed by moderation'; end if;
  if st not in ('published','scheduled') then raise exception 'invalid state: %', st; end if;
  update chapters set publication_status = 'unpublished', scheduled_at = null where id = p_chapter;
end $$;
