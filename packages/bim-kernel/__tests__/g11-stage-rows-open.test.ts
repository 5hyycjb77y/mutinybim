/**
 * @jest-environment node
 *
 * Round 11 G11: project stages are rows. The kernel ships the default list;
 * an add-on adds its own stage ("plan review round 2") with no kernel edit
 * and it takes its place by order. Fails on round 10's code: there is no
 * stage point at all.
 */
import { contribute, definePack, PackSet } from "../src/packs";
import { DEFAULT_STAGE_ROWS, LIFECYCLE_STAGE_POINT, defaultStageSet, stageProblems, stageExitBlockers } from "../src/lifecycle/stages";

describe("g11 stage rows are open", () => {
  it("the default list is the built-in rows, by order", () => {
    const list = defaultStageSet(PackSet.create([]));
    expect(list.id).toBe("default");
    expect(list.stages.map((s) => s.id)).toEqual(DEFAULT_STAGE_ROWS.map((s) => s.id));
    expect(list.stages[0]?.id).toBe("due_diligence");
    expect(list.stages.at(-1)?.id).toBe("operations");
    expect(stageProblems(DEFAULT_STAGE_ROWS)).toEqual([]);
  });

  it("an add-on adds a stage between permit and bid with zero kernel edits", () => {
    const pack = definePack({ id: "zj", name: "Test jurisdiction", version: "1.0.0", kernel: "^1.8.0" }, [
      contribute(LIFECYCLE_STAGE_POINT, [{ id: "zj.plan_review_2", label: "Plan review round 2", order: 65, exitBlockers: { severity: ["blocking"], sources: ["code_rule"] } }]),
    ]);
    const list = defaultStageSet(PackSet.create([pack]));
    const ids = list.stages.map((s) => s.id);
    expect(ids.indexOf("zj.plan_review_2")).toBe(ids.indexOf("permit") + 1);
    expect(ids.indexOf("bid")).toBe(ids.indexOf("zj.plan_review_2") + 1);
    const review = list.stages.find((s) => s.id === "zj.plan_review_2");
    if (!review) throw new Error("added stage missing");
    // Its blockers are its own: only open code-rule problems of blocking severity keep it from being left.
    expect(stageExitBlockers(review, [{ id: "f1", severity: "blocking", sourceKind: "lint_rule" }, { id: "f2", severity: "blocking", sourceKind: "code_rule" }, { id: "f3", severity: "warning", sourceKind: "code_rule" }]).map((f) => f.id)).toEqual(["f2"]);
  });

  it("an add-on's stage id must carry its namespace", () => {
    expect(() => definePack({ id: "zj", name: "Test", version: "1.0.0", kernel: "^1.8.0" }, [contribute(LIFECYCLE_STAGE_POINT, [{ id: "plan_review_2", label: "Plan review", order: 65 }])])).toThrow(/must start with "zj\."/);
  });
});
