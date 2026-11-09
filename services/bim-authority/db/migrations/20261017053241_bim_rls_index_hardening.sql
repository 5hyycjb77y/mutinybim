-- MutinyBIM feasibility: Postgres best-practice pass (Supabase rules
-- security-rls-performance, schema-foreign-key-indexes, security-privileges).
-- Disposable stacks only; not part of Hours' supabase/migrations.

-- 1. SECURITY DEFINER with an empty search_path: every reference is schema-qualified,
--    so a caller cannot shadow project_members with an object of their own.
create or replace function public.has_project_access(p_project_id uuid, p_user_id uuid default auth.uid())
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  -- DEFINER because callers (RLS on bim.* and realtime.messages) cannot read
  -- other users' membership rows directly.
  select exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project_id and pm.user_id = p_user_id
  );
$function$;

-- 2. Index the columns RLS filters on and the foreign keys without a leading index.
create index if not exists models_project_id_idx on bim.models (project_id);
create index if not exists project_members_user_id_idx on public.project_members (user_id);
create index if not exists command_outcomes_actor_id_idx on bim.command_outcomes (actor_id, model_id);

-- 3. Element and changeset reads: decide model access once per query (a set of
--    readable model ids) instead of a correlated membership check per row.
drop policy if exists elements_select on bim.elements;
create policy elements_select on bim.elements
  for select to authenticated using (
    model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );

drop policy if exists changesets_select on bim.changesets;
create policy changesets_select on bim.changesets
  for select to authenticated using (
    model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );
