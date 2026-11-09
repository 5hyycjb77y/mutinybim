/**
 * @jest-environment node
 *
 * Round 13 lane K13 (step 1.3, drawing): plans and the one-sheet printout
 * draw the Mechanical add-on's unit, duct, elbow and air terminal from its
 * kind rows' `planGraphics` face, not from kernel kind cases.
 *
 * - The four drawn rows carry the face (a tap draws nothing of its own).
 * - `drawing/sheet.ts` holds no duct, elbow, terminal or unit case and no
 *   duct drawing helper; `drawing/views.ts` holds no case for them either.
 * - A Mechanical whose duct row draws something else changes what the sheet
 *   and a floor plan draw for every duct, and nothing else draws a duct.
 *
 * Fails on round 12's code: the rows had no `planGraphics`, sheet.ts kept
 * `drawSegment` / `trimAt` / `drawElbow` and the four cases, and the kernel
 * drew ducts whatever the add-on's rows said.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ELEMENT_KIND_POINT,
  buildSheetScene,
  buildViewScene,
  commandSchema,
  demoSheetDefinition,
  executeCommand,
  type ElementKindItem,
  type ModelState,
  type Primitive,
} from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, withPackSet, type ErasedContribution } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_CONTRIBUTIONS, MECHANICAL_KINDS, MECHANICAL_PACK } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const KERNEL_DRAWING = path.resolve(__dirname, "../../bim-kernel/src/drawing");
const source = (file: string): string => readFileSync(path.join(KERNEL_DRAWING, file), "utf8");

function planModel(): ModelState {
  const r = executeCommand(createDemoModel("k13-rows"), commandSchema.parse({ type: "create_view", viewId: "plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } }));
  if (!r.ok) throw new Error(r.error.message);
  return r.model;
}

/** Mechanical, with its duct row drawing one dashed thin centre line and no size label. */
function markedMechanical() {
  const contributions: ErasedContribution[] = MECHANICAL_CONTRIBUTIONS.map((c) => {
    if (c.pointId !== ELEMENT_KIND_POINT.id) return c;
    const rows = MECHANICAL_KINDS.map((row): ElementKindItem =>
      row.kind === "duct_segment"
        ? { ...row, planGraphics: (el) => (el.kind === "duct_segment" ? [{ form: "line", a: el.start, b: el.end, pen: "thin", dash: "dashed" }] : null) }
        : row,
    );
    return contribute(ELEMENT_KIND_POINT, rows);
  });
  return definePack(MECHANICAL_PACK.manifest, contributions);
}

const dashedThin = (prims: readonly Primitive[]) => prims.filter((p) => p.kind === "line" && p.pen === "thin" && p.dash !== undefined && p.dash.join(",") === "3,1.5");

describe("k13 plan graphics rows", () => {
  it("Mechanical's unit, duct, elbow and terminal rows draw through planGraphics; a tap draws nothing of its own", () => {
    const faces = Object.fromEntries(MECHANICAL_KINDS.map((r) => [r.kind, typeof r.planGraphics]));
    expect(faces).toEqual({ equipment: "function", duct_segment: "function", elbow: "function", terminal: "function", tap: "undefined" });
  });

  it("drawing/sheet.ts and drawing/views.ts hold no duct, elbow, terminal or unit case", () => {
    const sheet = source("sheet.ts");
    expect(sheet).not.toMatch(/"duct_segment"|"elbow"|"tap"|drawSegment|drawElbow|trimAt|DuctSegment/);
    expect(sheet).not.toMatch(/case "(terminal|equipment)"/);
    const views = source("views.ts");
    expect(views).not.toMatch(/case "(duct_segment|elbow|terminal|equipment)"|drawSegment|drawElbow/);
  });

  it("what the duct row draws is what the sheet and a floor plan draw for every duct", () => {
    const model = planModel();
    const ducts = Object.values(model.elements).filter((el) => el.kind === "duct_segment").length;
    expect(ducts).toBeGreaterThan(0);

    const before = buildSheetScene(model, demoSheetDefinition());
    expect(dashedThin(before.primitives)).toHaveLength(0);
    expect(before.tags.some((t) => t.ref === "centerline_mid")).toBe(true);

    const set = PackSet.create([markedMechanical()]);
    const sheet = withPackSet(set, () => buildSheetScene(model, demoSheetDefinition()));
    expect(dashedThin(sheet.primitives)).toHaveLength(ducts);
    expect(sheet.tags.filter((t) => t.ref === "centerline_mid")).toEqual([]);
    expect(sheet.primitives.filter((p) => p.kind === "line" && p.pen === "wide").length).toBeLessThan(before.primitives.filter((p) => p.kind === "line" && p.pen === "wide").length);

    const plan = withPackSet(set, () => buildViewScene(model, "plan").scene);
    expect(dashedThin(plan.primitives).length).toBeGreaterThan(0);
    expect(dashedThin(buildViewScene(model, "plan").scene.primitives)).toHaveLength(0);
  });
});
