-- MutinyBIM round 11 (lane W11, D1): standalone per-copy members, for a
-- MutinyBIM host with no host IAM (the open-source host and the disposable
-- test stack). Polygnotos keeps its grants in Hours (public.bim_lineage_grants)
-- and never writes here.
--
-- A row names one person on one copy with one capability (`read`, `propose`,
-- `review`, `edit`, or a host's own word). Revoking stamps revoked_at; the row
-- is kept as the record of who could do what, when. At most one live grant per
-- (copy, person, capability).
--
-- Expand only: new table; an authority without it names nobody on copies (a
-- copy is edited by its creator, a round 8b branch by its base's editors).

set local lock_timeout = '5s';

create table if not exists bim.lineage_members (
  member_id uuid primary key default gen_random_uuid(),
  base_model_id text not null references bim.models (id) on delete cascade,
  lineage_id text not null check (char_length(lineage_id) between 1 and 64),
  user_id text not null check (char_length(user_id) between 1 and 200),
  capability text not null check (capability ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$' and char_length(capability) <= 64),
  granted_by text not null check (char_length(granted_by) between 1 and 200),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  check ((revoked_at is null) = (revoked_by is null))
);

create unique index if not exists lineage_members_live_idx on bim.lineage_members (base_model_id, lineage_id, user_id, capability)
  where revoked_at is null;
create index if not exists lineage_members_person_idx on bim.lineage_members (base_model_id, user_id) where revoked_at is null;

grant select on bim.lineage_members to authenticated;
grant select, insert, update, delete on bim.lineage_members to service_role;
alter table bim.lineage_members enable row level security;

drop policy if exists lineage_members_select on bim.lineage_members;
create policy lineage_members_select on bim.lineage_members
  for select to authenticated using (
    base_model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );
