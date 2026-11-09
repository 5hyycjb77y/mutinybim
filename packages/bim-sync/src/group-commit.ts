import type { Changeset, CommitDecision, ModelState } from "@permitzip/bim-kernel";
import { PipelineBrokenError, StaleLeaseError, withCommandDigest, type CommitOutcome, type CommitStore, type TransactResult } from "./store";

/**
 * Group commit: decide one command at a time against the in-memory head, show
 * accepted edits to other people at once, and make the decisions durable in
 * batches (one write per batch instead of one per edit). The author hears
 * "saved" only after the batch holding its edit is durable.
 *
 * Crash semantics:
 * - Durability is a prefix of the decision order. A batch is all or nothing;
 *   batches are written one after another, so after any crash the durable log
 *   is exactly the first N decided commits for some N.
 * - An edit someone else saw but that never became durable is lost with the
 *   process. Its author was never told "saved", still holds it, and sends it
 *   again with the same idempotency key to the next owner.
 * - Everyone reconnects to the next owner and gets a fresh copy at the
 *   durable head (the welcome replaces what they held), so nobody keeps an
 *   edit the database does not have. Clients re-run their own unsaved edits
 *   on top of it (SyncClient clamps their base to the welcome).
 */
export interface DecidedCommit {
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly outcome: CommitOutcome;
  /** Committed edits only; a refusal carries none and is never shown to anyone else. */
  readonly changeset?: Changeset;
  /** The head the decision ran on (writers read connection partitions from it). */
  readonly before: ModelState;
  /** The head after this commit (the before head for a refusal). */
  readonly after: ModelState;
}

export type LocalDecision =
  | { readonly kind: "decided"; readonly commit: DecidedCommit }
  /** This key already has a durable answer in this term. */
  | { readonly kind: "replay"; readonly outcome: CommitOutcome }
  /** Can't decide from memory (no head yet, or the base is older than the history kept): drain, then `transact`. */
  | { readonly kind: "fallback"; readonly reason: string };

export interface PipelinedCommitStore extends CommitStore {
  /**
   * Decide against the in-memory head, which already includes every commit
   * decided and not yet durable. No I/O. A commit advances that head at once.
   */
  decideLocal(
    generation: number,
    idempotencyKey: string,
    baseRevision: number,
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    actorId: string,
    /** Changesets after the base read from durable storage, for a base older than the history kept in memory. */
    history?: readonly Changeset[],
    /** The command's digest, kept with the answer (see `commandDigest`). */
    commandDigest?: string,
  ): LocalDecision;
  /** True when a command on this base needs changesets older than the history kept in memory. */
  needsHistory(baseRevision: number): boolean;
  /**
   * A request built before this term loaded the model may already have been
   * answered by an earlier owner; ask durable storage before deciding it.
   * (A durable commit's revision is above its base and at or below the
   * revision this term loaded, so a base at or above it cannot repeat one.)
   */
  needsPriorCheck(idempotencyKey: string, baseRevision: number): boolean;
  priorOutcome(idempotencyKey: string): Promise<CommitOutcome | null>;
  /** Write these decisions in order, behind the lease fence. All or nothing; throws when not applied. */
  flush(generation: number, commits: readonly DecidedCommit[]): Promise<void>;
  /** Highest revision known durable. */
  durableRevision(): number;
}

export function isPipelinedStore(store: CommitStore): store is PipelinedCommitStore {
  return "decideLocal" in store && "flush" in store && "durableRevision" in store;
}

/** Recently answered keys kept in memory per term (beyond this, the durable store answers). */
export const ANSWERED_KEYS_KEPT = 20_000;
/** Committed changesets kept in memory for rebasing commands sent on an older head. */
export const RECENT_KEPT = 256;

/** True when `recent` (ending at `headRevision`) does not reach back to `baseRevision + 1`. */
export function historyMissing(recent: readonly Changeset[], baseRevision: number, headRevision: number): boolean {
  if (baseRevision >= headRevision) return false;
  const oldest = recent[0]?.revision;
  return oldest === undefined || oldest > baseRevision + 1;
}

export function rememberAnswer(answered: Map<string, CommitOutcome>, key: string, outcome: CommitOutcome): void {
  answered.set(key, outcome);
  if (answered.size > ANSWERED_KEYS_KEPT) {
    const oldest = answered.keys().next();
    if (!oldest.done) answered.delete(oldest.value);
  }
}

/** The changesets after `baseRevision` from the kept history (plus any read from storage), or null when they don't reach back that far. */
export function sinceFromRecent(recent: readonly Changeset[], baseRevision: number, headRevision: number, history: readonly Changeset[] = []): readonly Changeset[] | null {
  if (baseRevision >= headRevision) return [];
  // Both lists are in revision order: take the history, then whatever the kept list has after it.
  const fromHistory = history.filter((c) => c.revision > baseRevision && c.revision <= headRevision);
  const after = fromHistory.at(-1)?.revision ?? baseRevision;
  const since = [...fromHistory, ...recent.filter((c) => c.revision > after && c.revision <= headRevision)];
  if (since[0]?.revision !== baseRevision + 1 || since.length !== headRevision - baseRevision) return null;
  return since;
}

/**
 * Stands in for Postgres in tests and the stress harness: durable state that
 * outlives any one authority process, with the lease fence and the
 * idempotency table. Writes take `writeDelayMs`, as the database round trip does.
 */
export class DurableLog {
  generation = 0;
  model: ModelState;
  readonly changesets: Changeset[] = [];
  readonly outcomes = new Map<string, CommitOutcome>();
  /** Durable writes made (one per commit serially, one per batch with group commit). */
  writes = 0;

  constructor(
    initial: ModelState,
    readonly writeDelayMs = 0,
  ) {
    this.model = initial;
  }

  wait(): Promise<void> {
    return this.writeDelayMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.writeDelayMs)) : Promise.resolve();
  }
}

/**
 * In-memory pipelined store over a DurableLog. One instance per authority
 * process; a new process (failover) is a new instance on the same log.
 */
export class GroupCommitMemoryStore implements PipelinedCommitStore {
  private generation = -1;
  private headModel: ModelState;
  private durable: number;
  private loaded: number;
  private recent: Changeset[] = [];
  private unflushed: Changeset[] = [];
  private readonly answered = new Map<string, CommitOutcome>();

  constructor(
    private readonly log: DurableLog,
    /** Measures the kernel's decision (stress harness). */
    private readonly onDecide?: (ms: number, revisionsBehind: number) => void,
  ) {
    this.headModel = log.model;
    this.durable = log.model.revision;
    this.loaded = log.model.revision;
  }

  async acquireLease(): Promise<number> {
    this.log.generation += 1;
    this.generation = this.log.generation;
    this.headModel = this.log.model;
    this.durable = this.loaded = this.headModel.revision;
    this.recent = [];
    this.unflushed = [];
    this.answered.clear();
    return this.generation;
  }

  async head(): Promise<ModelState> {
    return this.headModel;
  }

  async changesSince(revision: number): Promise<readonly Changeset[]> {
    // The log is in revision order: start at the first entry after `revision` instead of scanning it all.
    const log = this.log.changesets;
    let lo = 0;
    let hi = log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((log[mid]?.revision ?? 0) <= revision) lo = mid + 1;
      else hi = mid;
    }
    const durable = log.slice(lo);
    const last = durable.at(-1)?.revision ?? revision;
    return [...durable, ...this.unflushed.filter((cs) => cs.revision > Math.max(revision, last))];
  }

  durableRevision(): number {
    return this.durable;
  }

  needsPriorCheck(idempotencyKey: string, baseRevision: number): boolean {
    return !this.answered.has(idempotencyKey) && baseRevision < this.loaded;
  }

  needsHistory(baseRevision: number): boolean {
    return historyMissing(this.recent, baseRevision, this.headModel.revision);
  }

  async priorOutcome(idempotencyKey: string): Promise<CommitOutcome | null> {
    await this.log.wait();
    return this.log.outcomes.get(idempotencyKey) ?? null;
  }

  private fence(generation: number): void {
    if (generation !== this.generation || generation !== this.log.generation) throw new StaleLeaseError(generation, this.log.generation);
  }

  private timedDecide(decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision, head: ModelState, since: readonly Changeset[]): CommitDecision {
    const t0 = performance.now();
    const decision = decide(head, since);
    this.onDecide?.(performance.now() - t0, since.length);
    return decision;
  }

  /** The serial path: one durable write per commit (also the fallback after a drain). */
  async transact(
    generation: number,
    idempotencyKey: string,
    baseRevision: number,
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    _actorId?: string,
    commandDigest?: string,
  ): Promise<TransactResult> {
    await this.log.wait();
    this.fence(generation);
    const prior = this.log.outcomes.get(idempotencyKey);
    if (prior) return { outcome: prior, replayed: true };
    const decision = this.timedDecide(
      decide,
      this.log.model,
      this.log.changesets.filter((cs) => cs.revision > baseRevision),
    );
    this.log.writes += 1;
    if (!decision.ok) {
      const outcome = withCommandDigest({ status: "rejected", error: decision.error, conflict: decision.conflict }, commandDigest);
      this.log.outcomes.set(idempotencyKey, outcome);
      rememberAnswer(this.answered, idempotencyKey, outcome);
      return { outcome, replayed: false };
    }
    const cs = decision.changeset;
    const outcome = withCommandDigest({ status: "committed", revision: cs.revision, rebased: cs.rebased }, commandDigest);
    this.log.model = decision.model;
    this.log.changesets.push(cs);
    this.log.outcomes.set(idempotencyKey, outcome);
    this.headModel = decision.model;
    this.durable = cs.revision;
    this.recent.push(cs);
    if (this.recent.length > RECENT_KEPT) this.recent.splice(0, this.recent.length - RECENT_KEPT);
    rememberAnswer(this.answered, idempotencyKey, outcome);
    return { outcome, changeset: cs, replayed: false };
  }

  decideLocal(
    generation: number,
    idempotencyKey: string,
    baseRevision: number,
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    actorId: string,
    history: readonly Changeset[] = [],
    commandDigest?: string,
  ): LocalDecision {
    if (generation !== this.generation) throw new StaleLeaseError(generation, this.generation);
    const prior = this.answered.get(idempotencyKey);
    if (prior) return { kind: "replay", outcome: prior };
    const head = this.headModel;
    const since = sinceFromRecent(this.recent, baseRevision, head.revision, history);
    if (!since) return { kind: "fallback", reason: "history_gap" };
    const decision = this.timedDecide(decide, head, since);
    if (!decision.ok) {
      const outcome = withCommandDigest({ status: "rejected", error: decision.error, conflict: decision.conflict }, commandDigest);
      return { kind: "decided", commit: { idempotencyKey, actorId, outcome, before: head, after: head } };
    }
    const cs = decision.changeset;
    this.headModel = decision.model;
    this.recent.push(cs);
    if (this.recent.length > RECENT_KEPT) this.recent.splice(0, this.recent.length - RECENT_KEPT);
    this.unflushed.push(cs);
    const outcome = withCommandDigest({ status: "committed", revision: cs.revision, rebased: cs.rebased }, commandDigest);
    return { kind: "decided", commit: { idempotencyKey, actorId, outcome, changeset: cs, before: head, after: decision.model } };
  }

  async flush(generation: number, commits: readonly DecidedCommit[]): Promise<void> {
    await this.log.wait();
    try {
      this.fence(generation);
    } catch (err) {
      throw new PipelineBrokenError(generation, err);
    }
    if (this.log.model.revision !== this.durable || commits.some((c) => this.log.outcomes.has(c.idempotencyKey))) {
      throw new PipelineBrokenError(generation, new Error("durable state moved under the batch"));
    }
    this.log.writes += 1;
    let committed = 0;
    for (const c of commits) {
      this.log.outcomes.set(c.idempotencyKey, c.outcome);
      rememberAnswer(this.answered, c.idempotencyKey, c.outcome);
      if (!c.changeset) continue;
      this.log.changesets.push(c.changeset);
      this.log.model = c.after;
      this.durable = c.changeset.revision;
      committed += 1;
    }
    this.unflushed.splice(0, committed);
  }
}
