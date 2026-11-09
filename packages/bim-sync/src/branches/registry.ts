import {
  branchModelId,
  readBranchState,
  UNSIGNED_PROVIDER_ID,
  type BranchRef,
  type BranchState,
  type SavedVersion,
} from "@permitzip/bim-kernel";
import {
  lineageModelId,
  readBranchAsLineage,
  rootLineageOf,
  type Lineage,
} from "@permitzip/bim-kernel/lineages";
import type { ChildLineageInput, ChildLineageRegistry } from "../lineages/registry";
import type { LineageEditScope, LineageRow } from "../lineages/rights";
import type { LineageStore } from "../lineages/service";

/**
 * Where a model server keeps its branches and saved versions. The Postgres
 * one is the model server's (services/bim-authority/src/pg-branches.ts); the
 * in-memory one serves tests and the development server. A standalone
 * MutinyBIM plugs in its own.
 */
export interface BranchRegistry {
  /** Branches of a base model, newest first. */
  list(baseModelId: string): Promise<readonly BranchRef[]>;
  /** One branch by its model id (`<base>~<branch>`), or null when there is none. */
  get(branchModelId: string): Promise<BranchRef | null>;
  /** Record a branch and pin the base's history at `baseRevision` against retention. O(1): nothing is copied. */
  create(input: { readonly baseModelId: string; readonly name: string; readonly baseRevision: number; readonly createdBy: string }): Promise<BranchRef>;
  /** Close an open branch (nothing reaches Main); releases its history pin. */
  close(branchModelId: string, closedBy: string): Promise<BranchRef>;
  versions(modelId: string): Promise<readonly SavedVersion[]>;
  /** Name a version; its history is kept until the version is deleted. */
  saveVersion(input: { readonly modelId: string; readonly revision: number; readonly name: string; readonly savedBy: string }): Promise<SavedVersion>;
  deleteVersion(modelId: string, versionId: string): Promise<void>;
}

/** A request the registry refused, in words a person can act on. */
export class BranchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchRefusal";
  }
}

export const BRANCH_NAME_TAKEN = "An open branch already has that name. Pick another name.";
export const NO_SUCH_BRANCH = "That branch no longer exists. Pick another from the Branch list.";
export const BRANCH_NOT_OPEN = "That branch is already closed or merged.";

let sequence = 0;
function shortId(): string {
  sequence += 1;
  return `${Date.now().toString(36)}${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A copy's row beyond its branch row (round 11): its parent copy, purpose and who edits it. A branch row with none reads as a round 8b proposal. */
export interface StoredLineageMeta {
  readonly parentLineageId: string;
  readonly role: Lineage["role"];
  readonly returnPolicy: Lineage["returnPolicy"];
  readonly editScope: LineageEditScope;
  readonly createdBy: Lineage["createdBy"];
  readonly owner?: Lineage["owner"];
  readonly terms?: Lineage["terms"];
}

/** The model's first copy when the host stores no row for it (the design). */
export function firstLineage(createdAt: string): Lineage {
  return rootLineageOf({ name: "Design", createdBy: { provider: UNSIGNED_PROVIDER_ID, subject: "model", kind: "person" }, createdAt });
}

/** A branch row (and its copy row, when it has one) read as a copy. */
export function lineageRowOf(ref: BranchRef, meta: StoredLineageMeta | undefined): LineageRow {
  const asBranch = readBranchAsLineage(ref);
  if (!meta) return { lineage: asBranch, editScope: "parent_editors" };
  return {
    lineage: {
      ...asBranch,
      parent: { lineageId: meta.parentLineageId, revision: ref.baseRevision },
      role: meta.role,
      returnPolicy: meta.returnPolicy,
      createdBy: meta.createdBy,
      ...(meta.owner ? { owner: meta.owner } : {}),
      ...(meta.terms ? { terms: meta.terms } : {}),
    },
    editScope: meta.editScope,
  };
}

/** Everything an in-memory registry holds, as plain data (JSON-safe). */
export interface InMemoryRegistrySnapshot {
  readonly branches: readonly BranchRef[];
  readonly meta: Readonly<Record<string, StoredLineageMeta>>;
  readonly pinnedOn: Readonly<Record<string, string>>;
  readonly saved: Readonly<Record<string, readonly SavedVersion[]>>;
  readonly pins: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** Reference registry: in memory; a host that wants it after a restart saves `snapshot()` and passes it back to the constructor. */
export class InMemoryBranchRegistry implements BranchRegistry, LineageStore, ChildLineageRegistry {
  private readonly branches = new Map<string, BranchRef>();
  /** Copy rows (round 11), by model id. */
  private readonly meta = new Map<string, StoredLineageMeta>();
  private readonly createdAt = new Date(0).toISOString();
  /** The model each copy's fork pin is on (its parent's). */
  private readonly pinnedOn = new Map<string, string>();
  private readonly saved = new Map<string, SavedVersion[]>();
  /** Revisions whose history is kept, per model: by branch or by saved version. */
  private readonly pins = new Map<string, Map<string, number>>();
  private readonly listeners = new Set<(ref: BranchRef) => void>();
  private readonly storedListeners = new Set<() => void>();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    restored?: InMemoryRegistrySnapshot,
  ) {
    if (!restored) return;
    for (const ref of restored.branches) this.branches.set(ref.modelId, ref);
    for (const [id, meta] of Object.entries(restored.meta)) this.meta.set(id, meta);
    for (const [id, on] of Object.entries(restored.pinnedOn)) this.pinnedOn.set(id, on);
    for (const [id, list] of Object.entries(restored.saved)) this.saved.set(id, [...list]);
    for (const [id, pins] of Object.entries(restored.pins)) this.pins.set(id, new Map(Object.entries(pins)));
  }

  snapshot(): InMemoryRegistrySnapshot {
    return {
      branches: [...this.branches.values()],
      meta: Object.fromEntries(this.meta),
      pinnedOn: Object.fromEntries(this.pinnedOn),
      saved: Object.fromEntries(this.saved),
      pins: Object.fromEntries([...this.pins].map(([id, map]) => [id, Object.fromEntries(map)])),
    };
  }

  /** The branch's state now, without a round trip (the write gate reads it inside each decision). */
  stateOf(branchModelId: string): BranchState | null {
    const ref = this.branches.get(branchModelId);
    return ref ? readBranchState(ref.state) : null;
  }

  onChange(listener: (ref: BranchRef) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called after anything this registry holds changes (a branch, a copy or a saved version): the cue for a host that saves `snapshot()`. */
  onStored(listener: () => void): () => void {
    this.storedListeners.add(listener);
    return () => this.storedListeners.delete(listener);
  }

  private stored(): void {
    for (const listener of this.storedListeners) listener();
  }

  /** Revisions pinned against retention on a model (lowest first). */
  pinnedRevisions(modelId: string): number[] {
    return [...(this.pins.get(modelId)?.values() ?? [])].sort((a, b) => a - b);
  }

  async list(baseModelId: string): Promise<readonly BranchRef[]> {
    return [...this.branches.values()].filter((b) => b.baseModelId === baseModelId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<BranchRef | null> {
    return this.branches.get(id) ?? null;
  }

  async create(input: { readonly baseModelId: string; readonly name: string; readonly baseRevision: number; readonly createdBy: string }): Promise<BranchRef> {
    return this.record({ ...input, pinOn: input.baseModelId }, null);
  }

  /** Every copy of a base: the first copy, then each branch row read as a copy (any depth). */
  async rows(baseModelId: string): Promise<readonly LineageRow[]> {
    const own = [...this.branches.values()].filter((b) => b.baseModelId === baseModelId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return [{ lineage: firstLineage(this.createdAt), editScope: "named" }, ...own.map((ref) => lineageRowOf(ref, this.meta.get(ref.modelId)))];
  }

  /** The copy row of one model id (a branch row reads as a proposal), or null. */
  async rowOf(modelId: string): Promise<LineageRow | null> {
    const ref = this.branches.get(modelId);
    return ref ? lineageRowOf(ref, this.meta.get(modelId)) : null;
  }

  /** A copy with a purpose (any parent, any depth), pinning its parent's line. */
  async createCopy(input: { readonly baseModelId: string; readonly lineage: Omit<Lineage, "id">; readonly editScope: LineageEditScope }): Promise<LineageRow> {
    const parent = input.lineage.parent;
    if (!parent) throw new BranchRefusal("A copy names the copy it starts from.");
    const parentRow = (await this.rows(input.baseModelId)).find((r) => r.lineage.id === parent.lineageId);
    if (!parentRow) throw new BranchRefusal(NO_SUCH_BRANCH);
    const ref = await this.record({ baseModelId: input.baseModelId, name: input.lineage.name, baseRevision: parent.revision, createdBy: input.lineage.createdBy.subject, pinOn: lineageModelId(input.baseModelId, parentRow.lineage) }, {
      parentLineageId: parent.lineageId,
      role: input.lineage.role,
      returnPolicy: input.lineage.returnPolicy,
      editScope: input.editScope,
      createdBy: input.lineage.createdBy,
      ...(input.lineage.owner ? { owner: input.lineage.owner } : {}),
      ...(input.lineage.terms ? { terms: input.lineage.terms } : {}),
    });
    return lineageRowOf(ref, this.meta.get(ref.modelId));
  }

  /** `branch_create` on a branch session: a proposal copy of that copy, edited as a round 8b branch is (by its parent's editors). */
  async createChild(input: ChildLineageInput): Promise<BranchRef> {
    const row = await this.createCopy({
      baseModelId: input.parent.baseModelId,
      lineage: { ...readBranchAsLineage({ ...input.parent, name: input.name, baseRevision: input.baseRevision, createdBy: input.createdBy, state: "open" }), parent: { lineageId: input.parent.branchId, revision: input.baseRevision } },
      editScope: "parent_editors",
    });
    const ref = this.branches.get(lineageModelId(input.parent.baseModelId, row.lineage));
    if (!ref) throw new BranchRefusal(NO_SUCH_BRANCH);
    return ref;
  }

  private async record(input: { readonly baseModelId: string; readonly name: string; readonly baseRevision: number; readonly createdBy: string; readonly pinOn: string }, meta: StoredLineageMeta | null): Promise<BranchRef> {
    const taken = [...this.branches.values()].some((b) => b.baseModelId === input.baseModelId && b.name === input.name && (b.state === "open" || b.state === "merge_proposed"));
    if (taken) throw new BranchRefusal(BRANCH_NAME_TAKEN);
    const branchId = shortId();
    const ref: BranchRef = {
      branchId,
      modelId: branchModelId(input.baseModelId, branchId),
      baseModelId: input.baseModelId,
      baseRevision: input.baseRevision,
      name: input.name,
      createdBy: input.createdBy,
      createdAt: this.now(),
      state: "open",
    };
    this.branches.set(ref.modelId, ref);
    if (meta) this.meta.set(ref.modelId, meta);
    this.pin(input.pinOn, `branch:${ref.modelId}`, input.baseRevision);
    this.pinnedOn.set(ref.modelId, input.pinOn);
    this.emit(ref);
    return ref;
  }

  async close(id: string): Promise<BranchRef> {
    const ref = this.branches.get(id);
    if (!ref) throw new BranchRefusal(NO_SUCH_BRANCH);
    if (ref.state !== "open" && ref.state !== "merge_proposed") throw new BranchRefusal(BRANCH_NOT_OPEN);
    const closed: BranchRef = { ...ref, state: "closed" };
    this.branches.set(id, closed);
    this.pins.get(this.pinnedOn.get(id) ?? ref.baseModelId)?.delete(`branch:${id}`);
    this.emit(closed);
    return closed;
  }

  /** Lane M's merge marks a branch merged; exposed here so the write gate can be proven. */
  markMerged(id: string): BranchRef {
    const ref = this.branches.get(id);
    if (!ref) throw new BranchRefusal(NO_SUCH_BRANCH);
    const merged: BranchRef = { ...ref, state: "merged" };
    this.branches.set(id, merged);
    this.pins.get(this.pinnedOn.get(id) ?? ref.baseModelId)?.delete(`branch:${id}`);
    this.emit(merged);
    return merged;
  }

  async versions(modelId: string): Promise<readonly SavedVersion[]> {
    return [...(this.saved.get(modelId) ?? [])].sort((a, b) => b.revision - a.revision);
  }

  async saveVersion(input: { readonly modelId: string; readonly revision: number; readonly name: string; readonly savedBy: string }): Promise<SavedVersion> {
    const version: SavedVersion = { versionId: shortId(), modelId: input.modelId, revision: input.revision, name: input.name, savedBy: input.savedBy, savedAt: this.now() };
    this.saved.set(input.modelId, [...(this.saved.get(input.modelId) ?? []), version]);
    this.pin(input.modelId, `version:${version.versionId}`, input.revision);
    this.stored();
    return version;
  }

  async deleteVersion(modelId: string, versionId: string): Promise<void> {
    const list = this.saved.get(modelId) ?? [];
    if (!list.some((v) => v.versionId === versionId)) throw new BranchRefusal("That version was already deleted.");
    this.saved.set(modelId, list.filter((v) => v.versionId !== versionId));
    this.pins.get(modelId)?.delete(`version:${versionId}`);
    this.stored();
  }

  private pin(modelId: string, by: string, revision: number): void {
    const map = this.pins.get(modelId) ?? new Map<string, number>();
    map.set(by, revision);
    this.pins.set(modelId, map);
  }

  private emit(ref: BranchRef): void {
    for (const listener of this.listeners) listener(ref);
    this.stored();
  }
}
