import { performance } from "node:perf_hooks";
import { answerQuantityDelta, type QuantityDeltaDeps, type QuantityDeltaServerMessage } from "@permitzip/bim-sync";

/**
 * One `quantity_delta` read on a session, answered (round 8b, lane O). Lane
 * B's session wiring (`server.ts` / `hub.ts`) calls this with the same
 * history readers it gives `BranchService` (this model's, Main's on a
 * branch, and the branch record) and sends the reply. Reading needs only
 * the read access every connection already passed. Quantities only: no
 * price is read, computed or stored here.
 */
export async function handleQuantityDeltaMessage(raw: unknown, deps: QuantityDeltaDeps, modelId: string): Promise<QuantityDeltaServerMessage | null> {
  const t0 = performance.now();
  const out = await answerQuantityDelta(raw, deps);
  if (out?.type === "quantity_delta_result") {
    console.log("[bim-authority] quantity delta read", {
      modelId,
      fromRevision: out.fromRevision,
      fromMain: out.fromMain,
      toRevision: out.toRevision,
      changed: out.changedCount,
      rows: out.deltas.length,
      ms: Math.round(performance.now() - t0),
    });
  }
  return out;
}
