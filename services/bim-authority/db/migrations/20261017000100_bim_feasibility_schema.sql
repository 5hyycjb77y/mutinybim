-- MutinyBIM feasibility schema (candidates A and B share it).
-- FOR REVIEW: applied only to the disposable local stack in
-- experiments/mutinybim-backends. Not part of supabase/migrations in Hours, so it
-- cannot deploy on merge. Productizing it later means re-authoring it against
-- the real Hours objects (has_project_access with groups/clients/superadmin) and
-- the IAM keys in the plan.

create schema if not exists bim;
grant usage on schema bim to authenticated, service_role;

-- One row per model. The row lock serializes commits (candidate A); the lease
-- generation fences a stale authority process (candidate B).
create table bim.models (
  id text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  revision bigint not null default 0,
  lease_generation bigint not null default 0,
  settings jsonb not null,
  connections jsonb not null,
  created_at timestamptz not null default now()
);

-- Current authored + derived state, one row per element, written only by the sequencer.
create table bim.elements (
  model_id text not null references bim.models(id) on delete cascade,
  element_id text not null,
  kind text not null,
  version bigint not null,
  body jsonb not null,
  primary key (model_id, element_id)
);

-- Append-only, ordered changeset log: replay, catch-up, audit.
create table bim.changesets (
  model_id text not null references bim.models(id) on delete cascade,
  revision bigint not null,
  idempotency_key text not null,
  actor_id text not null,
  actor_kind text not null,
  body jsonb not null,
  committed_at timestamptz not null default now(),
  primary key (model_id, revision),
  unique (model_id, idempotency_key)
);

-- First outcome per idempotency key, rejections included (R5).
create table bim.command_outcomes (
  model_id text not null references bim.models(id) on delete cascade,
  idempotency_key text not null,
  actor_id text not null,
  outcome jsonb not null,
  created_at timestamptz not null default now(),
  primary key (model_id, idempotency_key)
);

-- Authenticated users read; only the trusted sequencer (service role / owner
-- connection) writes. No INSERT/UPDATE/DELETE grants to authenticated.
grant select on bim.models, bim.elements, bim.changesets, bim.command_outcomes to authenticated;
grant select, insert, update, delete on bim.models, bim.elements, bim.changesets, bim.command_outcomes to service_role;

alter table bim.models enable row level security;
alter table bim.elements enable row level security;
alter table bim.changesets enable row level security;
alter table bim.command_outcomes enable row level security;

create policy models_select on bim.models
  for select to authenticated using (public.has_project_access(project_id, (select auth.uid())));

create policy elements_select on bim.elements
  for select to authenticated using (
    exists (select 1 from bim.models m where m.id = model_id and public.has_project_access(m.project_id, (select auth.uid())))
  );

create policy changesets_select on bim.changesets
  for select to authenticated using (
    exists (select 1 from bim.models m where m.id = model_id and public.has_project_access(m.project_id, (select auth.uid())))
  );

create policy command_outcomes_select_own on bim.command_outcomes
  for select to authenticated using (actor_id = (select auth.uid())::text);

-- Realtime private channels.
--   bim:<model>:commits   committed-changeset notices; only the server sends (realtime.send).
--   bim:<model>:presence  ephemeral activity; members may send and receive.
create policy bim_channels_read on realtime.messages
  for select to authenticated using (
    realtime.topic() like 'bim:%'
    and exists (
      select 1 from bim.models m
      where m.id = split_part(realtime.topic(), ':', 2)
        and public.has_project_access(m.project_id, (select auth.uid()))
    )
  );

create policy bim_presence_write on realtime.messages
  for insert to authenticated with check (
    realtime.topic() like 'bim:%:presence'
    and exists (
      select 1 from bim.models m
      where m.id = split_part(realtime.topic(), ':', 2)
        and public.has_project_access(m.project_id, (select auth.uid()))
    )
  );
