-- Likes
create table likes (
  user_id uuid references profiles on delete cascade,
  target_type text check (target_type in ('series','comment')),
  target_id uuid,
  created_at timestamptz not null default now(),
  primary key (user_id, target_type, target_id)
);
create index on likes (target_type, target_id);
alter table likes enable row level security;
create policy likes_read on likes for select using (true);
create policy likes_insert on likes for insert with check (user_id = auth.uid());
create policy likes_delete on likes for delete using (user_id = auth.uid());

-- Suspended users cannot comment
drop policy comments_insert on comments;
create policy comments_insert on comments for insert with check (
  user_id = auth.uid() and series_is_public(series_id)
  and not exists (select 1 from profiles where id = auth.uid() and suspended));

-- Keep series.view_count in step with series_view events
create function bump_view_count() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.event_type = 'series_view' then update series set view_count = view_count + 1 where id = new.series_id; end if;
  return new;
end $$;
create trigger analytics_bump after insert on analytics_events for each row execute function bump_view_count();

-- Creator analytics for a date range. security invoker, so RLS limits it to the caller's own series.
create function creator_analytics(p_days int default 30) returns jsonb
language sql stable security invoker as $$
with rng as (select least(greatest(p_days, 1), 365) as n),
ev as (
  select e.* from analytics_events e join series s on s.id = e.series_id, rng
  where s.creator_id = auth.uid() and e.created_at >= now() - make_interval(days => rng.n)
),
days as (select d::date as day from rng, generate_series((now() - make_interval(days => rng.n))::date, now()::date, interval '1 day') d)
select jsonb_build_object(
  'series_views', (select count(*) from ev where event_type = 'series_view'),
  'chapter_views', (select count(*) from ev where event_type = 'chapter_view'),
  'completions', (select count(*) from ev where event_type = 'chapter_complete'),
  'unique_readers', (select count(distinct user_id) from ev where user_id is not null),
  'followers', (select count(*) from follows where creator_id = auth.uid()),
  'comments', (select count(*) from comments c join series s on s.id = c.series_id, rng where s.creator_id = auth.uid() and c.created_at >= now() - make_interval(days => rng.n)),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'views', coalesce(c.n, 0)) order by d.day), '[]'::jsonb)
            from days d left join (select created_at::date as day, count(*) n from ev where event_type in ('series_view','chapter_view') group by 1) c on c.day = d.day),
  'top_chapters', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
      select ch.id, s.title as series, ch.chapter_number, count(*) as views
      from ev join chapters ch on ch.id = ev.chapter_id join series s on s.id = ch.series_id
      where ev.event_type = 'chapter_view' group by 1, 2, 3 order by views desc limit 5) t)
);
$$;
