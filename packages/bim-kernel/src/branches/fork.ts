import type { Changeset } from "../changeset";
import { nextConnections } from "../command-core";
import { draftElements, freezeElements } from "../store";
import { asRevision, type ModelState } from "../types";

/**
 * Forking is a pin, not a copy. A branch from the head shares the head as it
 * is; a branch from an older version reverts only the changesets after that
 * version, on the chunked element store, so every element those changesets did
 * not touch is the same object in Main and in the branch.
 */

/** The history needed to rebuild a version is gone, or older than this release records. */
export class ForkHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkHistoryError";
  }
}

/**
 * The model as it was at `revision`, from a later model and every changeset
 * after `revision` up to it (`after`, any order). Throws ForkHistoryError when
 * a changeset is missing or carries no `before` record.
 */
export function forkState(model: ModelState, revision: number, after: readonly Changeset[]): ModelState {
  const steps = forkSteps(model.revision, revision, after);
  if (steps.length === 0) return model;
  const draft = draftElements(model.elements);
  let connections = model.connections;
  for (const cs of steps) {
    const before = cs.before ?? {};
    for (const id of [...cs.elements.map((el) => el.id), ...(cs.removedIds ?? [])]) {
      const prior = before[id];
      if (prior) draft[id] = prior;
      else delete draft[id];
    }
    connections = nextConnections(connections, { removedConnections: cs.addedConnections, addedConnections: cs.removedConnections });
  }
  return { ...model, revision: asRevision(revision), elements: freezeElements(draft), connections };
}

/**
 * The changesets a fork at `revision` reverts, newest first, after checking
 * that each is kept and recorded what it replaced. Throws ForkHistoryError in
 * words a person can act on. Reads only the changesets in the range.
 */
export function forkSteps(headRevision: number, revision: number, after: readonly Changeset[]): Changeset[] {
  if (!Number.isInteger(revision) || revision < 0) throw new ForkHistoryError(`Version ${revision} is not a saved version of this model.`);
  if (revision > headRevision) throw new ForkHistoryError(`Version ${revision} is newer than this model (it is at version ${headRevision}).`);
  const steps = after.filter((cs) => cs.revision > revision && cs.revision <= headRevision).sort((a, b) => b.revision - a.revision);
  if (steps.length !== headRevision - revision || steps.some((cs, i) => cs.revision !== headRevision - i)) {
    throw new ForkHistoryError(`The history back to version ${revision} is no longer kept, so a branch can't start there. Pick a newer or a saved version.`);
  }
  for (const cs of steps) {
    const before = cs.before;
    const recorded = before !== undefined && [...cs.elements.map((el) => el.id), ...(cs.removedIds ?? [])].every((id) => id in before);
    if (!recorded) throw new ForkHistoryError(`Version ${cs.revision} was saved by an older release that didn't record what it replaced, so a branch can't start before it. Pick version ${cs.revision} or newer.`);
  }
  return steps;
}

/** The model at `revision`, replayed forward from an earlier copy (a checkpoint) through the changesets after it. */
export function replayTo(start: ModelState, revision: number, forward: readonly Changeset[], apply: (model: ModelState, cs: Changeset) => ModelState): ModelState {
  if (revision < start.revision) throw new ForkHistoryError(`Version ${revision} is older than the saved copy it would start from.`);
  let model = start;
  for (const cs of [...forward].sort((a, b) => a.revision - b.revision)) {
    if (cs.revision <= model.revision) continue;
    if (cs.revision > revision) break;
    model = apply(model, cs);
  }
  if (model.revision !== revision) throw new ForkHistoryError(`The history up to version ${revision} is no longer kept, so a branch can't start there.`);
  return model;
}

/** A fork's state under the branch's own model id. */
export function asBranchState(state: ModelState, branchModelId: string): ModelState {
  return state.modelId === branchModelId ? state : { ...state, modelId: branchModelId };
}
