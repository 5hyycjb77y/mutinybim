-- MutinyBIM round 9 (lane I9): a durable record of each linked-model import
-- (Propose changes to this model). The model server's own database, not
-- Hours' supabase/migrations.
--
-- One row per run: the Main model it was made from, the branch it made, the
-- person who asked (their Hours login id), the linked model version and the
-- hash of the file read, where it got to, and the report. The row is also
-- what lets a person who can only read Main edit the proposal branch they
-- opened (product decision answer 7): an authority grants edit on a branch to the
-- creator of a finished run on it, and to no one else.
--
-- Expand only: the table is new and only an authority that knows it reads or
-- writes it. No probe in src/migration-baseline.ts: this file runs once,
-- through the migrator, and bim.schema_migrations is its record.

set local lock_timeout = '5s';

create table if not exists bim.import_runs (
  id uuid primary key,
  base_model_id text not null references bim.models (id) on delete cascade,
  branch_model_id text references bim.models (id) on delete cascade,
  created_by text not null check (char_length(created_by) between 1 and 200),
  reference_id text not null check (char_length(reference_id) between 1 and 200),
  source_version_id text not null check (char_length(source_version_id) between 1 and 200),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  hours_job_id text check (hours_job_id is null or char_length(hours_job_id) <= 200),
  status text not null check (status in ('converting', 'landing', 'done', 'failed', 'cancelled')),
  total integer not null default 0 check (total >= 0),
  landed integer not null default 0 check (landed >= 0),
  report jsonb check (report is null or (jsonb_typeof(report) = 'object' and octet_length(report::text) <= 262144)),
  error text check (error is null or char_length(error) <= 500),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists import_runs_branch_owner_idx on bim.import_runs (branch_model_id, created_by) where branch_model_id is not null;
create index if not exists import_runs_base_idx on bim.import_runs (base_model_id, started_at desc);
