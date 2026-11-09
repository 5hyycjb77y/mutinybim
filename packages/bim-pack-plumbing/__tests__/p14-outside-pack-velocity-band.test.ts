/**
 * @jest-environment node
 *
 * Round 14 P14 bedrock: an outside add-on (a hydronic test add-on, not
 * first-party) checks chilled water velocity against its own band through
 * the same design-limit points Plumbing uses — a default band for its system
 * and a measure row — with zero kernel edits. A firm row with the same id
 * replaces its default, and the words name the layer.
 */
import { asElementId, DEFAULT_SETTINGS, type ModelState } from "@permitzip/bim-kernel";
import { DESIGN_LIMIT_DEFAULT_POINT, DESIGN_LIMIT_MEASURE_POINT, designLimitMeasures, type DesignLimit, type DesignLimitMeasureRow } from "@permitzip/bim-kernel/policy";
import { PackSet, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";
import { velocityBandFindings, velocityBandRows } from "../src";

const CHW_BAND: DesignLimit = {
  id: "hx.chilled_water_velocity",
  label: "Chilled water velocity",
  quantity: "velocity",
  unit: "ft/s",
  appliesTo: { systems: ["hx.chilled_water"] },
  band: { max: 6 },
  severity: "warning",
  citation: { source: "Hydronic test add-on default" },
};

/** The add-on reads its own pipes; here it reports two measured mains. */
const CHW_MEASURE: DesignLimitMeasureRow = {
  id: "hx.chilled_water_velocity",
  label: "Chilled water velocity",
  quantities: ["velocity"],
  measure: (_model, ids) =>
    [
      { elementId: asElementId("chw-main-1"), label: "Velocity", selector: { quantity: "velocity", system: "hx.chilled_water" }, value: 7.24, unit: "ft/s" },
      { elementId: asElementId("chw-main-2"), label: "Velocity", selector: { quantity: "velocity", system: "hx.chilled_water" }, value: 4, unit: "ft/s" },
    ].filter((m) => !ids || ids.has(m.elementId)),
};

const HYDRONIC = definePack(
  { id: "hx", name: "Hydronic test", version: "1.0.0", kernel: "^1.0.0" },
  [contribute(DESIGN_LIMIT_DEFAULT_POINT, [CHW_BAND]), contribute(DESIGN_LIMIT_MEASURE_POINT, [CHW_MEASURE])],
);

const empty: ModelState = { modelId: "hx", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };

describe("p14-outside-pack-velocity-band", () => {
  const set = PackSet.create([HYDRONIC]);

  it("the add-on's band and measure are read through the same points", () => {
    withPackSet(set, () => {
      expect(designLimitMeasures().map((r) => r.id)).toContain("hx.chilled_water_velocity");
      const found = velocityBandFindings(empty, {}, { measures: designLimitMeasures() });
      expect(found.map((f) => [f.elementId, f.words])).toEqual([["chw-main-1", "Velocity 7.2 ft/s over the 6 ft/s limit (default)"]]);
      expect(velocityBandRows({}).find((r) => r.system === "hx.chilled_water")?.words).toBe("at most 6 ft/s (default)");
    });
  });

  it("a firm row with the add-on's id replaces its default", () => {
    withPackSet(set, () => {
      const firm: DesignLimit = { ...CHW_BAND, band: { max: 3.5 }, citation: { source: "Firm hydronic standard" } };
      const found = velocityBandFindings(empty, { firm: [firm] }, { measures: designLimitMeasures() });
      expect(found.map((f) => f.words)).toEqual(["Velocity 7.2 ft/s over the 3.5 ft/s limit (firm)", "Velocity 4 ft/s over the 3.5 ft/s limit (firm)"]);
      expect(found.every((f) => f.source === "Firm hydronic standard" && f.fix === null)).toBe(true);
    });
  });
});
