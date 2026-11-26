-- 0008: upload recovery (MED-006). Same-key re-signing for retries, and expiry of upload slots that never completed.
alter table chapter_assets add column if not exists created_at timestamptz not null default now();

-- Returns the already-issued key for a still-pending asset so the caller can sign a fresh URL. Same asset, no duplicates.
create or replace function resign_chapter_asset(p_asset uuid) returns table (storage_key text, mime_type text)
language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid; st asset_status; k text; mt text;
begin
  select a.chapter_id, a.processing_status, a.storage_key, a.mime_type into cid, st, k, mt from chapter_assets a where a.id = p_asset;
  select series_id into sid from chapters where chapters.id = cid;
  if cid is null or not owns_series(sid) or not _creator_can_publish() then raise exception 'not allowed' using errcode = '42501'; end if;
  if st <> 'pending' then raise exception 'asset is not awaiting upload'; end if;
  storage_key := k; mime_type := mt; return next;
end $$;
revoke execute on function resign_chapter_asset(uuid) from public, anon;
grant execute on function resign_chapter_asset(uuid) to authenticated;

-- Slots whose upload never arrived are failed (visible to the creator) and their keys queued for cleanup.
create or replace function expire_stale_uploads() returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in
    update chapter_assets set processing_status = 'failed'
    where processing_status = 'pending' and created_at < now() - interval '2 hours'
    returning storage_key, chapter_id
  loop
    perform _queue_cleanup(r.storage_key, 'upload_expired');
    update chapters set publication_status = 'failed'
      where id = r.chapter_id and publication_status in ('uploading','processing');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function expire_stale_uploads() from public, anon, authenticated;
grant execute on function expire_stale_uploads() to service_role;

create or replace function run_scheduled_jobs() returns jsonb language plpgsql security definer set search_path = public as $$
declare published int; pruned int; expired int;
begin
  published := publish_due_chapters();
  expired := expire_stale_uploads();
  delete from notifications where created_at < now() - interval '90 days';
  get diagnostics pruned = row_count;
  return jsonb_build_object('published', published, 'pruned', pruned, 'expired_uploads', expired);
end $$;
