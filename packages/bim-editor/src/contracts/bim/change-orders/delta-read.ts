import {
  deltaDigest,
  quantityDeltaFromReads,
  readForQuantityDelta,
  type BimElement,
  type ChangeTarget,
  type QuantityDelta,
} from "@permitzip/bim-kernel"
import { STATE_AT_MAX_IDS } from "@permitzip/bim-sync/branch-limits"

/**
 * The quantity change of a version range, or of this branch against Main,
 * read in the browser through lane B's history reads (`changed_between`,
 * `state_at`) and measured by the kernel. Quantities only: a price is added
 * only if the person picks their own company's book (lane C), in their
 * own browser.
 */

/** Lane B's two reads, as the model socket answers them. */
export interface HistoryReads {
  changedBetween(from: number | { readonly model: "main"; readonly revision: number | "head" }, to: number | "head"): Promise<readonly string[]>
  stateAt(revision: number | "head", ids: readonly string[], fromMain: boolean): Promise<Readonly<Record<string, BimElement | null>>>
}

export interface QuantityDeltaRead {
  readonly changedIds: readonly string[]
  readonly deltas: readonly QuantityDelta[]
  readonly digest: string
  /** The changed elements at the later end (removed ones at the earlier), for the coverage check. */
  readonly changedRecords: readonly BimElement[]
}

/** More changed elements than one comparison reads in the browser. */
export const DELTA_MAX_CHANGED = 20000

async function chunked(read: (ids: readonly string[]) => Promise<Readonly<Record<string, BimElement | null>>>, ids: readonly string[]) {
  const out: Record<string, BimElement | null> = {}
  for (let i = 0; i < ids.length; i += STATE_AT_MAX_IDS) Object.assign(out, await read(ids.slice(i, i + STATE_AT_MAX_IDS)))
  return out
}

export async function readQuantityDelta(
  reads: HistoryReads,
  target: ChangeTarget,
  input: { readonly head: number; readonly onBranch: boolean; readonly hostedNow?: (hostId: string) => readonly string[] },
): Promise<QuantityDeltaRead> {
  let changedIds: readonly string[]
  let laterChanged: readonly string[] = []
  let readEnd: (end: "from" | "to", ids: readonly string[]) => Promise<Readonly<Record<string, BimElement | null>>>
  if (target.kind === "version_range") {
    if (target.toRevision <= target.fromRevision) throw new Error("Pick an earlier version, then a later one.")
    changedIds = await reads.changedBetween(target.fromRevision, target.toRevision)
    if (target.toRevision < input.head) laterChanged = await reads.changedBetween(target.toRevision, "head")
    readEnd = (end, ids) => chunked((part) => reads.stateAt(end === "from" ? target.fromRevision : target.toRevision, part, false), ids)
  } else {
    if (!input.onBranch) throw new Error("Open the branch to see what it changes against Main.")
    changedIds = await reads.changedBetween({ model: "main", revision: "head" }, "head")
    readEnd = (end, ids) => chunked((part) => reads.stateAt("head", part, end === "from"), ids)
  }
  if (changedIds.length > DELTA_MAX_CHANGED) throw new Error(`${changedIds.length.toLocaleString("en-US")} elements changed, more than one comparison reads. Pick a shorter range.`)
  const both = await readForQuantityDelta(changedIds, readEnd, { hostedNow: input.hostedNow, laterChanged })
  const deltas = quantityDeltaFromReads(both, changedIds)
  const changedRecords: BimElement[] = []
  for (const id of changedIds) {
    const el = both.to[id] ?? both.from[id]
    if (el) changedRecords.push(el)
  }
  return { changedIds, deltas, digest: deltaDigest(deltas), changedRecords }
}
