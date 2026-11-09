/**
 * @jest-environment node
 *
 * Static pressure for routed duct, checked against an independent hand
 * calculation (its own Colebrook solve by bisection, its own velocity
 * pressure, the coefficient correlations written out), plus the critical
 * path, the fan ESP, and incremental recalculation after an edit. Before
 * this there was no pressure calculation at all.
 */
import {
  DEFAULT_SETTINGS,
  builtinPartType,
  planCommit,
  straightPiece,
  type Command,
  type ModelState,
  type RunSize,
} from "../src";
import {
  PA_PER_IN_WC,
  PressureEngine,
  airProperties,
  frictionRate,
  systemPressure,
} from "@permitzip/bim-pack-mechanical";

const FT = 304.8;
const IN = 25.4;
const M3S_PER_CFM = 0.00047194745;

// ------------------------------------------------------------------ the hand calculation (independent of the engine)

const RHO = 101_325 / (287.05 * 293.15); // standard air, sea level, 20 °C
const MU = 1.716e-5 * (293.15 / 273.15) ** 1.5 * (383.55 / 403.55);
const EPS = 0.09 / 1000; // galvanized

function section(size: RunSize): { area: number; dh: number } {
  if (size.shape === "round") return { area: (Math.PI * (size.diameter / 1000) ** 2) / 4, dh: size.diameter / 1000 };
  if (size.shape !== "rect") throw new Error("hand calc covers rect and round");
  const a = size.width / 1000;
  const b = size.height / 1000;
  return { area: a * b, dh: (2 * a * b) / (a + b) };
}

/** Colebrook by bisection on 1/√f: a different solve from the engine's fixed-point iteration. */
function colebrook(re: number, rel: number): number {
  let lo = 1;
  let hi = 30;
  for (let i = 0; i < 200; i++) {
    const x = (lo + hi) / 2;
    const g = x + 2 * Math.log10(rel / 3.7 + (2.51 * x) / re);
    if (g > 0) hi = x;
    else lo = x;
  }
  const x = (lo + hi) / 2;
  return 1 / (x * x);
}

function vp(cfm: number, size: RunSize): number {
  const v = (cfm * M3S_PER_CFM) / section(size).area;
  return (RHO * v * v) / 2;
}

function darcy(cfm: number, size: RunSize, lengthM: number): number {
  const s = section(size);
  const v = (cfm * M3S_PER_CFM) / s.area;
  const re = (RHO * v * s.dh) / MU;
  return colebrook(re, EPS / s.dh) * (lengthM / s.dh) * ((RHO * v * v) / 2);
}

describe("straight duct friction", () => {
  it("matches the hand Colebrook solve, and a friction chart: 10\" round at 400 CFM is about 0.085 in. w.c. / 100 ft", () => {
    const air = airProperties(0, 20);
    expect(air.densityKgM3).toBeCloseTo(RHO, 6);
    expect(air.viscosityPaS).toBeCloseTo(MU, 10);
    const ten: RunSize = { shape: "round", diameter: 10 * IN };
    const rate = frictionRate(400, ten, air, 0.09);
    expect(rate).toBeCloseTo(darcy(400, ten, 1), 6);
    const inPer100ft = (rate * 30.48) / PA_PER_IN_WC;
    expect(inPer100ft).toBeGreaterThan(0.075);
    expect(inPer100ft).toBeLessThan(0.095);
    // Altitude thins the air: at 5,000 ft the same duct loses about 16% less.
    expect(frictionRate(400, ten, airProperties(1524, 20), 0.09) / rate).toBeCloseTo(0.84, 1);
  });
});

// ------------------------------------------------------------------ a small system

const RTU = builtinPartType("builtin:rtu-5-ton@1");
const SD = builtinPartType("builtin:supply-diffuser-24@1");
let n = 0;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `p-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-10-19T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const TRUNK: RunSize = { shape: "rect", width: 14 * IN, height: 10 * IN };
const BRANCH: RunSize = { shape: "round", diameter: 8 * IN };

/** RTU-1 → 14x10 trunk → SD-1 at its end; a conical tap off the trunk → 8" branch → SD-2. Optionally a second system from RTU-2. */
function system(withSecond = false): ModelState {
  if (!RTU || !SD) throw new Error("starter library");
  let m: ModelState = { modelId: "p", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "rtu", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" });
  m = commit(m, { type: "place_part", partId: "sd-a", typeId: SD.id, partType: SD.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" });
  m = commit(m, { type: "place_part", partId: "sd-b", typeId: SD.id, levelId: "lvl-1", position: { x: 10 * FT, y: 6 * FT }, offsetMm: 8 * FT, mark: "SD-2" });
  const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
  m = commit(m, { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd-a", connectorId: "neck" } });
  m = commit(m, { type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 10 * FT, system: SA, points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 6 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
  if (withSecond) {
    m = commit(m, { type: "place_part", partId: "rtu-2", typeId: RTU.id, levelId: "lvl-1", position: { x: 0, y: 40 * FT }, offsetMm: 12 * FT, mark: "RTU-2" });
    m = commit(m, { type: "place_part", partId: "sd-c", typeId: SD.id, levelId: "lvl-1", position: { x: 15 * FT, y: 40 * FT }, offsetMm: 8 * FT, mark: "SD-3" });
    m = commit(m, { type: "route_run", idPrefix: "two", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: { id: "sys-2", kind: "supply_air", name: "Supply Air 2" }, points: [], from: { kind: "part", partId: "rtu-2", connectorId: "supply" }, to: { kind: "part", partId: "sd-c", connectorId: "neck" } });
  }
  return m;
}

describe("a system's pressure, by hand", () => {
  const m = system();
  const report = systemPressure(m, "sys-sa");
  if (!report) throw new Error("no report");
  const seg = (id: string) => {
    const el = m.elements[id];
    if (el?.kind !== "run_segment") throw new Error(id);
    return el;
  };
  const flow = (id: string) => {
    const e = report.elements[id];
    if (e?.kind !== "segment") throw new Error(id);
    return e;
  };
  const fitting = (id: string) => {
    const e = report.elements[id];
    if (e?.kind !== "fitting") throw new Error(id);
    return e;
  };

  it("loads come from the diffusers; the fan is RTU-1", () => {
    expect(report.hasFan).toBe(true);
    expect(report.rootLabel).toBe("RTU-1");
    expect(flow("trunk-s2").flowCfm).toBe(300);
    expect(flow("br-s1").flowCfm).toBe(150);
    // After the tap the trunk carries only SD-1's share.
    expect(flow("trunk-s2").stretches.map((s) => s.flowCfm)).toEqual([300, 150]);
  });

  it("each piece on the path to SD-2 equals the hand calculation", () => {
    // Branch leg 1: 1651 mm centreline, less the conical tap's 4" and the 5-gore r/D 1.5 elbow's 12".
    const l1 = (1828.8 - 177.8 - 101.6 - 304.8) / 1000;
    expect(flow("br-s1").straightLengthMm).toBeCloseTo(l1 * 1000, 1);
    expect(flow("br-s1").lossPa).toBeCloseTo(darcy(150, BRANCH, l1), 3);
    // 5-gore round elbow, r/D 1.5, 90°: 0.21 / √1.5 x (1 + 1.6 / 4).
    const cGored = (0.21 / Math.sqrt(1.5)) * 1.4;
    expect(fitting("br-f1").paths[0]?.c).toBeCloseTo(cGored, 4);
    expect(fitting("br-f1").lossPa).toBeCloseTo(cGored * vp(150, BRANCH), 3);
    // Conical tap: 0.65 (1 + r²) / r², r = Vb / Vc at the takeoff (trunk carries 300 CFM there).
    const r = 150 / section(BRANCH).area / (300 / section(TRUNK).area);
    const cTap = (0.65 * (1 + r * r)) / (r * r);
    const tap = fitting("br-f3").paths.find((p) => p.role === "branch");
    expect(tap?.c).toBeCloseTo(cTap, 3);
    expect(tap?.lossPa).toBeCloseTo(cTap * vp(150, BRANCH), 3);
    // Trunk radius elbow turning down: r/W 1 on the 10" height; aspect 14/10 → Idelchik C1 between 1.0 (1.00) and 1.5 (0.90): 0.92.
    const cElbow = 0.21 * 0.92;
    expect(fitting("trunk-f1").paths[0]?.c).toBeCloseTo(cElbow, 4);
    // Trunk to the tap: the straight piece from the elbow's 10" takeoff to the tap at 8 ft, at 300 CFM.
    const trunk = seg("trunk-s2");
    const toTap = (2438.4 - trunk.start.x - straightPiece(m.elements, trunk).cutStart) / 1000;
    const step = report.criticalPath.find((s) => s.elementId === "trunk-s2");
    expect(step?.lossPa).toBeCloseTo(darcy(300, TRUNK, toTap), 3);
  });

  it("the critical path is the one to SD-2; its total is the fan's ESP", () => {
    const last = report.criticalPath[report.criticalPath.length - 1];
    expect(last?.elementId).toBe("br-s3");
    const sum = report.criticalPath.reduce((a, s) => a + s.lossPa, 0);
    expect(report.totalPa).toBeCloseTo(sum, 2);
    expect(last?.cumulativePa).toBeCloseTo(report.totalPa, 2);
    expect(report.requiredEspInWc).toBeCloseTo(report.totalPa / PA_PER_IN_WC, 4);
    const ends = Object.fromEntries(report.ends.map((e) => [e.label, e.pathPa]));
    expect(ends["SD-2"]).toBeGreaterThan(ends["SD-1"] ?? Infinity);
    expect(report.requiredEspPa).toBeCloseTo(ends["SD-2"] ?? 0, 3);
    // Every fitting on the path is labelled with where its C came from.
    for (const s of report.criticalPath) {
      const e = report.elements[s.elementId];
      if (e?.kind === "fitting") for (const p of e.paths) expect(p.source.label).toBe("Formula, verify for permit work");
    }
  });

  it("design air at altitude lowers every loss; galvanized vs lined duct changes friction, not fittings", () => {
    const high = commit(m, { type: "set_system_design", systemId: "sys-sa", design: { altitudeM: 1524 } });
    const hi = systemPressure(high, "sys-sa");
    expect(hi?.air.densityKgM3).toBeLessThan(report.air.densityKgM3);
    expect(hi?.totalPa).toBeLessThan(report.totalPa);
    const lined = systemPressure(commit(m, { type: "set_system_design", systemId: "sys-sa", design: { material: "lined" } }), "sys-sa");
    expect(lined?.elements["br-s1"]?.lossPa).toBeGreaterThan(flow("br-s1").lossPa);
    expect(lined?.elements["br-f1"]?.lossPa).toBeCloseTo(fitting("br-f1").lossPa, 6);
  });

  it("a project coefficient table on the system replaces the formula, and says so", () => {
    const withTable = commit(m, {
      type: "set_system_design",
      systemId: "sys-sa",
      coefficientTable: { id: "proj", label: "7301 test data", scope: "project", entries: [{ family: "duct.elbow.gored", role: "body", c: 0.5, note: "Shop test" }] },
    });
    const e = systemPressure(withTable, "sys-sa")?.elements["br-f1"];
    expect(e?.kind === "fitting" && e.paths[0]).toMatchObject({ c: 0.5, source: { kind: "table", label: "Project table: 7301 test data" }, verify: false });
  });

  it("an unknown system has no report", () => {
    expect(systemPressure(m, "nope")).toBeNull();
  });
});

describe("incremental recalculation", () => {
  it("reuses a system's report until one of its elements changes; an edit elsewhere never touches it", () => {
    const m = system(true);
    const engine = new PressureEngine();
    const a1 = engine.report(m, "sys-sa", "trunk-s2");
    const b1 = engine.report(m, "sys-2", "two-s2");
    expect(engine.stats).toMatchObject({ computed: 2, reused: 0, scans: 0 });
    expect(engine.report(m, "sys-sa")).toBe(a1);
    expect(engine.stats.reused).toBe(1);
    // Swap an elbow on system A.
    const edited = commit(m, { type: "swap_fitting", fittingId: "br-f1", family: "duct.elbow.mitred" });
    const b2 = engine.report(edited, "sys-2");
    expect(b2).toBe(b1);
    const a2 = engine.report(edited, "sys-sa");
    expect(a2).not.toBe(a1);
    expect(engine.stats).toMatchObject({ computed: 3, reused: 2, scans: 0 });
    // Only the elbow and the two legs it shortens (a mitre reaches 4" into them, the gored elbow 12") changed;
    // the total moved by exactly their change.
    const touched = ["br-f1", "br-s1", "br-s2"];
    const delta = touched.reduce((d, id) => d + (a2?.elements[id]?.lossPa ?? 0) - (a1?.elements[id]?.lossPa ?? 0), 0);
    expect((a2?.elements["br-f1"]?.lossPa ?? 0) / (a1?.elements["br-f1"]?.lossPa ?? 1)).toBeCloseTo((1.2 * 0.9875) / 0.24, 2); // round mitre (Idelchik 6-5) over a 5-gore r/D 1.5 elbow (Locklin)
    expect((a2?.totalPa ?? 0) - (a1?.totalPa ?? 0)).toBeCloseTo(delta, 3);
    for (const id of Object.keys(a1?.elements ?? {})) if (!touched.includes(id)) expect(a2?.elements[id]?.lossPa).toBeCloseTo(a1?.elements[id]?.lossPa ?? NaN, 6);
  });

  it("asked by system id, starts from the run the system recorded; scans once only after that run is deleted", () => {
    const m = system(true);
    const engine = new PressureEngine();
    expect(m.elements["sys-sa"]).toMatchObject({ entryId: "trunk-s1" });
    engine.report(m, "sys-sa");
    engine.report(m, "sys-2");
    expect(engine.stats.scans).toBe(0);
    const edited = commit(m, { type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 18 * IN, height: 10 * IN } });
    const after = engine.report(edited, "sys-sa");
    expect(engine.stats.scans).toBe(0);
    expect(after?.elements["trunk-s2"]?.lossPa).toBeLessThan(engine.report(m, "sys-sa")?.elements["trunk-s2"]?.lossPa ?? 0);
    // The recorded run goes: one scan finds another run of the system, and that is remembered.
    const cut = commit(edited, { type: "delete_elements", ids: ["trunk-s1"], policy: "disconnect" });
    const fresh = new PressureEngine();
    expect(fresh.report(cut, "sys-sa")?.calculable).toBe(true);
    fresh.report(cut, "sys-sa");
    expect(fresh.stats.scans).toBe(1);
  });
});
