import type { Command, CommandError, CommandRequest } from "@permitzip/bim-kernel";
import type { CommitOutcome } from "../store";
import type { ScheduleChannel } from "../client";
import { applyRowPatch } from "@permitzip/bim-kernel/schedules";
import { CellHoldTracker, EDITING_CELL_REFRESH_MS, type CellAddress } from "./cell-holds";
import {
  EDITING_CELL_MAX_TTL_MS,
  decodeRowPatch,
  decodeRowSet,
  type ActorRef,
  type ScheduleClientMessage,
  type ScheduleClosedReason,
  type ScheduleServerMessage,
  type ScheduleTarget,
  type ScheduleWindow,
} from "./protocol";
import type { CellValue, ColumnId, RowKey, RowPatch, RowSet } from "./rows";

/**
 * The browser side of schedule subscriptions: what the schedule grid
 * (`@permitzip/bim-schedules-ui`) calls a `ScheduleConnection`, backed by
 * the live-sync socket. Rows arrive whole for the open window, then as
 * patches. A cell edit becomes one kernel command (one undo); while someone
 * else holds the cell, the edit waits until they release it or the hold
 * lapses, at most EDITING_CELL_MAX_TTL_MS.
 */

export interface CellRef {
  readonly rowKey: RowKey;
  readonly columnId: ColumnId;
  readonly parent?: { readonly rowKey: RowKey; readonly columnId: ColumnId };
}

export interface CellEdit extends CellRef {
  readonly value: CellValue;
}

export interface CellEditBatch {
  readonly source: "type" | "paste" | "fill_down" | "clear";
  readonly edits: readonly CellEdit[];
}

export interface TypeScopeImpact {
  readonly typeLabel: string;
  readonly instanceCount: number;
  readonly columnHeading: string;
}

export type CellRefusal = CellRef & { readonly reason: string };

export interface EditPreview {
  readonly typeScope: readonly TypeScopeImpact[];
  readonly refusals: readonly CellRefusal[];
}

export type EditOutcome = { readonly ok: true; readonly revision: number; readonly refusals: readonly CellRefusal[] } | { readonly ok: false; readonly message: string };

export interface EditingPresence extends CellRef {
  readonly actor: ActorRef;
  readonly expiresAt: number;
}

export type ScheduleEvent =
  /** `total`: the whole schedule's row count (the window holds `rows.rowCount`). */
  | { readonly type: "rows"; readonly rows: RowSet; readonly total: number; readonly window: ScheduleWindow }
  | { readonly type: "patch"; readonly patch: RowPatch; readonly total?: number }
  | { readonly type: "closed"; readonly reason: ScheduleClosedReason; readonly message: string }
  | { readonly type: "presence"; readonly editing: readonly EditingPresence[] }
  | { readonly type: "connection"; readonly state: "connected" | "reconnecting" };

export interface ScheduleSubscription {
  close(): void;
  requestWindow(window: ScheduleWindow): void;
  preview(batch: CellEditBatch): Promise<EditPreview>;
  edit(batch: CellEditBatch): Promise<EditOutcome>;
  setEditingCell(cell: CellRef | null): void;
  explain(cell: CellRef): Promise<string | null>;
  undo(): void;
  redo(): void;
}

export interface ScheduleConnection {
  readonly actor: ActorRef;
  open(target: ScheduleTarget, listener: (event: ScheduleEvent) => void): ScheduleSubscription;
}

/**
 * Turns cell edits into one kernel command through each field's writer
 * (Streams E/F own the writers). The connection never guesses a command.
 */
export interface CellCommandPlanner {
  plan(rows: RowSet, batch: CellEditBatch): { readonly command: Command | null; readonly typeScope: readonly TypeScopeImpact[]; readonly refusals: readonly CellRefusal[] };
  explain?(rows: RowSet, cell: CellRef): string | null;
}

/** The parts of SyncClient a schedule connection uses. */
export interface ScheduleClientPort {
  attachSchedules(channel: ScheduleChannel): () => void;
  scheduleReady(): boolean;
  sendSchedule(msg: ScheduleClientMessage): void;
  submit(command: Command): { ok: true; request: CommandRequest } | { ok: false; error: CommandError };
}

export interface SyncScheduleConnectionOptions {
  readonly planner?: CellCommandPlanner;
  /** Host undo/redo (the model's own undo stack). */
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  readonly now?: () => number;
}

export const EDITING_NOT_AVAILABLE = "Editing schedule cells isn't available yet in this model. Edit the value on the element instead.";

interface OpenSubscription {
  readonly id: string;
  readonly target: ScheduleTarget;
  window: ScheduleWindow;
  viewId: string | null;
  rows: RowSet | null;
  readonly listener: (event: ScheduleEvent) => void;
  editing: CellAddress | null;
  refresh: ReturnType<typeof setInterval> | null;
}

interface WaitingEdit {
  readonly cells: readonly CellAddress[];
  readonly deadline: number;
  readonly go: () => void;
}

let subscriptionCounter = 0;

export class SyncScheduleConnection implements ScheduleConnection {
  private readonly subs = new Map<string, OpenSubscription>();
  private readonly holds = new CellHoldTracker();
  private readonly outcomes = new Map<string, (outcome: CommitOutcome) => void>();
  private waiting: WaitingEdit[] = [];
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly detach: () => void;
  private readonly now: () => number;

  constructor(
    private readonly client: ScheduleClientPort,
    readonly actor: ActorRef,
    private readonly options: SyncScheduleConnectionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.detach = client.attachSchedules({
      message: (msg) => this.receive(msg),
      welcomed: () => this.welcomed(),
      left: (connectionId) => {
        this.holds.forget(connectionId);
        this.holdsChanged();
      },
      outcome: (request, outcome) => {
        const settle = this.outcomes.get(request.idempotencyKey);
        if (!settle) return;
        this.outcomes.delete(request.idempotencyKey);
        settle(outcome);
      },
    });
  }

  open(target: ScheduleTarget, listener: (event: ScheduleEvent) => void): ScheduleSubscription {
    subscriptionCounter += 1;
    const sub: OpenSubscription = {
      id: `sched-${subscriptionCounter}-${Math.floor(this.now()).toString(36)}`,
      target,
      window: { offset: 0, limit: 200 },
      viewId: "viewId" in target ? target.viewId : null,
      rows: null,
      listener,
      editing: null,
      refresh: null,
    };
    this.subs.set(sub.id, sub);
    if (this.client.scheduleReady()) this.client.sendSchedule({ type: "schedule_open", subscriptionId: sub.id, target, window: sub.window });
    return {
      close: () => this.close(sub),
      requestWindow: (window) => {
        sub.window = window;
        if (this.client.scheduleReady()) this.client.sendSchedule({ type: "schedule_window", subscriptionId: sub.id, window });
      },
      preview: (batch) => Promise.resolve(this.preview(sub, batch)),
      edit: (batch) => this.edit(sub, batch),
      setEditingCell: (cell) => this.setEditingCell(sub, cell),
      explain: (cell) => Promise.resolve(sub.rows && this.options.planner?.explain ? this.options.planner.explain(sub.rows, cell) : null),
      undo: () => this.options.onUndo?.(),
      redo: () => this.options.onRedo?.(),
    };
  }

  /** Stop listening (the host is tearing down the socket). */
  dispose(): void {
    for (const sub of [...this.subs.values()]) this.close(sub);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.detach();
  }

  /** Other people's live holds on a view (the grid's presence outlines). */
  editingOn(viewId: string): EditingPresence[] {
    return this.holds.forView(viewId, this.now()).map((h) => ({ rowKey: h.rowKey, columnId: h.columnId, actor: h.actor, expiresAt: h.expiresAt }));
  }

  private close(sub: OpenSubscription): void {
    if (!this.subs.delete(sub.id)) return;
    this.setEditingCell(sub, null);
    if (this.client.scheduleReady()) this.client.sendSchedule({ type: "schedule_close", subscriptionId: sub.id });
  }

  private receive(msg: ScheduleServerMessage): void {
    switch (msg.type) {
      case "schedule_rows": {
        const sub = this.subs.get(msg.subscriptionId);
        if (!sub) return;
        sub.rows = decodeRowSet(msg.rows);
        sub.viewId = sub.rows.viewId;
        sub.listener({ type: "rows", rows: sub.rows, total: msg.total, window: msg.window });
        sub.listener({ type: "presence", editing: this.editingOn(sub.viewId) });
        return;
      }
      case "schedule_patch": {
        const sub = this.subs.get(msg.subscriptionId);
        if (!sub) return;
        const patch = decodeRowPatch(msg.patch);
        if (sub.rows) sub.rows = applyRowPatch(sub.rows, patch);
        sub.listener({ type: "patch", patch, ...(msg.total !== undefined ? { total: msg.total } : {}) });
        return;
      }
      case "schedule_closed": {
        const sub = this.subs.get(msg.subscriptionId);
        if (!sub) return;
        this.subs.delete(sub.id);
        if (sub.refresh) clearInterval(sub.refresh);
        sub.listener({ type: "closed", reason: msg.reason, message: msg.message });
        return;
      }
      case "editing_cell":
      case "editing_cell_release":
        this.holds.receive(msg, this.now());
        this.holdsChanged();
        return;
    }
  }

  private welcomed(): void {
    for (const sub of this.subs.values()) {
      this.client.sendSchedule({ type: "schedule_open", subscriptionId: sub.id, target: sub.target, window: sub.window });
      if (sub.editing) this.client.sendSchedule({ type: "editing_cell", ...sub.editing, ttlMs: EDITING_CELL_MAX_TTL_MS });
      sub.listener({ type: "connection", state: "connected" });
    }
  }

  private setEditingCell(sub: OpenSubscription, cell: CellRef | null): void {
    const viewId = sub.viewId;
    if (sub.editing && this.client.scheduleReady()) this.client.sendSchedule({ type: "editing_cell_release", ...sub.editing });
    if (sub.refresh) clearInterval(sub.refresh);
    sub.refresh = null;
    sub.editing = null;
    if (!cell || !viewId) return;
    const address: CellAddress = { viewId, rowKey: cell.rowKey, columnId: cell.columnId };
    sub.editing = address;
    const announce = () => {
      if (this.client.scheduleReady()) this.client.sendSchedule({ type: "editing_cell", ...address, ttlMs: EDITING_CELL_MAX_TTL_MS });
    };
    announce();
    sub.refresh = setInterval(announce, EDITING_CELL_REFRESH_MS);
  }

  private preview(sub: OpenSubscription, batch: CellEditBatch): EditPreview {
    const planner = this.options.planner;
    if (!planner || !sub.rows) return { typeScope: [], refusals: batch.edits.map((e) => refusal(e, EDITING_NOT_AVAILABLE)) };
    const plan = planner.plan(sub.rows, batch);
    return { typeScope: plan.typeScope, refusals: plan.refusals };
  }

  private async edit(sub: OpenSubscription, batch: CellEditBatch): Promise<EditOutcome> {
    const planner = this.options.planner;
    if (!planner) return { ok: false, message: EDITING_NOT_AVAILABLE };
    const viewId = sub.viewId;
    if (viewId) await this.waitForHolds(batch.edits.map((e) => ({ viewId, rowKey: e.rowKey, columnId: e.columnId })));
    if (!sub.rows) return { ok: false, message: "The schedule hasn't loaded yet. Try again in a moment." };
    const plan = planner.plan(sub.rows, batch);
    if (!plan.command) {
      const reasons = [...new Set(plan.refusals.map((r) => r.reason))];
      return { ok: false, message: reasons.length > 0 ? `Nothing was changed: ${reasons.join(" ")}` : "Nothing was changed." };
    }
    const sent = this.client.submit(plan.command);
    if (!sent.ok) return { ok: false, message: sent.error.message };
    const outcome = await new Promise<CommitOutcome>((resolve) => this.outcomes.set(sent.request.idempotencyKey, resolve));
    if (outcome.status === "committed") return { ok: true, revision: outcome.revision, refusals: plan.refusals };
    return { ok: false, message: outcome.error.message };
  }

  /** Resolves once none of `cells` is held by someone else, or EDITING_CELL_MAX_TTL_MS after this call. */
  private waitForHolds(cells: readonly CellAddress[]): Promise<void> {
    const now = this.now();
    if (this.holds.nextExpiry(cells, now) === null) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiting.push({ cells, deadline: now + EDITING_CELL_MAX_TTL_MS, go: resolve });
      this.armExpiry();
    });
  }

  private holdsChanged(): void {
    const now = this.now();
    const still: WaitingEdit[] = [];
    for (const w of this.waiting) {
      if (now >= w.deadline || this.holds.nextExpiry(w.cells, now) === null) w.go();
      else still.push(w);
    }
    this.waiting = still;
    for (const sub of this.subs.values()) if (sub.viewId) sub.listener({ type: "presence", editing: this.editingOn(sub.viewId) });
    this.armExpiry();
  }

  /** Wake when the next hold or wait deadline passes, so a lapsed hold frees its cell without a message. */
  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const now = this.now();
    let next: number | null = null;
    for (const w of this.waiting) {
      const lapse = this.holds.nextExpiry(w.cells, now);
      const at = Math.min(w.deadline, lapse ?? w.deadline);
      if (next === null || at < next) next = at;
    }
    for (const sub of this.subs.values()) {
      if (!sub.viewId) continue;
      for (const h of this.holds.forView(sub.viewId, now)) if (next === null || h.expiresAt < next) next = h.expiresAt;
    }
    if (next === null) return;
    this.expiryTimer = setTimeout(() => this.holdsChanged(), Math.max(0, next - now) + 1);
  }
}

function refusal(cell: CellRef, reason: string): CellRefusal {
  return { rowKey: cell.rowKey, columnId: cell.columnId, ...(cell.parent ? { parent: cell.parent } : {}), reason };
}
