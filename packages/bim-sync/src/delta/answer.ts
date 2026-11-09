import { ForkHistoryError, deltaDigest, quantityDeltaFromReads, readForQuantityDelta, type BranchRef, type EndReader } from "@permitzip/bim-kernel";
import { idsChangedBetween, idsChangedMainVsBranch, type HistoryReader } from "../branches/history";
import { QUANTITY_DELTA_MAX_CHANGED, QUANTITY_DELTA_WORDS, quantityDeltaRequestSchema, type QuantityDeltaServerMessage } from "./messages";

/** What one session answers a delta read from (lane B's readers). */
export interface QuantityDeltaDeps {
  /** This session's model history (on a branch: `branchHistory`). */
  readonly history: HistoryReader;
  /** On a branch: Main's history. */
  readonly main?: HistoryReader;
  /** On a branch: its record. */
  readonly branch?: Pick<BranchRef, "baseRevision"> | null;
  /** What a host holds in this model's head, when the server has it in memory. */
  readonly hostedNow?: (hostId: string) => readonly string[];
}

/** Answers one `quantity_delta` message, or null when `raw` isn't one. */
export async function answerQuantityDelta(raw: unknown, deps: QuantityDeltaDeps): Promise<QuantityDeltaServerMessage | null> {
  const parsed = quantityDeltaRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const msg = parsed.data;
  const { requestId } = msg;
  const refuse = (reason: string): QuantityDeltaServerMessage => ({ type: "quantity_delta_refused", requestId, reason });
  try {
    const toRevision = msg.to === "head" ? await deps.history.headRevision() : msg.to;
    let fromRevision: number;
    let fromMain = false;
    let changed: string[];
    let read: EndReader;
    let laterChanged: readonly string[] = [];
    if (typeof msg.from === "number") {
      fromRevision = msg.from;
      if (fromRevision > toRevision) return refuse(QUANTITY_DELTA_WORDS.backwards);
      changed = await idsChangedBetween(deps.history, fromRevision, toRevision);
      read = (end, ids) => deps.history.elementsAt(end === "from" ? fromRevision : toRevision, ids);
      const head = await deps.history.headRevision();
      if (toRevision < head) laterChanged = await idsChangedBetween(deps.history, toRevision, head);
    } else {
      const main = deps.main;
      const branch = deps.branch;
      if (!main || !branch) return refuse(QUANTITY_DELTA_WORDS.notOnBranch);
      fromMain = true;
      fromRevision = msg.from.revision === "head" ? await main.headRevision() : msg.from.revision;
      changed = await idsChangedMainVsBranch(branch, deps.history, main, fromRevision);
      read = (end, ids) => (end === "from" ? main.elementsAt(fromRevision, ids) : deps.history.elementsAt(toRevision, ids));
    }
    if (changed.length > QUANTITY_DELTA_MAX_CHANGED) return refuse(QUANTITY_DELTA_WORDS.tooMany(changed.length));
    // Main vs a branch: an element either end holds unchanged on both sides is in the branch head, which `hostedNow` reads.
    const reads = await readForQuantityDelta(changed, read, { hostedNow: deps.hostedNow, laterChanged });
    const deltas = quantityDeltaFromReads(reads, changed, { system: msg.system, all: msg.all });
    return { type: "quantity_delta_result", requestId, fromRevision, fromMain, toRevision, changedCount: changed.length, deltas, digest: deltaDigest(deltas) };
  } catch (err) {
    if (err instanceof ForkHistoryError) return refuse(err.message);
    console.error("[bim-sync] quantity delta failed", { requestId, err });
    return refuse(QUANTITY_DELTA_WORDS.failed);
  }
}
