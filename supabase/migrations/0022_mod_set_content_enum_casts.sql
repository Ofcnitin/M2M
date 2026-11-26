-- 0022 — mod_set_content() has been broken since 0012 (found by executing qa001, v8).
--
-- Its UPDATEs assign CASE expressions (typed text) to the enum columns
-- series.visibility and chapters.publication_status. Postgres does not implicitly
-- cast a text CASE result to an enum, so every moderator remove/restore of a series
-- or chapter failed with "column is of type chapter_status/visibility but
-- expression is of type text". Re-issued verbatim from 0012 with explicit casts.

create or replace function mod_set_content(p_type text, p_target uuid, p_remove boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required'; end if;
  if p_type = 'series' then
    update series set removed_by_moderation = p_remove,
      visibility = case when p_remove then 'archived'::visibility else 'published'::visibility end where id = p_target;
  elsif p_type = 'chapter' then
    update chapters set removed_by_moderation = p_remove,
      publication_status = case when p_remove then 'unpublished'::chapter_status else 'published'::chapter_status end where id = p_target;
  elsif p_type = 'comment' then
    if not p_remove then raise exception 'comments cannot be restored'; end if;
    delete from comments where id = p_target;
  else raise exception 'invalid target type'; end if;
  if not found then raise exception 'target not found'; end if;
  perform _audit(case when p_remove then 'mod_removed' else 'mod_restored' end, p_type, p_target::text,
    jsonb_build_object('reason', left(p_reason, 500), 'actor_role', (select role::text from profiles where id = auth.uid())));
end $$;
revoke execute on function mod_set_content(text, uuid, boolean, text) from public, anon;
grant execute on function mod_set_content(text, uuid, boolean, text) to authenticated;
