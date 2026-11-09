/**
 * @jest-environment node
 *
 * Dragging routed runs that are not square: 45° offsets in plan, 45° and
 * vertical rises, the stop where an elbow runs out of room, and flipping the
 * elbows when a leg is dragged back past its end. Fails on the kernel before
 * these existed: an angled piece's neighbours refused ("at an angle"), a leg
 * pulled past its elbow committed backwards (elbows facing the wrong way), and
 * there was no `grip`, `reroute` or `dragLimit`.
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  canonicalJson,
  dragLimit,
  executeCommand,
  planCommit,
  validateModel,
  type Changeset,
  type Command,
  type CommandRequest,
  type ModelState,
  type RunFitting,
  type RunPoint,
  type RunSegment,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-20T00:00:00.000Z";
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor() {
    this.head = { modelId: "drag", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  }
  submit(command: Command) {
    counter += 1;
    const base = this.head.revision;
    const req: CommandRequest = { idempotencyKey: `d-${counter}`, baseRevision: base, actor: { id: "priya", name: "Priya", kind: "human" }, command, clientSessionId: "tab" };
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
  seg(id: string): RunSegment {
    const el = this.head.elements[id];
    if (el?.kind !== "run_segment") throw new Error(`${id} is ${el?.kind ?? "missing"}`);
    return el;
  }
  elbows(): RunFitting[] {
    return Object.values(this.head.elements).filter((el): el is RunFitting => el.kind === "run_fitting" && el.fittingType === "elbow");
  }
  route(idPrefix: string, elevationMm: number, points: { x: number; y: number; elevationMm?: number }[], riseStyle?: "45"): void {
    this.ok({ type: "route_run", idPrefix, levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm, system: SA, points, ...(riseStyle ? { riseStyle } : {}) });
  }
}

const close = (a: RunPoint, b: RunPoint) => {
  expect(a.x).toBeCloseTo(b.x, 2);
  expect(a.y).toBeCloseTo(b.y, 2);
  expect(a.z).toBeCloseTo(b.z, 2);
};
const ft = (x: number, y: number, z: number): RunPoint => ({ x: x * FT, y: y * FT, z: z * FT });
const dir = (s: RunSegment) => {
  const l = Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y, s.end.z - s.start.z);
  return { x: (s.end.x - s.start.x) / l, y: (s.end.y - s.start.y) / l, z: (s.end.z - s.start.z) / l };
};
const turns = (m: Model) =>
  m.elbows().map((e) => {
    const [a, b] = e.ports;
    if (!a || !b) return NaN;
    const cos = a.direction.x * b.direction.x + a.direction.y * b.direction.y + a.direction.z * b.direction.z;
    return Math.round(180 - (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  });

/** East 10 ft, a 45° jog of 4 ft north, then east to 30 ft; open at both ends. */
function planOffset(): Model {
  const m = new Model();
  m.route("o", 10 * FT, [
    { x: 0, y: 0 },
    { x: 10 * FT, y: 0 },
    { x: 14 * FT, y: 4 * FT },
    { x: 30 * FT, y: 4 * FT },
  ]);
  return m;
}

/** An L: 20 ft north, then 20 ft east, open at both ends. */
function lShape(): Model {
  const m = new Model();
  m.route("L", 10 * FT, [
    { x: 0, y: 0 },
    { x: 0, y: 20 * FT },
    { x: 20 * FT, y: 20 * FT },
  ]);
  return m;
}

describe("dragging a 45° piece", () => {
  it("square to itself: the jog slides, the legs either side only stretch, their far ends stay put", () => {
    const m = planOffset();
    expect(m.seg("o-s2").start).toEqual(ft(10, 0, 10));
    m.ok({ type: "drag_run", elementId: "o-s2", delta: { x: -1 * FT, y: 1 * FT, z: 0 } });
    close(m.seg("o-s1").start, ft(0, 0, 10));
    close(m.seg("o-s1").end, ft(8, 0, 10));
    close(m.seg("o-s2").start, ft(8, 0, 10));
    close(m.seg("o-s2").end, ft(12, 4, 10));
    close(m.seg("o-s3").start, ft(12, 4, 10));
    close(m.seg("o-s3").end, ft(30, 4, 10));
    expect(turns(m)).toEqual([45, 45]);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("along itself: the piece keeps its 45° and what it meets follows", () => {
    const m = planOffset();
    m.ok({ type: "drag_run", elementId: "o-s2", delta: { x: 1 * FT, y: 1 * FT, z: 0 } });
    close(m.seg("o-s2").start, ft(11, 1, 10));
    close(m.seg("o-s2").end, ft(15, 5, 10));
    close(dir(m.seg("o-s2")), { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 });
    expect(turns(m)).toEqual([45, 45]);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("drags a leg beside the jog sideways: the jog stretches instead of refusing", () => {
    const m = planOffset();
    m.ok({ type: "drag_run", elementId: "o-s3", delta: { x: 0, y: 2 * FT, z: 0 } });
    close(m.seg("o-s3").start, ft(16, 6, 10));
    close(m.seg("o-s2").end, ft(16, 6, 10));
    close(m.seg("o-s1").end, ft(10, 0, 10));
    expect(validateModel(m.head)).toEqual([]);
  });

  it("drags a 45° elbow: its legs keep their directions", () => {
    const m = planOffset();
    const elbow = m.elbows().find((e) => Math.abs(e.position.x - 14 * FT) < 1);
    m.ok({ type: "drag_run", elementId: elbow?.id ?? "", delta: { x: 0, y: 2 * FT, z: 0 } });
    close(dir(m.seg("o-s2")), { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 });
    close(m.seg("o-s1").start, ft(0, 0, 10));
    expect(turns(m)).toEqual([45, 45]);
    expect(validateModel(m.head)).toEqual([]);
  });
});

describe("dragging up and down", () => {
  /** Low run at 9 ft, a vertical rise at 10 ft east to 13 ft, high run on to 20 ft. */
  function rise(): Model {
    const m = new Model();
    m.route("z", 9 * FT, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 13 * FT }, { x: 20 * FT, y: 0 }]);
    return m;
  }

  it("raises the high run: the rise stretches, the low run stays", () => {
    const m = rise();
    m.ok({ type: "drag_run", elementId: "z-s3", delta: { x: 0, y: 0, z: 2 * FT } });
    close(m.seg("z-s3").start, ft(10, 0, 15));
    close(m.seg("z-s2").start, ft(10, 0, 9));
    close(m.seg("z-s2").end, ft(10, 0, 15));
    close(m.seg("z-s1").end, ft(10, 0, 9));
    expect(validateModel(m.head)).toEqual([]);
  });

  it("grabs the top of the rise and pulls it up: the rise gets taller, the high run rides up with it", () => {
    const m = rise();
    m.ok({ type: "drag_run", elementId: "z-s2", grip: "end", delta: { x: 0, y: 0, z: 1 * FT } });
    close(m.seg("z-s2").end, ft(10, 0, 14));
    close(m.seg("z-s3").end, ft(20, 0, 14));
    close(m.seg("z-s1").start, ft(0, 0, 9));
    expect(validateModel(m.head)).toEqual([]);
  });

  it("moves the rise sideways: the run below lengthens and the run above shortens", () => {
    const m = rise();
    m.ok({ type: "drag_run", elementId: "z-s2", delta: { x: 3 * FT, y: 0, z: 0 } });
    close(m.seg("z-s1").end, ft(13, 0, 9));
    close(m.seg("z-s3").start, ft(13, 0, 13));
    close(m.seg("z-s3").end, ft(20, 0, 13));
    expect(validateModel(m.head)).toEqual([]);
  });

  it("raises the run above a 45° rise: the sloped piece lengthens, the raised run gives up the length, the low run stays", () => {
    const m = new Model();
    m.route("r", 9 * FT, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 11 * FT }, { x: 25 * FT, y: 0 }], "45");
    const segs = Object.values(m.head.elements).filter((el): el is RunSegment => el.kind === "run_segment");
    const high = segs.find((s) => Math.abs(s.start.z - 11 * FT) < 1 && Math.abs(s.end.z - 11 * FT) < 1);
    const low = segs.find((s) => Math.abs(s.start.z - 9 * FT) < 1 && Math.abs(s.end.z - 9 * FT) < 1);
    if (!high || !low) throw new Error("expected a low and a high run");
    m.ok({ type: "drag_run", elementId: high.id, delta: { x: 0, y: 0, z: 1 * FT } });
    expect(m.seg(high.id).start.z).toBeCloseTo(12 * FT, 2);
    expect(m.seg(high.id).start.x).toBeCloseTo(high.start.x + 1 * FT, 2);
    close(m.seg(high.id).end, { ...high.end, z: 12 * FT });
    expect(m.seg(low.id)).toEqual(low);
    expect(turns(m)).toEqual([45, 45]);
    expect(validateModel(m.head)).toEqual([]);
  });
});

describe("elbow limits", () => {
  it("refuses to pull a leg back past its elbow (it used to commit with the elbow facing backwards)", () => {
    const m = lShape();
    expect(m.refused({ type: "drag_run", elementId: "L-s1", delta: { x: 25 * FT, y: 0, z: 0 } })).toMatch(/back past the 90° elbow/);
  });

  it("dragLimit stops where the elbow runs out of room, says so, and the stop commits", () => {
    const m = lShape();
    const cmd = { type: "drag_run" as const, elementId: "L-s1", delta: { x: 25 * FT, y: 0, z: 0 } };
    const limit = dragLimit(m.head, cmd);
    expect(limit.binding?.message).toMatch(/^the 90° elbow needs [\d.]+ ft of the 14"x10" supply air duct$/);
    expect(limit.flipsAt).toBeCloseTo(20 / 25, 3);
    expect(limit.accepted?.x).toBeGreaterThan(18 * FT);
    expect(limit.accepted?.x).toBeLessThan(20 * FT);
    const ok = executeCommand(m.head, { ...cmd, delta: limit.accepted ?? { x: 0, y: 0, z: 0 } });
    expect(ok.ok).toBe(true);
    const past = executeCommand(m.head, { ...cmd, delta: { x: (limit.accepted?.x ?? 0) + 25, y: 0, z: 0 } });
    expect(past.ok).toBe(false);
    expect(dragLimit(m.head, { ...cmd, delta: { x: 3 * FT, y: 0, z: 0 } })).toMatchObject({ fraction: 1, binding: null });
  });

  it("dragLimit gives no position for a drag that can't move at all, with the reason", () => {
    const m = lShape();
    const limit = dragLimit(m.head, { type: "drag_run", elementId: "L-s1", delta: { x: 1 * FT, y: 1 * FT, z: 0 } });
    expect(limit.accepted).toBeNull();
    expect(limit.binding?.message).toMatch(/square to it or along it/);
  });

  it("reroutes past the elbow: the leg runs the other way and the elbow turns to meet it", () => {
    const m = lShape();
    m.ok({ type: "drag_run", elementId: "L-s1", reroute: true, delta: { x: 25 * FT, y: 0, z: 0 } });
    close(m.seg("L-s2").start, ft(25, 20, 10));
    close(m.seg("L-s2").end, ft(20, 20, 10));
    const elbow = m.elbows()[0];
    const toLeg = elbow?.ports.find((p) => p.link?.elementId === "L-s2");
    close(toLeg?.direction ?? ft(0, 0, 0), { x: -1, y: 0, z: 0 });
    expect(turns(m)).toEqual([90]);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses to reroute through a 45° elbow, which can't turn the other way", () => {
    const m = planOffset();
    expect(m.refused({ type: "drag_run", elementId: "o-s2", reroute: true, delta: { x: -6 * FT, y: 6 * FT, z: 0 } })).toMatch(/turn 135°/);
  });

  it("refuses a reroute that leaves the turned leg too short for its elbow", () => {
    const m = lShape();
    expect(m.refused({ type: "drag_run", elementId: "L-s1", reroute: true, delta: { x: 20.5 * FT, y: 0, z: 0 } })).toMatch(/too short|shortest straight piece/);
  });
});
