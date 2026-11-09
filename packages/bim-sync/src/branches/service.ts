import { ForkHistoryError, branchModelId, forkSteps, parseBranchModelId, type BranchRef, type ModelState } from "@permitzip/bim-kernel";
import { lineageChain, lineageLookup, lineageModelId } from "@permitzip/bim-kernel/lineages";
import { answerCoverage, COVERAGE_WORDS, CoverageRefusal } from "./coverage";
import { BRANCH_EDIT_REQUIRED, type BranchClientMessage, type BranchServerMessage } from "./protocol";
import { idsChangedBetween, idsChangedMainVsBranch, type HistoryReader } from "./history";
import { BranchRefusal, type BranchRegistry } from "./registry";
import { createChildLineage } from "../lineages/registry";
import type { PrincipalLineage } from "../authorization";
import { lineageAsBranchRef } from "../lineages/protocol";
import { LINEAGE_RIGHTS_WORDS, rightsOn, type LineageRow } from "../lineages/rights";
import type { LineageStore } from "../lineages/service";

/** Who is asking (the hub's principal for the connection). */
export interface BranchCaller {
  readonly actorId: string;
  readonly canWrite: boolean;
  /** Round 11 (W11): the caller's rights per copy; with it, lists show only copies they can read and closing a copy needs edit on it. */
  readonly lineage?: PrincipalLineage;
}

export interface BranchServiceOptions {
  /** The model this hub serves: Main's id, or a branch's `<base>~<branch>` id. */
  readonly modelId: string;
  readonly registry: BranchRegistry;
  /** This model's history (on a branch: `branchHistory`). */
  readonly history: HistoryReader;
  /** On a branch: Main's history, for "compare with Main". */
  readonly main?: HistoryReader;
  /** On a branch: its record as loaded. */
  readonly branch?: BranchRef | null;
  /** The model as it stands (round 9 `coverage_check` reads classes, systems and sheets from it). Absent: coverage isn't served. */
  readonly head?: () => Promise<ModelState>;
}

/** Round 8b words, no longer said by this service (a branch session makes a copy of itself, round 11); kept for callers that still read it. */
export const START_BRANCH_FROM_MAIN = "Branches start from Main. Switch back to Main, then start a new branch.";
export const NOT_ON_A_BRANCH = "This session is on Main, so there is no Main to compare with. Open a branch first.";
const REQUEST_FAILED = "The model server couldn't do that just now; see its log. Try again.";
const NO_SUCH_COPY = "That copy no longer exists. Pick another from the list.";

function isLineageStore(registry: BranchRegistry): registry is BranchRegistry & LineageStore {
  return typeof Reflect.get(registry, "rows") === "function" && typeof Reflect.get(registry, "createCopy") === "function";
}

/**
 * Answers branch and history requests for one hub. Creating or closing a
 * branch needs model editing access; listing and reading need only the read
 * access every connection already passed.
 */
export class BranchService {
  private branch: BranchRef | null;
  readonly baseModelId: string;

  constructor(private readonly opts: BranchServiceOptions) {
    this.branch = opts.branch ?? null;
    this.baseModelId = parseBranchModelId(opts.modelId)?.baseModelId ?? opts.modelId;
  }

  /** This service answers `coverage_check` (its host gave it the model's head). */
  servesCoverage(): boolean {
    return this.opts.head !== undefined;
  }

  /** The branch this hub serves (null on Main). */
  current(): BranchRef | null {
    return this.branch;
  }

  private readonly stateListeners = new Set<(ref: BranchRef) => void>();

  /** The branch's record changed elsewhere (closed, merged). Listeners hear only a change of state. */
  setCurrent(ref: BranchRef): void {
    const prior = this.branch;
    if (!prior || ref.modelId !== prior.modelId) return;
    this.branch = ref;
    if (prior.state === ref.state) return;
    for (const listener of this.stateListeners) {
      try {
        listener(ref);
      } catch (err) {
        console.error("[bim-sync] a branch state listener failed", { modelId: ref.modelId, state: ref.state, err });
      }
    }
  }

  /** Called once per change of this branch's state (the hub tells its connections). */
  onStateChange(listener: (ref: BranchRef) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async handle(msg: BranchClientMessage, who: BranchCaller): Promise<BranchServerMessage> {
    const { requestId } = msg;
    try {
      return await this.answer(msg, who);
    } catch (err) {
      if (err instanceof BranchRefusal || err instanceof ForkHistoryError || err instanceof CoverageRefusal) return { type: "request_refused", requestId, reason: err.message };
      console.error("[bim-sync] branch request failed", { type: msg.type, modelId: this.opts.modelId, err });
      return { type: "request_refused", requestId, reason: REQUEST_FAILED };
    }
  }

  private async answer(msg: BranchClientMessage, who: BranchCaller): Promise<BranchServerMessage> {
    const { requestId } = msg;
    const registry = this.opts.registry;
    switch (msg.type) {
      case "branch_list":
        return { type: "branches", requestId, branches: who.lineage && isLineageStore(registry) ? await this.readableBranches(registry, who.lineage) : await registry.list(this.baseModelId) };
      case "branch_create": {
        if (!who.canWrite) throw new BranchRefusal(BRANCH_EDIT_REQUIRED);
        const head = await this.opts.history.headRevision();
        const from = msg.fromRevision ?? head;
        if (from < head) forkSteps(head, from, await this.opts.history.changesBetween(from, head));
        else if (from > head) throw new BranchRefusal(`Version ${from} is newer than this model (it is at version ${head}).`);
        // Round 11 (L11): any copy can be a parent; a branch session makes a copy of itself.
        const branch = this.branch ? await createChildLineage(registry, { parent: this.branch, name: msg.name, baseRevision: from, createdBy: who.actorId }) : await registry.create({ baseModelId: this.baseModelId, name: msg.name, baseRevision: from, createdBy: who.actorId });
        return { type: "branch_saved", requestId, branch };
      }
      case "branch_close": {
        if (!who.canWrite && !who.lineage) throw new BranchRefusal(BRANCH_EDIT_REQUIRED);
        const id = branchModelId(this.baseModelId, msg.branchId);
        if (who.lineage && isLineageStore(registry)) await this.requireEditOn(registry, who.lineage, msg.branchId);
        const branch = await registry.close(id, who.actorId);
        this.setCurrent(branch);
        return { type: "branch_saved", requestId, branch };
      }
      case "version_list":
        return { type: "versions", requestId, head: await this.opts.history.headRevision(), versions: await registry.versions(this.opts.modelId) };
      case "version_save": {
        if (!who.canWrite) throw new BranchRefusal("You can view this model but not save versions. Ask a project admin for model editing access.");
        const head = await this.opts.history.headRevision();
        const revision = msg.revision ?? head;
        if (revision > head) throw new BranchRefusal(`Version ${revision} is newer than this model (it is at version ${head}).`);
        return { type: "version_saved", requestId, version: await registry.saveVersion({ modelId: this.opts.modelId, revision, name: msg.name, savedBy: who.actorId }) };
      }
      case "version_delete": {
        if (!who.canWrite) throw new BranchRefusal("You can view this model but not delete versions. Ask a project admin for model editing access.");
        await registry.deleteVersion(this.opts.modelId, msg.versionId);
        return { type: "version_deleted", requestId, versionId: msg.versionId };
      }
      case "state_at": {
        const history = msg.model === "main" ? this.mainHistory() : this.opts.history;
        const at = msg.revision === "head" ? await history.headRevision() : msg.revision;
        return { type: "state_at_result", requestId, revision: at, elements: await history.elementsAt(at, msg.ids) };
      }
      case "changed_between": {
        const to = msg.to === "head" ? await this.opts.history.headRevision() : msg.to;
        if (typeof msg.from === "number") return { type: "changed_between_result", requestId, ids: await idsChangedBetween(this.opts.history, msg.from, to), truncated: false };
        const branch = this.branch;
        if (!branch) throw new BranchRefusal(NOT_ON_A_BRANCH);
        const main = this.mainHistory();
        const mainRevision = msg.from.revision === "head" ? await main.headRevision() : msg.from.revision;
        const ids = await idsChangedMainVsBranch(branch, this.opts.history, main, mainRevision);
        return { type: "changed_between_result", requestId, ids, truncated: false };
      }
      case "coverage_check": {
        const head = this.opts.head;
        if (!head) throw new CoverageRefusal(COVERAGE_WORDS.unavailable);
        return answerCoverage(msg, { history: this.opts.history, main: this.opts.main ?? null, branch: this.branch, head });
      }
    }
  }

  /** Copies whose parent is the first copy, that the caller can read, in their branch form (`branch_list` for every page). */
  private async readableBranches(store: LineageStore, lineage: PrincipalLineage): Promise<BranchRef[]> {
    const rows = await store.rows(this.baseModelId);
    const byId = new Map(rows.map((r) => [r.lineage.id, r]));
    const lookup = lineageLookup(rows.map((r) => r.lineage));
    const out: { ref: BranchRef; at: string }[] = [];
    for (const row of rows) {
      const parent = row.lineage.parent ? byId.get(row.lineage.parent.lineageId) : undefined;
      const ref = lineageAsBranchRef(this.baseModelId, row.lineage, parent?.lineage);
      if (!ref) continue;
      const chain = lineageChain(lookup, row.lineage.id).flatMap((l) => byId.get(l.lineage.id) ?? []);
      if (!rightsOn(lineage.rightsOf(chain), row.lineage.id).has("read")) continue;
      const stored = await this.opts.registry.get(lineageModelId(this.baseModelId, row.lineage));
      out.push({ ref: stored ?? ref, at: row.lineage.createdAt });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).map((o) => o.ref);
  }

  private async requireEditOn(store: LineageStore, lineage: PrincipalLineage, lineageId: string): Promise<void> {
    const rows = await store.rows(this.baseModelId);
    const byId = new Map(rows.map((r) => [r.lineage.id, r]));
    if (!byId.has(lineageId)) throw new BranchRefusal(NO_SUCH_COPY);
    const chain: LineageRow[] = lineageChain(lineageLookup(rows.map((r) => r.lineage)), lineageId).flatMap((l) => byId.get(l.lineage.id) ?? []);
    if (!rightsOn(lineage.rightsOf(chain), lineageId).has("edit")) throw new BranchRefusal(LINEAGE_RIGHTS_WORDS.noEdit);
  }

  private mainHistory(): HistoryReader {
    if (!this.branch || !this.opts.main) throw new BranchRefusal(NOT_ON_A_BRANCH);
    return this.opts.main;
  }
}
