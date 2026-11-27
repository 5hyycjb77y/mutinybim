-- An operator vouches for an account's address (npm run web:confirm-email).
-- Keeps the first confirmation time. True when p_email is still the account's
-- address and is now confirmed; false, changing nothing, when it isn't.
CREATE OR REPLACE FUNCTION public.web_confirm_email_by_operator(p_user_id TEXT, p_email TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.users SET email_confirmed_at = COALESCE(email_confirmed_at, now())
    WHERE id = p_user_id AND lower(email) = lower(p_email);
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.web_confirm_email_by_operator(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_confirm_email_by_operator(TEXT, TEXT) TO service_role;
