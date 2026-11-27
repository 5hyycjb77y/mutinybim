-- On a disposable database with the hosted web migrations applied, run with psql -X -v ON_ERROR_STOP=1.
BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE
  rpc text := 'public.web_redeem_email_confirmation(text,text)';
BEGIN
  IF has_function_privilege('anon', rpc, 'EXECUTE') OR has_function_privilege('authenticated', rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'Redeeming a confirmation link must be server-only';
  END IF;
  INSERT INTO public.users (id, email, display_name) VALUES
    ('confirm-bea', 'bea-confirm@example.test', 'Bea'), ('confirm-pat', 'pat-confirm@example.test', 'Pat');
  INSERT INTO public.email_confirmations (token_hash, user_id, email, expires_at) VALUES
    ('bea-live', 'confirm-bea', 'bea-confirm@example.test', now() + interval '1 day'),
    ('bea-stale', 'confirm-bea', 'bea-confirm@example.test', now() - interval '1 second'),
    ('pat-old-address', 'confirm-pat', 'pat-before@example.test', now() + interval '1 day');

  -- Another account's link, an expired link and an unknown link change nothing.
  IF public.web_redeem_email_confirmation('bea-live', 'confirm-pat')
     OR public.web_redeem_email_confirmation('bea-stale', 'confirm-bea')
     OR public.web_redeem_email_confirmation('no-such-link', 'confirm-bea') THEN
    RAISE EXCEPTION 'A link confirmed the wrong account, or worked after it expired';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.email_confirmations WHERE token_hash = 'bea-live') THEN
    RAISE EXCEPTION 'Another account used up Bea''s link';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE email_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A refused link confirmed an address';
  END IF;

  -- The right account confirms, once.
  IF NOT public.web_redeem_email_confirmation('bea-live', 'confirm-bea') THEN RAISE EXCEPTION 'Bea''s link was refused'; END IF;
  IF (SELECT email_confirmed_at FROM public.users WHERE id = 'confirm-bea') IS NULL THEN RAISE EXCEPTION 'Not confirmed'; END IF;
  IF public.web_redeem_email_confirmation('bea-live', 'confirm-bea') THEN RAISE EXCEPTION 'A link worked twice'; END IF;

  -- A link sent to an earlier address is used up but confirms nothing.
  IF public.web_redeem_email_confirmation('pat-old-address', 'confirm-pat') THEN RAISE EXCEPTION 'An old address''s link confirmed the new one'; END IF;
  IF (SELECT email_confirmed_at FROM public.users WHERE id = 'confirm-pat') IS NOT NULL THEN RAISE EXCEPTION 'Pat was confirmed'; END IF;
  IF EXISTS (SELECT 1 FROM public.email_confirmations WHERE token_hash = 'pat-old-address') THEN RAISE EXCEPTION 'Stale address link survived'; END IF;

  FOREACH rpc IN ARRAY ARRAY['public.web_stage_email_confirmation(text,text,text,timestamptz)', 'public.web_deliver_email_confirmation(text)'] LOOP
    IF has_function_privilege('anon', rpc, 'EXECUTE') OR has_function_privilege('authenticated', rpc, 'EXECUTE') THEN
      RAISE EXCEPTION 'Confirmation mail must be server-only';
    END IF;
  END LOOP;
  PERFORM public.web_stage_email_confirmation('pat-first', 'confirm-pat', 'pat-confirm@example.test', now() + interval '1 day');
  PERFORM public.web_stage_email_confirmation('pat-second', 'confirm-pat', 'pat-confirm@example.test', now() + interval '1 day');
  PERFORM public.web_deliver_email_confirmation('pat-second');
  PERFORM public.web_deliver_email_confirmation('pat-first');
  IF public.web_redeem_email_confirmation('pat-first','confirm-pat') OR NOT public.web_redeem_email_confirmation('pat-second','confirm-pat') THEN
    RAISE EXCEPTION 'Out-of-order delivery failed to preserve only the newer link';
  END IF;
END;
$test$;
ROLLBACK;
