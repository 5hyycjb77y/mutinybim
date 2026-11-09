/**
 * @jest-environment node
 *
 * Pipe fitting library and hydraulics: dimension data, family geometry and
 * take-outs, drainage direction and slope rules (allowed and refused), and
 * Hazen-Williams, Manning and Spitzglass / Mueller results checked against
 * hand calculations written out here, independent of the engine. Before
 * this, pipe fittings had no geometry, no rules and no hydraulics at all.
 */
import { DEFAULT_SETTINGS, fittingFamilies, pipeProducts, builtinPartType, fittingBody, fittingFamily, fittingMesh, pipeDims, pipeFamilyMismatch, planCommit, resolveParams, slopeInPerFt, straightPiece, validateModel, type BimElement, type Command, type ElementId, type MepSystem, type ModelState, type PartTypeDefinition, type RunFitting, type RunSegment, type RunSize } from "../src";
import { PipeHydraulicsEngine, directionIssue, hunterStyleGpm, manningGpm, partFull, spitzglassDropInWc, muellerDropInWc, hazenWilliamsPsiPer100Ft, stackCapacityGpm, waterDensity } from "@permitzip/bim-pack-plumbing";

const FT = 304.8;
const IN = 25.4;
const PSI = 6894.757;

let n = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `pipe-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-10-19T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function refusal(model: ModelState, command: Command): string {
  const d = planCommit(model, [], { idempotencyKey: `pipe-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-10-19T00:00:00.000Z");
  if (d.ok) throw new Error(`${command.type} was expected to be refused`);
  return d.error.message;
}

function emptyModel(): ModelState {
  let m: ModelState = { modelId: "pipe", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return m;
}

const seg = (m: ModelState, id: string): RunSegment => {
  const el = m.elements[id];
  if (el?.kind !== "run_segment") throw new Error(`${id} is not a segment`);
  return el;
};
const fit = (m: ModelState, id: string): RunFitting => {
  const el = m.elements[id];
  if (el?.kind !== "run_fitting") throw new Error(`${id} is not a fitting`);
  return el;
};
const fittingsOf = (m: ModelState, systemId: string): RunFitting[] => Object.values(m.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.systemId === systemId);

/** A one-connector part type: a source (category mechanical equipment) or a fixture / appliance. */
function partType(name: string, category: PartTypeDefinition["category"], systemKind: "domestic_cold_water" | "natural_gas", direction: [number, number, number], diameterMm: number, extra: { flow?: number; mbh?: number } = {}): PartTypeDefinition {
  return {
    familyName: name,
    typeName: "Test",
    category,
    typeParams: extra.mbh !== undefined ? [{ name: "input_mbh", label: "Input (MBH)", kind: "number", unit: "none", min: 0 }] : [],
    typeValues: extra.mbh !== undefined ? { input_mbh: extra.mbh } : {},
    instanceParams: [],
    connectors: [{ id: "c", label: "Connection", domain: "pipe", systemKind, position: [0, 0, 0], direction, shape: "round", diameter: diameterMm, ...(extra.flow !== undefined ? { flow: extra.flow } : {}) }],
    geometry: [{ kind: "box", center: [0, 0, 100], size: [200, 200, 200] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [200, 200] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  };
}

// ------------------------------------------------------------------ dimension data

describe("pipe dimension data (published dimensional standards)", () => {
  it("copper tube follows ASTM B88: OD is nominal + 1/8\", walls K > L > M, ID = OD - 2 x wall", () => {
    const k = pipeProducts().find((s) => s.spec === "type_k");
    const l = pipeProducts().find((s) => s.spec === "type_l");
    const mm = pipeProducts().find((s) => s.spec === "type_m");
    if (!k || !l || !mm) throw new Error("copper specs");
    for (const row of l.sizes) expect(row.odMm).toBeCloseTo((row.nominalIn + 0.125) * IN, 2);
    l.sizes.forEach((row, i) => {
      expect(k.sizes[i]?.wallMm ?? 0).toBeGreaterThan(row.wallMm);
      expect(row.wallMm).toBeGreaterThan(mm.sizes[i]?.wallMm ?? Infinity);
    });
    // 1" type L: 1.125" OD, 0.050" wall, 1.025" ID.
    expect(pipeDims({ shape: "pipe", nominalMm: IN, material: "copper" })).toEqual({ odMm: 28.575, idMm: 26.035, listed: true });
  });

  it("schedule 40 matches ASME B36.10M (2\": 2.375\" OD, 0.154\" wall), no-hub cast iron CISPI 301 (4\": 4.38\" OD)", () => {
    expect(pipeDims({ shape: "pipe", nominalMm: 2 * IN, material: "black_steel" }).idMm).toBeCloseTo((2.375 - 2 * 0.154) * IN, 2);
    expect(pipeDims({ shape: "pipe", nominalMm: 4 * IN, material: "pvc" }).idMm).toBeCloseTo(4.026 * IN, 2);
    expect(pipeDims({ shape: "pipe", nominalMm: 4 * IN, material: "cast_iron" }).odMm).toBeCloseTo(4.38 * IN, 2);
    expect(pipeDims({ shape: "pipe", nominalMm: 4 * IN, material: "cast_iron", spec: "service_weight" }).odMm).toBeCloseTo(4.3 * IN, 2);
  });

  it("every spec: sizes ascending, 0 < ID < OD, positive roughness and C, a default joint it actually takes", () => {
    for (const spec of pipeProducts()) {
      expect(spec.sizes.length).toBeGreaterThan(0);
      spec.sizes.forEach((row, i) => {
        expect(row.idMm).toBeGreaterThan(0);
        expect(row.idMm).toBeLessThan(row.odMm);
        expect(row.wallMm).toBeGreaterThan(0);
        if (i > 0) expect(row.nominalIn).toBeGreaterThan(spec.sizes[i - 1]?.nominalIn ?? 0);
      });
      expect(spec.roughnessMm).toBeGreaterThan(0);
      expect(spec.hazenWilliamsC).toBeGreaterThan(0);
      expect(spec.endTypes).toContain(spec.defaultEndType);
    }
  });
});

// ------------------------------------------------------------------ families and geometry

const PIPE_FAMILIES = fittingFamilies().filter((f) => f.domain === "pipe");

function syntheticElements(material: "copper" | "pvc" | "black_steel" | "csst", kind: MepSystem["systemKind"]): { elements: Record<string, BimElement>; system: MepSystem; host: RunSegment; branchSeg: RunSegment } {
  const size: RunSize = { shape: "pipe", nominalMm: 2 * IN, material };
  const base = { version: 0, authoredRev: {}, domain: "pipe" as const, systemId: "sys" as ElementId, levelId: "lvl" as ElementId };
  const system: MepSystem = { id: "sys" as ElementId, kind: "mep_system", version: 0, authoredRev: {}, name: "S", systemKind: kind, domain: "pipe" };
  const host: RunSegment = { ...base, id: "host" as ElementId, kind: "run_segment", start: { x: 0, y: 0, z: 0 }, end: { x: 3000, y: 0, z: 0 }, size, links: {}, branches: ["f" as ElementId], flow: 0 };
  const branchSeg: RunSegment = { ...base, id: "b" as ElementId, kind: "run_segment", start: { x: 1500, y: 0, z: 0 }, end: { x: 1500, y: 2000, z: 0 }, size, links: { start: { elementId: "f" as ElementId, port: "branch" } }, branches: [], flow: 0 };
  return { elements: { sys: system, host, b: branchSeg }, system, host, branchSeg };
}

describe("pipe fitting families as data", () => {
  it("every pipe family offers a joint, has materials and services, and a parametric take-out", () => {
    expect(PIPE_FAMILIES.length).toBeGreaterThan(35);
    for (const f of PIPE_FAMILIES) {
      expect(f.pipe).toBeDefined();
      expect(f.pipe?.materials.length).toBeGreaterThan(0);
      expect(f.pipe?.services.length).toBeGreaterThan(0);
      expect(f.params.find((p) => p.key === "joint")?.kind).toBe("choice");
      expect(f.params.some((p) => p.key === "takeout_mm")).toBe(true);
    }
    const ids = PIPE_FAMILIES.map((f) => f.id);
    for (const want of ["dwv.sanitary_tee", "dwv.combo_wye_eighth", "dwv.quarter_bend_long_sweep", "dwv.quarter_bend_short_sweep", "dwv.eighth_bend", "dwv.sixteenth_bend", "dwv.closet_bend", "dwv.cleanout_tee", "dwv.p_trap", "dwv.vent_tee", "dwv.test_tee", "pipe.water.elbow_90", "pipe.water.tee", "pipe.valve.ball", "pipe.valve.prv", "pipe.gas.drip_leg", "pipe.gas.cock", "pipe.gas.csst_tee"]) {
      expect(ids).toContain(want);
    }
  });

  it("bends: take-out R tan(θ/2) with R = r/D x OD, ports on the body's faces, a closed mesh", () => {
    for (const fam of PIPE_FAMILIES.filter((f) => f.pipe?.form === "bend")) {
      const material = fam.pipe?.materials.includes("copper") ? "copper" : fam.pipe?.materials.includes("pvc") ? "pvc" : fam.pipe?.materials[0] === "csst" ? "csst" : "black_steel";
      const { elements } = syntheticElements(material, "other");
      const angle = fam.angles === "45" ? 45 : fam.angles === "22.5" ? 22.5 : 90;
      const rad = (angle * Math.PI) / 180;
      const size: RunSize = { shape: "pipe", nominalMm: (fam.pipe?.sizesIn?.min ?? 2) * IN, material };
      const f: RunFitting = {
        id: "e" as ElementId, kind: "run_fitting", version: 0, authoredRev: {}, fittingType: "elbow", label: fam.name, domain: "pipe", systemId: "sys" as ElementId, levelId: "lvl" as ElementId,
        position: { x: 0, y: 0, z: 0 }, angleDeg: angle,
        ports: [{ id: "a", position: { x: 0, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 }, size }, { id: "b", position: { x: 0, y: 0, z: 0 }, direction: { x: Math.cos(Math.PI - rad) * -1, y: Math.sin(rad), z: 0 }, size }],
        family: fam.id, params: resolveParams(fam, undefined),
      };
      const body = fittingBody(elements, f);
      const od = pipeDims(size).odMm;
      const want = (fam.pipe?.rOverD ?? 1) * od * Math.tan(rad / 2);
      expect(body.takeoffs.a).toBeCloseTo(want, 3);
      expect(body.takeoffs.b).toBeCloseTo(want, 3);
      expect(Object.keys(body.faces).sort()).toEqual(["a", "b"]);
      expect(fittingMesh(body).indices.length).toBeGreaterThan(0);
    }
  });

  it("tees and inline items: the branch's take-out, the item's laying length, geometry for every accessory", () => {
    for (const fam of PIPE_FAMILIES.filter((f) => f.pipe?.form === "tee" || f.fittingTypes.includes("accessory"))) {
      const material = fam.pipe?.materials.includes("copper") ? "copper" : fam.pipe?.materials.includes("pvc") ? "pvc" : fam.pipe?.materials[0] === "csst" ? "csst" : "black_steel";
      const { elements, branchSeg } = syntheticElements(material, "other");
      const accessory = fam.fittingTypes.includes("accessory");
      const size = branchSeg.size;
      if (size.shape !== "pipe") throw new Error("pipe");
      const f: RunFitting = {
        id: "f" as ElementId, kind: "run_fitting", version: 0, authoredRev: {}, fittingType: accessory ? "accessory" : "tee", label: fam.name, domain: "pipe", systemId: "sys" as ElementId, levelId: "lvl" as ElementId,
        position: { x: 1500, y: 0, z: 0 }, host: { segmentId: "host" as ElementId, s: 1500, side: 1 },
        ports: accessory ? [] : [{ id: "branch", position: { x: 1500, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, size, link: { elementId: "b" as ElementId, port: "start" } }],
        family: fam.id, params: resolveParams(fam, undefined),
      };
      elements.f = f;
      const body = fittingBody(elements, f);
      const od = pipeDims(size).odMm;
      expect(fittingMesh(body).indices.length).toBeGreaterThan(0);
      if (accessory) {
        expect(body.lengthMm).toBeCloseTo((fam.pipe?.layingOverOd ?? 1) * od, 3);
      } else {
        expect(body.takeoffs.branch).toBeGreaterThanOrEqual(0.5 * od);
        // The branch segment's straight pipe starts after the tee's take-out.
        expect(straightPiece(elements, branchSeg).cutStart).toBeCloseTo(body.takeoffs.branch ?? -1, 6);
      }
    }
  });

  it("an engineer's own take-out wins over the generic proportion", () => {
    const fam = fittingFamily("pipe.water.elbow_90");
    if (!fam) throw new Error("family");
    const { elements } = syntheticElements("copper", "domestic_cold_water");
    const size: RunSize = { shape: "pipe", nominalMm: IN, material: "copper" };
    const f: RunFitting = {
      id: "e" as ElementId, kind: "run_fitting", version: 0, authoredRev: {}, fittingType: "elbow", label: "x", domain: "pipe", systemId: "sys" as ElementId, levelId: "lvl" as ElementId, position: { x: 0, y: 0, z: 0 }, angleDeg: 90,
      ports: [{ id: "a", position: { x: 0, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 }, size }, { id: "b", position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, size }],
      family: fam.id, params: resolveParams(fam, { takeout_mm: 40 }),
    };
    expect(fittingBody(elements, f).takeoffs.a).toBe(40);
  });
});

// ------------------------------------------------------------------ drainage direction rules

describe("drainage fittings by direction change (general practice, overridable)", () => {
  const fam = (id: string) => {
    const f = fittingFamily(id);
    if (!f) throw new Error(id);
    return f;
  };

  it("a sanitary tee takes horizontal-to-vertical only; horizontal-to-horizontal names the combination wye", () => {
    expect(directionIssue(fam("dwv.sanitary_tee"), "hv", 3, undefined, "branch")).toBeNull();
    expect(directionIssue(fam("dwv.sanitary_tee"), "hh", 3, undefined, "branch")).toBe("A sanitary tee can't take flow horizontal to horizontal; use a combination wye & 1/8 bend");
    expect(directionIssue(fam("dwv.sanitary_tee"), "vh", 3, undefined, "branch")).toMatch(/can't take flow vertical to horizontal; use a combination wye & 1\/8 bend/);
    for (const t of ["hv", "vh", "hh"] as const) expect(directionIssue(fam("dwv.combo_wye_eighth"), t, 4, undefined, "branch")).toBeNull();
  });

  it("turns: long sweep anywhere; short sweep vertical-to-horizontal from 3\"; a tight 1/4 bend only on small fixture drains", () => {
    for (const t of ["hv", "vh", "hh"] as const) expect(directionIssue(fam("dwv.quarter_bend_long_sweep"), t, 4, undefined, "turn")).toBeNull();
    expect(directionIssue(fam("dwv.quarter_bend_short_sweep"), "vh", 4, undefined, "turn")).toBeNull();
    expect(directionIssue(fam("dwv.quarter_bend_short_sweep"), "vh", 2, undefined, "turn")).toBe("A 1/4 bend, short sweep can't take flow vertical to horizontal here (only at 3\" and larger; this is 2\"); use a 1/4 bend, long sweep");
    expect(directionIssue(fam("dwv.quarter_bend"), "hh", 2, undefined, "turn")).toBeNull();
    expect(directionIssue(fam("dwv.quarter_bend"), "hh", 3, undefined, "turn")).toMatch(/only up to 2"; this is 3"/);
  });

  it("a project can override a rule; a vent tee refuses drainage; a 45° wye refuses a square branch", () => {
    expect(directionIssue(fam("dwv.sanitary_tee"), "hh", 3, { directionRules: [{ family: "dwv.sanitary_tee", hh: true }] }, "branch")).toBeNull();
    expect(pipeFamilyMismatch(fam("dwv.vent_tee"), { fittingType: "tee", sizes: [{ shape: "pipe", nominalMm: 2 * IN, material: "pvc" }], systemKind: "sanitary" })).toMatch(/has no sweep, so it can't take drainage/);
    expect(pipeFamilyMismatch(fam("dwv.vent_tee"), { fittingType: "tee", sizes: [{ shape: "pipe", nominalMm: 2 * IN, material: "pvc" }], systemKind: "vent" })).toBeNull();
    expect(pipeFamilyMismatch(fam("dwv.wye"), { fittingType: "wye", sizes: [{ shape: "pipe", nominalMm: 2 * IN, material: "pvc" }], systemKind: "sanitary" })).toMatch(/takes its branch at 45°; this branch leaves square to the run, so use a combination wye/);
    expect(pipeFamilyMismatch(fam("pipe.water.elbow_90"), { fittingType: "elbow", sizes: [{ shape: "pipe", nominalMm: 2 * IN, material: "pvc" }], systemKind: "sanitary" })).toBe("90° elbow, short radius is a water fitting; this system carries drainage");
    expect(pipeFamilyMismatch(fam("pipe.water.elbow_90"), { fittingType: "elbow", sizes: [{ shape: "pipe", nominalMm: 1 * IN, material: "csst" }], systemKind: "domestic_cold_water" })).toBe("90° elbow, short radius isn't made for csst pipe");
    expect(pipeFamilyMismatch(fam("dwv.closet_bend"), { fittingType: "elbow", sizes: [{ shape: "pipe", nominalMm: 2 * IN, material: "pvc" }] })).toMatch(/made 3" and larger/);
  });
});

// ------------------------------------------------------------------ a drainage system: slope, routing rules, Manning

const WC = builtinPartType("builtin:water-closet-floor@1");
const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
const pvc = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "pvc" });

/** 4" main below the slab falling east; a closet's 3" waste drops and runs level into it; a 4" stack with a 2" arm. */
function drainage(): ModelState {
  if (!WC) throw new Error("starter library");
  let m = emptyModel();
  m = commit(m, { type: "place_part", partId: "wc", typeId: WC.id, partType: WC.definition, levelId: "lvl-1", position: { x: 0, y: 10 * FT }, offsetMm: 0, mark: "WC-1" });
  m = commit(m, { type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -2 * FT, system: SAN, points: [{ x: -10 * FT, y: 8 * FT }, { x: 10 * FT, y: 8 * FT }] });
  m = commit(m, { type: "route_run", idPrefix: "wcb", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: -2 * FT, system: SAN, points: [{ x: -150, y: 10 * FT }, { x: -150, y: 8 * FT }], from: { kind: "part", partId: "wc", connectorId: "waste" }, to: { kind: "run_branch", segmentId: "main-s1" } });
  m = commit(m, { type: "route_run", idPrefix: "stack", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: 10 * FT, system: SAN, points: [{ x: 20 * FT, y: 0 }, { x: 20 * FT, y: 0, elevationMm: -2 * FT }] });
  m = commit(m, { type: "route_run", idPrefix: "arm", levelId: "lvl-1", domain: "pipe", size: pvc(2), elevationMm: 4 * FT, system: SAN, points: [{ x: 26 * FT, y: 0 }, { x: 20 * FT, y: 0 }], to: { kind: "run_branch", segmentId: "stack-s1" } });
  return m;
}

describe("routing drainage: slope, flow direction and the fitting each change of direction takes", () => {
  const m = drainage();

  it("level legs fall at the system's minimum: 1/8\" per ft for 4\", 1/4\" per ft for 3\" and smaller, towards the flow", () => {
    expect(slopeInPerFt(seg(m, "main-s1"))).toBeCloseTo(0.125, 4);
    expect(seg(m, "main-s1").start.z).toBeGreaterThan(seg(m, "main-s1").end.z);
    expect(slopeInPerFt(seg(m, "arm-s1"))).toBeCloseTo(0.25, 4);
    // The arm keeps its start height and drops 6 ft x 1/4" = 1.5" to where it meets the stack.
    expect(seg(m, "arm-s1").start.z - seg(m, "arm-s1").end.z).toBeCloseTo(1.5 * IN, 2);
    expect(validateModel(m)).toEqual([]);
  });

  it("a horizontal arm into a stack gets a sanitary tee, placed where the slope meets the stack", () => {
    const tee = fittingsOf(m, "sys-san").find((f) => f.host?.segmentId === "stack-s1");
    expect(tee?.family).toBe("dwv.sanitary_tee");
    expect(tee?.label).toBe("Sanitary tee");
    expect(tee?.host?.s).toBeCloseTo(6 * FT + 1.5 * IN, 1);
    expect(tee?.host?.dir).toEqual({ x: 1, y: 0 });
    // A horizontal branch into a horizontal main gets a combination wye & 1/8 bend; the closet's drop turns level on a long sweep.
    expect(fittingsOf(m, "sys-san").find((f) => f.host?.segmentId === "main-s1")?.family).toBe("dwv.combo_wye_eighth");
    expect(fittingsOf(m, "sys-san").find((f) => f.fittingType === "elbow")?.family).toBe("dwv.quarter_bend_long_sweep");
  });

  it("swaps are checked against the direction change: refused with the fitting to use instead", () => {
    const wye = fittingsOf(m, "sys-san").find((f) => f.host?.segmentId === "main-s1");
    const turn = fittingsOf(m, "sys-san").find((f) => f.fittingType === "elbow");
    if (!wye || !turn) throw new Error("fixture");
    expect(refusal(m, { type: "swap_fitting", fittingId: wye.id, family: "dwv.sanitary_tee" })).toBe("A sanitary tee can't take flow horizontal to horizontal; use a combination wye & 1/8 bend");
    expect(refusal(m, { type: "swap_fitting", fittingId: turn.id, family: "dwv.quarter_bend" })).toMatch(/can't take flow vertical to horizontal here \(only up to 2"; this is 3"\); use a 1\/4 bend, long sweep/);
    expect(refusal(m, { type: "swap_fitting", fittingId: wye.id, family: "dwv.vent_tee" })).toMatch(/has no sweep, so it can't take drainage/);
    expect(refusal(m, { type: "swap_fitting", fittingId: turn.id, family: "pipe.water.elbow_90" })).toMatch(/is a water fitting; this system carries drainage$/);
    // Allowed: a 3" short sweep from vertical to horizontal; a combination wye into the stack.
    expect(fit(commit(m, { type: "swap_fitting", fittingId: turn.id, family: "dwv.quarter_bend_short_sweep" }), turn.id).family).toBe("dwv.quarter_bend_short_sweep");
    const tee = fittingsOf(m, "sys-san").find((f) => f.host?.segmentId === "stack-s1");
    if (!tee) throw new Error("fixture");
    expect(fit(commit(m, { type: "swap_fitting", fittingId: tee.id, family: "dwv.combo_wye_eighth" }), tee.id).label).toBe("Combination wye & 1/8 bend");
  });

  it("slope is enforced: flatter than the minimum is refused, set_slope re-pitches and what is connected follows", () => {
    expect(refusal(m, { type: "route_run", idPrefix: "flat", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: -3 * FT, system: SAN, points: [{ x: 0, y: -10 * FT }, { x: 10 * FT, y: -10 * FT }], slopeInPerFt: 0.125 })).toBe(
      "1/8\" per ft is flatter than the 1/4\" per ft Sanitary needs for 3\" pipe; change the system's slope rule to go flatter",
    );
    expect(refusal(m, { type: "set_slope", segmentId: "main-s1", inPerFt: 0.0625 })).toMatch(/1\/16" per ft is flatter than the 1\/8" per ft Sanitary needs for 4" pipe/);
    const before = seg(m, "main-s1");
    const steep = commit(m, { type: "set_slope", segmentId: "main-s1", inPerFt: 0.25 });
    expect(slopeInPerFt(seg(steep, "main-s1"))).toBeCloseTo(0.25, 4);
    expect(seg(steep, "main-s1").start.z).toBeCloseTo(before.start.z, 3);
    // The closet's branch rides down with the wye on the main.
    const wye = fittingsOf(steep, "sys-san").find((f) => f.host?.segmentId === "main-s1");
    const arm = Object.values(steep.elements).find((e): e is RunSegment => e.kind === "run_segment" && e.links.end?.elementId === wye?.id);
    expect(arm && wye ? arm.end.z : NaN).toBeCloseTo(wye?.position.z ?? 0, 3);
    expect(validateModel(steep)).toEqual([]);
  });

  it("flow direction is enforced: a branch sloped away from the run it drains into is refused", () => {
    const arm = Object.values(m.elements).find((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith("wcb") && Math.abs(e.start.z - e.end.z) < 100 && Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) > 100);
    if (!arm) throw new Error("fixture");
    expect(refusal(m, { type: "set_slope", segmentId: arm.id, flow: "toward_start", keep: "upstream" })).toMatch(/slopes away from the|slopes down into the/);
  });

  it("a level drain is a validation issue in words, not a silent number", () => {
    let flat = emptyModel();
    flat = commit(flat, { type: "route_run", idPrefix: "x", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: 0, system: SAN, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    // The project allows level drains, so a level run is routed; then the rule goes back to 1/4" per ft.
    flat = commit(flat, { type: "set_system_design", systemId: "sys-san", design: { pipe: { slopes: [{ maxNominalIn: 1000, inPerFt: 0 }] } } });
    flat = commit(flat, { type: "route_run", idPrefix: "y", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: 0, system: SAN, points: [{ x: 0, y: 5 * FT }, { x: 10 * FT, y: 5 * FT }] });
    expect(slopeInPerFt(seg(flat, "y-s1"))).toBe(0);
    const sys = flat.elements["sys-san"];
    if (sys?.kind !== "mep_system") throw new Error("system");
    const back: ModelState = { ...flat, elements: { ...flat.elements, "sys-san": { ...sys, design: { pipe: {} } } } };
    expect(validateModel(back).map((i) => i.message)).toContain("The 3\" PVC sanitary pipe is level; 3\" Sanitary drains need at least 1/4\" per ft. Slope it (set_slope), or change the system's slope rule");
  });

  it("a leg too short for its real fittings is refused, creating nothing", () => {
    const why = refusal(m, { type: "route_run", idPrefix: "tight", levelId: "lvl-1", domain: "pipe", size: pvc(4), elevationMm: -4 * FT, system: SAN, points: [{ x: 0, y: -20 * FT }, { x: 10 * FT, y: -20 * FT }, { x: 10 * FT, y: -20 * FT + 8 * IN }, { x: 20 * FT, y: -20 * FT + 8 * IN }] });
    expect(why).toMatch(/^Leg 2 is 0\.\d+ ft long, but the two elbows there need \d+\.\d+ ft\. Move the point or pick a shorter fitting\.$/);
  });

  it("Manning's equation by hand: 4\" PVC (4.026\" bore), 1/8\" per ft, n 0.010, half full", () => {
    const d = 4.026 / 12;
    const area = (Math.PI * d * d) / 8;
    const v = (1.486 / 0.01) * (d / 4) ** (2 / 3) * Math.sqrt(0.125 / 12);
    expect(partFull(d, 0.5).area).toBeCloseTo(area, 8);
    expect(partFull(d, 0.5).hydraulicRadius).toBeCloseTo(d / 4, 8);
    const q = manningGpm(4.026, 0.125 / 12, 0.01, 0.5);
    expect(q.velocityFps).toBeCloseTo(v, 6);
    expect(q.gpm).toBeCloseTo(v * area * 448.831, 4);
    expect(q.gpm).toBeGreaterThan(55);
    expect(q.gpm).toBeLessThan(60);
  });

  it("the drainage report: fixture units per pipe, design flow, capacity at slope, stack capacity", () => {
    const report = new PipeHydraulicsEngine().report(m, "sys-san");
    if (report?.kind !== "drainage") throw new Error(`expected drainage, got ${report?.kind}`);
    const main = report.segments.find((s) => s.elementId === "main-s1");
    expect(main?.fixtureUnits).toBe(4);
    expect(main?.designGpm).toBeCloseTo(hunterStyleGpm(4), 2);
    expect(main?.capacityGpm).toBeCloseTo(manningGpm(4.026, 0.125 / 12, 0.01, 0.5).gpm, 1);
    expect(main?.ok).toBe(true);
    // The stack and its arm are a separate piece of the system: a hint reports that piece.
    const stackReport = new PipeHydraulicsEngine().report(m, "sys-san", "stack-s1");
    if (stackReport?.kind !== "drainage") throw new Error("drainage");
    const stack = stackReport.segments.find((s) => s.elementId === "stack-s1");
    expect(stack?.role).toBe("stack");
    expect(stack?.capacityGpm).toBeCloseTo(stackCapacityGpm(4.026), 1);
    expect(report.basis.join(" ")).toMatch(/verify for permit work/);
    expect(report.basis.join(" ")).toMatch(/No DFU capacity table entered/);
  });

  it("a firm's capacity table is applied when entered (no code table is bundled)", () => {
    const tight = commit(m, { type: "set_system_design", systemId: "sys-san", design: { pipe: { capacityTable: [{ nominalIn: 4, inPerFt: 0.125, maxDfu: 3 }] } } });
    const report = new PipeHydraulicsEngine().report(tight, "sys-san");
    if (report?.kind !== "drainage") throw new Error("drainage");
    expect(report.pass).toBe(false);
    expect(report.warnings.map((w) => w.message)).toContain("The 4\" PVC sanitary pipe carries 4 DFU; the capacity table allows 3 at this size and slope");
  });
});

// ------------------------------------------------------------------ domestic water: Hazen-Williams by hand

const SERVICE = partType("Water service", "mechanical_equipment", "domestic_cold_water", [1, 0, 0], IN);
const FIXTURE = partType("Test fixture", "plumbing_fixture", "domestic_cold_water", [-1, 0, 0], IN, { flow: 5 });
const CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };
const copper = (inches: number): RunSize => ({ shape: "pipe", nominalMm: inches * IN, material: "copper" });

/** Hazen-Williams written out: 4.52 Q^1.852 / (C^1.852 d^4.8704), psi per ft. */
const hwPsiPerFt = (gpm: number, c: number, d: number) => (4.52 * Math.pow(gpm, 1.852)) / (Math.pow(c, 1.852) * Math.pow(d, 4.8704));

describe("domestic water hydraulics", () => {
  it("Hazen-Williams by hand: 10 gpm in 3/4\" type L (0.785\" bore), C 140, is about 11 psi per 100 ft", () => {
    expect(hazenWilliamsPsiPer100Ft(10, 140, 0.785)).toBeCloseTo(hwPsiPerFt(10, 140, 0.785) * 100, 8);
    expect(hazenWilliamsPsiPer100Ft(10, 140, 0.785)).toBeGreaterThan(10.5);
    expect(hazenWilliamsPsiPer100Ft(10, 140, 0.785)).toBeLessThan(11.5);
  });

  function water(rise: boolean): ModelState {
    let m = emptyModel();
    m = commit(m, { type: "place_part", partId: "svc", typeId: "test:svc", partType: SERVICE, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 3 * FT, mark: "WS-1" });
    m = commit(m, { type: "place_part", partId: "fx", typeId: "test:fx", partType: FIXTURE, levelId: "lvl-1", position: { x: rise ? 20 * FT : 50 * FT, y: 0 }, offsetMm: rise ? 13 * FT : 3 * FT, mark: "FX-1" });
    m = commit(m, {
      type: "route_run",
      idPrefix: "cw",
      levelId: "lvl-1",
      domain: "pipe",
      size: copper(1),
      elevationMm: 3 * FT,
      system: CW,
      points: rise ? [{ x: 10 * FT, y: 0, elevationMm: 13 * FT }] : [],
      from: { kind: "part", partId: "svc", connectorId: "c" },
      to: { kind: "part", partId: "fx", connectorId: "c" },
    });
    return commit(m, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { supplyPressurePsi: 60, demandMethod: "flow_is_gpm", minFixturePressurePsi: 20 } } });
  }

  it("pressure at the fixture: supply less 50 ft of 1\" type L at 5 gpm", () => {
    const report = new PipeHydraulicsEngine().report(water(false), "sys-cw");
    if (report?.kind !== "water") throw new Error(`expected water, got ${report?.kind}`);
    const want = 60 - hwPsiPerFt(5, 140, 1.025) * 50;
    expect(report.critical?.label).toBe("FX-1");
    expect(report.critical?.pressure).toBeCloseTo(want, 3);
    expect(report.pass).toBe(true);
    expect(report.segments[0]?.velocityFps).toBeCloseTo(5 / 448.831 / ((Math.PI * (1.025 / 12) ** 2) / 4), 2);
  });

  it("a 10 ft rise: friction over the developed length, two elbows at K = 30 fT, and 10 ft of static head", () => {
    const m = water(true);
    const report = new PipeHydraulicsEngine().report(m, "sys-cw");
    if (report?.kind !== "water") throw new Error("water");
    const dMm = 1.025 * IN;
    const fT = 0.25 / Math.log10(0.0015 / dMm / 3.7) ** 2;
    const rho = waterDensity(60);
    const v = 5 / 15_850.323 / ((Math.PI * (dMm / 1000) ** 2) / 4);
    const elbows = (2 * 30 * fT * rho * v * v) / 2 / PSI;
    const head = (rho * 9.80665 * 10 * FT) / 1000 / PSI;
    const want = 60 - hwPsiPerFt(5, 140, 1.025) * 30 - elbows - head;
    expect(report.critical?.pressure).toBeCloseTo(want, 3);
    expect(report.fittings.filter((f) => f.paths[0]?.source === "Formula, verify for permit work")).toHaveLength(2);
    // The elbows' take-out (R tan 45° = 1 x 1.125") comes off the riser at both ends.
    expect(straightPiece(m.elements, seg(m, "cw-s2")).lengthMm).toBeCloseTo(10 * FT - 2 * 1.125 * IN, 2);
  });

  it("an engineer's override and the equivalent-length method both reach the report", () => {
    const m = water(true);
    const elbow = fittingsOf(m, "sys-cw").find((f) => f.fittingType === "elbow");
    if (!elbow) throw new Error("fixture");
    const over = commit(m, { type: "set_fitting_coefficient", fittingId: elbow.id, role: "body", c: 1.5, by: "Priya", at: "2026-10-19T00:00:00.000Z" });
    const r1 = new PipeHydraulicsEngine().report(over, "sys-cw");
    if (r1?.kind !== "water") throw new Error("water");
    expect(r1.fittings.find((f) => f.elementId === elbow.id)?.paths[0]).toMatchObject({ k: 1.5, source: "Override by Priya, 2026-10-19", verify: false });
    const el = commit(m, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { fittingMethod: "equivalent_length" } } });
    const r2 = new PipeHydraulicsEngine().report(el, "sys-cw");
    if (r2?.kind !== "water") throw new Error("water");
    // Equivalent length of a standard elbow: L/D 30 x the bore.
    expect(r2.fittings[0]?.paths[0]?.equivalentLengthFt).toBeCloseTo((30 * 1.025) / 12, 2);
  });

  it("an inline ball valve: placed on the pipe, drawn, and its K (3 fT) counted; misplaced accessories are refused", () => {
    const m = water(false);
    const v = commit(m, { type: "place_run_accessory", accessoryId: "bv-1", segmentId: "cw-s1", atMm: 25 * FT, family: "pipe.valve.ball" });
    expect(fit(v, "bv-1")).toMatchObject({ fittingType: "accessory", label: "Ball valve, full port", params: { joint: "sweat" } });
    expect(fittingMesh(fittingBody(v.elements, fit(v, "bv-1"))).indices.length).toBeGreaterThan(0);
    const report = new PipeHydraulicsEngine().report(v, "sys-cw");
    if (report?.kind !== "water") throw new Error("water");
    expect(report.fittings.find((f) => f.elementId === "bv-1")?.paths[0]?.k).toBeCloseTo(3 * (0.25 / Math.log10(0.0015 / (1.025 * IN) / 3.7) ** 2), 4);
    expect(refusal(m, { type: "place_run_accessory", accessoryId: "gc", segmentId: "cw-s1", atMm: 25 * FT, family: "pipe.gas.cock" })).toMatch(/is a fuel gas fitting; this system carries water/);
    expect(refusal(m, { type: "place_run_accessory", accessoryId: "bad", segmentId: "cw-s1", atMm: 25 * FT, family: "pipe.valve.ball", params: { joint: "solvent_weld" } })).toMatch(/Solvent weld joints aren't made for Copper tube, type L/);
    expect(refusal(m, { type: "place_run_accessory", accessoryId: "end", segmentId: "cw-s1", atMm: 50 * FT - 10, family: "pipe.valve.ball" })).toMatch(/runs into the fitting at the end|past its end/);
  });

  it("demand from fixture units: the firm table when it has one, else the Hunter-curve-style fit labelled verify", () => {
    expect(hunterStyleGpm(10)).toBeCloseTo(1.47 * 10 ** 0.735, 6);
    const firm = new PipeHydraulicsEngine({ firm: { demandMethod: "table", demandTable: [{ fu: 0, gpm: 0 }, { fu: 10, gpm: 9 }] } });
    const m = commit(water(false), { type: "set_system_design", systemId: "sys-cw", design: { pipe: { demandMethod: "table" } } });
    const report = firm.report(m, "sys-cw");
    if (report?.kind !== "water") throw new Error("water");
    // The fixture's connector says 5; read as fixture units through the firm's table: 4.5 gpm.
    expect(report.segments[0]?.gpm).toBeCloseTo(4.5, 6);
    expect(report.basis.join(" ")).toMatch(/firm\/project fixture-unit table/);
  });

  it("the report is incremental: reused until its system changes", () => {
    const m = water(false);
    const engine = new PipeHydraulicsEngine();
    const a = engine.report(m, "sys-cw");
    const b = engine.report(m, "sys-cw");
    expect(b).toBe(a);
    expect(engine.stats).toMatchObject({ computed: 1, reused: 1 });
    const moved = commit(m, { type: "place_run_accessory", accessoryId: "bv-2", segmentId: "cw-s1", atMm: 10 * FT, family: "pipe.valve.gate" });
    expect(engine.report(moved, "sys-cw", "bv-2")).not.toBe(a);
  });
});

// ------------------------------------------------------------------ fuel gas

const METER = partType("Gas meter", "mechanical_equipment", "natural_gas", [1, 0, 0], 0.75 * IN);
const FURNACE = partType("Furnace", "mechanical_equipment", "natural_gas", [-1, 0, 0], 0.75 * IN, { mbh: 80 });
const APPLIANCE = { ...FURNACE, category: "plumbing_fixture" as const, familyName: "Gas appliance" };

describe("fuel gas hydraulics", () => {
  it("Spitzglass and Mueller by hand: 100 cfh, 50 ft of 1\" schedule 40 (1.049\" bore), S 0.60", () => {
    const d = 1.049;
    const spitz = (0.6 * 50 * 100 ** 2 * (1 + 3.6 / d + 0.03 * d)) / (3550 ** 2 * d ** 5);
    expect(spitzglassDropInWc(100, 50, d, 0.6)).toBeCloseTo(spitz, 10);
    expect(spitz).toBeCloseTo(0.0836, 3);
    const mueller = 50 * ((100 * 0.6 ** 0.425) / (2971 * d ** 2.725)) ** (1 / 0.575);
    expect(muellerDropInWc(100, 50, d, 0.6)).toBeCloseTo(mueller, 10);
  });

  function gas(): ModelState {
    let m = emptyModel();
    m = commit(m, { type: "place_part", partId: "meter", typeId: "test:meter", partType: METER, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 3 * FT, mark: "GM-1" });
    m = commit(m, { type: "place_part", partId: "f", typeId: "test:appliance", partType: APPLIANCE, levelId: "lvl-1", position: { x: 30 * FT, y: 0 }, offsetMm: 3 * FT, mark: "F-1" });
    return commit(m, { type: "route_run", idPrefix: "g", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 0.75 * IN, material: "black_steel" }, elevationMm: 3 * FT, system: { id: "sys-g", kind: "natural_gas", name: "Natural Gas" }, points: [], from: { kind: "part", partId: "meter", connectorId: "c" }, to: { kind: "part", partId: "f", connectorId: "c" } });
  }

  it("an 80 MBH appliance 30 ft from the meter: 80 cfh, Spitzglass drop over the longest run, within the allowable", () => {
    const m = gas();
    expect(fittingsOf(m, "sys-g")).toHaveLength(0);
    const report = new PipeHydraulicsEngine().report(m, "sys-g");
    if (report?.kind !== "gas") throw new Error(`expected gas, got ${report?.kind}`);
    const s = report.segments[0];
    expect(s?.cfh).toBeCloseTo(80, 6);
    expect(report.longestRunFt).toBeCloseTo(30, 2);
    expect(s?.dropInWc).toBeCloseTo(spitzglassDropInWc(80, 30, 0.824, 0.6), 4);
    expect(report.critical?.pressure).toBeCloseTo(7 - spitzglassDropInWc(80, 30, 0.824, 0.6), 4);
    expect(report.pass).toBe(true);
    const mueller = new PipeHydraulicsEngine({ firm: { gasEquation: "mueller" } }).report(m, "sys-g");
    if (mueller?.kind !== "gas") throw new Error("gas");
    expect(mueller.segments[0]?.dropInWc).toBeCloseTo(muellerDropInWc(80, 30, 0.824, 0.6), 4);
  });

  it("a drip leg goes on the vertical drop, a gas cock anywhere; a sanitary fitting on gas is refused", () => {
    const m = gas();
    expect(refusal(m, { type: "place_run_accessory", accessoryId: "dl", segmentId: "g-s1", atMm: 15 * FT, family: "pipe.gas.drip_leg" })).toBe("A drip leg (tee + nipple + cap) goes on vertical pipe; ¾\" black steel natural gas pipe is level");
    const cock = commit(m, { type: "place_run_accessory", accessoryId: "gc", segmentId: "g-s1", atMm: 28 * FT, family: "pipe.gas.cock" });
    expect(fit(cock, "gc").params).toMatchObject({ joint: "threaded" });
    const report = new PipeHydraulicsEngine().report(cock, "sys-g");
    if (report?.kind !== "gas") throw new Error("gas");
    // The cock adds its equivalent length to the run.
    expect(report.longestRunFt).toBeCloseTo(30 + (18 * 0.824) / 12, 2);
    expect(refusal(m, { type: "place_run_accessory", accessoryId: "co", segmentId: "g-s1", atMm: 15 * FT, family: "dwv.cleanout_tee" })).toMatch(/isn't made for black steel pipe|drainage/);
  });
});

// ------------------------------------------------------------------ golden reports (fixture-unit totals on the shared aggregation core)

/**
 * Whole reports for trees with several fixtures on branches, recorded on the
 * code before the fixture-unit walk moved onto connections/aggregate.ts
 * (accumulateBelow). The snapshot is the proof the move changed no number:
 * update it only for a deliberate change to the plumbing method.
 */
describe("pipe reports: golden", () => {
  const FIXTURE_3 = partType("Test fixture 3", "plumbing_fixture", "domestic_cold_water", [-1, 0, 0], IN, { flow: 3 });
  const FIXTURE_2 = partType("Test fixture 2", "plumbing_fixture", "domestic_cold_water", [-1, 0, 0], IN, { flow: 2 });
  const GAS_2 = { ...APPLIANCE, familyName: "Gas range", typeValues: { input_mbh: 65 } };

  /** A 1 1/4" main from the service to FX-1 (5 FU), with 3/4" branches to FX-2 (3 FU) and FX-3 (2 FU); Hunter-style demand. */
  function waterTree(method: "hunter_formula" | "flow_is_gpm"): ModelState {
    let m = emptyModel();
    m = commit(m, { type: "place_part", partId: "svc", typeId: "test:svc", partType: SERVICE, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 3 * FT, mark: "WS-1" });
    m = commit(m, { type: "place_part", partId: "fx1", typeId: "test:fx", partType: FIXTURE, levelId: "lvl-1", position: { x: 60 * FT, y: 0 }, offsetMm: 3 * FT, mark: "FX-1" });
    m = commit(m, { type: "place_part", partId: "fx2", typeId: "test:fx3", partType: FIXTURE_3, levelId: "lvl-1", position: { x: 20 * FT, y: 10 * FT }, offsetMm: 3 * FT, mark: "FX-2" });
    m = commit(m, { type: "place_part", partId: "fx3", typeId: "test:fx2", partType: FIXTURE_2, levelId: "lvl-1", position: { x: 40 * FT, y: 10 * FT }, offsetMm: 3 * FT, mark: "FX-3" });
    m = commit(m, { type: "route_run", idPrefix: "cw", levelId: "lvl-1", domain: "pipe", size: copper(1.25), elevationMm: 3 * FT, system: CW, points: [], from: { kind: "part", partId: "svc", connectorId: "c" }, to: { kind: "part", partId: "fx1", connectorId: "c" } });
    m = commit(m, { type: "route_run", idPrefix: "b2", levelId: "lvl-1", domain: "pipe", size: copper(0.75), elevationMm: 3 * FT, system: CW, points: [{ x: 15 * FT, y: 10 * FT }, { x: 15 * FT, y: 0 }], from: { kind: "part", partId: "fx2", connectorId: "c" }, to: { kind: "run_branch", segmentId: "cw-s1" } });
    m = commit(m, { type: "route_run", idPrefix: "b3", levelId: "lvl-1", domain: "pipe", size: copper(0.75), elevationMm: 3 * FT, system: CW, points: [{ x: 35 * FT, y: 10 * FT }, { x: 35 * FT, y: 0 }], from: { kind: "part", partId: "fx3", connectorId: "c" }, to: { kind: "run_branch", segmentId: "cw-s1" } });
    return commit(m, { type: "set_system_design", systemId: "sys-cw", design: { pipe: { supplyPressurePsi: 60, demandMethod: method, minFixturePressurePsi: 20 } } });
  }

  /** The meter to F-1 (80 MBH) with a branch to a 65 MBH range. */
  function gasTree(): ModelState {
    let m = emptyModel();
    m = commit(m, { type: "place_part", partId: "meter", typeId: "test:meter", partType: METER, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 3 * FT, mark: "GM-1" });
    m = commit(m, { type: "place_part", partId: "f", typeId: "test:appliance", partType: APPLIANCE, levelId: "lvl-1", position: { x: 40 * FT, y: 0 }, offsetMm: 3 * FT, mark: "F-1" });
    m = commit(m, { type: "place_part", partId: "r", typeId: "test:range", partType: GAS_2, levelId: "lvl-1", position: { x: 20 * FT, y: 12 * FT }, offsetMm: 3 * FT, mark: "R-1" });
    const gasSystem = { id: "sys-g", kind: "natural_gas" as const, name: "Natural Gas" };
    m = commit(m, { type: "route_run", idPrefix: "g", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 1 * IN, material: "black_steel" }, elevationMm: 3 * FT, system: gasSystem, points: [], from: { kind: "part", partId: "meter", connectorId: "c" }, to: { kind: "part", partId: "f", connectorId: "c" } });
    return commit(m, { type: "route_run", idPrefix: "gr", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 0.75 * IN, material: "black_steel" }, elevationMm: 3 * FT, system: gasSystem, points: [{ x: 15 * FT, y: 12 * FT }, { x: 15 * FT, y: 0 }], from: { kind: "part", partId: "r", connectorId: "c" }, to: { kind: "run_branch", segmentId: "g-s1" } });
  }

  /** The drainage model with a second closet and a lavatory-sized arm, so the main carries more than one fixture. */
  function drainageTree(): ModelState {
    if (!WC) throw new Error("starter library");
    let m = drainage();
    m = commit(m, { type: "place_part", partId: "wc2", typeId: WC.id, levelId: "lvl-1", position: { x: 5 * FT, y: 10 * FT }, offsetMm: 0, mark: "WC-2" });
    return commit(m, { type: "route_run", idPrefix: "wcb2", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: -2 * FT, system: SAN, points: [{ x: 5 * FT - 150, y: 10 * FT }, { x: 5 * FT - 150, y: 8 * FT }], from: { kind: "part", partId: "wc2", connectorId: "waste" }, to: { kind: "run_branch", segmentId: "main-s1" } });
  }

  const cases: ReadonlyArray<readonly [string, () => ModelState, string, string | undefined]> = [
    ["water tree, Hunter-style demand", () => waterTree("hunter_formula"), "sys-cw", undefined],
    ["water tree, flow is gpm", () => waterTree("flow_is_gpm"), "sys-cw", undefined],
    ["gas tree", gasTree, "sys-g", undefined],
    ["drainage tree, main", drainageTree, "sys-san", undefined],
    ["drainage tree, stack piece", drainageTree, "sys-san", "stack-s1"],
  ];

  it.each(cases)("%s is unchanged", (_name, build, system, hint) => {
    const report = new PipeHydraulicsEngine().report(build(), system, hint);
    expect(report?.kind).not.toBe("not_calculated");
    expect(report).toMatchSnapshot();
  });
});
