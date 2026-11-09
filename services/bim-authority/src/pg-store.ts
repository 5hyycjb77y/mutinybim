import postgres from "postgres";
import {
  applyChangeset,
  branchAcceptsEdits,
  branchClosedMessage,
  elementCount,
  elementsFromRows,
  offerValidationState,
  partitionOf,
  asConnectionId,
  asElementId,
  asRevision,
  readBranchState,
  readModelSettings,
  validationStateOf,
  buildPointReads,
  VALIDATION_STATE_VERSION,
  type BimElement,
  type BranchState,
  type Changeset,
  type CommitDecision,
  type Connection,
  type ConnectorEnd,
  type ModelState,
} from "@permitzip/bim-kernel";
import {
  PipelineBrokenError,
  RECENT_KEPT,
  StaleLeaseError,
  mergeHistory,
  historyMissing,
  rememberAnswer,
  sinceFromRecent,
  withCommandDigest,
  type CommitOutcome,
  type DecidedCommit,
  type LocalDecision,
  type PipelinedCommitStore,
  type TransactResult,
  changesetPatch,
  type ChangesetPatch,
} from "@permitzip/bim-sync";
import { collectPages } from "./paged-load";
import { loadBranchHead, type BaseSource } from "./pg-branches";

export type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/**
 * Server-side limits ride on the connection's startup parameters, so they cost
 * no extra round trip: a stuck statement or a transaction left open under the
 * model row lock fails loudly instead of queuing every other writer.
 */
export function connect(dbUrl: string, max = 8): Sql {
  // Supabase's transaction pooler (port 6543) shares server connections, so named prepared statements break there.
  const transactionPooler = new URL(dbUrl).port === "6543";
  return postgres(dbUrl, {
    max,
    idle_timeout: 20,
    prepare: !transactionPooler,
    onnotice: () => undefined,
    connection: {
      statement_timeout: 5000,
      lock_timeout: 5000,
      idle_in_transaction_session_timeout: 10000,
    },
  });
}

/** Someone else holds an unexpired lease on the model; connect to them instead. */
export class LeaseHeldError extends Error {
  constructor(
    readonly modelId: string,
    readonly holderMachine: string | null,
    readonly expiresAt: Date | null,
  ) {
    super(`Model ${modelId} is owned by machine ${holderMachine ?? "unknown"} until ${expiresAt?.toISOString() ?? "unknown"}`);
    this.name = "LeaseHeldError";
  }
}

export interface LeaseTerm {
  readonly owner: string;
  readonly generation: number;
  readonly expiresAt: Date;
}

interface ModelRow {
  revision: string;
  lease_generation: string;
  /** Read through readModelSettings: older first-opened models hold it as a JSON string. */
  settings: unknown;
  /** models.created_at as text. A reset recreates the row, so a new epoch means "not the model you cached". */
  epoch: string;
}

export interface CachedHead {
  readonly model: ModelState;
  readonly epoch: string;
}

interface ConnectionRow {
  connection_id: string;
  a_element: string;
  a_end: string;
  b_element: string;
  b_end: string;
}

const CONNECTOR_ENDS: readonly ConnectorEnd[] = ["start", "end", "in", "out", "host", "branch"];

function connectorEnd(value: string): ConnectorEnd {
  const end = CONNECTOR_ENDS.find((e) => e === value);
  if (!end) throw new Error(`bim.connections holds an unknown connector end "${value}"`);
  return end;
}

function toConnection(r: ConnectionRow): Connection {
  return {
    id: asConnectionId(r.connection_id),
    a: { elementId: asElementId(r.a_element), end: connectorEnd(r.a_end) },
    b: { elementId: asElementId(r.b_element), end: connectorEnd(r.b_end) },
  };
}

export interface LoadTimings {
  readonly modelRowMs: number;
  readonly elementsMs: number;
  readonly connectionsMs: number;
  readonly buildMs: number;
  readonly elements: number;
  /** Element pages read (paged boot). */
  readonly pages: number;
}

/** Elements per boot page: bounded statements, a few round trips for a large building. */
export const BOOT_PAGE_SIZE = 2000;

/** One page of the head's elements after `after`, in key order (the database's collation). */
function elementPage(sql: Sql | Tx, modelId: string, after: string | null, limit: number) {
  return after === null
    ? sql<{ element_id: string; body: BimElement }[]>`
        select element_id, body from bim.elements where model_id = ${modelId} order by element_id limit ${limit}`
    : sql<{ element_id: string; body: BimElement }[]>`
        select element_id, body from bim.elements where model_id = ${modelId} and element_id > ${after} order by element_id limit ${limit}`;
}

export async function loadHeadTimed(sql: Sql | Tx, modelId: string, pageSize = BOOT_PAGE_SIZE): Promise<{ head: CachedHead; timings: LoadTimings }> {
  const t0 = performance.now();
  const [m] = await sql<ModelRow[]>`
    select revision, lease_generation, settings, created_at::text as epoch from bim.models where id = ${modelId}`;
  if (!m) throw new Error(`Model ${modelId} not found`);
  const t1 = performance.now();
  const { rows: elements, pages } = await collectPages((after, limit) => elementPage(sql, modelId, after, limit), (r) => r.element_id, pageSize);
  const t2 = performance.now();
  const connections = await sql<ConnectionRow[]>`
    select connection_id, a_element, a_end, b_element, b_end from bim.connections where model_id = ${modelId} order by ordinal`;
  const t3 = performance.now();
  const head: CachedHead = {
    epoch: m.epoch,
    model: {
      modelId,
      revision: asRevision(Number(m.revision)),
      // Indexed (and kinds shared) as the rows are read, so the first join doesn't index a plain copy again.
      elements: elementsFromRows(elements.map((r) => r.body)),
      connections: connections.map(toConnection),
      settings: readModelSettings(m.settings),
    },
  };
  return { head, timings: { modelRowMs: t1 - t0, elementsMs: t2 - t1, connectionsMs: t3 - t2, buildMs: performance.now() - t3, elements: elements.length, pages } };
}

export interface PgStoreOptions {
  readonly modelId: string;
  /** This process (config.owner): unique per start. */
  readonly owner: string;
  readonly ownerMachine: string | null;
  readonly leaseTtlMs: number;
  /**
   * Drills only: when this answers false, skip the in-process lease comparison so
   * the database's own write guard is the only thing between a stale authority and the model.
   */
  readonly processLeaseChecks?: () => boolean;
  /** Elements per boot page (default BOOT_PAGE_SIZE). */
  readonly bootPageSize?: number;
  /** Durable revisions between checkpoints (default CHECKPOINT_EVERY). */
  readonly checkpointEvery?: number;
  /** Larger models are not checkpointed yet (default CHECKPOINT_MAX_ELEMENTS); logged, never silent. */
  readonly checkpointMaxElements?: number;
  /**
   * This model is a branch (round 8b): its head is its base's state at
   * `baseRevision` plus its own changesets, it is never checkpointed, and
   * every write is refused once it is merged or closed.
   */
  readonly branch?: { readonly baseRevision: number; readonly base: BaseSource };
  /** The branch's state as the database answered it on a refused write (another machine closed it). */
  readonly onBranchState?: (state: BranchState) => void;
  /**
   * This build's checks (round 9 K9: the image ref). With it, the model's
   * validation state is kept in bim.validation_states and adopted on open
   * when it is for this build, revision and add-on set; without it, every open
   * runs the cold pass, as before.
   */
  readonly validationCodeKey?: string | null;
  /** Quiet time after the last durable commit before the validation state is written (default VALIDATION_STATE_IDLE_MS). */
  readonly validationStateIdleMs?: number;
}

/** A served model's validation state is written once commits have been quiet this long, off the commit path. */
export const VALIDATION_STATE_IDLE_MS = 20_000;

export const CHECKPOINT_EVERY = 1000;
export const CHECKPOINT_MAX_ELEMENTS = 50_000;

/** What this database supports, read once per lease term (a new authority may meet a database a migration has not reached). */
export interface StorageFeatures {
  readonly changesetPatch: boolean;
  readonly checkpoints: boolean;
  /** bim.models carries branch columns (20261101040000): writes check the branch still takes edits. */
  readonly branches: boolean;
  /** bim.validation_states exists (20261101050600): a model's validation state is kept and adopted on open. */
  readonly validationStates: boolean;
}

const NO_STORAGE_FEATURES: StorageFeatures = { changesetPatch: false, checkpoints: false, branches: false, validationStates: false };

/**
 * Postgres-owned model state for one model, written only by the process
 * holding its lease. The head lives in memory between commits; every write is
 * guarded in SQL by revision, epoch, and the lease (owner + generation +
 * unexpired by the database clock), so a stale or paused process writes nothing.
 */
// The epoch (created_at) is compared as text: the driver turns a timestamptz
// parameter into a JS Date, which drops the microseconds, and nothing matches.
export class PostgresCommitStore implements PipelinedCommitStore {
  private cache: CachedHead | null = null;
  private headLoading: Promise<CachedHead> | null = null;
  private recent: Changeset[] = [];
  private term: LeaseTerm | null = null;
  /** Highest revision known written; the cached head may be ahead of it by `unflushed`. */
  private durable = -1;
  /** The revision this term read from the database (requests based below it may repeat an earlier owner's). */
  private loaded = -1;
  /** Decided, shown, not yet written, oldest first (group commit). */
  private unflushed: Changeset[] = [];
  /** Keys this term answered durably. */
  private readonly answered = new Map<string, CommitOutcome>();
  lastHeadLoad: (LoadTimings & { readonly at: string; readonly totalMs: number }) | null = null;
  /** Which path each commit took, and why a fast path gave up (exposed on /metrics). */
  readonly pathStats: Record<string, number> = {};
  private storage: StorageFeatures = NO_STORAGE_FEATURES;
  /** Newest checkpoint revision this term knows of (-1: none). */
  private lastCheckpoint = -1;
  private checkpointing: Promise<void> | null = null;
  private checkpointTooLargeLogged = false;
  /** JSON characters (bytes, for our ASCII ids) written to bim.changesets: full bodies and patches, summed over commits (exposed on /metrics). */
  readonly writeBytes = { commits: 0, body: 0, patch: 0 };

  constructor(
    private readonly sql: Sql,
    private readonly opts: PgStoreOptions,
  ) {}

  private count(key: string): void {
    this.pathStats[key] = (this.pathStats[key] ?? 0) + 1;
  }

  leaseTerm(): LeaseTerm | null {
    return this.term;
  }

  /** Take the lease (a new term, so a new generation) or throw LeaseHeldError naming the holder. */
  async acquireLease(): Promise<number> {
    const [row] = await this.sql<{ acquired: boolean; generation: string; holder: string | null; holder_machine: string | null; expires_at: Date | null }[]>`
      select acquired, generation, holder, holder_machine, expires_at
        from bim.acquire_model_lease(${this.opts.modelId}, ${this.opts.owner}, ${this.opts.ownerMachine}, ${this.opts.leaseTtlMs})`;
    if (!row) throw new Error(`Model ${this.opts.modelId} not found`);
    if (!row.acquired || !row.expires_at) throw new LeaseHeldError(this.opts.modelId, row.holder_machine, row.expires_at);
    this.term = { owner: this.opts.owner, generation: Number(row.generation), expiresAt: row.expires_at };
    this.forget();
    await this.readStorageFeatures();
    return this.term.generation;
  }

  storageFeatures(): StorageFeatures {
    return this.storage;
  }

  private async readStorageFeatures(): Promise<void> {
    const [row] = await this.sql<{ patch: boolean; checkpoints: boolean; purge: boolean; branches: boolean; validation_states: boolean }[]>`
      select exists (select 1 from information_schema.columns
                      where table_schema = 'bim' and table_name = 'changesets' and column_name = 'patch') as patch,
             to_regclass('bim.checkpoints') is not null as checkpoints,
             to_regprocedure('bim.purge_changesets(text,bigint,interval,integer)') is not null as purge,
             exists (select 1 from information_schema.columns
                      where table_schema = 'bim' and table_name = 'models' and column_name = 'branch_state') as branches,
             to_regclass('bim.validation_states') is not null as validation_states`;
    this.storage = {
      changesetPatch: row?.patch === true,
      checkpoints: row?.checkpoints === true && row.purge === true,
      branches: row?.branches === true,
      validationStates: row?.validation_states === true,
    };
    if (this.opts.branch && !this.storage.branches) throw new Error(`Model ${this.opts.modelId} is a branch, but this database has no branch columns (run db/migrations 20261101040000)`);
    if (this.storage.checkpoints) {
      const [cp] = await this.sql<{ revision: string | null }[]>`
        select max(revision)::text as revision from bim.checkpoints where model_id = ${this.opts.modelId}`;
      this.lastCheckpoint = cp?.revision ? Number(cp.revision) : -1;
    }
  }

  /** The patch column value for a changeset decided on `before` (null when this database has no patch column). */
  private patchFor(cs: Changeset, before: ModelState): ChangesetPatch | null {
    if (!this.storage.changesetPatch) return null;
    return changesetPatch(cs, (id) => before.elements[id]);
  }

  private countWrite(cs: Changeset, patch: ChangesetPatch | null): void {
    this.writeBytes.commits += 1;
    this.writeBytes.body += JSON.stringify(cs).length;
    if (patch) this.writeBytes.patch += JSON.stringify(patch).length;
  }

  /** Extend this term. False = the lease is gone; the caller must stop committing at once. */
  async renewLease(): Promise<boolean> {
    const term = this.term;
    if (!term) return false;
    const [row] = await this.sql<{ expires_at: Date | null }[]>`
      select bim.renew_model_lease(${this.opts.modelId}, ${term.owner}, ${term.generation}, ${this.opts.leaseTtlMs}) as expires_at`;
    if (!row?.expires_at) return false;
    this.term = { ...term, expiresAt: row.expires_at };
    return true;
  }

  /** Give up this term so another process can take the model now. */
  async releaseLease(): Promise<boolean> {
    const term = this.term;
    this.term = null;
    if (!term) return false;
    const [row] = await this.sql<{ released: boolean }[]>`
      select bim.release_model_lease(${this.opts.modelId}, ${term.owner}, ${term.generation}) as released`;
    return row?.released === true;
  }

  /** Hello / heartbeat / export only, never the commit path. */
  async head(): Promise<ModelState> {
    // Decided edits not yet written are ahead of the database on purpose; the next write checks it hasn't moved.
    if (this.cache && this.unflushed.length > 0) return this.cache.model;
    const cached = this.cache;
    if (cached) {
      const [row] = await this.sql<{ revision: string; epoch: string }[]>`
        select revision, created_at::text as epoch from bim.models where id = ${this.opts.modelId}`;
      // This authority decided an edit while the row was being read: the head moved here, not outside, and the
      // edit's write is queued. Reloading now would drop it and fail the next group write.
      const now = this.cache;
      if (now && (now !== cached || this.unflushed.length > 0)) return now.model;
      if (now && row && row.epoch === cached.epoch && Number(row.revision) === cached.model.revision) return cached.model;
      if (now) {
        console.error("[bim-authority] head moved outside this authority; reloading", {
          modelId: this.opts.modelId,
          cached: cached.model.revision,
          database: row ? Number(row.revision) : null,
          reset: row ? row.epoch !== cached.epoch : null,
        });
      }
    }
    // One snapshot so the revision and the element rows cannot straddle a commit; joins arriving together share it.
    this.headLoading ??= this.sql
      .begin("isolation level repeatable read read only", async (tx) => {
        await tx`set local statement_timeout = '120s'`; // a whole building is a legitimately long read
        const started = performance.now();
        const { head, timings } = await this.loadFrom(tx);
        this.lastHeadLoad = { at: new Date().toISOString(), totalMs: performance.now() - started, ...timings };
        await this.offerKeptValidation(tx, head.model);
        return head;
      })
      .finally(() => {
        this.headLoading = null;
      });
    const head = await this.headLoading;
    // Edits decided on the old cache while it loaded are still queued: adopting would drop them. The lease
    // fence refuses their write if the head really moved, and the model is handed off as for any stale write.
    if (this.unflushed.length > 0 && this.cache) return this.cache.model;
    this.adopt(head);
    this.scheduleValidationState();
    return head.model;
  }

  async changesSince(revision: number): Promise<readonly Changeset[]> {
    const tail = this.unflushed.filter((cs) => cs.revision > revision);
    const rows = await this.sql<{ body: Changeset }[]>`
      select body from bim.changesets where model_id = ${this.opts.modelId} and revision > ${revision} order by revision`;
    return mergeHistory(
      rows.map((r) => r.body),
      tail,
    );
  }

  durableRevision(): number {
    return this.durable;
  }

  needsHistory(baseRevision: number): boolean {
    return this.cache !== null && historyMissing(this.recent, baseRevision, this.cache.model.revision);
  }

  needsPriorCheck(idempotencyKey: string, baseRevision: number): boolean {
    return !this.answered.has(idempotencyKey) && baseRevision < this.loaded;
  }

  async priorOutcome(idempotencyKey: string): Promise<CommitOutcome | null> {
    const [row] = await this.sql<{ prior: CommitOutcome | null }[]>`select ${priorAnswer(this.sql, this.opts.modelId, idempotencyKey)} as prior`;
    return row?.prior ?? null;
  }

  /** Group commit: decide on the cached head, which already holds every decided commit. No I/O. */
  decideLocal(
    generation: number,
    idempotencyKey: string,
    baseRevision: number,
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    actorId: string,
    history: readonly Changeset[] = [],
    commandDigest?: string,
  ): LocalDecision {
    const term = this.term;
    if (!term || term.generation !== generation) throw new StaleLeaseError(generation, term?.generation ?? -1);
    const prior = this.answered.get(idempotencyKey);
    if (prior) return { kind: "replay", outcome: prior };
    const cache = this.cache;
    if (!cache) {
      this.count("group_fallback_no_cache");
      return { kind: "fallback", reason: "no_cache" };
    }
    const head = cache.model;
    const since = sinceFromRecent(this.recent, baseRevision, head.revision, history);
    if (!since) {
      this.count("group_fallback_history_gap");
      return { kind: "fallback", reason: "history_gap" };
    }
    const decision = decide(head, since);
    if (!decision.ok) {
      const outcome = withCommandDigest({ status: "rejected", error: decision.error, conflict: decision.conflict }, commandDigest);
      return { kind: "decided", commit: { idempotencyKey, actorId, outcome, before: head, after: head } };
    }
    const cs = decision.changeset;
    this.cache = { model: decision.model, epoch: cache.epoch };
    this.remember(cs);
    this.unflushed.push(cs);
    const outcome = withCommandDigest({ status: "committed", revision: cs.revision, rebased: cs.rebased }, commandDigest);
    return { kind: "decided", commit: { idempotencyKey, actorId, outcome, changeset: cs, before: head, after: decision.model } };
  }

  /**
   * Write decided commits in order: one guarded statement per run (normally
   * the whole batch), all or nothing, behind the same lease and revision
   * fence as a single commit. A lost answer is checked before retrying, so a
   * batch is never written twice.
   */
  async flush(generation: number, commits: readonly DecidedCommit[]): Promise<void> {
    const term = this.term;
    const cache = this.cache;
    if (!term || term.generation !== generation || !cache) throw new PipelineBrokenError(generation, new StaleLeaseError(generation, term?.generation ?? -1));
    for (const run of planRuns(commits)) {
      const expected = this.durable;
      const written = run.commits.flatMap((c) => (c.changeset ? [c.changeset] : []));
      const logged = run.commits.flatMap((c) => (c.changeset ? [{ c: c.changeset, p: this.patchFor(c.changeset, c.before) }] : []));
      const last = written.at(-1)?.revision ?? expected;
      const lastKey = run.commits.at(-1)?.idempotencyKey ?? "";
      let applied = false;
      let failure: unknown = null;
      for (let attempt = 0; attempt < 3 && !applied; attempt++) {
        try {
          if (await this.writeRun(term, cache.epoch, expected, last, run, logged)) applied = true;
          else if (await this.runLanded(last, lastKey)) applied = true;
          else {
            failure = new Error("the model moved, the lease lapsed, or a key already had an answer");
            break;
          }
        } catch (err) {
          failure = err;
          console.error("[bim-authority] group write failed; checking whether it landed", { modelId: this.opts.modelId, attempt, err });
          try {
            if (await this.runLanded(last, lastKey)) applied = true;
          } catch (checkErr) {
            failure = checkErr;
          }
          if (!applied) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        }
      }
      if (!applied) {
        this.count("group_write_failed");
        throw new PipelineBrokenError(generation, failure);
      }
      this.count("group_write");
      this.pathStats.group_commits = (this.pathStats.group_commits ?? 0) + run.commits.length;
      this.durable = last;
      this.unflushed.splice(0, written.length);
      for (const c of run.commits) rememberAnswer(this.answered, c.idempotencyKey, c.outcome);
      for (const l of logged) this.countWrite(l.c, l.p);
    }
    this.afterDurable();
  }

  private async runLanded(last: number, lastKey: string): Promise<boolean> {
    const [row] = await this.sql<{ revision: string; answered: boolean }[]>`
      select m.revision,
             exists (select 1 from bim.command_outcomes o where o.model_id = m.id and o.idempotency_key = ${lastKey}) as answered
        from bim.models m where m.id = ${this.opts.modelId}`;
    return !!row && Number(row.revision) === last && row.answered;
  }

  private async writeRun(
    term: LeaseTerm,
    epoch: string,
    expected: number,
    last: number,
    run: BatchRun,
    logged: readonly { readonly c: Changeset; readonly p: ChangesetPatch | null }[],
  ): Promise<boolean> {
    const id = this.opts.modelId;
    const keys = run.commits.map((c) => c.idempotencyKey);
    const answers = run.commits.map((c) => ({ key: c.idempotencyKey, actorId: c.actorId, outcome: c.outcome }));
    const [row] = await this.sql<{ applied: string }[]>`
      with guard as (
        select m.id from bim.models m
        where m.id = ${id} and m.revision = ${expected} and m.created_at::text = ${epoch}::text
          and m.lease_owner = ${term.owner} and m.lease_generation = ${term.generation}
          and m.lease_expires_at > clock_timestamp() ${this.takesEdits(this.sql)}
          and not exists (select 1 from bim.command_outcomes o where o.model_id = ${id} and o.idempotency_key = any(${this.sql.array(keys)}::text[]))
          and not exists (select 1 from bim.changesets c where c.model_id = ${id} and c.idempotency_key = any(${this.sql.array(keys)}::text[]))
        for update of m
      ), els as (
        insert into bim.elements (model_id, element_id, kind, version, body)
        select ${id}, e->>'id', e->>'kind', (e->>'version')::bigint, e
        from jsonb_array_elements(${this.sql.json(toJson([...run.upserts.values()]))}::jsonb) as e
        where exists (select 1 from guard)
        on conflict (model_id, element_id) do update
          set kind = excluded.kind, version = excluded.version, body = excluded.body
        returning 1
      ), dels as (
        delete from bim.elements
        where model_id = ${id} and element_id in (select jsonb_array_elements_text(${this.sql.json(toJson([...run.removed]))}::jsonb))
          and exists (select 1 from guard)
        returning 1
      ), cuts as (
        delete from bim.connections
        where model_id = ${id} and connection_id in (select jsonb_array_elements_text(${this.sql.json(toJson([...run.cut]))}::jsonb))
          and exists (select 1 from guard)
        returning 1
      ), joins as (
        ${insertConnections(this.sql, id, [...run.added.values()], "guard")}
      ), log as (
        insert into bim.changesets (model_id, revision, idempotency_key, actor_id, actor_kind, body${this.storage.changesetPatch ? this.sql`, patch` : this.sql``})
        select ${id}, (r->'c'->>'revision')::bigint, r->'c'->>'idempotencyKey', r->'c'->'actor'->>'id', r->'c'->'actor'->>'kind', r->'c'${this.storage.changesetPatch ? this.sql`, r->'p'` : this.sql``}
        from jsonb_array_elements(${this.sql.json(toJson(logged))}::jsonb) as r
        where exists (select 1 from guard)
        returning 1
      ), advance as (
        update bim.models set revision = ${last}
        where id = ${id} and revision = ${expected} and exists (select 1 from guard)
        returning 1
      ), answer as (
        insert into bim.command_outcomes (model_id, idempotency_key, actor_id, outcome)
        select ${id}, a->>'key', a->>'actorId', a->'outcome'
        from jsonb_array_elements(${this.sql.json(toJson(answers))}::jsonb) as a
        where exists (select 1 from guard)
        returning 1
      )
      select (select count(*) from advance) as applied`;
    return Number(row?.applied ?? 0) === 1;
  }

  /**
   * Fast path first: the head in memory under the lease commits in ONE
   * self-checking statement. Anything unusual (outside writer, reset, client far
   * behind) falls through to the locked transaction, which is always correct.
   * Both refuse a write unless this process holds an unexpired lease of this term.
   */
  async transact(
    generation: number,
    idempotencyKey: string,
    baseRevision: number,
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    actorId = "unknown",
    commandDigest?: string,
  ): Promise<TransactResult> {
    const term = this.term;
    if (!term || term.generation !== generation) throw new StaleLeaseError(generation, term?.generation ?? -1);
    this.count("attempt");
    try {
      const fast = await this.fastCommit(term, idempotencyKey, baseRevision, decide, actorId, commandDigest);
      if (fast) return fast;
    } catch (err) {
      // A concurrent writer recorded the same request key first; the locked path replays its answer.
      if (!isUniqueViolation(err)) throw err;
    }
    return this.lockedTransact(term, idempotencyKey, baseRevision, decide, actorId, commandDigest);
  }

  private async fastCommit(
    term: LeaseTerm,
    idempotencyKey: string,
    baseRevision: number,
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    actorId: string,
    commandDigest?: string,
  ): Promise<TransactResult | null> {
    const cache = this.cache;
    if (!cache) {
      this.count("fast_miss_no_cache");
      return null;
    }
    const head = cache.model;
    let since: readonly Changeset[] = [];
    if (baseRevision < head.revision) {
      since = this.recent.filter((c) => c.revision > baseRevision);
      if (since[0]?.revision !== baseRevision + 1 || since.length !== head.revision - baseRevision) {
        this.count("fast_miss_history_gap");
        return null;
      }
    }
    const decision = decide(head, since);
    if (!decision.ok) {
      const outcome = withCommandDigest({ status: "rejected", error: decision.error, conflict: decision.conflict }, commandDigest);
      if (await this.guardedReject(head.revision, cache.epoch, term, idempotencyKey, outcome, actorId)) {
        this.count("fast_reject");
        return { outcome, replayed: false };
      }
      this.count("fast_miss_reject_guard");
      return null;
    }
    const cs = decision.changeset;
    const outcome = withCommandDigest({ status: "committed", revision: cs.revision, rebased: cs.rebased }, commandDigest);
    if (!(await this.guardedWrite(head, cache.epoch, term, idempotencyKey, cs, outcome))) {
      this.count("fast_miss_write_guard");
      return null;
    }
    this.count("fast_commit");
    this.cache = { model: decision.model, epoch: cache.epoch };
    this.durable = cs.revision;
    this.remember(cs);
    this.afterDurable();
    return { outcome, changeset: cs, replayed: false };
  }

  /**
   * One autocommit statement: applies only if the model is still at `expected`
   * in the same epoch, this process holds an unexpired lease of this term, and
   * the key has no answer yet. Otherwise writes nothing and returns false.
   */
  private async guardedWrite(
    head: ModelState,
    epoch: string,
    term: LeaseTerm,
    idempotencyKey: string,
    cs: Changeset,
    outcome: CommitOutcome,
  ): Promise<boolean> {
    const id = this.opts.modelId;
    const expected = head.revision;
    const patch = this.patchFor(cs, head);
    const [row] = await this.sql<{ applied: string }[]>`
      with guard as (
        select m.id from bim.models m
        where m.id = ${id} and m.revision = ${expected} and m.created_at::text = ${epoch}::text
          and m.lease_owner = ${term.owner} and m.lease_generation = ${term.generation}
          and m.lease_expires_at > clock_timestamp() ${this.takesEdits(this.sql)}
          and not exists (select 1 from bim.command_outcomes o where o.model_id = ${id} and o.idempotency_key = ${idempotencyKey})
          and not exists (select 1 from bim.changesets c where c.model_id = ${id} and c.idempotency_key = ${idempotencyKey})
        for update of m
      ), els as (
        insert into bim.elements (model_id, element_id, kind, version, body)
        select ${id}, e->>'id', e->>'kind', (e->>'version')::bigint, e
        from jsonb_array_elements(${this.sql.json(toJson(cs.elements))}::jsonb) as e
        where exists (select 1 from guard)
        on conflict (model_id, element_id) do update
          set kind = excluded.kind, version = excluded.version, body = excluded.body
        returning 1
      ), dels as (
        delete from bim.elements
        where model_id = ${id} and element_id in (select jsonb_array_elements_text(${this.sql.json(toJson(cs.removedIds ?? []))}::jsonb))
          and exists (select 1 from guard)
        returning 1
      ), cuts as (
        delete from bim.connections
        where model_id = ${id} and connection_id in (select jsonb_array_elements_text(${this.sql.json(toJson(cutIds(cs)))}::jsonb))
          and exists (select 1 from guard)
        returning 1
      ), joins as (
        ${insertConnections(this.sql, id, connectionRows(cs, head), "guard")}
      ), log as (
        insert into bim.changesets (model_id, revision, idempotency_key, actor_id, actor_kind, body${patch ? this.sql`, patch` : this.sql``})
        select ${id}, ${cs.revision}, ${cs.idempotencyKey}, ${cs.actor.id}, ${cs.actor.kind}, ${this.sql.json(toJson(cs))}${patch ? this.sql`, ${this.sql.json(toJson(patch))}` : this.sql``}
        where exists (select 1 from guard)
        returning 1
      ), advance as (
        update bim.models set revision = ${cs.revision}
        where id = ${id} and revision = ${expected} and exists (select 1 from guard)
        returning 1
      ), answer as (
        insert into bim.command_outcomes (model_id, idempotency_key, actor_id, outcome)
        select ${id}, ${idempotencyKey}, ${cs.actor.id}, ${this.sql.json(toJson(outcome))}
        where exists (select 1 from guard)
        returning 1
      )
      select (select count(*) from advance) as applied`;
    const applied = Number(row?.applied ?? 0) === 1;
    if (applied) this.countWrite(cs, patch);
    return applied;
  }

  /** Same guard for a rejection, so a refusal is never recorded against a head that moved or a lease that lapsed. */
  private async guardedReject(
    expected: number,
    epoch: string,
    term: LeaseTerm,
    idempotencyKey: string,
    outcome: CommitOutcome,
    actorId: string,
  ): Promise<boolean> {
    const id = this.opts.modelId;
    const rows = await this.sql`
      insert into bim.command_outcomes (model_id, idempotency_key, actor_id, outcome)
      select ${id}, ${idempotencyKey}, ${actorId}, ${this.sql.json(toJson(outcome))}
      from bim.models m
      where m.id = ${id} and m.revision = ${expected} and m.created_at::text = ${epoch}::text
        and m.lease_owner = ${term.owner} and m.lease_generation = ${term.generation}
        and m.lease_expires_at > clock_timestamp()
        and not exists (select 1 from bim.changesets c where c.model_id = ${id} and c.idempotency_key = ${idempotencyKey})
      on conflict (model_id, idempotency_key) do nothing
      returning 1`;
    return rows.length === 1;
  }

  /** Guard clause: the model takes edits (a plain model always; a branch while open or waiting on a merge). */
  private takesEdits(sql: Sql | Tx) {
    return this.storage.branches ? sql`and (m.branch_state is null or m.branch_state in ('open', 'merge_proposed'))` : sql``;
  }

  /** The head from the database: a plain model's element rows, or a branch rebuilt on its base. */
  private async loadFrom(tx: Sql | Tx): Promise<{ head: CachedHead; timings: LoadTimings }> {
    const branch = this.opts.branch;
    if (!branch) return loadHeadTimed(tx, this.opts.modelId, this.opts.bootPageSize);
    const started = performance.now();
    const head = await loadBranchHead(tx, this.opts.modelId, branch.baseRevision, branch.base);
    const ms = performance.now() - started;
    return { head, timings: { modelRowMs: 0, elementsMs: ms, connectionsMs: 0, buildMs: 0, elements: elementCount(head.model.elements), pages: 0 } };
  }

  private remember(cs: Changeset): void {
    this.recent.push(cs);
    if (this.recent.length > RECENT_KEPT) this.recent.splice(0, this.recent.length - RECENT_KEPT);
  }

  /** Only ever called with nothing decided and unwritten (a load, or the serial path after a drain). */
  private adopt(head: CachedHead): void {
    this.cache = head;
    this.recent = [];
    this.unflushed = [];
    this.durable = this.loaded = head.model.revision;
  }

  private forget(): void {
    this.cache = null;
    this.recent = [];
    this.unflushed = [];
    this.durable = this.loaded = -1;
    this.answered.clear();
  }

  private headFrom(row: ModelRow, since: readonly Changeset[]): CachedHead | null {
    const cache = this.cache;
    const target = Number(row.revision);
    if (!cache || cache.epoch !== row.epoch || cache.model.revision > target) return null;
    let model = cache.model;
    for (const cs of since) {
      if (cs.revision <= model.revision) continue;
      if (cs.revision !== model.revision + 1) return null;
      model = applyChangeset(model, cs);
    }
    if (model.revision !== target) return null;
    this.cache = { model, epoch: cache.epoch };
    return this.cache;
  }

  private async lockedTransact(
    term: LeaseTerm,
    idempotencyKey: string,
    baseRevision: number,
    decide: (head: ModelState, sinceBase: readonly Changeset[]) => CommitDecision,
    actorId: string,
    commandDigest?: string,
  ): Promise<TransactResult> {
    const id = this.opts.modelId;
    this.count("locked_fallback");
    // Begin, one read, one write, commit while the model row is locked. The
    // connection's statement and lock timeouts bound how long that can last.
    const done = await this.sql.begin(async (tx): Promise<LockedResult> => {
      const cache = this.cache;
      const from = cache ? Math.min(baseRevision, cache.model.revision) : baseRevision;
      const [read] = await tx<DeltaRead[]>`
        with m as (
          select revision, lease_generation, settings, created_at::text as epoch,
                 (lease_owner = ${term.owner} and lease_expires_at > clock_timestamp()) as held,
                 ${this.storage.branches ? tx`branch_state` : tx`null::text`} as branch_state
            from bim.models where id = ${id} for update
        )
        select
          (select row_to_json(m) from m) as model,
          ${priorAnswer(tx, id, idempotencyKey)} as prior,
          coalesce((select jsonb_agg(body order by revision) from bim.changesets
                    where model_id = ${id} and revision > ${from}), '[]'::jsonb) as since`;
      const m = read?.model;
      if (!read || !m) throw new Error(`Model ${id} not found`);
      if ((this.opts.processLeaseChecks?.() ?? true) && (Number(m.lease_generation) !== term.generation || !m.held)) {
        this.count("locked_lease_refused_by_process");
        throw new StaleLeaseError(term.generation, Number(m.lease_generation));
      }
      if (read.prior) return { result: { outcome: read.prior, replayed: true }, committed: null };
      if (m.branch_state !== null) {
        const state = readBranchState(m.branch_state);
        if (!branchAcceptsEdits(state)) {
          // Merged or closed (perhaps from another machine): refused and recorded, behind the same lock and lease.
          this.opts.onBranchState?.(state);
          const outcome: CommitOutcome = { status: "rejected", error: { code: "forbidden", message: branchClosedMessage(state), elementIds: [] } };
          await tx`insert into bim.command_outcomes (model_id, idempotency_key, actor_id, outcome)
            values (${id}, ${idempotencyKey}, ${actorId}, ${tx.json(toJson(outcome))})`;
          this.count("locked_branch_refused");
          return { result: { outcome, replayed: false }, committed: null };
        }
      }

      let head = this.headFrom(m, read.since);
      if (!head) {
        // Something wrote or reset the model without this process: adopt the
        // database's state even if this commit is refused, so heartbeats report
        // the real head and clients catch up instead of conflicting forever.
        if (cache) {
          console.error("[bim-authority] head moved outside this process; reloading", {
            modelId: id,
            cached: cache.model.revision,
            database: Number(m.revision),
            reset: cache.epoch !== m.epoch,
          });
        }
        head = (await this.loadFrom(tx)).head;
        this.adopt(head);
      }
      const sinceBase = read.since.filter((c) => c.revision > baseRevision);
      const decision = decide(head.model, sinceBase);

      if (!decision.ok) {
        const outcome = withCommandDigest({ status: "rejected", error: decision.error, conflict: decision.conflict }, commandDigest);
        const stored = await tx`insert into bim.command_outcomes (model_id, idempotency_key, actor_id, outcome)
          select ${id}, ${idempotencyKey}, ${actorId}, ${tx.json(toJson(outcome))}
          from bim.models m where m.id = ${id} and m.lease_owner = ${term.owner} and m.lease_generation = ${term.generation}
            and m.lease_expires_at > clock_timestamp()
          returning 1`;
        if (stored.length !== 1) {
          this.count("locked_lease_refused_by_database");
          throw new StaleLeaseError(term.generation, Number(m.lease_generation));
        }
        return { result: { outcome, replayed: false }, committed: null };
      }

      const cs = decision.changeset;
      const outcome = withCommandDigest({ status: "committed", revision: cs.revision, rebased: cs.rebased }, commandDigest);
      const patch = this.patchFor(cs, head.model);
      // One statement: batch-upsert the changed elements, append the changeset,
      // advance the head and record the outcome, all behind the lease fence.
      const [written] = await tx<{ advanced: string }[]>`
        with fence as (
          select m.id from bim.models m
          where m.id = ${id} and m.lease_owner = ${term.owner} and m.lease_generation = ${term.generation}
            and m.lease_expires_at > clock_timestamp() ${this.takesEdits(tx)}
        ), els as (
          insert into bim.elements (model_id, element_id, kind, version, body)
          select ${id}, e->>'id', e->>'kind', (e->>'version')::bigint, e
          from jsonb_array_elements(${tx.json(toJson(cs.elements))}::jsonb) as e
          where exists (select 1 from fence)
          on conflict (model_id, element_id) do update
            set kind = excluded.kind, version = excluded.version, body = excluded.body
          returning 1
        ), dels as (
          delete from bim.elements
          where model_id = ${id} and element_id in (select jsonb_array_elements_text(${tx.json(toJson(cs.removedIds ?? []))}::jsonb))
            and exists (select 1 from fence)
          returning 1
        ), cuts as (
          delete from bim.connections
          where model_id = ${id} and connection_id in (select jsonb_array_elements_text(${tx.json(toJson(cutIds(cs)))}::jsonb))
            and exists (select 1 from fence)
          returning 1
        ), joins as (
          ${insertConnections(tx, id, connectionRows(cs, head.model), "fence")}
        ), log as (
          insert into bim.changesets (model_id, revision, idempotency_key, actor_id, actor_kind, body${patch ? tx`, patch` : tx``})
          select ${id}, ${cs.revision}, ${cs.idempotencyKey}, ${cs.actor.id}, ${cs.actor.kind}, ${tx.json(toJson(cs))}${patch ? tx`, ${tx.json(toJson(patch))}` : tx``}
          where exists (select 1 from fence)
          returning 1
        ), advance as (
          update bim.models set revision = ${cs.revision} where id = ${id} and exists (select 1 from fence) returning 1
        ), answer as (
          insert into bim.command_outcomes (model_id, idempotency_key, actor_id, outcome)
          select ${id}, ${idempotencyKey}, ${cs.actor.id}, ${tx.json(toJson(outcome))}
          where exists (select 1 from fence)
          returning 1
        )
        select (select count(*) from advance) as advanced`;
      if (Number(written?.advanced ?? 0) !== 1) {
        this.count("locked_lease_refused_by_database");
        throw new StaleLeaseError(term.generation, Number(m.lease_generation));
      }
      return {
        result: { outcome, changeset: cs, replayed: false },
        committed: { head: { model: decision.model, epoch: head.epoch }, changeset: cs, patch },
      };
    });
    if (done.committed) {
      this.cache = done.committed.head;
      this.remember(done.committed.changeset);
      this.countWrite(done.committed.changeset, done.committed.patch);
    }
    if (this.cache) this.durable = this.cache.model.revision;
    this.afterDurable();
    return done.result;
  }

  /**
   * Every CHECKPOINT_EVERY durable revisions, write the durable head as a
   * checkpoint and apply changeset retention, off the commit path and behind
   * the lease. Only when nothing decided is still unwritten, so the cached
   * head is exactly the durable one. A failure is logged and retried at the
   * next interval; it never affects a commit.
   */
  private afterDurable(): void {
    this.scheduleValidationState();
    const cache = this.cache;
    const term = this.term;
    if (!this.storage.checkpoints || this.opts.branch || !cache || !term || this.checkpointing || this.unflushed.length > 0) return;
    const revision = cache.model.revision;
    if (revision !== this.durable || revision - this.lastCheckpoint < (this.opts.checkpointEvery ?? CHECKPOINT_EVERY)) return;
    const elements = Object.values(cache.model.elements); // full-scan-ok: a checkpoint is the whole head, every CHECKPOINT_EVERY revisions, off the commit path
    if (elements.length > (this.opts.checkpointMaxElements ?? CHECKPOINT_MAX_ELEMENTS)) {
      if (!this.checkpointTooLargeLogged) {
        console.error("[bim-authority] model too large to checkpoint whole; changesets are kept until partitioned checkpoints land", { modelId: this.opts.modelId, elements: elements.length });
        this.checkpointTooLargeLogged = true;
      }
      return;
    }
    const body = { revision, elements, connections: cache.model.connections, settings: cache.model.settings };
    this.checkpointing = this.writeCheckpoint(term, revision, elements.length, body)
      .catch((err) => {
        console.error("[bim-authority] checkpoint failed; will try again at the next interval", { modelId: this.opts.modelId, revision, err });
      })
      .finally(() => {
        this.checkpointing = null;
      });
  }

  private async writeCheckpoint(term: LeaseTerm, revision: number, elementCount: number, body: unknown): Promise<void> {
    const id = this.opts.modelId;
    const written = await this.sql`
      insert into bim.checkpoints (model_id, revision, element_count, body)
      select ${id}, ${revision}, ${elementCount}, ${this.sql.json(toJson(body))}
      from bim.models m
      where m.id = ${id} and m.lease_owner = ${term.owner} and m.lease_generation = ${term.generation}
        and m.lease_expires_at > clock_timestamp() and m.revision >= ${revision}
      on conflict (model_id, revision) do nothing
      returning 1`;
    if (written.length !== 1) return; // lease lapsed or already written; the next owner checkpoints
    this.lastCheckpoint = revision;
    const [purged] = await this.sql<{ deleted: string }[]>`select bim.purge_changesets(${id}) as deleted`;
    this.count("checkpoint");
    this.pathStats.changesets_purged = (this.pathStats.changesets_purged ?? 0) + Number(purged?.deleted ?? 0);
  }

  /** Wait for a checkpoint in progress (tests, shutdown). */
  async settleCheckpoint(): Promise<void> {
    await this.checkpointing;
  }

  // ── Kept validation state (round 9 K9) ────────────────────────────────────

  private validationTimer: ReturnType<typeof setTimeout> | null = null;
  private validationWriting: Promise<void> | null = null;
  /** Newest revision whose validation state this term wrote (-1: none). */
  private validationWritten = -1;

  private validationKey(): string | null {
    const key = this.opts.validationCodeKey;
    return this.storage.validationStates && !this.opts.branch && key ? key : null;
  }

  /** In the head's own read snapshot: the state kept for exactly this revision and build, offered to the kernel (which decides on first read). */
  private async offerKeptValidation(tx: Sql | Tx, model: ModelState): Promise<void> {
    const key = this.validationKey();
    if (!key) return;
    try {
      const [row] = await tx<{ body: unknown }[]>`
        select body from bim.validation_states
        where model_id = ${this.opts.modelId} and revision = ${model.revision} and code_key = ${key} and version = ${VALIDATION_STATE_VERSION}`;
      if (!row) {
        this.count("validation_state_none");
        return;
      }
      offerValidationState(model, row.body, key);
      this.count("validation_state_offered");
    } catch (err) {
      // The cold pass answers instead; a kept state is never needed for correctness.
      console.error("[bim-authority] reading the kept validation state failed; the model is checked from scratch", { modelId: this.opts.modelId, revision: model.revision, err });
      this.count("validation_state_read_failed");
    }
  }

  /** Write the validation state once commits have been quiet a while (restarted by every durable commit). */
  private scheduleValidationState(): void {
    if (!this.validationKey()) return;
    if (this.validationTimer) clearTimeout(this.validationTimer);
    this.validationTimer = setTimeout(() => {
      this.validationTimer = null;
      this.writeValidationState().catch((err) => console.error("[bim-authority] writing the validation state failed; will try after the next commit", { modelId: this.opts.modelId, err }));
    }, this.opts.validationStateIdleMs ?? VALIDATION_STATE_IDLE_MS);
    this.validationTimer.unref?.();
  }

  /** Write the durable head's validation state, behind the lease and only for the head the database holds. Exposed for tests and drills. */
  async writeValidationState(): Promise<boolean> {
    const key = this.validationKey();
    const cache = this.cache;
    const term = this.term;
    if (!key || !cache || !term || this.validationWriting || this.unflushed.length > 0) return false;
    const model = cache.model;
    if (model.revision !== this.durable || model.revision === this.validationWritten) return false;
    // Only what commits and the first check already established, plus the point index the save left to be built after it.
    buildPointReads(model);
    const state = validationStateOf(model, key);
    if (!state) {
      this.count("validation_state_not_known");
      return false;
    }
    const id = this.opts.modelId;
    const body = toJson(state);
    const write = this.sql`
      insert into bim.validation_states (model_id, revision, version, code_key, element_count, body)
      select ${id}, ${model.revision}, ${state.version}, ${key}, ${state.elementCount}, ${this.sql.json(body)}
      from bim.models m
      where m.id = ${id} and m.lease_owner = ${term.owner} and m.lease_generation = ${term.generation}
        and m.lease_expires_at > clock_timestamp() and m.revision = ${model.revision}
      on conflict (model_id) do update
        set revision = excluded.revision, version = excluded.version, code_key = excluded.code_key,
            element_count = excluded.element_count, body = excluded.body, written_at = now()
      returning 1`.then((rows) => {
      if (rows.length !== 1) return; // lease lapsed or the head moved on; the next quiet spell writes it
      this.validationWritten = model.revision;
      this.count("validation_state_written");
      this.pathStats.validation_state_bytes = JSON.stringify(body).length;
    });
    this.validationWriting = write.finally(() => {
      this.validationWriting = null;
    });
    await this.validationWriting;
    return this.validationWritten === model.revision;
  }

  /** Stop the pending write (shutdown) and wait for one in progress. */
  async settleValidationState(): Promise<void> {
    if (this.validationTimer) clearTimeout(this.validationTimer);
    this.validationTimer = null;
    await this.validationWriting;
  }

  /**
   * Before giving the model up while the lease still holds (shutdown): write the
   * state now if a quiet-spell write was still pending, so the next process of
   * this build adopts the latest head instead of checking it from scratch.
   */
  async flushValidationState(): Promise<boolean> {
    const pending = this.validationTimer !== null;
    await this.settleValidationState();
    return pending ? this.writeValidationState() : false;
  }
}

interface BatchRun {
  readonly commits: DecidedCommit[];
  /** Net effect of the run: last write per element, removals, connections made and cut. */
  readonly upserts: Map<string, BimElement>;
  readonly removed: Set<string>;
  readonly added: Map<string, ConnectionRowInput>;
  readonly cut: Set<string>;
}

/**
 * Split a batch into runs that each fit one statement. Normally one run. A
 * connection that existed before the run and is cut and made again inside it
 * would be deleted and inserted by sibling statements on the same row, so the
 * run ends before it. Runs are written in order: durability stays a prefix.
 */
function planRuns(commits: readonly DecidedCommit[]): BatchRun[] {
  const fresh = (): BatchRun => ({ commits: [], upserts: new Map(), removed: new Set(), added: new Map(), cut: new Set() });
  const runs: BatchRun[] = [];
  let run = fresh();
  for (const c of commits) {
    const cs = c.changeset;
    const made = cs ? connectionRows(cs, c.before) : [];
    if (run.commits.length > 0 && made.some((r) => run.cut.has(r.id))) {
      runs.push(run);
      run = fresh();
    }
    run.commits.push(c);
    if (!cs) continue;
    for (const el of cs.elements) {
      run.upserts.set(el.id, el);
      run.removed.delete(el.id);
    }
    for (const removedId of cs.removedIds ?? []) {
      run.upserts.delete(removedId);
      run.removed.add(removedId);
    }
    for (const gone of cs.removedConnections ?? []) {
      if (run.added.has(gone.id)) run.added.delete(gone.id);
      else run.cut.add(gone.id);
    }
    for (const r of made) run.added.set(r.id, r);
  }
  if (run.commits.length > 0) runs.push(run);
  return runs;
}

interface LockedResult {
  readonly result: TransactResult;
  readonly committed: { readonly head: CachedHead; readonly changeset: Changeset; readonly patch: ChangesetPatch | null } | null;
}

interface DeltaRead {
  model: (ModelRow & { held: boolean; branch_state: string | null }) | null;
  prior: CommitOutcome | null;
  since: Changeset[];
}

/**
 * The first answer for a request key: its stored outcome, or, once outcomes
 * past the retention window are purged, the committed changeset itself.
 */
function priorAnswer(sql: Sql | Tx, modelId: string, idempotencyKey: string) {
  return sql`coalesce(
    (select outcome from bim.command_outcomes where model_id = ${modelId} and idempotency_key = ${idempotencyKey}),
    (select jsonb_build_object('status', 'committed', 'revision', c.revision, 'rebased', coalesce((c.body->>'rebased')::boolean, false))
     from bim.changesets c where c.model_id = ${modelId} and c.idempotency_key = ${idempotencyKey}))`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

function cutIds(cs: Changeset): string[] {
  return (cs.removedConnections ?? []).map((c) => c.id);
}

interface ConnectionRowInput {
  readonly id: string;
  readonly a_element: string;
  readonly a_end: string;
  readonly b_element: string;
  readonly b_end: string;
  readonly level: string;
  readonly zone: string;
  readonly discipline: string;
}

/**
 * Connections a change makes, with the partition of their first end (the
 * insert trigger would look it up, but cannot see an element written by the
 * same statement). Ends are read from the change itself, then the head.
 */
function connectionRows(cs: Changeset, head: ModelState): ConnectionRowInput[] {
  const written = new Map(cs.elements.map((el) => [el.id, el]));
  return (cs.addedConnections ?? []).map((c) => {
    const a = written.get(c.a.elementId) ?? head.elements[c.a.elementId];
    if (!a) throw new Error(`Connection ${c.id} names unknown element ${c.a.elementId}`);
    const p = partitionOf(a);
    return { id: c.id, a_element: c.a.elementId, a_end: c.a.end, b_element: c.b.elementId, b_end: c.b.end, level: p.level, zone: p.zone, discipline: p.discipline };
  });
}

/** Append connections after the model's last ordinal, only when the named guard CTE passed. */
function insertConnections(sql: Sql | Tx, modelId: string, rows: readonly ConnectionRowInput[], guardName: "guard" | "fence") {
  const guardRef = guardName === "guard" ? sql`guard` : sql`fence`;
  return sql`
    insert into bim.connections (model_id, connection_id, ordinal, a_element, a_end, b_element, b_end, level, zone, discipline)
    select ${modelId}, r->>'id',
           (select coalesce(max(ordinal), -1) from bim.connections where model_id = ${modelId}) + x.ord::integer,
           r->>'a_element', r->>'a_end', r->>'b_element', r->>'b_end', r->>'level', r->>'zone', r->>'discipline'
    from jsonb_array_elements(${sql.json(toJson(rows))}::jsonb) with ordinality as x(r, ord)
    where exists (select 1 from ${guardRef})
    returning 1`;
}

/** JSONB boundary: our own plain data objects, serialized as-is. */
export function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value));
}
