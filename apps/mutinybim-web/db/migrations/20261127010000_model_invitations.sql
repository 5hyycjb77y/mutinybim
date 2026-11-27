-- Invitations to a native hosted model (#26, #27). The owner names an email
-- address and nothing looks up whether an account uses it. A share is made only
-- when an account whose confirmed address matches accepts, while the inviter
-- still owns the model. Only the digest of the invitation link is kept.
CREATE TABLE IF NOT EXISTS public.model_invitations (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email = lower(email)),
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'accepted', 'declined', 'cancelled')),
  answered_by TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  answered_at TIMESTAMPTZ,
  CHECK ((state = 'open') = (answered_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS model_invitations_open ON public.model_invitations (model_id, email) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS model_invitations_inbox ON public.model_invitations (email, expires_at) WHERE state = 'open';
ALTER TABLE public.model_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.model_invitations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.model_invitations TO service_role;

-- A handover ends the open invitations, so they can't come back if the model is handed back.
CREATE OR REPLACE FUNCTION public.web_end_model_invitations() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.model_invitations SET state = 'cancelled', answered_at = clock_timestamp() WHERE model_id = NEW.id AND state = 'open';
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.web_end_model_invitations() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS end_invitations_on_handover ON public.models;
CREATE TRIGGER end_invitations_on_handover AFTER UPDATE OF owner_id ON public.models
  FOR EACH ROW WHEN (OLD.owner_id IS DISTINCT FROM NEW.owner_id) EXECUTE FUNCTION public.web_end_model_invitations();

-- Saves an invitation, replacing an open one for the same address. False when
-- the model isn't the owner's.
CREATE OR REPLACE FUNCTION public.web_create_model_invitation(
  p_id TEXT, p_model TEXT, p_owner TEXT, p_email TEXT, p_role TEXT, p_token_hash TEXT, p_expires_at TIMESTAMPTZ
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('mutinybim-web:model-access', 0));
  PERFORM 1 FROM public.models WHERE id = p_model AND owner_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  UPDATE public.model_invitations SET state = 'cancelled', answered_at = clock_timestamp()
    WHERE model_id = p_model AND email = lower(p_email) AND state = 'open';
  INSERT INTO public.model_invitations (id, model_id, email, role, token_hash, invited_by, created_at, expires_at, state)
    VALUES (p_id, p_model, lower(p_email), p_role, p_token_hash, p_owner, clock_timestamp(), p_expires_at, 'open');
  RETURN TRUE;
END;
$$;

-- Open, unexpired invitations for an address or a link, while each inviter
-- still owns its model. One of the two arguments is given.
CREATE OR REPLACE FUNCTION public.web_open_model_invitations(p_email TEXT, p_token_hash TEXT)
RETURNS TABLE (
  id TEXT, model_id TEXT, email TEXT, role TEXT, invited_by TEXT, created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  model_name TEXT, inviter_name TEXT
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT i.id, i.model_id, i.email, i.role, i.invited_by, i.created_at, i.expires_at, m.name, u.display_name
  FROM public.model_invitations AS i
  JOIN public.models AS m ON m.id = i.model_id AND m.owner_id = i.invited_by
  JOIN public.users AS u ON u.id = i.invited_by
  WHERE i.state = 'open' AND i.expires_at > now()
    AND (p_email IS NULL OR i.email = lower(p_email))
    AND (p_token_hash IS NULL OR i.token_hash = p_token_hash)
    AND (p_email IS NOT NULL OR p_token_hash IS NOT NULL)
  ORDER BY i.created_at, i.id
$$;

-- Answers an open, unexpired invitation for the account's current, confirmed
-- address, while the inviter still owns the model. Accepting saves the
-- personal share; an existing share takes the new role and keeps its grant.
CREATE OR REPLACE FUNCTION public.web_respond_model_invitation(p_id TEXT, p_user TEXT, p_action TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  invitation public.model_invitations;
  result_state TEXT;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('accept', 'decline') THEN RAISE EXCEPTION 'Invalid invitation action'; END IF;
  -- The same order as handover acceptance: access guard, account rows, then model rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('mutinybim-web:model-access', 0));
  SELECT i.* INTO invitation FROM public.model_invitations AS i
    JOIN public.users AS u ON u.id = p_user AND lower(u.email) = i.email AND u.email_confirmed_at IS NOT NULL
    JOIN public.models AS m ON m.id = i.model_id AND m.owner_id = i.invited_by AND m.owner_id <> u.id
    WHERE i.id = p_id AND i.state = 'open' AND i.expires_at > clock_timestamp()
    FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  result_state := CASE WHEN p_action = 'accept' THEN 'accepted' ELSE 'declined' END;
  UPDATE public.model_invitations SET state = result_state, answered_by = p_user, answered_at = clock_timestamp() WHERE id = p_id;
  IF result_state = 'accepted' THEN
    INSERT INTO public.model_shares (model_id, user_id, role, invited_by)
      VALUES (invitation.model_id, p_user, invitation.role, invitation.invited_by)
      ON CONFLICT (model_id, user_id) DO UPDATE SET role = excluded.role;
  END IF;
  RETURN result_state;
END;
$$;

REVOKE ALL ON FUNCTION public.web_create_model_invitation(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_open_model_invitations(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_respond_model_invitation(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_create_model_invitation(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_open_model_invitations(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_respond_model_invitation(TEXT, TEXT, TEXT) TO service_role;
