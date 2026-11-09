/**
 * @jest-environment node
 *
 * Round 15 (lane SH15, product decision: the live plan matches the sheet this
 * round). A plan's view range leaves out the same work on the live plan as on
 * its printed drawing, through one test (`planViewRangeExcludes`). Fails on
 * round 14: the live model never read the view range, so ductwork above a
 * plan's top printed nowhere but still showed live.
 */
import { buildSheetSceneFor, commandSchema, executeCommand, planViewRangeExcludes, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { liveViewRangeExcludes } from "../src/live-display";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function planWith(props: Record<string, unknown>): ModelState {
  let m = run(createDemoModel(), { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan" });
  m = run(m, { type: "create_view", viewId: "v1", name: "L1", viewType: "floor_plan", props: { level: "L1", ...props } });
  return run(m, { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 300, y: 300 } });
}

const ducts = (m: ModelState) => Object.values(m.elements).filter((e) => e.kind === "duct_segment");
const lineCount = (m: ModelState) => buildSheetSceneFor(m, "s1", { projectName: "Test" }).primitives.filter((p) => p.kind === "line").length;

describe("sh15-live-plan-view-range", () => {
  it("work above the plan's top is left out of the live plan exactly as the sheet leaves it out", () => {
    const open = planWith({});
    const low = planWith({ cutHeightMm: 100, viewBottomMm: 0, viewTopMm: 150 });
    const view = low.elements["v1"];
    if (view?.kind !== "view") throw new Error("no view");
    const printed = planViewRangeExcludes(low, view);
    const live = liveViewRangeExcludes(low, view, true);
    expect(printed && live).toBeTruthy();
    for (const d of ducts(low)) expect(live!(d)).toBe(printed!(d));
    expect(ducts(low).some((d) => live!(d))).toBe(true);
    // The sheet really drops them: fewer lines than the same plan with no range.
    expect(lineCount(low)).toBeLessThan(lineCount(open));
  });

  it("no range, or outside plan, leaves the live model as it was", () => {
    const open = planWith({});
    const view = open.elements["v1"];
    if (view?.kind !== "view") throw new Error("no view");
    expect(liveViewRangeExcludes(open, view, true)).toBeNull();
    const low = planWith({ cutHeightMm: 100, viewBottomMm: 0, viewTopMm: 150 });
    const lowView = low.elements["v1"];
    expect(lowView?.kind === "view" ? liveViewRangeExcludes(low, lowView, false) : "no view").toBeNull();
  });
});
