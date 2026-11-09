import {
  asElementId,
  changedBetween,
  changedMainVsBranch,
  stateAt,
  type BimElement,
  type BranchRef,
  type Changeset,
  type ElementId,
  type ModelState,
} from "@permitzip/bim-kernel";
import { lineageHistory } from "../lineages/history";

/**
 * History reads one model's session answers (`state_at`, `changed_between`).
 * On a branch, revisions at or below its base are Main's, so they are read
 * from Main's history; the branch's own changesets start after its base.
 */
export interface HistoryReader {
  headRevision(): Promise<number>;
  /** The given elements at `revision` (null: not present then). */
  elementsAt(revision: number, ids: readonly string[]): Promise<Record<string, BimElement | null>>;
  /** Changesets with revision in (from, to]. */
  changesBetween(from: number, to: number): Promise<readonly Changeset[]>;
}

/** What a history reader needs from a commit store (InMemoryCommitStore, PostgresCommitStore). */
export interface HistorySource {
  head(): Promise<ModelState>;
  changesSince(revision: number): Promise<readonly Changeset[]>;
}

export function storeHistory(store: HistorySource): HistoryReader {
  return {
    async headRevision() {
      return (await store.head()).revision;
    },
    async elementsAt(revision, ids) {
      const head = await store.head();
      const after = revision < head.revision ? await store.changesSince(revision) : [];
      return stateAt(head, revision, after, ids.map(asElementId));
    },
    async changesBetween(from, to) {
      if (to <= from) return [];
      return (await store.changesSince(from)).filter((cs) => cs.revision <= to);
    },
  };
}

/**
 * A branch's history: its own changesets after its base, its base's at and
 * below it. A two-link lineage chain (round 11): the same code reads a copy
 * of a copy at any depth (`lineageHistory`).
 */
export function branchHistory(branch: Pick<BranchRef, "baseRevision">, own: HistorySource, main: HistoryReader): HistoryReader {
  const ownReader = storeHistory(own);
  const chain = [{ lineage: { id: "own", parent: { lineageId: "base", revision: branch.baseRevision } } }, { lineage: { id: "base", parent: null } }];
  return lineageHistory(chain, (id) => (id === "own" ? ownReader : main));
}

/** Ids touched in (from, to] on this history. */
export async function idsChangedBetween(history: HistoryReader, from: number, to: number): Promise<ElementId[]> {
  return changedBetween(await history.changesBetween(from, to), from, to);
}

/** Ids that may differ between Main at `mainRevision` and this branch's head. */
export async function idsChangedMainVsBranch(branch: Pick<BranchRef, "baseRevision">, own: HistoryReader, main: HistoryReader, mainRevision: number): Promise<ElementId[]> {
  const lo = Math.min(branch.baseRevision, mainRevision);
  const hi = Math.max(branch.baseRevision, mainRevision);
  const branchHead = await own.headRevision();
  const [mainChangesets, branchChangesets] = await Promise.all([main.changesBetween(lo, hi), own.changesBetween(branch.baseRevision, branchHead)]);
  return changedMainVsBranch({ baseRevision: branch.baseRevision, mainRevision, mainChangesets, branchHead, branchChangesets });
}
