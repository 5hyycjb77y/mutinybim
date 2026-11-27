-- On a disposable database with the hosted web migrations applied, run with psql -X -v ON_ERROR_STOP=1.
BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE
  rpc text := 'public.web_redeem_password_reset(text,text)';
  who text;
BEGIN
  IF has_function_privilege('anon', rpc, 'EXECUTE') OR has_function_privilege('authenticated', rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'Redeeming a reset link must be server-only';
  END IF;
  INSERT INTO public.users (id, email, display_name, password_hash) VALUES
    ('reset-sam', 'sam-reset@example.test', 'Sam', 'old-sam'), ('reset-pat', 'pat-reset@example.test', 'Pat', 'old-pat');
  INSERT INTO public.sessions (token_hash, user_id, expires_at) VALUES
    ('reset-sam-1', 'reset-sam', now() + interval '1 day'), ('reset-sam-2', 'reset-sam', now() + interval '1 day'),
    ('reset-pat-1', 'reset-pat', now() + interval '1 day');
  INSERT INTO public.password_resets (token_hash, user_id, expires_at) VALUES
    ('live-link', 'reset-sam', now() + interval '1 hour'), ('stale-link', 'reset-pat', now() - interval '1 second');

  -- An expired or unknown link changes nothing.
  IF public.web_redeem_password_reset('stale-link', 'new-pat') IS NOT NULL
     OR public.web_redeem_password_reset('no-such-link', 'new-pat') IS NOT NULL THEN
    RAISE EXCEPTION 'An expired or unknown link was accepted';
  END IF;
  IF (SELECT password_hash FROM public.users WHERE id = 'reset-pat') IS DISTINCT FROM 'old-pat'
     OR NOT EXISTS (SELECT 1 FROM public.sessions WHERE user_id = 'reset-pat') THEN
    RAISE EXCEPTION 'A refused link changed the account';
  END IF;

  -- The live link saves the password and ends that account's sessions only.
  who := public.web_redeem_password_reset('live-link', 'new-sam');
  IF who IS DISTINCT FROM 'reset-sam' THEN RAISE EXCEPTION 'The live link was refused'; END IF;
  IF (SELECT password_hash FROM public.users WHERE id = 'reset-sam') IS DISTINCT FROM 'new-sam' THEN
    RAISE EXCEPTION 'The new password was not saved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sessions WHERE user_id = 'reset-sam')
     OR NOT EXISTS (SELECT 1 FROM public.sessions WHERE user_id = 'reset-pat') THEN
    RAISE EXCEPTION 'Sessions were not ended for exactly the reset account';
  END IF;

  -- A second use is refused and leaves the first password.
  IF public.web_redeem_password_reset('live-link', 'second-sam') IS NOT NULL THEN
    RAISE EXCEPTION 'A used link worked twice';
  END IF;
  IF (SELECT password_hash FROM public.users WHERE id = 'reset-sam') IS DISTINCT FROM 'new-sam' THEN
    RAISE EXCEPTION 'A refused second use changed the password';
  END IF;
END;
$test$;
ROLLBACK;
