/**
 * @jest-environment node
 *
 * Connecting existing duct to itself as one edit (Product decision, Oct 22 2026): the
 * "+" on an elbow makes a tee, two open ends that don't meet are joined by a
 * square route, and an end dragged onto another duct's side taps into it.
 * None of these commands existed before; each is checked for links, heights,
 * systems and a model that validates.
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  autoRoutePaths,
  canonicalJson,
  planCommit,
  validateModel,
  type Changeset,
  type Command,
  type CommandRequest,
  type ModelState,
  type RunFitting,
  type RunSegment,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-22T00:00:00.000Z";
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };
const ROUND8 = { shape: "round" as const, diameter: 8 * IN };
const Z = 12 * FT + 2.75 * IN;

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor() {
    this.head = { modelId: "connect", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  }
  submit(command: Command) {
    counter += 1;
    const base = this.head.revision;
    const req: CommandRequest = { idempotencyKey: `cc-${counter}`, baseRevision: base, actor: { id: "avery", name: "Avery", kind: "human" }, command, clientSessionId: "tab" };
    const decision = planCommit(this.head, this.log.filter((cs) => cs.revision > base), req, NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(command: Command): Changeset {
    const d = this.submit(command);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  refused(command: Command): string {
    const before = this.head;
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    expect(this.head).toBe(before);
    return d.error.message;
  }
  segs(): RunSegment[] {
    return Object.values(this.head.elements).filter((e): e is RunSegment => e.kind === "run_segment");
  }
  fits(): RunFitting[] {
    return Object.values(this.head.elements).filter((e): e is RunFitting => e.kind === "run_fitting");
  }
}

describe("elbow_to_tee: the + on an elbow's free side", () => {
  test("the east leg runs on through the corner and ends open; the north leg joins it as a branch; one edit", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "L", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }, { x: 20 * FT, y: 15 * FT }] });
    const elbow = m.fits().find((f) => f.fittingType === "elbow");
    if (!elbow) throw new Error("no elbow");
    const eastLeg = m.segs().find((s) => Math.abs(s.start.y - s.end.y) < 1);
    const northLeg = m.segs().find((s) => Math.abs(s.start.x - s.end.x) < 1);
    const through = elbow.ports.find((p) => p.link?.elementId === eastLeg?.id);
    if (!eastLeg || !northLeg || !through) throw new Error("expected an L");
    const before = m.log.length;
    m.ok({ type: "elbow_to_tee", fittingId: elbow.id, through: through.id, idPrefix: "tee1" });
    expect(m.log.length).toBe(before + 1);
    expect(m.head.elements[elbow.id]).toBeUndefined();
    const trunk = m.head.elements[eastLeg.id];
    if (trunk?.kind !== "run_segment") throw new Error("trunk gone");
    const far = trunk.start.x > trunk.end.x ? "start" : "end";
    expect(Math.max(trunk.start.x, trunk.end.x)).toBeGreaterThan(20 * FT);
    expect(trunk.links[far]).toBeUndefined();
    const takeoff = m.fits().find((f) => f.host?.segmentId === trunk.id);
    expect(takeoff).toBeDefined();
    expect(m.segs().every((s) => Math.abs(s.start.z - Z) < 1 && Math.abs(s.end.z - Z) < 1)).toBe(true);
    expect(m.segs().every((s) => s.systemId === "sys-sa")).toBe(true);
    const branchLeg = m.head.elements[northLeg.id];
    expect(branchLeg?.kind === "run_segment" && (branchLeg.links.start || branchLeg.links.end)).toBeTruthy();
    expect(validateModel(m.head)).toEqual([]);
  });

  test("a riser's elbow is refused in plain words", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "R", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0, elevationMm: Z + 4 * FT }] });
    const elbow = m.fits().find((f) => f.fittingType === "elbow");
    if (!elbow) throw new Error("no elbow");
    expect(m.refused({ type: "elbow_to_tee", fittingId: elbow.id, through: elbow.ports[0]?.id ?? "a", idPrefix: "t" })).toMatch(/Only a level elbow turns into a tee/);
  });
});

describe("auto_connect_runs: two open ends that don't meet face to face", () => {
  test("ends 15 ft apart east-west, 8 ft apart north-south and 2 ft apart in height are joined, linked both ends", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "A", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    m.ok({ type: "route_run", idPrefix: "B", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 12 * FT, system: SA, points: [{ x: 25 * FT, y: 8 * FT }, { x: 40 * FT, y: 8 * FT }] });
    m.ok({ type: "auto_connect_runs", a: { elementId: "A-s1", port: "end" }, b: { elementId: "B-s1", port: "start" }, idPrefix: "J" });
    const a = m.head.elements["A-s1"];
    const b = m.head.elements["B-s1"];
    expect(a?.kind === "run_segment" && a.links.end).toBeTruthy();
    expect(b?.kind === "run_segment" && b.links.start).toBeTruthy();
    expect(m.segs().some((s) => s.id.startsWith("J") && Math.abs(s.start.z - s.end.z) > 100)).toBe(true);
    expect(validateModel(m.head)).toEqual([]);
  });

  test("ends on different systems are refused with the reason", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "A", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }] });
    m.ok({ type: "route_run", idPrefix: "B", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: { id: "sys-ra", kind: "return_air", name: "Return Air 1" }, points: [{ x: 25 * FT, y: 8 * FT }, { x: 40 * FT, y: 8 * FT }] });
    expect(m.refused({ type: "auto_connect_runs", a: { elementId: "A-s1", port: "end" }, b: { elementId: "B-s1", port: "start" }, idPrefix: "J" })).toMatch(/No square route joins those two ends.*Return Air 1/);
  });

  test("candidate paths leave each end straight out and rise once on a straight stretch", () => {
    const paths = autoRoutePaths({ at: { x: 0, y: 0, z: 0 }, out: { x: 1, y: 0, z: 0 } }, { at: { x: 5000, y: 3000, z: 600 }, out: { x: -1, y: 0, z: 0 } }, 600);
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths) {
      expect(p[0]?.x).toBe(600);
      expect(p.filter((q) => q.elevationMm !== undefined)).toHaveLength(1);
    }
  });
});

describe("stretch_to_side: an open end dragged onto another duct's side", () => {
  function setup(branchZ: number) {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "T", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
    m.ok({ type: "route_run", idPrefix: "P", levelId: "lvl-1", domain: "duct", size: ROUND8, elevationMm: branchZ, system: SA, points: [{ x: 10 * FT, y: 12 * FT }, { x: 10 * FT, y: 4 * FT }] });
    return m;
  }

  test("at the trunk's height it continues straight into the trunk with a tap", () => {
    const m = setup(Z);
    m.ok({ type: "stretch_to_side", from: { elementId: "P-s1", port: "end" }, onto: "T-s1", idPrefix: "S" });
    const piece = m.head.elements["P-s1"];
    expect(piece?.kind === "run_segment" && piece.links.end).toBeTruthy();
    expect(m.fits().some((f) => f.host?.segmentId === "T-s1")).toBe(true);
    expect(validateModel(m.head)).toEqual([]);
  });

  test("at another height it rises to the trunk's height on the way and taps in", () => {
    const m = setup(10 * FT);
    m.ok({ type: "stretch_to_side", from: { elementId: "P-s1", port: "end" }, onto: "T-s1", idPrefix: "S" });
    expect(m.fits().some((f) => f.host?.segmentId === "T-s1")).toBe(true);
    expect(m.segs().some((s) => s.id.startsWith("S") && Math.abs(s.start.z - s.end.z) > 100)).toBe(true);
    expect(validateModel(m.head)).toEqual([]);
  });

  test("dragged alongside the trunk instead of onto its side: refused with the reason", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "T", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
    m.ok({ type: "route_run", idPrefix: "P", levelId: "lvl-1", domain: "duct", size: ROUND8, elevationMm: Z, system: SA, points: [{ x: 0, y: 6 * FT }, { x: 10 * FT, y: 6 * FT }] });
    expect(m.refused({ type: "stretch_to_side", from: { elementId: "P-s1", port: "end" }, onto: "T-s1", idPrefix: "S" })).toMatch(/runs alongside/);
  });
});

describe("drag_run along a piece and square to it at once", () => {
  test("east and down on an east-west duct is two moves saved as one edit (it used to be refused as at an angle)", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "T", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: Z, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
    const before = m.log.length;
    m.ok({ type: "drag_run", elementId: "T-s1", delta: { x: FT, y: 0, z: -4 * FT } });
    expect(m.log.length).toBe(before + 1);
    const t = m.head.elements["T-s1"];
    if (t?.kind !== "run_segment") throw new Error("trunk gone");
    expect(Math.min(t.start.x, t.end.x)).toBeCloseTo(FT, 3);
    expect(t.start.z).toBeCloseTo(Z - 4 * FT, 3);
  });
});
