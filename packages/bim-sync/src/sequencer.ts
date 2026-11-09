import { canonicalJson, planCommit, type Changeset, type CommandRequest, type CommitDecision, type ModelState, type ServerCommandContext, type UpgradePolicy } from "@permitzip/bim-kernel";
import { decideWithUpgrades } from "./upgrade-policy";
import { isPipelinedStore, type DecidedCommit, type PipelinedCommitStore } from "./group-commit";
import { PipelineBrokenError, StaleLeaseError, keyReusedOutcome, mergeHistory, withoutCommandDigest, type CommitOutcome, type CommitStore } from "./store";
import { commandDigest } from "./command-digest";
import { PointReadsBuilder } from "./point-reads-idle";

/**
 * What the client is told for an answered key: the same answer for the same change (a retry),
 * a plain refusal for a different change under a reused key. Answers stored before digests
 * existed (or by an older server) carry none and replay as they always did.
 */
function answerFor(request: CommandRequest, digest: string, outcome: CommitOutcome): CommitOutcome {
  if (outcome.commandDigest !== undefined && outcome.commandDigest !== digest) {
    console.error("[bim-sync] a save key was reused for a different change; refused", { key: request.idempotencyKey, actor: request.actor.id, command: request.command.type });
    return keyReusedOutcome();
  }
  return withoutCommandDigest(outcome);
}

export interface ExportSnapshot {
  readonly revision: number;
  readonly model: ModelState;
  /** Canonical JSON of the model; hash it to content-address the snapshot. */
  readonly canonical: string;
}

/** A commit others may see now (with group commit: decided, maybe not durable yet). */
type Listener = (cs: Changeset) => void;
/** Everything through `durableRevision` is durable; `committed` are the edits this write made durable. */
type DurableListener = (durableRevision: number, committed: readonly Changeset[]) => void;
/** Why edits are refused right now, or null when they are accepted. */
export type WriteGate = () => string | null;

export interface GroupCommitOptions {
  /** Off: one durable write per commit, decided inside it (the store's `transact`). Default on when the store supports it. */
  readonly enabled?: boolean;
  /** Most decisions one durable write carries. */
  readonly maxBatch?: number;
  /**
   * With no write in flight, wait this long for more decisions before writing.
   * 0 (default) writes at once, so a lone editor waits exactly one write; a
   * batch forms on its own from what arrives while the previous write is out.
   */
  readonly windowMs?: number;
}

export interface GroupCommitStats {
  batches: number;
  commits: number;
  failures: number;
  /** Decided and not yet durable, at most. */
  maxPending: number;
  /** Commands that could not decide in memory and took the serial path (should stay near 0). */
  fallbacks: number;
  /** Recent batch sizes and write times (capped). */
  readonly batchSizes: number[];
  readonly flushMs: number[];
}

const STATS_CAP = 2000;
const DEFAULT_MAX_BATCH = 64;

function capped(list: number[], value: number): void {
  list.push(value);
  if (list.length > STATS_CAP) list.splice(0, list.length - STATS_CAP);
}

interface Waiting {
  readonly commit: DecidedCommit;
  readonly resolve: (outcome: CommitOutcome) => void;
  readonly reject: (err: unknown) => void;
}

/**
 * Orders commits for one model. Holds no authority of its own: the store owns
 * the state and enforces the lease, so a stale sequencer cannot commit.
 * Decisions are serialized in-process so the head stays ordered. With a
 * pipelined store, durable writes are grouped (see group-commit.ts).
 */
export class Sequencer {
  private readonly listeners = new Set<Listener>();
  private readonly durableListeners = new Set<DurableListener>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly group: { readonly store: PipelinedCommitStore; readonly maxBatch: number; readonly windowMs: number } | null;
  private waiting: Waiting[] = [];
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Keys decided and not yet durable: a repeat waits for the same answer instead of deciding twice. */
  private readonly inflight = new Map<string, Promise<CommitOutcome>>();
  private broken: PipelineBrokenError | null = null;
  readonly groupStats: GroupCommitStats = { batches: 0, commits: 0, failures: 0, maxPending: 0, fallbacks: 0, batchSizes: [], flushMs: [] };
  /** After a save, the head's point index (which add-on contributions each check reads) is built while the queue is idle. */
  private readonly pointReads = new PointReadsBuilder(() => this.queue.then(() => this.store.head()));

  constructor(
    private readonly store: CommitStore,
    private readonly generation: number,
    options: GroupCommitOptions = {},
  ) {
    const enabled = options.enabled ?? true;
    this.group =
      enabled && isPipelinedStore(store)
        ? { store, maxBatch: Math.max(1, options.maxBatch ?? DEFAULT_MAX_BATCH), windowMs: Math.max(0, options.windowMs ?? 0) }
        : null;
  }

  static async start(store: CommitStore, options?: GroupCommitOptions): Promise<Sequencer> {
    return new Sequencer(store, await store.acquireLease(), options);
  }

  /** True when edits are shown before they are durable and written in batches. */
  groupCommit(): boolean {
    return this.group !== null;
  }

  head(): Promise<ModelState> {
    return this.store.head();
  }

  changesSince(revision: number): Promise<readonly Changeset[]> {
    return this.store.changesSince(revision);
  }

  durableRevision(fallback: number): number {
    return this.group ? this.group.store.durableRevision() : fallback;
  }

  onCommit(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDurable(listener: DurableListener): () => void {
    this.durableListeners.add(listener);
    return () => this.durableListeners.delete(listener);
  }

  /** `server`: what only the model server supplies to a server-only command (a merged part's records). */
  submit(request: CommandRequest, server: ServerCommandContext = {}): Promise<CommitOutcome> {
    const digest = commandDigest(request.command);
    return this.submitWithDigest(request, digest, server).then((outcome) => answerFor(request, digest, outcome));
  }

  private submitWithDigest(request: CommandRequest, digest: string, server: ServerCommandContext): Promise<CommitOutcome> {
    const group = this.group;
    if (!group) return this.submitSerial(request, digest, server);
    const repeat = this.inflight.get(request.idempotencyKey);
    if (repeat) return repeat;
    // A request that may repeat an earlier owner's commit asks durable storage first, outside the queue:
    // after a failover every client resends at once, and those reads must not queue behind each other.
    const prior = group.store.needsPriorCheck(request.idempotencyKey, request.baseRevision) ? group.store.priorOutcome(request.idempotencyKey) : Promise.resolve(null);
    // A command on a head older than the history kept in memory (a client with a backlog, or one that was
    // away) reads the missing changesets here too, so it still decides in memory instead of falling back
    // to one serial write per command; the queue adds whatever committed while this read was out.
    const history = group.store.needsHistory(request.baseRevision) ? group.store.changesSince(request.baseRevision) : Promise.resolve([]);
    const outcome = Promise.all([prior, history]).then(([answer, earlierChanges]) => {
      if (answer) return answer;
      // The queue holds only the decision; the durable write happens behind it, so the next edit decides at once.
      const decided = this.queue.then(() => this.decide(group.store, request, earlierChanges, digest, server));
      this.queue = decided.catch((err) => console.error("[bim-sync] decide failed", { key: request.idempotencyKey, err }));
      return decided.then((d) => d.durable);
    });
    this.inflight.set(request.idempotencyKey, outcome);
    const forget = () => {
      if (this.inflight.get(request.idempotencyKey) === outcome) this.inflight.delete(request.idempotencyKey);
    };
    outcome.then(forget, forget);
    return outcome;
  }

  /** What the pipeline holds right now (diagnosis: drills, /metrics). */
  pipelineState(): { readonly waiting: number; readonly writing: boolean; readonly broken: boolean; readonly inflight: number; readonly fallbacks: number } {
    return { waiting: this.waiting.length, writing: this.flushing !== null, broken: this.broken !== null, inflight: this.inflight.size, fallbacks: this.groupStats.fallbacks };
  }

  /** Every decision made so far is durable (or the pipeline is broken and this throws). */
  async drain(): Promise<void> {
    while (this.waiting.length > 0 || this.flushing) {
      if (!this.flushing) this.flushNext();
      await this.flushing;
    }
    if (this.broken) throw this.broken;
  }

  /** Complete model-linked state at the current durable head, captured atomically. */
  async exportSnapshot(): Promise<ExportSnapshot> {
    if (this.group) await this.queue.then(() => this.drain());
    const model = await this.store.head();
    return { revision: model.revision, model, canonical: canonicalJson(model) };
  }

  private upgradePolicy: UpgradePolicy = () => false;

  /** Which gated record upgrades may write while deciding (the hub: features every connected peer reads). */
  setUpgradePolicy(policy: UpgradePolicy): void {
    this.upgradePolicy = policy;
  }

  private writeGate: WriteGate = () => null;

  /**
   * Refuse every edit while the gate answers a reason (a branch that was merged
   * or closed). Checked inside each decision, against the same head, so an
   * edit decided after the gate closes is refused and recorded, never written.
   */
  setWriteGate(gate: WriteGate): void {
    this.writeGate = gate;
  }

  private plan(request: CommandRequest, earlier: readonly Changeset[] | null, server: ServerCommandContext) {
    return (head: ModelState, sinceBase: readonly Changeset[]): CommitDecision => {
      const refusal = this.writeGate();
      if (refusal !== null) return { ok: false, error: { code: "forbidden", message: refusal, elementIds: [] } };
      return decideWithUpgrades(request.command, this.upgradePolicy, () =>
        planCommit(head, sinceBase, request, undefined, earlier ? mergeHistory(earlier, sinceBase) : sinceBase, server),
      );
    };
  }

  /** Undo inverts a committed changeset and must see everything after it. Committed changesets never change. */
  private earlierFor(request: CommandRequest): Promise<readonly Changeset[] | null> {
    const command = request.command;
    return command.type === "undo" ? this.store.changesSince(Math.max(0, command.revision - 1)) : Promise.resolve(null);
  }

  private submitSerial(request: CommandRequest, digest: string, server: ServerCommandContext): Promise<CommitOutcome> {
    const run = this.queue.then(async () => {
      const earlier = await this.earlierFor(request);
      const result = await this.store.transact(this.generation, request.idempotencyKey, request.baseRevision, this.plan(request, earlier, server), request.actor.id, digest);
      if (result.changeset) this.publish(result.changeset, true);
      return result.outcome;
    });
    // Keep the chain alive after a failure; the caller still sees the rejection.
    this.queue = run.catch((err) => console.error("[bim-sync] submit failed", { key: request.idempotencyKey, err }));
    return run;
  }

  private publish(cs: Changeset, durable: boolean): void {
    this.pointReads.schedule();
    for (const listener of this.listeners) listener(cs);
    if (durable) for (const listener of this.durableListeners) listener(cs.revision, [cs]);
  }

  private async decide(store: PipelinedCommitStore, request: CommandRequest, history: readonly Changeset[], digest: string, server: ServerCommandContext): Promise<{ readonly durable: Promise<CommitOutcome> }> {
    if (this.broken) throw this.broken;
    const key = request.idempotencyKey;
    const earlier = await this.earlierFor(request);
    let local = store.decideLocal(this.generation, key, request.baseRevision, this.plan(request, earlier, server), request.actor.id, history, digest);
    if (local.kind === "fallback" && local.reason === "history_gap") {
      // More than the kept history committed while the read before the queue was out. Inside the queue
      // the head can't move, so one more read closes the gap and the command still decides in memory.
      local = store.decideLocal(this.generation, key, request.baseRevision, this.plan(request, earlier, server), request.actor.id, await store.changesSince(request.baseRevision), digest);
    }
    if (local.kind === "replay") return { durable: Promise.resolve(local.outcome) };
    if (local.kind === "fallback") {
      this.groupStats.fallbacks += 1;
      // Rare (no head in memory yet): everything before it becomes durable first.
      await this.drain();
      const result = await store.transact(this.generation, key, request.baseRevision, this.plan(request, earlier, server), request.actor.id, digest);
      if (result.changeset) this.publish(result.changeset, true);
      return { durable: Promise.resolve(result.outcome) };
    }
    const commit = local.commit;
    const durable = new Promise<CommitOutcome>((resolve, reject) => this.waiting.push({ commit, resolve, reject }));
    this.groupStats.maxPending = Math.max(this.groupStats.maxPending, this.waiting.length);
    if (commit.changeset) for (const listener of this.listeners) listener(commit.changeset);
    this.pointReads.schedule();
    this.schedule();
    return { durable };
  }

  private schedule(): void {
    const group = this.group;
    if (!group || this.flushing || this.waiting.length === 0) return;
    if (group.windowMs === 0 || this.waiting.length >= group.maxBatch) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.flushNext();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.flushNext();
    }, group.windowMs);
  }

  private flushNext(): void {
    const group = this.group;
    if (!group || this.flushing || this.waiting.length === 0) return;
    if (this.broken) {
      this.failAll(this.broken);
      return;
    }
    const batch = this.waiting.splice(0, group.maxBatch);
    const started = performance.now();
    this.flushing = group.store
      .flush(
        this.generation,
        batch.map((w) => w.commit),
      )
      .then(
        () => {
          this.groupStats.batches += 1;
          this.groupStats.commits += batch.length;
          capped(this.groupStats.batchSizes, batch.length);
          capped(this.groupStats.flushMs, performance.now() - started);
          const committed = batch.flatMap((w) => (w.commit.changeset ? [w.commit.changeset] : []));
          const durableRevision = group.store.durableRevision();
          for (const listener of this.durableListeners) listener(durableRevision, committed);
          for (const w of batch) w.resolve(w.commit.outcome);
        },
        (err: unknown) => {
          this.groupStats.failures += 1;
          // Others may have seen these edits: this process can't vouch for its head any more.
          this.broken = err instanceof PipelineBrokenError ? err : new PipelineBrokenError(this.generation, err);
          console.error("[bim-sync] group commit failed; the model must be handed off", { generation: this.generation, batch: batch.length, err });
          for (const w of batch) w.reject(this.broken);
          this.failAll(this.broken);
        },
      )
      .finally(() => {
        this.flushing = null;
        // What arrived during the write goes out now, as one batch.
        if (this.waiting.length > 0) {
          if (this.broken) this.failAll(this.broken);
          else this.flushNext();
        }
      });
  }

  private failAll(err: StaleLeaseError): void {
    const rest = this.waiting;
    this.waiting = [];
    for (const w of rest) w.reject(err);
  }
}
