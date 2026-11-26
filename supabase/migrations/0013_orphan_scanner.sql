-- 0013: orphan-object scanner (MED-002). The Worker lists R2 keys and records those no database row references
-- as candidates. Nothing is deleted by the scan: an admin must approve a candidate, and only objects older than
-- the retention age can be approved. Pending uploads already have chapter_assets rows, so they count as referenced. Approval queues a normal cleanup job (grace period, re-check, audit).
create table orphan_candidates (
  object_key text primary key,
  size_bytes bigint not null,
  uploaded_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  state text not null default 'candidate' check (state in ('candidate','approved','resolved')),
  approved_by uuid references profiles on delete set null,
  approved_at timestamptz
);
alter table orphan_candidates enable row level security;
create policy orphan_admin_read on orphan_candidates for select using (is_admin());
revoke all on orphan_candidates from anon, authenticated;
grant select on orphan_candidates to authenticated;

-- Worker (service role): from a page of listed keys, returns those that are unreferenced and not already queued.
create function orphan_filter(p_keys text[]) returns setof text language sql stable security definer set search_path = public as $$
  select k from unnest(p_keys) k
  where not exists (select 1 from chapter_assets where storage_key = k)
    and not exists (select 1 from series where cover_url = k or banner_url = k)
    and not exists (select 1 from cleanup_jobs where object_key = k and state = 'pending') $$;
revoke execute on function orphan_filter(text[]) from public, anon, authenticated;
grant execute on function orphan_filter(text[]) to service_role;

create function orphan_record(p_key text, p_size bigint, p_uploaded timestamptz) returns void language sql security definer set search_path = public as $$
  insert into orphan_candidates (object_key, size_bytes, uploaded_at) values (p_key, p_size, p_uploaded)
  on conflict (object_key) do update set last_seen_at = now(), size_bytes = excluded.size_bytes $$;
revoke execute on function orphan_record(text, bigint, timestamptz) from public, anon, authenticated;
grant execute on function orphan_record(text, bigint, timestamptz) to service_role;

-- Keys that became referenced again, or that vanished from R2, stop being candidates.
create function orphan_resolve(p_keys text[]) returns int language sql security definer set search_path = public as $$
  with u as (update orphan_candidates set state = 'resolved' where object_key = any(p_keys) and state = 'candidate' returning 1) select count(*)::int from u $$;
revoke execute on function orphan_resolve(text[]) from public, anon, authenticated;
grant execute on function orphan_resolve(text[]) to service_role;

create function orphan_approve(p_key text, p_min_age_days int default 7) returns void language plpgsql security definer set search_path = public as $$
declare c orphan_candidates;
begin
  if not is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from orphan_candidates where object_key = p_key and state = 'candidate' for update;
  if not found then raise exception 'not a candidate'; end if;
  if c.uploaded_at > now() - make_interval(days => greatest(p_min_age_days, 7)) then raise exception 'object is too recent to delete'; end if;
  if cleanup_is_referenced(p_key) then raise exception 'object is referenced'; end if;
  update orphan_candidates set state = 'approved', approved_by = auth.uid(), approved_at = now() where object_key = p_key;
  perform _queue_cleanup(p_key, 'orphan_approved');
  perform _audit('orphan_approved', 'r2_object', p_key, jsonb_build_object('size', c.size_bytes));
end $$;
revoke execute on function orphan_approve(text, int) from public, anon;
grant execute on function orphan_approve(text, int) to authenticated;
