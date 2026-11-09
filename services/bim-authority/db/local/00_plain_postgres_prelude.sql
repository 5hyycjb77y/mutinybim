-- LOCAL TEST AUTHORITY ONLY (a throwaway plain Postgres container on a laptop).
-- The roles and auth.uid() a Supabase database provides, so the authority's
-- migrations and the disposable identity shim apply unchanged. Sign-in and
-- project permissions come from the host plug-in, not from here.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create extension if not exists pgcrypto;

-- Supabase Realtime's broadcast table, which the feasibility schema puts policies on.
create schema if not exists realtime;
create table if not exists realtime.messages (topic text not null, extension text not null default 'broadcast', payload jsonb, inserted_at timestamptz not null default now());
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
