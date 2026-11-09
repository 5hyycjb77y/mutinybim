/**
 * @jest-environment node
 *
 * Connected routing for duct and pipe. Each block is one CP3 acceptance gate
 * and fails on the kernel before routing (route_run did not exist; parts had
 * no links; move/resize/slide/delete knew nothing about routed runs).
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  asElementId,
  builtinPartType,
  canonicalJson,
  drawView,
  executeCommand,
  planCommit,
  portInfo,
  validateModel,
  type BimElement,
  type Changeset,
  type Command,
  type CommandRequest,
  type LibraryEntry,
  type ModelState,
  type PartInstance,
  type Primitive,
  type RunFitting,
  type RunSegment,
  type TagPlacement,
  type ViewElement,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-19T00:00:00.000Z";

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
const RTU = lib("builtin:rtu-5-ton@1");
const DIFFUSER = lib("builtin:supply-diffuser-24@1");
const WC = lib("builtin:water-closet-floor@1");

interface Person {
  readonly id: string;
  readonly name: string;
  readonly session: string;
}
const PRIYA: Person = { id: "priya", name: "Priya", session: "tab-priya" };
const PRIYA_OTHER_TAB: Person = { id: "priya", name: "Priya", session: "tab-priya-2" };
const MARCO: Person = { id: "marco", name: "Marco", session: "tab-marco" };

let counter = 0;
function request(who: Person, base: number, command: Command): CommandRequest {
  counter += 1;
  return { idempotencyKey: `${who.id}-${counter}-key`, baseRevision: base, actor: { id: who.id, name: who.name, kind: "human" }, command, clientSessionId: who.session };
}

class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  submit(who: Person, command: Command, base: number = this.head.revision) {
    const decision = planCommit(this.head, this.log.filter((cs) => cs.revision > base), request(who, base, command), NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(who: Person, command: Command, base?: number): Changeset {
    const d = this.submit(who, command, base);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  refused(who: Person, command: Command, base?: number): string {
    const before = this.head;
    const d = this.submit(who, command, base);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    expect(this.head).toBe(before);
    return d.error.message;
  }
  el(key: string): BimElement {
    const found = this.head.elements[key];
    if (!found) throw new Error(`missing ${key}`);
    return found;
  }
  seg(key: string): RunSegment {
    const el = this.el(key);
    if (el.kind !== "run_segment") throw new Error(`${key} is a ${el.kind}`);
    return el;
  }
  fitting(key: string): RunFitting {
    const el = this.el(key);
    if (el.kind !== "run_fitting") throw new Error(`${key} is a ${el.kind}`);
    return el;
  }
  part(key: string): PartInstance {
    const el = this.el(key);
    if (el.kind !== "part") throw new Error(`${key} is a ${el.kind}`);
    return el;
  }
  ids(prefix: string): string[] {
    return Object.keys(this.head.elements).filter((k) => k.startsWith(prefix));
  }
}

function empty(): Model {
  return new Model({ modelId: "routing", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
}

function place(m: Model, partId: string, entry: LibraryEntry, x: number, y: number, offsetMm: number, mark: string): void {
  m.ok(PRIYA, { type: "place_part", partId, typeId: entry.id, ...(m.head.elements[entry.id] ? {} : { partType: entry.definition }), levelId: "lvl-1", position: { x, y }, offsetMm, mark });
}

/** An RTU on the roof framing (12 ft) and two diffusers (8 ft, so the 10 ft duct drops 18" onto each neck: room for its elbow and transition), all on Level 1. */
function airFixture(): Model {
  const m = empty();
  m.ok(PRIYA, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  place(m, "rtu", RTU, 0, 0, 12 * FT, "RTU-1");
  place(m, "sd-a", DIFFUSER, 20 * FT, 0, 8 * FT, "SD-1");
  place(m, "sd-b", DIFFUSER, 10 * FT, 4 * FT, 8 * FT, "SD-2");
  return m;
}

const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };
const BRANCH = { shape: "round" as const, diameter: 8 * IN };

function routeTrunk(m: Model, who: Person = PRIYA): Changeset {
  return m.ok(who, {
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
  });
}

/** Branch from the trunk's main run to SD-2: north, east, then down onto the neck. */
function routeBranch(m: Model, who: Person = PRIYA): Changeset {
  return m.ok(who, {
    type: "route_run",
    idPrefix: "br",
    levelId: "lvl-1",
    domain: "duct",
    size: BRANCH,
    elevationMm: 10 * FT,
    system: SA,
    points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 4 * FT }],
    from: { kind: "run_branch", segmentId: "trunk-s2" },
    to: { kind: "part", partId: "sd-b", connectorId: "neck" },
  });
}

function expectSymmetricLinks(model: ModelState): void {
  for (const el of Object.values(model.elements)) {
    const ports: Array<[string, { elementId: string; port: string }]> =
      el.kind === "run_segment"
        ? (Object.entries(el.links) as Array<[string, { elementId: string; port: string }]>)
        : el.kind === "run_fitting"
          ? el.ports.flatMap((p) => (p.link ? [[p.id, p.link] as [string, { elementId: string; port: string }]] : []))
          : el.kind === "part"
            ? Object.entries(el.links ?? {})
            : [];
    for (const [port, link] of ports) {
      const back = portInfo(model.elements, { elementId: asElementId(link.elementId), port: link.port });
      expect(back?.link).toEqual({ elementId: el.id, port });
    }
  }
}

describe("route_run creates connected segments, fittings and a system atomically", () => {
  it("routes supply duct from an RTU down into a diffuser with drops, elbows and transitions", () => {
    const m = airFixture();
    const cs = routeTrunk(m);
    // Drop from the unit, along the ceiling space, drop to the neck.
    expect(m.ids("trunk-s").sort()).toEqual(["trunk-s1", "trunk-s2", "trunk-s3"]);
    expect(m.seg("trunk-s1").start).toEqual({ x: -400, y: 0, z: 3657.6 });
    expect(m.seg("trunk-s1").end).toEqual({ x: -400, y: 0, z: 3048 });
    expect(m.seg("trunk-s2").end).toEqual({ x: 20 * FT, y: 0, z: 10 * FT });
    const fittings = m.ids("trunk-f").map((k) => m.fitting(k));
    expect(fittings.map((f) => f.label).sort()).toEqual(["90° elbow", "90° elbow", "Transition", "Transition"]);
    // The RTU's 24x12 supply and the diffuser's 8" neck each get their own transition.
    expect(m.part("rtu").links?.supply?.elementId).toMatch(/^trunk-f/);
    expect(m.part("sd-a").links?.neck?.elementId).toMatch(/^trunk-f/);
    const sys = m.el("sys-sa");
    expect(sys.kind === "mep_system" && sys.name).toBe("Supply Air 1");
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
    // One atomic changeset: system + 3 segments + 4 fittings + both parts.
    expect(cs.elements.length).toBe(1 + 3 + 4 + 2);
    expect(m.seg("trunk-s2").flow).toBe(150);
  });

  it("branches with a tap that sums the airflow it carries", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    const tap = m.fitting("br-f3");
    expect(tap.fittingType).toBe("tap");
    expect(tap.label).toBe("Conical tap");
    expect(tap.host).toEqual({ segmentId: "trunk-s2", s: 8 * FT + 400, side: 1 });
    expect(m.seg("trunk-s2").branches).toEqual(["br-f3"]);
    // Branch leaves the trunk's face (7" off the centreline).
    expect(tap.ports[0]?.position).toEqual({ x: 2438.4, y: 177.8, z: 3048 });
    expect(m.part("sd-b").links?.neck).toEqual({ elementId: "br-s3", port: "end" });
    expect(m.seg("trunk-s2").flow).toBe(300);
    expect(m.seg("br-s1").flow).toBe(150);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("a branch straight off the trunk onto a diffuser needs only the point on the trunk (as the Route tool sends it)", () => {
    const m = airFixture();
    routeTrunk(m);
    place(m, "sd-c", DIFFUSER, 15 * FT, -4 * FT, 8 * FT, "SD-3");
    m.ok(PRIYA, { type: "route_run", idPrefix: "br2", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 10 * FT, system: SA, points: [{ x: 15 * FT, y: 0 }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-c", connectorId: "neck" } });
    const tap = Object.values(m.head.elements).find((el): el is RunFitting => el.kind === "run_fitting" && el.host?.segmentId === "trunk-s2");
    expect(tap?.host?.side).toBe(-1);
    expect(m.part("sd-c").links?.neck?.elementId).toMatch(/^br2-s/);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses unsupported geometry with a plain reason and creates nothing", () => {
    const m = airFixture();
    const diagonal = m.refused(PRIYA, {
      type: "route_run",
      idPrefix: "bad",
      levelId: "lvl-1",
      domain: "duct",
      size: TRUNK,
      elevationMm: 10 * FT,
      system: SA,
      points: [{ x: 0, y: 6 * FT }, { x: 10 * FT, y: 6 * FT }, { x: 2 * FT, y: 8 * FT }],
    });
    // Any plan angle routes now (route-angles.ts); a turn that folds back on itself still has no elbow.
    expect(diagonal).toMatch(/The turn at point 2 is 166°; an elbow turns at most 135°/);
    const wrongSystem = m.refused(PRIYA, {
      type: "route_run",
      idPrefix: "bad",
      levelId: "lvl-1",
      domain: "duct",
      size: TRUNK,
      elevationMm: 10 * FT,
      system: SA,
      points: [{ x: 400, y: -6 * FT }],
      from: { kind: "part", partId: "rtu", connectorId: "return" },
    });
    expect(wrongSystem).toMatch(/RTU-1's return is return air; this run is Supply Air 1/);
    const above = m.refused(PRIYA, {
      type: "route_run",
      idPrefix: "bad",
      levelId: "lvl-1",
      domain: "duct",
      size: TRUNK,
      elevationMm: 13 * FT,
      system: SA,
      points: [{ x: -400, y: 6 * FT }],
      from: { kind: "part", partId: "rtu", connectorId: "supply" },
    });
    expect(above).toMatch(/faces down, so the run has to be below it/);
    expect(m.ids("bad")).toEqual([]);
    expect(m.head.elements["sys-sa"]).toBeUndefined();
    expect(executeCommand(m.head, { type: "route_run", idPrefix: "c", levelId: "lvl-1", domain: "conduit", size: { shape: "conduit", tradeSizeMm: 19.05, conduitType: "emt" }, elevationMm: 3000, system: { id: "pw", kind: "power" }, points: [{ x: 0, y: 0 }, { x: 3000, y: 0 }] })).toMatchObject({
      ok: false,
      error: { message: "Conduit routing isn't available yet; duct and pipe are" },
    });
  });

  it("routes pipe to a fixture with system rules: tees for water, combination wyes for sanitary, fixture units", () => {
    const m = empty();
    m.ok(PRIYA, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    place(m, "wc", WC, 0, 10 * FT, 0, "WC-1");
    // Cold water arrives level into the side connector at 300 mm.
    m.ok(PRIYA, {
      type: "route_run",
      idPrefix: "cw",
      levelId: "lvl-1",
      domain: "pipe",
      size: { shape: "pipe", nominalMm: 1 * IN, material: "copper" },
      elevationMm: 300,
      system: { id: "sys-cw", kind: "domestic_cold_water", name: "Domestic Cold Water" },
      points: [{ x: -6 * FT, y: 10 * FT }],
      to: { kind: "part", partId: "wc", connectorId: "cw" },
    });
    expect(m.part("wc").links?.cw).toEqual({ elementId: "cw-s1", port: "end" });
    expect(m.seg("cw-s1").flow).toBe(4);
    // Sanitary main below the slab, then the closet's waste drops into it through a combination wye.
    const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
    m.ok(PRIYA, { type: "route_run", idPrefix: "san-main", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 4 * IN, material: "pvc" }, elevationMm: -2 * FT, system: SAN, points: [{ x: -10 * FT, y: 8 * FT }, { x: 10 * FT, y: 8 * FT }] });
    m.ok(PRIYA, {
      type: "route_run",
      idPrefix: "san-wc",
      levelId: "lvl-1",
      domain: "pipe",
      size: { shape: "pipe", nominalMm: 3 * IN, material: "pvc" },
      elevationMm: -2 * FT,
      system: SAN,
      points: [{ x: -150, y: 10 * FT }, { x: -150, y: 8 * FT }],
      from: { kind: "part", partId: "wc", connectorId: "waste" },
      to: { kind: "run_branch", segmentId: "san-main-s1" },
    });
    const wye = Object.values(m.head.elements).find((el): el is RunFitting => el.kind === "run_fitting" && el.host?.segmentId === "san-main-s1");
    // A horizontal drain joining a horizontal main takes a combination wye & 1/8 bend, not a sanitary tee.
    expect(wye?.label).toBe("Combination wye & 1/8 bend");
    expect(wye?.family).toBe("dwv.combo_wye_eighth");
    // The 4" main falls 1/8" per ft from its first point; the closet's drop turns into the level arm with a long sweep.
    const main = m.seg("san-main-s1");
    expect(main.start.z - main.end.z).toBeCloseTo(0.125 * 20 * IN, 1);
    const turn = Object.values(m.head.elements).find((el): el is RunFitting => el.kind === "run_fitting" && el.fittingType === "elbow" && el.systemId === "sys-san");
    expect(turn?.family).toBe("dwv.quarter_bend_long_sweep");
    expect(m.seg("san-main-s1").flow).toBe(4);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
    // A 6" branch can't come off a 4" main.
    expect(
      m.refused(PRIYA, {
        type: "route_run",
        idPrefix: "san-big",
        levelId: "lvl-1",
        domain: "pipe",
        size: { shape: "pipe", nominalMm: 6 * IN, material: "pvc" },
        elevationMm: -2 * FT,
        system: SAN,
        points: [{ x: 5 * FT, y: 8 * FT }, { x: 5 * FT, y: 4 * FT }],
        from: { kind: "run_branch", segmentId: "san-main-s1" },
      }),
    ).toMatch(/6" PVC branch is larger than the 4" PVC trunk/);
  });
});

describe("plan views draw routed runs", () => {
  it("double-line duct with its size label, and the parts' symbols; hiding duct hides it", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    const view: ViewElement = { id: asElementId("plan-1"), kind: "view", version: 1, authoredRev: {}, name: "Level 1 plan", viewType: "floor_plan", cropMin: { x: -10 * FT, y: -10 * FT }, cropMax: { x: 30 * FT, y: 10 * FT }, props: { scale: 48, level: "Level 1" } };
    const prims: Primitive[] = [];
    const tags: TagPlacement[] = [];
    drawView(prims, tags, m.head, view, { center: { x: 400, y: 300 }, size: { x: 800, y: 600 }, scale: 48, modelCenter: { x: 10 * FT, y: 0 } });
    const lines = prims.filter((p) => p.kind === "line");
    // The trunk's two sides, 14" apart, running east. The RTU sits 2 ft above its first 3'-9" in plan,
    // so with hidden lines removed each side starts where the unit's footprint ends.
    const trunkSides = lines.filter((l) => l.kind === "line" && Math.abs(l.a.y - l.b.y) < 1e-6 && Math.abs(l.b.x - l.a.x) > 90);
    expect(trunkSides.length).toBeGreaterThanOrEqual(2);
    const rtuEdgeX = 400 + (1150 - 10 * FT) / 48;
    for (const side of trunkSides) expect(Math.min(side.a.x, side.b.x)).toBeGreaterThanOrEqual(rtuEdgeX - 0.02);
    // Shown hidden lines: the covered stretch comes back dashed.
    const dashedPrims: Primitive[] = [];
    drawView(dashedPrims, [], m.head, { ...view, props: { ...view.props, showHiddenLines: true } }, { center: { x: 400, y: 300 }, size: { x: 800, y: 600 }, scale: 48, modelCenter: { x: 10 * FT, y: 0 } });
    expect(dashedPrims.some((l) => l.kind === "line" && l.dash !== undefined && Math.abs(l.a.y - l.b.y) < 1e-6 && Math.max(l.a.x, l.b.x) <= rtuEdgeX + 0.01 && Math.abs(l.b.x - l.a.x) > 15)).toBe(true);
    // Long pieces carry their size; the short branch pieces at 1/4" scale don't.
    expect(tags.map((t) => t.text)).toEqual(['14"x10"']);
    expect(prims.some((p) => p.kind === "text" && p.text === "SD-1")).toBe(true);
    const hidden = { ...view, props: { ...view.props, hiddenCategories: ["duct" as const, "duct_fitting" as const] } };
    const without: Primitive[] = [];
    drawView(without, [], m.head, hidden, { center: { x: 400, y: 300 }, size: { x: 800, y: 600 }, scale: 48, modelCenter: { x: 10 * FT, y: 0 } });
    expect(without.filter((p) => p.kind === "line").length).toBeLessThan(lines.length);
  });
});

describe("slide_branch keeps the trunk connection", () => {
  it("slides a tap along the trunk; the branch follows and stretches, the trunk stays one piece", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    m.ok(PRIYA, { type: "slide_branch", tapId: "br-f3", s: 6 * FT + 400 });
    const tap = m.fitting("br-f3");
    expect(tap.host?.segmentId).toBe("trunk-s2");
    expect(tap.ports[0]?.position.x).toBeCloseTo(6 * FT);
    expect(m.seg("br-s1").start.x).toBeCloseTo(6 * FT);
    // The leg running along the slide stretched; SD-2 did not move.
    expect(m.seg("br-s2").start.x).toBeCloseTo(6 * FT);
    expect(m.seg("br-s2").end.x).toBeCloseTo(10 * FT);
    expect(m.part("sd-b").position).toEqual({ x: 10 * FT, y: 4 * FT });
    expect(m.ids("trunk-s").length).toBe(3);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses a slide that would crush the stretching leg, and one off the trunk's end", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    expect(m.refused(PRIYA, { type: "slide_branch", tapId: "br-f3", s: 10 * FT + 300 })).toMatch(/shorter than the 150 mm minimum straight piece/);
    expect(m.refused(PRIYA, { type: "slide_branch", tapId: "br-f3", s: 100 })).toMatch(/within 300 mm of the end/);
  });
});

describe("moving equipment respects fixed connections", () => {
  it("moving the RTU along the trunk stretches it; branches stay put", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    m.ok(PRIYA, { type: "move_elements", ids: ["rtu"], delta: { x: -2 * FT, y: 0 } });
    expect(m.seg("trunk-s1").start.x).toBeCloseTo(-400 - 2 * FT);
    expect(m.seg("trunk-s2").start.x).toBeCloseTo(-400 - 2 * FT);
    expect(m.fitting("br-f3").ports[0]?.position.x).toBeCloseTo(8 * FT);
    expect(m.fitting("br-f3").host?.s).toBeCloseTo(10 * FT + 400);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses a move that would drag a connected diffuser", () => {
    const m = airFixture();
    routeTrunk(m);
    expect(m.refused(PRIYA, { type: "move_elements", ids: ["rtu"], delta: { x: 0, y: 2 * FT } })).toBe(
      "SD-1 is connected and stays where it is; this would drag it along. Move it too, or disconnect it first",
    );
    // Moving both together is allowed: the whole run translates.
    m.ok(PRIYA, { type: "move_elements", ids: ["rtu", "sd-a"], delta: { x: 0, y: 2 * FT } });
    expect(m.seg("trunk-s2").start.y).toBeCloseTo(2 * FT);
    expect(validateModel(m.head)).toEqual([]);
    expect(m.refused(PRIYA, { type: "rotate_elements", ids: ["rtu"], angleDeg: 90 })).toMatch(/has runs connected to it; disconnect them before rotating it/);
  });
});

describe("resize_run updates compatible fittings or refuses", () => {
  it("resizes the trunk: elbows and both transitions follow, the tap moves out with the wider face", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    const wider = { shape: "rect" as const, width: 16 * IN, height: 10 * IN };
    m.ok(PRIYA, { type: "resize_run", segmentId: "trunk-s2", profile: wider });
    for (const k of ["trunk-s1", "trunk-s2", "trunk-s3"]) expect(m.seg(k).size).toEqual(wider);
    const elbows = m.ids("trunk-f").map((k) => m.fitting(k)).filter((f) => f.fittingType === "elbow");
    for (const e of elbows) for (const p of e.ports) expect(p.size).toEqual(wider);
    expect(m.fitting("br-f3").ports[0]?.position.y).toBeCloseTo(8 * IN);
    expect(m.seg("br-s1").start.y).toBeCloseTo(8 * IN);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses a size that makes a transition pointless, or that a connector can't take", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    expect(m.refused(PRIYA, { type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 24 * IN, height: 12 * IN } })).toMatch(/would join two runs of the same size; delete it instead/);
    expect(m.refused(PRIYA, { type: "resize_run", segmentId: "br-s2", profile: { shape: "round", diameter: 10 * IN } })).toMatch(/SD-2's neck doesn't fit 10"Ø; it needs a transition/);
    expect(m.refused(PRIYA, { type: "resize_run", segmentId: "br-s2", profile: { shape: "pipe", nominalMm: 50, material: "copper" } })).toMatch(/isn't a duct size/);
  });
});

describe("delete_elements handles run dependencies", () => {
  it("refuses by default, then cascade removes the tap, caps the branch and keeps the trunk whole", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    expect(m.refused(PRIYA, { type: "delete_elements", ids: ["br-f3"], policy: "refuse" })).toMatch(/Nothing deleted: this would leave 1 connection pointing at nothing/);
    const r = executeCommand(m.head, { type: "delete_elements", ids: ["br-f3"], policy: "cascade" });
    expect(r.ok && r.summary).toEqual(["The trunk stays whole where the branch was taken off", "1 open end was capped"]);
    m.ok(PRIYA, { type: "delete_elements", ids: ["br-f3"], policy: "cascade" });
    expect(m.seg("trunk-s2").branches).toEqual([]);
    const cap = m.fitting("br-s1-cap-start");
    expect(cap.label).toBe("End cap");
    expect(m.seg("br-s1").links.start).toEqual({ elementId: "br-s1-cap-start", port: "a" });
    expect(m.seg("trunk-s2").flow).toBe(150);
    expectSymmetricLinks(m.head);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("a trunk with branches refuses unless they go too; deleting a diffuser can leave the run open", () => {
    const m = airFixture();
    routeTrunk(m);
    routeBranch(m);
    expect(m.refused(PRIYA, { type: "delete_elements", ids: ["trunk-s2"], policy: "disconnect" })).toMatch(/1 item that depend on it/);
    const r = executeCommand(m.head, { type: "delete_elements", ids: ["sd-b"], policy: "disconnect" });
    expect(r.ok && r.summary).toEqual(["1 run end is left open"]);
    m.ok(PRIYA, { type: "delete_elements", ids: ["sd-b"], policy: "disconnect" });
    expect(m.seg("br-s3").links.end).toBeUndefined();
    expect(m.seg("trunk-s2").flow).toBe(150);
    expect(validateModel(m.head)).toEqual([]);
  });
});

describe("collaborative undo and stale protection on routed runs", () => {
  it("undo refuses over another person's newer work on the same run", () => {
    const m = airFixture();
    const routed = routeTrunk(m, PRIYA);
    m.ok(MARCO, { type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 16 * IN, height: 10 * IN } });
    expect(m.refused(PRIYA, { type: "undo", revision: routed.revision })).toMatch(/Marco changed this since \(revision \d+\); undo would overwrite their work/);
    expect(m.ids("trunk-s").length).toBe(3);
  });

  it("undoing your own route removes it whole and frees the connectors", () => {
    const m = airFixture();
    const routed = routeTrunk(m, PRIYA);
    m.ok(PRIYA, { type: "undo", revision: routed.revision });
    expect(m.ids("trunk")).toEqual([]);
    expect(m.head.elements["sys-sa"]).toBeUndefined();
    expect(m.part("rtu").links).toBeUndefined();
    expect(m.part("sd-a").links).toBeUndefined();
    expect(validateModel(m.head)).toEqual([]);
  });

  it("two sessions of the same person conflict: the second tab's resize from an old base is refused", () => {
    const m = airFixture();
    routeTrunk(m);
    const base = m.head.revision;
    m.ok(PRIYA, { type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 16 * IN, height: 10 * IN } }, base);
    const d = m.submit(PRIYA_OTHER_TAB, { type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 18 * IN, height: 10 * IN } }, base);
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error.code).toBe("conflict");
    expect(d.error.message).toMatch(/Priya changed trunk-s2 size while you were editing/);
    // The same tab, building on its own unconfirmed edit, is not a conflict.
    m.ok(PRIYA, { type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 18 * IN, height: 10 * IN } }, base);
  });

  it("two people routing onto the same connector: the second is refused, not doubled", () => {
    const m = airFixture();
    const base = m.head.revision;
    routeTrunk(m, PRIYA);
    const d = m.submit(MARCO, {
      type: "route_run",
      idPrefix: "marco",
      levelId: "lvl-1",
      domain: "duct",
      size: BRANCH,
      elevationMm: 10 * FT,
      system: SA,
      points: [{ x: 14 * FT, y: 0 }],
      to: { kind: "part", partId: "sd-a", connectorId: "neck" },
    }, base);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.message).toBe("SD-1's neck is already connected");
  });
});

describe("connect_runs / disconnect_run", () => {
  it("connects a free run end that meets a connector, and disconnects it again", () => {
    const m = airFixture();
    m.ok(PRIYA, { type: "route_run", idPrefix: "loose", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 8 * FT + 150, system: SA, points: [{ x: 14 * FT, y: 4 * FT }, { x: 10 * FT, y: 4 * FT }] });
    // The neck faces up; this run is level, so they don't face each other.
    expect(m.refused(PRIYA, { type: "connect_runs", a: { elementId: "loose-s1", port: "end" }, b: { elementId: "sd-b", port: "neck" } })).toMatch(/don't face each other/);
    expect(m.refused(PRIYA, { type: "connect_runs", a: { elementId: "loose-s1", port: "start" }, b: { elementId: "sd-b", port: "neck" } })).toMatch(/apart; route between them instead/);
    m.ok(PRIYA, { type: "route_run", idPrefix: "drop", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 11 * FT, system: SA, points: [{ x: 10 * FT, y: 6 * FT }], to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
    m.ok(PRIYA, { type: "disconnect_run", elementId: "sd-b", port: "neck" });
    expect(m.part("sd-b").links).toBeUndefined();
    const end = m.seg("drop-s2");
    m.ok(PRIYA, { type: "connect_runs", a: { elementId: end.id, port: "end" }, b: { elementId: "sd-b", port: "neck" } });
    expect(m.part("sd-b").links?.neck).toEqual({ elementId: "drop-s2", port: "end" });
    expect(validateModel(m.head)).toEqual([]);
  });
});
