-- Native identity and ownership storage, shared by the two installer streams.
-- Native: follows db/native's explicit host-independent storage baseline.
-- Hosted: follows the 16 immutable historical files; keeps all project columns,
-- constraints, policies and permission sources intact. No actor is backfilled.
-- Browser OIDC and the membership administration API are separate work.
set local lock_timeout = '3s';

-- A native baseline has already recorded its marker. An existing hosted
-- installation receives its marker here, in the same transaction as this file.
create table if not exists bim.installation (
  id boolean primary key default true check (id),
  mode text not null check (mode in ('native', 'hosted')),
  format_version integer not null check (format_version = 1)
);
insert into bim.installation(id,mode,format_version) values(true,'hosted',1)
on conflict (id) do nothing;
alter table bim.installation enable row level security;
revoke all on table bim.installation from public;

create table bim.people (
  person_id uuid primary key default gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 200)
);
create table bim.person_identities (
  issuer text not null check (char_length(issuer) between 1 and 1000),
  subject text not null check (char_length(subject) between 1 and 1000),
  person_id uuid not null references bim.people(person_id),
  primary key (issuer, subject)
);
create index person_identities_person_idx on bim.person_identities(person_id);

-- An operator-reviewed bridge, not identity inference. A historical namespace
-- and literal actor are explicitly attached to ONE verified issuer+subject.
-- Historical changesets, creator JSON and grant strings remain byte-for-byte.
create table bim.legacy_identity_mappings (
  authority_namespace text not null,
  legacy_actor_id text not null,
  issuer text not null,
  subject text not null,
  mapped_by text not null,
  reason text not null check (char_length(reason) > 0),
  mapped_at timestamptz not null default now(),
  primary key (authority_namespace, legacy_actor_id),
  foreign key (issuer, subject) references bim.person_identities(issuer, subject)
);

-- The native baseline supplies nullable project columns. The hosted original
-- NOT NULL constraint and project foreign key stay untouched on hosted stores.

create table bim.model_authority (
  model_id text primary key references bim.models(id) on delete cascade,
  permission_source text not null check (permission_source in ('native','project')),
  owner_person_id uuid references bim.people(person_id),
  authorization_revision bigint not null default 0 check (authorization_revision >= 0),
  check ((permission_source = 'native') = (owner_person_id is not null))
);
create table bim.model_members (
  model_id text not null references bim.model_authority(model_id) on delete cascade,
  person_id uuid not null references bim.people(person_id),
  role text not null check (role in ('viewer','editor','manager')),
  primary key (model_id, person_id)
);

-- Preserve every legacy root's project authority. No inferred native owner.
-- An older authority can still create a project row with no sidecar: a new
-- router must interpret missing metadata as project authority, never native.
insert into bim.model_authority(model_id, permission_source)
select id, 'project' from bim.models where base_model_id is null
and exists(select 1 from bim.installation where id and mode='hosted');

-- A native baseline can commit before this file if installation is interrupted.
-- Until all files finish, applications must not write models. Never silently
-- convert such a partial store's rows into hosted/project-controlled models.
do $$ begin
  if exists(select 1 from bim.installation where id and mode='native')
     and exists(select 1 from bim.models) then
    raise exception 'native installation is incomplete but model rows already exist; review the partial installation before proceeding' using errcode='55000';
  end if;
end $$;

create function bim.check_native_authority_shape() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_id text;
  v_ids text[];
  v_model bim.models%rowtype;
  v_auth bim.model_authority%rowtype;
begin
  if tg_table_name = 'models' then
    v_ids := case when tg_op = 'INSERT' then array[new.id]
                  when tg_op = 'DELETE' then array[old.id] else array[old.id,new.id] end;
  else
    v_ids := case when tg_op = 'INSERT' then array[new.model_id]
                  when tg_op = 'DELETE' then array[old.model_id] else array[old.model_id,new.model_id] end;
  end if;
  foreach v_id in array v_ids loop
  select * into v_model from bim.models where id = v_id;
  if not found then continue; end if; -- Cascading deletion is valid.
  select * into v_auth from bim.model_authority where model_id = v_id;
  if v_auth.model_id is not null and v_model.base_model_id is not null then
    raise exception 'authority belongs to a base model, not a child copy' using errcode='23514';
  end if;
  if v_auth.permission_source = 'native' then
    if v_model.project_id is not null or v_model.host_project_id is not null then
      raise exception 'native model must not acquire project authority' using errcode='23514';
    end if;
    if not exists (select 1 from bim.model_members
                   where model_id = v_id and person_id = v_auth.owner_person_id and role = 'manager') then
      raise exception 'native owner must be an existing manager member at commit' using errcode='23514';
    end if;
  elsif exists (select 1 from bim.model_members where model_id = v_id) then
    raise exception 'native members cannot override project authority' using errcode='23514';
  end if;
  if v_model.project_id is null then
    if v_model.base_model_id is null then
      if v_auth.permission_source is distinct from 'native' then
        raise exception 'a project-free base needs native ownership' using errcode='23514';
      end if;
    elsif not exists (select 1 from bim.model_authority
                      where model_id = v_model.base_model_id and permission_source = 'native') then
      raise exception 'a project-free copy needs a native base' using errcode='23514';
    end if;
  end if;
  if v_model.base_model_id is not null and exists (
    select 1 from bim.model_authority where model_id=v_model.base_model_id and permission_source='native'
  ) and (v_model.project_id is not null or v_model.host_project_id is not null) then
    raise exception 'a native child cannot acquire project authority' using errcode='23514';
  end if;
  end loop;
  return null;
end $$;

-- v1 has creation and membership management, not native ownership/source
-- transfer. Such a future operation needs its own reviewed transaction.
create function bim.native_authority_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (old.model_id,old.permission_source,old.owner_person_id) is distinct from
     (new.model_id,new.permission_source,new.owner_person_id) then
    raise exception 'authority identity, source and owner are immutable in this draft' using errcode='23514';
  end if;
  return new;
end $$;
create trigger native_authority_immutable before update on bim.model_authority
for each row execute function bim.native_authority_immutable();

create constraint trigger native_models_insert_shape
after insert on bim.models deferrable initially deferred
for each row execute function bim.check_native_authority_shape();
-- Lease renewals and revision writes do not queue ownership queries. Only
-- changes to model identity/authority columns need this deferred check.
create constraint trigger native_models_update_shape
after update on bim.models deferrable initially deferred
for each row when (
  (old.id,old.project_id,old.host_project_id,old.base_model_id) is distinct from
  (new.id,new.project_id,new.host_project_id,new.base_model_id)
) execute function bim.check_native_authority_shape();
create constraint trigger native_authority_shape
after insert or update or delete on bim.model_authority deferrable initially deferred
for each row execute function bim.check_native_authority_shape();
create constraint trigger native_members_shape
after insert or update or delete on bim.model_members deferrable initially deferred
for each row execute function bim.check_native_authority_shape();

create function bim.create_native_model(p_model_id text, p_owner uuid, p_settings jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not exists(select 1 from bim.installation where id and mode='native') then
    raise exception 'create_native_model requires a native installation' using errcode='22023';
  end if;
  if p_model_id is null or p_model_id = '' or strpos(p_model_id, '~') > 0 then
    raise exception 'a native base model id is required' using errcode='22023';
  end if;
  if not exists(select 1 from bim.people where person_id = p_owner) then
    raise exception 'operator must designate an existing native person' using errcode='23503';
  end if;
  insert into bim.models(id, project_id, settings) values(p_model_id, null, p_settings);
  insert into bim.model_authority(model_id,permission_source,owner_person_id,authorization_revision)
  values(p_model_id,'native',p_owner,1);
  insert into bim.model_members(model_id,person_id,role) values(p_model_id,p_owner,'manager');
end $$;

-- The authority/operator DB role is trusted. Browsers do not call these SQL
-- functions or supply their actor identity directly to a privileged endpoint.
alter table bim.people enable row level security;
alter table bim.person_identities enable row level security;
alter table bim.legacy_identity_mappings enable row level security;
alter table bim.model_authority enable row level security;
alter table bim.model_members enable row level security;
revoke all on bim.people, bim.person_identities, bim.legacy_identity_mappings,
  bim.model_authority, bim.model_members from public;
revoke all on function bim.create_native_model(text,uuid,jsonb) from public;
revoke all on function bim.check_native_authority_shape() from public;
revoke all on function bim.native_authority_immutable() from public;
-- A native database uses its owning installation role and needs no cluster
-- roles. Preserve the existing hosted service role's access where it exists.
do $$ begin
  if exists(select 1 from bim.installation where id and mode='hosted')
     and exists(select 1 from pg_roles where rolname='service_role') then
    grant select on table bim.installation to service_role;
    grant select,insert,update,delete on bim.people, bim.person_identities,
      bim.legacy_identity_mappings, bim.model_authority, bim.model_members to service_role;
  end if;
end $$;
