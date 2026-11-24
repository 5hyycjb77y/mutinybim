-- Initial schema for the hosted MutinyBIM web app (apps/mutinybim-web) on Postgres / Supabase.
-- Mirrors the local SQLite store in src/db.ts while locking all tables down to server-only access
-- (RLS enabled, all anon/authenticated privileges revoked, service_role granted).

CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  color_scheme TEXT NOT NULL DEFAULT 'system' CHECK (color_scheme IN ('light', 'dark', 'system')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON public.users (LOWER(email));

CREATE TABLE IF NOT EXISTS public.identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_user_idx ON public.identities (user_id);

CREATE TABLE IF NOT EXISTS public.sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  via TEXT NOT NULL DEFAULT 'password'
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON public.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON public.sessions (expires_at);

CREATE TABLE IF NOT EXISTS public.models (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS models_owner_idx ON public.models (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  last4 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_keys_user_idx ON public.agent_keys (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.oauth_clients (
  provider TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, redirect_uri)
);

CREATE TABLE IF NOT EXISTS public.model_shares (
  model_id TEXT NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  invited_by TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, user_id)
);
CREATE INDEX IF NOT EXISTS model_shares_user_idx ON public.model_shares (user_id);
CREATE INDEX IF NOT EXISTS model_shares_invited_by_idx ON public.model_shares (invited_by);

CREATE TABLE IF NOT EXISTS public.password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON public.password_resets (user_id);

CREATE TABLE IF NOT EXISTS public.assistant_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris JSONB NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'metadata')),
  token_auth_method TEXT NOT NULL DEFAULT 'none' CHECK (token_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  secret_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.assistant_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_codes_user_idx ON public.assistant_codes (user_id);

CREATE TABLE IF NOT EXISTS public.assistant_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  previous_refresh_hash TEXT,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS assistant_grants_user_idx ON public.assistant_grants (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_grants_prev_refresh_idx ON public.assistant_grants (previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.assistant_approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  details JSONB NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'retry')),
  key TEXT,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'approved', 'declined', 'landed', 'failed', 'expired')),
  outcome TEXT,
  landing JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_approvals_user_idx ON public.assistant_approvals (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.assistant_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES public.assistant_grants(id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  families JSONB NOT NULL,
  run_id TEXT NOT NULL,
  init JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_sessions_user_idx ON public.assistant_sessions (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS assistant_sessions_grant_idx ON public.assistant_sessions (grant_id);

CREATE TABLE IF NOT EXISTS public.assistant_kept_scripts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body JSONB NOT NULL,
  expires_at BIGINT NOT NULL,
  saved_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_kept_scripts_user_idx ON public.assistant_kept_scripts (user_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS public.oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_created_idx ON public.oauth_states (created_at);

CREATE TABLE IF NOT EXISTS public.linked_grants (
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_cipher TEXT NOT NULL,
  refresh_cipher TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'reconnect')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS public.linked_models (
  alias_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  remote_model_id TEXT NOT NULL,
  remote_project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  can_edit BOOLEAN NOT NULL,
  open_url TEXT,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, remote_model_id)
);
CREATE INDEX IF NOT EXISTS linked_models_user_provider_idx ON public.linked_models (user_id, provider, label);

CREATE TABLE IF NOT EXISTS public.linked_offers (
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

-- Lock down every table: RLS on with no anon/authenticated policies, and explicit REVOKE.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'users', 'identities', 'sessions', 'models', 'agent_keys', 'oauth_clients',
    'model_shares', 'password_resets', 'assistant_clients', 'assistant_codes',
    'assistant_grants', 'assistant_approvals', 'assistant_sessions',
    'assistant_kept_scripts', 'oauth_states', 'linked_grants', 'linked_models',
    'linked_offers'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);
  END LOOP;
END $$;

-- Atomic single-use OAuth state take.
CREATE OR REPLACE FUNCTION public.web_take_oauth_state(p_state TEXT)
RETURNS TABLE (
  state TEXT,
  provider TEXT,
  code_verifier TEXT,
  return_to TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  DELETE FROM public.oauth_states s
  WHERE s.state = p_state
    AND s.created_at > now() - interval '15 minutes'
  RETURNING s.state, s.provider, s.code_verifier, s.return_to, s.created_at;
END;
$$;

-- Atomic single-use assistant authorization code take.
CREATE OR REPLACE FUNCTION public.web_take_assistant_code(p_code_hash TEXT)
RETURNS TABLE (
  client_id TEXT,
  user_id TEXT,
  redirect_uri TEXT,
  code_challenge TEXT,
  resource TEXT,
  scope TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  DELETE FROM public.assistant_codes c
  WHERE c.code_hash = p_code_hash
    AND c.expires_at > now()
  RETURNING c.client_id, c.user_id, c.redirect_uri, c.code_challenge, c.resource, c.scope;
END;
$$;

-- Atomic refresh-token rotation with reuse detection (deletes grant if previous refresh token is replayed).
CREATE OR REPLACE FUNCTION public.web_rotate_assistant_refresh(
  p_refresh_hash TEXT,
  p_client_id TEXT,
  p_next_access_hash TEXT,
  p_next_access_expires_at TIMESTAMPTZ,
  p_next_refresh_hash TEXT,
  p_next_refresh_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reused public.assistant_grants%ROWTYPE;
  v_grant public.assistant_grants%ROWTYPE;
BEGIN
  SELECT * INTO v_reused
  FROM public.assistant_grants
  WHERE previous_refresh_hash = p_refresh_hash
  FOR UPDATE;

  IF FOUND THEN
    DELETE FROM public.assistant_grants WHERE id = v_reused.id;
    RETURN jsonb_build_object('status', 'reused');
  END IF;

  SELECT * INTO v_grant
  FROM public.assistant_grants
  WHERE refresh_hash = p_refresh_hash
    AND refresh_expires_at > now()
    AND client_id = p_client_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;

  UPDATE public.assistant_grants
  SET access_hash = p_next_access_hash,
      access_expires_at = p_next_access_expires_at,
      refresh_hash = p_next_refresh_hash,
      previous_refresh_hash = p_refresh_hash,
      refresh_expires_at = p_next_refresh_expires_at
  WHERE id = v_grant.id
  RETURNING * INTO v_grant;

  RETURN jsonb_build_object('status', 'ok', 'grant', to_jsonb(v_grant));
END;
$$;

-- Atomic assistant token revocation (access or refresh token).
CREATE OR REPLACE FUNCTION public.web_revoke_assistant_token(p_token_hash TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id TEXT;
BEGIN
  DELETE FROM public.assistant_grants
  WHERE access_hash = p_token_hash OR refresh_hash = p_token_hash
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Atomic kept-script upsert + trim to newest p_keep per user.
CREATE OR REPLACE FUNCTION public.web_save_kept_script(
  p_id TEXT,
  p_user_id TEXT,
  p_body JSONB,
  p_expires_at BIGINT,
  p_saved_at BIGINT,
  p_keep INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.assistant_kept_scripts WHERE expires_at <= p_saved_at;
  INSERT INTO public.assistant_kept_scripts (id, user_id, body, expires_at, saved_at)
  VALUES (p_id, p_user_id, p_body, p_expires_at, p_saved_at)
  ON CONFLICT (id) DO UPDATE
    SET body = EXCLUDED.body,
        expires_at = EXCLUDED.expires_at,
        saved_at = EXCLUDED.saved_at
    WHERE public.assistant_kept_scripts.user_id = EXCLUDED.user_id;

  DELETE FROM public.assistant_kept_scripts
  WHERE user_id = p_user_id
    AND id NOT IN (
      SELECT id FROM public.assistant_kept_scripts
      WHERE user_id = p_user_id
      ORDER BY saved_at DESC, id
      LIMIT p_keep
    );
END;
$$;

-- Atomic trim of assistant sessions to newest p_keep per user.
CREATE OR REPLACE FUNCTION public.web_trim_assistant_sessions(p_user_id TEXT, p_keep INT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.assistant_sessions
  WHERE user_id = p_user_id
    AND id NOT IN (
      SELECT id FROM public.assistant_sessions
      WHERE user_id = p_user_id
      ORDER BY last_seen_at DESC
      LIMIT p_keep
    );
END;
$$;

-- Atomic replacement of a user's linked-host models (preserving existing aliases).
CREATE OR REPLACE FUNCTION public.web_replace_linked_models(
  p_user_id TEXT,
  p_provider TEXT,
  p_rows JSONB
)
RETURNS SETOF public.linked_models
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item JSONB;
  v_keep TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    v_keep := array_append(v_keep, v_item->>'remote_model_id');
    INSERT INTO public.linked_models (
      alias_id, user_id, provider, remote_model_id, remote_project_id, label, can_edit, open_url, seen_at
    ) VALUES (
      v_item->>'alias_id',
      p_user_id,
      p_provider,
      v_item->>'remote_model_id',
      v_item->>'remote_project_id',
      v_item->>'label',
      (v_item->>'can_edit')::BOOLEAN,
      NULLIF(v_item->>'open_url', ''),
      now()
    )
    ON CONFLICT (user_id, provider, remote_model_id) DO UPDATE
      SET remote_project_id = EXCLUDED.remote_project_id,
          label = EXCLUDED.label,
          can_edit = EXCLUDED.can_edit,
          open_url = EXCLUDED.open_url,
          seen_at = EXCLUDED.seen_at;
  END LOOP;

  DELETE FROM public.linked_models
  WHERE user_id = p_user_id
    AND provider = p_provider
    AND NOT (remote_model_id = ANY(v_keep));

  RETURN QUERY
  SELECT * FROM public.linked_models
  WHERE user_id = p_user_id AND provider = p_provider
  ORDER BY label;
END;
$$;

REVOKE ALL ON FUNCTION public.web_take_oauth_state(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_take_assistant_code(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_rotate_assistant_refresh(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_revoke_assistant_token(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_save_kept_script(TEXT, TEXT, JSONB, BIGINT, BIGINT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_trim_assistant_sessions(TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_replace_linked_models(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.web_take_oauth_state(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_take_assistant_code(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_rotate_assistant_refresh(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_revoke_assistant_token(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_save_kept_script(TEXT, TEXT, JSONB, BIGINT, BIGINT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_trim_assistant_sessions(TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_replace_linked_models(TEXT, TEXT, JSONB) TO service_role;
