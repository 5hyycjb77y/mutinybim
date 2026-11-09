import {
  asBranchState,
  branchAcceptsEdits,
  branchClosedMessage,
  forkState,
  type BimElement,
  type BranchRef,
  type Changeset,
  type ModelState,
} from "@permitzip/bim-kernel";
import {
  lineageChain,
  lineageLookup,
  lineageModelId,
  ROOT_LINEAGE_ID,
  type RecordedLineageAct,
} from "@permitzip/bim-kernel/lineages";
import { SyncHub, type HubOptions } from "../hub";
import { Sequencer } from "../sequencer";
import { InMemoryCommitStore } from "../store";
import { storeHistory, type HistoryReader } from "./history";
import { InMemoryBranchRegistry, type InMemoryRegistrySnapshot } from "./registry";
import { BranchService } from "./service";
import type { MergeApprovalSource } from "../merge/engine";
import { sequencerLander } from "../merge/lander";
import { mergeSessionHandler } from "../merge/session";
import type { ConnectionLineage } from "../authorization";
import { lineageHistory } from "../lineages/history";
import { LINEAGE_CHECKPOINT_EVERY, lineageCheckpointBody, openLineageHead, type LineageCheckpointStore, type OpenedLineageHead } from "../lineages/checkpoints";
import type { LineageRow } from "../lineages/rights";
import { LineageService, lineageActKey, type LineageActRecorder } from "../lineages/service";

export interface ServedModel {
  readonly store: InMemoryCommitStore;
  readonly sequencer: Sequencer;
  readonly hub: SyncHub;
  /** How this copy was opened (null: the first copy). */
  readonly opened: OpenedLineageHead | null;
}

/** Signed acts kept in memory (tests, the development server). */
export class InMemoryLineageActs implements LineageActRecorder {
  readonly recorded: RecordedLineageAct[] = [];

  private readonly byKey = new Map<string, { readonly seq: number; readonly ref: string }>();

  async record(input: Parameters<LineageActRecorder["record"]>[0]): Promise<{ readonly seq: number; readonly ref: string }> {
    const key = lineageActKey(input);
    const already = this.byKey.get(key);
    if (already) return already;
    const seq = this.recorded.length + 1;
    const ref = `act-${seq}`;
    this.recorded.push({ ref, act: input.act });
    this.byKey.set(key, { seq, ref });
    return { seq, ref };
  }

  async list(): Promise<readonly RecordedLineageAct[]> {
    return this.recorded;
  }
}

export interface InMemoryLineageOptions {
  /** Where copies' checkpoints live; absent: copies replay from their fork. */
  readonly checkpoints?: LineageCheckpointStore;
  /** Own revisions between checkpoints (default LINEAGE_CHECKPOINT_EVERY). */
  readonly checkpointEvery?: number;
  /** Signed acts (review, accept back); absent: those are not served. */
  readonly acts?: LineageActRecorder;
  /** Who covers what on the parent (the engineer of record), read as the person. */
  readonly responsibleOn?: (input: { readonly userId: string; readonly chain: readonly LineageRow[]; readonly changed: (lineageId: string) => Promise<readonly BimElement[]> }) => Promise<ReadonlySet<string>>;
}

/** Main, its copies and its saved versions as plain data (JSON-safe): what a single-machine host saves to start again after a restart. */
export interface InMemoryHostSnapshot {
  readonly main: { readonly head: ModelState; readonly history: readonly Changeset[] };
  readonly registry: InMemoryRegistrySnapshot;
  /** Each copy's own changesets since its fork, by copy model id. */
  readonly copies: Readonly<Record<string, readonly Changeset[]>>;
}

/**
 * Main and its copies in one process (tests, the development server, the
 * single-machine hosted app, which saves `snapshot()` and passes it back to
 * `start`). The
 * model server does the same over Postgres: a copy is opened from its
 * parent's state at its fork pin (copy on write), plus its newest
 * checkpoint's net change, plus its own changesets after that. Copies of
 * copies open the same way at any depth.
 */
export class InMemoryBranchHost {
  private readonly branches = new Map<string, Promise<ServedModel>>();
  /** Own changesets of copies closed in this process (`reopen` reads them, as a restarted server reads its database). */
  private readonly ownLog = new Map<string, readonly Changeset[]>();
  private readonly changeListeners = new Set<() => void>();

  private constructor(
    readonly main: ServedModel,
    readonly registry: InMemoryBranchRegistry,
    private readonly hubOptions: Omit<HubOptions, "branches">,
    /** Who is responsible and who approved (the host's records). Absent: branches don't serve merges. */
    private readonly mergeSource: MergeApprovalSource | null,
    private readonly lineageOptions: InMemoryLineageOptions,
  ) {}

  /** `restored`: a `snapshot()` saved earlier; `initial` is then ignored. */
  static async start(initial: ModelState, hubOptions: Omit<HubOptions, "branches"> = {}, mergeSource: MergeApprovalSource | null = null, lineageOptions: InMemoryLineageOptions = {}, restored?: InMemoryHostSnapshot): Promise<InMemoryBranchHost> {
    const store = restored ? new InMemoryCommitStore(restored.main.head, restored.main.history) : new InMemoryCommitStore(initial);
    const sequencer = await Sequencer.start(store);
    const registry = new InMemoryBranchRegistry(undefined, restored?.registry);
    const modelId = restored ? restored.main.head.modelId : initial.modelId;
    const service = new BranchService({ modelId, registry, history: storeHistory(store), head: () => sequencer.head() });
    const served: { host: InMemoryBranchHost | null } = { host: null };
    const lineages = InMemoryBranchHost.lineageService(modelId, ROOT_LINEAGE_ID, registry, served, lineageOptions);
    const hub = new SyncHub(sequencer, { ...hubOptions, branches: service, lineages });
    const host = new InMemoryBranchHost({ store, sequencer, hub, opened: null }, registry, hubOptions, mergeSource, lineageOptions);
    served.host = host;
    for (const [modelId, own] of Object.entries(restored?.copies ?? {})) host.ownLog.set(modelId, own);
    sequencer.onCommit(() => host.changed());
    registry.onStored(() => host.changed());
    return host;
  }

  /** Called after any edit on Main or a copy, and after a branch, copy or saved version changes: the cue to save `snapshot()`. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  /** Main, every copy and every saved version now, as plain data. */
  async snapshot(): Promise<InMemoryHostSnapshot> {
    const base = await this.baseModelId();
    const copies: Record<string, readonly Changeset[]> = {};
    for (const ref of await this.registry.list(base)) copies[ref.modelId] = await this.ownChanges(ref);
    return { main: { head: await this.main.store.head(), history: await this.main.store.changesSince(0) }, registry: this.registry.snapshot(), copies };
  }

  private async ownChanges(ref: BranchRef): Promise<readonly Changeset[]> {
    const served = await this.branches.get(ref.modelId)?.catch((err: unknown) => {
      console.error("[bim-sync] a copy failed to open; its saved changes are kept as they were", { modelId: ref.modelId, err });
      return null;
    });
    if (!served) return this.ownLog.get(ref.modelId) ?? [];
    return served.store.changesSince(ref.baseRevision);
  }

  private static lineageService(baseModelId: string, lineageId: string, registry: InMemoryBranchRegistry, served: { host: InMemoryBranchHost | null }, opts: InMemoryLineageOptions): LineageService {
    const hostOf = (): InMemoryBranchHost => {
      if (!served.host) throw new Error("The copy host isn't started yet.");
      return served.host;
    };
    return new LineageService({
      baseModelId,
      lineageId,
      store: registry,
      line: (id) => hostOf().line(id),
      ...(opts.acts ? { acts: opts.acts } : {}),
      lander: async (targetLineageId, actor, fromLineageId) => {
        const host = hostOf();
        const target = await host.servedLineage(targetLineageId);
        return sequencerLander({ sequencer: target.sequencer, actor, branchModelId: await host.modelIdOf(fromLineageId) });
      },
    });
  }

  private async baseModelId(): Promise<string> {
    return (await this.main.store.head()).modelId;
  }

  async modelIdOf(lineageId: string): Promise<string> {
    const base = await this.baseModelId();
    const row = (await this.registry.rows(base)).find((r) => r.lineage.id === lineageId);
    if (!row) throw new Error(`No copy ${lineageId} on ${base}`);
    return lineageModelId(base, row.lineage);
  }

  private async servedLineage(lineageId: string): Promise<ServedModel> {
    const served = await this.open(await this.modelIdOf(lineageId));
    if (!served) throw new Error(`Copy ${lineageId} can't be opened`);
    return served;
  }

  /** The chain of copies a model id is served under, nearest first (null: not a copy of this model). */
  async chainOf(modelId: string): Promise<readonly LineageRow[] | null> {
    const base = await this.baseModelId();
    const rows = await this.registry.rows(base);
    const row = modelId === base ? rows[0] : rows.find((r) => lineageModelId(base, r.lineage) === modelId);
    if (!row) return null;
    const byId = new Map(rows.map((r) => [r.lineage.id, r]));
    return lineageChain(lineageLookup(rows.map((r) => r.lineage)), row.lineage.id).flatMap((l) => byId.get(l.lineage.id) ?? []);
  }

  /** What `authorizeConnection` needs to decide a connection to `modelId` per copy (null: no such copy). */
  async connectionLineage(modelId: string, userId: string): Promise<ConnectionLineage | null> {
    const chain = await this.chainOf(modelId);
    if (!chain) return null;
    const responsible = this.lineageOptions.responsibleOn;
    return {
      chain,
      ...(responsible ? { responsibleOn: () => responsible({ userId, chain, changed: (id) => this.changedOn(id) }) } : {}),
    };
  }

  /** The records a copy changed since its fork, as it has them (removed ones as they were). */
  async changedOn(lineageId: string): Promise<readonly BimElement[]> {
    const served = await this.servedLineage(lineageId);
    const chain = await this.chainOf(await this.modelIdOf(lineageId));
    const pin = chain?.[0]?.lineage.parent?.revision ?? 0;
    const head = await served.store.head();
    const own = await served.store.changesSince(pin);
    const out = new Map<string, BimElement>();
    for (const cs of own) {
      for (const el of cs.elements) out.set(el.id, head.elements[el.id] ?? el);
      for (const id of cs.removedIds ?? []) {
        const before = cs.before?.[id];
        if (before) out.set(id, before);
      }
    }
    return [...out.values()];
  }

  /** A copy's line (its head and its history over its whole chain). */
  async line(lineageId: string): Promise<{ readonly head: () => Promise<ModelState>; readonly history: HistoryReader }> {
    const served = await this.servedLineage(lineageId);
    const chain = (await this.chainOf(await this.modelIdOf(lineageId))) ?? [];
    const readers = new Map<string, HistoryReader>();
    for (const link of chain) readers.set(link.lineage.id, storeHistory((await this.servedLineage(link.lineage.id)).store));
    return { head: () => served.store.head(), history: lineageHistory(chain, (id) => readers.get(id)) };
  }

  /** The hub for a model id: Main, an existing copy at any depth, or null ("No such model"). */
  async open(modelId: string): Promise<ServedModel | null> {
    const mainId = await this.baseModelId();
    if (modelId === mainId) return this.main;
    const pending = this.branches.get(modelId);
    if (pending) return pending;
    const ref = await this.registry.get(modelId);
    if (!ref || ref.baseModelId !== mainId) return null;
    const opening = this.openBranch(modelId);
    this.branches.set(modelId, opening);
    return opening;
  }

  /**
   * Drop a served copy and open it again, as a restarted server would (its own
   * changesets kept): it opens from its newest checkpoint and replays only
   * what came after.
   */
  async reopen(modelId: string): Promise<ServedModel | null> {
    const served = await this.branches.get(modelId);
    if (served) {
      const chain = await this.chainOf(modelId);
      const pin = chain?.[0]?.lineage.parent?.revision ?? 0;
      this.ownLog.set(modelId, await served.store.changesSince(pin));
      this.branches.delete(modelId);
    }
    return this.open(modelId);
  }

  /** Write a checkpoint of a served copy now (the host does it every `checkpointEvery` own revisions, off the commit path). */
  async checkpoint(modelId: string): Promise<boolean> {
    const store = this.lineageOptions.checkpoints;
    const served = await this.branches.get(modelId);
    const row = await this.registry.rowOf(modelId);
    if (!store || !served || !row?.lineage.parent) return false;
    const head = await served.store.head();
    const pin = row.lineage.parent.revision;
    await store.write(modelId, lineageCheckpointBody(row.lineage.id, pin, head, await served.store.changesSince(pin)));
    return true;
  }

  private async openBranch(modelId: string): Promise<ServedModel> {
    const ref = await this.registry.get(modelId);
    if (!ref) throw new Error(`Branch ${modelId} vanished while opening`);
    const chain = (await this.chainOf(modelId)) ?? [];
    const here = chain[0];
    const parentRow = chain[1];
    if (!here || !parentRow || !here.lineage.parent) throw new Error(`Copy ${modelId} has no parent copy`);
    const base = await this.baseModelId();
    const parent = await this.open(lineageModelId(base, parentRow.lineage));
    if (!parent) throw new Error(`The parent of copy ${modelId} can't be opened`);
    const pin = here.lineage.parent.revision;
    const parentHead = await parent.store.head();
    const fork = asBranchState(forkState(parentHead, pin, pin < parentHead.revision ? await parent.store.changesSince(pin) : []), modelId);
    const own = this.ownLog.get(modelId) ?? [];
    const checkpoint = this.lineageOptions.checkpoints && own.length > 0 ? await this.lineageOptions.checkpoints.latest(modelId, Math.max(...own.map((c) => c.revision))) : null;
    const opened = openLineageHead({ fork, checkpoint, own });
    // The copy's own changesets stay in its log, so a later reopen, undo or save still has them.
    const store = new InMemoryCommitStore(opened.model, own);
    const sequencer = await Sequencer.start(store);
    sequencer.onCommit(() => this.changed());
    sequencer.setWriteGate(() => {
      const state = this.registry.stateOf(modelId) ?? "closed";
      return branchAcceptsEdits(state) ? null : branchClosedMessage(state);
    });
    const parentHistory = (await this.line(parentRow.lineage.id)).history;
    const ownHistory = lineageHistory([{ lineage: { id: "own", parent: { lineageId: "parent", revision: pin } } }, { lineage: { id: "parent", parent: null } }], (id) => (id === "own" ? storeHistory(store) : parentHistory));
    const service = new BranchService({ modelId, registry: this.registry, history: ownHistory, main: parentHistory, branch: ref, head: () => sequencer.head() });
    this.registry.onChange((changed) => service.setCurrent(changed));
    const source = this.mergeSource;
    const merge = source
      ? mergeSessionHandler({
          source,
          sides: async () => ({ branch: service.current() ?? ref, mainHistory: parentHistory, branchHistory: ownHistory, branchHead: await sequencer.head() }),
          // In process, the admitted actor is the person and the host reads its records without a token. A merge lands on the parent: edit there, never edit here, decides.
          who: (_connectionId, principal) => ({ userId: principal.actorId, token: "", canEdit: principal.lineage ? (principal.lineage.rights.get(parentRow.lineage.id)?.has("edit") ?? false) : principal.canWrite }),
          lander: (actor) => sequencerLander({ sequencer: parent.sequencer, actor, branchModelId: modelId }),
          onAnswered: async (_msg, reply) => {
            if (reply.type === "merge_apply_result" && reply.allLanded) this.registry.markMerged(modelId);
          },
        })
      : null;
    const served: { host: InMemoryBranchHost | null } = { host: this };
    const lineages = InMemoryBranchHost.lineageService(base, here.lineage.id, this.registry, served, this.lineageOptions);
    const hub = new SyncHub(sequencer, { ...this.hubOptions, branches: service, lineages, ...(merge ? { merge } : {}) });
    const every = this.lineageOptions.checkpointEvery ?? LINEAGE_CHECKPOINT_EVERY;
    if (this.lineageOptions.checkpoints) {
      let last = opened.fromCheckpoint ?? pin;
      sequencer.onDurable((revision) => {
        if (revision - last < every) return;
        last = revision;
        // Off the commit path: the commit is already durable; a failed checkpoint is logged and retried at the next interval.
        this.checkpoint(modelId).catch((err) => console.error("[bim-sync] copy checkpoint failed; will try again at the next interval", { modelId, revision, err }));
      });
    }
    return { store, sequencer, hub, opened };
  }
}
