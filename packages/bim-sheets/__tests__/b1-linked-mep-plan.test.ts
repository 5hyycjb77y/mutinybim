/**
 * @jest-environment node
 *
 * The Nov 6 review video, item 1: a linked MEP model draws its ducts, pipes,
 * fittings, equipment, terminals and ceilings in plans and ceiling plans,
 * within the view range, by the add-ons' display rules.
 *
 * Fails on the old cut: it drew only walls, doors, furniture, terminals and
 * slabs (ducts, pipes, fittings, equipment and coverings were "otherCategory")
 * and dropped everything above the cut plane, so the 9 ft duct never showed.
 */
import * as WebIFC from "web-ifc";
import type { ReferencePlan } from "@permitzip/bim-kernel";
import { cutIfcPlan, listStoreys, type PlanCutOptions } from "../src/ifc-plan";
import { IDENTITY4 } from "../src/plan-geometry";
import { FIRST_PARTY_LINKED_DISPLAY } from "./fixtures/linked-display";
import { MEP_LINK_FT, MEP_LINK_STOREYS, mepLinkIfc } from "./fixtures/mep-link-ifc";

const FT = 304.8;
const bytes = new TextEncoder().encode(mepLinkIfc());

const has = (plan: ReferencePlan, key: string) => plan.layers.some((l) => `${l.kind}:${l.category}` === key && l.segments.length > 0);
const categories = (plan: ReferencePlan) => new Set(plan.layers.filter((l) => l.segments.length > 0).map((l) => l.category));

describe("a linked MEP model in plan", () => {
  let api: WebIFC.IfcAPI;
  let modelId: number;
  const cut = (extra: Partial<PlanCutOptions> = {}) =>
    cutIfcPlan(api, modelId, { id: "mep", file: "mep-link.ifc", bytes, discipline: "mep", ifcToHostMetres: IDENTITY4, storeyName: "LEVEL 01", cutAboveLevelMm: 4 * FT, display: FIRST_PARTY_LINKED_DISPLAY, ...extra });

  beforeAll(async () => {
    api = new WebIFC.IfcAPI();
    await api.Init();
    modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  });
  afterAll(() => api.CloseModel(modelId));

  it("has the three storeys a roof plan has to choose between", () => {
    expect(listStoreys(api, modelId, IDENTITY4).map((s) => s.name)).toEqual([...MEP_LINK_STOREYS]);
  });

  it("draws the duct, its elbow and the diffuser above the cut, and the pipe below it", () => {
    const { plan, stats } = cut();
    expect(has(plan, "projection:IFCDUCTSEGMENT")).toBe(true);
    expect(has(plan, "projection:IFCDUCTFITTING")).toBe(true);
    expect(has(plan, "projection:IFCAIRTERMINAL")).toBe(true);
    expect(has(plan, "projection:IFCPIPESEGMENT")).toBe(true);
    expect(has(plan, "cut:IFCWALL")).toBe(true);
    expect(stats.otherCategory).toBe(0);
    // The duct's outline is its true size in plan.
    const duct = plan.layers.find((l) => l.category === "IFCDUCTSEGMENT")?.segments ?? [];
    const xs = duct.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs) / FT).toBeCloseTo(MEP_LINK_FT.duct.minX, 1);
    expect(Math.max(...xs) / FT).toBeCloseTo(MEP_LINK_FT.duct.maxX, 1);
  });

  it("a floor plan doesn't draw the ceiling", () => {
    expect(categories(cut().plan).has("IFCCOVERING")).toBe(false);
  });

  it("the view's top leaves out what is wholly above it (the rooftop unit), and keeps the duct", () => {
    expect(categories(cut().plan).has("IFCUNITARYEQUIPMENT")).toBe(true);
    const capped = cut({ topAboveLevelMm: 12 * FT });
    expect(categories(capped.plan).has("IFCUNITARYEQUIPMENT")).toBe(false);
    expect(categories(capped.plan).has("IFCDUCTSEGMENT")).toBe(true);
    const low = cut({ topAboveLevelMm: 8 * FT });
    expect(categories(low.plan).has("IFCDUCTSEGMENT")).toBe(false);
  });

  it("a ceiling plan draws the ceiling and the duct, and nothing below the cut", () => {
    const { plan } = cut({ lookingUp: true, topAboveLevelMm: 12 * FT });
    const seen = categories(plan);
    expect(seen.has("IFCCOVERING")).toBe(true);
    expect(seen.has("IFCDUCTSEGMENT")).toBe(true);
    expect(seen.has("IFCPIPESEGMENT")).toBe(false);
    expect(seen.has("IFCSLAB")).toBe(false);
    expect(seen.has("IFCWALL")).toBe(true);
  });

  it("the rooftop unit draws on a plan of the roof storey it stands on", () => {
    const { plan } = cut({ storeyName: "ROOF LOW POINT", cutAboveLevelMm: 2 * FT });
    expect(has(plan, "cut:IFCUNITARYEQUIPMENT")).toBe(true);
  });

  it("a category no add-on names is not drawn", () => {
    const { plan, stats } = cut({ display: { rules: {}, fingerprint: "none" } });
    expect(plan.layers).toHaveLength(0);
    expect(stats.otherCategory).toBeGreaterThan(0);
  });
});
