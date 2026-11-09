/**
 * @jest-environment node
 *
 * Round 11 G11 (product owner question 6, pending): freezing occupancy *offers* the
 * operations copy as data; nothing in the kernel forks on freeze. The
 * command writes the gate and the stage plan and nothing else. Fails on
 * round 10's code: no stages, no freeze.
 */
import { executeLifecycleCommand } from "../src/lifecycle/commands";
import { freezeGate } from "../src/lifecycle/freeze";
import { DEFAULT_STAGE_ROWS } from "../src/lifecycle/stages";
import { floor } from "./g7-fixtures";
import { allPeers, KS, lifecycle } from "./g11-fixtures";

const AT = "2026-11-02T15:00:00Z";

describe("g11 freezing never forks", () => {
  it("occupancy offers an operations copy as data only", () => {
    const m0 = lifecycle(floor("g11-fork"), { type: "set_stage_plan", stageSetId: "default", stageSetVersion: "1", currentStageId: "occupancy" });
    expect(DEFAULT_STAGE_ROWS.find((s) => s.id === "occupancy")?.onFreeze).toEqual({ offerLineageRole: "operations" });
    const out = freezeGate(m0, { stageId: "occupancy", frozenBy: KS, frozenAt: AT });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.offer).toEqual({ lineageRole: "operations" });
      expect(out.next?.id).toBe("operations");
    }
    const r = allPeers(() => executeLifecycleCommand(m0, { type: "freeze_stage", gateId: "G-CO", stageId: "occupancy", frozenBy: KS, frozenAt: AT }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Exactly the gate and the plan; no lineage, branch or copy record appears, and nothing else changes.
    expect([...r.changedIds].sort()).toEqual(["G-CO", "stage_plan"]);
    expect(r.removedIds).toEqual([]);
    const added = Object.keys(r.model.elements).filter((id) => !(id in m0.elements));
    expect(added).toEqual(["G-CO"]);
    for (const id of Object.keys(m0.elements)) if (id !== "stage_plan") expect(r.model.elements[id]).toBe(m0.elements[id]);
  });

  it("a stage with no offer returns none", () => {
    const out = freezeGate(floor("g11-fork-2"), { stageId: "due_diligence", frozenBy: KS, frozenAt: AT });
    expect(out.ok && out.offer).toBe(undefined);
  });
});
