-- 0012: moderator role split (ADM-001), moderation RPCs with reasons (ADM-003) and the
-- copyright case / creator response / appeal workflow (ADM-004).
-- Legal wording, deadlines and jurisdiction rules are a product/counsel decision; the
-- deadline below is a configurable default, not legal advice.

-- 'moderator' is a new enum value. It cannot be used in the same transaction that adds it,
-- so every check below compares role::text instead of the literal enum member.
alter type user_role add value if not exists 'moderator';

create function is_moderator() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and role::text = 'moderator' and not suspended) $$;
create function is_staff() returns boolean language sql stable security definer set search_path = public as
$$ select is_admin() or is_moderator() $$;
revoke execute on function is_moderator(), is_staff() from public, anon;
grant execute on function is_moderator(), is_staff() to authenticated;

-- Moderators work the report queue; only admins change roles, suspend users or edit genres.
create policy reports_staff on reports for all using (is_staff());

-- Every moderation action needs a reason and is written to the append-only audit log.
create function mod_set_content(p_type text, p_target uuid, p_remove boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'reason required'; end if;
  if p_type = 'series' then
    update series set removed_by_moderation = p_remove,
      visibility = case when p_remove then 'archived' else 'published' end where id = p_target;
  elsif p_type = 'chapter' then
    update chapters set removed_by_moderation = p_remove,
      publication_status = case when p_remove then 'unpublished' else 'published' end where id = p_target;
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

-- ---------------------------------------------------------------- copyright cases
create table copyright_cases (
  id uuid primary key default gen_random_uuid(),
  claimant_name text not null check (length(claimant_name) between 2 and 200),
  claimant_email text not null check (claimant_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  claimant_org text,
  work_description text not null check (length(work_description) between 10 and 4000),
  target_urls text[] not null check (cardinality(target_urls) between 1 and 20),
  series_id uuid references series on delete set null,
  chapter_id uuid references chapters on delete set null,
  ownership_statement boolean not null,
  good_faith_statement boolean not null,
  signature text not null check (length(signature) between 2 and 200),
  status text not null default 'received'
    check (status in ('received','reviewing','content_removed','creator_responded','reinstated','rejected','closed')),
  received_at timestamptz not null default now(),
  creator_response_due_at timestamptz,
  creator_response text,
  creator_responded_at timestamptz,
  decision_reason text,
  decided_by uuid references profiles on delete set null,
  decided_at timestamptz,
  check (ownership_statement and good_faith_statement)
);
create index on copyright_cases (status, received_at desc);
create index on copyright_cases (series_id);
alter table copyright_cases enable row level security;

create policy cc_staff on copyright_cases for select using (is_staff());
-- Creators see cases against their own series, but never the claimant's contact details (column grants below).
create policy cc_creator on copyright_cases for select using (series_id is not null and owns_series(series_id));

revoke all on copyright_cases from anon, authenticated;
grant select (id, work_description, target_urls, series_id, chapter_id, status, received_at,
              creator_response_due_at, creator_response, creator_responded_at, decision_reason, decided_at)
  on copyright_cases to authenticated;
-- Staff read the full row through this function instead of a broad column grant.
create function staff_copyright_cases() returns setof copyright_cases language sql stable security definer set search_path = public as
$$ select * from copyright_cases where is_staff() order by received_at desc limit 200 $$;
revoke execute on function staff_copyright_cases() from public, anon;
grant execute on function staff_copyright_cases() to authenticated;

-- Public submission. Called only from the Next.js server (service role) so it can be rate limited there.
create function submit_copyright_claim(
  p_name text, p_email text, p_org text, p_work text, p_urls text[], p_series uuid, p_chapter uuid,
  p_owner boolean, p_good_faith boolean, p_signature text
) returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid := p_series;
begin
  if not (coalesce(p_owner, false) and coalesce(p_good_faith, false)) then
    raise exception 'both declarations are required'; end if;
  if p_chapter is not null and sid is null then select series_id into sid from chapters where id = p_chapter; end if;
  insert into copyright_cases (claimant_name, claimant_email, claimant_org, work_description, target_urls, series_id, chapter_id,
    ownership_statement, good_faith_statement, signature)
  values (trim(p_name), trim(p_email), nullif(trim(p_org), ''), trim(p_work), p_urls, sid, p_chapter, p_owner, p_good_faith, trim(p_signature))
  returning id into cid;
  return cid;
end $$;
revoke execute on function submit_copyright_claim(text, text, text, text, text[], uuid, uuid, boolean, boolean, text) from public, anon, authenticated;
grant execute on function submit_copyright_claim(text, text, text, text, text[], uuid, uuid, boolean, boolean, text) to service_role;

-- Staff start review. Optionally take the content down immediately and give the creator a response window.
create function copyright_review(p_case uuid, p_takedown boolean, p_response_days int default 10)
returns void language plpgsql security definer set search_path = public as $$
declare c copyright_cases;
begin
  if not is_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from copyright_cases where id = p_case for update;
  if not found then raise exception 'case not found'; end if;
  if c.status not in ('received','reviewing') then raise exception 'case is already %', c.status; end if;
  if p_takedown then
    if c.chapter_id is not null then perform mod_set_content('chapter', c.chapter_id, true, 'copyright case ' || p_case);
    elsif c.series_id is not null then perform mod_set_content('series', c.series_id, true, 'copyright case ' || p_case);
    else raise exception 'case has no resolvable target'; end if;
  end if;
  update copyright_cases set status = case when p_takedown then 'content_removed' else 'reviewing' end,
    creator_response_due_at = now() + make_interval(days => greatest(1, least(p_response_days, 60)))
  where id = p_case;
  perform _audit('copyright_review', 'copyright_case', p_case::text, jsonb_build_object('takedown', p_takedown));
end $$;
revoke execute on function copyright_review(uuid, boolean, int) from public, anon;
grant execute on function copyright_review(uuid, boolean, int) to authenticated;

-- Creator response / appeal. Only the owner of the targeted series, only while a response is open.
create function copyright_respond(p_case uuid, p_response text) returns void language plpgsql security definer set search_path = public as $$
declare c copyright_cases;
begin
  if auth.uid() is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_response is null or length(trim(p_response)) < 20 or length(p_response) > 4000 then
    raise exception 'response must be 20 to 4000 characters'; end if;
  select * into c from copyright_cases where id = p_case for update;
  if not found or c.series_id is null or not owns_series(c.series_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if c.status not in ('reviewing','content_removed') then raise exception 'case is not open for a response'; end if;
  update copyright_cases set creator_response = trim(p_response), creator_responded_at = now(), status = 'creator_responded' where id = p_case;
  perform _audit('copyright_creator_response', 'copyright_case', p_case::text, '{}');
end $$;
revoke execute on function copyright_respond(uuid, text) from public, anon;
grant execute on function copyright_respond(uuid, text) to authenticated;

-- Final decision. Reinstating needs a reason; removal stays in force when the claim is upheld.
create function copyright_decide(p_case uuid, p_outcome text, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare c copyright_cases;
begin
  if not is_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_outcome not in ('uphold','reinstate','reject') then raise exception 'invalid outcome'; end if;
  if p_reason is null or length(trim(p_reason)) < 10 then raise exception 'reasoned decision required'; end if;
  select * into c from copyright_cases where id = p_case for update;
  if not found then raise exception 'case not found'; end if;
  if c.status in ('reinstated','rejected','closed') then raise exception 'case already decided'; end if;
  if p_outcome = 'uphold' then
    if c.chapter_id is not null then perform mod_set_content('chapter', c.chapter_id, true, 'copyright upheld ' || p_case);
    elsif c.series_id is not null then perform mod_set_content('series', c.series_id, true, 'copyright upheld ' || p_case); end if;
  elsif p_outcome = 'reinstate' then
    if c.chapter_id is not null then perform mod_set_content('chapter', c.chapter_id, false, 'copyright reinstated ' || p_case);
    elsif c.series_id is not null then perform mod_set_content('series', c.series_id, false, 'copyright reinstated ' || p_case); end if;
  end if;
  update copyright_cases set status = case p_outcome when 'reinstate' then 'reinstated' when 'reject' then 'rejected' else 'closed' end,
    decision_reason = trim(p_reason), decided_by = auth.uid(), decided_at = now() where id = p_case;
  perform _audit('copyright_decision', 'copyright_case', p_case::text, jsonb_build_object('outcome', p_outcome));
end $$;
revoke execute on function copyright_decide(uuid, text, text) from public, anon;
grant execute on function copyright_decide(uuid, text, text) to authenticated;
