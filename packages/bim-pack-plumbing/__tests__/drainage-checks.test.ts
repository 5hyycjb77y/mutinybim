/**
 * @jest-environment node
 *
 * Building sewer checks with worked numbers (ROADMAP P4, 6144 review `1c289b72`):
 * 394 DFU on a 4 in. building drain at 1/8 in/ft is over the 180 that size
 * carries (Table 710.1(1)); 7329's 79 DFU on a 4 in. at 1/4 in/ft is under 216;
 * raising the manhole above the basement floor flips the basement to "needs a
 * sewage pump" (712.1) and "needs a backwater valve" (715.1); a sewage pump
 * refuses to turn fixture units into gpm and checks once a flow is typed
 * (712.4.2). Neither calc existed before this change, so every case fails on
 * import against the old code.
 */
import { ipcEdition, PERMITZIP_DESIGN_CRITERIA, type CalcContext, type CalcIssue, type CalcValue } from "@permitzip/bim-calc";
import { buildingSewerCalc, ipcMinDrainSlope, IPC_BUILDING_DRAIN_CAPACITY, sewagePumpCalc, type BuildingSewerDetail } from "../src/calc/plumbing/drainage-checks";
import type { RegisteredCalc } from "@permitzip/bim-calc";

const ctx: CalcContext = { code: ipcEdition("2021"), criteria: PERMITZIP_DESIGN_CRITERIA, model: null };

function run(calc: RegisteredCalc, inputs: unknown) {
  const r = calc.execute(inputs, ctx);
  if (!r.ok) throw new Error(r.reason);
  return r.output;
}
const value = (values: readonly CalcValue[], key: string) => values.find((v) => v.key === key)?.value;
const errors = (issues: readonly CalcIssue[]) => issues.filter((i) => i.severity === "error").map((i) => i.message);

describe("whole building drains here: fixture units against the building drain", () => {
  it("6144: 394 DFU on a 4 in. drain at 1/8 in/ft; that size carries 180, and 6 in. is the smallest that carries it", () => {
    const out = run(buildingSewerCalc, { sewer_invert_ft: -12, elevation_confidence: "verified", building_drain_size_in: 4, building_drain_slope_in_per_ft: 0.125, dfu: 394 });
    expect(value(out.values, "capacity_dfu")).toBe(180);
    expect(value(out.values, "over_capacity")).toBe(true);
    expect(errors(out.issues)).toEqual(["394 DFU on a 4 in. drain at 1/8 in/ft; that size carries 180 at 1/8 in/ft. 6 in. carries 700 at that slope."]);
    const capacity = (out.detail as BuildingSewerDetail).capacity;
    expect(capacity).toMatchObject({ sizeIn: 4, maxDfu: 180, over: true, smallestIn: 6 });
    const cite = out.issues.find((i) => i.message.startsWith("394"))?.cite[0]?.text ?? "";
    expect(cite).toContain("Table 710.1(1)");
    expect(cite).toContain("2021");
  });

  it("7329: 79 DFU on a 4 in. drain at 1/4 in/ft passes (216 at that slope)", () => {
    const out = run(buildingSewerCalc, { sewer_invert_ft: -12, elevation_confidence: "verified", building_drain_size_in: 4, building_drain_slope_in_per_ft: 0.25, dfu: 79 });
    expect(value(out.values, "capacity_dfu")).toBe(216);
    expect(value(out.values, "over_capacity")).toBe(false);
    expect(errors(out.issues)).toEqual([]);
  });

  it("with no slope given, the Table 704.1 least slope for the size is used and said", () => {
    expect(ipcMinDrainSlope(4)).toBe(0.125);
    const out = run(buildingSewerCalc, { sewer_invert_ft: -12, elevation_confidence: "verified", building_drain_size_in: 4, dfu: 100 });
    expect(out.steps.find((s) => s.label === "Slope")?.detail).toBe("No slope given: 1/8 in/ft, the least slope for 4 in.");
    expect(value(out.values, "capacity_dfu")).toBe(180);
  });

  it("the kernel table shape carries the code pack's rows unchanged", () => {
    expect(IPC_BUILDING_DRAIN_CAPACITY.slopes).toEqual([0.0625, 0.125, 0.25, 0.5]);
    expect(IPC_BUILDING_DRAIN_CAPACITY.rows.find((r) => r.nominalIn === 4)?.maxDfu).toEqual([null, 180, 216, 250]);
  });
});

describe("invert limit and backwater valve (6144 field change)", () => {
  const floors = [
    { name: "Basement", floor_ft: -10, dfu: 24 },
    { name: "Level 1", floor_ft: 0, dfu: 55 },
  ];

  it("manhole invert 2 ft below the basement: every floor drains by gravity, nothing needs a valve", () => {
    const out = run(buildingSewerCalc, { sewer_invert_ft: -12, sewer_rim_ft: -12, elevation_confidence: "verified", floors });
    const d = out.detail as BuildingSewerDetail;
    expect(d.floors.map((f) => [f.name, f.needsPump, f.needsBackwaterValve])).toEqual([
      ["Basement", false, false],
      ["Level 1", false, false],
    ]);
    expect(errors(out.issues)).toEqual([]);
  });

  it("invert raised to -8'-6\" with the cover at -2'-0\": the basement needs a sewage pump and a backwater valve; Level 1 does not", () => {
    const out = run(buildingSewerCalc, { sewer_invert_ft: -8.5, sewer_rim_ft: -2, elevation_confidence: "verified", building_drain_size_in: 4, building_drain_slope_in_per_ft: 0.125, building_drain_length_ft: 60, floors });
    const d = out.detail as BuildingSewerDetail;
    expect(d.gravityLimitFt).toBeCloseTo(-7.875, 3);
    expect(d.floors.map((f) => [f.name, f.needsPump, f.needsBackwaterValve])).toEqual([
      ["Basement", true, true],
      ["Level 1", false, false],
    ]);
    expect(errors(out.issues)).toEqual([
      "Basement (floor -10'-0\") can't drain to the sewer by gravity: it needs a sump and a sewage pump or ejector.",
      "Basement (floor -10'-0\") is below the next upstream manhole cover (-2'-0\"): it needs a backwater valve.",
    ]);
    expect(out.issues.filter((i) => i.message.includes("sewage pump"))[0]?.cite[0]?.clause).toBe("712.1");
    expect(out.issues.filter((i) => i.message.includes("backwater"))[0]?.cite[0]?.clause).toBe("715.1");
    expect(d.dfu).toBe(79);
  });

  it("a basement already on a pump with a backwater valve is clear; a floor above the cover on a valve is told not to use it", () => {
    const out = run(buildingSewerCalc, {
      sewer_invert_ft: -8.5,
      sewer_rim_ft: -2,
      elevation_confidence: "verified",
      floors: [
        { name: "Basement", floor_ft: -10, dfu: 24, drains_to: "sewage_pump_with_backwater_valve" },
        { name: "Level 1", floor_ft: 0, dfu: 55, drains_to: "backwater_valve" },
      ],
    });
    expect(errors(out.issues)).toEqual([]);
    expect(out.issues.map((i) => i.message)).toContain("Level 1 (floor 0'-0\") is above the manhole cover, so it must not discharge through the backwater valve.");
  });

  it("an assumed invert says so and asks for field verification", () => {
    const out = run(buildingSewerCalc, { sewer_invert_ft: -12, floors });
    expect(out.issues.filter((i) => i.severity === "warning").map((i) => i.message)).toEqual(["The sewer invert is assumed: have the contractor verify it before rough-in."]);
  });
});

describe("sewage pump: fixture units are never turned into gpm", () => {
  it("24 DFU and no inflow: can't be calculated from fixture units; enter the inflow in gpm", () => {
    const out = run(sewagePumpCalc, { dfu: 24, rated_gpm: 50, rated_head_ft: 25 });
    expect(errors(out.issues)).toEqual(["Can't be calculated from fixture units (24 DFU); enter the inflow in gpm."]);
    expect(out.detail).toEqual({ kind: "inflow_unknown" });
    expect(value(out.values, "pump_ok")).toBeUndefined();
  });

  it("40 gpm at 22 ft on a pump rated 50 gpm at 25 ft passes with 10 gpm and 3 ft to spare", () => {
    const out = run(sewagePumpCalc, { dfu: 24, inflow_gpm: 40, head_ft: 22, rated_gpm: 50, rated_head_ft: 25 });
    expect(errors(out.issues)).toEqual([]);
    expect(value(out.values, "pump_ok")).toBe(true);
    expect(value(out.values, "flow_spare_gpm")).toBe(10);
    expect(value(out.values, "head_spare_ft")).toBe(3);
    expect(out.steps[0]?.cite[0]?.clause).toBe("712.4.2");
  });

  it("60 gpm on the same pump is 10 gpm short; 28 ft of head is over its rating", () => {
    expect(errors(run(sewagePumpCalc, { inflow_gpm: 60, head_ft: 22, rated_gpm: 50, rated_head_ft: 25 }).issues)).toEqual(["60 gpm in, but the pump is rated 50 gpm: 10 gpm short."]);
    expect(errors(run(sewagePumpCalc, { inflow_gpm: 40, head_ft: 28, rated_gpm: 50, rated_head_ft: 25 }).issues)).toEqual(["28 ft of head needed, but the pump is rated at 25 ft."]);
  });
});
