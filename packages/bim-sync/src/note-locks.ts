import type { Actor } from "@permitzip/bim-kernel";
import type { Presence } from "./protocol";

/**
 * Note edit soft locks, carried on presence (never persisted, never a model
 * edit). While someone edits a note their client re-announces
 * `editing_note` every NOTE_LOCK_REFRESH_MS; everyone else sees "Avery is
 * editing this note" and can't open it. A lock lapses when its holder says
 * so, disconnects, or goes quiet for its TTL (a closed laptop), measured on
 * the receiving clock so clock skew between machines doesn't matter.
 *
 * The lock is courtesy, not safety: `edit_text_note` names the content it
 * started from, so an edit that slipped past a lock is still refused, never
 * silently overwritten.
 */

export const NOTE_LOCK_TTL_MS = 45_000;
export const NOTE_LOCK_REFRESH_MS = 15_000;

export interface NoteLock {
  readonly itemId: string;
  readonly ownerId: string;
  readonly actor: Actor;
  readonly connectionId: string;
  /** Receiver clock, epoch ms. */
  readonly expiresAt: number;
}

/** Presence as this client received it, with when (receiver clock). */
export interface SeenPresence {
  readonly presence: Presence;
  readonly receivedAt: number;
}

/**
 * Tracks when each connection's presence last arrived, so locks expire on
 * this machine's clock. Feed it every presence map you get.
 */
export class PresenceClock {
  private readonly seen = new Map<string, SeenPresence>();

  /** Record the latest presence per connection; a changed object counts as a fresh announcement. */
  update(people: ReadonlyMap<string, Presence>, now: number): ReadonlyMap<string, SeenPresence> {
    for (const id of [...this.seen.keys()]) if (!people.has(id)) this.seen.delete(id);
    for (const [id, presence] of people) {
      const prior = this.seen.get(id);
      if (!prior || prior.presence !== presence) this.seen.set(id, { presence, receivedAt: now });
    }
    return this.seen;
  }
}

/**
 * Live note locks held by other connections, by note id. The hub never echoes
 * a connection's own presence back, so everything here is someone else: another
 * person, an agent, or you in another tab. The earliest announcement wins a tie.
 */
export function noteLocks(seen: ReadonlyMap<string, SeenPresence>, now: number): ReadonlyMap<string, NoteLock> {
  const locks = new Map<string, NoteLock>();
  for (const [connectionId, { presence, receivedAt }] of seen) {
    const a = presence.activity;
    if (a.kind !== "editing_note") continue;
    const expiresAt = receivedAt + a.ttlMs;
    if (expiresAt <= now) continue;
    const existing = locks.get(a.itemId);
    if (existing && existing.expiresAt - a.ttlMs <= receivedAt) continue;
    locks.set(a.itemId, { itemId: a.itemId, ownerId: a.ownerId, actor: presence.actor, connectionId, expiresAt });
  }
  return locks;
}

/** The activity to announce while editing a note. */
export function editingNoteActivity(itemId: string, ownerId: string): Extract<Presence["activity"], { kind: "editing_note" }> {
  return { kind: "editing_note", itemId, ownerId, ttlMs: NOTE_LOCK_TTL_MS };
}

/** What others see on a locked note; `selfActorId` names your own other tab as such. */
export function lockMessage(lock: Pick<NoteLock, "actor">, selfActorId?: string): string {
  if (selfActorId && lock.actor.id === selfActorId) return "You're editing this note in another tab or window";
  return lock.actor.kind === "agent" ? `${lock.actor.name} (agent) is editing this note` : `${lock.actor.name} is editing this note`;
}
