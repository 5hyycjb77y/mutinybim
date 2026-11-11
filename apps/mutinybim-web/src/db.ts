/**
 * The hosted app's own records: people, how they sign in, sessions, the
 * models they own, who else each model is shared with, one-time password
 * reset links and the keys their outside assistants connect with. One
 * SQLite file (node:sqlite, no extra dependency). Model contents live beside
 * it as snapshot files (models.ts), not in this database.
 *
 * Secrets never land here in the clear: passwords are scrypt hashes, session
 * tokens, reset links, agent keys and the sign-in codes and tokens outside
 * assistants get are stored as SHA-256 digests, the passes a linked host
 * issues are AES-256-GCM ciphertext under MUTINYBIM_WEB_LINK_KEY
 * (linked-hosts.ts), and AI provider keys are not stored on the server at all
 * (they stay in the person's browser).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly password_hash: string | null;
  readonly created_at: string;
  /** Light, dark or the computer's setting; the pages and the editor both follow it. */
  readonly color_scheme: ColorScheme;
}

export type ColorScheme = "light" | "dark" | "system";

export function isColorScheme(value: unknown): value is ColorScheme {
  return value === "light" || value === "dark" || value === "system";
}

export interface ModelRow {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export type ShareRole = "view" | "edit";
export type ModelAccess = "owner" | ShareRole;

/** A model someone else shared with this person. */
export interface SharedModelRow extends ModelRow {
  readonly role: ShareRole;
  readonly owner_name: string;
}

export interface ShareRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: ShareRole;
  readonly created_at: string;
}

export interface SessionInfo {
  readonly user: UserRow;
  /** "password", "reset" or the sign-in provider's id. */
  readonly via: string;
  readonly created_at: string;
}

export interface AgentKeyRow {
  readonly id: string;
  readonly user_id: string;
  readonly label: string;
  readonly last4: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
}

export interface OAuthClientRow {
  readonly provider: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly registered_at: string;
}

/** A person's pass for one linked host (ciphertext only; "reconnect" once the host refused it). */
export interface LinkedGrantRow {
  readonly user_id: string;
  readonly provider: string;
  readonly client_id: string;
  readonly access_cipher: string;
  readonly refresh_cipher: string;
  readonly access_expires_at: string;
  readonly refresh_expires_at: string;
  readonly state: "ok" | "reconnect";
  readonly last_error: string | null;
  readonly created_at: string;
}

/** A model on a linked host, as this person last saw it, under a local id (alias) the tools take. */
export interface LinkedModelRow {
  readonly alias_id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly remote_model_id: string;
  readonly remote_project_id: string;
  readonly label: string;
  readonly can_edit: boolean;
  readonly open_url: string | null;
  readonly seen_at: string;
}

export interface OAuthStateRow {
  readonly state: string;
  readonly provider: string;
  readonly code_verifier: string;
  readonly return_to: string;
  readonly created_at: string;
}

/** An outside assistant (Claude, ChatGPT, …) as it registered itself, or as its client metadata document describes it. */
export interface AssistantClientRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: readonly string[];
  readonly kind: "registered" | "metadata";
  /** How the client proves itself at the token endpoint: "none" is a public client (PKCE only). */
  readonly token_auth_method: AssistantTokenAuthMethod;
  /** SHA-256 digest of a confidential client's secret; null for public clients. */
  readonly secret_hash: string | null;
  readonly created_at: string;
}

export type AssistantTokenAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface AssistantCodeRow {
  readonly client_id: string;
  readonly user_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly resource: string;
  readonly scope: string;
}

/** One assistant a person let in: its current access and refresh tokens (digests only). */
export interface AssistantGrantRow {
  readonly id: string;
  readonly user_id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly resource: string;
  readonly scope: string;
  readonly access_expires_at: string;
  readonly refresh_expires_at: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
}

export type AssistantApprovalState = "waiting" | "approved" | "declined" | "landed" | "failed" | "expired";

/** One change an outside assistant asked to make, waiting for (or answered by) the person. Kept across restarts. */
export interface AssistantApprovalRow {
  readonly id: string;
  readonly user_id: string;
  readonly client_name: string;
  readonly model_id: string;
  readonly model_name: string;
  readonly summary: string;
  readonly details: readonly string[];
  readonly kind: "edit" | "retry";
  readonly key: string | null;
  readonly state: AssistantApprovalState;
  readonly outcome: string | null;
  /** What lands on approval after the call returned (edit kind), as JSON the tool server reads back. */
  readonly landing: unknown;
  /** Milliseconds since 1970. */
  readonly created_at: number;
}

/** One assistant connection (an MCP session), kept so it carries on after the server restarts. */
export interface AssistantSessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly grant_id: string;
  /** The tool address's family ("" for /mcp). */
  readonly family: string;
  /** Families the assistant turned on in the session. */
  readonly families: readonly string[];
  readonly run_id: string;
  /** The assistant's initialize request, replayed on restore. */
  readonly init: unknown;
  readonly last_seen_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS models_owner ON models(owner_id, updated_at);
CREATE TABLE IF NOT EXISTS agent_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  last4 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  provider TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (provider, redirect_uri)
);
CREATE TABLE IF NOT EXISTS model_shares (
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (model_id, user_id)
);
CREATE INDEX IF NOT EXISTS model_shares_user ON model_shares(user_id);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('registered', 'metadata')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  previous_refresh_hash TEXT,
  refresh_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS assistant_grants_user ON assistant_grants(user_id);
CREATE TABLE IF NOT EXISTS assistant_approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'retry')),
  key TEXT,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'approved', 'declined', 'landed', 'failed', 'expired')),
  outcome TEXT,
  landing TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_approvals_user ON assistant_approvals(user_id, created_at);
CREATE TABLE IF NOT EXISTS assistant_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES assistant_grants(id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  families TEXT NOT NULL,
  run_id TEXT NOT NULL,
  init TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_sessions_user ON assistant_sessions(user_id);
CREATE TABLE IF NOT EXISTS assistant_kept_scripts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  saved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_kept_scripts_user ON assistant_kept_scripts(user_id, saved_at);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS linked_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_cipher TEXT NOT NULL,
  refresh_cipher TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'reconnect')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS linked_models (
  alias_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  remote_model_id TEXT NOT NULL,
  remote_project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  can_edit INTEGER NOT NULL,
  open_url TEXT,
  seen_at TEXT NOT NULL,
  UNIQUE (user_id, provider, remote_model_id)
);
CREATE TABLE IF NOT EXISTS linked_offers (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  answered_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
`;

export type Db = ReturnType<typeof openDb>;

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`[mutinybim-web db] column ${key} is not text`);
  return value;
}

function strOrNull(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function toUser(row: unknown): UserRow | null {
  if (!isRecord(row)) return null;
  const scheme = row.color_scheme;
  return { id: str(row, "id"), email: str(row, "email"), display_name: str(row, "display_name"), password_hash: strOrNull(row, "password_hash"), created_at: str(row, "created_at"), color_scheme: isColorScheme(scheme) ? scheme : "system" };
}

function toModel(row: unknown): ModelRow | null {
  if (!isRecord(row)) return null;
  return { id: str(row, "id"), owner_id: str(row, "owner_id"), name: str(row, "name"), created_at: str(row, "created_at"), updated_at: str(row, "updated_at") };
}

function toAgentKey(row: unknown): AgentKeyRow | null {
  if (!isRecord(row)) return null;
  return { id: str(row, "id"), user_id: str(row, "user_id"), label: str(row, "label"), last4: str(row, "last4"), created_at: str(row, "created_at"), last_used_at: strOrNull(row, "last_used_at") };
}

function toGrant(row: unknown): AssistantGrantRow | null {
  if (!isRecord(row)) return null;
  return {
    id: str(row, "id"),
    user_id: str(row, "user_id"),
    client_id: str(row, "client_id"),
    client_name: str(row, "client_name"),
    resource: str(row, "resource"),
    scope: str(row, "scope"),
    access_expires_at: str(row, "access_expires_at"),
    refresh_expires_at: str(row, "refresh_expires_at"),
    created_at: str(row, "created_at"),
    last_used_at: strOrNull(row, "last_used_at"),
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("[mutinybim-web db] a stored JSON value didn't parse", { err });
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function num(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`[mutinybim-web db] column ${key} is not a number`);
}

const APPROVAL_STATES: readonly AssistantApprovalState[] = ["waiting", "approved", "declined", "landed", "failed", "expired"];

function toApproval(row: unknown): AssistantApprovalRow | null {
  if (!isRecord(row)) return null;
  const state = APPROVAL_STATES.find((s) => s === row.state);
  const kind = row.kind === "edit" || row.kind === "retry" ? row.kind : null;
  if (!state || !kind) throw new Error("[mutinybim-web db] an approval row has an unknown state or kind");
  return {
    id: str(row, "id"),
    user_id: str(row, "user_id"),
    client_name: str(row, "client_name"),
    model_id: str(row, "model_id"),
    model_name: str(row, "model_name"),
    summary: str(row, "summary"),
    details: stringList(parseJson(str(row, "details"))),
    kind,
    key: strOrNull(row, "key"),
    state,
    outcome: strOrNull(row, "outcome"),
    landing: parseJson(strOrNull(row, "landing")),
    created_at: num(row, "created_at"),
  };
}

function toAssistantSession(row: unknown): AssistantSessionRow | null {
  if (!isRecord(row)) return null;
  return {
    id: str(row, "id"),
    user_id: str(row, "user_id"),
    grant_id: str(row, "grant_id"),
    family: str(row, "family"),
    families: stringList(parseJson(str(row, "families"))),
    run_id: str(row, "run_id"),
    init: parseJson(str(row, "init")),
    last_seen_at: num(row, "last_seen_at"),
  };
}

function toLinkedGrant(row: unknown): LinkedGrantRow | null {
  if (!isRecord(row)) return null;
  return {
    user_id: str(row, "user_id"),
    provider: str(row, "provider"),
    client_id: str(row, "client_id"),
    access_cipher: str(row, "access_cipher"),
    refresh_cipher: str(row, "refresh_cipher"),
    access_expires_at: str(row, "access_expires_at"),
    refresh_expires_at: str(row, "refresh_expires_at"),
    state: row.state === "reconnect" ? "reconnect" : "ok",
    last_error: strOrNull(row, "last_error"),
    created_at: str(row, "created_at"),
  };
}

function toLinkedModel(row: unknown): LinkedModelRow | null {
  if (!isRecord(row)) return null;
  return {
    alias_id: str(row, "alias_id"),
    user_id: str(row, "user_id"),
    provider: str(row, "provider"),
    remote_model_id: str(row, "remote_model_id"),
    remote_project_id: str(row, "remote_project_id"),
    label: str(row, "label"),
    can_edit: num(row, "can_edit") === 1,
    open_url: strOrNull(row, "open_url"),
    seen_at: str(row, "seen_at"),
  };
}

function shareRole(value: unknown): ShareRole {
  if (value === "view" || value === "edit") return value;
  throw new Error(`[mutinybim-web db] share role ${String(value)} is not view or edit`);
}

/** Changes to tables made by earlier versions of this app, applied once, in order (PRAGMA user_version counts them). */
const UPGRADES: readonly string[] = [
  "ALTER TABLE sessions ADD COLUMN via TEXT NOT NULL DEFAULT 'password'",
  "ALTER TABLE users ADD COLUMN color_scheme TEXT NOT NULL DEFAULT 'system' CHECK (color_scheme IN ('light', 'dark', 'system'))",
  "ALTER TABLE assistant_clients ADD COLUMN token_auth_method TEXT NOT NULL DEFAULT 'none' CHECK (token_auth_method IN ('none', 'client_secret_post', 'client_secret_basic'))",
  "ALTER TABLE assistant_clients ADD COLUMN secret_hash TEXT",
];

export function openDb(file: string) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const versionRow = db.prepare("PRAGMA user_version").get();
  const version = isRecord(versionRow) && typeof versionRow.user_version === "number" ? versionRow.user_version : 0;
  for (const [index, sql] of UPGRADES.entries()) {
    if (index < version) continue;
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${index + 1}`);
  }

  return {
    close: () => db.close(),

    createUser(input: { id: string; email: string; displayName: string; passwordHash: string | null }): UserRow {
      db.prepare("INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(input.id, input.email, input.displayName, input.passwordHash, now());
      const user = toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(input.id));
      if (!user) throw new Error("[mutinybim-web db] the new account was not saved");
      return user;
    },
    userByEmail: (email: string): UserRow | null => toUser(db.prepare("SELECT * FROM users WHERE email = ?").get(email)),
    userById: (id: string): UserRow | null => toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id)),
    renameUser: (id: string, displayName: string): void => void db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName, id),
    setColorScheme: (id: string, scheme: ColorScheme): void => void db.prepare("UPDATE users SET color_scheme = ? WHERE id = ?").run(scheme, id),

    userByIdentity(provider: string, subject: string): UserRow | null {
      return toUser(db.prepare("SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?").get(provider, subject));
    },
    linkIdentity(provider: string, subject: string, userId: string): void {
      db.prepare("INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)").run(provider, subject, userId, now());
    },
    /** The subject a person's linked sign-in has at a provider, or null. */
    identitySubject(userId: string, provider: string): string | null {
      const row = db.prepare("SELECT subject FROM identities WHERE user_id = ? AND provider = ?").get(userId, provider);
      return isRecord(row) && typeof row.subject === "string" ? row.subject : null;
    },
    identitiesOf(userId: string): readonly string[] {
      return db.prepare("SELECT provider FROM identities WHERE user_id = ? ORDER BY provider").all(userId).flatMap((r) => (isRecord(r) && typeof r.provider === "string" ? [r.provider] : []));
    },

    createSession(tokenHash: string, userId: string, expiresAt: Date, via: string): void {
      db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, via) VALUES (?, ?, ?, ?, ?)").run(tokenHash, userId, now(), expiresAt.toISOString(), via);
    },
    userBySession(tokenHash: string): UserRow | null {
      return toUser(db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?").get(tokenHash, now()));
    },
    session(tokenHash: string): SessionInfo | null {
      const row = db.prepare("SELECT via, created_at, user_id FROM sessions WHERE token_hash = ? AND expires_at > ?").get(tokenHash, now());
      if (!isRecord(row)) return null;
      const user = toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(str(row, "user_id")));
      return user ? { user, via: str(row, "via"), created_at: str(row, "created_at") } : null;
    },
    deleteSession: (tokenHash: string): void => void db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash),
    /** Signs the person out everywhere except, optionally, the session they are using. */
    deleteSessionsOf: (userId: string, keepTokenHash: string | null = null): void => void db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?").run(userId, keepTokenHash),
    setPassword: (userId: string, passwordHash: string): void => void db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId),

    createPasswordReset(tokenHash: string, userId: string, expiresAt: Date): void {
      db.prepare("DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?").run(userId, now());
      db.prepare("INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(tokenHash, userId, now(), expiresAt.toISOString());
    },
    /** The person a reset link is for, while it is unused and unexpired (reading it does not use it up). */
    userByPasswordReset(tokenHash: string): UserRow | null {
      return toUser(db.prepare("SELECT u.* FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.expires_at > ?").get(tokenHash, now()));
    },
    usePasswordReset: (tokenHash: string): void => void db.prepare("DELETE FROM password_resets WHERE token_hash = ?").run(tokenHash),

    createModel(input: { id: string; ownerId: string; name: string }): ModelRow {
      const at = now();
      db.prepare("INSERT INTO models (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(input.id, input.ownerId, input.name, at, at);
      const model = toModel(db.prepare("SELECT * FROM models WHERE id = ?").get(input.id));
      if (!model) throw new Error("[mutinybim-web db] the new model was not saved");
      return model;
    },
    modelsOf: (userId: string): readonly ModelRow[] => db.prepare("SELECT * FROM models WHERE owner_id = ? ORDER BY updated_at DESC").all(userId).flatMap((r) => toModel(r) ?? []),
    modelById: (id: string): ModelRow | null => toModel(db.prepare("SELECT * FROM models WHERE id = ?").get(id)),
    countModelsOf(userId: string): number {
      const row = db.prepare("SELECT count(*) AS n FROM models WHERE owner_id = ?").get(userId);
      return isRecord(row) && typeof row.n === "number" ? row.n : 0;
    },
    renameModel: (id: string, name: string): void => void db.prepare("UPDATE models SET name = ?, updated_at = ? WHERE id = ?").run(name, now(), id),
    touchModel: (id: string): void => void db.prepare("UPDATE models SET updated_at = ? WHERE id = ?").run(now(), id),
    deleteModel: (id: string): void => void db.prepare("DELETE FROM models WHERE id = ?").run(id),

    /** What this person may do with a model: own it, edit it, view it, or nothing (null). */
    accessTo(userId: string, modelId: string): { readonly model: ModelRow; readonly access: ModelAccess } | null {
      const model = toModel(db.prepare("SELECT * FROM models WHERE id = ?").get(modelId));
      if (!model) return null;
      if (model.owner_id === userId) return { model, access: "owner" };
      const row = db.prepare("SELECT role FROM model_shares WHERE model_id = ? AND user_id = ?").get(modelId, userId);
      return isRecord(row) ? { model, access: shareRole(row.role) } : null;
    },
    sharedWith(userId: string): readonly SharedModelRow[] {
      return db
        .prepare("SELECT m.*, s.role, u.display_name AS owner_name FROM model_shares s JOIN models m ON m.id = s.model_id JOIN users u ON u.id = m.owner_id WHERE s.user_id = ? ORDER BY m.updated_at DESC")
        .all(userId)
        .flatMap((r) => {
          const model = toModel(r);
          return model && isRecord(r) ? [{ ...model, role: shareRole(r.role), owner_name: str(r, "owner_name") }] : [];
        });
    },
    sharesOf(modelId: string): readonly ShareRow[] {
      return db
        .prepare("SELECT s.user_id, u.email, u.display_name, s.role, s.created_at FROM model_shares s JOIN users u ON u.id = s.user_id WHERE s.model_id = ? ORDER BY s.created_at")
        .all(modelId)
        .flatMap((r) => (isRecord(r) ? [{ user_id: str(r, "user_id"), email: str(r, "email"), display_name: str(r, "display_name"), role: shareRole(r.role), created_at: str(r, "created_at") }] : []));
    },
    share(input: { modelId: string; userId: string; role: ShareRole; invitedBy: string }): void {
      db.prepare("INSERT INTO model_shares (model_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (model_id, user_id) DO UPDATE SET role = excluded.role").run(input.modelId, input.userId, input.role, input.invitedBy, now());
    },
    unshare: (modelId: string, userId: string): void => void db.prepare("DELETE FROM model_shares WHERE model_id = ? AND user_id = ?").run(modelId, userId),

    createAgentKey(input: { id: string; userId: string; keyHash: string; label: string; last4: string }): void {
      db.prepare("INSERT INTO agent_keys (id, user_id, key_hash, label, last4, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(input.id, input.userId, input.keyHash, input.label, input.last4, now());
    },
    agentKeysOf: (userId: string): readonly AgentKeyRow[] => db.prepare("SELECT * FROM agent_keys WHERE user_id = ? ORDER BY created_at DESC").all(userId).flatMap((r) => toAgentKey(r) ?? []),
    userByAgentKey(keyHash: string): UserRow | null {
      const row = db.prepare("SELECT user_id FROM agent_keys WHERE key_hash = ?").get(keyHash);
      if (!isRecord(row) || typeof row.user_id !== "string") return null;
      db.prepare("UPDATE agent_keys SET last_used_at = ? WHERE key_hash = ?").run(now(), keyHash);
      return toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id));
    },
    deleteAgentKey: (id: string, userId: string): void => void db.prepare("DELETE FROM agent_keys WHERE id = ? AND user_id = ?").run(id, userId),

    oauthClient(provider: string, redirectUri: string): OAuthClientRow | null {
      const row = db.prepare("SELECT * FROM oauth_clients WHERE provider = ? AND redirect_uri = ?").get(provider, redirectUri);
      if (!isRecord(row)) return null;
      return { provider: str(row, "provider"), client_id: str(row, "client_id"), redirect_uri: str(row, "redirect_uri"), registered_at: str(row, "registered_at") };
    },
    saveOAuthClient(provider: string, redirectUri: string, clientId: string): void {
      db.prepare("INSERT OR REPLACE INTO oauth_clients (provider, redirect_uri, client_id, registered_at) VALUES (?, ?, ?, ?)").run(provider, redirectUri, clientId, now());
    },
    forgetOAuthClient: (provider: string, redirectUri: string): void => void db.prepare("DELETE FROM oauth_clients WHERE provider = ? AND redirect_uri = ?").run(provider, redirectUri),

    saveAssistantClient(input: { clientId: string; clientName: string; redirectUris: readonly string[]; kind: "registered" | "metadata"; tokenAuthMethod?: AssistantTokenAuthMethod; secretHash?: string | null }): void {
      db.prepare("INSERT OR REPLACE INTO assistant_clients (client_id, client_name, redirect_uris, kind, token_auth_method, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        input.clientId,
        input.clientName,
        JSON.stringify(input.redirectUris),
        input.kind,
        input.tokenAuthMethod ?? "none",
        input.secretHash ?? null,
        now(),
      );
    },
    assistantClient(clientId: string): AssistantClientRow | null {
      const row = db.prepare("SELECT * FROM assistant_clients WHERE client_id = ?").get(clientId);
      if (!isRecord(row)) return null;
      const uris: unknown = JSON.parse(str(row, "redirect_uris"));
      const kind = row.kind === "metadata" ? "metadata" : "registered";
      const tokenAuthMethod: AssistantTokenAuthMethod = row.token_auth_method === "client_secret_post" || row.token_auth_method === "client_secret_basic" ? row.token_auth_method : "none";
      const secretHash = typeof row.secret_hash === "string" && row.secret_hash ? row.secret_hash : null;
      return {
        client_id: str(row, "client_id"),
        client_name: str(row, "client_name"),
        redirect_uris: Array.isArray(uris) ? uris.filter((u): u is string => typeof u === "string") : [],
        kind,
        token_auth_method: tokenAuthMethod,
        secret_hash: secretHash,
        created_at: str(row, "created_at"),
      };
    },
    countAssistantClients(): number {
      const row = db.prepare("SELECT count(*) AS n FROM assistant_clients").get();
      return isRecord(row) && typeof row.n === "number" ? row.n : 0;
    },

    saveAssistantCode(codeHash: string, code: AssistantCodeRow, expiresAt: Date): void {
      db.prepare("DELETE FROM assistant_codes WHERE expires_at < ?").run(now());
      db.prepare("INSERT INTO assistant_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(codeHash, code.client_id, code.user_id, code.redirect_uri, code.code_challenge, code.resource, code.scope, expiresAt.toISOString());
    },
    /** A sign-in code, used up by reading it (a code works once). */
    takeAssistantCode(codeHash: string): AssistantCodeRow | null {
      const row = db.prepare("SELECT * FROM assistant_codes WHERE code_hash = ? AND expires_at > ?").get(codeHash, now());
      db.prepare("DELETE FROM assistant_codes WHERE code_hash = ?").run(codeHash);
      if (!isRecord(row)) return null;
      return { client_id: str(row, "client_id"), user_id: str(row, "user_id"), redirect_uri: str(row, "redirect_uri"), code_challenge: str(row, "code_challenge"), resource: str(row, "resource"), scope: str(row, "scope") };
    },

    createAssistantGrant(input: { id: string; userId: string; clientId: string; clientName: string; resource: string; scope: string; accessHash: string; accessExpiresAt: Date; refreshHash: string; refreshExpiresAt: Date }): void {
      db.prepare(
        "INSERT INTO assistant_grants (id, user_id, client_id, client_name, resource, scope, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.id, input.userId, input.clientId, input.clientName, input.resource, input.scope, input.accessHash, input.accessExpiresAt.toISOString(), input.refreshHash, input.refreshExpiresAt.toISOString(), now());
    },
    /** The grant an unexpired access token belongs to, and its person. */
    assistantGrantByAccess(accessHash: string): { readonly grant: AssistantGrantRow; readonly user: UserRow } | null {
      const row = db.prepare("SELECT * FROM assistant_grants WHERE access_hash = ? AND access_expires_at > ?").get(accessHash, now());
      const grant = toGrant(row);
      if (!grant) return null;
      const user = toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(grant.user_id));
      if (!user) return null;
      db.prepare("UPDATE assistant_grants SET last_used_at = ? WHERE id = ?").run(now(), grant.id);
      return { grant, user };
    },
    /**
     * Swaps a refresh token for new tokens (rotation). Presenting the refresh
     * token that was already swapped means it leaked: the grant is ended.
     */
    rotateAssistantRefresh(refreshHash: string, clientId: string, next: { accessHash: string; accessExpiresAt: Date; refreshHash: string; refreshExpiresAt: Date }): { readonly grant: AssistantGrantRow } | { readonly reused: true } | null {
      const reused = toGrant(db.prepare("SELECT * FROM assistant_grants WHERE previous_refresh_hash = ?").get(refreshHash));
      if (reused) {
        db.prepare("DELETE FROM assistant_grants WHERE id = ?").run(reused.id);
        return { reused: true };
      }
      const grant = toGrant(db.prepare("SELECT * FROM assistant_grants WHERE refresh_hash = ? AND refresh_expires_at > ? AND client_id = ?").get(refreshHash, now(), clientId));
      if (!grant) return null;
      db.prepare("UPDATE assistant_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, previous_refresh_hash = ?, refresh_expires_at = ? WHERE id = ?").run(
        next.accessHash,
        next.accessExpiresAt.toISOString(),
        next.refreshHash,
        refreshHash,
        next.refreshExpiresAt.toISOString(),
        grant.id,
      );
      return { grant };
    },
    assistantGrantsOf: (userId: string): readonly AssistantGrantRow[] => db.prepare("SELECT * FROM assistant_grants WHERE user_id = ? ORDER BY created_at DESC").all(userId).flatMap((r) => toGrant(r) ?? []),
    deleteAssistantGrant: (id: string, userId: string): void => void db.prepare("DELETE FROM assistant_grants WHERE id = ? AND user_id = ?").run(id, userId),
    /** Ends the grant a token (access or refresh) belongs to; the grant's id, or null when the token was unknown. */
    revokeAssistantToken(tokenHash: string): string | null {
      const grant = toGrant(db.prepare("SELECT * FROM assistant_grants WHERE access_hash = ? OR refresh_hash = ?").get(tokenHash, tokenHash));
      if (!grant) return null;
      db.prepare("DELETE FROM assistant_grants WHERE id = ?").run(grant.id);
      return grant.id;
    },
    assistantGrantExists(id: string): boolean {
      return isRecord(db.prepare("SELECT 1 AS one FROM assistant_grants WHERE id = ?").get(id));
    },

    saveAssistantApproval(row: AssistantApprovalRow): void {
      db.prepare(
        "INSERT INTO assistant_approvals (id, user_id, client_name, model_id, model_name, summary, details, kind, key, state, outcome, landing, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state, outcome = excluded.outcome, landing = excluded.landing",
      ).run(row.id, row.user_id, row.client_name, row.model_id, row.model_name, row.summary, JSON.stringify(row.details), row.kind, row.key, row.state, row.outcome, row.landing === null || row.landing === undefined ? null : JSON.stringify(row.landing), row.created_at);
    },
    assistantApproval: (id: string): AssistantApprovalRow | null => toApproval(db.prepare("SELECT * FROM assistant_approvals WHERE id = ?").get(id)),
    assistantApprovalsOf: (userId: string): readonly AssistantApprovalRow[] => db.prepare("SELECT * FROM assistant_approvals WHERE user_id = ? ORDER BY created_at DESC").all(userId).flatMap((r) => toApproval(r) ?? []),
    /** Waiting requests older than `cutoff` become expired; rows older than `dropBefore` go. */
    expireAssistantApprovals(cutoff: number, dropBefore: number, outcome: string): void {
      db.prepare("UPDATE assistant_approvals SET state = 'expired', outcome = ?, landing = NULL WHERE state = 'waiting' AND created_at < ?").run(outcome, cutoff);
      db.prepare("DELETE FROM assistant_approvals WHERE created_at < ?").run(dropBefore);
    },

    /**
     * A script an assistant sent, kept so later calls name it by id (and a preview lands by it), across restarts.
     * `body` is the tool server's record, stored whole; a person's oldest go once they hold more than `keep`.
     */
    saveKeptScript(input: { id: string; userId: string; body: unknown; expiresAt: number; keep: number }): void {
      const at = Date.now();
      db.prepare("DELETE FROM assistant_kept_scripts WHERE expires_at <= ?").run(at);
      db.prepare(
        "INSERT INTO assistant_kept_scripts (id, user_id, body, expires_at, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at, saved_at = excluded.saved_at WHERE assistant_kept_scripts.user_id = excluded.user_id",
      ).run(input.id, input.userId, JSON.stringify(input.body), input.expiresAt, at);
      db.prepare("DELETE FROM assistant_kept_scripts WHERE user_id = ? AND id NOT IN (SELECT id FROM assistant_kept_scripts WHERE user_id = ? ORDER BY saved_at DESC, id LIMIT ?)").run(input.userId, input.userId, input.keep);
    },
    /** The kept script's record, only for the person it was kept for and only before it expires. */
    keptScript(id: string, userId: string): unknown {
      const row = db.prepare("SELECT body FROM assistant_kept_scripts WHERE id = ? AND user_id = ? AND expires_at > ?").get(id, userId, Date.now());
      return isRecord(row) ? parseJson(strOrNull(row, "body")) : null;
    },

    saveAssistantSession(row: AssistantSessionRow): void {
      db.prepare(
        "INSERT INTO assistant_sessions (id, user_id, grant_id, family, families, run_id, init, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET families = excluded.families, last_seen_at = excluded.last_seen_at",
      ).run(row.id, row.user_id, row.grant_id, row.family, JSON.stringify(row.families), row.run_id, JSON.stringify(row.init), Date.now(), row.last_seen_at);
    },
    assistantSession: (id: string): AssistantSessionRow | null => toAssistantSession(db.prepare("SELECT * FROM assistant_sessions WHERE id = ?").get(id)),
    touchAssistantSession: (id: string, at: number): void => void db.prepare("UPDATE assistant_sessions SET last_seen_at = ? WHERE id = ?").run(at, id),
    deleteAssistantSession: (id: string): void => void db.prepare("DELETE FROM assistant_sessions WHERE id = ?").run(id),
    deleteAssistantSessionsBefore: (cutoff: number): void => void db.prepare("DELETE FROM assistant_sessions WHERE last_seen_at < ?").run(cutoff),
    /** Keeps a person's `keep` most recent sessions. */
    trimAssistantSessions: (userId: string, keep: number): void =>
      void db.prepare("DELETE FROM assistant_sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM assistant_sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT ?)").run(userId, userId, keep),

    linkedGrant: (userId: string, provider: string): LinkedGrantRow | null => toLinkedGrant(db.prepare("SELECT * FROM linked_grants WHERE user_id = ? AND provider = ?").get(userId, provider)),
    saveLinkedGrant(input: { userId: string; provider: string; clientId: string; accessCipher: string; refreshCipher: string; accessExpiresAt: Date; refreshExpiresAt: Date }): void {
      const at = now();
      db.prepare(
        "INSERT INTO linked_grants (user_id, provider, client_id, access_cipher, refresh_cipher, access_expires_at, refresh_expires_at, state, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?) " +
          "ON CONFLICT (user_id, provider) DO UPDATE SET client_id = excluded.client_id, access_cipher = excluded.access_cipher, refresh_cipher = excluded.refresh_cipher, access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at, state = 'ok', last_error = NULL, updated_at = excluded.updated_at",
      ).run(input.userId, input.provider, input.clientId, input.accessCipher, input.refreshCipher, input.accessExpiresAt.toISOString(), input.refreshExpiresAt.toISOString(), at, at);
    },
    /** The host refused the pass: keep the row (so the page says "reconnect"), drop the ciphertext. */
    markLinkedReconnect(userId: string, provider: string, error: string): void {
      db.prepare("UPDATE linked_grants SET state = 'reconnect', access_cipher = '', refresh_cipher = '', last_error = ?, updated_at = ? WHERE user_id = ? AND provider = ?").run(error.slice(0, 300), now(), userId, provider);
      db.prepare("DELETE FROM linked_models WHERE user_id = ? AND provider = ?").run(userId, provider);
    },
    deleteLinkedGrant(userId: string, provider: string): void {
      db.prepare("DELETE FROM linked_grants WHERE user_id = ? AND provider = ?").run(userId, provider);
      db.prepare("DELETE FROM linked_models WHERE user_id = ? AND provider = ?").run(userId, provider);
    },
    linkedModelsOf: (userId: string, provider: string): readonly LinkedModelRow[] =>
      db.prepare("SELECT * FROM linked_models WHERE user_id = ? AND provider = ? ORDER BY label").all(userId, provider).flatMap((r) => toLinkedModel(r) ?? []),
    linkedModelByAlias: (userId: string, aliasId: string): LinkedModelRow | null => toLinkedModel(db.prepare("SELECT * FROM linked_models WHERE user_id = ? AND alias_id = ?").get(userId, aliasId)),
    /** The host's list as it is now: known models keep their alias, new ones get one, the rest go. */
    replaceLinkedModels(userId: string, provider: string, rows: readonly { remoteModelId: string; remoteProjectId: string; label: string; canEdit: boolean; openUrl: string | null }[], newAlias: () => string): readonly LinkedModelRow[] {
      const at = now();
      db.exec("BEGIN");
      try {
        const keep = new Set<string>();
        for (const r of rows) {
          keep.add(r.remoteModelId);
          db.prepare(
            "INSERT INTO linked_models (alias_id, user_id, provider, remote_model_id, remote_project_id, label, can_edit, open_url, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT (user_id, provider, remote_model_id) DO UPDATE SET remote_project_id = excluded.remote_project_id, label = excluded.label, can_edit = excluded.can_edit, open_url = excluded.open_url, seen_at = excluded.seen_at",
          ).run(newAlias(), userId, provider, r.remoteModelId, r.remoteProjectId, r.label, r.canEdit ? 1 : 0, r.openUrl, at);
        }
        for (const existing of db.prepare("SELECT alias_id, remote_model_id FROM linked_models WHERE user_id = ? AND provider = ?").all(userId, provider)) {
          if (isRecord(existing) && typeof existing.remote_model_id === "string" && !keep.has(existing.remote_model_id)) db.prepare("DELETE FROM linked_models WHERE alias_id = ?").run(str(existing, "alias_id"));
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return db.prepare("SELECT * FROM linked_models WHERE user_id = ? AND provider = ? ORDER BY label").all(userId, provider).flatMap((r) => toLinkedModel(r) ?? []);
    },
    linkedOfferAnswered(userId: string, provider: string): boolean {
      return isRecord(db.prepare("SELECT 1 AS one FROM linked_offers WHERE user_id = ? AND provider = ?").get(userId, provider));
    },
    answerLinkedOffer: (userId: string, provider: string): void => void db.prepare("INSERT OR REPLACE INTO linked_offers (user_id, provider, answered_at) VALUES (?, ?, ?)").run(userId, provider, now()),

    saveOAuthState(input: { state: string; provider: string; codeVerifier: string; returnTo: string }): void {
      db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - 15 * 60_000).toISOString());
      db.prepare("INSERT INTO oauth_states (state, provider, code_verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?)").run(input.state, input.provider, input.codeVerifier, input.returnTo, now());
    },
    takeOAuthState(state: string): OAuthStateRow | null {
      const row = db.prepare("SELECT * FROM oauth_states WHERE state = ? AND created_at > ?").get(state, new Date(Date.now() - 15 * 60_000).toISOString());
      db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
      if (!isRecord(row)) return null;
      return { state: str(row, "state"), provider: str(row, "provider"), code_verifier: str(row, "code_verifier"), return_to: str(row, "return_to"), created_at: str(row, "created_at") };
    },
  };
}
