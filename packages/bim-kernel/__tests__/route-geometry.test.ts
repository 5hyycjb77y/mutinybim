/**
 * @jest-environment node
 *
 * Routing geometry: risers and slopes line up with the elbows that turn into
 * them, and the router only builds turns a real fitting makes.
 *
 * Before: a riser always took its width along plan Y (the elbow fell back to
 * the next leg, the 3D view to plan X), so a rectangular riser off a 45° leg,
 * or off a north-south leg, sat 45° or 90° off its elbows; a 45° slope drew as
 * a level box; and a rectangular duct could turn east → north-and-up in one
 * "elbow", which twists the duct.
 */
import {
  DEFAULT_SETTINGS,
  elbowFrame,
  executeCommand,
  fittingBody,
  planCommit,
  planDuctFrames,
  ringPoint,
  segmentRings,
  segmentWidthAxis,
  validateModel,
  type Command,
  type ModelState,
  type Ring,
  type RunFitting,
  type RunPoint,
  type RunSegment,
  type RunSize,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const RECT: RunSize = { shape: "rect", width: 24 * IN, height: 12 * IN };
const SQUARE: RunSize = { shape: "rect", width: 16 * IN, height: 16 * IN };
const ROUND: RunSize = { shape: "round", diameter: 12 * IN };
const SA = { id: "sa", kind: "supply_air" as const };

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `t-${model.revision}-key`, baseRevision: model.revision, actor: { id: "t", name: "T", kind: "human" }, command });
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function empty(): ModelState {
  const m: ModelState = { modelId: "geo", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
}

function route(size: RunSize, points: Array<{ x: number; y: number; elevationMm?: number }>, extra: Partial<Extract<Command, { type: "route_run" }>> = {}): Extract<Command, { type: "route_run" }> {
  return { type: "route_run", idPrefix: "r", levelId: "lvl-1", domain: "duct", size, elevationMm: 10 * FT, system: SA, points, ...extra };
}

function seg(m: ModelState, id: string): RunSegment {
  const el = m.elements[id];
  if (el?.kind !== "run_segment") throw new Error(`${id} is not a segment`);
  return el;
}
function fit(m: ModelState, id: string): RunFitting {
  const el = m.elements[id];
  if (el?.kind !== "run_fitting") throw new Error(`${id} is not a fitting`);
  return el;
}

/** A rectangle's four corners. */
function corners(r: Ring): RunPoint[] {
  return [0, 1, 2, 3].map((k) => ringPoint(r, Math.PI / 4 + (k * Math.PI) / 2));
}
function expectSameOutline(a: Ring, b: Ring): void {
  expect(a.center.x).toBeCloseTo(b.center.x, 3);
  expect(a.center.y).toBeCloseTo(b.center.y, 3);
  expect(a.center.z).toBeCloseTo(b.center.z, 3);
  const key = (p: RunPoint) => [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10).join(",");
  expect(corners(a).map(key).sort()).toEqual(corners(b).map(key).sort());
}
function expectAxis(v: RunPoint, expected: RunPoint): void {
  // A width axis has no sign.
  const s = Math.sign(v.x * expected.x + v.y * expected.y + v.z * expected.z) || 1;
  expect(v.x * s).toBeCloseTo(expected.x, 4);
  expect(v.y * s).toBeCloseTo(expected.y, 4);
  expect(v.z * s).toBeCloseTo(expected.z, 4);
}

/** The elbow's ring at a port: the end of its tube that meets that face. */
function elbowFaceRing(m: ModelState, f: RunFitting, port: "a" | "b"): Ring {
  const body = fittingBody(m.elements, f);
  const rings = body.tubes[0]?.rings ?? [];
  const r = port === "a" ? rings[0] : rings[rings.length - 1];
  if (!r) throw new Error("elbow has no tube");
  return r;
}

const R = Math.SQRT1_2;

describe("risers line up with their elbows", () => {
  it("east, up, east: the riser keeps the level leg's width (along north-south) and meets both elbow faces exactly", () => {
    const m = commit(empty(), route(RECT, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 20 * FT, y: 0 }]));
    const riser = seg(m, "r-s2");
    expect(riser.start).toEqual({ x: 10 * FT, y: 0, z: 10 * FT });
    expect(riser.end).toEqual({ x: 10 * FT, y: 0, z: 14 * FT });
    expectAxis(segmentWidthAxis(m.elements, riser), { x: 0, y: 1, z: 0 });
    const rings = segmentRings(m.elements, riser);
    const low = fit(m, "r-f1");
    const high = fit(m, "r-f2");
    // Default smooth elbow, r/W 1 on the 12" side that bends: it reaches 12" into the riser.
    expect(rings.start.center.z).toBeCloseTo(10 * FT + 12 * IN, 3);
    expectSameOutline(rings.start, elbowFaceRing(m, low, "b"));
    expectSameOutline(rings.end, elbowFaceRing(m, high, "a"));
    expect(elbowFrame(low, m.elements)?.planeDim).toBeCloseTo(12 * IN, 3);
    expect(elbowFrame(high, m.elements)?.planeDim).toBeCloseTo(12 * IN, 3);
    expect(validateModel(m)).toEqual([]);
  });

  it("a riser off a 45° leg turns 45° with it (it used to sit square to plan)", () => {
    const m = commit(empty(), route(RECT, [{ x: 0, y: 0 }, { x: 10 * FT, y: 10 * FT, elevationMm: 14 * FT }, { x: 20 * FT, y: 20 * FT }]));
    const riser = seg(m, "r-s2");
    expectAxis(segmentWidthAxis(m.elements, riser), { x: -R, y: R, z: 0 });
    const rings = segmentRings(m.elements, riser);
    expectSameOutline(rings.start, elbowFaceRing(m, fit(m, "r-f1"), "b"));
    expectSameOutline(rings.end, elbowFaceRing(m, fit(m, "r-f2"), "a"));
    expect(validateModel(m)).toEqual([]);
  });

  it("north, up, north: the riser's width runs east-west", () => {
    const m = commit(empty(), route(RECT, [{ x: 0, y: 0 }, { x: 0, y: 10 * FT, elevationMm: 14 * FT }, { x: 0, y: 20 * FT }]));
    expectAxis(segmentWidthAxis(m.elements, seg(m, "r-s2")), { x: 1, y: 0, z: 0 });
    expectSameOutline(segmentRings(m.elements, seg(m, "r-s2")).end, elbowFaceRing(m, fit(m, "r-f2"), "a"));
  });

  it("a drop that ends on an open end takes its width from the elbow above it", () => {
    const m = commit(empty(), route(RECT, [{ x: 0, y: 0 }, { x: 0, y: 10 * FT, elevationMm: 4 * FT }]));
    const drop = seg(m, "r-s2");
    expectAxis(segmentWidthAxis(m.elements, drop), { x: 1, y: 0, z: 0 });
    expectSameOutline(segmentRings(m.elements, drop).start, elbowFaceRing(m, fit(m, "r-f1"), "b"));
  });

  it("a 45° rise: the slope's straight piece is square to the slope and meets both 45° elbow faces", () => {
    const m = commit(empty(), route(RECT, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 20 * FT, y: 0 }], { riseStyle: "45" }));
    const slope = seg(m, "r-s2");
    expect(slope.end.z - slope.start.z).toBeCloseTo(4 * FT, 3);
    expect(slope.end.x - slope.start.x).toBeCloseTo(4 * FT, 3);
    const rings = segmentRings(m.elements, slope);
    expectSameOutline(rings.start, elbowFaceRing(m, fit(m, "r-f1"), "b"));
    expectSameOutline(rings.end, elbowFaceRing(m, fit(m, "r-f2"), "a"));
    // The height half-axis tilts with the slope: (-1, 0, 1)/√2 times 6".
    expectAxis(rings.start.b, { x: -R * 6 * IN, y: 0, z: R * 6 * IN });
    expect(validateModel(m)).toEqual([]);
  });
});

describe("only turns a fitting can make", () => {
  it("east, up, north in 24x12: the top elbow turns the duct on its width, and a transition stands it back up", () => {
    const m = commit(empty(), route(RECT, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 10 * FT, y: 20 * FT }]));
    const top = fit(m, "r-f2");
    expect(top.fittingType).toBe("elbow");
    expect(top.ports.map((p) => p.size)).toEqual([RECT, { shape: "rect", width: 12 * IN, height: 24 * IN }]);
    // The riser's width (north-south) is in the plane of the top turn: the 24" side bends.
    expect(elbowFrame(top, m.elements)?.planeDim).toBeCloseTo(24 * IN, 3);
    const onSide = seg(m, "r-s3");
    expect(onSide.size).toEqual({ shape: "rect", width: 12 * IN, height: 24 * IN });
    // The elbow reaches 24" (r/W 1 x 24"); the on-side piece ends exactly where it does.
    expect(onSide.start).toEqual({ x: 10 * FT, y: 0, z: 14 * FT });
    expect(onSide.end.y).toBeCloseTo(24 * IN, 3);
    const transition = fit(m, "r-f3");
    expect(transition.fittingType).toBe("transition");
    expect(transition.ports.map((p) => p.size)).toEqual([{ shape: "rect", width: 12 * IN, height: 24 * IN }, RECT]);
    expect(seg(m, "r-s4").size).toEqual(RECT);
    // The elbow's top face is 12" across in plan and 24" tall: what the on-side piece is.
    const face = elbowFaceRing(m, top, "b");
    expect(Math.abs(face.a.z) + Math.abs(face.b.z)).toBeCloseTo(12 * IN, 3);
    expectSameOutline(face, segmentRings(m.elements, onSide).start);
    expect(validateModel(m)).toEqual([]);
  });

  it("square duct turns any way out of a riser with no transition", () => {
    const m = commit(empty(), route(SQUARE, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 10 * FT, y: 20 * FT }]));
    expect(Object.values(m.elements).filter((e) => e.kind === "run_fitting").map((e) => (e as RunFitting).fittingType)).toEqual(["elbow", "elbow"]);
    expect(validateModel(m)).toEqual([]);
  });

  it("refuses a rectangular turn sideways and up at once, and builds nothing", () => {
    const m = empty();
    const twisted = route(RECT, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 10 * FT, y: 20 * FT }], { riseStyle: "45" });
    const res = executeCommand(m, twisted);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/turn at point 2 turns sideways and up or down at once, which twists rectangular duct; no single elbow makes it/);
  });

  it("round duct may make that same turn: a round elbow turns in any plane", () => {
    const m = commit(empty(), route(ROUND, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 10 * FT, y: 20 * FT }], { riseStyle: "45" }));
    expect(validateModel(m)).toEqual([]);
  });

  it("refuses flat oval that would lie on its side out of a riser", () => {
    const res = executeCommand(empty(), route({ shape: "oval", width: 24 * IN, height: 12 * IN }, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 10 * FT, y: 20 * FT }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/flat oval duct would lie on its side/);
  });

  it("refuses when the leg after the riser is too short for the transition back", () => {
    const res = executeCommand(empty(), route(RECT, [{ x: 0, y: 0 }, { x: 10 * FT, y: 0, elevationMm: 14 * FT }, { x: 10 * FT, y: 2.5 * FT }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/Leg 3 is 0\.5 ft long, but the transition there needs/);
  });

  it("frame planning: plan turns bend the width and keep it level", () => {
    const plan = planDuctFrames([{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: R, y: R, z: 0 }], RECT, null);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.onSide).toEqual([]);
      expectAxis(plan.widthAtEnd, { x: -R, y: R, z: 0 });
    }
  });
});

describe("joining existing duct", () => {
  const TRUNK: RunSize = { shape: "rect", width: 14 * IN, height: 10 * IN };
  function withTrunk(): ModelState {
    return commit(empty(), { type: "route_run", idPrefix: "t", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
  }
  const fittingsOf = (m: ModelState, prefix: string) => Object.values(m.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.id.startsWith(prefix));

  it("a branch wider than its trunk is tapped at the widest the trunk takes, then a transition to the size drawn", () => {
    const wide: RunSize = { shape: "round", diameter: 16 * IN };
    const m = commit(withTrunk(), { type: "route_run", idPrefix: "b", levelId: "lvl-1", domain: "duct", size: wide, elevationMm: 10 * FT, system: SA, points: [{ x: 10 * FT, y: 0 }, { x: 10 * FT, y: 10 * FT }], from: { kind: "run_branch", segmentId: "t-s1" } });
    const tap = fittingsOf(m, "b").find((f) => f.host?.segmentId === "t-s1");
    expect(tap?.ports[0]?.size.shape).toBe("round");
    const tapped = tap?.ports[0]?.size;
    const tappedDia = tapped?.shape === "round" ? tapped.diameter : 0;
    expect(tappedDia).toBeLessThanOrEqual(14 * IN);
    expect(tappedDia).toBeGreaterThanOrEqual(13 * IN);
    // The tap's branch face is on the trunk's north side: 7" off its centreline.
    expect(tap?.ports[0]?.position).toEqual({ x: 10 * FT, y: 177.8, z: 10 * FT });
    const neck = seg(m, "b-s1");
    expect(neck.size).toEqual(tapped);
    const transition = fittingsOf(m, "b").find((f) => f.fittingType === "transition");
    expect(transition?.ports.map((p) => p.size).sort((x, y) => (x.shape === "round" && y.shape === "round" ? x.diameter - y.diameter : 0))).toEqual([tapped, wide]);
    expect(seg(m, "b-s2").size).toEqual(wide);
    expect(validateModel(m)).toEqual([]);
  });

  it("the same when the route ends on the trunk's side", () => {
    const wide: RunSize = { shape: "round", diameter: 16 * IN };
    const m = commit(withTrunk(), { type: "route_run", idPrefix: "b", levelId: "lvl-1", domain: "duct", size: wide, elevationMm: 10 * FT, system: SA, points: [{ x: 10 * FT, y: 10 * FT }, { x: 10 * FT, y: 0 }], to: { kind: "run_branch", segmentId: "t-s1" } });
    expect(fittingsOf(m, "b").map((f) => f.fittingType).sort()).toEqual(["tap", "transition"].sort());
    expect(seg(m, "b-s1").size).toEqual(wide);
    expect(validateModel(m)).toEqual([]);
  });

  it("continuing an open end at another size and shape puts a transition at that end", () => {
    const round: RunSize = { shape: "round", diameter: 10 * IN };
    const m = commit(withTrunk(), { type: "route_run", idPrefix: "c", levelId: "lvl-1", domain: "duct", size: round, elevationMm: 10 * FT, system: SA, points: [{ x: 30 * FT, y: 0 }], from: { kind: "run_end", elementId: "t-s1", port: "end" } });
    const transition = fittingsOf(m, "c")[0];
    expect(transition?.fittingType).toBe("transition");
    expect(transition?.position).toEqual({ x: 20 * FT, y: 0, z: 10 * FT });
    expect(transition?.ports.map((p) => p.size)).toEqual([TRUNK, round]);
    expect(validateModel(m)).toEqual([]);
  });
});
