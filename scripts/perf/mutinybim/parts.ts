/**
 * One run of the part editor workload, in one process: the geometry engine
 * starting cold, a 40-point / 60-constraint sketch solved, a 50-feature part
 * regenerated, and one ~10k-triangle solid cut by another. Every repeat of a
 * workload is checked against the first result, so a solver or engine that
 * stops being deterministic fails the gate's invariants.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/parts.ts --samples=21
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts.
 */
import { createHash } from "node:crypto";
import { solveSketch, type Sketch, type SketchInputs, type SketchSolution } from "@permitzip/bim-kernel";
import { createManifoldEngine, type Frame, type Loop, type SolidProgram, type SolidStep, type TriangleMesh } from "@permitzip/bim-geometry";
import { emit, gc, memoryMB, round, timeSync, type Sample } from "./lib";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const samplesPerRun = Number(arg("samples", "21"));
/** The solve is well under a millisecond; more samples keep its p95 off the single slowest one. */
const solveSamples = Math.max(201, samplesPerRun);
const WARMUP = 5;

// ------------------------------------------------------------------ workloads

/** 40 points chained by 39 lines; a fixed start, then alternating horizontal / vertical and a length on most lines (60 constraints). */
function sketch40x60(): { sketch: Sketch; inputs: SketchInputs } {
  const points = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, u: i * 10 + (i % 3), v: (i % 2) * 20 + (i % 5) }));
  const entities = Array.from({ length: 39 }, (_, i) => ({ kind: "line" as const, id: `l${i}`, a: `p${i}`, b: `p${i + 1}` }));
  const constraints: Sketch["constraints"] = [{ kind: "fix", point: "p0", u: 0, v: 0 }];
  const dims = new Map<number, { value?: number; u?: number; v?: number }>([[0, { u: 0, v: 0 }]]);
  for (let i = 0; i < 39 && constraints.length < 60; i++) {
    constraints.push({ kind: i % 2 ? "vertical" : "horizontal", line: `l${i}` });
    if (constraints.length < 60) {
      dims.set(constraints.length, { value: 10 + (i % 4) });
      constraints.push({ kind: "length", line: `l${i}`, value: 10 + (i % 4) });
    }
  }
  return { sketch: { id: "big", name: "Big", plane: "base", points, entities, constraints }, inputs: { dims, planes: new Map(), radii: new Map() } };
}

const XY: Frame = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 1] };
const rect = (cx: number, cy: number, w: number, h: number): Loop => [
  [cx - w / 2, cy - h / 2],
  [cx + w / 2, cy - h / 2],
  [cx + w / 2, cy + h / 2],
  [cx - w / 2, cy + h / 2],
];
const box = (id: string, loop: Loop, start: number, end: number, operation: SolidStep["operation"]): SolidStep => ({ id, operation, op: { kind: "extrude", frame: XY, loops: [loop], start, end } });

/** A body and 49 extruded features, joins and cuts interleaved (the order a person adds bosses and holes). */
function regen50(): SolidProgram {
  const steps: SolidStep[] = [box("body", rect(0, 0, 900, 500), 0, 400, "join")];
  for (let i = 0; i < 49; i++) steps.push(box(`f${i}`, rect(-400 + i * 16, i % 2 ? 100 : 0, 12, 40), -20, 430, i % 3 === 0 ? "join" : "cut"));
  return { steps, circularSegments: 32 };
}

/** A 64-gon ring revolved in 80 segments: a 10,240-triangle torus. */
const ring = (cx: number): Array<{ x: number; y: number }> => Array.from({ length: 64 }, (_, i) => ({ x: cx + 500 * Math.cos((2 * Math.PI * i) / 64), y: 500 * Math.sin((2 * Math.PI * i) / 64) }));

const meshHash = (m: TriangleMesh): string => createHash("sha256").update(Buffer.from(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength)).update(Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength)).digest("hex");
const solutionKey = (s: SketchSolution): string => JSON.stringify([s.status, s.freeDirections, s.iterations, [...s.points.entries()].map(([id, p]) => [id, p.u, p.v])]);

// ------------------------------------------------------------------ run

async function main(): Promise<void> {
  gc();
  // Engine start, cold: import, instantiate the WASM, set up.
  const t0 = performance.now();
  const mod = await import("manifold-3d");
  const wasm = await mod.default();
  wasm.setup();
  const initMs = performance.now() - t0;
  const engine = createManifoldEngine(wasm);

  // Sketch solve.
  const { sketch, inputs } = sketch40x60();
  const firstSolve = solveSketch(sketch, inputs);
  if (firstSolve.status === "failed") throw new Error(`[perf/parts] the 40x60 sketch failed to solve: ${firstSolve.problems.join("; ")}`);
  const solveKey = solutionKey(firstSolve);
  let solveMismatches = 0;
  for (let i = 0; i < WARMUP; i++) solveSketch(sketch, inputs);
  const solve: number[] = [];
  for (let i = 0; i < solveSamples; i++) {
    const t = timeSync(() => solveSketch(sketch, inputs));
    solve.push(t.ms);
    if (solutionKey(t.value) !== solveKey) solveMismatches++;
  }

  // Regenerate a 50-feature part.
  const program = regen50();
  const firstRegen = engine.evaluate(program);
  const regenKey = meshHash(firstRegen);
  let regenMismatches = 0;
  for (let i = 0; i < WARMUP; i++) engine.evaluate(program);
  const regen: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(() => engine.evaluate(program));
    regen.push(t.ms);
    if (meshHash(t.value) !== regenKey) regenMismatches++;
  }

  // One boolean: two tori built and evaluated first, then only the cut and its mesh are timed.
  const sa = new wasm.CrossSection([ring(1500)] as never, "EvenOdd");
  const sb = new wasm.CrossSection([ring(1800)] as never, "EvenOdd");
  const a = sa.revolve(80, 360);
  const b = sb.revolve(80, 360);
  const inputTriangles = [a.numTri(), b.numTri()];
  const cutOnce = (): { tris: number; volume: number } => {
    const c = a.subtract(b);
    try {
      c.getMesh();
      return { tris: c.numTri(), volume: c.volume() };
    } finally {
      c.delete();
    }
  };
  const firstCut = cutOnce();
  let booleanMismatches = 0;
  for (let i = 0; i < WARMUP; i++) cutOnce();
  const boolean: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(cutOnce);
    boolean.push(t.ms);
    if (t.value.tris !== firstCut.tris || t.value.volume !== firstCut.volume) booleanMismatches++;
  }
  for (const o of [sa, sb, a, b]) o.delete();

  const samples: Sample[] = [
    { metric: "geometry.engine.init", values: [initMs], note: "manifold-3d import + WASM instantiate + setup, once per process" },
    { metric: "part.sketch.solve.40x60", values: solve, note: `${firstSolve.status}, ${firstSolve.iterations} iterations, ${firstSolve.freeDirections} free directions` },
    { metric: "part.regen.50", values: regen, counts: { visibleTriangles: firstRegen.triangleCount } },
    { metric: "geometry.boolean.10k", values: boolean, counts: { visibleTriangles: firstCut.tris }, note: `inputs ${inputTriangles.join(" + ")} triangles` },
  ];
  emit({
    suite: "parts",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { sketch: "40 points / 60 constraints", regen: "body + 49 extrudes, joins and cuts interleaved", boolean: "torus minus torus, 10,240 triangles each", samplesPerRun, solveSamples },
    samples,
    invariants: { partSolveMismatches: solveMismatches, partRegenMismatches: regenMismatches, booleanMismatches },
    info: { initMs: round(initMs, 1), memory: memoryMB() },
  });
}

main().catch((err) => {
  console.error("[perf/parts] failed", err);
  process.exit(1);
});
