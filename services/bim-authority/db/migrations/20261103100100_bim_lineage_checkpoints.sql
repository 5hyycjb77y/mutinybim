-- MutinyBIM round 11 (lane W11, D1): copy checkpoints, so a copy that lives
-- for decades opens from its newest checkpoint instead of replaying every
-- changeset since it was made.
--
-- A checkpoint is the copy's NET CHANGE from its fork pin to one revision (the
-- records it rewrote as they then stood, the ids it removed, the connections
-- it made and cut), never its whole state: its unchanged records stay shared
-- with its parent. The rows below name it (revision, fork pin, the kernel's
-- state digest); the net change rides in chunks of at most 5,000 records so no
-- row holds a whole delta.
--
-- Written off the commit path by the authority (src/lineages/checkpoints.ts),
-- read once per open (src/pg-branches.ts loadBranchHead). The newest three per
-- copy are kept. A copy's own changesets are still never purged (round 8b
-- bim.purge_changesets is unchanged): the checkpoint saves the replay, not the
-- history.
--
-- Expand only: new tables, nothing older reads them; an authority without this
-- migration opens copies by replaying, as round 8b did.

set local lock_timeout = '5s';

create table if not exists bim.lineage_checkpoints (
  model_id text not null references bim.models (id) on delete cascade,
  revision bigint not null check (revision >= 0),
  fork_revision bigint not null check (fork_revision >= 0 and fork_revision <= revision),
  state_digest text not null check (state_digest ~ '^[0-9a-f]{64}$'),
  element_count integer not null check (element_count >= 0),
  chunk_count integer not null check (chunk_count >= 1),
  created_at timestamptz not null default now(),
  primary key (model_id, revision)
);

create table if not exists bim.lineage_checkpoint_chunks (
  model_id text not null,
  revision bigint not null,
  chunk integer not null check (chunk >= 0),
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  primary key (model_id, revision, chunk),
  foreign key (model_id, revision) references bim.lineage_checkpoints (model_id, revision) on delete cascade
);

grant select on bim.lineage_checkpoints to authenticated;
grant select, insert, update, delete on bim.lineage_checkpoints to service_role;
alter table bim.lineage_checkpoints enable row level security;

drop policy if exists lineage_checkpoints_select on bim.lineage_checkpoints;
create policy lineage_checkpoints_select on bim.lineage_checkpoints
  for select to authenticated using (
    model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );

grant select on bim.lineage_checkpoint_chunks to authenticated;
grant select, insert, update, delete on bim.lineage_checkpoint_chunks to service_role;
alter table bim.lineage_checkpoint_chunks enable row level security;

drop policy if exists lineage_checkpoint_chunks_select on bim.lineage_checkpoint_chunks;
create policy lineage_checkpoint_chunks_select on bim.lineage_checkpoint_chunks
  for select to authenticated using (
    model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );
