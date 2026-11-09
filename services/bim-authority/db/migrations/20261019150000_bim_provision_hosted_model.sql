-- MutinyBIM authority: create the empty live model for a Polygnotos project the
-- first time someone who can edit it opens the Building Model.
--
-- The authority calls this only after Polygnotos said the signed-in person may
-- edit p_host_project_id and that the project's number is p_project_number.
-- The model id is derived from the number ('site-<number>'), so two openings
-- at once (two tabs, two machines) race on bim.models' primary key: one
-- inserts, the other does nothing, and both read back the same row.
--
-- Returns the Polygnotos project the model is hosted for. That can differ from
-- p_host_project_id when another project with the same number got there
-- first; the caller re-checks access against the returned project.

create or replace function bim.provision_hosted_model(
  p_model_id text,
  p_host_project_id uuid,
  p_project_number text,
  p_settings jsonb
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_local_project uuid;
  v_host uuid;
begin
  if p_project_number is null or p_project_number !~ '^[0-9]{3,6}$' or p_model_id is distinct from 'site-' || p_project_number then
    raise exception 'model id % does not match project number %', p_model_id, p_project_number;
  end if;
  if p_host_project_id is null or p_settings is null then
    raise exception 'a host project and model settings are required';
  end if;

  -- bim.models needs a local project row (the authority's own stand-in for
  -- membership). Reuse one already holding this number; otherwise add one.
  insert into public.projects (id, project_number, name)
  values (p_host_project_id, p_project_number, 'Polygnotos project ' || p_project_number)
  on conflict do nothing;
  select p.id into v_local_project from public.projects p where p.id = p_host_project_id;
  if v_local_project is null then
    select p.id into v_local_project from public.projects p where p.project_number = p_project_number;
  end if;

  insert into bim.models (id, project_id, host_project_id, revision, lease_generation, settings)
  values (p_model_id, v_local_project, p_host_project_id, 0, 0, p_settings)
  on conflict (id) do nothing;

  select m.host_project_id into v_host from bim.models m where m.id = p_model_id;
  return v_host;
end;
$$;

-- Only the authority's own database role calls this (it owns it). Never the Data API.
revoke all on function bim.provision_hosted_model(text, uuid, text, jsonb) from public, anon, authenticated;
