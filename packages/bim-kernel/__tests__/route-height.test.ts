/**
 * @jest-environment node
 *
 * A route that doesn't say its height takes it from what it starts on: a
 * branch takes the trunk's centreline height, a continued open end takes the
 * end's. The 7303 case: a 14"x10" trunk at 12'-2.75" with the Route
 * panel still at 10 ft. Before this, `elevationMm` was required and a branch
 * at any other height than the trunk's was refused ("A branch leaves … at its
 * height (12.23 ft); route the branch at that height").
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  canonicalJson,
  inheritedRouteHeight,
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
const BRANCH = { shape: "round" as const, diameter: 8 * IN };
const TRUNK_Z = 12 * FT + 2.75 * IN;

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor() {
    this.head = { modelId: "route-height", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    this.ok({ type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: TRUNK_Z, system: SA, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
  }
  submit(command: Command) {
    counter += 1;
    const base = this.head.revision;
    const req: CommandRequest = { idempotencyKey: `rh-${counter}`, baseRevision: base, actor: { id: "avery", name: "Avery", kind: "human" }, command, clientSessionId: "tab" };
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
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    return d.error.message;
  }
  segments(prefix: string): RunSegment[] {
    return Object.values(this.head.elements).filter((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith(prefix));
  }
}

describe("route height inherited from what the route starts on", () => {
  test("a branch with no height lands on the trunk's centreline, on the trunk's system, linked", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "tap", levelId: "lvl-1", domain: "duct", size: BRANCH, system: SA, points: [{ x: 10 * FT, y: 0 }, { x: 10 * FT, y: 6 * FT }], from: { kind: "run_branch", segmentId: "trunk-s1" } });
    const [branch] = m.segments("tap-");
    expect(branch).toBeDefined();
    expect(branch?.start.z).toBeCloseTo(TRUNK_Z, 3);
    expect(branch?.end.z).toBeCloseTo(TRUNK_Z, 3);
    expect(branch?.systemId).toBe("sys-sa");
    const takeoff = Object.values(m.head.elements).find((e): e is RunFitting => e.kind === "run_fitting" && e.host !== undefined);
    expect(takeoff?.host?.segmentId).toBe("trunk-s1");
    expect(branch?.links.start?.elementId).toBe(takeoff?.id);
    expect(validateModel(m.head)).toEqual([]);
  });

  test("a typed height that isn't the trunk's is still refused with the trunk's height (explicit wins, nothing is guessed)", () => {
    const m = new Model();
    const message = m.refused({ type: "route_run", idPrefix: "tap", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 10 * FT, system: SA, points: [{ x: 10 * FT, y: 0 }, { x: 10 * FT, y: 6 * FT }], from: { kind: "run_branch", segmentId: "trunk-s1" } });
    expect(message).toMatch(/at its height \(12\.23 ft\)/);
  });

  test("continuing an open end with no height carries on at the end's height", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "more", levelId: "lvl-1", domain: "duct", size: TRUNK, system: SA, points: [{ x: 40 * FT, y: 0 }], from: { kind: "run_end", elementId: "trunk-s1", port: "end" } });
    const [more] = m.segments("more-");
    expect(more?.start.z).toBeCloseTo(TRUNK_Z, 3);
    expect(more?.end.x).toBeCloseTo(40 * FT, 3);
  });

  test("a free route with no height is refused in plain words", () => {
    const m = new Model();
    expect(m.refused({ type: "route_run", idPrefix: "free", levelId: "lvl-1", domain: "duct", size: BRANCH, system: SA, points: [{ x: 0, y: 10 * FT }, { x: 10 * FT, y: 10 * FT }] })).toMatch(/Give the run a height/);
  });

  test("a route that rises on the way can finish on the trunk's side (the trunk is compared with its height after the rise)", () => {
    const m = new Model();
    m.ok({ type: "route_run", idPrefix: "up", levelId: "lvl-1", domain: "duct", size: BRANCH, elevationMm: 10 * FT, system: SA, points: [{ x: 10 * FT, y: 12 * FT }, { x: 10 * FT, y: 8 * FT, elevationMm: TRUNK_Z }, { x: 10 * FT, y: 0 }], to: { kind: "run_branch", segmentId: "trunk-s1" } });
    expect(m.segments("up-").some((s) => Math.abs(s.end.z - TRUNK_Z) < 1 && Math.abs(s.end.y) < 400)).toBe(true);
  });

  test("inheritedRouteHeight reads the trunk where the branch's first point is", () => {
    const m = new Model();
    expect(inheritedRouteHeight(m.head, { from: { kind: "run_branch", segmentId: "trunk-s1" }, points: [{ x: 5 * FT, y: 0 }] })).toBeCloseTo(TRUNK_Z, 3);
  });
});
