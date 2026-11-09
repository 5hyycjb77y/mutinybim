-- MutinyBIM feasibility (disposable stacks only): which Polygnotos project a
-- model belongs to, so the model server can ask Polygnotos what a signed-in
-- person may do there. Null = the model is not linked to a Polygnotos project
-- and Polygnotos logins are refused for it.
alter table bim.models add column if not exists host_project_id uuid;

comment on column bim.models.host_project_id is
  'Polygnotos public.projects.id this model belongs to (checked through public.bim_project_capabilities on the Polygnotos database).';
