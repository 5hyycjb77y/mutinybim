/**
 * @jest-environment node
 *
 * Round 15 lane A15 (A1): walls join. Review video (Nov 4): four walls drawn corner
 * to corner overlap as separate boxes in the live plan and 3D. The kernel
 * already joins them (`lineJoinsOf`, the body sections draw); the viewer drew
 * every wall nothing was hosted in as its own box from end to end, so each
 * corner had one wall poking through the other and a notch missing.
 *
 * Now every wall something joins draws the kernel's joined body, and the
 * viewer merges a level's walls into one mesh (one draw, one outline), with
 * each triangle still knowing its wall so a click picks one wall.
 *
 * Fails on round 14's code: the four walls are plain boxes (`shape: "box"`)
 * whose volumes don't add up to the room's ring of wall (overlap at two
 * corners, notches at the other two), and there was no batching
 * (`../src/mesh-batches` did not exist).
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import type { ModelState } from "@permitzip/bim-kernel";
import { twoLevels, type Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import { MM } from "../src/coords";
import { batchMeshSolids, batchOwnerAt } from "../src/mesh-batches";
import { elementSolids, modelSolids, type Solid } from "../src/native-geometry";

installFirstPartyAddOns();

const H = 3000;
const T = 200;

function room(m: Log, prefix: string, levelId: string, at: { x: number; y: number }, w: number, d: number): void {
  const c = [at, { x: at.x + w, y: at.y }, { x: at.x + w, y: at.y + d }, { x: at.x, y: at.y + d }];
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    if (!a || !b) continue;
    m.ok({ type: "create_element", elementId: `${prefix}${i}`, kind: "wall", levelId, size: { thicknessMm: T, heightMm: H }, placement: { kind: "line", start: a, end: b } });
  }
}

/** A closed mesh's volume, mm³ (divergence theorem over its triangles). */
function volumeMm3(s: Solid): number {
  const p = s.mesh?.positions;
  const idx = s.mesh?.indices;
  if (!p || !idx) {
    return s.size[0] * s.size[1] * s.size[2] * 1e9;
  }
  const at = (i: number): [number, number, number] => [((p[i * 3] ?? 0) + s.center[0]) / MM, ((p[i * 3 + 1] ?? 0) + s.center[1]) / MM, ((p[i * 3 + 2] ?? 0) + s.center[2]) / MM];
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [at(idx[t] ?? 0), at(idx[t + 1] ?? 0), at(idx[t + 2] ?? 0)];
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return Math.abs(v / 6);
}

const wallSolids = (model: ModelState, ids: readonly string[]): Solid[] =>
  ids.flatMap((id) => {
    const el = model.elements[id];
    return el ? elementSolids(el, undefined, model) : [];
  });

describe("a15-walls-join-batched", () => {
  it("four walls corner to corner draw the kernel's joined bodies: no overlap, no notch", () => {
    const m = twoLevels("a15-join");
    room(m, "w", "L1", { x: 0, y: 0 }, 6000, 4000);
    const model = m.head as ModelState;
    const solids = wallSolids(model, ["w0", "w1", "w2", "w3"]);
    expect(solids.map((s) => s.shape)).toEqual(["mesh", "mesh", "mesh", "mesh"]);
    const ring = ((6000 + T) * (4000 + T) - (6000 - T) * (4000 - T)) * H;
    const total = solids.reduce((sum, s) => sum + volumeMm3(s), 0);
    expect(total / ring).toBeCloseTo(1, 6);
  });

  it("a level's joined walls are one batch; each triangle still picks its own wall", () => {
    const m = twoLevels("a15-batch");
    room(m, "a", "L1", { x: 0, y: 0 }, 6000, 4000);
    room(m, "b", "L2", { x: 0, y: 0 }, 6000, 4000);
    const model = m.head as ModelState;
    const solids = modelSolids(model);
    const walls = new Set(["a0", "a1", "a2", "a3", "b0", "b1", "b2", "b3"]);
    const { batches, rest } = batchMeshSolids(solids, (s) => (walls.has(s.elementId) ? `${model.elements[s.elementId]?.partition?.level ?? ""}:${s.group}` : null));
    expect(batches.map((b) => b.owners.length)).toEqual([4, 4]);
    expect(rest.filter((s) => walls.has(s.elementId))).toEqual([]);
    const first = batches[0];
    if (!first) throw new Error("no batch");
    // The triangles after the first wall's belong to the second wall.
    const firstWall = solids.find((s) => s.elementId === first.owners[0]);
    const firstTriangles = (firstWall?.mesh?.indices.length ?? 0) / 3;
    expect(batchOwnerAt(first, 0)).toBe(first.owners[0]);
    expect(batchOwnerAt(first, firstTriangles)).toBe(first.owners[1]);
    expect(batchOwnerAt(first, first.triangleOwner.length)).toBeNull();
    // World positions are kept: the batch spans the room's outside faces.
    const xs: number[] = [];
    for (let i = 0; i < first.positions.length; i += 3) xs.push(Math.round((first.positions[i] ?? 0) / MM));
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([-T / 2, 6000 + T / 2]);
  });

  it("a wall nothing joins stays an instanced box", () => {
    const m = twoLevels("a15-lone");
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: T, heightMm: H }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 } } });
    expect(wallSolids(m.head as ModelState, ["w"]).map((s) => s.shape)).toEqual(["box"]);
  });

  it("batches a level of joined walls inside the budget (viewer.walls.level_batch)", () => {
    const m = twoLevels("a15-perf");
    const rooms = 12;
    for (let i = 0; i < rooms; i++) for (let k = 0; k < rooms; k++) room(m, `r${i}-${k}-`, "L1", { x: i * 7000, y: k * 5000 }, 6000, 4000);
    const model = m.head as ModelState;
    const ids = Object.values(model.elements).flatMap((e) => (e.kind === "wall" ? [e.id] : []));
    const wallSet = new Set<string>(ids);
    const solids = wallSolids(model, ids);
    const merge = () => batchMeshSolids(solids, (s) => (wallSet.has(s.elementId) ? "L1:wall" : null));
    merge();
    const ms: number[] = [];
    const build: number[] = [];
    for (let r = 0; r < 9; r++) {
      const t0 = performance.now();
      wallSolids(model, ids);
      const t1 = performance.now();
      merge();
      build.push(t1 - t0);
      ms.push(performance.now() - t1);
    }
    ms.sort((a, b) => a - b);
    build.sort((a, b) => a - b);
    const p50 = ms[Math.floor(ms.length / 2)] ?? Infinity;
    const p95 = ms[ms.length - 1] ?? Infinity;
    const bodies = build[Math.floor(build.length / 2)] ?? Infinity;
    process.stdout.write(`[perf] viewer.walls.level_batch p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms merge for ${ids.length} joined walls on one level (their joined bodies: ${bodies.toFixed(2)}ms, built once per edit for every solid already)\n`);
    // Context only at this size (the 250k / 1M rows run in the perf script under the heavy lock); a regression guard.
    expect(p50).toBeLessThan(250);
  });
});
