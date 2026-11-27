-- On a disposable database with the hosted web migrations applied, run with psql -X -v ON_ERROR_STOP=1.
BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE
  fn text;
  answer text;
  original_grant text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.web_create_model_invitation(text,text,text,text,text,text,timestamptz)',
    'public.web_open_model_invitations(text,text)',
    'public.web_respond_model_invitation(text,text,text)',
    'public.web_confirm_email_by_operator(text,text)',
    'public.web_update_model_share_role(text,text,text,text,text)'
  ] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% must be server-only', fn;
    END IF;
  END LOOP;
  INSERT INTO public.users (id, email, display_name, email_confirmed_at) VALUES
    ('inv-alex', 'alex-inv@example.test', 'Alex', now()), ('inv-bea', 'bea-inv@example.test', 'Bea', now()),
    ('inv-cam', 'cam-inv@example.test', 'Cam', now()), ('inv-dee', 'dee-inv@example.test', 'Dee', NULL);
  INSERT INTO public.models (id, owner_id, name) VALUES ('inv-plant', 'inv-alex', 'Plant room');

  -- Only the owner invites; a new invitation to the same address replaces the open one.
  IF public.web_create_model_invitation('inv-x', 'inv-plant', 'inv-bea', 'pat@example.test', 'edit', 'h-x', now() + interval '7 days') THEN
    RAISE EXCEPTION 'Someone else''s model took an invitation';
  END IF;
  PERFORM public.web_create_model_invitation('inv-1', 'inv-plant', 'inv-alex', 'Bea-Inv@Example.test', 'view', 'h-1', now() + interval '7 days');
  PERFORM public.web_create_model_invitation('inv-2', 'inv-plant', 'inv-alex', 'bea-inv@example.test', 'edit', 'h-2', now() + interval '7 days');
  IF (SELECT state FROM public.model_invitations WHERE id = 'inv-1') <> 'cancelled' THEN RAISE EXCEPTION 'The first invitation stayed open'; END IF;
  IF (SELECT count(*) FROM public.web_open_model_invitations('bea-inv@example.test', NULL)) <> 1
     OR (SELECT model_name FROM public.web_open_model_invitations(NULL, 'h-2')) <> 'Plant room'
     OR EXISTS (SELECT 1 FROM public.web_open_model_invitations(NULL, 'h-1'))
     OR EXISTS (SELECT 1 FROM public.web_open_model_invitations(NULL, NULL)) THEN
    RAISE EXCEPTION 'Open invitations by address or link are wrong';
  END IF;

  -- The operator confirms an address only while the account still uses it, keeping the first time.
  IF public.web_confirm_email_by_operator('inv-dee', 'dee-old@example.test') THEN RAISE EXCEPTION 'Confirmed an address Dee no longer uses'; END IF;
  IF (SELECT email_confirmed_at FROM public.users WHERE id = 'inv-dee') IS NOT NULL THEN RAISE EXCEPTION 'Dee was confirmed'; END IF;
  IF NOT public.web_confirm_email_by_operator('inv-alex', 'Alex-Inv@Example.test') THEN RAISE EXCEPTION 'The operator could not confirm Alex'; END IF;

  -- Another address, an unconfirmed address and the owner can't answer; nothing changes.
  PERFORM public.web_create_model_invitation('inv-3', 'inv-plant', 'inv-alex', 'dee-inv@example.test', 'edit', 'h-3', now() + interval '7 days');
  IF public.web_respond_model_invitation('inv-2', 'inv-cam', 'accept') <> 'unavailable'
     OR public.web_respond_model_invitation('inv-3', 'inv-dee', 'accept') <> 'unavailable'
     OR public.web_respond_model_invitation('inv-2', 'inv-alex', 'accept') <> 'unavailable' THEN
    RAISE EXCEPTION 'The wrong account answered an invitation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.model_shares WHERE model_id = 'inv-plant') THEN RAISE EXCEPTION 'A refused answer shared the model'; END IF;

  -- Bea accepts once; an existing share keeps its grant and takes the invited role.
  INSERT INTO public.model_shares (model_id, user_id, role, invited_by) VALUES ('inv-plant', 'inv-bea', 'view', 'inv-alex');
  answer := public.web_respond_model_invitation('inv-2', 'inv-bea', 'accept');
  IF answer <> 'accepted' THEN RAISE EXCEPTION 'Bea''s acceptance answered %', answer; END IF;
  IF (SELECT role FROM public.model_shares WHERE model_id = 'inv-plant' AND user_id = 'inv-bea') <> 'edit' THEN RAISE EXCEPTION 'The share kept its old role'; END IF;
  IF public.web_respond_model_invitation('inv-2', 'inv-bea', 'accept') <> 'unavailable' THEN RAISE EXCEPTION 'An invitation was accepted twice'; END IF;

  -- Role edits target the displayed grant. Revocation wins even when access is later reissued.
  SELECT grant_id INTO STRICT original_grant FROM public.model_shares WHERE model_id = 'inv-plant' AND user_id = 'inv-bea';
  IF public.web_update_model_share_role('inv-plant','inv-bea','inv-cam',original_grant,'view') THEN RAISE EXCEPTION 'A non-owner edited the grant'; END IF;
  IF NOT public.web_update_model_share_role('inv-plant','inv-bea','inv-alex',original_grant,'view') THEN RAISE EXCEPTION 'The current grant could not be edited'; END IF;
  PERFORM public.web_change_model_share('inv-plant','inv-alex','inv-bea',NULL);
  IF public.web_update_model_share_role('inv-plant','inv-bea','inv-alex',original_grant,'edit')
     OR EXISTS (SELECT 1 FROM public.model_shares WHERE model_id = 'inv-plant' AND user_id = 'inv-bea') THEN RAISE EXCEPTION 'A role edit restored a removed grant'; END IF;
  PERFORM public.web_change_model_share('inv-plant','inv-alex','inv-bea','view');
  IF public.web_update_model_share_role('inv-plant','inv-bea','inv-alex',original_grant,'edit') THEN RAISE EXCEPTION 'A stale form edited a replacement grant'; END IF;
  IF (SELECT role FROM public.model_shares WHERE model_id = 'inv-plant' AND user_id = 'inv-bea') <> 'view' THEN RAISE EXCEPTION 'Replacement grant role changed'; END IF;

  -- Expired, or made by a former owner: unusable.
  PERFORM public.web_create_model_invitation('inv-4', 'inv-plant', 'inv-alex', 'cam-inv@example.test', 'view', 'h-4', now() - interval '1 second');
  IF public.web_respond_model_invitation('inv-4', 'inv-cam', 'accept') <> 'unavailable' THEN RAISE EXCEPTION 'An expired invitation was accepted'; END IF;
  PERFORM public.web_create_model_invitation('inv-5', 'inv-plant', 'inv-alex', 'cam-inv@example.test', 'view', 'h-5', now() + interval '7 days');
  UPDATE public.models SET owner_id = 'inv-bea' WHERE id = 'inv-plant';
  IF public.web_respond_model_invitation('inv-5', 'inv-cam', 'accept') <> 'unavailable'
     OR EXISTS (SELECT 1 FROM public.web_open_model_invitations('cam-inv@example.test', NULL)) THEN
    RAISE EXCEPTION 'A former owner''s invitation still worked';
  END IF;
  UPDATE public.models SET owner_id = 'inv-alex' WHERE id = 'inv-plant';
  IF public.web_respond_model_invitation('inv-5', 'inv-cam', 'accept') <> 'unavailable' THEN
    RAISE EXCEPTION 'An invitation came back when the model was handed back';
  END IF;
END;
$test$;
ROLLBACK;
