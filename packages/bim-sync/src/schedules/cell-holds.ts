import { EDITING_CELL_MAX_TTL_MS, type ActorRef, type ScheduleServerMessage } from "./protocol";
import type { ColumnId, RowKey } from "./rows";

/**
 * `editing_cell` holds (SCHEDULES-PLAN §6, D7). While someone types in a
 * schedule cell their client announces it, re-announcing before the TTL runs
 * out. Everyone else sees a coloured outline with the person's name, and
 * their own edit to that cell is held (not sent) until the hold is released
 * or lapses, at most EDITING_CELL_MAX_TTL_MS after they tried.
 *
 * Like note locks this is courtesy, not safety: an edit that does reach the
 * server against a newer value is still a changeset conflict.
 */

export interface CellAddress {
  readonly viewId: string;
  readonly rowKey: RowKey;
  readonly columnId: ColumnId;
}

export function cellKey(cell: CellAddress): string {
  return `${cell.viewId}\u0000${cell.rowKey}\u0000${cell.columnId}`;
}

/** Re-announce a held cell this often (well inside the TTL). */
export const EDITING_CELL_REFRESH_MS = 3_000;

export function heldCellMessage(actor: Pick<ActorRef, "name">, isAgent = false): string {
  return isAgent ? `${actor.name} (agent) is editing this cell` : `${actor.name} is editing this cell`;
}

interface ServerHold {
  readonly connectionId: string;
  readonly actor: ActorRef;
  readonly cell: CellAddress;
  readonly ttlMs: number;
  readonly expiresAt: number;
}

type HoldMessage = Extract<ScheduleServerMessage, { type: "editing_cell" | "editing_cell_release" }>;

/** The server's view of who holds which cell. The first live claim wins; a lapsed one is free. */
export class CellHoldBoard {
  private readonly holds = new Map<string, ServerHold>();

  /** A claim or refresh. Returns what to tell everyone else, or null when someone else holds the cell. */
  claim(connectionId: string, actor: ActorRef, cell: CellAddress, ttlMs: number, now: number): HoldMessage | null {
    const key = cellKey(cell);
    const existing = this.holds.get(key);
    if (existing && existing.connectionId !== connectionId && existing.expiresAt > now) return null;
    const ttl = Math.min(Math.max(ttlMs, 0), EDITING_CELL_MAX_TTL_MS);
    const hold: ServerHold = { connectionId, actor, cell, ttlMs: ttl, expiresAt: now + ttl };
    this.holds.set(key, hold);
    return holdMessage(hold);
  }

  release(connectionId: string, cell: CellAddress): HoldMessage | null {
    const key = cellKey(cell);
    const existing = this.holds.get(key);
    if (!existing || existing.connectionId !== connectionId) return null;
    this.holds.delete(key);
    return { type: "editing_cell_release", connectionId, actor: existing.actor, ...cell };
  }

  /** The connection left or lost access: release everything it held. */
  releaseAll(connectionId: string): HoldMessage[] {
    const out: HoldMessage[] = [];
    for (const [key, hold] of this.holds) {
      if (hold.connectionId !== connectionId) continue;
      this.holds.delete(key);
      out.push({ type: "editing_cell_release", connectionId, actor: hold.actor, ...hold.cell });
    }
    return out;
  }

  /** Live holds for someone joining, with the TTL that remains. */
  current(now: number): HoldMessage[] {
    const out: HoldMessage[] = [];
    for (const [key, hold] of this.holds) {
      if (hold.expiresAt <= now) {
        this.holds.delete(key);
        continue;
      }
      out.push(holdMessage({ ...hold, ttlMs: hold.expiresAt - now }));
    }
    return out;
  }
}

function holdMessage(hold: ServerHold): HoldMessage {
  return { type: "editing_cell", connectionId: hold.connectionId, actor: hold.actor, ...hold.cell, ttlMs: hold.ttlMs, expiresAt: hold.expiresAt };
}

export interface CellHold extends CellAddress {
  readonly connectionId: string;
  readonly actor: ActorRef;
  /** Receiver clock, epoch ms. */
  readonly expiresAt: number;
}

/**
 * The client's view of other people's holds, timed on this machine's clock
 * (receipt + TTL), so clock skew between machines doesn't matter.
 */
export class CellHoldTracker {
  private readonly holds = new Map<string, CellHold>();

  receive(msg: HoldMessage, now: number): void {
    const key = cellKey(msg);
    if (msg.type === "editing_cell") {
      this.holds.set(key, { viewId: msg.viewId, rowKey: msg.rowKey, columnId: msg.columnId, connectionId: msg.connectionId, actor: msg.actor, expiresAt: now + msg.ttlMs });
      return;
    }
    const existing = this.holds.get(key);
    if (existing && existing.connectionId === msg.connectionId) this.holds.delete(key);
  }

  /** A connection left: its holds go with it. */
  forget(connectionId: string): void {
    for (const [key, hold] of this.holds) if (hold.connectionId === connectionId) this.holds.delete(key);
  }

  /** Live holds on one schedule view. */
  forView(viewId: string, now: number): CellHold[] {
    const out: CellHold[] = [];
    for (const [key, hold] of this.holds) {
      if (hold.expiresAt <= now) {
        this.holds.delete(key);
        continue;
      }
      if (hold.viewId === viewId) out.push(hold);
    }
    return out;
  }

  /** The live hold on a cell, if someone else has it. */
  holder(cell: CellAddress, now: number): CellHold | null {
    const hold = this.holds.get(cellKey(cell));
    if (!hold) return null;
    if (hold.expiresAt <= now) {
      this.holds.delete(cellKey(cell));
      return null;
    }
    return hold;
  }

  /** The soonest a currently held cell among `cells` lapses (receiver clock), or null when none is held. */
  nextExpiry(cells: readonly CellAddress[], now: number): number | null {
    let soonest: number | null = null;
    for (const cell of cells) {
      const hold = this.holder(cell, now);
      if (hold && (soonest === null || hold.expiresAt < soonest)) soonest = hold.expiresAt;
    }
    return soonest;
  }
}
