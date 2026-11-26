-- M2M core schema, RLS and publishing functions
create extension if not exists pgcrypto;

create type user_role as enum ('reader','creator','admin');
create type content_format as enum ('manhwa','manga','webtoon','western','other');
create type content_rating as enum ('everyone','teen','mature');
create type pub_status as enum ('ongoing','completed','hiatus','cancelled');
create type visibility as enum ('draft','published','unlisted','archived');
create type chapter_status as enum ('draft','uploading','processing','scheduled','published','unpublished','failed');
create type reading_mode as enum ('vertical','page_ltr','page_rtl');
create type asset_status as enum ('pending','processing','ready','failed');
create type library_status as enum ('reading','plan_to_read','completed','on_hold','dropped');
create type report_status as enum ('open','reviewing','actioned','dismissed','appealed');

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_]{3,30}$'),
  display_name text not null,
  avatar_url text,
  biography text,
  role user_role not null default 'reader',
  suspended boolean not null default false,
  created_at timestamptz not null default now()
);

create table creator_profiles (
  user_id uuid primary key references profiles on delete cascade,
  creator_slug text unique not null,
  portfolio_url text,
  social_links jsonb not null default '{}',
  publishing_status text not null default 'active' check (publishing_status in ('active','restricted')),
  terms_accepted_at timestamptz not null default now()
);

create table series (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references profiles on delete cascade,
  title text not null,
  alternative_titles text[] not null default '{}',
  slug text unique not null,
  synopsis text,
  cover_url text,
  banner_url text,
  language text not null default 'en',
  content_format content_format not null default 'webtoon',
  content_rating content_rating not null default 'everyone',
  publication_status pub_status not null default 'ongoing',
  release_schedule text,
  visibility visibility not null default 'draft',
  tags text[] not null default '{}',
  view_count bigint not null default 0,
  search tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index series_search_idx on series using gin (search);
create index series_creator_idx on series (creator_id);
create index series_listing_idx on series (visibility, updated_at desc);

create table series_contributors (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references series on delete cascade,
  user_id uuid references profiles on delete set null,
  display_name text not null,
  contribution_role text not null
);
create index on series_contributors (series_id);

create table genres (id serial primary key, name text unique not null, slug text unique not null);
create table series_genres (
  series_id uuid references series on delete cascade,
  genre_id int references genres on delete cascade,
  primary key (series_id, genre_id)
);

create table chapters (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references series on delete cascade,
  chapter_number numeric(8,2) not null,
  volume_number int,
  title text,
  description text,
  reading_mode reading_mode not null default 'vertical',
  publication_status chapter_status not null default 'draft',
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (series_id, chapter_number)
);
create index on chapters (series_id, chapter_number);

create table chapter_assets (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references chapters on delete cascade,
  storage_key text unique not null,
  display_order int not null,
  original_width int,
  original_height int,
  file_size bigint,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  processing_status asset_status not null default 'pending',
  unique (chapter_id, display_order) deferrable initially deferred
);

create table reading_progress (
  user_id uuid references profiles on delete cascade,
  series_id uuid references series on delete cascade,
  chapter_id uuid references chapters on delete cascade,
  asset_id uuid references chapter_assets on delete set null,
  scroll_position real not null default 0,
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, series_id)
);

create table library (
  user_id uuid references profiles on delete cascade,
  series_id uuid references series on delete cascade,
  reading_status library_status not null default 'plan_to_read',
  added_at timestamptz not null default now(),
  primary key (user_id, series_id)
);

create table follows (
  user_id uuid references profiles on delete cascade,
  creator_id uuid references profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, creator_id),
  check (user_id <> creator_id)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  series_id uuid not null references series on delete cascade,
  chapter_id uuid references chapters on delete cascade,
  parent_comment_id uuid references comments on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references profiles on delete set null,
  target_type text not null check (target_type in ('series','chapter','comment','user')),
  target_id uuid not null,
  reason text not null,
  description text,
  status report_status not null default 'open',
  created_at timestamptz not null default now()
);

create table analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('series_view','chapter_view','chapter_complete')),
  user_id uuid,
  series_id uuid not null references series on delete cascade,
  chapter_id uuid references chapters on delete cascade,
  created_at timestamptz not null default now()
);
create index on analytics_events (series_id, created_at);

-- helpers
create function is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and not suspended) $$;

create function owns_series(sid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from series s join profiles p on p.id = s.creator_id
   where s.id = sid and s.creator_id = auth.uid() and not p.suspended) $$;

create function series_is_public(sid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from series where id = sid and visibility in ('published','unlisted')) $$;

create function chapter_is_public(cid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from chapters c join series s on s.id = c.series_id
   where c.id = cid and c.publication_status = 'published' and s.visibility in ('published','unlisted')) $$;

-- new auth user -> profile
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, username, display_name)
  values (new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(replace(new.id::text,'-',''),1,10)),
    coalesce(new.raw_user_meta_data->>'display_name', 'New reader'));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- search vector + updated_at
create function series_before_write() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.search := setweight(to_tsvector('simple', coalesce(new.title,'')), 'A')
    || setweight(to_tsvector('simple', array_to_string(new.alternative_titles,' ')), 'B')
    || setweight(to_tsvector('simple', array_to_string(new.tags,' ')), 'C')
    || setweight(to_tsvector('simple', coalesce(new.synopsis,'')), 'D');
  return new;
end $$;
create trigger series_bw before insert or update on series for each row execute function series_before_write();

-- become a creator (the only way a user changes their own role)
create function become_creator(p_slug text) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into creator_profiles (user_id, creator_slug) values (auth.uid(), p_slug);
  update profiles set role = 'creator' where id = auth.uid() and role = 'reader';
end $$;

-- publish only when every asset is ready
create function publish_chapter(p_chapter uuid, p_at timestamptz default null) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid; total int; ready int;
begin
  select series_id into sid from chapters where id = p_chapter;
  if sid is null or not owns_series(sid) then raise exception 'not allowed'; end if;
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

-- RLS
alter table profiles enable row level security;
alter table creator_profiles enable row level security;
alter table series enable row level security;
alter table series_contributors enable row level security;
alter table genres enable row level security;
alter table series_genres enable row level security;
alter table chapters enable row level security;
alter table chapter_assets enable row level security;
alter table reading_progress enable row level security;
alter table library enable row level security;
alter table follows enable row level security;
alter table comments enable row level security;
alter table reports enable row level security;
alter table analytics_events enable row level security;

create policy profiles_read on profiles for select using (true);
create policy profiles_update_own on profiles for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from profiles where id = auth.uid()) and suspended = false);
create policy profiles_admin on profiles for all using (is_admin());

create policy cp_read on creator_profiles for select using (true);
create policy cp_update_own on creator_profiles for update using (user_id = auth.uid())
  with check (user_id = auth.uid() and publishing_status = (select publishing_status from creator_profiles where user_id = auth.uid()));
create policy cp_admin on creator_profiles for all using (is_admin());

create policy series_read on series for select using (visibility in ('published','unlisted') or creator_id = auth.uid() or is_admin());
create policy series_insert on series for insert with check (creator_id = auth.uid() and exists (
  select 1 from profiles p join creator_profiles c on c.user_id = p.id
  where p.id = auth.uid() and p.role in ('creator','admin') and not p.suspended and c.publishing_status = 'active'));
create policy series_update on series for update using (creator_id = auth.uid() or is_admin());
create policy series_delete on series for delete using (creator_id = auth.uid() or is_admin());

create policy sc_read on series_contributors for select using (series_is_public(series_id) or owns_series(series_id) or is_admin());
create policy sc_write on series_contributors for all using (owns_series(series_id)) with check (owns_series(series_id));
create policy genres_read on genres for select using (true);
create policy genres_admin on genres for all using (is_admin());
create policy sg_read on series_genres for select using (true);
create policy sg_write on series_genres for all using (owns_series(series_id)) with check (owns_series(series_id));

create policy ch_read on chapters for select using (chapter_is_public(id) or owns_series(series_id) or is_admin());
create policy ch_write on chapters for all using (owns_series(series_id)) with check (owns_series(series_id));
create policy ch_admin on chapters for update using (is_admin());

create policy ca_read on chapter_assets for select using (
  (chapter_is_public(chapter_id) and processing_status = 'ready')
  or exists (select 1 from chapters c where c.id = chapter_id and owns_series(c.series_id)) or is_admin());
create policy ca_write on chapter_assets for all using (
  exists (select 1 from chapters c where c.id = chapter_id and owns_series(c.series_id)))
  with check (exists (select 1 from chapters c where c.id = chapter_id and owns_series(c.series_id)));

create policy rp_own on reading_progress for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy lib_own on library for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy follows_read on follows for select using (user_id = auth.uid() or creator_id = auth.uid());
create policy follows_write on follows for insert with check (user_id = auth.uid());
create policy follows_delete on follows for delete using (user_id = auth.uid());

create policy comments_read on comments for select using (series_is_public(series_id) or is_admin());
create policy comments_insert on comments for insert with check (user_id = auth.uid());
create policy comments_delete on comments for delete using (user_id = auth.uid() or is_admin());

create policy reports_insert on reports for insert with check (reporter_id = auth.uid());
create policy reports_admin on reports for all using (is_admin());
create policy reports_own on reports for select using (reporter_id = auth.uid());

create policy ae_insert on analytics_events for insert with check (user_id is null or user_id = auth.uid());
create policy ae_read on analytics_events for select using (owns_series(series_id) or is_admin());

insert into genres (name, slug) values ('Action','action'),('Romance','romance'),('Sci-fi','sci-fi'),('Mystery','mystery'),('Fantasy','fantasy'),('Drama','drama'),('Thriller','thriller'),('Comedy','comedy');
