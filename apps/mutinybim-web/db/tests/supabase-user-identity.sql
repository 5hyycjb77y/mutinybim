-- Run on a disposable database after applying the hosted web migrations.
BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.web_create_supabase_user(text,text,text)', 'public.web_user_by_email(text)'] LOOP
    IF has_function_privilege('anon', signature, 'EXECUTE')
       OR has_function_privilege('authenticated', signature, 'EXECUTE')
       OR NOT has_function_privilege('service_role', signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Unexpected access to %', signature;
    END IF;
  END LOOP;

  IF public.web_create_supabase_user('new-subject','new@example.test','New') IS NOT TRUE THEN
    RAISE EXCEPTION 'First creation failed';
  END IF;
  IF public.web_create_supabase_user('new-subject','new@example.test','Retry') IS NOT FALSE
     OR (SELECT user_id FROM public.identities WHERE provider='supabase' AND subject='new-subject') IS DISTINCT FROM 'new-subject'
     OR (SELECT display_name FROM public.users WHERE id='new-subject') IS DISTINCT FROM 'New' THEN
    RAISE EXCEPTION 'Retry changed the saved account or identity';
  END IF;

  INSERT INTO public.users(id,email,display_name) VALUES ('legacy','Team_A@Example.test','Legacy');
  IF public.web_create_supabase_user('unused','team_a@example.test','Other') IS NOT FALSE
     OR EXISTS (SELECT 1 FROM public.identities WHERE provider='supabase' AND subject='unused') THEN
    RAISE EXCEPTION 'Duplicate email created a binding';
  END IF;
  IF (SELECT id FROM public.web_user_by_email('team_a@example.test')) IS DISTINCT FROM 'legacy'
     OR EXISTS (SELECT 1 FROM public.web_user_by_email('team_%@example.test')) THEN
    RAISE EXCEPTION 'Email lookup must match literal characters and ignore case';
  END IF;

  INSERT INTO public.identities(provider,subject,user_id) VALUES ('supabase','occupied','legacy');
  IF public.web_create_supabase_user('occupied','other@example.test','Other') IS NOT FALSE
     OR EXISTS (SELECT 1 FROM public.users WHERE id='occupied')
     OR (SELECT user_id FROM public.identities WHERE provider='supabase' AND subject='occupied') IS DISTINCT FROM 'legacy' THEN
    RAISE EXCEPTION 'Conflicting identity changed existing data';
  END IF;
END
$test$;
ROLLBACK;
