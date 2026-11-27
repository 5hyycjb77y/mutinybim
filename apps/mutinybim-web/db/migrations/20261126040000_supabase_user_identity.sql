-- A new hosted account and its Supabase sign-in must survive a retry together.
CREATE OR REPLACE FUNCTION public.web_create_supabase_user(p_id TEXT, p_email TEXT, p_display_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, email, display_name, created_at)
    VALUES (p_id, lower(p_email), p_display_name, now());
  INSERT INTO public.identities (provider, subject, user_id, created_at)
    VALUES ('supabase', p_id, p_id, now());
  RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
  -- Both inserts in this block roll back, including a user whose subject
  -- was already attached to a different account.
  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.web_create_supabase_user(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_create_supabase_user(TEXT, TEXT, TEXT) TO service_role;

-- Match the unique index, including the original casing of imported accounts.
CREATE OR REPLACE FUNCTION public.web_user_by_email(p_email TEXT)
RETURNS SETOF public.users
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT u.* FROM public.users AS u WHERE lower(u.email) = lower(p_email)
$$;

REVOKE ALL ON FUNCTION public.web_user_by_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_user_by_email(TEXT) TO service_role;
