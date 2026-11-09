/**
 * @jest-environment node
 *
 * Round 11 G11 (product owner answer 5): each firm defines its own stages, ours are
 * the default rows a firm copies, reorders or replaces. A model records the
 * list and version it uses, and reads that list. Fails on round 10's code:
 * no stage list, no stage plan record.
 */
import { DEFAULT_SETTINGS, type ModelState } from "../src";
import { contribute, PackSet, withPackSet } from "../src/packs";
import { currentStageOf } from "../src/lifecycle/current";
import { STAGE_PLAN_ID, stagePlanOf } from "../src/lifecycle/records";
import { STAGE_SET_POINT, copyStageSet, defaultStageSet, resolveStageSet, stageProblems } from "../src/lifecycle/stages";
import { allPeers, KS, lifecycle } from "./g11-fixtures";
import { executeLifecycleCommand } from "../src/lifecycle/commands";

const empty = (modelId: string): ModelState => ({ modelId, revision: 1 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });

const base = defaultStageSet(PackSet.create([]));
const ACME = copyStageSet(base, {
  id: "firm:acme",
  version: "2026-11",
  label: "Acme stages",
  order: ["feasibility", "schematic_design", "design_development", "construction_documents", "permit", "construction", "occupancy"],
  replace: [{ id: "permit", label: "Permit and plan check", order: 0, exitBlockers: { severity: ["blocking", "warning"] } }],
});
const FIRM = PackSet.create([], { firm: [contribute(STAGE_SET_POINT, [ACME])] });

describe("g11 a firm's own stage list", () => {
  it("copies, reorders and replaces the defaults", () => {
    expect(ACME.stages.map((s) => s.id)).toEqual(["feasibility", "schematic_design", "design_development", "construction_documents", "permit", "construction", "occupancy"]);
    expect(ACME.stages.find((s) => s.id === "permit")?.label).toBe("Permit and plan check");
    expect(stageProblems([], [ACME])).toEqual([]);
    expect(() => copyStageSet(base, { id: "firm:x", version: "1", label: "X", order: ["nope"] })).toThrow(/names a stage "nope"/);
  });

  it("a model pinned to the firm's list reads it, at its version", () => {
    const m = withPackSet(FIRM, () => lifecycle(empty("g11-firm"), { type: "set_stage_plan", stageSetId: "firm:acme", stageSetVersion: "2026-11", currentStageId: "design_development", setBy: "K. Example" }));
    expect(stagePlanOf(m.elements)).toEqual({ stageSet: { id: "firm:acme", version: "2026-11" }, currentStageId: "design_development", setBy: "K. Example" });
    const { list, stage } = currentStageOf(m.elements, FIRM);
    expect(list.id).toBe("firm:acme");
    expect(list.problem).toBeUndefined();
    expect(stage?.id).toBe("design_development");
    // A stage the firm dropped can't be frozen on this model.
    const r = withPackSet(FIRM, () => allPeers(() => executeLifecycleCommand(m, { type: "freeze_stage", gateId: "G-1", stageId: "bid", frozenBy: KS, frozenAt: "2026-11-02T15:00:00Z" })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/"bid" isn't a stage in this model's list \(Acme stages\)/);
  });

  it("a pin to a list this host doesn't have reads the defaults and says so; the pin is kept", () => {
    const m = withPackSet(FIRM, () => lifecycle(empty("g11-firm-2"), { type: "set_stage_plan", stageSetId: "firm:acme", stageSetVersion: "2026-11" }));
    const elsewhere = currentStageOf(m.elements, PackSet.create([]));
    expect(elsewhere.list.id).toBe("default");
    expect(elsewhere.list.problem).toMatch(/uses the stage list "firm:acme", which isn't installed here/);
    expect(stagePlanOf(m.elements)?.stageSet).toEqual({ id: "firm:acme", version: "2026-11" });
    expect(resolveStageSet({ id: "firm:acme", version: "2025-01" }, FIRM).problem).toMatch(/version 2025-01 of "Acme stages"; version 2026-11 is installed/);
    expect(m.elements[STAGE_PLAN_ID]?.kind).toBe("stage_plan");
  });

  it("an older model server is refused in words", () => {
    const r = withPackSet(FIRM, () => executeLifecycleCommand(empty("g11-firm-3"), { type: "set_stage_plan", stageSetId: "default", stageSetVersion: "1" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/older version that doesn't store stages and gates/);
  });
});
