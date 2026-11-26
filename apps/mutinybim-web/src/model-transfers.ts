import type { DatabaseSync } from "node:sqlite";

// The grant ID survives a role change. Removing and re-adding the person creates a new grant.
export const SQLITE_TRANSFER_SCHEMA = `
  CREATE TABLE transfer_shares_upgrade (
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('view','edit')),
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    grant_id TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
    PRIMARY KEY(model_id, user_id)
  );
  INSERT INTO transfer_shares_upgrade(model_id, user_id, role, invited_by, created_at)
    SELECT model_id, user_id, role, invited_by, created_at FROM model_shares;
  DROP TABLE model_shares;
  ALTER TABLE transfer_shares_upgrade RENAME TO model_shares;
  CREATE INDEX model_shares_user ON model_shares(user_id);
  CREATE TABLE model_transfers (
    id TEXT PRIMARY KEY, model_id TEXT NOT NULL, model_name TEXT NOT NULL,
    sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, recipient_id TEXT NOT NULL, recipient_name TEXT NOT NULL,
    share_id TEXT NOT NULL, retained TEXT NOT NULL CHECK (retained IN ('view','edit','none')),
    state TEXT NOT NULL CHECK (state IN ('open','accepted','declined','cancelled','expired','invalidated')),
    expires_at TEXT NOT NULL, accepted_at TEXT,
    CHECK (sender_id <> recipient_id), CHECK ((state = 'accepted') = (accepted_at IS NOT NULL))
  );
  CREATE UNIQUE INDEX model_transfers_open ON model_transfers(model_id) WHERE state = 'open';
  CREATE INDEX model_transfers_model ON model_transfers(model_id);
  CREATE INDEX model_transfers_inbox ON model_transfers(recipient_id, expires_at) WHERE state = 'open';
  CREATE TRIGGER end_transfer_on_unshare AFTER DELETE ON model_shares BEGIN
    UPDATE model_transfers SET state = 'invalidated' WHERE model_id = OLD.model_id AND share_id = OLD.grant_id AND state = 'open';
  END;
  CREATE TRIGGER end_transfer_on_delete AFTER DELETE ON models BEGIN
    UPDATE model_transfers SET state = 'invalidated' WHERE model_id = OLD.id AND state = 'open';
  END;
`;

export type RetainedAccess = "edit" | "view" | "none";
export type TransferAction = "accept" | "decline" | "cancel";
export type TransferState = "open" | "accepted" | "declined" | "cancelled" | "expired" | "invalidated";

export interface Transfer {
  readonly id: string;
  readonly model_id: string;
  readonly model_name: string;
  readonly sender_id: string;
  readonly sender_name: string;
  readonly recipient_id: string;
  readonly recipient_name: string;
  readonly share_id: string;
  readonly retained: RetainedAccess;
  readonly state: TransferState;
  readonly expires_at: string;
  readonly accepted_at: string | null;
}

export type TransferResult = Transfer | "unavailable" | "ineligible" | "exists" | "quota";
export interface Transfers {
  forRecipient(id: string, person: string): Promise<Transfer | null>;
  outgoing(modelId: string): Promise<Transfer | null>;
  inbox(recipientId: string): Promise<readonly Transfer[]>;
  offer(id: string, modelId: string, sender: string, recipient: string, retained: RetainedAccess): Promise<TransferResult>;
  respond(id: string, actor: string, action: TransferAction, limit: number): Promise<TransferResult>;
}

export function transferRow(value: unknown): Transfer {
  if (!value || typeof value !== "object") throw new Error("Missing model transfer");
  const r = value as Record<string, unknown>;
  const field = (key: string): string => {
    const v = r[key];
    if (typeof v !== "string") throw new Error(`Invalid model transfer field ${key}`);
    return v;
  };
  const state = r.state;
  const retained = r.retained;
  if (state !== "open" && state !== "accepted" && state !== "declined" && state !== "cancelled" && state !== "expired" && state !== "invalidated") throw new Error("Invalid transfer state");
  if (retained !== "view" && retained !== "edit" && retained !== "none") throw new Error("Invalid retained access");
  return { id: field("id"), model_id: field("model_id"), model_name: field("model_name"), sender_id: field("sender_id"),
    sender_name: field("sender_name"), recipient_id: field("recipient_id"), recipient_name: field("recipient_name"),
    share_id: field("share_id"), retained, state, expires_at: field("expires_at"),
    accepted_at: r.accepted_at === null ? null : field("accepted_at") };
}

export function transferResult(value: unknown): TransferResult {
  if (value === "quota" || value === "unavailable" || value === "ineligible" || value === "exists") return value;
  return transferRow(value);
}

export function occupiedSlots(db: DatabaseSync, owner: string): number {
  const row = db.prepare(`SELECT (SELECT count(*) FROM models WHERE owner_id = ?)
    + (SELECT count(*) FROM model_creations WHERE owner_id = ? AND state = 'reserved') AS used`).get(owner, owner);
  if (typeof row?.used !== "number") throw new Error("Missing account model count");
  return row.used;
}

export function sqliteTransfers(db: DatabaseSync, write: <T>(f: () => T) => T): Transfers {
  const read = (id: string) => db.prepare("SELECT * FROM model_transfers WHERE id = ?").get(id);
  const open = "state = 'open' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  function end(id: string, state: TransferState): Transfer {
    return transferRow(db.prepare("UPDATE model_transfers SET state = ? WHERE id = ? RETURNING *").get(state, id));
  }
  return {
    async forRecipient(id, person) {
      const row = db.prepare("SELECT * FROM model_transfers WHERE id = ? AND recipient_id = ?").get(id, person);
      return row ? transferRow(row) : null;
    },
    async outgoing(id) {
      const row = db.prepare(`SELECT * FROM model_transfers WHERE model_id = ? AND ${open}`).get(id);
      return row ? transferRow(row) : null;
    },
    async inbox(id) {
      return db.prepare(`SELECT * FROM model_transfers WHERE recipient_id = ? AND ${open} ORDER BY expires_at, id`).all(id).map(transferRow);
    },
    async offer(id, modelId, sender, recipient, retained) {
      return write(() => {
        const model = db.prepare("SELECT name FROM models WHERE id = ? AND owner_id = ?").get(modelId, sender);
        if (typeof model?.name !== "string") return "unavailable";
        const share = db.prepare("SELECT grant_id FROM model_shares WHERE model_id = ? AND user_id = ?").get(modelId, recipient);
        if (typeof share?.grant_id !== "string" || sender === recipient) return "ineligible";
        const now = new Date();
        db.prepare("UPDATE model_transfers SET state = 'expired' WHERE model_id = ? AND state = 'open' AND expires_at <= ?").run(modelId, now.toISOString());
        if (db.prepare("SELECT 1 FROM model_transfers WHERE model_id = ? AND state = 'open'").get(modelId)) return "exists";
        const expires = new Date(now.getTime() + 14 * 86_400_000).toISOString();
        const row = db.prepare(`INSERT INTO model_transfers
          (id, model_id, model_name, sender_id, sender_name, recipient_id, recipient_name, share_id, retained, state, expires_at)
          SELECT ?, ?, ?, sender.id, sender.display_name, recipient.id, recipient.display_name, ?, ?, 'open', ?
          FROM users sender, users recipient WHERE sender.id = ? AND recipient.id = ? RETURNING *`)
          .get(id, modelId, model.name, share.grant_id, retained, expires, sender, recipient);
        return transferRow(row);
      });
    },
    async respond(id, actor, action, limit) {
      return write(() => {
        const raw = read(id);
        if (!raw) return "unavailable";
        const offer = transferRow(raw);
        if (actor !== (action === "cancel" ? offer.sender_id : offer.recipient_id)) return "unavailable";
        if (offer.state === "accepted" && action !== "accept") return "unavailable";
        if (offer.state !== "open") return offer;
        const now = new Date().toISOString();
        if (offer.expires_at <= now) return end(id, "expired");
        if (action === "cancel") return end(id, "cancelled");
        if (action === "decline") return end(id, "declined");
        const eligible = db.prepare(`SELECT 1 FROM models m JOIN model_shares s ON s.model_id = m.id
          WHERE m.id = ? AND m.owner_id = ? AND s.user_id = ? AND s.grant_id = ?`)
          .get(offer.model_id, offer.sender_id, actor, offer.share_id);
        if (!eligible) return end(id, "invalidated");
        if (occupiedSlots(db, actor) >= limit) return "quota";
        // Save the receipt in this transaction before consuming the qualifying share.
        const receipt = transferRow(db.prepare("UPDATE model_transfers SET state = 'accepted', accepted_at = ? WHERE id = ? RETURNING *").get(now, id));
        db.prepare("UPDATE models SET owner_id = ? WHERE id = ?").run(actor, offer.model_id);
        db.prepare("DELETE FROM model_shares WHERE model_id = ? AND user_id IN (?, ?)").run(offer.model_id, actor, offer.sender_id);
        if (offer.retained !== "none") {
          db.prepare("INSERT INTO model_shares(model_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(offer.model_id, offer.sender_id, offer.retained, actor, now);
        }
        return receipt;
      });
    },
  };
}
