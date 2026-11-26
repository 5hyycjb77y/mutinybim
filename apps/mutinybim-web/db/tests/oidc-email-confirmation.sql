-- Run after the hosted migrations on a disposable database with psql -X -v ON_ERROR_STOP=1.
BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE
  prior timestamptz := '2026-01-01T00:00:00Z';
  rpc text := 'public.web_confirm_oidc_email(text,text,text,text)';
BEGIN
  IF has_function_privilege('anon', rpc, 'EXECUTE') OR has_function_privilege('authenticated', rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'OIDC confirmation must be server-only';
  END IF;
  INSERT INTO public.users (id, email, display_name) VALUES
    ('oidc-bea', 'bea@example.test', 'Bea'), ('oidc-pat', 'pat@example.test', 'Pat');
  INSERT INTO public.identities (provider, subject, user_id) VALUES ('org', 'bea-sub', 'oidc-bea');

  PERFORM public.web_confirm_oidc_email('other', 'bea-sub', 'oidc-bea', 'bea@example.test');
  PERFORM public.web_confirm_oidc_email('org', 'different', 'oidc-bea', 'bea@example.test');
  PERFORM public.web_confirm_oidc_email('org', 'bea-sub', 'oidc-pat', 'pat@example.test');
  PERFORM public.web_confirm_oidc_email('org', 'bea-sub', 'oidc-bea', 'b_a@example.test');
  IF EXISTS (SELECT 1 FROM public.users WHERE id IN ('oidc-bea', 'oidc-pat') AND email_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A different identity or address confirmed an account';
  END IF;
  PERFORM public.web_confirm_oidc_email('org', 'bea-sub', 'oidc-bea', 'BEA@example.test');
  IF (SELECT email_confirmed_at FROM public.users WHERE id = 'oidc-bea') IS NULL THEN
    RAISE EXCEPTION 'The matching identity and address were not confirmed';
  END IF;

  UPDATE public.users SET email_confirmed_at = prior WHERE id = 'oidc-bea';
  UPDATE public.users SET email = 'BEA@EXAMPLE.TEST' WHERE id = 'oidc-bea';
  PERFORM public.web_confirm_oidc_email('org', 'bea-sub', 'oidc-bea', 'bea@example.test');
  IF (SELECT email_confirmed_at FROM public.users WHERE id = 'oidc-bea') IS DISTINCT FROM prior THEN
    RAISE EXCEPTION 'A repeat sign-in or case-only edit replaced confirmation';
  END IF;
  UPDATE public.users SET email = 'new@example.test' WHERE id = 'oidc-bea';
  PERFORM public.web_confirm_oidc_email('org', 'bea-sub', 'oidc-bea', 'bea@example.test');
  IF (SELECT email_confirmed_at FROM public.users WHERE id = 'oidc-bea') IS NOT NULL THEN
    RAISE EXCEPTION 'A changed address retained the old proof';
  END IF;
END;
$test$;
ROLLBACK;
