/**
 * @jest-environment node
 *
 * Round 16 B2 (review video, Nov 6, 07:53–09:31): a new ceiling plan came in
 * with a crop box far bigger than the floor plan he had cropped for the same
 * level, so the two would not line up on sheets. A new plan of a level that
 * already has one starts on that plan's crop (the floor plan first). Fails on
 * round 15's code: `create_view` with no crop fitted the work, ignoring the
 * floor plan.
 */
import { commandSchema, executeCommand, matchingPlanCrop, type ModelState } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

const CROP = { min: { x: 1000, y: 2000 }, max: { x: 21000, y: 14000 } };

function cropOf(model: ModelState, id: string) {
  const v = model.elements[id];
  if (v?.kind !== "view") throw new Error(`no view ${id}`);
  return { min: v.cropMin, max: v.cropMax };
}

describe("b2: ceiling plans crop like floor plans", () => {
  it("a new ceiling plan of a level takes the floor plan's crop", () => {
    let m = run(createDemoModel(), { type: "create_view", viewId: "fp", name: "L1 plan", viewType: "floor_plan", crop: CROP, props: { level: "L1", scale: 48 } });
    expect(matchingPlanCrop(m, "ceiling_plan", "l1")).toEqual(CROP);
    m = run(m, { type: "create_view", viewId: "rcp", name: "L1 ceiling plan", viewType: "ceiling_plan", props: { level: "L1", scale: 48 } });
    expect(cropOf(m, "rcp")).toEqual(CROP);
  });

  it("another level, a 3D view or an explicit crop is left alone", () => {
    const m = run(createDemoModel(), { type: "create_view", viewId: "fp", name: "L1 plan", viewType: "floor_plan", crop: CROP, props: { level: "L1", scale: 48 } });
    expect(matchingPlanCrop(m, "ceiling_plan", "L2")).toBeNull();
    expect(matchingPlanCrop(m, "three_d", "L1")).toBeNull();
    const own = { min: { x: 0, y: 0 }, max: { x: 5000, y: 5000 } };
    const after = run(m, { type: "create_view", viewId: "rcp", name: "L1 ceiling plan", viewType: "ceiling_plan", crop: own, props: { level: "L1", scale: 48 } });
    expect(cropOf(after, "rcp")).toEqual(own);
  });
});
