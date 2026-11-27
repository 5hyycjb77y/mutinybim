/** The owner belongs to the roster through teams.owner_id. Every other person
 * belongs through team_members. Personal grants remain independent of both. */
export const SQLITE_TEAM_SCHEMA = `
CREATE TABLE teams (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX teams_owner ON teams(owner_id);
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('member', 'manager')),
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id, team_id);
CREATE TABLE team_shares (
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  shared_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (model_id, team_id)
);
CREATE INDEX team_shares_team ON team_shares(team_id, model_id);

CREATE VIEW model_share_sources (user_id, model_id, role, team_name) AS
  SELECT user_id, model_id, role, NULL FROM model_shares
  UNION ALL
  SELECT t.owner_id, s.model_id, s.role, t.name
    FROM teams t JOIN team_shares s ON s.team_id = t.id
  UNION ALL
  SELECT m.user_id, s.model_id, s.role, t.name FROM team_members m
    JOIN team_shares s ON s.team_id = m.team_id JOIN teams t ON t.id = m.team_id;
`;

// Both reads use a single snapshot across grants and ownership. Limit the
// editor's frequent point lookup to one person and one model before ranking.
export const SQLITE_MODEL_ACCESS = `
  SELECT m.*, (
    SELECT role FROM model_share_sources WHERE user_id = $person AND model_id = $model
    ORDER BY (role = 'edit') DESC LIMIT 1
  ) AS role FROM models m WHERE m.id = $model`;

export const SQLITE_SHARED_MODELS = `
  WITH grants AS (
    SELECT model_id, CASE MAX(role = 'edit') WHEN 1 THEN 'edit' ELSE 'view' END AS role,
      json_group_array(DISTINCT team_name ORDER BY team_name) FILTER (WHERE team_name IS NOT NULL) AS team_names
    FROM model_share_sources WHERE user_id = ? GROUP BY model_id
  )
  SELECT m.*, g.role, g.team_names, u.display_name AS owner_name FROM grants g
  JOIN models m ON m.id = g.model_id JOIN users u ON u.id = m.owner_id
  WHERE m.owner_id <> ? ORDER BY m.updated_at DESC, m.id`;
