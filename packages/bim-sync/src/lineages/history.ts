import { lineageSegments, type Lineage } from "@permitzip/bim-kernel/lineages";
import type { HistoryReader } from "../branches/history";

/**
 * A lineage's history over its parent chain, any depth (round 11 L11): the
 * same answer a branch session gives (`branchHistory`), generalised. Each
 * lineage of the chain answers the revisions it owns: those above the pin the
 * link below it forked from. Revisions at or below a pin are the parent's.
 */

/** A chain, nearest first, as `lineageChain` returns it (only ids and parents are read). */
export type HistoryChain = readonly { readonly lineage: Pick<Lineage, "id" | "parent"> }[];

/**
 * History for `chain[0]`'s line. `readerOf(id)` answers at least the
 * revisions that lineage owns (its own store's history, or its own line's).
 * Throws when a lineage of the chain has no reader.
 */
export function lineageHistory(chain: HistoryChain, readerOf: (lineageId: string) => HistoryReader | undefined): HistoryReader {
  const first = chain[0];
  if (!first) throw new Error("A copy's history needs at least the copy itself.");
  const reader = (id: string): HistoryReader => {
    const r = readerOf(id);
    if (!r) throw new Error(`No history is open for the copy "${id}" in this chain.`);
    return r;
  };
  const owner = (revision: number): string => {
    for (const link of chain) if (link.lineage.parent === null || revision > link.lineage.parent.revision) return link.lineage.id;
    return first.lineage.id;
  };
  return {
    headRevision: () => reader(first.lineage.id).headRevision(),
    elementsAt: (revision, ids) => reader(owner(revision)).elementsAt(revision, ids),
    async changesBetween(from, to) {
      if (to <= from) return [];
      const parts = await Promise.all(lineageSegments(chain, from, to).map((s) => reader(s.lineageId).changesBetween(s.from, s.to)));
      return parts.flat();
    },
  };
}
