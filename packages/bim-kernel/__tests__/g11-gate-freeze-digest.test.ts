/**
 * @jest-environment node
 *
 * Round 11 G11 (D3): freezing a stage writes a gate: the copy and revision,
 * the state digest, the issued sets, sign-off seqs and dispositions it relied
 * on, and quantity totals by basis; the gate carries its own digest, and the
 * signed freeze payload names both. A stage's exit blockers refuse it. Fails
 * on round 10's code: there is no gate.
 */
import { signoffRecordHash, signoffFields, SIGNOFF_GENESIS, type BimElement } from "../src";
import { executeLifecycleCommand } from "../src/lifecycle/commands";
import { gateDigest, gatesOf, modelStateDigest } from "../src/lifecycle/freeze";
import { GATE_FROZEN_SIGNOFF_KIND, gateFreezeSignoffPayload } from "../src/lifecycle/gate-freeze";
import { isGateRecord, readGateBody, type GateElement } from "../src/lifecycle/records";
import { floor } from "./g7-fixtures";
import { allPeers, KS, lifecycle, wall, withElements } from "./g11-fixtures";

const AT = "2026-11-02T15:00:00Z";

function gate(m: { readonly elements: Readonly<Record<string, BimElement>> }, id: string): GateElement {
  const el: unknown = m.elements[id];
  if (!isGateRecord(el as BimElement)) throw new Error(`${id} isn't a gate`);
  return el as GateElement;
}

describe("g11 a freeze writes a gate with its digests", () => {
  it("records the revision, the state digest, what it relied on and totals by basis", () => {
    const m0 = floor("g11-freeze");
    const digest = modelStateDigest(m0);
    const m1 = lifecycle(m0, { type: "freeze_stage", gateId: "G-DD", stageId: "due_diligence", issuedSetRefs: ["set:DD-01"], signoffSeqs: [3, 4], dispositionIds: ["disp-1"], frozenBy: KS, frozenAt: AT });
    const g = gate(m1, "G-DD");
    expect(readGateBody(g.gate).ok).toBe(true);
    expect(g.gate).toMatchObject({ stageId: "due_diligence", stageSet: { id: "default", version: "1" }, lineageId: "main", revision: m0.revision, stateDigest: digest, issuedSetRefs: ["set:DD-01"], signoffSeqs: [3, 4], dispositionIds: ["disp-1"], frozenAt: AT });
    expect(g.digest).toBe(gateDigest(g.gate));
    const walls = g.gate.totals.quantities.lines.filter((l) => l.group === "class:arch.wall" && l.measure === "qto.length");
    expect(walls).toHaveLength(1);
    // Nothing on the floor records a basis, so every metre is "not recorded"; the split sums to the total.
    expect(walls[0]?.byBasis).toEqual({ not_recorded: walls[0]?.total });
    expect(g.gate.totals.costByBasis).toBeUndefined();
    // The model moved to the next stage.
    expect(m1.elements.stage_plan).toMatchObject({ kind: "stage_plan", plan: { currentStageId: "feasibility" } });
  });

  it("the state digest changes with any record; the signed payload names both digests in whole numbers", () => {
    const m0 = floor("g11-freeze-2");
    const moved = withElements(m0, [wall("W-12", 4000, 2000, 4100, 6000)]);
    expect(modelStateDigest(moved)).not.toBe(modelStateDigest(m0));
    const m1 = lifecycle(m0, { type: "freeze_stage", gateId: "G-1", stageId: "due_diligence", signoffSeqs: [7], frozenBy: KS, frozenAt: AT });
    const g = gate(m1, "G-1");
    const payload = gateFreezeSignoffPayload(g);
    expect(payload).toMatchObject({ v: 1, gate_id: "G-1", gate_digest: g.digest, state_digest: g.gate.stateDigest, stage_id: "due_diligence", lineage_id: "main", signoff_seqs: [7] });
    expect(typeof payload.totals_digest).toBe("string");
    // The chain hashes it (it throws on a payload number that isn't whole).
    expect(() => signoffRecordHash(SIGNOFF_GENESIS, signoffFields({ seq: 8, projectId: "p", baseModelId: m1.modelId, recordKind: GATE_FROZEN_SIGNOFF_KIND, subjectId: g.id, actorUserId: KS.subject, payload }))).not.toThrow();
    expect(gatesOf(m1.elements).map((x) => x.id)).toEqual(["G-1"]);
  });

  it("a gate is never rewritten, a host's checkpoint digest is kept, and an older server is refused", () => {
    const m0 = floor("g11-freeze-3");
    const m1 = lifecycle(m0, { type: "freeze_stage", gateId: "G-1", stageId: "due_diligence", stateDigest: "sha256:0123456789abcdef0123", frozenBy: KS, frozenAt: AT });
    expect(gate(m1, "G-1").gate.stateDigest).toBe("sha256:0123456789abcdef0123");
    const again = allPeers(() => executeLifecycleCommand(m1, { type: "freeze_stage", gateId: "G-1", stageId: "feasibility", frozenBy: KS, frozenAt: AT }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.message).toMatch(/a gate is never rewritten/);
    const old = executeLifecycleCommand(m0, { type: "freeze_stage", gateId: "G-2", stageId: "due_diligence", frozenBy: KS, frozenAt: AT });
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.error.message).toMatch(/older version/);
  });

  it("a stage's exit blockers keep it from being frozen until they are fixed or accepted", () => {
    const m0 = lifecycle(floor("g11-freeze-4"), { type: "set_stage_plan", stageSetId: "default", stageSetVersion: "1", currentStageId: "construction_documents" });
    const blocked = allPeers(() => executeLifecycleCommand(m0, { type: "freeze_stage", gateId: "G-CD", stageId: "construction_documents", frozenBy: KS, frozenAt: AT, openFindings: [{ id: "S104", severity: "blocking", sourceKind: "code_rule" }, { id: "S101", severity: "warning" }] }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.message).toBe("Construction documents can't be frozen yet: 1 open problem must be fixed or accepted first");
      expect(blocked.error.elementIds).toEqual(["S104"]);
    }
    const m1 = lifecycle(m0, { type: "freeze_stage", gateId: "G-CD", stageId: "construction_documents", frozenBy: KS, frozenAt: AT, dispositionIds: ["disp-S104"], openFindings: [{ id: "S101", severity: "warning" }] });
    expect(gate(m1, "G-CD").gate.dispositionIds).toEqual(["disp-S104"]);
  });
});
