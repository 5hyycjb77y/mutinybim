-- Retain the creating person's receipt across a rename, handover or model deletion.
CREATE TABLE public.model_creations (
  owner_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  creation_key TEXT NOT NULL,
  model_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  starter TEXT NOT NULL CHECK (starter IN ('blank', 'sample')),
  starter_hash TEXT NOT NULL CHECK (starter_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'ready', 'abandoned')),
  PRIMARY KEY (owner_id, creation_key)
);
CREATE INDEX model_creations_pending ON public.model_creations(owner_id) WHERE state = 'reserved';
ALTER TABLE public.model_creations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.model_creations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.model_creations TO service_role;

-- A share keeps its identity on a role edit. Its inviter may leave the firm.
ALTER TABLE public.model_shares
  ADD COLUMN grant_id TEXT NOT NULL UNIQUE DEFAULT (gen_random_uuid()::TEXT),
  ALTER COLUMN invited_by DROP NOT NULL,
  DROP CONSTRAINT model_shares_invited_by_fkey,
  ADD CONSTRAINT model_shares_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- Terminal receipts outlive the mutable model and share rows.
CREATE TABLE public.model_transfers (
  id TEXT PRIMARY KEY, model_id TEXT NOT NULL, model_name TEXT NOT NULL,
  sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, recipient_id TEXT NOT NULL, recipient_name TEXT NOT NULL,
  share_id TEXT NOT NULL, retained TEXT NOT NULL CHECK (retained IN ('view','edit','none')),
  state TEXT NOT NULL CHECK (state IN ('open','accepted','declined','cancelled','expired','invalidated')),
  expires_at TIMESTAMPTZ NOT NULL, accepted_at TIMESTAMPTZ,
  CHECK (sender_id <> recipient_id), CHECK ((state = 'accepted') = (accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX model_transfers_open ON public.model_transfers(model_id) WHERE state = 'open';
CREATE INDEX model_transfers_model ON public.model_transfers(model_id);
CREATE INDEX model_transfers_inbox ON public.model_transfers(recipient_id, expires_at) WHERE state = 'open';
ALTER TABLE public.model_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.model_transfers FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.model_transfers TO service_role;

CREATE FUNCTION public.web_account_model_slots(p_owner TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT (SELECT count(*) FROM public.models WHERE owner_id = p_owner)
       + (SELECT count(*) FROM public.model_creations WHERE owner_id = p_owner AND state = 'reserved')
$$;
REVOKE ALL ON FUNCTION public.web_account_model_slots(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_account_model_slots(TEXT) TO service_role;

CREATE FUNCTION public.web_reserve_model_creation(
  p_owner TEXT, p_key TEXT, p_model TEXT, p_name TEXT, p_starter TEXT, p_hash TEXT, p_limit INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  request public.model_creations;
  used BIGINT;
BEGIN
  IF p_limit IS NULL OR p_limit < 0 OR p_key IS NULL OR p_name IS NULL
     OR p_starter IS NULL OR p_hash IS NULL OR p_model IS NULL THEN
    RAISE EXCEPTION 'Missing or invalid model creation parameters';
  END IF;
  -- Transfer acceptance shares this order: access guard, affected account rows, then model rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('mutinybim-web:model-access', 0));
  PERFORM 1 FROM public.users WHERE id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown model creator'; END IF;
  SELECT * INTO request FROM public.model_creations WHERE owner_id = p_owner AND creation_key = p_key;
  IF FOUND THEN
    IF request.name IS DISTINCT FROM p_name OR request.starter IS DISTINCT FROM p_starter THEN
      RETURN to_jsonb('conflict'::TEXT);
    END IF;
    RETURN to_jsonb(request);
  END IF;
  SELECT public.web_account_model_slots(p_owner) INTO used;
  IF used >= p_limit THEN RETURN to_jsonb('quota'::TEXT); END IF;
  IF EXISTS (SELECT 1 FROM public.models WHERE id = p_model)
     OR EXISTS (SELECT 1 FROM public.model_creations WHERE model_id = p_model)
     OR EXISTS (SELECT 1 FROM public.model_transfers WHERE model_id = p_model) THEN
    RETURN to_jsonb('id_used'::TEXT);
  END IF;
  INSERT INTO public.model_creations (owner_id, creation_key, model_id, name, starter, starter_hash, state)
    VALUES (p_owner, p_key, p_model, p_name, p_starter, p_hash, 'reserved') RETURNING * INTO request;
  RETURN to_jsonb(request);
END;
$$;

CREATE FUNCTION public.web_finish_model_creation(p_owner TEXT, p_key TEXT, p_state TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  request public.model_creations;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('ready', 'abandoned') THEN RAISE EXCEPTION 'Invalid creation state'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mutinybim-web:model-access', 0));
  PERFORM 1 FROM public.users WHERE id = p_owner FOR UPDATE;
  SELECT * INTO STRICT request FROM public.model_creations WHERE owner_id = p_owner AND creation_key = p_key FOR UPDATE;
  IF request.state = 'reserved' THEN
    IF p_state = 'ready' THEN
      INSERT INTO public.models (id, owner_id, name) VALUES (request.model_id, p_owner, request.name);
    END IF;
    UPDATE public.model_creations SET state = p_state WHERE owner_id = p_owner AND creation_key = p_key RETURNING * INTO request;
  END IF;
  RETURN to_jsonb(request);
END;
$$;

REVOKE ALL ON FUNCTION public.web_reserve_model_creation(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_finish_model_creation(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_reserve_model_creation(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_finish_model_creation(TEXT, TEXT, TEXT) TO service_role;

CREATE FUNCTION public.web_invalidate_model_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'model_shares' THEN
    UPDATE public.model_transfers SET state = 'invalidated' WHERE model_id = OLD.model_id AND share_id = OLD.grant_id AND state = 'open';
  ELSE
    UPDATE public.model_transfers SET state = 'invalidated' WHERE model_id = OLD.id AND state = 'open';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER end_transfer_on_unshare AFTER DELETE ON public.model_shares
  FOR EACH ROW EXECUTE FUNCTION public.web_invalidate_model_transfer();
CREATE TRIGGER end_transfer_on_delete AFTER DELETE ON public.models
  FOR EACH ROW EXECUTE FUNCTION public.web_invalidate_model_transfer();

-- A SQLite import preserves destination rows on conflict. An offer from a
-- different grant lifetime must never appear in the destination inbox.
CREATE FUNCTION public.web_check_open_model_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.models m JOIN public.model_shares s ON s.model_id = m.id
    WHERE m.id = NEW.model_id AND m.owner_id = NEW.sender_id
      AND s.user_id = NEW.recipient_id AND s.grant_id = NEW.share_id
  ) THEN NEW.state := 'invalidated'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_open_model_transfer BEFORE INSERT ON public.model_transfers
  FOR EACH ROW WHEN (NEW.state = 'open') EXECUTE FUNCTION public.web_check_open_model_transfer();

CREATE FUNCTION public.web_change_model_share(p_model TEXT, p_owner TEXT, p_user TEXT, p_role TEXT)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('mutinybim-web:model-access', 0));
  PERFORM 1 FROM public.models WHERE id = p_model AND owner_id = p_owner AND owner_id <> p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_role IS NULL THEN
    DELETE FROM public.model_shares WHERE model_id = p_model AND user_id = p_user;
  ELSE
    INSERT INTO public.model_shares(model_id,user_id,role,invited_by) VALUES(p_model,p_user,p_role,p_owner)
      ON CONFLICT(model_id,user_id) DO UPDATE SET role = excluded.role;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.web_offer_model_transfer(p_id TEXT, p_model TEXT, p_sender TEXT, p_recipient TEXT, p_retained TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  model_name TEXT;
  grant_id TEXT;
  offer public.model_transfers;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('mutinybim-web:model-access', 0));
  SELECT m.name INTO model_name FROM public.models m WHERE m.id = p_model AND m.owner_id = p_sender FOR UPDATE;
  IF NOT FOUND THEN RETURN to_jsonb('unavailable'::TEXT); END IF;
  SELECT s.grant_id INTO grant_id FROM public.model_shares s WHERE s.model_id = p_model AND s.user_id = p_recipient;
  IF NOT FOUND OR p_recipient = p_sender THEN RETURN to_jsonb('ineligible'::TEXT); END IF;
  UPDATE public.model_transfers SET state = 'expired' WHERE model_id = p_model AND state = 'open' AND expires_at <= clock_timestamp();
  IF EXISTS (SELECT 1 FROM public.model_transfers WHERE model_id = p_model AND state = 'open') THEN RETURN to_jsonb('exists'::TEXT); END IF;
  INSERT INTO public.model_transfers(id, model_id, model_name, sender_id, sender_name, recipient_id, recipient_name, share_id, retained, state, expires_at)
    SELECT p_id, p_model, model_name, s.id, s.display_name, r.id, r.display_name, grant_id, p_retained, 'open', clock_timestamp() + interval '14 days'
    FROM public.users s, public.users r WHERE s.id = p_sender AND r.id = p_recipient RETURNING * INTO STRICT offer;
  RETURN to_jsonb(offer);
END;
$$;

CREATE FUNCTION public.web_respond_model_transfer(p_id TEXT, p_actor TEXT, p_action TEXT, p_limit INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  offer public.model_transfers;
  result_state TEXT;
  current_owner TEXT;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('accept','cancel','decline') OR p_limit IS NULL OR p_limit < 0 THEN
    RAISE EXCEPTION 'Invalid response parameters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mutinybim-web:model-access', 0));
  SELECT * INTO offer FROM public.model_transfers WHERE id = p_id;
  IF NOT FOUND OR p_actor IS DISTINCT FROM (CASE WHEN p_action = 'cancel' THEN offer.sender_id ELSE offer.recipient_id END) THEN
    RETURN to_jsonb('unavailable'::TEXT);
  END IF;
  IF offer.state = 'accepted' AND p_action <> 'accept' THEN RETURN to_jsonb('unavailable'::TEXT); END IF;
  IF offer.state <> 'open' THEN RETURN to_jsonb(offer); END IF;
  PERFORM u.id FROM public.users u WHERE u.id IN (offer.sender_id, offer.recipient_id) ORDER BY u.id FOR UPDATE;
  SELECT owner_id INTO current_owner FROM public.models WHERE id = offer.model_id FOR UPDATE;
  SELECT * INTO STRICT offer FROM public.model_transfers WHERE id = p_id FOR UPDATE;
  IF offer.state <> 'open' THEN RETURN to_jsonb(offer); END IF;
  IF offer.expires_at <= clock_timestamp() THEN result_state := 'expired';
  ELSIF p_action = 'cancel' THEN result_state := 'cancelled';
  ELSIF p_action = 'decline' THEN result_state := 'declined';
  ELSIF current_owner IS DISTINCT FROM offer.sender_id OR NOT EXISTS (
    SELECT 1 FROM public.model_shares WHERE model_id = offer.model_id AND user_id = p_actor AND grant_id = offer.share_id
  ) THEN result_state := 'invalidated';
  ELSIF public.web_account_model_slots(p_actor) >= p_limit THEN RETURN to_jsonb('quota'::TEXT);
  ELSE result_state := 'accepted';
  END IF;
  UPDATE public.model_transfers SET state = result_state, accepted_at = CASE WHEN result_state = 'accepted' THEN clock_timestamp() END
    WHERE id = p_id RETURNING * INTO offer;
  IF result_state = 'accepted' THEN
    UPDATE public.models SET owner_id = p_actor WHERE id = offer.model_id;
    DELETE FROM public.model_shares WHERE model_id = offer.model_id AND user_id IN (p_actor, offer.sender_id);
    IF offer.retained <> 'none' THEN
      INSERT INTO public.model_shares(model_id,user_id,role,invited_by) VALUES(offer.model_id,offer.sender_id,offer.retained,p_actor);
    END IF;
  END IF;
  RETURN to_jsonb(offer);
END;
$$;
REVOKE ALL ON FUNCTION public.web_invalidate_model_transfer() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_check_open_model_transfer() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_change_model_share(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_offer_model_transfer(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_respond_model_transfer(TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_change_model_share(TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_offer_model_transfer(TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_respond_model_transfer(TEXT,TEXT,TEXT,INTEGER) TO service_role;
