-- 0009: recorded publishing-terms consent (CR-001) and an append-only admin audit trail (ADM-002).

-- Consent is recorded explicitly with the terms version; it is no longer implied by a column default.
alter table creator_profiles add column if not exists terms_version text;
alter table creator_profiles alter column terms_accepted_at drop default;

drop function if exists become_creator(text);
create function become_creator(p_slug text, p_terms_version text) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_terms_version is null or length(trim(p_terms_version)) = 0 then raise exception 'terms must be accepted'; end if;
  insert into creator_profiles (user_id, creator_slug, terms_accepted_at, terms_version) values (auth.uid(), p_slug, now(), p_terms_version);
  update profiles set role = 'creator' where id = auth.uid() and role = 'reader';
end $$;
revoke execute on function become_creator(text, text) from public, anon;
grant execute on function become_creator(text, text) to authenticated;

-- Append-only: no update or delete for anyone, including admins and the service role through the API.
create table admin_audit_log (
  id bigserial primary key,
  actor_id uuid not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on admin_audit_log (created_at desc);
create index on admin_audit_log (target_type, target_id);
alter table admin_audit_log enable row level security;
create policy audit_admin_read on admin_audit_log for select using (is_admin());
revoke all on admin_audit_log from anon, authenticated;
grant select on admin_audit_log to authenticated;
create function admin_audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'admin_audit_log is append-only'; end $$;
create trigger admin_audit_no_change before update or delete on admin_audit_log for each row execute function admin_audit_immutable();

create function _audit(a text, tt text, tid text, d jsonb) returns void language sql security definer set search_path = public as $$
  insert into admin_audit_log (actor_id, action, target_type, target_id, detail) values (auth.uid(), a, tt, tid, coalesce(d, '{}')) $$;
revoke execute on function _audit(text, text, text, jsonb) from public, anon, authenticated;

-- Triggers record every admin moderation action automatically, so no code path can forget to log one.
create function audit_series() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(is_admin(), false) and new.creator_id is distinct from auth.uid()
     and (new.removed_by_moderation is distinct from old.removed_by_moderation or new.visibility is distinct from old.visibility) then
    perform _audit(case when new.removed_by_moderation and not old.removed_by_moderation then 'series_removed'
                        when old.removed_by_moderation and not new.removed_by_moderation then 'series_restored' else 'series_visibility_changed' end,
      'series', new.id::text, jsonb_build_object('from_visibility', old.visibility, 'to_visibility', new.visibility));
  end if;
  return null;
end $$;
create trigger series_audit after update on series for each row execute function audit_series();

create function audit_chapters() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(is_admin(), false) and (new.removed_by_moderation is distinct from old.removed_by_moderation
     or (new.publication_status is distinct from old.publication_status and new.removed_by_moderation)) then
    perform _audit(case when new.removed_by_moderation and not old.removed_by_moderation then 'chapter_removed'
                        when old.removed_by_moderation and not new.removed_by_moderation then 'chapter_restored' else 'chapter_status_changed' end,
      'chapter', new.id::text, jsonb_build_object('from_status', old.publication_status, 'to_status', new.publication_status));
  end if;
  return null;
end $$;
create trigger chapters_audit after update on chapters for each row execute function audit_chapters();

create function audit_profiles() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(is_admin(), false) and new.id is distinct from auth.uid()
     and (new.suspended is distinct from old.suspended or new.role is distinct from old.role) then
    perform _audit(case when new.suspended is distinct from old.suspended then (case when new.suspended then 'user_suspended' else 'user_unsuspended' end) else 'user_role_changed' end,
      'user', new.id::text, jsonb_build_object('suspended', new.suspended, 'role', new.role));
  end if;
  return null;
end $$;
create trigger profiles_audit after update on profiles for each row execute function audit_profiles();

create function audit_comments() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(is_admin(), false) and old.user_id is distinct from auth.uid() then
    perform _audit('comment_removed', 'comment', old.id::text, jsonb_build_object('author', old.user_id, 'series', old.series_id));
  end if;
  return null;
end $$;
create trigger comments_audit after delete on comments for each row execute function audit_comments();
