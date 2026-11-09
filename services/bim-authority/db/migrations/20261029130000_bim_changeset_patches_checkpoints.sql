-- MutinyBIM round 5a (f-wire): smaller changeset writes, checkpoints and a
-- changeset retention policy (KERNEL-AUDIT §6.1, MIGRATION-PLAN §6).
-- The authority's own database, not Hours' supabase/migrations.
--
-- Expand only. Nothing an older authority reads or writes changes:
--   * bim.changesets.patch is nullable; older authorities never write it and
--     keep reading body. A new authority writes both for one release
--     (packages/bim-sync/src/changeset-patch.ts), and only after it has seen
--     this column (it checks at lease time), so it also runs against a
--     database this file has not reached yet.
--   * bim.checkpoints is new; nothing older reads it.
--   * bim.purge_changesets is only called by an authority that knows it.

-- 1. Patch form of each changeset, beside the full body.
alter table bim.changesets add column if not exists patch jsonb;

-- 2. Checkpoints: the whole durable head at a revision, written off the commit
--    path every N revisions by the lease holder. Changesets at or below the
--    newest checkpoint (and outside the catch-up window) may be purged; a
--    client behind the kept history is sent a fresh copy instead of a catch-up.
create table if not exists bim.checkpoints (
  model_id text not null references bim.models (id) on delete cascade,
  revision bigint not null,
  element_count integer not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (model_id, revision)
);

grant select on bim.checkpoints to authenticated;
grant select, insert, update, delete on bim.checkpoints to service_role;
alter table bim.checkpoints enable row level security;

drop policy if exists checkpoints_select on bim.checkpoints;
create policy checkpoints_select on bim.checkpoints
  for select to authenticated using (
    model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );

-- 3. Retention. Deletes, in bounded batches, changesets that are
--      at or below the newest checkpoint,
--      more than p_keep_revisions behind the head, and
--      older than p_keep (so a retried edit still finds its first answer:
--      command outcomes are kept 24 hours, purge_command_outcomes).
--    Keeps the newest three checkpoints. Returns changesets deleted.
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
    select least(
      coalesce((select max(k.revision) from bim.checkpoints k where k.model_id = p_model_id), -1),
      (select m.revision from bim.models m where m.id = p_model_id) - p_keep_revisions
    ) as revision
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
