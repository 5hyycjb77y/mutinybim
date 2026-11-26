-- Native PostgreSQL 17 storage baseline, derived from the authority at
-- d5c6a4289a7b1a0cbc3a5e11cc26977e6f30eca7. This is a distinct migration
-- history: it does not claim that the sixteen hosted SQL files were applied.
-- The CLI runs this only for an empty native installation, under its normal
-- migration lock and transaction. Never run it against a hosted installation.
--
-- The trusted authority connects as the installing owner. RLS is enabled with
-- no client policies and PUBLIC receives no object privileges. There are no
-- global roles, project tables, auth/realtime shims, or hosted provisioning
-- function. project_id and host_project_id remain nullable UUID columns because
-- the existing copy writers explicitly copy them, including their NULL values.
-- gen_random_uuid() is built into PostgreSQL 17; no extension is required.

create schema if not exists bim;
revoke all on schema bim from public;

create table bim.installation (
  id boolean primary key default true check (id),
  mode text not null check (mode in ('native', 'hosted')),
  format_version integer not null check (format_version = 1)
);
comment on table bim.installation is
  'Installation lineage. Native baseline 20261125000000 derives storage from d5c6a4289a7b1a0cbc3a5e11cc26977e6f30eca7; historical hosted migrations were not applied.';
insert into bim.installation (id, mode, format_version) values (true, 'native', 1);

create table bim.models (
  id text primary key,
  project_id uuid,
  revision bigint not null default 0,
  lease_generation bigint not null default 0,
  settings jsonb not null,
  created_at timestamptz not null default now(),
  host_project_id uuid,
  lease_owner text,
  lease_owner_machine text,
  lease_expires_at timestamptz,
  base_model_id text references bim.models (id) on delete cascade,
  base_revision bigint,
  branch_name text,
  branch_state text,
  branch_created_by text,
  branch_created_at timestamptz,
  constraint bim_models_native_project_absent check (project_id is null and host_project_id is null),
  constraint bim_models_settings_is_object check (jsonb_typeof(settings) = 'object'),
  constraint bim_models_branch_shape check (
    (base_model_id is null and base_revision is null and branch_name is null and branch_state is null and branch_created_by is null and branch_created_at is null)
    or (
      base_model_id is not null and base_revision is not null and base_revision >= 0
      and branch_name is not null and char_length(branch_name) between 1 and 80
      and branch_state in ('open', 'merge_proposed', 'merged', 'closed')
      and branch_created_by is not null and branch_created_at is not null
      and left(id, char_length(base_model_id) + 1) = base_model_id || '~'
    )
  )
);
comment on column bim.models.project_id is
  'Nullable compatibility column for existing model/copy storage. Native models have no hosted project dependency.';
comment on column bim.models.host_project_id is
  'Nullable hosted routing identifier retained for existing copy writers. Native installations do not provision hosted projects.';
comment on column bim.models.lease_owner is
  'Authority process holding the lease, unique per process start.';
comment on column bim.models.lease_owner_machine is
  'Machine id of the lease holder, never taken from the client.';
comment on column bim.models.lease_expires_at is
  'The lease is held only while this is later than the database clock.';
comment on column bim.models.lease_generation is
  'Ownership term. Renewal keeps it; every new term increments it. Commits are fenced on it.';


create table bim.elements (
  model_id text not null references bim.models(id) on delete cascade,
  element_id text not null,
  kind text not null,
  version bigint not null,
  body jsonb not null,
  primary key (model_id, element_id),
  level text generated always as (coalesce(body->'partition'->>'level', 'L1')) stored,
  zone text generated always as (coalesce(body->'partition'->>'zone', 'Z1')) stored,
  discipline text generated always as (coalesce(body->'partition'->>'discipline', 'mechanical')) stored
);

create table bim.changesets (
  model_id text not null references bim.models(id) on delete cascade,
  revision bigint not null,
  idempotency_key text not null,
  actor_id text not null,
  actor_kind text not null,
  body jsonb not null,
  committed_at timestamptz not null default now(),
  patch jsonb,
  primary key (model_id, revision),
  unique (model_id, idempotency_key)
);

create table bim.command_outcomes (
  model_id text not null references bim.models(id) on delete cascade,
  idempotency_key text not null,
  actor_id text not null,
  outcome jsonb not null,
  created_at timestamptz not null default now(),
  primary key (model_id, idempotency_key)
);

create table bim.connections (
  model_id text not null references bim.models(id) on delete cascade,
  connection_id text not null,
  ordinal integer not null,
  a_element text not null,
  a_end text not null,
  b_element text not null,
  b_end text not null,
  primary key (model_id, connection_id),
  level text not null,
  zone text not null,
  discipline text not null
);

create table bim.checkpoints (
  model_id text not null references bim.models (id) on delete cascade,
  revision bigint not null,
  element_count integer not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  primary key (model_id, revision)
);

create table bim.history_pins (
  model_id text not null references bim.models (id) on delete cascade,
  revision bigint not null check (revision >= 0),
  pinned_by text not null check (pinned_by ~ '^(branch|version):.+$'),
  created_at timestamptz not null default now(),
  primary key (model_id, pinned_by)
);

create table bim.saved_versions (
  version_id uuid primary key default gen_random_uuid(),
  model_id text not null references bim.models (id) on delete cascade,
  revision bigint not null check (revision >= 0),
  name text not null check (char_length(name) between 1 and 80),
  saved_by text not null,
  saved_at timestamptz not null default now()
);

create table bim.import_runs (
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

create table bim.validation_states (
  model_id text primary key references bim.models (id) on delete cascade,
  revision bigint not null,
  version integer not null,
  code_key text not null,
  element_count integer not null,
  body jsonb not null,
  written_at timestamptz not null default now()
);

create table bim.lineages (
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

create table bim.lineage_checkpoints (
  model_id text not null references bim.models (id) on delete cascade,
  revision bigint not null check (revision >= 0),
  fork_revision bigint not null check (fork_revision >= 0 and fork_revision <= revision),
  state_digest text not null check (state_digest ~ '^[0-9a-f]{64}$'),
  element_count integer not null check (element_count >= 0),
  chunk_count integer not null check (chunk_count >= 1),
  created_at timestamptz not null default now(),
  primary key (model_id, revision)
);

create table bim.lineage_checkpoint_chunks (
  model_id text not null,
  revision bigint not null,
  chunk integer not null check (chunk >= 0),
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  primary key (model_id, revision, chunk),
  foreign key (model_id, revision) references bim.lineage_checkpoints (model_id, revision) on delete cascade
);

create table bim.lineage_members (
  member_id uuid primary key default gen_random_uuid(),
  base_model_id text not null references bim.models (id) on delete cascade,
  lineage_id text not null check (char_length(lineage_id) between 1 and 64),
  user_id text not null check (char_length(user_id) between 1 and 200),
  capability text not null check (capability ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$' and char_length(capability) <= 64),
  granted_by text not null check (char_length(granted_by) between 1 and 200),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by text,
  check ((revoked_at is null) = (revoked_by is null))
);

-- Storage indexes retain the pinned hosted definitions.

create index models_project_id_idx on bim.models (project_id);

create index command_outcomes_actor_id_idx on bim.command_outcomes (actor_id, model_id);

create index connections_model_ordinal_idx on bim.connections (model_id, ordinal);

create index connections_a_element_idx on bim.connections (model_id, a_element);

create index connections_b_element_idx on bim.connections (model_id, b_element);

create index command_outcomes_created_at_idx on bim.command_outcomes (created_at);

create index elements_partition_idx on bim.elements (model_id, level, zone, discipline, element_id);

create index connections_partition_idx on bim.connections (model_id, level, zone, discipline, ordinal);

create index models_base_model_id_idx on bim.models (base_model_id) where base_model_id is not null;

create unique index models_open_branch_name_idx on bim.models (base_model_id, branch_name)
  where base_model_id is not null and branch_state in ('open', 'merge_proposed');

create index history_pins_model_revision_idx on bim.history_pins (model_id, revision);

create index saved_versions_model_revision_idx on bim.saved_versions (model_id, revision desc);

create index import_runs_branch_owner_idx on bim.import_runs (branch_model_id, created_by) where branch_model_id is not null;

create index import_runs_base_idx on bim.import_runs (base_model_id, started_at desc);

create index lineages_base_parent_idx on bim.lineages (base_model_id, parent_lineage_id);

create unique index lineage_members_live_idx on bim.lineage_members (base_model_id, lineage_id, user_id, capability)
  where revoked_at is null;

create index lineage_members_person_idx on bim.lineage_members (base_model_id, user_id) where revoked_at is null;

-- Bodies below are the final definitions at the pinned commit. The branch-
-- aware purge function preserves parent pins and every copy changeset.

create function bim.model_snapshot(p_model_id text)
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

create function bim.purge_command_outcomes(p_keep interval default interval '24 hours')
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

create function bim.acquire_model_lease(
  p_model_id text,
  p_owner text,
  p_owner_machine text,
  p_ttl_ms integer
)
returns table (acquired boolean, generation bigint, holder text, holder_machine text, expires_at timestamptz)
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_ttl_ms is null or p_ttl_ms < 1000 or p_ttl_ms > 120000 then
    raise exception 'lease ttl must be between 1 and 120 seconds (got % ms)', p_ttl_ms;
  end if;
  return query
    update bim.models m
       set lease_generation = case
             when m.lease_owner = p_owner and m.lease_expires_at > clock_timestamp() then m.lease_generation
             else m.lease_generation + 1
           end,
           lease_owner = p_owner,
           lease_owner_machine = p_owner_machine,
           lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0)
     where m.id = p_model_id
       and (m.lease_owner is null
            or m.lease_expires_at is null
            or m.lease_expires_at <= clock_timestamp()
            or m.lease_owner = p_owner)
    returning true, m.lease_generation, m.lease_owner, m.lease_owner_machine, m.lease_expires_at;
  if found then
    return;
  end if;
  return query
    select false, m.lease_generation, m.lease_owner, m.lease_owner_machine, m.lease_expires_at
      from bim.models m
     where m.id = p_model_id;
end;
$$;

create function bim.renew_model_lease(
  p_model_id text,
  p_owner text,
  p_generation bigint,
  p_ttl_ms integer
)
returns timestamptz
language sql
volatile
set search_path = ''
as $$
  update bim.models m
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0)
   where m.id = p_model_id
     and m.lease_owner = p_owner
     and m.lease_generation = p_generation
     and m.lease_expires_at > clock_timestamp()
  returning m.lease_expires_at;
$$;

create function bim.release_model_lease(
  p_model_id text,
  p_owner text,
  p_generation bigint
)
returns boolean
language sql
volatile
set search_path = ''
as $$
  with released as (
    update bim.models m
       set lease_expires_at = clock_timestamp()
     where m.id = p_model_id
       and m.lease_owner = p_owner
       and m.lease_generation = p_generation
       and m.lease_expires_at > clock_timestamp()
    returning 1
  )
  select exists (select 1 from released);
$$;

create function bim.model_lease_holder(p_model_id text)
returns table (holder_machine text, expires_at timestamptz, live boolean)
language sql
volatile
set search_path = ''
as $$
  select m.lease_owner_machine, m.lease_expires_at, coalesce(m.lease_expires_at > clock_timestamp(), false)
    from bim.models m
   where m.id = p_model_id;
$$;

create function bim.purge_changesets(
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

create trigger connections_partition
  before insert or update of a_element on bim.connections
  for each row execute function bim.set_connection_partition();

-- Only the installing owner accesses native storage. Future application
-- grants must be explicit; no host role or authentication policy is simulated.

alter table bim.installation enable row level security;

alter table bim.models enable row level security;

alter table bim.elements enable row level security;

alter table bim.changesets enable row level security;

alter table bim.command_outcomes enable row level security;

alter table bim.connections enable row level security;

alter table bim.checkpoints enable row level security;

alter table bim.history_pins enable row level security;

alter table bim.saved_versions enable row level security;

alter table bim.import_runs enable row level security;

alter table bim.validation_states enable row level security;

alter table bim.lineages enable row level security;

alter table bim.lineage_checkpoints enable row level security;

alter table bim.lineage_checkpoint_chunks enable row level security;

alter table bim.lineage_members enable row level security;

revoke all on table bim.installation, bim.models, bim.elements, bim.changesets, bim.command_outcomes, bim.connections, bim.checkpoints, bim.history_pins, bim.saved_versions, bim.import_runs, bim.validation_states, bim.lineages, bim.lineage_checkpoints, bim.lineage_checkpoint_chunks, bim.lineage_members from public;

revoke all on function bim.model_snapshot(text) from public;

revoke all on function bim.purge_command_outcomes(interval) from public;

revoke all on function bim.set_connection_partition() from public;

revoke all on function bim.model_partitions(text) from public;

revoke all on function bim.model_slice(text, text[]) from public;

revoke all on function bim.acquire_model_lease(text, text, text, integer) from public;

revoke all on function bim.renew_model_lease(text, text, bigint, integer) from public;

revoke all on function bim.release_model_lease(text, text, bigint) from public;

revoke all on function bim.model_lease_holder(text) from public;

revoke all on function bim.purge_changesets(text, bigint, interval, integer) from public;
