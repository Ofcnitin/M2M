-- 0007: durable R2 cleanup (MED-001). Object keys are captured by triggers at the moment rows are deleted or
-- re-pointed, so cleanup intent survives cascades and request failures. The Worker cron drains the queue.
create table cleanup_jobs (
  id bigserial primary key,
  object_key text not null,
  reason text not null,
  state text not null default 'pending' check (state in ('pending','done')),
  attempts int not null default 0,
  last_error text,
  not_before timestamptz not null default now() + interval '10 minutes', -- grace period before any deletion
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create unique index cleanup_jobs_pending_key on cleanup_jobs (object_key) where state = 'pending';
create index cleanup_jobs_due on cleanup_jobs (next_attempt_at) where state = 'pending';
alter table cleanup_jobs enable row level security; -- no policies: service role and security-definer triggers only
revoke all on cleanup_jobs from anon, authenticated;

create or replace function _queue_cleanup(k text, why text) returns void language sql security definer set search_path = public as $$
  insert into cleanup_jobs (object_key, reason) select k, why where k is not null and k <> ''
  on conflict (object_key) where state = 'pending' do nothing $$;

create function cleanup_on_asset_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform _queue_cleanup(old.storage_key, 'asset_deleted');
  elsif old.storage_key is distinct from new.storage_key then perform _queue_cleanup(old.storage_key, 'asset_replaced'); end if;
  return null;
end $$;
create trigger chapter_assets_cleanup after update of storage_key or delete on chapter_assets
  for each row execute function cleanup_on_asset_change();

create function cleanup_on_series_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform _queue_cleanup(old.cover_url, 'series_deleted'); perform _queue_cleanup(old.banner_url, 'series_deleted');
  else
    if old.cover_url is distinct from new.cover_url then perform _queue_cleanup(old.cover_url, 'cover_replaced'); end if;
    if old.banner_url is distinct from new.banner_url then perform _queue_cleanup(old.banner_url, 'banner_replaced'); end if;
  end if;
  return null;
end $$;
create trigger series_cleanup after update of cover_url, banner_url or delete on series
  for each row execute function cleanup_on_series_change();

-- Worker bookkeeping, service role only.
create function cleanup_due(p_limit int default 100) returns setof cleanup_jobs language sql security definer set search_path = public as $$
  select * from cleanup_jobs where state = 'pending' and not_before <= now() and next_attempt_at <= now()
  order by id limit p_limit $$;
create function cleanup_is_referenced(k text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from chapter_assets where storage_key = k) or exists (select 1 from series where cover_url = k or banner_url = k) $$;
create function cleanup_finish(p_id bigint, p_error text default null) returns void language sql security definer set search_path = public as $$
  update cleanup_jobs set
    state = case when p_error is null then 'done' else state end,
    done_at = case when p_error is null then now() else null end,
    attempts = attempts + case when p_error is null then 0 else 1 end,
    last_error = p_error,
    next_attempt_at = now() + (least(3600, 30 * power(2, least(attempts, 7)))::int || ' seconds')::interval
  where id = p_id $$;
create function cleanup_prune() returns int language plpgsql security definer set search_path = public as $$
declare n int; begin
  delete from cleanup_jobs where state = 'done' and done_at < now() - interval '7 days'; get diagnostics n = row_count; return n; end $$;

revoke execute on function cleanup_due(int), cleanup_is_referenced(text), cleanup_finish(bigint, text), cleanup_prune(), _queue_cleanup(text, text)
  from public, anon, authenticated;
grant execute on function cleanup_due(int), cleanup_is_referenced(text), cleanup_finish(bigint, text), cleanup_prune() to service_role;
