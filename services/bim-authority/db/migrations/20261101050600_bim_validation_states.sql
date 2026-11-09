-- MutinyBIM round 9 (lane K9): a model's validation state, kept beside its
-- head so a model server opening it adopts what validation already knows
-- instead of re-checking every element (one cold pass is 1.6-1.8 s at 1M).
-- The model server's own database, not Hours' supabase/migrations.
--
-- One row per model, the newest written: the head revision it describes, the
-- shape version of the body, the build that wrote it (its checks), and the
-- body (open issues, which checks have them, which add-on contributions each
-- check reads, "fully derived"). An authority adopts it only when the head it
-- loaded is at that revision, it is the same build, and the add-on set the
-- model resolves to has the same key (inside the body); anything else is the
-- cold pass, as before. Nothing here is read by clients.
--
-- Expand only. Nothing an older authority reads or writes changes: the table
-- is new and only an authority that knows it (it checks at lease time) reads
-- or writes it. No probe in src/migration-baseline.ts: this file runs once,
-- through the migrator, and bim.schema_migrations is its record.

set local lock_timeout = '5s';

create table if not exists bim.validation_states (
  model_id text primary key references bim.models (id) on delete cascade,
  revision bigint not null,
  version integer not null,
  code_key text not null,
  element_count integer not null,
  body jsonb not null,
  written_at timestamptz not null default now()
);

-- The authority (service_role) only; no client reads it.
grant select, insert, update, delete on bim.validation_states to service_role;
alter table bim.validation_states enable row level security;
