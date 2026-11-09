/**
 * @jest-environment node
 *
 * Fittings correctness (Oct 22 2026 mechanical comments, workstream 3). Each
 * case fails on the kernel before this change:
 * - a reducer placed by split + resize carried no insulation (stretch-commands
 *   built it without the segment's wrap), and an offset's new elbows lost it too;
 * - resizing a run with a smooth radius elbow to round was refused ("Smooth
 *   radius elbow isn't made in round duct") instead of taking the round elbow;
 * - duct legs had to run at 45° steps and turn 45° or 90°;
 * - a Mirror (flat side only) reset the transition's other parameters.
 */
import {
  DEFAULT_SETTINGS,
  ROUTE_SNAP_ANGLES_DEG,
  applyChangeset,
  canonicalJson,
  elbowTurnFor,
  executeCommand,
  fittingBody,
  planCommit,
  routeSnapHeadings,
  transitionShape,
  resolveFitting,
  validateModel,
  type Changeset,
  type Command,
  type CommandRequest,
  type DuctInsulation,
  type MepSystem,
  type ModelState,
  type RunFitting,
  type RunSegment,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-22T00:00:00.000Z";
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };
const WRAP: DuctInsulation = { kind: "wrap", thicknessMm: 2 * IN };

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  readonly summaries: string[][] = [];
  constructor() {
    this.head = { modelId: "fit", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  }
  submit(command: Command) {
    counter += 1;
    const req: CommandRequest = { idempotencyKey: `fc-${counter}`, baseRevision: this.head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command, clientSessionId: "tab" };
    const decision = planCommit(this.head, [], req, NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(command: Command): void {
    const predicted = executeCommand(this.head, command);
    const d = this.submit(command);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    this.summaries.push(predicted.ok ? [...(predicted.summary ?? [])] : []);
  }
  refused(command: Command): string {
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    return d.error.message;
  }
  seg(id: string): RunSegment {
    const el = this.head.elements[id];
    if (el?.kind !== "run_segment") throw new Error(`${id} is ${el?.kind ?? "missing"}`);
    return el;
  }
  fittings(type: RunFitting["fittingType"]): RunFitting[] {
    return Object.values(this.head.elements).filter((el): el is RunFitting => el.kind === "run_fitting" && el.fittingType === type);
  }
  system(): MepSystem {
    const s = this.head.elements[SA.id];
    if (s?.kind !== "mep_system") throw new Error("no system");
    return s;
  }
}

/** 40 ft of 14x10 with a 2" wrap, east at 10 ft. */
function wrappedRun(): Model {
  const m = new Model();
  m.ok({ type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 40 * FT, y: 0 }], insulation: WRAP });
  return m;
}

describe("a reducer placed by a resize carries the insulation of the duct it joins", () => {
  it("split, then resize one side: the new transition has the 2-inch wrap", () => {
    const m = wrappedRun();
    m.ok({ type: "split_run", idPrefix: "cut", segmentId: "main-s1", atMm: 20 * FT });
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["cut-s1"], size: { shape: "rect", width: 12 * IN, height: 10 * IN } });
    const [reducer] = m.fittings("transition");
    expect(reducer?.insulation).toEqual(WRAP);
    expect(m.seg("cut-s1").insulation).toEqual(WRAP);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("resizing a stretch between two points on one piece wraps both transitions", () => {
    const m = wrappedRun();
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["main-s1"], fromMm: 10 * FT, toMm: 30 * FT, size: { shape: "rect", width: 12 * IN, height: 10 * IN } });
    const transitions = m.fittings("transition");
    expect(transitions).toHaveLength(2);
    for (const t of transitions) expect(t.insulation).toEqual(WRAP);
  });

  it("an offset's new elbows and pieces keep the wrap", () => {
    const m = wrappedRun();
    m.ok({ type: "offset_run", idPrefix: "off", segmentId: "main-s1", atMm: 10 * FT, offset: { x: 0, y: 0, z: 2 * FT }, lengthMm: 10 * FT, style: "90" });
    const added = Object.values(m.head.elements).filter((el) => (el.kind === "run_segment" || el.kind === "run_fitting") && el.id.startsWith("off-"));
    expect(added.length).toBeGreaterThan(3);
    for (const el of added) expect(el.kind === "run_segment" || el.kind === "run_fitting" ? el.insulation : null).toEqual(WRAP);
  });
});

describe("resizing a run to round swaps fittings not made in round", () => {
  /** An L of 14x10: east 20 ft, a 90° smooth radius elbow, north 20 ft. */
  function ell(): Model {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "l", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: 20 * FT }] });
    const [elbow] = m.fittings("elbow");
    expect(elbow?.family).toBe("duct.elbow.radius");
    return m;
  }

  it("the selected run (two pieces and the elbow) becomes round with the system's round elbow, and the edit says why", () => {
    const m = ell();
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["l-s1", "l-s2"], size: { shape: "round", diameter: 12 * IN } });
    const [elbow] = m.fittings("elbow");
    expect(elbow?.family).toBe("duct.elbow.gored");
    expect(elbow?.ports.every((p) => p.size.shape === "round")).toBe(true);
    expect(m.summaries.at(-1)?.join(" ")).toMatch(/The 90° elbow .*is now a gored round elbow: smooth radius elbow isn't made in round duct/);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("resize_run (the agent's whole-run resize) swaps it the same way", () => {
    const m = ell();
    m.ok({ type: "resize_run", segmentId: "l-s1", profile: { shape: "round", diameter: 12 * IN } });
    expect(m.fittings("elbow")[0]?.family).toBe("duct.elbow.gored");
    expect(validateModel(m.head)).toEqual([]);
  });

  it("an elbow whose type is made in round keeps its type (a mitred elbow stays mitred)", () => {
    const m = ell();
    const [elbow] = m.fittings("elbow");
    if (!elbow) throw new Error("no elbow");
    m.ok({ type: "swap_fitting", fittingId: elbow.id, family: "duct.elbow.mitred" });
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["l-s1", "l-s2"], size: { shape: "round", diameter: 12 * IN } });
    expect(m.fittings("elbow")[0]?.family).toBe("duct.elbow.mitred");
  });

  it("a system whose round elbow can't be placed is refused with both reasons", () => {
    const m = ell();
    // A system set to place vaned elbows in round slots can't be: the refusal names both.
    const s = m.system();
    m.head = { ...m.head, elements: { ...m.head.elements, [s.id]: { ...s, fittingDefaults: { elbow_round: { family: "duct.elbow.mitred_vanes" } } } } };
    const why = m.refused({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["l-s1", "l-s2"], size: { shape: "round", diameter: 12 * IN } });
    expect(why).toMatch(/can't follow the new size: smooth radius elbow isn't made in round duct, and .*mitred elbow with turning vanes/i);
  });
});

describe("turns at any angle, with the elbow made to it", () => {
  it("snaps to every 15° and 22.5° heading", () => {
    expect(ROUTE_SNAP_ANGLES_DEG).toEqual([15, 22.5]);
    const h = routeSnapHeadings();
    for (const a of [0, 15, 22.5, 30, 45, 60, 67.5, 75, 90, 112.5, 135, 180, 337.5]) expect(h).toContain(a);
    expect(h).not.toContain(7.5);
  });

  it("a 30° turn in plan routes with one 30° elbow, cut back by r/W x W x tan(15°)", () => {
    const m = new Model();
    const a = (30 * Math.PI) / 180;
    m.ok({ type: "route_run", idPrefix: "a", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT + 20 * FT * Math.cos(a), y: 20 * FT * Math.sin(a) }] });
    const elbows = m.fittings("elbow");
    expect(elbows).toHaveLength(1);
    const [elbow] = elbows;
    if (!elbow) throw new Error("no elbow");
    expect(elbow.angleDeg).toBe(30);
    expect(elbow.label).toBe("30° elbow");
    // Turning in plan, the 14" width is in the plane of the turn: r/W 1 → 355.6 x tan 15° = 95.28 mm.
    expect(fittingBody(m.head.elements, elbow).takeoffs.a).toBeCloseTo(14 * IN * Math.tan(Math.PI / 12), 2);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("a 22.5° heading and a 60° turn route too", () => {
    const m = new Model();
    const p = (deg: number, len: number, from: { x: number; y: number }) => ({ x: from.x + len * Math.cos((deg * Math.PI) / 180), y: from.y + len * Math.sin((deg * Math.PI) / 180) });
    const p1 = p(22.5, 15 * FT, { x: 0, y: 0 });
    const p2 = p(82.5, 15 * FT, p1);
    m.ok({ type: "route_run", idPrefix: "b", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, p1, p2] });
    expect(m.fittings("elbow").map((e) => e.angleDeg)).toEqual([60]);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("an elbow type made only for 45° and 90° refuses 30° with its reason", () => {
    const m = new Model();
    const a = (30 * Math.PI) / 180;
    const why = m.refused({ type: "route_run", idPrefix: "v", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT + 20 * FT * Math.cos(a), y: 20 * FT * Math.sin(a) }], fittings: { elbow_rect: { family: "duct.elbow.mitred_vanes" } } });
    expect(why).toMatch(/made for 45° and 90° turns; this one turns 30°/);
  });

  it("pipe stays on 45° steps (pipe fittings are made at 45° and 90°)", () => {
    expect(elbowTurnFor(true, 30, 0.5, 2)).toMatch(/pipe elbows turn 45° or 90°/);
    expect(elbowTurnFor(false, 30, 0.5, 2)).toBe(30);
    expect(elbowTurnFor(false, 150, 0.5, 2)).toMatch(/at most 135°/);
  });
});

describe("eccentric transitions: flat side and mirror", () => {
  it("a resize with an eccentric flat-on-top transition keeps the top of duct level", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "e", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 14 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 40 * FT, y: 0 }] });
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["e-s1"], fromMm: 20 * FT, size: { shape: "rect", width: 14 * IN, height: 10 * IN }, transition: { family: "duct.transition.eccentric", params: { flat: "top" } } });
    const [t] = m.fittings("transition");
    if (!t) throw new Error("no transition");
    expect(t.params?.flat).toBe("top");
    const body = fittingBody(m.head.elements, t);
    const [r0, r1] = body.tubes[0]?.rings ?? [];
    const top = (r: typeof r0) => (r ? r.center.z + Math.abs(r.b.z) : NaN);
    expect(top(r1)).toBeCloseTo(top(r0), 3);
    const rf = resolveFitting(m.system(), t);
    if (!rf) throw new Error("unresolved");
    expect(transitionShape(t.ports[0]?.size ?? TRUNK, t.ports[1]?.size ?? TRUNK, rf).shiftH).toBeCloseTo(2 * IN, 3);
  });

  it("Mirror (only the flat side given) keeps the wall angle the person chose", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "e", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 14 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 40 * FT, y: 0 }] });
    m.ok({ type: "resize_stretch", idPrefix: "rs", segmentIds: ["e-s1"], fromMm: 20 * FT, size: { shape: "rect", width: 14 * IN, height: 10 * IN }, transition: { family: "duct.transition.eccentric", params: { flat: "top", wall_angle_deg: 20 } } });
    const [t] = m.fittings("transition");
    if (!t) throw new Error("no transition");
    m.ok({ type: "swap_fitting", fittingId: t.id, family: "duct.transition.eccentric", params: { flat: "bottom" } });
    const after = m.fittings("transition")[0];
    expect(after?.params).toEqual({ flat: "bottom", wall_angle_deg: 20 });
  });
});
