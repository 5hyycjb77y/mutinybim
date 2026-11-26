-- A configured provider can confirm the current address of its linked account.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.web_confirm_oidc_email(
  p_provider TEXT, p_subject TEXT, p_user_id TEXT, p_email TEXT
) RETURNS VOID
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  UPDATE public.users AS u SET email_confirmed_at = now()
  WHERE u.id = p_user_id AND lower(u.email) = lower(p_email)
    AND u.email_confirmed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.identities AS i
      WHERE i.provider = p_provider AND i.subject = p_subject AND i.user_id = u.id
    );
$$;

REVOKE ALL ON FUNCTION public.web_confirm_oidc_email(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_confirm_oidc_email(TEXT, TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.web_clear_email_confirmation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
BEGIN
  NEW.email_confirmed_at := NULL;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.web_clear_email_confirmation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS users_clear_email_confirmation ON public.users;
CREATE TRIGGER users_clear_email_confirmation BEFORE UPDATE OF email ON public.users
  FOR EACH ROW WHEN (lower(OLD.email) <> lower(NEW.email))
  EXECUTE FUNCTION public.web_clear_email_confirmation();
