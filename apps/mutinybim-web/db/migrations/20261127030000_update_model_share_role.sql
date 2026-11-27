-- A role form targets the grant that was displayed. Removal or replacement
-- makes the form stale, even if the same user is invited back to the model.
CREATE FUNCTION public.web_update_model_share_role(p_model TEXT, p_user TEXT, p_owner TEXT, p_grant TEXT, p_role TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('mutinybim-web:model-access', 0));
  PERFORM 1 FROM public.models WHERE id = p_model AND owner_id = p_owner AND owner_id <> p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.model_shares SET role = p_role
    WHERE model_id = p_model AND user_id = p_user AND grant_id = p_grant;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.web_update_model_share_role(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_update_model_share_role(TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;
