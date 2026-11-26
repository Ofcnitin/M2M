-- 0019 — Collision-safe signup usernames (found by executing the SQL suites, v8).
--
-- handle_new_user() (0015) generated fallback usernames as 'user_' + the first 10 hex
-- chars of the user's UUID. Two signups whose UUIDs share that prefix (guaranteed in
-- tests with sequential fixture UUIDs; possible in production) hit
-- profiles_username_key and the SECOND SIGNUP FAILED ENTIRELY. Re-issued verbatim from
-- 0015 except: the profile insert retries with a random suffix on username collision
-- (whether the username came from metadata or was generated).

create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare dob date; uname text; attempt int := 0;
begin
  begin
    dob := nullif(new.raw_user_meta_data->>'date_of_birth', '')::date;
  exception when others then
    raise exception 'invalid date_of_birth';
  end;
  if dob is not null then
    if dob > current_date - interval '13 years' then raise exception 'users must be 13 or older'; end if;
    if dob <= current_date - interval '120 years' then raise exception 'invalid date_of_birth'; end if;
  end if;
  uname := coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(replace(new.id::text,'-',''),1,10));
  loop
    begin
      insert into profiles (id, username, display_name, age_confirmed_at, adult_confirmed_at, date_of_birth)
      values (new.id,
        uname,
        coalesce(new.raw_user_meta_data->>'display_name', 'New reader'),
        case when dob is not null or new.raw_user_meta_data->>'age_confirmed' = 'true' then now() end,
        case when new.raw_user_meta_data->>'adult_confirmed' = 'true' then now() end,
        dob);
      exit;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 5 then raise; end if;
      uname := left(uname, 24) || '_' || substr(md5(random()::text || new.id::text), 1, 6);
    end;
  end loop;
  return new;
end $$;
