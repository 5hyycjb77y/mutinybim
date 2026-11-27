-- One-time links that confirm an account's address. Only each token's digest
-- is kept, with the address it was sent to; a link works for its own account.
CREATE TABLE IF NOT EXISTS public.email_confirmations (
  token_hash TEXT PRIMARY KEY,
  issue_order BIGINT GENERATED ALWAYS AS IDENTITY,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS email_confirmations_user_idx ON public.email_confirmations (user_id);
ALTER TABLE public.email_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.email_confirmations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.email_confirmations TO service_role;

-- Serialize issuance per account so delivery acknowledgements can retire older
-- links even when two SMTP sends finish in reverse order.
CREATE OR REPLACE FUNCTION public.web_stage_email_confirmation(p_token_hash TEXT, p_user_id TEXT, p_email TEXT, p_expires_at TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR NO KEY UPDATE;
  DELETE FROM public.email_confirmations WHERE expires_at <= now();
  INSERT INTO public.email_confirmations (token_hash, user_id, email, expires_at)
    VALUES (p_token_hash, p_user_id, p_email, p_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.web_deliver_email_confirmation(p_token_hash TEXT)
RETURNS VOID LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  DELETE FROM public.email_confirmations AS earlier USING public.email_confirmations AS sent
    WHERE sent.token_hash = p_token_hash AND sent.expires_at > now()
      AND earlier.user_id = sent.user_id AND earlier.issue_order < sent.issue_order;
$$;

REVOKE ALL ON FUNCTION public.web_stage_email_confirmation(TEXT,TEXT,TEXT,TIMESTAMPTZ), public.web_deliver_email_confirmation(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_stage_email_confirmation(TEXT,TEXT,TEXT,TIMESTAMPTZ), public.web_deliver_email_confirmation(TEXT) TO service_role;

-- Uses up the link and confirms the address in one statement's transaction.
-- True when the account's current address is the one the link was sent to.
CREATE OR REPLACE FUNCTION public.web_redeem_email_confirmation(p_token_hash TEXT, p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_email TEXT;
BEGIN
  PERFORM 1 FROM public.users WHERE id = p_user_id FOR NO KEY UPDATE;
  DELETE FROM public.email_confirmations AS c
  WHERE c.token_hash = p_token_hash AND c.user_id = p_user_id AND c.expires_at > now()
  RETURNING c.email INTO v_email;
  IF v_email IS NULL THEN
    RETURN FALSE;
  END IF;
  UPDATE public.users SET email_confirmed_at = COALESCE(email_confirmed_at, now())
  WHERE id = p_user_id AND lower(email) = lower(v_email);
  IF NOT FOUND THEN RETURN FALSE; END IF;
  DELETE FROM public.email_confirmations WHERE user_id = p_user_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.web_redeem_email_confirmation(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_redeem_email_confirmation(TEXT, TEXT) TO service_role;
