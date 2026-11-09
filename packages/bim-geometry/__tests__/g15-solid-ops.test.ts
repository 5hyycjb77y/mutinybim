/** @jest-environment node */
import { IDENTITY_MAT4, MeshCache, SolidProgramError, decimateMesh, readGltf, readObj, type Frame, type Loop, type Mat4Tuple, type SolidEngine, type SolidProgram, type SolidStep, type TriangleMesh } from "../src";
import { nodeManifoldEngine } from "../testing/node-manifold";

/**
 * G15 engine operations: loft between any two loops, steps moved by a
 * transform (pattern copies, mirrors), imported bodies, and convex pieces
 * that keep a hollow hollow. Each fails on round 14's engine, which had only
 * extrude and revolve and no `convexPieces`.
 */

const XY = (z = 0): Frame => ({ origin: [0, 0, z], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] });
const rect = (w: number, h: number, cx = 0, cy = 0): Loop => [
  [cx - w / 2, cy - h / 2],
  [cx + w / 2, cy - h / 2],
  [cx + w / 2, cy + h / 2],
  [cx - w / 2, cy + h / 2],
];
const circle = (r: number, n = 32): Loop => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as const);
const program = (...steps: SolidStep[]): SolidProgram => ({ steps, circularSegments: 32 });
const extrude = (id: string, loops: Loop[], start: number, end: number, operation: SolidStep["operation"] = "join", transform?: Mat4Tuple): SolidStep => ({ id, operation, op: { kind: "extrude", frame: XY(), loops, start, end }, ...(transform ? { transform } : {}) });

function volume(m: TriangleMesh): number {
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const p = (k: number): [number, number, number] => {
      const i = (m.indices[t + k] ?? 0) * 3;
      return [m.positions[i] ?? 0, m.positions[i + 1] ?? 0, m.positions[i + 2] ?? 0];
    };
    const [a, b, c] = [p(0), p(1), p(2)];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

const translate = (x: number, y: number, z: number): Mat4Tuple => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const mirrorX: Mat4Tuple = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

let engine: SolidEngine;
beforeAll(async () => {
  engine = await nodeManifoldEngine();
});

describe("g15-loft-transition", () => {
  it("lofts a rectangle to a round at another height into one closed solid", () => {
    const m = engine.evaluate(program({ id: "t", operation: "join", op: { kind: "loft", sections: [{ frame: XY(0), loop: rect(600, 400) }, { frame: XY(500), loop: circle(150, 48) }] } }));
    expect(m.bounds.min[2]).toBeCloseTo(0);
    expect(m.bounds.max[2]).toBeCloseTo(500);
    expect(m.bounds.max[0]).toBeCloseTo(300);
    // Between the rectangle's and the round's prism volumes.
    const v = volume(m);
    expect(v).toBeGreaterThan(Math.PI * 150 * 150 * 500);
    expect(v).toBeLessThan(600 * 400 * 500);
  });

  it("tapers both width and height (a duct transition along x)", () => {
    const yz = (x: number): Frame => ({ origin: [x, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1], normal: [1, 0, 0] });
    const m = engine.evaluate(program({ id: "t", operation: "join", op: { kind: "loft", sections: [{ frame: yz(0), loop: rect(600, 400) }, { frame: yz(800), loop: rect(300, 200) }] } }));
    expect(m.bounds.max[1] - m.bounds.min[1]).toBeCloseTo(600);
    expect(m.bounds.max[2] - m.bounds.min[2]).toBeCloseTo(400);
    // A frustum: h/3 (A1 + A2 + sqrt(A1 A2)).
    const a1 = 600 * 400;
    const a2 = 300 * 200;
    expect(volume(m)).toBeCloseTo((800 / 3) * (a1 + a2 + Math.sqrt(a1 * a2)), -2);
  });

  it("lofts through three sections and joins with other solids", () => {
    const m = engine.evaluate(program(extrude("base", [rect(800, 800)], -100, 0), { id: "t", operation: "join", op: { kind: "loft", sections: [{ frame: XY(0), loop: rect(400, 400) }, { frame: XY(300), loop: rect(300, 300) }, { frame: XY(600), loop: circle(100) }] } }));
    expect(m.bounds.min[2]).toBeCloseTo(-100);
    expect(m.bounds.max[2]).toBeCloseTo(600);
  });

  it("refuses sections in the same place, in words", () => {
    expect(() => engine.evaluate(program({ id: "bad", operation: "join", op: { kind: "loft", sections: [{ frame: XY(0), loop: rect(100, 100) }, { frame: XY(0), loop: rect(100, 100) }] } }))).toThrow(SolidProgramError);
  });
});

describe("g15-pattern", () => {
  it("moves a step's solid by its transform; copies add up", () => {
    const one = volume(engine.evaluate(program(extrude("a", [rect(100, 100)], 0, 100))));
    const steps = [0, 1, 2, 3].map((i) => extrude(`a${i}`, [rect(100, 100)], 0, 100, "join", translate(i * 300, 0, 0)));
    const m = engine.evaluate(program(...steps));
    expect(volume(m)).toBeCloseTo(4 * one, 0);
    expect(m.bounds.max[0]).toBeCloseTo(950);
  });

  it("mirrors (a negative determinant) into a solid with outward faces", () => {
    const m = engine.evaluate(program(extrude("a", [rect(100, 100, 200, 0)], 0, 100), extrude("b", [rect(100, 100, 200, 0)], 0, 100, "join", mirrorX)));
    expect(volume(m)).toBeCloseTo(2 * 100 * 100 * 100, 0);
    expect(m.bounds.min[0]).toBeCloseTo(-250);
  });

  it("cuts a pattern of holes", () => {
    const holes = [0, 1, 2].map((i) => extrude(`h${i}`, [circle(20, 24)], -1, 101, "cut", translate(-200 + i * 200, 0, 0)));
    const m = engine.evaluate(program(extrude("plate", [rect(700, 200)], 0, 100), ...holes));
    expect(volume(m)).toBeLessThan(700 * 200 * 100 - 3 * 1100 * 100);
    expect(IDENTITY_MAT4[0]).toBe(1);
  });
});

describe("g15-convex-pieces", () => {
  it("keeps a casing's hollow hollow: no piece fills the middle", () => {
    // A 2 m cube shell, 50 mm walls.
    const shell = program(extrude("outer", [rect(2000, 2000)], 0, 2000), extrude("inner", [rect(1900, 1900)], 50, 1950, "cut"));
    const { pieces } = engine.convexPieces(shell);
    expect(pieces.length).toBeGreaterThan(8);
    const centre = [0, 0, 1000];
    const contains = ({ positions: pts }: { positions: Float32Array }) => {
      let lo = [Infinity, Infinity, Infinity];
      let hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pts.length; i += 3) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] ?? 0, pts[i + k] ?? 0);
        hi[k] = Math.max(hi[k] ?? 0, pts[i + k] ?? 0);
      }
      return centre.every((c, k) => c > (lo[k] ?? 0) + 1 && c < (hi[k] ?? 0) - 1);
    };
    expect(pieces.some(contains)).toBe(false);
  });

  it("a solid box is covered by its pieces (all corners present)", () => {
    const { pieces } = engine.convexPieces(program(extrude("box", [rect(500, 500)], 0, 500)));
    const all = pieces.flatMap((p) => Array.from(p.positions));
    expect(Math.max(...all)).toBeCloseTo(500);
    expect(Math.min(...all)).toBeCloseTo(-250);
  });

  it("caches pieces per key like meshes", () => {
    const cache = new MeshCache(engine);
    const p = () => program(extrude("box", [rect(500, 500)], 0, 500));
    cache.pieces("k", p);
    cache.pieces("k", p);
    expect(cache.pieceEvaluations).toBe(1);
  });
});

function cubeObj(size: number): string {
  const s = size / 2;
  const v = [
    [-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0],
    [-s, -s, size], [s, -s, size], [s, s, size], [-s, s, size],
  ];
  const f = ["1 4 3 2", "5 6 7 8", "1 2 6 5", "2 3 7 6", "3 4 8 7", "4 1 5 8"];
  return [...v.map((p) => `v ${p.join(" ")}`), "vt 0 0", "usemtl shiny", ...f.map((q) => `f ${q.split(" ").map((i) => `${i}/1`).join(" ")}`)].join("\n");
}

function cubeGltf(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  // Corner order as above (x, y, z with y up in the file, so the file's y is height).
  const idx = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  const bin = new Uint8Array(positions.byteLength + idx.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), positions.byteLength);
  const b64 = Buffer.from(bin).toString("base64");
  const doc = {
    asset: { version: "2.0" },
    buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: idx.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0, scale: [0.5, 0.5, 0.5], translation: [1, 0, 0] }],
    scenes: [{ nodes: [0] }],
  };
  return new TextEncoder().encode(JSON.stringify(doc));
}

describe("g15-import-gltf-body", () => {
  it("reads a glTF (metres, y up) into millimetres, z up, with node transforms", () => {
    const m = readGltf(cubeGltf(), { mmPerUnit: 1000, upAxis: "y" });
    expect(m.triangleCount).toBe(12);
    expect(m.bounds.min[0]).toBeCloseTo(1000);
    expect(m.bounds.max[0]).toBeCloseTo(1500);
    expect(m.bounds.max[2]).toBeCloseTo(500);
  });

  it("reads an OBJ, ignores its materials, and the body joins the solid", () => {
    const body = readObj(cubeObj(100), { mmPerUnit: 1, upAxis: "z" });
    const m = engine.evaluate(program(extrude("plate", [rect(400, 400)], -10, 0), { id: "imp", operation: "join", op: { kind: "mesh", positions: body.positions, indices: body.indices } }));
    expect(volume(m)).toBeCloseTo(400 * 400 * 10 + 100 ** 3, -1);
  });

  it("an open body still draws, but can't cut", () => {
    const body = readObj(cubeObj(100).split("\n").slice(0, -1).join("\n"), { mmPerUnit: 1, upAxis: "z" });
    const drawn = engine.evaluate(program(extrude("plate", [rect(400, 400)], -10, 0), { id: "open", operation: "join", op: { kind: "mesh", positions: body.positions, indices: body.indices } }));
    expect(drawn.triangleCount).toBeGreaterThan(12);
    expect(() => engine.evaluate(program(extrude("plate", [rect(400, 400)], -10, 0), { id: "open", operation: "cut", op: { kind: "mesh", positions: body.positions, indices: body.indices } }))).toThrow(/can only add material/);
  });

  it("refuses files that reach outside themselves or break the limits, in words", () => {
    const external = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "secret.bin", byteLength: 4 }] }));
    expect(() => readGltf(external, { mmPerUnit: 1000, upAxis: "y" })).toThrow(/separate buffer file/);
    expect(() => readObj("v 0 0 0\nv 1 0 0\nf 1 2 9", { mmPerUnit: 1, upAxis: "z" })).toThrow(/isn't in the file/);
    expect(() => readObj("v 0 0 NaN", { mmPerUnit: 1, upAxis: "z" })).toThrow(/isn't a number/);
    expect(() => readObj(cubeObj(1), { mmPerUnit: 1e6, upAxis: "z" })).toThrow(/check its unit/);
  });

  it("decimates for coarse drawings", () => {
    const fine = engine.evaluate(program({ id: "c", operation: "join", op: { kind: "revolve", frame: { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] }, loops: [rect(100, 400, 50, 200)], axisPoint: [0, 0], axisDirection: [0, 1], startDeg: 0, endDeg: 360 } }));
    const coarse = decimateMesh(fine, 60);
    expect(coarse.triangleCount).toBeLessThan(fine.triangleCount);
    expect(coarse.triangleCount).toBeGreaterThan(0);
  });
});
