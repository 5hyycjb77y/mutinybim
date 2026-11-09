/** @jest-environment node */
import { createHash } from "node:crypto";
import { MeshCache, SolidProgramError, type Frame, type Loop, type SolidEngine, type SolidProgram, type SolidStep, type TriangleMesh } from "../src";
import { nodeManifoldEngine } from "../testing/node-manifold";

const XY: Frame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] };
const rect = (cx: number, cy: number, w: number, h: number): Loop => [
  [cx - w / 2, cy - h / 2],
  [cx + w / 2, cy - h / 2],
  [cx + w / 2, cy + h / 2],
  [cx - w / 2, cy + h / 2],
];
const box = (id: string, loop: Loop, start: number, end: number, operation: SolidStep["operation"] = "join", frame: Frame = XY): SolidStep => ({ id, operation, op: { kind: "extrude", frame, loops: [loop], start, end } });
const program = (...steps: SolidStep[]): SolidProgram => ({ steps, circularSegments: 32 });

function volume(m: TriangleMesh): number {
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const p = (k: number) => [m.positions[(m.indices[t + k] ?? 0) * 3] ?? 0, m.positions[(m.indices[t + k] ?? 0) * 3 + 1] ?? 0, m.positions[(m.indices[t + k] ?? 0) * 3 + 2] ?? 0];
    const [a, b, c] = [p(0), p(1), p(2)] as [number[], number[], number[]];
    v += ((a[0] ?? 0) * ((b[1] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[1] ?? 0)) - (a[1] ?? 0) * ((b[0] ?? 0) * (c[2] ?? 0) - (b[2] ?? 0) * (c[0] ?? 0)) + (a[2] ?? 0) * ((b[0] ?? 0) * (c[1] ?? 0) - (b[1] ?? 0) * (c[0] ?? 0))) / 6;
  }
  return v;
}

const hash = (m: TriangleMesh) => createHash("sha256").update(Buffer.from(m.positions.buffer)).update(Buffer.from(m.indices.buffer)).digest("hex");

let engine: SolidEngine;
beforeAll(async () => {
  engine = await nodeManifoldEngine();
});

describe("manifold engine", () => {
  it("extrudes a profile along the frame normal from start to end", () => {
    const m = engine.evaluate(program(box("a", rect(0, 0, 100, 50), 10, 40)));
    expect(m.bounds.min).toEqual([-50, -25, 10]);
    expect(m.bounds.max).toEqual([50, 25, 40]);
    expect(volume(m)).toBeCloseTo(100 * 50 * 30, 0);
  });

  it("places profiles in any frame", () => {
    const front: Frame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] };
    const m = engine.evaluate(program(box("a", rect(0, 50, 100, 100), 0, 20, "join", front)));
    expect(m.bounds.min[1]).toBeCloseTo(-20);
    expect(m.bounds.max[1]).toBeCloseTo(0);
    expect(m.bounds.max[2]).toBeCloseTo(100);
  });

  it("treats a loop inside another as a hole", () => {
    const m = engine.evaluate({ steps: [{ id: "curb", operation: "join", op: { kind: "extrude", frame: XY, loops: [rect(0, 0, 100, 100), rect(0, 0, 80, 80)], start: 0, end: 10 } }], circularSegments: 32 });
    expect(volume(m)).toBeCloseTo((100 * 100 - 80 * 80) * 10, 0);
  });

  it("cuts and joins in order: a join after a cut adds material back", () => {
    const cut = engine.evaluate(program(box("body", rect(0, 0, 100, 100), 0, 100), box("hole", rect(0, 0, 20, 20), -1, 101, "cut")));
    expect(volume(cut)).toBeCloseTo(100 * 100 * 100 - 20 * 20 * 100, 0);
    const refilled = engine.evaluate(program(box("body", rect(0, 0, 100, 100), 0, 100), box("hole", rect(0, 0, 20, 20), -1, 101, "cut"), box("plug", rect(0, 0, 20, 20), 0, 50)));
    expect(volume(refilled)).toBeCloseTo(100 * 100 * 100 - 20 * 20 * 50, 0);
  });

  it("intersects", () => {
    const m = engine.evaluate(program(box("a", rect(0, 0, 100, 100), 0, 100), box("b", rect(50, 50, 100, 100), 0, 100, "intersect")));
    expect(volume(m)).toBeCloseTo(50 * 50 * 100, 0);
  });

  it("revolves a profile about an axis in the sketch, on either side", () => {
    // Sketch on the front plane (u = x, v = z); a 10 x 100 strip from x = 40..50 revolved about the vertical axis u = 0 → a tube.
    const front: Frame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] };
    const strip: Loop = [[40, 0], [50, 0], [50, 100], [40, 100]];
    const tube = engine.evaluate({ steps: [{ id: "r", operation: "join", op: { kind: "revolve", frame: front, loops: [strip], axisPoint: [0, 0], axisDirection: [0, 1], startDeg: 0, endDeg: 360 } }], circularSegments: 128 });
    expect(tube.bounds.min[2]).toBeCloseTo(0);
    expect(tube.bounds.max[2]).toBeCloseTo(100);
    expect(tube.bounds.max[0]).toBeCloseTo(50, 0);
    // A 128-gon holds 99.96% of its circle's area.
    expect(volume(tube) / (Math.PI * (50 * 50 - 40 * 40) * 100)).toBeCloseTo(1, 2);
    const mirrored: Loop = strip.map(([u, v]) => [-u, v] as const);
    const left = engine.evaluate({ steps: [{ id: "r", operation: "join", op: { kind: "revolve", frame: front, loops: [mirrored], axisPoint: [0, 0], axisDirection: [0, 1], startDeg: 0, endDeg: 360 } }], circularSegments: 128 });
    expect(volume(left)).toBeCloseTo(volume(tube), -1);
  });

  it("refuses a profile crossing the revolve axis, naming the step", () => {
    const front: Frame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] };
    expect(() => engine.evaluate({ steps: [{ id: "bad", operation: "join", op: { kind: "revolve", frame: front, loops: [rect(0, 50, 20, 20)], axisPoint: [0, 0], axisDirection: [0, 1], startDeg: 0, endDeg: 360 } }], circularSegments: 32 })).toThrow(
      expect.objectContaining({ name: "SolidProgramError", stepId: "bad" }) as SolidProgramError,
    );
  });

  it("refuses a first feature that cuts", () => {
    expect(() => engine.evaluate(program(box("v", rect(0, 0, 10, 10), 0, 10, "cut")))).toThrow(/first solid feature must add material/);
  });

  it("is deterministic: the same program gives byte-identical meshes", () => {
    const p = program(box("body", rect(0, 0, 900, 500), 0, 400), box("hole", rect(100, 0, 200, 200), -10, 410, "cut"));
    expect(hash(engine.evaluate(p))).toBe(hash(engine.evaluate(p)));
  });

  it("caches by key: a thousand requests for one key build one mesh", () => {
    const cache = new MeshCache(engine);
    const p = () => program(box("body", rect(0, 0, 900, 500), 0, 400));
    const first = cache.get("rtu/60", p);
    for (let i = 0; i < 999; i++) expect(cache.get("rtu/60", p)).toBe(first);
    expect(cache.evaluations).toBe(1);
  });
});

// Timing lives in the BIM perf gate (part.regen.50, geometry.boolean.10k: scripts/perf/mutinybim/parts.ts).
describe("batched booleans", () => {
  it("keeps order where it matters: a join over an earlier cut refills it, a join clear of it doesn't", () => {
    const body = box("body", rect(0, 0, 100, 100), 0, 100);
    const hole = box("hole", rect(0, 0, 20, 20), -1, 101, "cut");
    const boss = box("boss", rect(80, 0, 20, 20), 0, 100); // outside the body, clear of the hole
    const plug = box("plug", rect(0, 0, 20, 20), 0, 50); // fills half the hole back
    const slot = box("slot", rect(-30, 0, 10, 10), -1, 101, "cut");
    const m = engine.evaluate(program(body, hole, boss, slot, plug));
    expect(volume(m)).toBeCloseTo(100 * 100 * 100 - 20 * 20 * 100 + 20 * 20 * 100 - 10 * 10 * 100 + 20 * 20 * 50, 0);
  });

  it("regenerates a 50-feature part to the volume of its features, byte-identical every time", () => {
    const steps: SolidStep[] = [box("body", rect(0, 0, 900, 500), 0, 400)];
    for (let i = 0; i < 49; i++) steps.push(box(`f${i}`, rect(-400 + i * 16, i % 2 ? 100 : 0, 12, 40), -20, 430, i % 3 === 0 ? "join" : "cut"));
    const joins = steps.filter((s, i) => i > 0 && s.operation === "join").length;
    const cuts = steps.filter((s) => s.operation === "cut").length;
    const m = engine.evaluate(program(...steps));
    // Joins stick out 20 below and 30 above the body; cuts go through it.
    expect(volume(m)).toBeCloseTo(900 * 500 * 400 + joins * 12 * 40 * 50 - cuts * 12 * 40 * 400, 0);
    expect(m.bounds.min[2]).toBeCloseTo(-20);
    expect(m.bounds.max[2]).toBeCloseTo(430);
    const first = hash(m);
    for (let k = 0; k < 3; k++) expect(hash(engine.evaluate(program(...steps)))).toBe(first);
  });

  it("cuts one ~10k-triangle solid with another: what's left is the first minus their overlap", () => {
    const n = 64;
    const ring = (cx: number): Loop => Array.from({ length: n }, (_, i) => [cx + 500 * Math.cos((2 * Math.PI * i) / n), 500 * Math.sin((2 * Math.PI * i) / n)] as const);
    const front: Frame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] };
    const torus = (id: string, cx: number, operation: SolidStep["operation"]): SolidStep => ({ id, operation, op: { kind: "revolve", frame: front, loops: [ring(cx)], axisPoint: [0, 0], axisDirection: [0, 1], startDeg: 0, endDeg: 360 } });
    const a = engine.evaluate({ steps: [torus("a", 1500, "join")], circularSegments: 80 });
    expect(a.triangleCount).toBeGreaterThan(9000);
    const cut: SolidProgram = { steps: [torus("a", 1500, "join"), torus("b", 1800, "cut")], circularSegments: 80 };
    const overlap = engine.evaluate({ steps: [torus("a", 1500, "join"), torus("b", 1800, "intersect")], circularSegments: 80 });
    const m = engine.evaluate(cut);
    expect(volume(overlap)).toBeGreaterThan(0);
    expect(volume(m) / (volume(a) - volume(overlap))).toBeCloseTo(1, 6);
    expect(hash(engine.evaluate(cut))).toBe(hash(m));
  });
});
