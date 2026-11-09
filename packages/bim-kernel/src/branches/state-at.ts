import type { Changeset } from "../changeset";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { ForkHistoryError } from "./fork";

/**
 * History reads for comparing versions (feature `history:revision_reads`):
 * what given elements were at a revision, and which elements changed between
 * two revisions. Both read only the changesets in the range and only the ids
 * asked for; never a whole-model diff.
 */

/** Ids each changeset touched: written or removed. */
export function changesetTouchedIds(cs: Changeset): readonly string[] {
  return cs.removedIds && cs.removedIds.length > 0 ? [...cs.elements.map((el) => el.id), ...cs.removedIds] : cs.elements.map((el) => el.id);
}

/**
 * The given elements as they were at `revision` (null: not present then),
 * from a later model and the changesets after `revision` up to it. The first
 * changeset after `revision` that touched an element recorded what it was.
 */
export function stateAt(model: ModelState, revision: number, after: readonly Changeset[], ids: readonly ElementId[]): Record<string, BimElement | null> {
  if (revision > model.revision) throw new ForkHistoryError(`Version ${revision} is newer than this model (it is at version ${model.revision}).`);
  const out: Record<string, BimElement | null> = {};
  const wanted = new Set<string>(ids);
  if (revision < model.revision) {
    const steps = after.filter((cs) => cs.revision > revision && cs.revision <= model.revision).sort((a, b) => a.revision - b.revision);
    if (steps.length !== model.revision - revision || steps.some((cs, i) => cs.revision !== revision + 1 + i)) {
      throw new ForkHistoryError(`The history back to version ${revision} is no longer kept, so it can't be compared.`);
    }
    for (const cs of steps) {
      if (wanted.size === 0) break;
      for (const id of changesetTouchedIds(cs)) {
        if (!wanted.has(id)) continue;
        const before = cs.before;
        if (!before || !(id in before)) throw new ForkHistoryError(`Version ${cs.revision} was saved by an older release that didn't record what it replaced, so it can't be compared before it.`);
        out[id] = before[id] ?? null;
        wanted.delete(id);
      }
    }
  }
  for (const id of wanted) out[id] = model.elements[id] ?? null;
  return out;
}

/** Ids touched by any changeset in (from, to], sorted. `changesets` may hold more; only the range counts. */
export function changedBetween(changesets: readonly Changeset[], from: number, to: number): ElementId[] {
  const ids = new Set<string>();
  for (const cs of changesets) {
    if (cs.revision <= from || cs.revision > to) continue;
    for (const id of changesetTouchedIds(cs)) ids.add(id);
  }
  return [...ids].sort().map(asElementId);
}

/**
 * Ids that may differ between Main at `mainRevision` and a branch head: what
 * Main changed after the branch's base, and what the branch changed since it
 * started. Each side's changesets are read only in its own range.
 */
export function changedMainVsBranch(input: {
  readonly baseRevision: number;
  readonly mainRevision: number;
  readonly mainChangesets: readonly Changeset[];
  readonly branchHead: number;
  readonly branchChangesets: readonly Changeset[];
}): ElementId[] {
  const lo = Math.min(input.baseRevision, input.mainRevision);
  const hi = Math.max(input.baseRevision, input.mainRevision);
  const ids = new Set<string>([...changedBetween(input.mainChangesets, lo, hi), ...changedBetween(input.branchChangesets, input.baseRevision, input.branchHead)]);
  return [...ids].sort().map(asElementId);
}
