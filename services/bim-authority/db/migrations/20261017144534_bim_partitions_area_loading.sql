-- MutinyBIM feasibility (disposable stacks only): area-based loading for
-- candidate A. Every element belongs to one partition (level, zone,
-- discipline); a person loads only the partitions of their area.

-- 1. Element partition columns, derived from the element body. Commands never
--    move an element to another partition, and every existing write path
--    (seed, reset, commit upserts) keeps working unchanged. Elements of the
--    original duct-only models carry no partition: they belong to L1|Z1|mechanical.
alter table bim.elements
  add column level text generated always as (coalesce(body->'partition'->>'level', 'L1')) stored,
  add column zone text generated always as (coalesce(body->'partition'->>'zone', 'Z1')) stored,
  add column discipline text generated always as (coalesce(body->'partition'->>'discipline', 'mechanical')) stored;

-- Matches the slice filter (model, then partition) and keeps its order.
create index elements_partition_idx on bim.elements (model_id, level, zone, discipline, element_id);

-- 2. Connection partitions: a connection takes the partition of its first end.
--    Generated systems never leave their partition, so both ends agree; the
--    client still keeps only connections whose two ends it holds.
alter table bim.connections
  add column level text,
  add column zone text,
  add column discipline text;

create function bim.set_connection_partition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Bulk loads supply the partition from a join; single inserts look it up here.
  if new.level is not null and new.zone is not null and new.discipline is not null then
    return new;
  end if;
  select e.level, e.zone, e.discipline
    into new.level, new.zone, new.discipline
  from bim.elements e
  where e.model_id = new.model_id and e.element_id = new.a_element;
  if new.level is null then
    raise exception 'connection % in model % names unknown element %', new.connection_id, new.model_id, new.a_element;
  end if;
  return new;
end;
$$;

create trigger connections_partition
  before insert or update of a_element on bim.connections
  for each row execute function bim.set_connection_partition();

update bim.connections c
set level = e.level, zone = e.zone, discipline = e.discipline
from bim.elements e
where e.model_id = c.model_id and e.element_id = c.a_element;

alter table bim.connections
  alter column level set not null,
  alter column zone set not null,
  alter column discipline set not null;

create index connections_partition_idx on bim.connections (model_id, level, zone, discipline, ordinal);

-- 3. Which partitions a model has, with element counts, so a client can turn
--    its area into partition keys and fetch them in bounded pages.
--    SECURITY INVOKER: the caller's row-level security applies.
create function bim.model_partitions(p_model_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'revision', m.revision,
    'partitions', coalesce(
      (select jsonb_agg(jsonb_build_object('key', p.level || '|' || p.zone || '|' || p.discipline, 'elements', p.n)
                        order by p.level, p.zone, p.discipline)
       from (select e.level, e.zone, e.discipline, count(*) as n
             from bim.elements e
             where e.model_id = m.id
             group by e.level, e.zone, e.discipline) p),
      '[]'::jsonb)
  )
  from bim.models m
  where m.id = p_model_id
$$;

revoke all on function bim.model_partitions(text) from public;
grant execute on function bim.model_partitions(text) to authenticated;

-- 4. One page of an area: the elements and connections of the given partition
--    keys (`level|zone|discipline`) plus the revision they were read at, in one
--    statement (one snapshot). Callers keep pages to a few thousand elements.
create function bim.model_slice(p_model_id text, p_partitions text[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with keys as (
    select split_part(k, '|', 1) as level, split_part(k, '|', 2) as zone, split_part(k, '|', 3) as discipline
    from unnest(p_partitions) as k
  )
  select jsonb_build_object(
    'modelId', m.id,
    'revision', m.revision,
    'settings', m.settings,
    'elements', coalesce(
      (select jsonb_agg(e.body order by e.element_id)
       from keys k
       join bim.elements e
         on e.model_id = m.id and e.level = k.level and e.zone = k.zone and e.discipline = k.discipline),
      '[]'::jsonb),
    'connections', coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'id', c.connection_id,
                  'a', jsonb_build_object('elementId', c.a_element, 'end', c.a_end),
                  'b', jsonb_build_object('elementId', c.b_element, 'end', c.b_end))
                order by c.ordinal)
       from keys k
       join bim.connections c
         on c.model_id = m.id and c.level = k.level and c.zone = k.zone and c.discipline = k.discipline),
      '[]'::jsonb)
  )
  from bim.models m
  where m.id = p_model_id
$$;

revoke all on function bim.model_slice(text, text[]) from public;
grant execute on function bim.model_slice(text, text[]) to authenticated;
