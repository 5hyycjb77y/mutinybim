/**
 * @jest-environment node
 *
 * October review defect B2: "Leave out things smaller than 6 in" blanked the
 * view. The filter must drop only what is drawn beyond the cut and smaller
 * than the setting; walls the plan cuts (a 6 in wall is no wider than the
 * setting) always draw, and so do the chairs and the table. The view keeping
 * its old background while the new cut is made is e0s-view-backgrounds.
 *
 * Fails on the product before #2786, which measured every element, cut or
 * not, and left out the 6 in walls with the cup.
 */
import * as WebIFC from "web-ifc";
import type { ReferencePlan } from "@permitzip/bim-kernel";
import { cutIfcPlan } from "../src/ifc-plan";
import { FIRST_PARTY_LINKED_DISPLAY } from "./fixtures/linked-display";
import { IDENTITY4 } from "../src/plan-geometry";
import { furnitureIfc } from "./fixtures/furniture-ifc";

const FT = 304.8;
const IN = 25.4;
const bytes = new TextEncoder().encode(furnitureIfc());

function count(plan: ReferencePlan, key: string): number {
  return plan.layers.filter((l) => `${l.kind}:${l.category}` === key).reduce((n, l) => n + l.segments.length / 4, 0);
}

describe("q12-filter-hides-only-small (B2)", () => {
  let api: WebIFC.IfcAPI;
  let modelId: number;
  const plan = (minObjectMm?: number) =>
    cutIfcPlan(api, modelId, { id: "arch", file: "furniture.ifc", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, storeyName: "Level 1", cutAboveLevelMm: 4 * FT, display: FIRST_PARTY_LINKED_DISPLAY, ...(minObjectMm !== undefined ? { minObjectMm } : {}) });

  beforeAll(async () => {
    api = new WebIFC.IfcAPI();
    await api.Init();
    modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  });
  afterAll(() => api.CloseModel(modelId));

  it("keeps every cut wall at 6 in and at 12 in, exactly as with no filter", () => {
    const all = plan();
    const walls = count(all.plan, "cut:IFCWALL");
    expect(walls).toBeGreaterThan(0);
    expect(count(plan(6 * IN).plan, "cut:IFCWALL")).toBe(walls);
    expect(count(plan(12 * IN).plan, "cut:IFCWALL")).toBe(walls);
  });

  it("at 6 in leaves out only the cup: the chairs and the table still draw", () => {
    const all = plan();
    const six = plan(6 * IN);
    expect(six.stats.small).toBe(1);
    expect(count(six.plan, "projection:IFCFURNISHINGELEMENT")).toBe(0);
    expect(count(all.plan, "projection:IFCFURNISHINGELEMENT")).toBeGreaterThan(0);
    expect(count(six.plan, "projection:IFCFURNITURE")).toBe(count(all.plan, "projection:IFCFURNITURE"));
  });

  it("never leaves a filtered view with nothing drawn", () => {
    const six = plan(6 * IN);
    expect(six.plan.layers.reduce((n, l) => n + l.segments.length, 0)).toBeGreaterThan(0);
  });
});
