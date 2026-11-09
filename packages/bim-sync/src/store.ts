import type { Changeset, CommitDecision, ConflictDetail, CommandError, ModelState } from "@permitzip/bim-kernel";

export type CommitOutcome = (
  | { readonly status: "committed"; readonly revision: number; readonly rebased: boolean }
  | { readonly status: "rejected"; readonly error: CommandError; readonly conflict?: ConflictDetail }
) & {
  /** Server-side only: the digest of the command that earned this answer (`commandDigest`). Never sent to a client. */
  readonly commandDigest?: string;
};

/** The answer as stored: with the command's digest, when the sequencer gave one. */
export function withCommandDigest(outcome: CommitOutcome, digest: string | undefined): CommitOutcome {
  return digest ? { ...outcome, commandDigest: digest } : outcome;
}

/** The answer as a client sees it. */
export function withoutCommandDigest(outcome: CommitOutcome): CommitOutcome {
  if (outcome.commandDigest === undefined) return outcome;
  const { commandDigest: _digest, ...rest } = outcome;
  return rest;
}

/** A reused save key with a different change: nothing is saved, and the client is told so. */
export const KEY_REUSED_MESSAGE = "This save key was already used for a different change; nothing was saved.";
export function keyReusedOutcome(): CommitOutcome {
  return { status: "rejected", error: { code: "conflict", message: KEY_REUSED_MESSAGE, elementIds: [] } };
}

/** Two overlapping slices of the log as one ordered list. */
export function mergeHistory(a: readonly Changeset[], b: readonly Changeset[]): Changeset[] {
  const byRevision = new Map<number, Changeset>();
  for (const cs of [...a, ...b]) byRevision.set(cs.revision, cs);
  return [...byRevision.values()].sort((x, y) => x.revision - y.revision);
}

export class StaleLeaseError extends Error {
  constructor(readonly attempted: number, readonly current: number) {
    super(`Lease generation ${attempted} is stale (current ${current}); this sequencer must stop`);
    this.name = "StaleLeaseError";
  }
}

/**
 * The commit pipeline can no longer vouch for its in-memory head: a group write
 * failed after its edits were shown to other people. The process must stop
 * serving the model (exactly as when its lease is lost); the next owner loads
 * the durable state and every client resyncs from it.
 */
export class PipelineBrokenError extends StaleLeaseError {
  constructor(
    attempted: number,
    readonly reason: unknown,
  ) {
    super(attempted, -1);
    this.name = "PipelineBrokenError";
    this.message = `Group commit for lease generation ${attempted} could not be made durable; this sequencer must stop`;
  }
}

export interface TransactResult {
  readonly outcome: CommitOutcome;
  /** Present only when this call committed a new changeset (not an idempotent replay). */
  readonly changeset?: Changeset;
  readonly replayed: boolean;
}

/**
 * The single owner of authored model state. Every candidate implements this
 * contract; the decision function runs inside the store's atomic unit:
 * - in-memory baseline: one synchronous critical section;
 * - Postgres (candidates A and B): one transaction with the model row locked;
 * - SpacetimeDB (candidate C): one reducer call (implemented in the module).
 *
 * Inside that unit the store must: reject a stale lease generation (R1), return
 * the first outcome for a repeated idempotency key (R5), and run `decide`
 * against the current head so validation and commit see the same state
 * (R2, R3). Rejections are recorded too, so a retry gets the same answer.
 */
export interface CommitStore {
  acquireLease(): Promise<number>;
  head(): Promise<ModelState>;
  changesSince(revision: number): Promise<readonly Changeset[]>;
  transact(
    generation: number,
    idempotencyKey: string,
    baseRevision: number,
    /** Runs inside the atomic unit with the head and every changeset after `baseRevision`. */
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    /** Who sent the command; recorded with refusals too, so a refused edit can be traced to a person. */
    actorId?: string,
    /** The command's digest, stored with the answer so a reused key with a different change can be told apart. */
    commandDigest?: string,
  ): Promise<TransactResult>;
}

/**
 * Development baseline. Not a persistent candidate on its own: state is lost on
 * restart unless the host saves `head()` and `changesSince(0)` and passes them
 * back here (the single-machine hosted app does).
 */
export class InMemoryCommitStore implements CommitStore {
  private generation = 0;
  private model: ModelState;
  private readonly log: Changeset[];
  private readonly outcomes = new Map<string, CommitOutcome>();

  /** `history`: the changesets that led to `initial`, oldest first (kept so undo, branches and versions still read them). */
  constructor(initial: ModelState, history: readonly Changeset[] = []) {
    this.model = initial;
    this.log = [...history].sort((a, b) => a.revision - b.revision);
    for (const cs of this.log) if (cs.revision > initial.revision) throw new Error(`[bim-sync] history revision ${cs.revision} is after the head ${initial.revision}`);
    for (const cs of this.log) this.outcomes.set(cs.idempotencyKey, { status: "committed", revision: cs.revision, rebased: cs.rebased });
  }

  async acquireLease(): Promise<number> {
    this.generation += 1;
    return this.generation;
  }

  async head(): Promise<ModelState> {
    return this.model;
  }

  async changesSince(revision: number): Promise<readonly Changeset[]> {
    return this.log.filter((cs) => cs.revision > revision);
  }

  async transact(
    generation: number,
    idempotencyKey: string,
    baseRevision: number,
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    _actorId?: string,
    commandDigest?: string,
  ): Promise<TransactResult> {
    if (generation !== this.generation) throw new StaleLeaseError(generation, this.generation);
    const prior = this.outcomes.get(idempotencyKey);
    if (prior) return { outcome: prior, replayed: true };

    const decision = decide(this.model, this.log.filter((cs) => cs.revision > baseRevision));
    if (!decision.ok) {
      const outcome = withCommandDigest({ status: "rejected", error: decision.error, conflict: decision.conflict }, commandDigest);
      this.outcomes.set(idempotencyKey, outcome);
      return { outcome, replayed: false };
    }
    this.model = decision.model;
    this.log.push(decision.changeset);
    const outcome = withCommandDigest({ status: "committed", revision: decision.changeset.revision, rebased: decision.changeset.rebased }, commandDigest);
    this.outcomes.set(idempotencyKey, outcome);
    return { outcome, changeset: decision.changeset, replayed: false };
  }
}
