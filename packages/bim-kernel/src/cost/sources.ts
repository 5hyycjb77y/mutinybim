import type { PackSet } from "../packs/set";
import { COST_SOURCE_POINT, type CostSourceDef } from "../qto/types";

/**
 * Cost sources (reserved, round 7): each party's price list, contributed by
 * that party's own host or add-on to `COST_SOURCE_POINT`. Prices are private
 * to the company that owns them and shared only by its choice (product owner
 * decision 4), so every read goes through the reader's party: a source is
 * visible to its owner, and to the parties it is shared with. Nothing here
 * writes to a model.
 */

/** The company reading, as its host names it (`CostParty.id`). */
export type ReaderParty = string;

/** Thrown when a reader asks for a source it may not see, or one that isn't there. */
export class CostAccessError extends Error {
  readonly sourceId: string;
  constructor(sourceId: string, message: string) {
    super(message);
    this.name = "CostAccessError";
    this.sourceId = sourceId;
  }
}

/** Whether `reader` may read this source's prices. */
export function canReadCostSource(source: CostSourceDef, reader: ReaderParty): boolean {
  if (reader === "") return false;
  if (source.party.id === reader) return true;
  const v = source.visibility;
  if (v.kind === "party_only") return false;
  if (v.kind === "shared_with") return v.parties.includes(reader);
  // A visibility a newer peer wrote that this release doesn't know: the safe reading is "owner only".
  console.error("[cost] a cost source has a visibility this release doesn't know; only its owner reads it", { sourceId: source.id });
  return false;
}

/**
 * Sources the reader's own host holds in its process only (a company's price
 * book fetched for this reader), offered beside the set's contributions. A
 * host binds a model's pack set for every reader, so a source that exists
 * only for one reader can't be a contribution; it still goes through the
 * same `canReadCostSource` check. A set's contribution wins an id clash.
 */
export type ReaderCostSources = readonly CostSourceDef[];

function candidates(set: PackSet, extra: ReaderCostSources): readonly CostSourceDef[] {
  const fromSet = set.packItems(COST_SOURCE_POINT);
  if (extra.length === 0) return fromSet;
  const ids = new Set(fromSet.map((s) => s.id));
  return [...fromSet, ...extra.filter((s) => !ids.has(s.id))];
}

/** The sources in a set (and the reader's own, if any) the reader may see. */
export function costSourcesFor(set: PackSet, reader: ReaderParty, extra: ReaderCostSources = []): readonly CostSourceDef[] {
  return candidates(set, extra).filter((s) => canReadCostSource(s, reader));
}

/** One source by id, if the reader may see it; otherwise a `CostAccessError` in words. */
export function costSourceFor(set: PackSet, sourceId: string, reader: ReaderParty, extra: ReaderCostSources = []): CostSourceDef {
  const source = candidates(set, extra).find((s) => s.id === sourceId);
  // The same words whether the source is missing or private: a reader learns nothing about another party's lists.
  if (!source || !canReadCostSource(source, reader)) throw new CostAccessError(sourceId, `There is no price list "${sourceId}" you can read on this model. Price lists are private to the company that owns them unless it shares them with you.`);
  return source;
}
