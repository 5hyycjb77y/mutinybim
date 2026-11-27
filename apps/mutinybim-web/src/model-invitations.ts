import type { DatabaseSync } from "node:sqlite";

/**
 * Invitations to a native hosted model (#26, #27). The owner names an email
 * address; nothing looks up whether an account uses it. A share is made only
 * when an account whose confirmed address matches accepts, while the inviter
 * still owns the model. Only the digest of the invitation link is kept.
 */
export const SQLITE_INVITATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS model_invitations (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    email TEXT NOT NULL CHECK (email = lower(email)),
    role TEXT NOT NULL CHECK (role IN ('view','edit')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','accepted','declined','cancelled')),
    answered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    answered_at TEXT,
    CHECK ((state = 'open') = (answered_at IS NULL))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS model_invitations_open ON model_invitations(model_id, email) WHERE state = 'open';
  CREATE INDEX IF NOT EXISTS model_invitations_inbox ON model_invitations(email, expires_at) WHERE state = 'open';
  -- A handover ends the open invitations, so they can't come back if the model is handed back.
  CREATE TRIGGER IF NOT EXISTS end_invitations_on_handover AFTER UPDATE OF owner_id ON models
  WHEN OLD.owner_id <> NEW.owner_id BEGIN
    UPDATE model_invitations SET state = 'cancelled', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE model_id = NEW.id AND state = 'open';
  END;
`;

/** How long an invitation can be accepted. */
export const INVITATION_DAYS = 7;

export type InvitationRole = "view" | "edit";
export type InvitationState = "open" | "accepted" | "declined" | "cancelled";
export type InvitationAction = "accept" | "decline";
/** What answering an invitation did. "unavailable" covers every refusal alike. */
export type InvitationAnswer = "accepted" | "declined" | "unavailable";

/** An invitation as its model's owner sees it. */
export interface Invitation {
  readonly id: string;
  readonly model_id: string;
  readonly email: string;
  readonly role: InvitationRole;
  readonly invited_by: string;
  readonly created_at: string;
  readonly expires_at: string;
}

/** An open invitation as the invited person sees it. */
export interface InvitationCard extends Invitation {
  readonly model_name: string;
  readonly inviter_name: string;
}

export interface NewInvitation {
  readonly id: string;
  readonly modelId: string;
  readonly ownerId: string;
  readonly email: string;
  readonly role: InvitationRole;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface Invitations {
  /** Saves an invitation, replacing an open one for the same address. False when the model isn't the owner's. */
  create(input: NewInvitation): Promise<boolean>;
  /** The owner's open invitations for a model, expired ones included, oldest first. */
  outgoing(modelId: string, ownerId: string): Promise<readonly Invitation[]>;
  /** Cancels an open invitation the owner made for this model. */
  cancel(id: string, modelId: string, ownerId: string): Promise<boolean>;
  /** An open, unexpired invitation that its link names, while its inviter still owns the model. */
  byToken(tokenHash: string): Promise<InvitationCard | null>;
  /** The open, unexpired invitations for an address, while each inviter still owns its model. */
  inbox(email: string): Promise<readonly InvitationCard[]>;
  /**
   * In one database operation: answers an open, unexpired invitation for the
   * account's current, confirmed address, while the inviter still owns the
   * model. Accepting saves the personal share (an existing share takes the new
   * role and keeps its grant). Anything else changes nothing.
   */
  respond(id: string, userId: string, action: InvitationAction): Promise<InvitationAnswer>;
}

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

function field(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") throw new Error(`Invalid model invitation field ${key}`);
  return v;
}

export function invitationRow(value: unknown): Invitation {
  if (!value || typeof value !== "object") throw new Error("Missing model invitation");
  const r = value as Record<string, unknown>;
  const role = r.role;
  if (role !== "view" && role !== "edit") throw new Error("Invalid invitation role");
  return { id: field(r, "id"), model_id: field(r, "model_id"), email: field(r, "email"), role,
    invited_by: field(r, "invited_by"), created_at: field(r, "created_at"), expires_at: field(r, "expires_at") };
}

export function invitationCard(value: unknown): InvitationCard {
  const r = value as Record<string, unknown>;
  return { ...invitationRow(value), model_name: field(r, "model_name"), inviter_name: field(r, "inviter_name") };
}

export function invitationAnswer(value: unknown): InvitationAnswer {
  return value === "accepted" || value === "declined" ? value : "unavailable";
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
// The inviter must still own the model: a handover leaves earlier invitations unusable.
const CARDS = `SELECT i.*, m.name AS model_name, u.display_name AS inviter_name
  FROM model_invitations i JOIN models m ON m.id = i.model_id AND m.owner_id = i.invited_by JOIN users u ON u.id = i.invited_by
  WHERE i.state = 'open' AND i.expires_at > ${NOW}`;

export function sqliteInvitations(db: DatabaseSync, write: <T>(f: () => T) => T): Invitations {
  return {
    async create(input) {
      return write(() => {
        if (!db.prepare("SELECT 1 FROM models WHERE id = ? AND owner_id = ?").get(input.modelId, input.ownerId)) return false;
        const at = new Date().toISOString();
        db.prepare("UPDATE model_invitations SET state = 'cancelled', answered_at = ? WHERE model_id = ? AND email = ? AND state = 'open'")
          .run(at, input.modelId, input.email);
        db.prepare(`INSERT INTO model_invitations (id, model_id, email, role, token_hash, invited_by, created_at, expires_at, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
          .run(input.id, input.modelId, input.email, input.role, input.tokenHash, input.ownerId, at, input.expiresAt.toISOString());
        return true;
      });
    },
    async outgoing(modelId, ownerId) {
      return db.prepare("SELECT * FROM model_invitations WHERE model_id = ? AND invited_by = ? AND state = 'open' ORDER BY created_at, id")
        .all(modelId, ownerId).map(invitationRow);
    },
    async cancel(id, modelId, ownerId) {
      return db.prepare(`UPDATE model_invitations SET state = 'cancelled', answered_at = ?
        WHERE id = ? AND model_id = ? AND invited_by = ? AND state = 'open'`)
        .run(new Date().toISOString(), id, modelId, ownerId).changes === 1;
    },
    async byToken(tokenHash) {
      const row = db.prepare(`${CARDS} AND i.token_hash = ?`).get(tokenHash);
      return row ? invitationCard(row) : null;
    },
    async inbox(email) {
      return db.prepare(`${CARDS} AND i.email = ? ORDER BY i.created_at, i.id`).all(normalizeInviteEmail(email)).map(invitationCard);
    },
    async respond(id, userId, action) {
      return write(() => {
        const eligible = db.prepare(`SELECT i.model_id, i.role, i.invited_by FROM model_invitations i
          JOIN users u ON u.id = ? AND lower(u.email) = i.email AND u.email_confirmed_at IS NOT NULL
          JOIN models m ON m.id = i.model_id AND m.owner_id = i.invited_by AND m.owner_id <> u.id
          WHERE i.id = ? AND i.state = 'open' AND i.expires_at > ${NOW}`).get(userId, id);
        if (!eligible || typeof eligible.model_id !== "string" || typeof eligible.role !== "string" || typeof eligible.invited_by !== "string") return "unavailable";
        const at = new Date().toISOString();
        const state = action === "accept" ? "accepted" : "declined";
        db.prepare("UPDATE model_invitations SET state = ?, answered_by = ?, answered_at = ? WHERE id = ?").run(state, userId, at, id);
        if (action === "accept") {
          db.prepare(`INSERT INTO model_shares (model_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (model_id, user_id) DO UPDATE SET role = excluded.role`)
            .run(eligible.model_id, userId, eligible.role, eligible.invited_by, at);
        }
        return state;
      });
    },
  };
}
