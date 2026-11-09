-- MutinyBIM feasibility: consistent initial load for candidate A.
-- One statement = one MVCC snapshot, so the revision and the element rows can
-- never straddle a commit. SECURITY INVOKER: the caller's RLS applies, so a
-- non-member gets NULL.

create or replace function bim.model_snapshot(p_model_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'modelId', m.id,
    'revision', m.revision,
    'settings', m.settings,
    'connections', m.connections,
    'elements', coalesce(
      (select jsonb_object_agg(e.element_id, e.body) from bim.elements e where e.model_id = m.id),
      '{}'::jsonb
    )
  )
  from bim.models m
  where m.id = p_model_id
$$;

revoke all on function bim.model_snapshot(text) from public;
grant execute on function bim.model_snapshot(text) to authenticated;
