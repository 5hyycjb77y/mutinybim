-- MutinyBIM authority: a time-bounded lease per model, judged by the database clock.
--
-- One authority process owns a model at a time. It holds the lease only while
-- lease_expires_at is in the future by the database's own clock; renewals keep
-- the generation, and every new ownership term (a different process, or the
-- same process coming back after its lease ran out) increments it. Every
-- durable commit checks owner + generation + unexpired lease in the statement
-- that writes (services/bim-authority/src/pg-store.ts), so a process that was
-- paused past its lease cannot write when it wakes, even before anyone else
-- takes the model over.
--
-- clock_timestamp() rather than now(): now() is frozen at transaction start,
-- and a lease must be judged at the moment of the write.

alter table bim.models
  add column if not exists lease_owner text,
  add column if not exists lease_owner_machine text,
  add column if not exists lease_expires_at timestamptz;

comment on column bim.models.lease_owner is
  'Authority process holding the lease: <machine id>/<boot id>, unique per process start.';
comment on column bim.models.lease_owner_machine is
  'Fly machine id of the lease holder. Connections are replayed to it (fly-replay); never taken from the client.';
comment on column bim.models.lease_expires_at is
  'The lease is held only while this is later than the database clock.';
comment on column bim.models.lease_generation is
  'Ownership term. Renewal keeps it; every new term increments it. Commits are fenced on it.';

-- Take the lease when it is free, expired, or already ours and unexpired (a renewal
-- that keeps the generation). Anything else returns the current holder, not acquired.
create or replace function bim.acquire_model_lease(
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

-- Extend our own unexpired lease, keeping the generation. Null = the lease is
-- gone (expired, or another process holds it): the caller must stop committing.
create or replace function bim.renew_model_lease(
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

-- Give the lease up now (expire it) so another process can take the model at
-- once. Only the holder of this exact term can; the owner is kept for the record.
create or replace function bim.release_model_lease(
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

-- Where connections for a model should go: the machine holding an unexpired lease, if any.
create or replace function bim.model_lease_holder(p_model_id text)
returns table (holder_machine text, expires_at timestamptz, live boolean)
language sql
volatile
set search_path = ''
as $$
  select m.lease_owner_machine, m.lease_expires_at, coalesce(m.lease_expires_at > clock_timestamp(), false)
    from bim.models m
   where m.id = p_model_id;
$$;

-- Only the authority's own database role calls these (it owns them). Never the Data API.
revoke all on function bim.acquire_model_lease(text, text, text, integer) from public, anon, authenticated;
revoke all on function bim.renew_model_lease(text, text, bigint, integer) from public, anon, authenticated;
revoke all on function bim.release_model_lease(text, text, bigint) from public, anon, authenticated;
revoke all on function bim.model_lease_holder(text) from public, anon, authenticated;
