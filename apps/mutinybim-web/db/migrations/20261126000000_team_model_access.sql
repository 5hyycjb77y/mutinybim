-- Hosted teams grant model access. Ownership of a model or team stays individual.
CREATE TABLE public.teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  owner_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_by TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX teams_owner ON public.teams(owner_id);
CREATE TABLE public.team_members (
  team_id TEXT NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('member', 'manager')),
  added_by TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON public.team_members(user_id, team_id);
CREATE TABLE public.team_shares (
  model_id TEXT NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  shared_by TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, team_id)
);
CREATE INDEX team_shares_team ON public.team_shares(team_id, model_id);

CREATE VIEW public.model_share_sources (user_id, model_id, role, team_name) WITH (security_invoker = true) AS
  SELECT user_id, model_id, role, NULL::text FROM public.model_shares
  UNION ALL
  SELECT t.owner_id, s.model_id, s.role, t.name
    FROM public.teams t JOIN public.team_shares s ON s.team_id = t.id
  UNION ALL
  SELECT m.user_id, s.model_id, s.role, t.name FROM public.team_members m
    JOIN public.team_shares s ON s.team_id = m.team_id JOIN public.teams t ON t.id = m.team_id;

-- An ownership transfer consumes the incoming owner's personal grant. Resolve
-- the owner and every qualifying source within the same statement snapshot.
CREATE FUNCTION public.web_access_to(p_user TEXT, p_model TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT to_jsonb(m) || jsonb_build_object('role', g.role)
  FROM public.models m LEFT JOIN (
    SELECT role FROM public.model_share_sources WHERE user_id = p_user AND model_id = p_model
    ORDER BY (role = 'edit') DESC LIMIT 1
  ) g ON true
  WHERE m.id = p_model AND (m.owner_id = p_user OR g.role IS NOT NULL)
$$;

-- One array preserves a single snapshot even when a team shares more models
-- than the PostgREST row limit. Only the caller's qualifying team names appear.
CREATE FUNCTION public.web_shared_with(p_user TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH grants AS (
    SELECT model_id, CASE WHEN bool_or(role = 'edit') THEN 'edit' ELSE 'view' END AS role,
      COALESCE(jsonb_agg(DISTINCT team_name ORDER BY team_name) FILTER (WHERE team_name IS NOT NULL), '[]'::jsonb) AS team_names
    FROM public.model_share_sources WHERE user_id = p_user GROUP BY model_id
  )
  SELECT COALESCE(jsonb_agg(
    to_jsonb(m) || jsonb_build_object('role', g.role, 'team_names', g.team_names, 'owner_name', u.display_name)
    ORDER BY m.updated_at DESC, m.id
  ), '[]'::jsonb)
  FROM grants g JOIN public.models m ON m.id = g.model_id JOIN public.users u ON u.id = m.owner_id
  WHERE m.owner_id <> p_user
$$;

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.teams, public.team_members, public.team_shares, public.model_share_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teams, public.team_members, public.team_shares TO service_role;
GRANT SELECT ON public.model_share_sources TO service_role;
REVOKE ALL ON FUNCTION public.web_access_to(TEXT, TEXT), public.web_shared_with(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_access_to(TEXT, TEXT), public.web_shared_with(TEXT) TO service_role;
