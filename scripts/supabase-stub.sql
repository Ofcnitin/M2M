create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create or replace function auth.uid() returns uuid language plpgsql stable as $$
declare claims text; sub text;
begin
  claims := current_setting('request.jwt.claims', true);
  if claims is null or claims = '' then return null; end if;
  sub := (claims::jsonb ->> 'sub');
  if sub is null then return null; end if;
  return sub::uuid;
exception when others then return null;
end $$;
create or replace function auth.role() returns text language plpgsql stable as $$
declare claims text;
begin
  claims := current_setting('request.jwt.claims', true);
  if claims is null or claims = '' then return null; end if;
  return claims::jsonb ->> 'role';
exception when others then return null;
end $$;
grant usage on schema auth to anon, authenticated, service_role;
-- Emulate Supabase default privileges: objects created by postgres in public are
-- accessible to anon/authenticated (RLS is the gate) and fully to service_role.
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;
