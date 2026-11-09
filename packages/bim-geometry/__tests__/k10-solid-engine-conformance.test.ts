/**
 * @jest-environment node
 *
 * Round 10 lane K10: the conformance suite any second solid engine must pass
 * before it can stand behind `SolidEngine` (the cheap proof for "exact solids
 * later" in round 10's CANDIDATES answers; OpenCascade is not built this
 * round). Each case states the contract in terms of the mesh an engine
 * returns, never its internals: a closed, outward-facing, watertight mesh of
 * the right volume and bounds; boolean steps applied in order; refusals that
 * name the step; identical bytes for an identical program.
 *
 * Add an engine by adding a row to ENGINES. Manifold passes.
 */
import { createHash } from "node:crypto";
import { meshBounds, SolidProgramError, type Frame, type Loop, type SolidEngine, type SolidProgram, type SolidStep, type TriangleMesh } from "../src";
import { nodeManifoldEngine } from "../testing/node-manifold";

const ENGINES: ReadonlyArray<readonly [string, () => Promise<SolidEngine>]> = [["manifold", nodeManifoldEngine]];

const XY: Frame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] };
const rect = (cx: number, cy: number, w: number, h: number): Loop => [
  [cx - w / 2, cy - h / 2],
  [cx + w / 2, cy - h / 2],
  [cx + w / 2, cy + h / 2],
  [cx - w / 2, cy + h / 2],
];
const extrude = (id: string, loops: readonly Loop[], start: number, end: number, operation: SolidStep["operation"] = "join"): SolidStep => ({ id, operation, op: { kind: "extrude", frame: XY, loops, start, end } });
const program = (steps: readonly SolidStep[], circularSegments = 64): SolidProgram => ({ steps, circularSegments });

function vertex(m: TriangleMesh, i: number): readonly [number, number, number] {
  return [m.positions[i * 3] ?? 0, m.positions[i * 3 + 1] ?? 0, m.positions[i * 3 + 2] ?? 0];
}

/** Signed volume (positive when triangles face outward). */
function volume(m: TriangleMesh): number {
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [vertex(m, m.indices[t] ?? 0), vertex(m, m.indices[t + 1] ?? 0), vertex(m, m.indices[t + 2] ?? 0)];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

/** Every directed edge appears once and its reverse once: closed, consistently wound, no gaps. */
function isWatertight(m: TriangleMesh): boolean {
  const edges = new Map<string, number>();
  const key = (a: number, b: number) => `${a}:${b}`;
  for (let t = 0; t < m.indices.length; t += 3) {
    const tri = [m.indices[t] ?? 0, m.indices[t + 1] ?? 0, m.indices[t + 2] ?? 0];
    for (let k = 0; k < 3; k++) {
      const a = tri[k] ?? 0;
      const b = tri[(k + 1) % 3] ?? 0;
      edges.set(key(a, b), (edges.get(key(a, b)) ?? 0) + 1);
    }
  }
  for (const [edge, count] of edges) {
    const [a, b] = edge.split(":");
    if (count !== 1 || edges.get(`${b}:${a}`) !== 1) return false;
  }
  return true;
}

function wellFormed(m: TriangleMesh): void {
  expect(m.positions.length % 3).toBe(0);
  expect(m.indices.length).toBe(m.triangleCount * 3);
  const vertices = m.positions.length / 3;
  for (const i of m.indices) expect(i).toBeLessThan(vertices);
  expect(m.bounds).toEqual(meshBounds(m.positions));
}

const digest = (m: TriangleMesh) => createHash("sha256").update(Buffer.from(m.positions.buffer)).update(Buffer.from(m.indices.buffer)).digest("hex");

describe.each(ENGINES)("k10 solid engine conformance: %s", (_name, load) => {
  let engine: SolidEngine;
  beforeAll(async () => {
    engine = await load();
  });

  it("an extrusion is a well-formed, watertight, outward-facing box of the right bounds and volume", () => {
    const m = engine.evaluate(program([extrude("box", [rect(0, 0, 100, 50)], 10, 40)]));
    wellFormed(m);
    expect(isWatertight(m)).toBe(true);
    expect(m.bounds.min).toEqual([-50, -25, 10]);
    expect(m.bounds.max).toEqual([50, 25, 40]);
    expect(volume(m)).toBeCloseTo(100 * 50 * 30, 0);
  });

  it("a loop inside another is a hole (even-odd)", () => {
    const m = engine.evaluate(program([extrude("curb", [rect(0, 0, 100, 100), rect(0, 0, 80, 80)], 0, 10)]));
    expect(isWatertight(m)).toBe(true);
    expect(volume(m)).toBeCloseTo((100 * 100 - 80 * 80) * 10, 0);
  });

  it("join, cut and intersect apply in order", () => {
    const a = extrude("a", [rect(0, 0, 100, 100)], 0, 100);
    const b = (operation: SolidStep["operation"]) => extrude("b", [rect(50, 0, 100, 100)], 0, 100, operation);
    expect(volume(engine.evaluate(program([a, b("join")])))).toBeCloseTo(150 * 100 * 100, 0);
    expect(volume(engine.evaluate(program([a, b("cut")])))).toBeCloseTo(50 * 100 * 100, 0);
    expect(volume(engine.evaluate(program([a, b("intersect")])))).toBeCloseTo(50 * 100 * 100, 0);
    const refill = engine.evaluate(program([a, b("cut"), extrude("c", [rect(25, 0, 50, 100)], 0, 100)]));
    expect(volume(refill)).toBeCloseTo(100 * 100 * 100, 0);
    expect(isWatertight(refill)).toBe(true);
  });

  it("a full revolve of a rectangle beside the axis is a ring within the circle-sampling tolerance", () => {
    const step: SolidStep = { id: "ring", operation: "join", op: { kind: "revolve", frame: XY, loops: [rect(30, 0, 20, 10)], axisPoint: [0, 0], axisDirection: [0, 1], startDeg: 0, endDeg: 360 } };
    const m = engine.evaluate(program([step], 128));
    expect(isWatertight(m)).toBe(true);
    const exact = Math.PI * (40 * 40 - 20 * 20) * 10;
    expect(Math.abs(volume(m) - exact) / exact).toBeLessThan(0.005);
  });

  it("refusals name the step: no depth, no loop, crossing the axis, a first feature that cuts", () => {
    const named = (p: SolidProgram, stepId: string) => {
      let thrown: unknown = null;
      try {
        engine.evaluate(p);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SolidProgramError);
      if (thrown instanceof SolidProgramError) expect(thrown.stepId).toBe(stepId);
    };
    named(program([extrude("flat", [rect(0, 0, 10, 10)], 5, 5)]), "flat");
    named(program([extrude("none", [], 0, 10)]), "none");
    named(program([{ id: "crossing", operation: "join", op: { kind: "revolve", frame: XY, loops: [rect(0, 0, 20, 10)], axisPoint: [0, 0], axisDirection: [0, 1], startDeg: 0, endDeg: 360 } }]), "crossing");
    named(program([extrude("first-cut", [rect(0, 0, 10, 10)], 0, 10, "cut")]), "first-cut");
  });

  it("is deterministic: the same program gives byte-identical meshes", () => {
    const p = program([extrude("a", [rect(0, 0, 100, 100)], 0, 100), extrude("b", [rect(30, 30, 40, 40)], 20, 80, "cut")]);
    expect(digest(engine.evaluate(p))).toBe(digest(engine.evaluate(p)));
  });

  it("an empty program is an empty mesh", () => {
    const m = engine.evaluate(program([]));
    expect(m.triangleCount).toBe(0);
    expect(m.positions.length).toBe(0);
  });
});
