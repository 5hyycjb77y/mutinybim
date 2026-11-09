-- MutinyBIM round 8b (lane B): branches and saved versions, on the model
-- server's own database (not Hours' supabase/migrations).
--
-- A branch is a model of its own (`<baseModelId>~<branchId>`): its bim.models
-- row says what it came from and whether it still takes edits. A fork copies
-- nothing: it pins the base's history at the branch's base revision against
-- retention, and the branch is opened from the base's state at that revision
-- plus its own changesets.
--
-- Expand only. Nothing an older authority reads or writes changes:
--   * the new bim.models columns are nullable and older authorities never
--     write them; a plain model keeps them null;
--   * bim.history_pins and bim.saved_versions are new; nothing older reads them;
--   * bim.purge_changesets keeps the same signature and only deletes less
--     (pinned history and a branch's own changesets are kept).
-- No probe in src/migration-baseline.ts: this file runs once, through the
-- migrator, and bim.schema_migrations is its record.
--
-- TESTING MUST DIFF BEFORE THIS DEPLOYS: section 4's bim.purge_changesets was
-- copied from the old migration file 20261029130000 (the model server's
-- database wasn't reachable from Building), not exported from a live database.
-- Before it reaches any region, diff it against
--   select pg_get_functiondef('bim.purge_changesets(text,bigint,interval,integer)'::regprocedure);
-- on the model-server database; only the pin / branch lines may differ.

set local lock_timeout = '5s';

-- 1. Branch identity on the model row.
alter table bim.models
  add column if not exists base_model_id text references bim.models (id) on delete cascade,
  add column if not exists base_revision bigint,
  add column if not exists branch_name text,
  add column if not exists branch_state text,
  add column if not exists branch_created_by text,
  add column if not exists branch_created_at timestamptz;

-- Writers are strict (readers are tolerant: an unknown state reads as closed).
-- bim.models holds one row per model, so the check's scan is short.
alter table bim.models drop constraint if exists bim_models_branch_shape;
alter table bim.models add constraint bim_models_branch_shape check (
  (base_model_id is null and base_revision is null and branch_name is null and branch_state is null and branch_created_by is null and branch_created_at is null)
  or (
    base_model_id is not null and base_revision is not null and base_revision >= 0
    and branch_name is not null and char_length(branch_name) between 1 and 80
    and branch_state in ('open', 'merge_proposed', 'merged', 'closed')
    and branch_created_by is not null and branch_created_at is not null
    and left(id, char_length(base_model_id) + 1) = base_model_id || '~'
  )
);

create index if not exists models_base_model_id_idx on bim.models (base_model_id) where base_model_id is not null;

-- One open branch per name on a base (a closed or merged name may be reused).
create unique index if not exists models_open_branch_name_idx on bim.models (base_model_id, branch_name)
  where base_model_id is not null and branch_state in ('open', 'merge_proposed');

-- 2. History pins: a revision of a model whose history retention must keep.
--    `pinned_by` names the holder: 'branch:<branch model id>' or 'version:<version id>'.
create table if not exists bim.history_pins (
  model_id text not null references bim.models (id) on delete cascade,
  revision bigint not null check (revision >= 0),
  pinned_by text not null check (pinned_by ~ '^(branch|version):.+$'),
  created_at timestamptz not null default now(),
  primary key (model_id, pinned_by)
);

create index if not exists history_pins_model_revision_idx on bim.history_pins (model_id, revision);

grant select on bim.history_pins to authenticated;
grant select, insert, update, delete on bim.history_pins to service_role;
alter table bim.history_pins enable row level security;

drop policy if exists history_pins_select on bim.history_pins;
create policy history_pins_select on bim.history_pins
  for select to authenticated using (
    model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );

-- 3. Saved versions: a name on a revision ("Save version"), kept until deleted.
create table if not exists bim.saved_versions (
  version_id uuid primary key default gen_random_uuid(),
  model_id text not null references bim.models (id) on delete cascade,
  revision bigint not null check (revision >= 0),
  name text not null check (char_length(name) between 1 and 80),
  saved_by text not null,
  saved_at timestamptz not null default now()
);

create index if not exists saved_versions_model_revision_idx on bim.saved_versions (model_id, revision desc);

grant select on bim.saved_versions to authenticated;
grant select, insert, update, delete on bim.saved_versions to service_role;
alter table bim.saved_versions enable row level security;

drop policy if exists saved_versions_select on bim.saved_versions;
create policy saved_versions_select on bim.saved_versions
  for select to authenticated using (
    model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );

-- 4. Retention keeps pinned history and a branch's own changesets.
--    Copied from 20261029130000 (the definition every region runs; the model
--    server's database is not reachable from Building, so Testing diffs this
--    against `pg_get_functiondef` there). Only the cutoff changed:
--      * a pinned revision R keeps every changeset after R (a fork reverts
--        them from the head);
--      * a branch's own changesets are never purged (it is opened by replaying
--        them on its base's state).
create or replace function bim.purge_changesets(
  p_model_id text,
  p_keep_revisions bigint default 10000,
  p_keep interval default interval '30 days',
  p_limit integer default 5000
)
 returns bigint
 language sql
 security invoker
 set search_path to ''
as $function$
  with cutoff as (
    -- least() skips nulls: with no checkpoint the cutoff must be -1 (keep
    -- everything), not the head minus p_keep_revisions.
    select case
      when exists (select 1 from bim.models b where b.id = p_model_id and b.base_model_id is not null) then -1
      else least(
        coalesce((select max(k.revision) from bim.checkpoints k where k.model_id = p_model_id), -1),
        (select m.revision from bim.models m where m.id = p_model_id) - p_keep_revisions,
        (select min(p.revision) from bim.history_pins p where p.model_id = p_model_id)
      )
    end as revision
  ), doomed as (
    select c.revision from bim.changesets c
    where c.model_id = p_model_id
      and c.revision <= (select revision from cutoff)
      and c.committed_at < now() - p_keep
    order by c.revision
    limit greatest(p_limit, 0)
  ), gone as (
    delete from bim.changesets c
    where c.model_id = p_model_id and c.revision in (select revision from doomed)
    returning 1
  ), old_checkpoints as (
    -- Runs whether or not the final select reads it (data-modifying CTEs always do).
    delete from bim.checkpoints k
    where k.model_id = p_model_id
      and k.revision < (
        select min(r.revision) from (
          select k2.revision from bim.checkpoints k2 where k2.model_id = p_model_id order by k2.revision desc limit 3
        ) r
      )
    returning 1
  )
  select count(*) from gone
$function$;

revoke all on function bim.purge_changesets(text, bigint, interval, integer) from public;
grant execute on function bim.purge_changesets(text, bigint, interval, integer) to service_role;
