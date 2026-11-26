-- Shared migration ledger, native-only storage. Hosted installations record
-- this file without changing their tables, policies, roles or permissions.
-- Keep the reviewed native baseline and all historical files immutable.
set local lock_timeout = '3s';

do $migration$
declare
  installation_mode text;
  browser_role text;
begin
  select mode into installation_mode from bim.installation where id;
  if installation_mode = 'hosted' then return; end if;
  if installation_mode is distinct from 'native' then
    raise exception 'native session storage requires a recorded installation mode' using errcode = '55000';
  end if;

  create table bim.native_signin_transactions (
    transaction_id uuid primary key,
    state_digest text not null unique check (length(state_digest) = 64 and state_digest ~ '^[0-9a-f]{64}$'),
    browser_binding_digest text not null check (length(browser_binding_digest) = 64 and browser_binding_digest ~ '^[0-9a-f]{64}$'),
    issuer text collate "C" not null check (octet_length(issuer) between 1 and 1000),
    client_id text not null check (octet_length(client_id) between 1 and 2000),
    redirect_uri text not null check (octet_length(redirect_uri) between 1 and 2000),
    nonce text,
    code_verifier text,
    status text not null default 'pending' check (status in ('pending', 'claimed', 'completed', 'failed')),
    created_at timestamptz not null,
    expires_at timestamptz not null check (expires_at > created_at),
    claim_digest text check (length(claim_digest) = 64 and claim_digest ~ '^[0-9a-f]{64}$'),
    claimed_at timestamptz,
    completed_at timestamptz,
    failed_at timestamptz,
    person_id uuid references bim.people(person_id),
    completed_session_id uuid unique,
    unique (transaction_id, person_id),
    check (
      (status = 'pending' and nonce is not null and code_verifier is not null
        and length(nonce) = 43 and nonce ~ '^[A-Za-z0-9_-]{43}$'
        and length(code_verifier) = 43 and code_verifier ~ '^[A-Za-z0-9_-]{43}$'
        and claim_digest is null and claimed_at is null and completed_at is null
        and failed_at is null and person_id is null and completed_session_id is null)
      or
      (status = 'claimed' and nonce is null and code_verifier is null
        and claim_digest is not null and claimed_at is not null and completed_at is null
        and failed_at is null and person_id is null and completed_session_id is null)
      or
      (status = 'completed' and nonce is null and code_verifier is null
        and claim_digest is null and claimed_at is not null and completed_at is not null
        and failed_at is null and person_id is not null and completed_session_id is not null)
      or
      (status = 'failed' and nonce is null and code_verifier is null
        and claim_digest is null and claimed_at is not null and completed_at is null
        and failed_at is not null and person_id is null and completed_session_id is null)
    )
  );
  create index native_signin_expiry_idx on bim.native_signin_transactions(expires_at);

  create table bim.native_sessions (
    session_id uuid primary key,
    transaction_id uuid not null unique,
    person_id uuid not null references bim.people(person_id),
    token_digest text not null unique check (length(token_digest) = 64 and token_digest ~ '^[0-9a-f]{64}$'),
    issued_at timestamptz not null,
    expires_at timestamptz not null check (expires_at > issued_at),
    revoked_at timestamptz,
    unique (session_id, transaction_id, person_id),
    foreign key (transaction_id, person_id)
      references bim.native_signin_transactions(transaction_id, person_id)
      deferrable initially deferred
  );
  -- Commit cannot leave a completion pointing at a missing/different session,
  -- nor a session attached to an uncompleted transaction or different person.
  alter table bim.native_signin_transactions add constraint native_signin_completed_session_fk
    foreign key (completed_session_id, transaction_id, person_id)
    references bim.native_sessions(session_id, transaction_id, person_id)
    deferrable initially deferred;
  create index native_sessions_person_idx on bim.native_sessions(person_id);
  create index native_sessions_expiry_idx on bim.native_sessions(expires_at);

  alter table bim.native_signin_transactions enable row level security;
  alter table bim.native_sessions enable row level security;
  revoke all on bim.native_signin_transactions, bim.native_sessions from public;
  -- Also neutralize any inherited hosted-role defaults in a reused cluster.
  -- The native authority uses the trusted owning database role, as in the installer.
  foreach browser_role in array array['anon', 'authenticated', 'service_role'] loop
    if browser_role <> current_user and exists(select 1 from pg_roles where rolname = browser_role) then
      execute format('revoke all on bim.native_signin_transactions, bim.native_sessions from %I', browser_role);
    end if;
  end loop;
end
$migration$;
