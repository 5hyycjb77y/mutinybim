/**
 * @jest-environment node
 *
 * Gravity drainage reads (ROADMAP P4): the sewer connection, sewage pump and
 * backwater valve are ordinary parts whose type carries `drainage_role`; floors
 * are compared with the sewer invert and the upstream manhole cover; fixture
 * units reaching the connection come from the load lifecycle, not a pipe walk.
 * Before this module none of these reads existed, so every case fails on import.
 */
import { balance, coversDemand, dfuAtSewerConnection, drainageLoadsByFloor, drainageParts, floorsAgainstSewer, gravityDrainCapacity, gravityLimit, pumpAgainstInflow, sewagePumpCheck, sewerConnectionOf, smallestGravityDrain, type GravityCapacityTable } from "../src/drainage";
import { asElementId } from "@permitzip/bim-kernel";
import { DrainageBuilding, FT } from "../../bim-kernel/__tests__/drainage-fixtures";

const IN_MM = 25.4;

describe("gravity limit", () => {
  it("adds slope × length of fall to the sewer invert: -8'-6\" + 1/8 in/ft × 60 ft = 7.5 in. → -7'-10.5\"", () => {
    const g = gravityLimit({ sewerInvertMm: -8.5 * FT, slopeInPerFt: 0.125, lengthMm: 60 * FT });
    expect(g.fallKnown).toBe(true);
    expect(g.fallMm).toBeCloseTo(7.5 * IN_MM, 6);
    expect(g.limitMm / FT).toBeCloseTo(-7.875, 6);
  });

  it("with no slope or length, compares the floor with the invert itself", () => {
    expect(gravityLimit({ sewerInvertMm: -8.5 * FT, slopeInPerFt: null, lengthMm: 60 * FT })).toEqual({ limitMm: -8.5 * FT, fallMm: 0, fallKnown: false });
  });
});

describe("floors against the sewer (6144: the manhole was found above the basement floor)", () => {
  function site(invertFt: number, rimFt: number): DrainageBuilding {
    const b = new DrainageBuilding();
    b.manhole({ invertFt, rimFt, confidence: "verified" });
    b.drains("bsmt", "lvl-b", 3, 8);
    b.drains("l1", "lvl-1", 4, 6);
    return b;
  }

  it("a manhole 2 ft below the basement floor: every floor drains by gravity and none needs a backwater valve", () => {
    const b = site(-12, -12);
    const conn = sewerConnectionOf(b.head.elements, "mh-1");
    expect(conn).not.toBeNull();
    if (!conn) return;
    const floors = floorsAgainstSewer(b.head.elements, conn);
    expect(floors.map((f) => [f.levelName, f.gravity, f.backwater, f.needPump.length, f.needValve.length])).toEqual([
      ["Basement", "gravity", "above_rim", 0, 0],
      ["Level 1", "gravity", "above_rim", 0, 0],
    ]);
  });

  it("raise the invert to -8'-6\" and the cover to -2'-0\": the basement needs a pump and a backwater valve, Level 1 stays gravity", () => {
    const b = site(-8.5, -2);
    const conn = sewerConnectionOf(b.head.elements, "mh-1");
    if (!conn) throw new Error("no sewer connection");
    const [bsmt, l1] = floorsAgainstSewer(b.head.elements, conn);
    expect(bsmt).toMatchObject({ levelName: "Basement", gravity: "needs_pump", backwater: "below_rim" });
    expect(bsmt?.needPump).toEqual(["bsmt-1", "bsmt-2", "bsmt-3"]);
    expect(bsmt?.needValve).toEqual(["bsmt-1", "bsmt-2", "bsmt-3"]);
    expect(l1).toMatchObject({ levelName: "Level 1", gravity: "gravity", backwater: "above_rim", needPump: [], needValve: [] });
  });

  it("basement drains named against a sewage pump with a backwater valve need nothing more; against a bare valve they still need the pump", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -8.5, rimFt: -2 });
    b.pump("sgp-1", "SGP-1", { backwater_valve: true });
    b.valve("bwv-1", "BWV-1");
    b.drains("pumped", "lvl-b", 2, 8, "sgp-1");
    b.drains("valved", "lvl-b", 1, 2, "bwv-1");
    const conn = sewerConnectionOf(b.head.elements, "mh-1");
    if (!conn) throw new Error("no sewer connection");
    const [bsmt] = floorsAgainstSewer(b.head.elements, conn);
    expect(bsmt?.needPump).toEqual(["valved-1"]);
    expect(bsmt?.needValve).toEqual([]);
    expect(drainageParts(b.head.elements)).toEqual({ sewerConnections: ["mh-1"], pumps: ["sgp-1"], valves: ["bwv-1"] });
  });

  it("a model with no drainage parts has none, and rows typed in a table sit on no floor", () => {
    const b = new DrainageBuilding();
    b.rows("row", 3, 2);
    expect(drainageParts(b.head.elements)).toEqual({ sewerConnections: [], pumps: [], valves: [] });
    expect(drainageLoadsByFloor(b.head.elements)).toEqual({ floors: [], unplaced: ["row-1", "row-2", "row-3"] });
  });
});

describe("fixture units at the connection, through the load lifecycle", () => {
  it("7329: 35 fixtures typed as rows (26 × 2 + 9 × 3 DFU) reach the only connection as 79 DFU, whole building", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -12, sizeIn: 4, slope: 0.25 });
    b.rows("two", 26, 2);
    b.rows("three", 9, 3);
    expect(dfuAtSewerConnection(b.head.elements, asElementId("mh-1"))).toEqual({ dfu: 79, basis: "whole_building", loads: 35 });
  });

  it("with two connections, each counts only the loads that name it", () => {
    const b = new DrainageBuilding();
    b.manhole({ invertFt: -12 }, "mh-1", "MH-1");
    b.manhole({ invertFt: -12 }, "mh-2", "MH-2");
    b.drains("a", "lvl-1", 3, 4, "mh-1");
    b.drains("b", "lvl-1", 2, 6, "mh-2");
    expect(dfuAtSewerConnection(b.head.elements, asElementId("mh-1"))).toEqual({ dfu: 12, basis: "named", loads: 3 });
    expect(dfuAtSewerConnection(b.head.elements, asElementId("mh-2"))).toEqual({ dfu: 12, basis: "named", loads: 2 });
  });
});

describe("drain capacity lookup (table handed in by the code pack)", () => {
  const table: GravityCapacityTable = { slopes: [0.0625, 0.125, 0.25], rows: [{ nominalIn: 3, maxDfu: [null, 36, 42] }, { nominalIn: 4, maxDfu: [null, 180, 216] }, { nominalIn: 6, maxDfu: [null, 700, 840] }] };

  it("takes the column at or below the slope, never interpolating", () => {
    expect(gravityDrainCapacity(table, 4, 0.125)).toEqual({ maxDfu: 180, tableSlope: 0.125 });
    expect(gravityDrainCapacity(table, 4, 0.2)).toEqual({ maxDfu: 180, tableSlope: 0.125 });
    expect(gravityDrainCapacity(table, 4, 0.0625)).toEqual({ maxDfu: null, tableSlope: 0.0625 });
    expect(gravityDrainCapacity(table, 5, 0.25).maxDfu).toBeNull();
  });

  it("the smallest size for 394 DFU at 1/8 in/ft is 6 in.", () => {
    expect(smallestGravityDrain(table, 394, 0.125, 3)).toEqual({ nominalIn: 6, maxDfu: 700 });
  });
});

describe("sewage pump against its inflow (fixture units are never converted)", () => {
  it("with no inflow typed the verdict is inflow_unknown, whatever the rating", () => {
    expect(pumpAgainstInflow({ inflowGpm: null, headFt: 22, ratedGpm: 50, ratedHeadFt: 25 })).toEqual({ kind: "inflow_unknown" });
  });

  it("40 gpm at 22 ft on a pump rated 50 gpm at 25 ft passes; 60 gpm is 10 gpm short; 28 ft is 3 ft short", () => {
    expect(pumpAgainstInflow({ inflowGpm: 40, headFt: 22, ratedGpm: 50, ratedHeadFt: 25 }).kind).toBe("ok");
    const flow = pumpAgainstInflow({ inflowGpm: 60, headFt: 22, ratedGpm: 50, ratedHeadFt: 25 });
    expect(flow.kind).toBe("undersized");
    if (flow.kind === "undersized") expect(flow.flow.spare).toBe(-10);
    const head = pumpAgainstInflow({ inflowGpm: 40, headFt: 28, ratedGpm: 50, ratedHeadFt: 25 });
    if (head.kind !== "undersized") throw new Error(`expected undersized, got ${head.kind}`);
    expect(head.head.spare).toBe(-3);
    expect(pumpAgainstInflow({ inflowGpm: 40, headFt: 22, ratedGpm: null, ratedHeadFt: null })).toEqual({ kind: "rating_unknown", missing: ["flow", "head"] });
  });

  it("a pump in the model reports the fixture units that name it, and asks for the flow", () => {
    const b = new DrainageBuilding();
    b.pump("sgp-1", "SGP-1", { pump_rated_gpm: 50, pump_rated_head_ft: 25 });
    b.drains("bsmt", "lvl-b", 3, 8, "sgp-1");
    expect(sewagePumpCheck(b.head.elements, asElementId("sgp-1"))).toEqual({ pumpId: "sgp-1", label: "SGP-1", dfu: 24, loads: 3, verdict: { kind: "inflow_unknown" } });
    b.setValues("sgp-1", { pump_inflow_gpm: 40, pump_head_ft: 22 });
    expect(sewagePumpCheck(b.head.elements, asElementId("sgp-1"))?.verdict.kind).toBe("ok");
  });
});

describe("balance shape", () => {
  it("an absolute floor keeps a tiny difference balanced; the percentage is of the larger side", () => {
    expect(balance(50, 180, { absolute: 200 }).verdict).toBe("balanced");
    expect(balance(50, 180).verdict).toBe("more_out");
    expect(balance(100, 95, { percent: 10 })).toMatchObject({ verdict: "balanced", difference: 5, tolerance: 10, percent: 5 });
    expect(coversDemand(51, 50, { absolute: 1 }).ok).toBe(true);
    expect(coversDemand(52, 50, { absolute: 1 })).toMatchObject({ ok: false, spare: -2 });
    expect(() => balance(Number.NaN, 1)).toThrow(/finite/);
  });
});
