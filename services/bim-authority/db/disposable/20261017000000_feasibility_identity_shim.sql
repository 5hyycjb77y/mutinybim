-- DISPOSABLE FEASIBILITY STACK ONLY. Never applied to a host's database.
-- Minimal stand-ins for the host tables/functions the bim schema depends on,
-- with membership-only semantics
-- (public.projects, public.project_members, public.has_project_access).

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  project_number text not null unique,
  name text not null
);

create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (project_id, user_id)
);

grant select on public.projects, public.project_members to authenticated;
grant select, insert, update, delete on public.projects, public.project_members to service_role;

alter table public.projects enable row level security;
alter table public.project_members enable row level security;

-- Membership-only, like production has_project_access (minus groups/clients/superadmin).
create or replace function public.has_project_access(p_project_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- DEFINER because callers (RLS on bim.* and realtime.messages) cannot read
  -- other users' membership rows directly.
  select exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project_id and pm.user_id = p_user_id
  );
$$;

revoke all on function public.has_project_access(uuid, uuid) from public;
grant execute on function public.has_project_access(uuid, uuid) to authenticated, service_role;

create policy projects_select on public.projects
  for select to authenticated using (public.has_project_access(id, (select auth.uid())));
create policy project_members_select on public.project_members
  for select to authenticated using (user_id = (select auth.uid()));
