-- Atomic reorder: one statement, so the unique (chapter_id, display_order) constraint never trips.
create function reorder_chapter_assets(p_chapter uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  select series_id into sid from chapters where id = p_chapter;
  if sid is null or not owns_series(sid) then raise exception 'not allowed'; end if;
  update chapter_assets a set display_order = o.ord - 1
  from unnest(p_ids) with ordinality as o(id, ord)
  where a.id = o.id and a.chapter_id = p_chapter;
end $$;
