-- A reset link works exactly once: using it, saving the new password and
-- ending the account's sessions happen in one statement's transaction.
CREATE OR REPLACE FUNCTION public.web_redeem_password_reset(p_token_hash TEXT, p_password_hash TEXT)
RETURNS TEXT
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_user_id TEXT;
BEGIN
  -- A second caller waits on this row's lock, then finds it gone.
  DELETE FROM public.password_resets AS r
  WHERE r.token_hash = p_token_hash AND r.expires_at > now()
  RETURNING r.user_id INTO v_user_id;
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.users SET password_hash = p_password_hash WHERE id = v_user_id;
  DELETE FROM public.sessions WHERE user_id = v_user_id;
  RETURN v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.web_redeem_password_reset(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_redeem_password_reset(TEXT, TEXT) TO service_role;
