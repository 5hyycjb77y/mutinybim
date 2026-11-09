import type { QuantityDelta } from "../graph/types";
import type { BimElement } from "../types";
import { quantityDeltasBetween, type QuantityDeltaOptions } from "./delta";
import { hostIdOf } from "./hosted";

/**
 * Quantity change between two revisions (or Main and a branch) from sparse
 * history reads (round 8b, lane O): the changed ids, then what they name
 * (host, type), read at both ends. Never a full diff, never a model scan.
 *
 * Why the reads are enough: a measure reads the element, its type (for its
 * classification) and, for a host, the elements it hosts. Every element a
 * host held at either end is either changed in the range (already read),
 * unchanged since then and so held by the host now (`hostedNow`, from the
 * head the caller has in memory), or changed after the range
 * (`laterChanged`, bounded by the edits since). Reading those keeps a
 * host's measure exact even where it isn't linear in what it holds (an
 * opening clipped by a shortened host).
 */

type Sparse = Readonly<Record<string, BimElement | null>>;

/** Reads the given ids at one end of the range (B's `state_at`). */
export type EndReader = (end: "from" | "to", ids: readonly string[]) => Promise<Sparse>;

export interface DeltaReads {
  readonly from: Sparse;
  readonly to: Sparse;
}

/** Most read rounds: changed ids, what they name, then those records' types. */
const MAX_ROUNDS = 3;

/** Ids an element names that its measure or grouping reads: its host and its type. */
export function deltaReferencedIds(el: BimElement | null | undefined): string[] {
  if (!el) return [];
  const out: string[] = [];
  const host = hostIdOf(el);
  if (host !== null) out.push(host);
  if ("typeId" in el && typeof el.typeId === "string" && el.typeId !== "") out.push(el.typeId);
  return out;
}

export interface DeltaReadOptions {
  /** What a host holds in the head the caller has in memory. */
  readonly hostedNow?: (hostId: string) => readonly string[];
  /** Ids changed after the range's later end, on the model whose head `hostedNow` reads. */
  readonly laterChanged?: readonly string[];
}

/** Everything `quantityDeltaFromReads` needs for `changedIds`, read in at most three bounded rounds. */
export async function readForQuantityDelta(changedIds: readonly string[], read: EndReader, options: DeltaReadOptions = {}): Promise<DeltaReads> {
  const { hostedNow, laterChanged = [] } = options;
  const from: Record<string, BimElement | null> = {};
  const to: Record<string, BimElement | null> = {};
  const seen = new Set<string>();
  let wanted = [...new Set(changedIds)];
  for (let round = 0; round < MAX_ROUNDS && wanted.length > 0; round++) {
    for (const id of wanted) seen.add(id);
    const [a, b] = await Promise.all([read("from", wanted), read("to", wanted)]);
    const next = new Set<string>();
    for (const id of wanted) {
      from[id] = a[id] ?? null;
      to[id] = b[id] ?? null;
      for (const ref of [...deltaReferencedIds(from[id]), ...deltaReferencedIds(to[id])]) if (!seen.has(ref)) next.add(ref);
    }
    if (round === 0) {
      const hosts = new Set<string>();
      for (const id of wanted) {
        for (const host of [hostIdOf(from[id] ?? undefined), hostIdOf(to[id] ?? undefined)]) if (host !== null) hosts.add(host);
        // A changed element may itself be a host whose held elements changed elsewhere.
        hosts.add(id);
      }
      if (hostedNow) for (const host of hosts) for (const held of hostedNow(host)) if (!seen.has(held)) next.add(held);
      if (hosts.size > 0) for (const id of laterChanged) if (!seen.has(id)) next.add(id);
    }
    wanted = [...next];
  }
  return { from, to };
}

function present(records: Sparse): Record<string, BimElement> {
  const out: Record<string, BimElement> = {};
  for (const [id, el] of Object.entries(records)) if (el) out[id] = el;
  return out;
}

/** The quantity deltas for `changedIds` from sparse reads at both ends. Equals `quantityDeltasBetween` over the full models. */
export function quantityDeltaFromReads(reads: DeltaReads, changedIds: readonly string[], options: QuantityDeltaOptions = {}): QuantityDelta[] {
  return quantityDeltasBetween(present(reads.from), present(reads.to), changedIds, options);
}
