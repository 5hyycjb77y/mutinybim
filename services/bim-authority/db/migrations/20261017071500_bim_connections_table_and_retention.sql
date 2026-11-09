-- MutinyBIM feasibility: heavy-model storage pass (Supabase rules
-- schema-data-types / data access, query-missing-indexes, security-rls-performance,
-- monitor-vacuum-analyze). Disposable stacks only; not part of Hours' migrations.

-- 1. Connections become rows instead of one jsonb array on the model row: at
--    30k elements the array is ~3 MB and was read on every commit attempt.
--    Commands never change connections, so they are written at seed/reset only.
--    `ordinal` keeps the authored order so a loaded model is identical to the seeded one.
create table bim.connections (
  model_id text not null references bim.models(id) on delete cascade,
  connection_id text not null,
  ordinal integer not null,
  a_element text not null,
  a_end text not null,
  b_element text not null,
  b_end text not null,
  primary key (model_id, connection_id)
);
create index connections_model_ordinal_idx on bim.connections (model_id, ordinal);
create index connections_a_element_idx on bim.connections (model_id, a_element);
create index connections_b_element_idx on bim.connections (model_id, b_element);

grant select on bim.connections to authenticated;
grant select, insert, update, delete on bim.connections to service_role;
alter table bim.connections enable row level security;

create policy connections_select on bim.connections
  for select to authenticated using (
    model_id in (
      select m.id from bim.models m
      where public.has_project_access(m.project_id, (select auth.uid()))
    )
  );

insert into bim.connections (model_id, connection_id, ordinal, a_element, a_end, b_element, b_end)
select m.id, c->>'id', (x.ord - 1)::integer,
       c->'a'->>'elementId', c->'a'->>'end', c->'b'->>'elementId', c->'b'->>'end'
from bim.models m
cross join lateral jsonb_array_elements(m.connections) with ordinality as x(c, ord);

-- 2. Snapshot reads connections from the table (live definition exported from
--    the local stack; only the 'connections' entry changed).
create or replace function bim.model_snapshot(p_model_id text)
 returns jsonb
 language sql
 stable
 set search_path to ''
as $function$
  select jsonb_build_object(
    'modelId', m.id,
    'revision', m.revision,
    'settings', m.settings,
    'connections', coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'id', c.connection_id,
                  'a', jsonb_build_object('elementId', c.a_element, 'end', c.a_end),
                  'b', jsonb_build_object('elementId', c.b_element, 'end', c.b_end))
                order by c.ordinal)
       from bim.connections c where c.model_id = m.id),
      '[]'::jsonb
    ),
    'elements', coalesce(
      (select jsonb_object_agg(e.element_id, e.body) from bim.elements e where e.model_id = m.id),
      '{}'::jsonb
    )
  )
  from bim.models m
  where m.id = p_model_id
$function$;

-- One source of truth: the array is gone, so nothing can read a stale copy.
alter table bim.models drop column connections;

-- 3. Request answers are kept for a duplicate-request window, not forever.
--    Committed answers stay recoverable from bim.changesets (unique per key),
--    so a retry after the window is still never applied twice.
create index command_outcomes_created_at_idx on bim.command_outcomes (created_at);

create or replace function bim.purge_command_outcomes(p_keep interval default interval '24 hours')
 returns bigint
 language sql
 security invoker
 set search_path to ''
as $function$
  with gone as (
    delete from bim.command_outcomes where created_at < now() - p_keep returning 1
  )
  select count(*) from gone
$function$;

revoke all on function bim.purge_command_outcomes(interval) from public;
grant execute on function bim.purge_command_outcomes(interval) to service_role;
