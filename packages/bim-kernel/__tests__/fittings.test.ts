/**
 * @jest-environment node
 *
 * Duct fittings: the library, the coefficient sources, the sheet-metal
 * geometry, and the commands that change fittings (swap, override, system
 * choices) and the shape of a run (offsets, height changes, rises along a
 * route). Before this, fittings had no type beyond "elbow" / "transition",
 * no length, no loss coefficient, and runs could not jog or change height.
 */
import {
  DEFAULT_SETTINGS,
  fittingFamilies,
  FORMULA_LABEL,
  FORMULA_SOURCE,
  bendAngleFactor,
  bendAspectFactor,
  bendRadiusFactor,
  branchCoefficient,
  builtinPartType,
  executeCommand,
  fittingBody,
  fittingFamily,
  fittingMesh,
  goredElbow90,
  licensedCoefficientPackageSchema,
  licensedSource,
  mainCoefficient,
  mitreCoefficient,
  planCommit,
  resolveCoefficient,
  resolveParams,
  stampedElbow90,
  straightPiece,
  tableSource,
  transitionCoefficient,
  validateModel,
  type BimElement,
  type Changeset,
  type Command,
  type CoefficientQuery,
  type LibraryEntry,
  type MepSystem,
  type ModelState,
  type RunFitting,
  type RunPoint,
  type RunSegment,
  type RunSize,
} from "../src";
import {
  systemPressure,
} from "@permitzip/bim-pack-mechanical";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-19T00:00:00.000Z";

// ------------------------------------------------------------------ harness

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
const RTU = lib("builtin:rtu-5-ton@1");
const DIFFUSER = lib("builtin:supply-diffuser-24@1");

type Who = "priya" | "marco";
let counter = 0;

class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  submit(who: Who, command: Command, base: number = this.head.revision) {
    counter += 1;
    const d = planCommit(this.head, this.log.filter((cs) => cs.revision > base), { idempotencyKey: `${who}-${counter}-key`, baseRevision: base, actor: { id: who, name: who === "priya" ? "Priya" : "Marco", kind: "human" }, command }, NOW, this.log);
    if (d.ok) {
      this.head = d.model;
      this.log.push(d.changeset);
    }
    return d;
  }
  ok(who: Who, command: Command): Changeset {
    const d = this.submit(who, command);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  refused(who: Who, command: Command): string {
    const before = this.head;
    const d = this.submit(who, command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    expect(this.head).toBe(before);
    return d.error.message;
  }
  seg(id: string): RunSegment {
    const el = this.head.elements[id];
    if (el?.kind !== "run_segment") throw new Error(`${id} is not a segment`);
    return el;
  }
  fit(id: string): RunFitting {
    const el = this.head.elements[id];
    if (el?.kind !== "run_fitting") throw new Error(`${id} is not a fitting`);
    return el;
  }
  ids(prefix: string): string[] {
    return Object.keys(this.head.elements).filter((k) => k.startsWith(prefix)).sort();
  }
}

/** RTU at 12 ft, SD-1 20 ft east and SD-2 10 ft east / 6 ft north, both necks at 8 ft. */
function fixture(): Model {
  const m = new Model({ modelId: "fittings", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok("priya", { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m.ok("priya", { type: "place_part", partId: "rtu", typeId: RTU.id, partType: RTU.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 12 * FT, mark: "RTU-1" });
  m.ok("priya", { type: "place_part", partId: "sd-a", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, offsetMm: 8 * FT, mark: "SD-1" });
  m.ok("priya", { type: "place_part", partId: "sd-b", typeId: DIFFUSER.id, levelId: "lvl-1", position: { x: 10 * FT, y: 6 * FT }, offsetMm: 8 * FT, mark: "SD-2" });
  return m;
}

const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK: RunSize = { shape: "rect", width: 14 * IN, height: 10 * IN };
const BRANCH: RunSize = { shape: "round", diameter: 8 * IN };

function routeTrunk(m: Model): Changeset {
  return m.ok("priya", { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd-a", connectorId: "neck" } });
}

function routeBranch(m: Model): Changeset {
  return m.ok("priya", { type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 10 * FT, system: SA, points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 6 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
}

function expectSymmetricLinks(model: ModelState): void {
  for (const el of Object.values(model.elements)) {
    const links: Array<[string, { elementId: string; port: string }]> =
      el.kind === "run_segment" ? (Object.entries(el.links) as Array<[string, { elementId: string; port: string }]>) : el.kind === "run_fitting" ? el.ports.flatMap((p) => (p.link ? [[p.id, p.link] as [string, { elementId: string; port: string }]] : [])) : [];
    for (const [port, link] of links) {
      const other = model.elements[link.elementId] as BimElement | undefined;
      const back = other?.kind === "run_segment" ? other.links[link.port as "start" | "end"] : other?.kind === "run_fitting" ? other.ports.find((p) => p.id === link.port)?.link : other?.kind === "part" ? other.links?.[link.port] : undefined;
      expect(back).toEqual({ elementId: el.id, port });
    }
  }
}

const close = (a: RunPoint, b: RunPoint, tol = 0.01) => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(tol);
  expect(Math.abs(a.y - b.y)).toBeLessThan(tol);
  expect(Math.abs(a.z - b.z)).toBeLessThan(tol);
};

// ------------------------------------------------------------------ geometry, per family

const system: MepSystem = { id: "sys" as MepSystem["id"], kind: "mep_system", version: 1, authoredRev: {}, name: "SA", systemKind: "supply_air", domain: "duct" };

function elbow(size: RunSize, family: string, params: Record<string, number | string>, tin: RunPoint, tout: RunPoint, angleDeg = 90): RunFitting {
  const C = { x: 0, y: 0, z: 3000 };
  return {
    id: "e" as RunFitting["id"],
    kind: "run_fitting",
    version: 1,
    authoredRev: {},
    fittingType: "elbow",
    label: `${angleDeg}° elbow`,
    domain: "duct",
    systemId: system.id,
    levelId: "lvl" as RunFitting["levelId"],
    position: C,
    angleDeg,
    ports: [
      { id: "a", position: C, direction: { x: -tin.x, y: -tin.y, z: -tin.z }, size },
      { id: "b", position: C, direction: tout, size },
    ],
    family,
    params,
  };
}

const EL = { [system.id]: system } as Record<string, BimElement>;
const ringLen = (v: RunPoint) => Math.hypot(v.x, v.y, v.z);

describe("fitting geometry: connector faces line up with the ports and the duct beside them", () => {
  const east = { x: 1, y: 0, z: 0 };
  const north = { x: 0, y: 1, z: 0 };
  const down = { x: 0, y: 0, z: -1 };
  const s45 = Math.SQRT1_2;

  it("smooth radius elbow: takeoff r·tan(θ/2) from r/W x the in-plane dimension; curved throat and heel", () => {
    const f = elbow(TRUNK, "duct.elbow.radius", { r_over_w: 1 }, east, north);
    const body = fittingBody(EL, f);
    // Turning in plan: the width bends. R = 1.0 x 14" = 355.6 mm; 90° takeoff = R.
    expect(body.takeoffs.a).toBeCloseTo(355.6, 3);
    expect(body.radiusMm).toBeCloseTo(355.6, 3);
    close(body.faces.a?.center ?? f.position, { x: -355.6, y: 0, z: 3000 });
    close(body.faces.b?.center ?? f.position, { x: 0, y: 355.6, z: 3000 });
    const rings = body.tubes[0]?.rings ?? [];
    expect(rings.length).toBeGreaterThan(8);
    // First and last rings are the connector faces at the duct's size.
    close(rings[0]?.center ?? f.position, { x: -355.6, y: 0, z: 3000 });
    expect(ringLen(rings[0]?.a ?? east) * 2).toBeCloseTo(14 * IN, 3);
    expect(ringLen(rings[0]?.b ?? east) * 2).toBeCloseTo(10 * IN, 3);
    // Every ring sits on the centreline arc (R from the arc centre).
    const O = { x: -355.6, y: 355.6, z: 3000 };
    for (const r of rings) expect(Math.hypot(r.center.x - O.x, r.center.y - O.y)).toBeCloseTo(355.6, 2);
    // 45°: takeoff R·tan(22.5°).
    const f45 = elbow(TRUNK, "duct.elbow.radius", { r_over_w: 1 }, east, { x: s45, y: s45, z: 0 }, 45);
    expect(fittingBody(EL, f45).takeoffs.a).toBeCloseTo(355.6 * Math.tan(Math.PI / 8), 3);
    // Turning down: the height bends, so R = 1.0 x 10".
    expect(fittingBody(EL, elbow(TRUNK, "duct.elbow.radius", { r_over_w: 1 }, east, down)).takeoffs.a).toBeCloseTo(254, 3);
  });

  it("gored round elbow: half-gores at the ends, n − 1 joints, faceted, r/D 1.5", () => {
    for (const gores of [3, 4, 5]) {
      const body = fittingBody(EL, elbow(BRANCH, "duct.elbow.gored", { gores: String(gores), r_over_w: 1.5 }, east, north));
      expect(body.takeoffs.a).toBeCloseTo(1.5 * 8 * IN, 3);
      expect(body.tubes[0]?.faceted).toBe(true);
      expect(body.tubes[0]?.rings.length).toBe(gores + 1);
      expect(body.tubes[0]?.rings.every((r) => r.shape === "round")).toBe(true);
    }
  });

  it("mitred elbow: square throat, the mitre section 1/cos(θ/2) longer; with vanes the rail is visible", () => {
    const plain = fittingBody(EL, elbow(TRUNK, "duct.elbow.mitred", {}, east, north));
    expect(plain.takeoffs.a).toBeCloseTo((14 * IN) / 2, 3);
    const mitre = plain.tubes[0]?.rings[1];
    expect(ringLen(mitre?.a ?? east)).toBeCloseTo((14 * IN) / 2 / Math.cos(Math.PI / 4), 2);
    expect(plain.plates).toHaveLength(0);
    const vaned = fittingBody(EL, elbow(TRUNK, "duct.elbow.mitred_vanes", { vanes: "single", vane_radius_mm: 50.8 }, east, north));
    expect(vaned.plates.length).toBeGreaterThanOrEqual(4);
    for (const v of vaned.plates) {
      if (v.kind !== "sheet") throw new Error("vanes are sheets");
      // A vane is full duct depth (10") and turns with the elbow.
      expect(ringLen(v.extrude)).toBeCloseTo(10 * IN, 3);
      const first = v.points[0];
      const last = v.points[v.points.length - 1];
      expect(first && last && Math.hypot(last.x - first.x, last.y - first.y)).toBeCloseTo(50.8 * Math.SQRT2, 1);
    }
  });

  it("transitions: length = largest side change / tan(wall angle); eccentric keeps a side flat; rect-to-round lofts", () => {
    const transition = (family: string, params: Record<string, string | number>, a: RunSize, b: RunSize): RunFitting => ({
      ...elbow(a, family, params, east, east),
      fittingType: "transition",
      label: "Transition",
      ports: [
        { id: "a", position: { x: 0, y: 0, z: 3000 }, direction: { x: -1, y: 0, z: 0 }, size: a },
        { id: "b", position: { x: 0, y: 0, z: 3000 }, direction: east, size: b },
      ],
    });
    const big: RunSize = { shape: "rect", width: 24 * IN, height: 12 * IN };
    const conc = fittingBody(EL, transition("duct.transition.concentric", { wall_angle_deg: 30 }, big, TRUNK));
    // Width 24 → 14: 5" a side; height 12 → 10: 1" a side. 127 mm / tan 30°.
    expect(conc.lengthMm).toBeCloseTo(127 / Math.tan(Math.PI / 6), 0);
    close(conc.faces.b?.center ?? east, { x: conc.lengthMm ?? 0, y: 0, z: 3000 }, 0.2);
    const ecc = fittingBody(EL, transition("duct.transition.eccentric", { flat: "top", wall_angle_deg: 30 }, big, TRUNK));
    const [r0, r1] = ecc.tubes[0]?.rings ?? [];
    // Flat top: the tops line up (centre + half height equal at both ends).
    expect((r0?.center.z ?? 0) + ringLen(r0?.b ?? east)).toBeCloseTo((r1?.center.z ?? 0) + ringLen(r1?.b ?? east), 3);
    const r2r = fittingBody(EL, transition("duct.transition.rect_round", { wall_angle_deg: 30 }, TRUNK, BRANCH));
    expect(r2r.tubes[0]?.rings.map((r) => r.shape)).toEqual(["rect", "round"]);
    expect(r2r.lengthMm).toBeCloseTo((3 * IN) / Math.tan(Math.PI / 6), 0);
  });

  it("every duct family builds a closed, finite mesh", () => {
    const m = fixture();
    routeTrunk(m);
    routeBranch(m);
    for (const el of Object.values(m.head.elements)) {
      if (el.kind !== "run_fitting" || el.domain !== "duct") continue;
      const mesh = fittingMesh(fittingBody(m.head.elements, el));
      expect(mesh.positions.length).toBeGreaterThan(0);
      expect(mesh.positions.every(Number.isFinite)).toBe(true);
      expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
    }
  });

  it("routed fittings: each face meets the segment's straight piece exactly, end to end", () => {
    const m = fixture();
    routeTrunk(m);
    routeBranch(m);
    for (const el of Object.values(m.head.elements)) {
      if (el.kind !== "run_segment") continue;
      const piece = straightPiece(m.head.elements, el);
      for (const [end, at] of [["start", piece.start], ["end", piece.end]] as const) {
        const link = el.links[end];
        const f = link ? m.head.elements[link.elementId] : undefined;
        if (f?.kind !== "run_fitting" || !link) continue;
        const face = fittingBody(m.head.elements, f).faces[link.port];
        if (!face) throw new Error(`${f.id} has no face ${link.port}`);
        close(face.center, at, 0.05);
      }
    }
    // The tap's body reaches 4" into the branch; the gored elbows reach 12".
    expect(straightPiece(m.head.elements, m.seg("br-s1")).lengthMm).toBeCloseTo(1828.8 - 177.8 - 101.6 - 304.8, 2);
  });
});

// ------------------------------------------------------------------ coefficients

describe("loss coefficients: published correlation forms, checked by hand", () => {
  it("smooth bends: angle x radius x aspect", () => {
    expect(bendRadiusFactor(1)).toBeCloseTo(0.21, 6);
    expect(bendRadiusFactor(1.5)).toBeCloseTo(0.21 / Math.sqrt(1.5), 6); // 0.17146
    expect(bendRadiusFactor(0.5)).toBeCloseTo(0.21 / 0.5 ** 2.5, 6); // 1.188
    expect(bendAngleFactor(90)).toBe(1);
    expect(bendAspectFactor(1)).toBeCloseTo(1, 6);
  });

  // Hand-checked against the published tables: Idelchik, Handbook of Hydraulic Resistance (1986),
  // Diagrams 6-1 (smooth bends: A1 angle, B1 radius, C1 aspect) and 6-5 (sharp bends), and
  // Locklin (1950) for round stamped and gored elbows. Before these, the angle factor was a sine fit
  // (0.636 at 45°), the mitre left out Idelchik's angle multiplier (0.18 at 45° instead of 0.34)
  // and gored elbows used a fitted joint factor.
  it("Idelchik A1: the angle factor is the tabulated curve, not a fit", () => {
    const a1: Array<[number, number]> = [[20, 0.31], [30, 0.45], [45, 0.6], [60, 0.78], [75, 0.9], [90, 1], [110, 1.13], [130, 1.2], [150, 1.28], [180, 1.4]];
    for (const [deg, k] of a1) expect(bendAngleFactor(deg)).toBeCloseTo(k, 6);
    expect(bendAngleFactor(22.5)).toBeCloseTo(0.31 + (0.14 * 2.5) / 10, 6); // 0.345, between 20° and 30°
  });

  it("rectangular radius elbow, r/W 1.0, matches the H/W row of Idelchik 6-1", () => {
    // C = 0.21 x C1(H/W); the table row at r/W 1.0: 0.27 0.25 0.23 0.21 0.19 0.18 0.18 0.19 0.20 0.21 0.21.
    const row: Array<[number, number]> = [[0.25, 0.27], [0.5, 0.25], [0.75, 0.23], [1, 0.21], [1.5, 0.19], [2, 0.18], [3, 0.18], [4, 0.19], [5, 0.2], [6, 0.21], [8, 0.21]];
    for (const [hw, c] of row) expect(Math.abs(bendRadiusFactor(1) * bendAspectFactor(hw) - c)).toBeLessThan(0.006);
    // r/W 1.5, H/W 1: 0.17; r/W 2.0: 0.15; r/W 0.75: 0.44.
    expect(bendRadiusFactor(1.5)).toBeCloseTo(0.17, 2);
    expect(bendRadiusFactor(2)).toBeCloseTo(0.15, 2);
    expect(Math.abs(bendRadiusFactor(0.75) - 0.44)).toBeLessThan(0.01); // 0.431
  });

  it("mitred elbows: Weisbach x Idelchik 6-5 A, with the sharp-bend aspect factor", () => {
    // Round / square section: 20° 0.08, 30° 0.16, 45° 0.34, 60° 0.55, 75° 0.81, 90° 1.2.
    const round: Array<[number, number]> = [[20, 0.08], [30, 0.16], [45, 0.34], [60, 0.55], [75, 0.81], [90, 1.2]];
    for (const [deg, c] of round) expect(Math.abs(mitreCoefficient(deg) - c)).toBeLessThan(0.02);
    // 90°, H/W 4 (tall, square throat): 1.2 x 0.78 ≈ 0.92.
    const f = fittingFamily("duct.elbow.mitred");
    if (!f) throw new Error("duct.elbow.mitred");
    const tall = FORMULA_SOURCE.lookup({ family: f, params: {}, role: "body", angleDeg: 90, rOverW: 1, aspectRatio: 4, areaRatio: 1, expanding: false, includedAngleDeg: 60, velocityRatio: 1, diverging: true });
    expect(tall?.c).toBeCloseTo(0.9243, 3);
  });

  it("round elbows follow Locklin: stamped by r/D, gored by pieces and r/D", () => {
    // Stamped: r/D 0.5 0.71, 0.75 0.33, 1.0 0.22, 1.5 0.15, 2.0 0.13, 2.5 0.12.
    for (const [r, c] of [[0.5, 0.71], [0.75, 0.33], [1, 0.22], [1.5, 0.15], [2, 0.13], [2.5, 0.12]] as const) expect(stampedElbow90(r)).toBeCloseTo(c, 6);
    // Gored, 90°: 5 pieces .46 .33 .24 .19; 4 pieces .50 .37 .27 .24; 3 pieces .54 .42 .34 .33 at r/D 0.75, 1.0, 1.5, 2.0.
    const gored: Record<number, number[]> = { 5: [0.46, 0.33, 0.24, 0.19], 4: [0.5, 0.37, 0.27, 0.24], 3: [0.54, 0.42, 0.34, 0.33] };
    for (const [pieces, cs] of Object.entries(gored)) [0.75, 1, 1.5, 2].forEach((r, i) => expect(goredElbow90(Number(pieces), r)).toBeCloseTo(cs[i] ?? 0, 6));
    // A 30° 5-gore elbow at r/D 1.5: 0.24 x 0.45.
    const g = fittingFamily("duct.elbow.gored");
    if (!g) throw new Error("duct.elbow.gored");
    expect(FORMULA_SOURCE.lookup({ family: g, params: { gores: "5", r_over_w: 1.5 }, role: "body", angleDeg: 30, rOverW: 1.5, aspectRatio: 1, areaRatio: 1, expanding: false, includedAngleDeg: 60, velocityRatio: 1, diverging: true })?.c).toBeCloseTo(0.108, 4);
  });

  const q = (family: string, extra: Partial<CoefficientQuery> = {}): CoefficientQuery => {
    const fam = fittingFamily(family);
    if (!fam) throw new Error(family);
    return { family: fam, params: resolveParams(fam, undefined), role: "body", angleDeg: 90, rOverW: 1, aspectRatio: 1, areaRatio: 1, expanding: false, includedAngleDeg: 60, velocityRatio: 1, diverging: true, ...extra };
  };

  it("the formula source answers every duct family, labelled 'formula, verify for permit work'", () => {
    expect(FORMULA_SOURCE.lookup(q("duct.elbow.radius"))?.c).toBeCloseTo(0.21, 4);
    expect(FORMULA_SOURCE.lookup(q("duct.elbow.gored", { rOverW: 1.5 }))?.c).toBeCloseTo(0.24, 3); // 0.17146 x 1.4
    expect(FORMULA_SOURCE.lookup(q("duct.elbow.mitred"))?.c).toBeCloseTo(1.185, 4); // 1.2 x 0.9875
    expect(FORMULA_SOURCE.lookup(q("duct.elbow.round_smooth", { rOverW: 1.5 }))?.c).toBeCloseTo(0.15, 4);
    expect(FORMULA_SOURCE.lookup(q("duct.elbow.mitred_vanes"))?.c).toBeCloseTo(0.15, 4);
    // Expansion, θ 60°, β² 0.5 → (1 − 0.5)² = 0.25; contraction → 0.5 √sin 30° x 0.5 = 0.1768.
    expect(transitionCoefficient(0.5, 60, true)).toBeCloseTo(0.25, 6);
    expect(transitionCoefficient(0.5, 60, false)).toBeCloseTo(0.5 * Math.sqrt(0.5) * 0.5, 6);
    expect(transitionCoefficient(0.5, 30, true)).toBeCloseTo(2.6 * Math.sin(Math.PI / 12) * 0.25, 6);
    // Takeoffs: 90° square-edged at Vb/Vc 1 → 2.0; at 0.5 → 5.0; 45° at 1 → 2 − √2.
    expect(branchCoefficient(1, 90, 1)).toBeCloseTo(2, 6);
    expect(branchCoefficient(0.5, 90, 1)).toBeCloseTo(5, 6);
    expect(branchCoefficient(1, 45, 1)).toBeCloseTo(2 - Math.SQRT2, 6);
    expect(mainCoefficient(0.5)).toBeCloseTo(0.1, 6);
    for (const f of fittingFamilies().filter((x) => x.domain === "duct")) {
      const v = FORMULA_SOURCE.lookup(q(f.id, { role: f.loss === "branch_takeoff" ? "branch" : "body" }));
      expect(v).not.toBeNull();
      expect(v?.sourceLabel).toBe(FORMULA_LABEL);
      expect(v?.verify).toBe(true);
    }
    // Pipe: K = (L/D) x fT for water and gas fittings; drains are sized by Manning, so their fittings take no K.
    expect(FORMULA_SOURCE.lookup(q("pipe.elbow", { turbulentFrictionFactor: 0.019 }))?.c).toBeCloseTo(30 * 0.019, 6);
    expect(FORMULA_SOURCE.lookup(q("dwv.sanitary_tee"))).toBeNull();
  });

  it("override > engineer table > licensed > formula; tables interpolate curves and match parameters", () => {
    const table = tableSource({
      id: "acme",
      label: "Acme 2026",
      scope: "firm",
      entries: [
        { family: "duct.elbow.gored", role: "body", c: 0.3, when: { gores: "3" } },
        { family: "duct.elbow.radius", role: "body", variable: "r_over_w", points: [{ x: 0.5, c: 0.6 }, { x: 1.5, c: 0.2 }] },
      ],
    });
    expect(table.lookup(q("duct.elbow.radius", { rOverW: 1 }))?.c).toBeCloseTo(0.4, 6);
    expect(table.lookup(q("duct.elbow.radius", { rOverW: 3 }))?.c).toBeCloseTo(0.2, 6);
    expect(table.lookup(q("duct.elbow.gored"))).toBeNull(); // 5 gores by default; the entry is for 3
    const pkg = licensedCoefficientPackageSchema.parse({ vendor: "V", product: "Fittings DB", version: "1", license: { holder: "PermitZIP", licenseId: "L-1" }, fittings: [{ vendorCode: "X-1", family: "duct.elbow.mitred", role: "body", c: 1.1 }] });
    const licensed = licensedSource(pkg);
    expect(resolveCoefficient(q("duct.elbow.mitred"), [table, licensed])).toMatchObject({ c: 1.1, sourceKind: "licensed" });
    expect(resolveCoefficient(q("duct.elbow.radius"), [table, licensed])).toMatchObject({ sourceKind: "table", sourceLabel: "Firm table: Acme 2026" });
    expect(resolveCoefficient(q("duct.elbow.radius"), [table], { c: 0.05, role: "body", by: "Priya", at: "2026-10-19T12:00:00Z" })).toMatchObject({ c: 0.05, sourceKind: "override", sourceLabel: "Override by Priya, 2026-10-19" });
    expect(resolveCoefficient(q("duct.elbow.mitred"), [])).toMatchObject({ sourceKind: "formula" });
    expect(() => licensedCoefficientPackageSchema.parse({ vendor: "V" })).toThrow();
  });
});

// ------------------------------------------------------------------ routing with families

describe("route_run places the system's fittings", () => {
  it("defaults by shape: radius elbows on rectangular, 5-gore on round, conical tap for a round branch", () => {
    const m = fixture();
    routeTrunk(m);
    routeBranch(m);
    expect(m.fit("trunk-f1").family).toBe("duct.elbow.radius");
    expect(m.fit("trunk-f1").params).toEqual({ r_over_w: 1 });
    expect(m.fit("br-f1").family).toBe("duct.elbow.gored");
    expect(m.fit("br-f3")).toMatchObject({ family: "duct.tap.conical", label: "Conical tap" });
    expect(m.fit("trunk-f4").family).toBe("duct.transition.rect_round");
    expect(validateModel(m.head)).toEqual([]);
  });

  it("follows the system's own choices, and refuses one that can't be the fitting", () => {
    const m = fixture();
    routeTrunk(m);
    m.ok("priya", { type: "set_system_design", systemId: "sys-sa", fittingDefaults: { elbow_round: { family: "duct.elbow.gored", params: { gores: "3" } }, branch_round: { family: "duct.tap.bellmouth" } } });
    routeBranch(m);
    expect(m.fit("br-f1").params).toMatchObject({ gores: "3" });
    expect(m.fit("br-f3")).toMatchObject({ family: "duct.tap.bellmouth", label: "Bellmouth tap" });
    expect(m.refused("priya", { type: "set_system_design", systemId: "sys-sa", fittingDefaults: { elbow_rect: { family: "duct.elbow.gored" } } })).toBe("Gored round elbow can't be Supply Air 1's choice for rectangular elbows: Gored round elbow isn't made in rectangular duct");
    expect(m.refused("priya", { type: "set_system_design", systemId: "sys-sa", fittingDefaults: { branch_rect: { family: "duct.elbow.radius" } } })).toMatch(/isn't a branch takeoff/);
  });

  it("rises and drops along a route: straight up with two 90° elbows, or a 45° slope with two 45° elbows", () => {
    const m = fixture();
    m.ok("priya", { type: "route_run", idPrefix: "v", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 30 * FT, y: 0 }, { x: 40 * FT, y: 0, elevationMm: 12 * FT }, { x: 50 * FT, y: 0 }] });
    expect(m.ids("v-s")).toHaveLength(3);
    close(m.seg("v-s2").start, { x: 40 * FT, y: 0, z: 10 * FT });
    close(m.seg("v-s2").end, { x: 40 * FT, y: 0, z: 12 * FT });
    expect(m.ids("v-f").map((k) => m.fit(k).angleDeg)).toEqual([90, 90]);
    m.ok("priya", { type: "route_run", idPrefix: "s", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, riseStyle: "45", points: [{ x: 30 * FT, y: 20 * FT }, { x: 40 * FT, y: 20 * FT, elevationMm: 8 * FT }, { x: 50 * FT, y: 20 * FT }] });
    const slope = m.seg("s-s2");
    expect(slope.end.z - slope.start.z).toBeCloseTo(-2 * FT, 3);
    expect(slope.end.x - slope.start.x).toBeCloseTo(2 * FT, 3);
    expect(m.ids("s-f").map((k) => m.fit(k).angleDeg)).toEqual([45, 45]);
    expect(validateModel(m.head)).toEqual([]);
    expect(
      m.refused("priya", { type: "route_run", idPrefix: "t", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, riseStyle: "45", points: [{ x: 30 * FT, y: 40 * FT }, { x: 40 * FT, y: 40 * FT, elevationMm: 14 * FT }, { x: 42 * FT, y: 40 * FT }] }),
    ).toBe("A 45° rise of 4 ft at point 2 needs 4 ft of run before the next point; there is 2 ft");
  });

  it("refuses a leg too short for its real fittings, names the leg and the room needed, and creates nothing", () => {
    const m = fixture();
    // At 10 ft the 18" drop into SD-1 holds its radius elbow (10") and transition (5.2").
    routeTrunk(m);
    expect(systemPressure(m.head, "sys-sa")?.warnings).toEqual([]);
    // At 9 ft the drop is 6": the route is refused whole, in preview and on commit.
    const tight = fixture();
    const low: Command = { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 9 * FT, system: SA, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd-a", connectorId: "neck" } };
    const message = "Leg 3 is 0.51 ft long, but the elbow and transition there need 1.27 ft. Move the point or pick a shorter fitting.";
    const planned = executeCommand(tight.head, low);
    expect(planned.ok).toBe(false);
    expect(!planned.ok && planned.error).toMatchObject({ code: "min_straight_length", message, elementIds: ["trunk-s3"] });
    const elementsBefore = tight.head.elements;
    expect(tight.refused("priya", low)).toBe(message);
    expect(tight.head.elements).toBe(elementsBefore);
    expect(tight.ids("trunk")).toEqual([]);
    expect(tight.head.elements["sys-sa"]).toBeUndefined();
    expect(tight.head.elements.rtu?.kind === "part" && tight.head.elements.rtu.links).toBeFalsy();
    // Two elbows back to back on a 1 ft rise of 14"x10" duct (each reaches 10" into it).
    expect(
      tight.refused("priya", { type: "route_run", idPrefix: "v", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 30 * FT, y: 0 }, { x: 40 * FT, y: 0, elevationMm: 11 * FT }, { x: 50 * FT, y: 0 }] }),
    ).toBe("Leg 2 is 1 ft long, but the two elbows there need 1.67 ft. Move the point or pick a shorter fitting.");
  });
});

// ------------------------------------------------------------------ swap_fitting

describe("swap_fitting changes the type in place", () => {
  it("keeps the id and every connection; the new type shows in loss and geometry; undo puts it back", () => {
    const m = fixture();
    routeTrunk(m);
    routeBranch(m);
    const before = m.fit("trunk-f1");
    const cBefore = systemPressure(m.head, "sys-sa")?.elements["trunk-f1"];
    const cs = m.ok("priya", { type: "swap_fitting", fittingId: "trunk-f1", family: "duct.elbow.mitred_vanes", params: { vanes: "double" } });
    const after = m.fit("trunk-f1");
    expect(after.ports).toEqual(before.ports);
    expect(after).toMatchObject({ family: "duct.elbow.mitred_vanes", params: { vanes: "double", vane_radius_mm: 50.8 } });
    expect(fittingBody(m.head.elements, after).plates.length).toBeGreaterThan(0);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
    const cAfter = systemPressure(m.head, "sys-sa")?.elements["trunk-f1"];
    expect(cAfter?.kind === "fitting" && cAfter.paths[0]?.c).toBeCloseTo(0.25, 4);
    expect(cBefore?.kind === "fitting" && cBefore.paths[0]?.c).not.toBeCloseTo(0.25, 2);
    m.ok("priya", { type: "undo", revision: cs.revision });
    expect(m.fit("trunk-f1").family).toBe("duct.elbow.radius");
  });

  it("refuses a type that can't be that fitting, a parameter out of range, and a body too big for the duct beside it", () => {
    const m = fixture();
    routeTrunk(m);
    routeBranch(m);
    expect(m.refused("priya", { type: "swap_fitting", fittingId: "trunk-f1", family: "duct.elbow.gored" })).toBe("The 90° elbow (14\"x10\") can't be a Gored round elbow: Gored round elbow isn't made in rectangular duct");
    expect(m.refused("priya", { type: "swap_fitting", fittingId: "trunk-f4", family: "duct.transition.concentric" })).toMatch(/keeps one shape; these ends are round and rectangular, so use a rectangular-to-round transition/);
    expect(m.refused("priya", { type: "swap_fitting", fittingId: "br-f3", family: "duct.tap.45_entry" })).toMatch(/isn't made in round duct/);
    expect(m.refused("priya", { type: "swap_fitting", fittingId: "trunk-f1", family: "duct.tap.straight" })).toBe("The 90° elbow (14\"x10\") can't be a Straight tap: Straight tap isn't an elbow; pick an elbow type");
    expect(m.refused("priya", { type: "swap_fitting", fittingId: "br-f1", family: "duct.elbow.gored", params: { gores: "7" } })).toBe("Gored round elbow: Gores is one of 3, 4, 5");
    // r/D 3 on the 2 ft east leg between two elbows: 24" each side of a 24" leg.
    expect(m.refused("priya", { type: "swap_fitting", fittingId: "br-f1", family: "duct.elbow.gored", params: { gores: "5", r_over_w: 3 } })).toMatch(/^Gored round elbow needs more room: the 8"Ø supply air duct is 2 ft long, but the fittings at its ends need 3 ft \(914 mm\); make it longer or choose tighter fittings$/);
    expect(m.refused("priya", { type: "swap_fitting", fittingId: "br-f1", family: "duct.elbow.gored", params: { gores: "5", r_over_w: 1.5 } })).toMatch(/already a Gored round elbow with those settings/);
    expect(m.refused("priya", { type: "swap_fitting", fittingId: "trunk-f1", family: "duct.elbow.nope" })).toBe("There is no fitting type duct.elbow.nope in the library");
  });

  it("undo is refused when someone has since changed the same fitting", () => {
    const m = fixture();
    routeTrunk(m);
    const mine = m.ok("priya", { type: "swap_fitting", fittingId: "trunk-f1", family: "duct.elbow.mitred" });
    m.ok("marco", { type: "swap_fitting", fittingId: "trunk-f1", family: "duct.elbow.radius", params: { r_over_w: 1.5 } });
    const d = m.submit("priya", { type: "undo", revision: mine.revision });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.error.code).toBe("undo_refused");
  });
});

// ------------------------------------------------------------------ coefficient override

describe("set_fitting_coefficient records an engineer's C with who and when", () => {
  it("wins over the formula in the pressure report, clears on swap, and clears on request", () => {
    const m = fixture();
    routeTrunk(m);
    routeBranch(m);
    m.ok("priya", { type: "set_fitting_coefficient", fittingId: "br-f3", role: "branch", c: 0.4, by: "Priya", at: "2026-10-19T15:00:00.000Z", note: "Manufacturer test" });
    expect(m.fit("br-f3").coefficientOverride).toEqual({ c: 0.4, role: "branch", by: "Priya", at: "2026-10-19T15:00:00.000Z", note: "Manufacturer test" });
    const tap = systemPressure(m.head, "sys-sa")?.elements["br-f3"];
    const branch = tap?.kind === "fitting" ? tap.paths.find((p) => p.role === "branch") : undefined;
    expect(branch).toMatchObject({ c: 0.4, source: { kind: "override", label: "Override by Priya, 2026-10-19" }, verify: false });
    expect(branch?.lossPa).toBeCloseTo(0.4 * (branch?.vpPa ?? 0), 3);
    expect(m.refused("priya", { type: "set_fitting_coefficient", fittingId: "br-f3", role: "body", c: 0.4, by: "Priya", at: "2026-10-19T15:00:00.000Z" })).toMatch(/has two paths, branch and main/);
    expect(m.refused("priya", { type: "set_fitting_coefficient", fittingId: "trunk-f1", role: "branch", c: 0.4, by: "Priya", at: "2026-10-19T15:00:00.000Z" })).toMatch(/has one path/);
    const swapped = m.ok("priya", { type: "swap_fitting", fittingId: "br-f3", family: "duct.tap.straight" });
    expect(m.fit("br-f3").coefficientOverride).toBeUndefined();
    expect(swapped.elements.length).toBeGreaterThan(0);
    m.ok("priya", { type: "set_fitting_coefficient", fittingId: "trunk-f1", role: "body", c: 0.12, by: "Marco", at: "2026-10-19T16:00:00.000Z" });
    m.ok("priya", { type: "set_fitting_coefficient", fittingId: "trunk-f1", role: "body", c: null, by: "Marco", at: "2026-10-19T16:05:00.000Z" });
    expect(m.fit("trunk-f1").coefficientOverride).toBeUndefined();
    expect(m.refused("priya", { type: "set_fitting_coefficient", fittingId: "trunk-f1", role: "body", c: null, by: "Marco", at: "2026-10-19T16:05:00.000Z" })).toMatch(/no coefficient of its own to clear/);
  });
});

// ------------------------------------------------------------------ offsets and height changes

describe("offset_run and change_elevation", () => {
  it("a sideways 90° jog with a length comes back in line: both ends stay, links are symmetric", () => {
    const m = fixture();
    routeTrunk(m);
    const trunk = m.seg("trunk-s2");
    const cs = m.ok("priya", { type: "offset_run", idPrefix: "jog", segmentId: "trunk-s2", atMm: 4 * FT, offset: { x: 0, y: -2 * FT, z: 0 }, lengthMm: 5 * FT, style: "90" });
    expect(m.seg("trunk-s2").start).toEqual(trunk.start);
    expect(m.seg("trunk-s2").end).toEqual({ ...trunk.start, x: trunk.start.x + 4 * FT });
    // Out, along, back: four elbows, two offset legs, the displaced run, the remainder ending where the trunk ended.
    expect(m.ids("jog-f")).toHaveLength(4);
    const ends = m.ids("jog-s").map((k) => m.seg(k).end);
    expect(ends.some((e) => Math.abs(e.x - trunk.end.x) < 0.01 && Math.abs(e.y - trunk.end.y) < 0.01)).toBe(true);
    expect(m.ids("jog-s").map((k) => m.seg(k)).some((s) => Math.abs(s.start.y + 2 * FT) < 0.01 && Math.abs(s.end.y + 2 * FT) < 0.01)).toBe(true);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
    expect(cs.elements.find((e) => e.id === "trunk-f2")).toBeDefined();
    m.ok("priya", { type: "undo", revision: cs.revision });
    expect(m.seg("trunk-s2")).toMatchObject({ start: trunk.start, end: trunk.end });
    expect(m.ids("jog-")).toEqual([]);
  });

  it("an ogee offset is one fitting whose length is offset x cot(φ/2)", () => {
    const m = fixture();
    routeTrunk(m);
    m.ok("priya", { type: "offset_run", idPrefix: "og", segmentId: "trunk-s2", atMm: 3 * FT, offset: { x: 0, y: 1 * FT, z: 0 }, lengthMm: 4 * FT, style: "ogee" });
    const offsets = m.ids("og-f").map((k) => m.fit(k));
    expect(offsets.map((f) => f.fittingType)).toEqual(["offset", "offset"]);
    const [a, b] = offsets[0]?.ports ?? [];
    expect(Math.abs((b?.position.x ?? 0) - (a?.position.x ?? 0))).toBeCloseTo(FT / Math.tan(Math.PI / 8), 2);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("raising the rest of a run: the connected drop into the diffuser stretches", () => {
    const m = fixture();
    routeTrunk(m);
    const drop = m.seg("trunk-s3");
    m.ok("priya", { type: "change_elevation", idPrefix: "up", segmentId: "trunk-s2", fromMm: 5 * FT, elevationMm: 11 * FT, style: "45" });
    const moved = m.seg("trunk-s3");
    expect(moved.start.z).toBeCloseTo(11 * FT, 3);
    expect(moved.end).toEqual(drop.end);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses: along the run, too close to the end, a branch in the way, an anchored part, not level, already there", () => {
    const m = fixture();
    routeTrunk(m);
    routeBranch(m);
    expect(m.refused("priya", { type: "offset_run", idPrefix: "x", segmentId: "trunk-s2", atMm: 4 * FT, offset: { x: 1 * FT, y: 0, z: 0 }, style: "90" })).toMatch(/square to it; this one runs along it/);
    expect(m.refused("priya", { type: "offset_run", idPrefix: "x", segmentId: "trunk-s2", atMm: 4 * FT, offset: { x: 0, y: 1 * FT, z: 1 * FT }, style: "90" })).toMatch(/either sideways or up \/ down/);
    expect(m.refused("priya", { type: "offset_run", idPrefix: "x", segmentId: "trunk-s2", atMm: 20 * FT, offset: { x: 0, y: 1 * FT, z: 0 }, style: "45" })).toMatch(/^The offset needs/);
    expect(m.refused("priya", { type: "offset_run", idPrefix: "x", segmentId: "trunk-s2", atMm: 7.5 * FT, offset: { x: 0, y: -1 * FT, z: 0 }, lengthMm: 2 * FT, style: "90" })).toMatch(/is where the offset goes; slide it clear first/);
    // Sideways to the end: the drop is square to the move, so it would drag SD-1.
    expect(m.refused("priya", { type: "offset_run", idPrefix: "x", segmentId: "trunk-s2", atMm: 12 * FT, offset: { x: 0, y: -1 * FT, z: 0 }, style: "90" })).toMatch(/connected and stays where it is/);
    expect(m.refused("priya", { type: "change_elevation", idPrefix: "x", segmentId: "trunk-s1", fromMm: 100, elevationMm: 9 * FT, style: "90" })).toMatch(/isn't level/);
    expect(m.refused("priya", { type: "change_elevation", idPrefix: "x", segmentId: "trunk-s2", fromMm: 2 * FT, elevationMm: 10 * FT, style: "90" })).toMatch(/is already at 10 ft/);
  });

  it("branches past the offset move with the run, and their branch follows", () => {
    const m = fixture();
    routeTrunk(m);
    routeBranch(m);
    const tap = m.fit("br-f3");
    const neck = m.seg("br-s3").end;
    m.ok("priya", { type: "change_elevation", idPrefix: "lo", segmentId: "trunk-s2", fromMm: 3 * FT, toMm: 15 * FT, elevationMm: 10.5 * FT, style: "90" });
    const moved = m.fit("br-f3");
    expect(moved.host?.segmentId).not.toBe("trunk-s2");
    expect(moved.position.z - tap.position.z).toBeCloseTo(0.5 * FT, 3);
    // The branch's level leg moves up; its drop into SD-2 shortens.
    expect(m.seg("br-s1").start.z).toBeCloseTo(10.5 * FT, 3);
    expect(m.seg("br-s3").end).toEqual(neck);
    expect(m.seg("br-s3").start.z).toBeCloseTo(10.5 * FT, 3);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });
});
