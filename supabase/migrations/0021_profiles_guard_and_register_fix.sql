-- 0021 — Two defects found ONLY by executing the SQL suites (v8). Both are real
-- production bugs, invisible to static review:
--
-- (1) SELF-UN-SUSPENSION: profiles_guard (0015) pinned DOB/verification columns but
--     NOT role/suspended. The profiles UPDATE policy's WITH CHECK only requires the
--     NEW suspended value to be false, so a suspended user could update their own
--     profile with suspended=false and reactivate themselves. The guard now raises
--     42501 when a non-admin client tries to CHANGE role or suspended (no-op writes
--     of the same value, and ordinary profile edits, are unaffected; admins and the
--     service role are unaffected).
--
-- (2) register_chapter_assets BROKEN SINCE 0015: the function RETURNS TABLE(id uuid, ...)
--     which makes `id` a PL/pgSQL variable; its unqualified `where id = sid` is then
--     ambiguous and EVERY call failed with "column reference id is ambiguous" —
--     chapter uploads could not register assets at all. Re-issued verbatim from 0015
--     with the series lookup qualified as `series.id = sid`.

create or replace function profiles_guard() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and not coalesce(is_admin(), false) then
    if new.role is distinct from old.role or new.suspended is distinct from old.suspended then
      raise exception 'role and suspension are managed by administrators' using errcode = '42501';
    end if;
    new.date_of_birth := old.date_of_birth;
    new.age_verification_status := old.age_verification_status;
    new.age_verification_provider := old.age_verification_provider;
    new.age_verified_at := old.age_verified_at;
    new.age_verification_expires_at := old.age_verification_expires_at;
  end if;
  return new;
end $$;

create or replace function register_chapter_assets(p_chapter uuid, p_files jsonb)
returns table (id uuid, storage_key text, display_order int, mime_type text)
language plpgsql security definer set search_path = public as $$
declare sid uuid; s_rating content_rating; key_prefix text := ''; start_ord int; n int; existing int; f jsonb; i int := 0; ext text; mt text; sz bigint;
begin
  select series_id into sid from chapters where chapters.id = p_chapter for update;
  select content_rating into s_rating from series where series.id = sid;
  if s_rating = 'mature' then key_prefix := 'restricted/'; end if;
  if sid is null or not can_upload_assets(sid) then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_files) <> 'array' then raise exception 'invalid files'; end if;
  n := jsonb_array_length(p_files);
  select count(*), coalesce(max(a.display_order) + 1, 0) into existing, start_ord from chapter_assets a where a.chapter_id = p_chapter;
  if n < 1 or existing + n > 300 then raise exception 'invalid file count'; end if;
  for f in select * from jsonb_array_elements(p_files) loop
    mt := f->>'type'; sz := (f->>'size')::bigint;
    ext := case mt when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else null end;
    if ext is null or sz is null or sz <= 0 or sz > 15 * 1024 * 1024 then raise exception 'invalid file'; end if;
    id := gen_random_uuid(); storage_key := key_prefix || sid || '/' || p_chapter || '/' || gen_random_uuid() || '.' || ext;
    display_order := start_ord + i; mime_type := mt; i := i + 1;
    insert into chapter_assets (id, chapter_id, storage_key, display_order, mime_type, file_size)
      values (register_chapter_assets.id, p_chapter, register_chapter_assets.storage_key, register_chapter_assets.display_order, mt, sz);
    return next;
  end loop;
  update chapters set publication_status = 'uploading' where chapters.id = p_chapter and publication_status = 'draft';
end $$;
