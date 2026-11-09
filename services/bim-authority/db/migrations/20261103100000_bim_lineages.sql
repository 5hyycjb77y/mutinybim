-- MutinyBIM round 11 (lane W11, D1): copies with a purpose, on the model
-- server's own database (not Hours' supabase/migrations).
--
-- A copy is still a bim.models row (`<baseModelId>~<copyId>`, round 8b): its
-- branch columns say which base it belongs to, the revision of its parent's
-- line it forked at, and whether it still takes edits. bim.lineages adds what a
-- round 8b branch can't say: its parent copy (any depth), its purpose, what may
-- go back from it, its owner and who edits it.
--
-- Expand only. Nothing an older authority reads or writes changes:
--   * bim.lineages is new; nothing older reads it;
--   * an existing branch row has no bim.lineages row and reads as a round 8b
--     proposal whose parent is the first copy, edited by whoever edits it
--     (no backfill: the reader decides, packages/bim-sync lineageRowOf);
--   * a copy of a copy is a branch row whose base_model_id is the base and whose
--     base_revision is a revision of its parent's line; the existing
--     bim_models_branch_shape check already admits it.
-- No probe in src/migration-baseline.ts: this file runs once, through the
-- migrator, and bim.schema_migrations is its record.

set local lock_timeout = '5s';

create table if not exists bim.lineages (
  -- The copy's own model row.
  model_id text primary key references bim.models (id) on delete cascade,
  base_model_id text not null references bim.models (id) on delete cascade,
  -- The copy's id within its base (the part after `~`).
  lineage_id text not null check (char_length(lineage_id) between 1 and 64),
  -- The copy it came from: another copy's lineage_id, or the first copy's id.
  parent_lineage_id text not null check (char_length(parent_lineage_id) between 1 and 64),
  parent_revision bigint not null check (parent_revision >= 0),
  -- A first-party purpose or an add-on's `<pack>.<name>` (kernel.lineage_role v1). Readers keep unknown ones as written.
  role text not null check (role ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$' and char_length(role) <= 96),
  -- Writers are strict; readers read an unknown policy as `never` (never wider).
  return_policy text not null check (return_policy in ('merge', 'review_only', 'accept_back', 'never')),
  -- Who edits it besides its creator and named people: `named` (a copy with a purpose) or
  -- `parent_editors` (a branch made the round 8b way on a branch session).
  edit_scope text not null default 'named' check (edit_scope in ('named', 'parent_editors')),
  owner_party text check (owner_party is null or char_length(owner_party) between 1 and 200),
  -- Host-stored text the forker accepted (the text itself is never here).
  terms_disclaimer_id text check (terms_disclaimer_id is null or char_length(terms_disclaimer_id) between 1 and 100),
  -- AuthorRef { provider, subject, kind } of whoever made it.
  created_by jsonb not null check (jsonb_typeof(created_by) = 'object'),
  created_at timestamptz not null default now(),
  check (left(model_id, char_length(base_model_id) + 1) = base_model_id || '~'),
  check (model_id = base_model_id || '~' || lineage_id),
  check (parent_lineage_id <> lineage_id),
  unique (base_model_id, lineage_id)
);

create index if not exists lineages_base_parent_idx on bim.lineages (base_model_id, parent_lineage_id);

grant select on bim.lineages to authenticated;
grant select, insert, update, delete on bim.lineages to service_role;
alter table bim.lineages enable row level security;

drop policy if exists lineages_select on bim.lineages;
create policy lineages_select on bim.lineages
  for select to authenticated using (
    base_model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );
