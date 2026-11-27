import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ShareRole } from "../src/db";

/** Marks an account's current address confirmed, as a confirmation link or a verified sign-in would. */
export function confirmAddress(dataDir: string, email: string): void {
  const db = new DatabaseSync(path.join(dataDir, "accounts.sqlite"));
  try {
    db.prepare("UPDATE users SET email_confirmed_at = '2026-11-27T00:00:00.000Z' WHERE email = ? AND email_confirmed_at IS NULL").run(email);
  } finally { db.close(); }
}

/**
 * Gives an account a personal share the way people do: the owner invites its
 * address on the Share page, and the account accepts the card on My models.
 * The account's address is confirmed first.
 */
export async function shareByInvitation(base: string, dataDir: string, input: {
  readonly owner: string; readonly recipient: string; readonly modelId: string; readonly email: string; readonly role: ShareRole;
}): Promise<void> {
  confirmAddress(dataDir, input.email);
  const form = (body: Record<string, string>) => ({ method: "POST", redirect: "manual" as const,
    headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const invited = await fetch(`${base}/models/${input.modelId}/share`, { ...form({ email: input.email, role: input.role }), headers: { ...form({}).headers, cookie: input.owner } });
  if (invited.status !== 200) throw new Error(`inviting ${input.email} answered ${invited.status}`);
  const db = new DatabaseSync(path.join(dataDir, "accounts.sqlite"));
  let id: string;
  try {
    const row = db.prepare("SELECT id FROM model_invitations WHERE model_id = ? AND email = ? AND state = 'open'").get(input.modelId, input.email.toLowerCase());
    if (typeof row?.id !== "string") throw new Error(`no open invitation for ${input.email}`);
    id = row.id;
  } finally { db.close(); }
  const models = await (await fetch(`${base}/models`, { headers: { cookie: input.recipient } })).text();
  if (!models.includes(`action="/invitations/${id}/accept"`)) throw new Error(`no invitation card for ${input.email} on My models`);
  const accepted = await fetch(`${base}/invitations/${id}/accept`, { ...form({}), headers: { ...form({}).headers, cookie: input.recipient } });
  if (accepted.status !== 303) throw new Error(`accepting the invitation answered ${accepted.status}`);
}
