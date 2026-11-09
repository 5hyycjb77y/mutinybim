import { canonicalize, sha256HexOf } from "../authorship/canonical";
import type { SignoffJson } from "../responsibility/signoff-chain";
import type { GateElement } from "./records";

/**
 * The gate-freeze event on the sign-off chain (round 11 D3; wave 1 keeps it
 * in this file, and the coordinator adds the kind to `SIGNOFF_KINDS`).
 *
 * A freeze is a signed act: who froze which stage of which copy at which
 * revision, over which state and gate digests, relying on which sign-offs
 * and dispositions. Payload numbers are whole numbers only (the chain's
 * rule), so quantity totals ride as their digest, never as numbers.
 */

/** The sign-off record kind of a freeze. */
export const GATE_FROZEN_SIGNOFF_KIND = "gate_frozen";

/** `sha256:<hex>` over a gate's totals, for the signed payload. */
export function gateTotalsDigest(gate: GateElement): string {
  return `sha256:${sha256HexOf(canonicalize(gate.gate.totals))}`;
}

/** The signed payload of freezing `gate` (subject: the gate id). Stored forever: names and shape are fixed. */
export function gateFreezeSignoffPayload(gate: GateElement): { readonly [key: string]: SignoffJson } {
  const g = gate.gate;
  return {
    v: 1,
    gate_id: gate.id,
    gate_digest: gate.digest,
    stage_id: g.stageId,
    stage_set: { id: g.stageSet.id, version: g.stageSet.version },
    purpose: g.purpose,
    lineage_id: g.lineageId,
    revision: g.revision,
    state_digest: g.stateDigest,
    issued_set_refs: [...g.issuedSetRefs],
    signoff_seqs: [...g.signoffSeqs],
    disposition_ids: [...g.dispositionIds],
    totals_digest: gateTotalsDigest(gate),
    frozen_at: g.frozenAt,
  };
}
