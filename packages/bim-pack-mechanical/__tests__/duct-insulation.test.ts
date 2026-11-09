/**
 * @jest-environment node
 *
 * Duct insulation and liner, and duct sizes from airflow. Hand values are
 * computed here independently of the engine (velocity from area, Colebrook by
 * bisection, the ASHRAE friction-chart fit), so a change that drifts either
 * side fails. Before this, a run had no insulation and the Route panel had no
 * airflow.
 */
import {
  DEFAULT_SETTINGS,
  INSULATION_DASH,
  buildViewScene,
  builtinPartType,
  ductAirway,
  ductOuterSize,
  evaluateSchedule,
  insulatedSizeLabel,
  insulationIssue,
  insulationLabel,
  paperToModel,
  planCommit,
  planAutoTags,
  tagLines,
  type Command,
  type DuctInsulation,
  type ModelState,
  type RunSize,
} from "@permitzip/bim-kernel";
import {
  PA_PER_IN_WC,
  ductPerformance,
  systemPressure,
} from "@permitzip/bim-pack-mechanical";
import {
  sizingCriteriaFor,
  suggestDuctSize,
} from "../src";

const FT = 304.8;
const IN = 25.4;
/** Inches to millimetres to the micron, as the kernel stores sizes. */
const inch = (v: number) => Math.round(v * IN * 1000) / 1000;
const M3S_PER_CFM = 0.00047194745;
const LINER_1: DuctInsulation = { kind: "liner", thicknessMm: 1 * IN };
const WRAP_2: DuctInsulation = { kind: "wrap", thicknessMm: 2 * IN };

// ------------------------------------------------------------------ hand calculation

const RHO = 101_325 / (287.05 * 293.15);
const MU = 1.716e-5 * (293.15 / 273.15) ** 1.5 * (383.55 / 403.55);

function section(size: RunSize): { area: number; dh: number } {
  if (size.shape === "round") return { area: (Math.PI * (size.diameter / 1000) ** 2) / 4, dh: size.diameter / 1000 };
  if (size.shape !== "rect") throw new Error("hand calc covers rect and round");
  const a = size.width / 1000;
  const b = size.height / 1000;
  return { area: a * b, dh: (2 * a * b) / (a + b) };
}

function colebrook(re: number, rel: number): number {
  let lo = 1;
  let hi = 30;
  for (let i = 0; i < 200; i++) {
    const x = (lo + hi) / 2;
    if (x + 2 * Math.log10(rel / 3.7 + (2.51 * x) / re) > 0) hi = x;
    else lo = x;
  }
  const x = (lo + hi) / 2;
  return 1 / (x * x);
}

/** In. w.c. per 100 ft. */
function handFriction(cfm: number, size: RunSize, roughnessMm: number): number {
  const s = section(size);
  const v = (cfm * M3S_PER_CFM) / s.area;
  const re = (RHO * v * s.dh) / MU;
  const paPerM = (colebrook(re, roughnessMm / 1000 / s.dh) / s.dh) * ((RHO * v * v) / 2);
  return (paPerM * 30.48) / PA_PER_IN_WC;
}

/** The ASHRAE friction-chart fit for galvanized round duct: 0.109136 q^1.9 / D^5.02 (in. w.c./100 ft, CFM, inches). */
const chartFriction = (cfm: number, dIn: number) => (0.109136 * cfm ** 1.9) / dIn ** 5.02;

// ------------------------------------------------------------------ inside, outside, labels

describe("inside and outside dimensions", () => {
  const rect: RunSize = { shape: "rect", width: 24 * IN, height: 12 * IN };
  const round: RunSize = { shape: "round", diameter: 16 * IN };

  it("a liner narrows the airway by its thickness on every side; the outside stays the sheet metal", () => {
    expect(ductAirway(rect, LINER_1)).toEqual({ shape: "rect", width: inch(22), height: inch(10) });
    expect(ductAirway(round, LINER_1)).toEqual({ shape: "round", diameter: inch(14) });
    expect(ductOuterSize(rect, LINER_1)).toEqual(rect);
  });

  it("a wrap grows the outside by its thickness on every side; the airway stays the sheet metal", () => {
    expect(ductOuterSize(rect, WRAP_2)).toEqual({ shape: "rect", width: inch(28), height: inch(16) });
    expect(ductOuterSize(round, WRAP_2)).toEqual({ shape: "round", diameter: inch(20) });
    expect(ductAirway(rect, WRAP_2)).toEqual(rect);
    expect(ductAirway(rect, undefined)).toEqual(rect);
  });

  it("refuses a liner that leaves less than 2\" clear, and a liner on pipe (pipe takes a wrap)", () => {
    expect(insulationIssue({ shape: "rect", width: 8 * IN, height: 5 * IN }, { kind: "liner", thicknessMm: 2 * IN })).toMatch(/at least 2" each way/);
    expect(insulationIssue({ shape: "rect", width: 8 * IN, height: 5 * IN }, { kind: "wrap", thicknessMm: 2 * IN })).toBeNull();
    expect(insulationIssue({ shape: "pipe", nominalMm: 25.4, material: "copper" }, LINER_1)).toMatch(/Pipe takes insulation outside \(a wrap\)/);
    expect(insulationIssue({ shape: "pipe", nominalMm: 25.4, material: "copper" }, WRAP_2)).toBeNull();
  });

  it("labels read like a drawing tag", () => {
    expect(insulatedSizeLabel(rect, LINER_1)).toBe('24"x12" (1" liner)');
    expect(insulatedSizeLabel(rect, { kind: "wrap", thicknessMm: 1.5 * IN })).toBe('24"x12" (1½" wrap)');
    expect(insulatedSizeLabel(rect, undefined)).toBe('24"x12"');
    expect(insulationLabel({ kind: "wrap", thicknessMm: 2 * IN, rValue: 6 })).toBe('2" wrap R-6');
    expect(insulationLabel({ ...LINER_1, surface: "spray_coated" })).toBe('1" liner, spray-coated');
    expect(insulationLabel({ ...LINER_1, surface: "faced" })).toBe('1" liner');
    expect(insulationIssue({ shape: "rect", width: 24 * IN, height: 12 * IN }, { ...WRAP_2, surface: "faced" })).toMatch(/applies to a liner/);
  });
});

// ------------------------------------------------------------------ velocity and friction

describe("velocity and friction through the airway", () => {
  it("2,000 CFM in 24x12 is 1,000 fpm bare and 1,309 fpm with a 1\" liner (22x10 inside)", () => {
    const size: RunSize = { shape: "rect", width: 24 * IN, height: 12 * IN };
    const bare = ductPerformance(2000, size, undefined, undefined);
    const lined = ductPerformance(2000, size, LINER_1, undefined);
    expect(bare?.velocityFpm).toBeCloseTo(2000 / ((24 * 12) / 144), 1);
    expect(lined?.velocityFpm).toBeCloseTo(2000 / ((22 * 10) / 144), 1);
    expect(Math.round(lined?.velocityFpm ?? 0)).toBe(1309);
  });

  it("friction matches the hand Colebrook solve: galvanized bare; through the inside size at the liner's own roughness when lined", () => {
    const size: RunSize = { shape: "rect", width: 24 * IN, height: 12 * IN };
    expect(ductPerformance(2000, size, undefined, undefined)?.frictionInPer100Ft).toBeCloseTo(handFriction(2000, size, 0.09), 5);
    const inside: RunSize = { shape: "rect", width: 22 * IN, height: 10 * IN };
    // Faced fibrous glass liner is 1.5 mm (the default); spray-coated is 4.5 mm.
    expect(ductPerformance(2000, size, LINER_1, undefined)?.frictionInPer100Ft).toBeCloseTo(handFriction(2000, inside, 1.5), 5);
    expect(ductPerformance(2000, size, { ...LINER_1, surface: "faced" }, undefined)?.frictionInPer100Ft).toBeCloseTo(handFriction(2000, inside, 1.5), 5);
    expect(ductPerformance(2000, size, { ...LINER_1, surface: "spray_coated" }, undefined)?.frictionInPer100Ft).toBeCloseTo(handFriction(2000, inside, 4.5), 5);
    // The liner's surface replaces the duct material: a lined-material system with a faced liner is still 1.5 mm.
    expect(ductPerformance(2000, size, LINER_1, { material: "lined" })?.frictionInPer100Ft).toBeCloseTo(handFriction(2000, inside, 1.5), 5);
  });
});

// ------------------------------------------------------------------ size suggestions

describe("a size from airflow", () => {
  const criteria = sizingCriteriaFor("supply_air", undefined);

  it("supply air defaults to 0.08\" per 100 ft and 2,000 fpm, 4:1; the system's own values win field by field", () => {
    expect(criteria).toMatchObject({ frictionInPer100Ft: 0.08, maxVelocityFpm: 2000, maxAspectRatio: 4 });
    expect(sizingCriteriaFor("return_air", undefined).maxVelocityFpm).toBe(1500);
    const own = sizingCriteriaFor("supply_air", { sizing: { frictionInPer100Ft: 0.1 } });
    expect(own.frictionInPer100Ft).toBe(0.1);
    expect(own.typical).toEqual(["maxVelocityFpm", "maxAspectRatio"]);
  });

  it("1,200 CFM round at 0.08\": 16\" (859 fpm), the first size under the rate by hand and by the friction chart", () => {
    const s = suggestDuctSize({ cfm: 1200, shape: "round", criteria });
    if (!s.ok) throw new Error(s.reason);
    expect(s.best.size).toEqual({ shape: "round", diameter: inch(16) });
    expect(Math.round(s.best.velocityFpm)).toBe(Math.round(1200 / ((Math.PI * (16 / 12) ** 2) / 4)));
    expect(Math.round(s.best.velocityFpm)).toBe(859);
    expect(s.best.frictionInPer100Ft).toBeCloseTo(handFriction(1200, { shape: "round", diameter: 16 * IN }, 0.09), 5);
    // 15" is over the rate by hand; the chart fit agrees on both sides within 10%.
    expect(handFriction(1200, { shape: "round", diameter: 15 * IN }, 0.09)).toBeGreaterThan(0.08);
    expect(s.best.frictionInPer100Ft / chartFriction(1200, 16)).toBeGreaterThan(0.9);
    expect(s.best.frictionInPer100Ft / chartFriction(1200, 16)).toBeLessThan(1.1);
    expect(s.best.limitedBy).toBe("friction");
  });

  it("a velocity limit sets the size when it binds: 2,000 CFM at 1,000 fpm needs 2 ft², so 20\" round (917 fpm)", () => {
    const s = suggestDuctSize({ cfm: 2000, shape: "round", criteria: { frictionInPer100Ft: 1, maxVelocityFpm: 1000, maxAspectRatio: 4 } });
    if (!s.ok) throw new Error(s.reason);
    // 19" has 1.969 ft² (1,016 fpm); 20" has 2.182 ft².
    expect(s.best.size).toEqual({ shape: "round", diameter: inch(20) });
    expect(Math.round(s.best.velocityFpm)).toBe(917);
    expect(s.best.limitedBy).toBe("velocity");
  });

  it("rectangular: the least sheet metal within the aspect limit, and the narrowest width at the depth the ceiling allows", () => {
    const s = suggestDuctSize({ cfm: 1200, shape: "rect", criteria, holdHeightMm: 10 * IN });
    if (!s.ok) throw new Error(s.reason);
    const best = s.best.size;
    if (best.shape !== "rect") throw new Error("rect");
    // 14x14 (0.079"); every 26" perimeter (16x10, 18x8, 13x13 isn't standard) is over the rate.
    expect(best).toEqual({ shape: "rect", width: inch(14), height: inch(14) });
    expect(best.width / best.height).toBeLessThanOrEqual(4);
    expect(s.best.frictionInPer100Ft).toBeLessThanOrEqual(0.08);
    // Every smaller perimeter fails by hand.
    for (let h = 4; h <= 96; h += 2) {
      for (let w = h; w <= 4 * h; w += 2) {
        if (w + h >= Math.round((best.width + best.height) / IN)) continue;
        expect(handFriction(1200, { shape: "rect", width: w * IN, height: h * IN }, 0.09)).toBeGreaterThan(0.08);
      }
    }
    const at = s.atHeight?.size;
    if (at?.shape !== "rect") throw new Error("at height");
    expect(at.height).toBeCloseTo(10 * IN, 6);
    // At 10" deep: 22x10 (20x10 is 0.081" by hand).
    expect(at.width).toBeCloseTo(22 * IN, 6);
    expect(handFriction(1200, at, 0.09)).toBeLessThanOrEqual(0.08);
    expect(handFriction(1200, { shape: "rect", width: at.width - 2 * IN, height: 10 * IN }, 0.09)).toBeGreaterThan(0.08);
  });

  it("1,200 CFM with a 1\" faced liner: 19\" round (17\" inside, 761 fpm), 22x14 least metal, 36x10 at 10\" deep; spray-coated needs more", () => {
    const faced = suggestDuctSize({ cfm: 1200, shape: "round", criteria, insulation: LINER_1 });
    if (!faced.ok) throw new Error(faced.reason);
    expect(faced.best.size).toEqual({ shape: "round", diameter: inch(19) });
    expect(Math.round(faced.best.velocityFpm)).toBe(Math.round(1200 / ((Math.PI * (17 / 12) ** 2) / 4)));
    expect(faced.best.frictionInPer100Ft).toBeCloseTo(handFriction(1200, { shape: "round", diameter: 17 * IN }, 1.5), 5);
    // 18" leaves 16" inside, over the rate by hand.
    expect(handFriction(1200, { shape: "round", diameter: 16 * IN }, 1.5)).toBeGreaterThan(0.08);
    const rect = suggestDuctSize({ cfm: 1200, shape: "rect", criteria, insulation: LINER_1, holdHeightMm: 10 * IN });
    if (!rect.ok) throw new Error(rect.reason);
    expect(rect.best.size).toEqual({ shape: "rect", width: inch(22), height: inch(14) });
    expect(rect.atHeight?.size).toEqual({ shape: "rect", width: inch(36), height: inch(10) });
    expect(handFriction(1200, { shape: "rect", width: 32 * IN, height: 8 * IN }, 1.5)).toBeGreaterThan(0.08);
    const sprayed = suggestDuctSize({ cfm: 1200, shape: "rect", criteria, insulation: { ...LINER_1, surface: "spray_coated" }, holdHeightMm: 10 * IN });
    expect(sprayed.ok ? sprayed.atHeight?.size : null).toEqual({ shape: "rect", width: inch(40), height: inch(10) });
  });

  it("with a liner the sheet metal is sized so the inside meets the criteria", () => {
    const bare = suggestDuctSize({ cfm: 1200, shape: "round", criteria });
    const lined = suggestDuctSize({ cfm: 1200, shape: "round", criteria, insulation: LINER_1 });
    if (!bare.ok || !lined.ok) throw new Error("no size");
    expect(lined.best.size.shape === "round" && bare.best.size.shape === "round" && lined.best.size.diameter > bare.best.size.diameter).toBe(true);
    expect(lined.best.frictionInPer100Ft).toBeLessThanOrEqual(0.08);
  });

  it("says why when there is no airflow, or nothing standard carries it", () => {
    const none = suggestDuctSize({ cfm: 0, shape: "round", criteria });
    expect(none.ok ? "" : none.reason).toMatch(/Enter the airflow/);
    const huge = suggestDuctSize({ cfm: 400_000, shape: "round", criteria });
    expect(huge.ok ? "" : huge.reason).toMatch(/No round duct/);
  });
});

// ------------------------------------------------------------------ the model

const RTU = builtinPartType("builtin:rtu-5-ton@1");
const SD = builtinPartType("builtin:supply-diffuser-24@1");
let n = 0;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `ins-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-10-21T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function refusal(model: ModelState, command: Command): string {
  const d = planCommit(model, [], { idempotencyKey: `ins-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-10-21T00:00:00.000Z");
  return d.ok ? "" : d.error.message;
}

const TRUNK: RunSize = { shape: "rect", width: 14 * IN, height: 10 * IN };
const BRANCH: RunSize = { shape: "round", diameter: 8 * IN };
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };

/** RTU-1 → 14x10 trunk → SD-1; a tap off the trunk → 8" branch → SD-2. */
function system(trunkInsulation?: DuctInsulation | null): ModelState {
  if (!RTU || !SD) throw new Error("starter library");
  let m: ModelState = { modelId: "ins", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "rtu", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" });
  m = commit(m, { type: "place_part", partId: "sd-a", typeId: SD.id, partType: SD.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" });
  m = commit(m, { type: "place_part", partId: "sd-b", typeId: SD.id, levelId: "lvl-1", position: { x: 10 * FT, y: 6 * FT }, offsetMm: 8 * FT, mark: "SD-2" });
  m = commit(m, {
    type: "route_run",
    idPrefix: "trunk",
    levelId: "lvl-1",
    domain: "duct",
    size: TRUNK,
    elevationMm: 10 * FT,
    system: SA,
    points: [],
    from: { kind: "part", partId: "rtu", connectorId: "supply" },
    to: { kind: "part", partId: "sd-a", connectorId: "neck" },
    ...(trunkInsulation !== undefined ? { insulation: trunkInsulation } : {}),
  });
  m = commit(m, { type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 10 * FT, system: SA, points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 6 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
  return m;
}

const seg = (m: ModelState, id: string) => {
  const el = m.elements[id];
  if (el?.kind !== "run_segment") throw new Error(id);
  return el;
};

describe("routing with insulation", () => {
  it("a new system's first route sets its default; the next route without a choice uses it; fittings carry it", () => {
    const m = system(LINER_1);
    const sys = m.elements["sys-sa"];
    expect(sys?.kind === "mep_system" ? sys.design?.insulation : null).toEqual(LINER_1);
    expect(seg(m, "trunk-s2").insulation).toEqual(LINER_1);
    expect(seg(m, "br-s1").insulation).toEqual(LINER_1);
    const elbow = m.elements["br-f1"];
    expect(elbow?.kind === "run_fitting" ? elbow.insulation : null).toEqual(LINER_1);
  });

  it("insulation null routes bare duct even when the system has a default", () => {
    let m = system(LINER_1);
    m = commit(m, { type: "place_part", partId: "sd-c", typeId: "builtin:supply-diffuser-24@1", levelId: "lvl-1", position: { x: 14 * FT, y: -6 * FT }, offsetMm: 8 * FT, mark: "SD-3" });
    m = commit(m, { type: "route_run", idPrefix: "br2", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 10 * FT, system: SA, points: [{ x: 14 * FT, y: 0 }, { x: 14 * FT, y: -6 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-c", connectorId: "neck" }, insulation: null });
    expect(seg(m, "br2-s1").insulation).toBeUndefined();
  });

  it("a new system of the same kind starts with its sibling's insulation", () => {
    let m = system(WRAP_2);
    m = commit(m, { type: "route_run", idPrefix: "free", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 11 * FT, system: { id: "sys-sa2", kind: "supply_air", name: "Supply Air 2" }, points: [{ x: 0, y: 30 * FT }, { x: 20 * FT, y: 30 * FT }] });
    expect(seg(m, "free-s1").insulation).toEqual(WRAP_2);
    const sys2 = m.elements["sys-sa2"];
    expect(sys2?.kind === "mep_system" ? sys2.design?.insulation : null).toEqual(WRAP_2);
  });

  it("refuses a liner too thick for the duct and a liner on pipe; a wrap routes on pipe", () => {
    const m = system();
    expect(refusal(m, { type: "route_run", idPrefix: "tiny", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 6 * IN, height: 4 * IN }, elevationMm: 9 * FT, system: SA, points: [{ x: 0, y: 40 * FT }, { x: 10 * FT, y: 40 * FT }], insulation: { kind: "liner", thicknessMm: 1.5 * IN } })).toMatch(/at least 2" each way/);
    expect(refusal(m, { type: "route_run", idPrefix: "p", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 25.4, material: "copper" }, elevationMm: 9 * FT, system: { id: "dcw", kind: "domestic_cold_water" }, points: [{ x: 0, y: 50 * FT }, { x: 10 * FT, y: 50 * FT }], insulation: LINER_1 })).toMatch(/a wrap/);
    const wrapped = commit(m, { type: "route_run", idPrefix: "p", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 25.4, material: "copper" }, elevationMm: 9 * FT, system: { id: "dcw", kind: "domestic_cold_water" }, points: [{ x: 0, y: 50 * FT }, { x: 10 * FT, y: 50 * FT }], insulation: WRAP_2 });
    expect(seg(wrapped, "p-s1").insulation).toEqual(WRAP_2);
  });
});

describe("set_run_insulation", () => {
  it("a piece: the segment and the fittings at its ends", () => {
    const m = commit(system(), { type: "set_run_insulation", elementId: "br-s2", insulation: WRAP_2, scope: "piece" });
    expect(seg(m, "br-s2").insulation).toEqual(WRAP_2);
    expect(seg(m, "br-s1").insulation).toBeUndefined();
    for (const id of ["br-f1", "br-f2"]) {
      const f = m.elements[id];
      expect(f?.kind === "run_fitting" ? f.insulation : null).toEqual(WRAP_2);
    }
  });

  it("a run stops at transitions and branches; the whole system reaches every duct", () => {
    const run = commit(system(), { type: "set_run_insulation", elementId: "br-s1", insulation: LINER_1, scope: "run" });
    expect(["br-s1", "br-s2", "br-s3"].every((id) => seg(run, id).insulation?.kind === "liner")).toBe(true);
    expect(seg(run, "trunk-s2").insulation).toBeUndefined();
    const all = commit(system(), { type: "set_run_insulation", elementId: "br-s1", insulation: LINER_1, scope: "system" });
    expect(seg(all, "trunk-s2").insulation).toEqual(LINER_1);
    const off = commit(all, { type: "set_run_insulation", elementId: "trunk-s2", insulation: null, scope: "system" });
    expect(seg(off, "br-s1").insulation).toBeUndefined();
  });

  it("refuses what changes nothing, and a liner the duct can't take", () => {
    const m = system(LINER_1);
    expect(refusal(m, { type: "set_run_insulation", elementId: "trunk-s2", insulation: LINER_1, scope: "piece" })).toMatch(/already has 1" liner/);
    // Faced is the default surface, so saying so changes nothing; spray-coated does.
    expect(refusal(m, { type: "set_run_insulation", elementId: "trunk-s2", insulation: { ...LINER_1, surface: "faced" }, scope: "piece" })).toMatch(/already has 1" liner/);
    expect(seg(commit(m, { type: "set_run_insulation", elementId: "trunk-s2", insulation: { ...LINER_1, surface: "spray_coated" }, scope: "piece" }), "trunk-s2").insulation?.surface).toBe("spray_coated");
    expect(refusal(m, { type: "set_run_insulation", elementId: "br-s1", insulation: { kind: "liner", thicknessMm: 3.5 * IN }, scope: "piece" })).toMatch(/at least 2" each way/);
  });

  it("the system default is set and cleared with set_system_design", () => {
    const m = commit(system(), { type: "set_system_design", systemId: "sys-sa", design: { insulation: WRAP_2, sizing: { frictionInPer100Ft: 0.1 } } });
    const sys = m.elements["sys-sa"];
    expect(sys?.kind === "mep_system" ? sys.design : null).toMatchObject({ insulation: WRAP_2, sizing: { frictionInPer100Ft: 0.1 } });
    const cleared = commit(m, { type: "set_system_design", systemId: "sys-sa", design: { insulation: null } });
    const after = cleared.elements["sys-sa"];
    expect(after?.kind === "mep_system" ? after.design?.insulation : "x").toBeUndefined();
    expect(after?.kind === "mep_system" ? after.design?.sizing : null).toEqual({ frictionInPer100Ft: 0.1 });
  });
});

describe("pressure with a liner", () => {
  it("the branch's straight loss is the hand Darcy through the inside (6\" with a 1\" liner) at the liner's roughness, faced or spray-coated", () => {
    const bare = system();
    const lined = commit(bare, { type: "set_run_insulation", elementId: "br-s1", insulation: LINER_1, scope: "run" });
    const before = systemPressure(bare, "sys-sa")?.elements["br-s1"];
    const after = systemPressure(lined, "sys-sa")?.elements["br-s1"];
    if (before?.kind !== "segment" || after?.kind !== "segment") throw new Error("segments");
    const inside: RunSize = { shape: "round", diameter: 6 * IN };
    expect(after.frictionRateInPer100Ft).toBeCloseTo(handFriction(150, inside, 1.5), 3);
    expect(after.lossPa).toBeGreaterThan(before.lossPa * 2);
    const sprayed = systemPressure(commit(bare, { type: "set_run_insulation", elementId: "br-s1", insulation: { ...LINER_1, surface: "spray_coated" }, scope: "run" }), "sys-sa")?.elements["br-s1"];
    expect(sprayed?.kind === "segment" ? sprayed.frictionRateInPer100Ft : 0).toBeCloseTo(handFriction(150, inside, 4.5), 3);
    // Velocity is through the inside: 150 CFM over 6" round.
    expect(after.velocityFpm).toBeCloseTo(150 / ((Math.PI * 0.5 ** 2) / 4), 0);
    expect(systemPressure(lined, "sys-sa")?.totalPa).toBeGreaterThan(systemPressure(bare, "sys-sa")?.totalPa ?? Infinity);
  });

  it("a wrap changes nothing the air sees", () => {
    const bare = systemPressure(system(), "sys-sa");
    const wrapped = systemPressure(system(WRAP_2), "sys-sa");
    expect(wrapped?.totalPa).toBeCloseTo(bare?.totalPa ?? 0, 6);
  });
});

// ------------------------------------------------------------------ drawings, tags, schedules

function withViews(m: ModelState): ModelState {
  let out = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "Level 1", scale: 48 } });
  out = commit(out, { type: "create_view", viewId: "v-sec", name: "Section A", viewType: "section", props: { level: "Level 1", section: { start: { x: 5 * FT, y: -5 * FT }, end: { x: 5 * FT, y: 5 * FT }, direction: 1, depthMm: 2 * FT } } });
  return out;
}

/** Thin dashed insulation lines of a view, back in model (plan) or view (section u, v) millimetres. */
function insulationLines(m: ModelState, viewId: string) {
  const { scene, frame } = buildViewScene(m, viewId);
  return scene.primitives.flatMap((p) => (p.kind === "line" && p.pen === "thin" && p.dash && p.dash.join() === INSULATION_DASH.join() ? [[paperToModel(frame, p.a), paperToModel(frame, p.b)] as const] : []));
}

describe("drawings", () => {
  it("plan: no insulation lines on bare duct; a 2\" wrap draws thin dashed lines 2\" outside the 14\" trunk", () => {
    expect(insulationLines(withViews(system()), "v-plan")).toEqual([]);
    const lines = insulationLines(withViews(system(WRAP_2)), "v-plan");
    // The trunk runs east along y = 0: its sides are at ±7", the wrap at ±9".
    const ys = lines.filter(([a, b]) => Math.abs(a.y - b.y) < 1 && Math.abs(a.x - b.x) > FT).map(([a]) => Math.round(Math.abs(a.y) / IN * 10) / 10);
    expect(ys).toContain(9);
  });

  it("plan: changing to a 2\" liner moves the lines inside, 2\" in from each side (±5\")", () => {
    const m = commit(withViews(system(WRAP_2)), { type: "set_run_insulation", elementId: "trunk-s2", insulation: { kind: "liner", thicknessMm: 2 * IN }, scope: "run" });
    const ys = insulationLines(m, "v-plan").filter(([a, b]) => Math.abs(a.y - b.y) < 1 && Math.abs(a.x - b.x) > FT).map(([a]) => Math.round(Math.abs(a.y) / IN * 10) / 10);
    expect(ys).toContain(5);
    expect(ys).not.toContain(9);
  });

  it("section: the cut through a lined trunk shows the inside outline, 12\" x 8\" around its centre at 10 ft", () => {
    const lines = insulationLines(withViews(system(LINER_1)), "v-sec");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const us = lines.flatMap(([a, b]) => [a.x, b.x]);
    const vs = lines.flatMap(([a, b]) => [a.y, b.y]);
    expect((Math.max(...us) - Math.min(...us)) / IN).toBeCloseTo(12, 1);
    expect((Math.max(...vs) - Math.min(...vs)) / IN).toBeCloseTo(8, 1);
    expect((Math.max(...vs) + Math.min(...vs)) / 2 / FT).toBeCloseTo(10, 2);
    expect((Math.max(...us) + Math.min(...us)) / 2 / FT).toBeCloseTo(5, 2);
  });

  it("tags: the insulation template says it; auto-tag can use it", () => {
    const m = withViews(system(LINER_1));
    expect(tagLines(m, { elementId: "trunk-s2", template: "duct_size_insulation", leader: false })).toEqual(['14"x10" (1" liner)']);
    expect(tagLines(m, { elementId: "trunk-s2", template: "duct_size", leader: false })).toEqual(['14"x10"']);
    expect(tagLines(m, { elementId: "trunk-s2", template: "fields", fields: ["size", "insulation"], leader: false })).toEqual(['14"x10"', '1" liner']);
    const plan = planAutoTags(m, "v-plan", { categories: ["duct"], idPrefix: "t", ductInsulationInTags: true });
    expect(plan.items.some((i) => i.text === '14"x10" (1" liner)')).toBe(true);
  });

  it("schedules: a duct schedule lists insulation, inside and outside size, airflow and velocity", () => {
    const m = commit(system(LINER_1), { type: "set_run_insulation", elementId: "br-s1", insulation: WRAP_2, scope: "run" });
    const table = evaluateSchedule(m, { category: "duct", columns: [{ field: "size" }, { field: "insulation" }, { field: "inside_size" }, { field: "outside_size" }, { field: "cfm" }, { field: "velocity_fpm" }, { field: "liner_surface" }], sort: [{ field: "size" }] });
    expect(table.headings).toEqual(["SIZE", "INSULATION", "INSIDE SIZE", "OUTSIDE SIZE", "CFM", "VELOCITY (FPM)", "LINER SURFACE"]);
    const trunk = table.rows.find((r) => r[0] === '14"x10"' && r[4] === "300");
    expect(trunk?.slice(1, 4)).toEqual(['1" liner', '12"x8"', '14"x10"']);
    expect(trunk?.[5]).toBe(String(Math.round(300 / ((12 * 8) / 144))));
    expect(trunk?.[6]).toBe("Faced");
    const branch = table.rows.find((r) => r[0] === '8"Ø');
    expect(branch?.slice(1, 4)).toEqual(['2" wrap', '8"Ø', '12"Ø']);
  });
});
