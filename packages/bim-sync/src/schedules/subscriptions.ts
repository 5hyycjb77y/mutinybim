import { applyChangeset, type Changeset, type ModelState } from "@permitzip/bim-kernel";
import { scheduleTargetKey, type ScheduleEvaluator, type ScheduleInstance } from "./evaluator";
import {
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  encodeRowPatch,
  encodeRowSet,
  type ScheduleClosedReason,
  type ScheduleServerMessage,
  type ScheduleTarget,
  type ScheduleWindow,
} from "./protocol";
import type { RowKey, RowPatch, RowSet } from "./rows";
import { projectPatch, projectValuePatch, sliceRows, windowKeys } from "./window";

/**
 * Open schedules, evaluated where the whole model lives (the authority, or a
 * standalone worker). Transport-agnostic: the hub and the local runner feed it
 * commits and route what it delivers.
 *
 * - One evaluation per distinct schedule, shared by everyone who has it open.
 * - It tracks its own copy of the model, advanced with exactly the committed
 *   changesets, so every patch is computed at exactly its revision.
 * - Commits are batched per tick: a burst of edits is one apply per schedule,
 *   and evaluation never runs inside the commit path.
 * - Nothing is evaluated while nobody has a schedule open.
 */

export type ScheduleDeliver = (subscriber: string, revision: number, message: ScheduleServerMessage) => void;

export interface ScheduleMetrics {
  opens: number;
  closes: number;
  refused: number;
  /** `schedule_rows` sent (opens, window moves, definition resets). */
  rowsSent: number;
  patchesSent: number;
  /** Changeset batches evaluated, and how many schedules each batch touched. */
  applies: number;
  resets: number;
  /** Model reloads after a revision gap (should stay 0). */
  reloads: number;
  failures: number;
  /** Open subscriptions and distinct evaluations right now. */
  open: number;
  evaluations: number;
  /** Recent build (open) and apply (per batch, per schedule) times, ms; capped. */
  readonly buildMs: number[];
  readonly applyMs: number[];
  /** Advancing the schedules' copy of the model by each batch, ms; capped. */
  readonly advanceMs: number[];
  /** A whole batch: advance, every schedule's apply and every subscriber's patch, ms; capped. */
  readonly flushMs: number[];
}

const SAMPLE_CAP = 2000;
function sample(list: number[], value: number): void {
  list.push(value);
  if (list.length > SAMPLE_CAP) list.splice(0, list.length - SAMPLE_CAP);
}

interface Subscription {
  readonly subscriber: string;
  readonly subscriptionId: string;
  window: ScheduleWindow;
  /** Row keys of the window the subscriber holds, and the same as a set. */
  keys: RowKey[];
  keySet: Set<RowKey>;
  /** Whole-schedule row count the subscriber last heard. */
  total: number;
  /** The revision of the rows the subscriber holds (patches outside its window are never sent, so it can lag). */
  revision: number;
}

interface Evaluation {
  readonly key: string;
  readonly instance: ScheduleInstance;
  readonly subs: Map<string, Subscription>;
  /** The whole schedule, materialized at most once per revision (the engine builds it on demand). */
  rows: RowSet | null;
}

function rowsOf(evaluation: Evaluation): RowSet {
  evaluation.rows ??= evaluation.instance.rows();
  return evaluation.rows;
}

/** Rows were added, removed or moved (the engine sends the order then), or groups changed. */
function structural(patch: RowPatch): boolean {
  return patch.order !== undefined || patch.removes.length > 0 || patch.groups !== undefined;
}

export const SCHEDULE_FAILED =
  "This schedule stopped updating because the model server hit an error evaluating it. Close it and open it again; if it keeps happening, report it with the schedule's name.";
export const TOO_MANY_SCHEDULES = `You already have ${MAX_SUBSCRIPTIONS_PER_CONNECTION} schedules open in this tab. Close one to open another.`;

export interface ScheduleSubscriptionsOptions {
  /** The current model, read when the first schedule opens (and after a gap). */
  readonly loadHead: () => Promise<ModelState>;
  /** Defers evaluation past the commit path. Default: setImmediate (or a resolved promise where it is missing). */
  readonly defer?: (run: () => void) => void;
}

const defaultDefer = (run: () => void): void => {
  if (typeof setImmediate === "function") setImmediate(run);
  else void Promise.resolve().then(run);
};

export class ScheduleSubscriptions {
  readonly metrics: ScheduleMetrics = {
    opens: 0,
    closes: 0,
    refused: 0,
    rowsSent: 0,
    patchesSent: 0,
    applies: 0,
    resets: 0,
    reloads: 0,
    failures: 0,
    open: 0,
    evaluations: 0,
    buildMs: [],
    applyMs: [],
    advanceMs: [],
    flushMs: [],
  };
  private readonly evaluations = new Map<string, Evaluation>();
  /** subscriber → subscriptionId → evaluation key. */
  private readonly bySubscriber = new Map<string, Map<string, string>>();
  private model: ModelState | null = null;
  private loading: Promise<ModelState> | null = null;
  /** Commits that arrived while the model was loading. */
  private early: Changeset[] = [];
  private pending: Changeset[] = [];
  private flushQueued = false;
  /** A window asked for while its open was still waiting for the model. */
  private readonly earlyWindows = new Map<string, ScheduleWindow>();
  /** Bumped on every open/close so an open that awaited the model can tell it was overtaken. */
  private generation = 0;
  private readonly defer: (run: () => void) => void;

  constructor(
    private readonly evaluator: ScheduleEvaluator,
    private readonly deliver: ScheduleDeliver,
    private readonly options: ScheduleSubscriptionsOptions,
  ) {
    this.defer = options.defer ?? defaultDefer;
  }

  /** Any subscription open, anywhere. */
  active(): boolean {
    return this.metrics.open > 0;
  }

  /** A commit decided (call synchronously from the sequencer's commit listener). */
  onCommit(cs: Changeset): void {
    if (this.loading) {
      this.early.push(cs);
      return;
    }
    if (!this.model) return;
    this.pending.push(cs);
    if (!this.flushQueued) {
      this.flushQueued = true;
      this.defer(() => this.flush());
    }
  }

  async open(subscriber: string, subscriptionId: string, target: ScheduleTarget, window: ScheduleWindow): Promise<void> {
    const mine = this.bySubscriber.get(subscriber);
    if (mine?.has(subscriptionId)) this.close(subscriber, subscriptionId, false);
    if ((mine?.size ?? 0) >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      this.metrics.refused += 1;
      this.deliver(subscriber, -1, { type: "schedule_closed", subscriptionId, reason: "closed", message: TOO_MANY_SCHEDULES });
      return;
    }
    // Reserve the slot now, so a close that arrives while the model loads cancels this open.
    const reserved = this.reserve(subscriber, subscriptionId, "");
    const model = await this.ensureModel();
    if (this.bySubscriber.get(subscriber)?.get(subscriptionId) !== reserved) return;
    // Apply anything decided while we waited, so the new evaluation starts at the same revision as the others.
    this.flush();
    const key = scheduleTargetKey(target);
    let evaluation = this.evaluations.get(key);
    if (!evaluation) {
      const started = performance.now();
      let opened;
      try {
        opened = this.evaluator.open(this.model ?? model, target);
      } catch (err) {
        console.error("[bim-sync] schedule evaluation failed to open", { key, err });
        this.metrics.failures += 1;
        opened = { ok: false as const, reason: "closed" as const, message: SCHEDULE_FAILED };
      }
      sample(this.metrics.buildMs, performance.now() - started);
      if (!opened.ok) {
        this.unreserve(subscriber, subscriptionId);
        this.metrics.refused += 1;
        this.deliver(subscriber, -1, { type: "schedule_closed", subscriptionId, reason: opened.reason, message: opened.message });
        return;
      }
      evaluation = { key, instance: opened.instance, subs: new Map(), rows: null };
      this.evaluations.set(key, evaluation);
      this.metrics.evaluations = this.evaluations.size;
    }
    this.bySubscriber.get(subscriber)?.set(subscriptionId, key);
    const sk = subKey(subscriber, subscriptionId);
    const sub: Subscription = { subscriber, subscriptionId, window: this.earlyWindows.get(sk) ?? window, keys: [], keySet: new Set(), total: 0, revision: -1 };
    this.earlyWindows.delete(sk);
    evaluation.subs.set(sk, sub);
    this.metrics.opens += 1;
    this.metrics.open += 1;
    this.sendRows(evaluation, sub);
  }

  setWindow(subscriber: string, subscriptionId: string, window: ScheduleWindow): void {
    const found = this.find(subscriber, subscriptionId);
    if (!found) {
      if (this.bySubscriber.get(subscriber)?.has(subscriptionId)) this.earlyWindows.set(subKey(subscriber, subscriptionId), window);
      return;
    }
    found.sub.window = window;
    this.sendRows(found.evaluation, found.sub);
  }

  /** The subscriber closed it (`notify`: tell them it is closed). */
  close(subscriber: string, subscriptionId: string, notify = false): void {
    const key = this.bySubscriber.get(subscriber)?.get(subscriptionId);
    if (key === undefined) return;
    this.unreserve(subscriber, subscriptionId);
    const evaluation = this.evaluations.get(key);
    if (!evaluation || !evaluation.subs.delete(subKey(subscriber, subscriptionId))) return;
    this.metrics.closes += 1;
    this.metrics.open -= 1;
    if (evaluation.subs.size === 0) this.evaluations.delete(key);
    this.metrics.evaluations = this.evaluations.size;
    if (notify) this.deliver(subscriber, -1, { type: "schedule_closed", subscriptionId, reason: "closed", message: "Schedule closed" });
    this.releaseModelIfIdle();
  }

  /** Close everything a subscriber has open and say why (access removed: `denied`). */
  closeAll(subscriber: string, reason: ScheduleClosedReason, message: string): void {
    for (const subscriptionId of [...(this.bySubscriber.get(subscriber)?.keys() ?? [])]) {
      const opened = this.find(subscriber, subscriptionId) !== null;
      this.close(subscriber, subscriptionId, false);
      if (opened) this.deliver(subscriber, -1, { type: "schedule_closed", subscriptionId, reason, message });
    }
    this.bySubscriber.delete(subscriber);
  }

  /** The subscriber went away: drop its subscriptions silently. */
  drop(subscriber: string): void {
    for (const subscriptionId of [...(this.bySubscriber.get(subscriber)?.keys() ?? [])]) this.close(subscriber, subscriptionId, false);
    this.bySubscriber.delete(subscriber);
  }

  /** Evaluate every commit received so far, now (tests and the local runner; normally deferred). */
  flush(): void {
    this.flushQueued = false;
    if (!this.model || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    let model = this.model;
    const applied: Changeset[] = [];
    const advanceStarted = performance.now();
    for (const cs of batch) {
      if (cs.revision <= model.revision) continue;
      if (cs.revision !== model.revision + 1) {
        console.error("[bim-sync] schedule model missed a revision; reloading every open schedule", { have: model.revision, got: cs.revision });
        this.reload();
        return;
      }
      model = applyChangeset(model, cs);
      applied.push(cs);
    }
    this.model = model;
    sample(this.metrics.advanceMs, performance.now() - advanceStarted);
    if (applied.length === 0) return;
    this.metrics.applies += 1;
    for (const evaluation of [...this.evaluations.values()]) this.applyTo(evaluation, model, applied);
    sample(this.metrics.flushMs, performance.now() - advanceStarted);
  }

  private applyTo(evaluation: Evaluation, model: ModelState, applied: readonly Changeset[]): void {
    const started = performance.now();
    let result;
    try {
      result = evaluation.instance.apply(model, applied);
    } catch (err) {
      console.error("[bim-sync] schedule evaluation failed on a commit; closing it for its subscribers", { key: evaluation.key, revision: model.revision, err });
      this.metrics.failures += 1;
      result = { kind: "closed" as const, reason: "closed" as const, message: SCHEDULE_FAILED };
    }
    sample(this.metrics.applyMs, performance.now() - started);
    if (result.kind !== "unchanged") evaluation.rows = null;
    switch (result.kind) {
      case "unchanged":
        return;
      case "reset":
        this.metrics.resets += 1;
        for (const sub of evaluation.subs.values()) this.sendRows(evaluation, sub);
        return;
      case "closed":
        for (const sub of [...evaluation.subs.values()]) {
          this.close(sub.subscriber, sub.subscriptionId, false);
          this.deliver(sub.subscriber, model.revision, { type: "schedule_closed", subscriptionId: sub.subscriptionId, reason: result.reason, message: result.message });
        }
        return;
      case "patch": {
        // A value-only patch keeps every window's rows: no need to materialize the whole schedule.
        const rows = structural(result.patch) ? rowsOf(evaluation) : null;
        for (const sub of evaluation.subs.values()) {
          const projected = rows ? projectPatch(rows, result.patch, sub.keys, sub.window, sub.total) : projectValuePatch(result.patch, sub.keys, sub.keySet);
          if (projected.keys !== sub.keys) {
            sub.keys = projected.keys;
            sub.keySet = new Set(projected.keys);
          }
          if (projected.total !== undefined) sub.total = projected.total;
          if (!projected.patch) continue;
          this.metrics.patchesSent += 1;
          // Made against the rows this subscriber holds, which may be older than the evaluation's last revision.
          const patch = { ...projected.patch, fromRevision: sub.revision };
          sub.revision = patch.toRevision;
          this.deliver(sub.subscriber, result.patch.toRevision, {
            type: "schedule_patch",
            subscriptionId: sub.subscriptionId,
            patch: encodeRowPatch(patch),
            ...(projected.total !== undefined ? { total: projected.total } : {}),
          });
        }
        return;
      }
    }
  }

  private sendRows(evaluation: Evaluation, sub: Subscription): void {
    const rows = rowsOf(evaluation);
    sub.keys = windowKeys(rows, sub.window);
    sub.keySet = new Set(sub.keys);
    sub.total = rows.rowCount;
    sub.revision = rows.revision;
    this.metrics.rowsSent += 1;
    this.deliver(sub.subscriber, rows.revision, {
      type: "schedule_rows",
      subscriptionId: sub.subscriptionId,
      window: sub.window,
      total: rows.rowCount,
      rows: encodeRowSet(sliceRows(rows, sub.window)),
    });
  }

  private ensureModel(): Promise<ModelState> {
    if (this.model) return Promise.resolve(this.model);
    if (this.loading) return this.loading;
    const loading = this.options.loadHead().then(
      (head) => {
        let model = head;
        for (const cs of this.early) if (cs.revision === model.revision + 1) model = applyChangeset(model, cs);
        this.early = [];
        this.model = model;
        this.loading = null;
        return model;
      },
      (err: unknown) => {
        this.early = [];
        this.loading = null;
        throw err;
      },
    );
    this.loading = loading;
    return loading;
  }

  /** A gap: reload the model and re-open every schedule from it. */
  private reload(): void {
    this.metrics.reloads += 1;
    this.model = null;
    this.pending = [];
    const open = [...this.evaluations.values()].flatMap((e) => [...e.subs.values()].map((s) => ({ ...s, key: e.key })));
    this.ensureModel()
      .then((model) => {
        for (const e of this.evaluations.values()) {
          const target = targetOfKey(e.key);
          const reopened = target ? this.evaluator.open(model, target) : null;
          if (!reopened || !reopened.ok) {
            for (const s of [...e.subs.values()]) {
              this.close(s.subscriber, s.subscriptionId, false);
              this.deliver(s.subscriber, model.revision, { type: "schedule_closed", subscriptionId: s.subscriptionId, reason: reopened?.ok === false ? reopened.reason : "closed", message: reopened?.ok === false ? reopened.message : SCHEDULE_FAILED });
            }
            continue;
          }
          this.evaluations.set(e.key, { key: e.key, instance: reopened.instance, subs: e.subs, rows: null });
        }
        for (const s of open) {
          const e = this.evaluations.get(s.key);
          const sub = e?.subs.get(subKey(s.subscriber, s.subscriptionId));
          if (e && sub) this.sendRows(e, sub);
        }
      })
      .catch((err) => {
        console.error("[bim-sync] schedule model reload failed; closing open schedules", err);
        for (const s of open) {
          this.close(s.subscriber, s.subscriptionId, false);
          this.deliver(s.subscriber, -1, { type: "schedule_closed", subscriptionId: s.subscriptionId, reason: "closed", message: SCHEDULE_FAILED });
        }
      });
  }

  private releaseModelIfIdle(): void {
    if (this.metrics.open > 0 || this.loading || this.hasReservations()) return;
    this.model = null;
    this.pending = [];
  }

  private hasReservations(): boolean {
    for (const m of this.bySubscriber.values()) if (m.size > 0) return true;
    return false;
  }

  private reserve(subscriber: string, subscriptionId: string, key: string): string {
    let mine = this.bySubscriber.get(subscriber);
    if (!mine) {
      mine = new Map();
      this.bySubscriber.set(subscriber, mine);
    }
    this.generation += 1;
    const token = `${key}#pending${this.generation}`;
    mine.set(subscriptionId, token);
    return token;
  }

  private unreserve(subscriber: string, subscriptionId: string): void {
    this.earlyWindows.delete(subKey(subscriber, subscriptionId));
    const mine = this.bySubscriber.get(subscriber);
    mine?.delete(subscriptionId);
    if (mine && mine.size === 0) this.bySubscriber.delete(subscriber);
  }

  private find(subscriber: string, subscriptionId: string): { evaluation: Evaluation; sub: Subscription } | null {
    const key = this.bySubscriber.get(subscriber)?.get(subscriptionId);
    if (key === undefined) return null;
    const evaluation = this.evaluations.get(key);
    const sub = evaluation?.subs.get(subKey(subscriber, subscriptionId));
    return evaluation && sub ? { evaluation, sub } : null;
  }
}

function subKey(subscriber: string, subscriptionId: string): string {
  return `${subscriber}\u0000${subscriptionId}`;
}

function targetOfKey(key: string): ScheduleTarget | null {
  if (key.startsWith("view:")) return { viewId: key.slice(5) };
  if (key.startsWith("def:")) {
    try {
      const parsed: unknown = JSON.parse(key.slice(4));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { definition: Object.fromEntries(Object.entries(parsed)) };
    } catch (err) {
      console.error("[bim-sync] could not read a schedule definition back from its key", err);
    }
  }
  return null;
}
