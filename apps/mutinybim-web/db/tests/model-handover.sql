-- On a disposable database with the hosted web migrations applied, run with psql -X -v ON_ERROR_STOP=1.
BEGIN;
SET LOCAL ROLE service_role;
DO $test$
DECLARE
  offer jsonb;
  receipt jsonb;
  answer jsonb;
  original_grant text;
BEGIN
  INSERT INTO public.users(id,email,display_name) VALUES
    ('test-32-a','alex-32@example.test','Alex'), ('test-32-b','bea-32@example.test','Bea'), ('test-32-c','cam-32@example.test','Cam');
  INSERT INTO public.models(id,owner_id,name) VALUES ('test-32-plant','test-32-a','Plant room');
  PERFORM public.web_change_model_share('test-32-plant','test-32-a','test-32-b','view');
  PERFORM public.web_change_model_share('test-32-plant','test-32-a','test-32-c','edit');
  INSERT INTO public.model_transfers(id, model_id, model_name, sender_id, sender_name, recipient_id,
                                    recipient_name, share_id, retained, state, expires_at)
    VALUES ('imported-offer','test-32-plant','Plant room','test-32-a','Alex','test-32-b','Bea',
            'share-from-another-store','edit','open',clock_timestamp() + interval '1 day');
  IF (SELECT state FROM public.model_transfers WHERE id='imported-offer') IS DISTINCT FROM 'invalidated' THEN
    RAISE EXCEPTION 'Imported an open offer for a different grant lifetime';
  END IF;
  offer := public.web_offer_model_transfer('test-32-offer','test-32-plant','test-32-a','test-32-b','edit');
  IF offer->>'state' IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'Offer missing'; END IF;
  original_grant := offer->>'share_id';
  PERFORM public.web_change_model_share('test-32-plant','test-32-a','test-32-b','edit');
  IF original_grant IS DISTINCT FROM (SELECT grant_id FROM public.model_shares WHERE model_id='test-32-plant' AND user_id='test-32-b') THEN
    RAISE EXCEPTION 'Grant identity changed on role edit';
  END IF;
  -- An admitted create occupies the last slot even before the model becomes visible.
  answer := public.web_reserve_model_creation('test-32-b','req-1','test-32-other','Job','blank',repeat('a',64),1);
  IF answer->>'state' IS DISTINCT FROM 'reserved' THEN RAISE EXCEPTION 'Reservation missing'; END IF;
  IF public.web_respond_model_transfer('test-32-offer','test-32-b','accept',1) IS DISTINCT FROM to_jsonb('quota'::text) THEN
    RAISE EXCEPTION 'Both operations occupied the last slot';
  END IF;
  PERFORM public.web_finish_model_creation('test-32-b','req-1','ready');
  answer := public.web_reserve_model_creation('test-32-b','req-1','test-32-new','Job','blank',repeat('b',64),1);
  IF answer->>'state' IS DISTINCT FROM 'ready' OR answer->>'model_id' IS DISTINCT FROM 'test-32-other' THEN
    RAISE EXCEPTION 'Lost create receipt at full quota';
  END IF;
  DELETE FROM public.models WHERE id='test-32-other';
  receipt := public.web_respond_model_transfer('test-32-offer','test-32-b','accept',1);
  IF receipt->>'state' IS DISTINCT FROM 'accepted' OR receipt->>'accepted_at' IS NULL THEN RAISE EXCEPTION 'Receipt missing'; END IF;
  IF (SELECT owner_id FROM public.models WHERE id='test-32-plant') IS DISTINCT FROM 'test-32-b'
     OR EXISTS (SELECT 1 FROM public.model_shares WHERE model_id='test-32-plant' AND user_id='test-32-b')
     OR (SELECT role FROM public.model_shares WHERE model_id='test-32-plant' AND user_id='test-32-a') IS DISTINCT FROM 'edit' THEN
    RAISE EXCEPTION 'Owner or personal grants disagreed with receipt';
  END IF;
  IF public.web_reserve_model_creation('test-32-b','req-2','test-32-new','Job','blank',repeat('c',64),1)
       IS DISTINCT FROM to_jsonb('quota'::text) THEN RAISE EXCEPTION 'Create admitted after transfer took the slot'; END IF;
  PERFORM public.web_offer_model_transfer('test-32-next','test-32-plant','test-32-b','test-32-c','none');
  PERFORM public.web_change_model_share('test-32-plant','test-32-b','test-32-c',NULL);
  PERFORM public.web_change_model_share('test-32-plant','test-32-b','test-32-c','edit');
  answer := public.web_respond_model_transfer('test-32-next','test-32-c','accept',1);
  IF answer->>'state' IS DISTINCT FROM 'invalidated' THEN RAISE EXCEPTION 'Regrant revived old offer'; END IF;
  DELETE FROM public.users WHERE id='test-32-a';
  IF NOT EXISTS (SELECT 1 FROM public.model_shares WHERE model_id='test-32-plant' AND user_id='test-32-c') THEN
    RAISE EXCEPTION 'A coworker lost their surviving grant';
  END IF;
  DELETE FROM public.models WHERE id='test-32-plant';
  IF public.web_reserve_model_creation('test-32-c','req-reuse','test-32-plant','Later','blank',repeat('c',64),1)
       IS DISTINCT FROM to_jsonb('id_used'::text) THEN RAISE EXCEPTION 'Reused a model identity from a historical receipt'; END IF;
  IF public.web_respond_model_transfer('test-32-offer','test-32-b','accept',0) IS DISTINCT FROM receipt THEN
    RAISE EXCEPTION 'Historical receipt changed after deletion';
  END IF;
END
$test$;
ROLLBACK;
