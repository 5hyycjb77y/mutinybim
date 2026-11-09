/**
 * Round 15 lane G15: what real part solids cost. Per part type, in process,
 * no model needed (a part's solid depends on its type and size, not on how
 * many copies are placed: every copy of a size shares one cached mesh).
 *
 * - part.mesh.build.<part>: build one size's solid from its definition
 *   (resolve the solid program, then the engine), the cache cold. Budget
 *   20 / 50 ms per type. Parts: the rooftop-unit starter (fine), a swept
 *   elbow, a rectangle-to-round loft.
 * - part.mesh.cache_hit: a placed copy asking for its size's mesh when it is
 *   cached (what every redraw of every copy pays), µs.
 * - part.clash.pieces.build.rtu: the rooftop unit's convex pieces for clash
 *   (medium detail, ~450 mm cells), built once per type + size (cached beside the mesh).
 * - lint.clash.part_mesh.after_edit: one touched rooftop unit measured
 *   against a pipe through its curb and one through its casing (pieces cached).
 *   Budget 5 / 10 ms per touched part.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/g15-part-solids.ts [samples] [--pictures=<dir>]
 *
 * `--pictures` also writes the rooftop unit's front / side / plan pictures
 * and a shaded three-quarter view as SVG.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createManifoldEngine, MeshCache, type TriangleMesh } from "@permitzip/bim-geometry";
import { DEFAULT_SETTINGS, PART_VIEWS, partConvexPieces, partMesh, partViewLinework, partViewSvg, setPartMeshProvider, type ModelState, type PartTypeDefinition, type Revision } from "@permitzip/bim-kernel";
import { hullConvex, measurePair, p3, prismConvex } from "../../../packages/bim-lint/src/geometry/convex";
import * as kit from "../../../packages/bim-script/src";
import { gc, percentile, round, timeSync } from "./lib";

const samples = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? "21");
const pictures = process.argv.find((a) => a.startsWith("--pictures="))?.split("=")[1] ?? null;
const WARMUP = 3;
const IN = 25.4;

function stats(ms: readonly number[]): { p50: number; p95: number } {
  return { p50: round(percentile(ms, 0.5) ?? 0, 4), p95: round(percentile(ms, 0.95) ?? 0, 4) };
}

function evaluate(source: string): kit.ScriptDefinition {
  const plain = source.replace(/^import \{([^}]*)\} from "@permitzip\/bim-script";$/m, "const {$1} = __kit;").replace(/^export default /m, "__exports.default = ");
  const slot: { default?: kit.ScriptDefinition } = {};
  runInNewContext(plain, { __kit: kit, __exports: slot, Math, Number, String, JSON });
  if (!slot.default) throw new Error("[perf/g15] starter has no default export");
  return slot.default;
}

async function starterPart(key: string): Promise<PartTypeDefinition> {
  const item = kit.starterScriptItems().find((i) => i.key === key);
  if (!item) throw new Error(`[perf/g15] no starter ${key}`);
  const def = evaluate(item.source);
  const head: ModelState = { modelId: "g15-perf", revision: 1 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const out = await kit.runScript(def, { slice: kit.sliceModel(head, def.manifest.reads), values: kit.resolveValues(def.manifest), scriptHash: item.contentHash ?? "" });
  const part = out.kind === "part_types" ? out.types[0]?.definition : undefined;
  if (!part) throw new Error(`[perf/g15] ${key} made no part`);
  return part;
}

/** A shaded three-quarter view (painter's order, flat light) as SVG. */
function shadedSvg(m: TriangleMesh, widthPx = 1000): string {
  const view = [0.62, -0.62, 0.48];
  const vl = Math.hypot(view[0] ?? 0, view[1] ?? 0, view[2] ?? 0);
  const d = view.map((c) => c / vl) as [number, number, number];
  const right = [d[1], -d[0], 0].map((c) => c / Math.hypot(d[0], d[1])) as [number, number, number];
  const up = [right[1] * d[2] - right[2] * d[1], right[2] * d[0] - right[0] * d[2], right[0] * d[1] - right[1] * d[0]] as [number, number, number];
  const light = [0.3, -0.5, 0.81];
  const pt = (i: number): [number, number, number] => [m.positions[i * 3] ?? 0, m.positions[i * 3 + 1] ?? 0, m.positions[i * 3 + 2] ?? 0];
  const tris: Array<{ pts: [number, number][]; depth: number; shade: number }> = [];
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [pt(m.indices[t] ?? 0), pt(m.indices[t + 1] ?? 0), pt(m.indices[t + 2] ?? 0)];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [(e1[1] ?? 0) * (e2[2] ?? 0) - (e1[2] ?? 0) * (e2[1] ?? 0), (e1[2] ?? 0) * (e2[0] ?? 0) - (e1[0] ?? 0) * (e2[2] ?? 0), (e1[0] ?? 0) * (e2[1] ?? 0) - (e1[1] ?? 0) * (e2[0] ?? 0)];
    const nl = Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0) || 1;
    const facing = ((n[0] ?? 0) * d[0] + (n[1] ?? 0) * d[1] + (n[2] ?? 0) * d[2]) / nl;
    if (facing <= 0) continue;
    const lit = Math.max(0, ((n[0] ?? 0) * (light[0] ?? 0) + (n[1] ?? 0) * (light[1] ?? 0) + (n[2] ?? 0) * (light[2] ?? 0)) / nl);
    const proj = [a, b, c].map((p) => [p[0] * right[0] + p[1] * right[1] + p[2] * right[2], p[0] * up[0] + p[1] * up[1] + p[2] * up[2]] as [number, number]);
    for (const [u, v] of proj) {
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const depth = (a[0] + b[0] + c[0]) * d[0] + (a[1] + b[1] + c[1]) * d[1] + (a[2] + b[2] + c[2]) * d[2];
    tris.push({ pts: proj, depth, shade: 0.35 + 0.65 * lit });
  }
  tris.sort((x, y) => x.depth - y.depth);
  const pad = 0.04 * Math.max(maxU - minU, maxV - minV);
  const k = widthPx / (maxU - minU + 2 * pad);
  const h = (maxV - minV + 2 * pad) * k;
  const X = (u: number) => ((u - minU + pad) * k).toFixed(1);
  const Y = (v: number) => ((maxV + pad - v) * k).toFixed(1);
  const body = tris.map((t) => {
    const g = Math.round(90 + 150 * t.shade);
    const fill = `rgb(${g},${Math.round(g * 0.98)},${Math.round(g * 0.94)})`;
    return `<polygon points="${t.pts.map(([u, v]) => `${X(u)},${Y(v)}`).join(" ")}" fill="${fill}" stroke="${fill}" stroke-width="0.4"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${h.toFixed(0)}" viewBox="0 0 ${widthPx} ${h.toFixed(0)}"><rect width="100%" height="100%" fill="white"/>${body.join("")}</svg>`;
}

/** The same picture on a square page (thumbnailers crop to a square). */
function squared(svg: string): string {
  const m = /<svg [^>]*width="([\d.]+)" height="([\d.]+)" viewBox="0 0 ([\d.]+) ([\d.]+)">/.exec(svg);
  if (!m) return svg;
  const w = Number(m[3]);
  const h = Number(m[4]);
  const side = Math.max(w, h);
  return svg.replace(m[0], `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="${((w - side) / 2).toFixed(1)} ${((h - side) / 2).toFixed(1)} ${side} ${side}"><rect x="${((w - side) / 2).toFixed(1)}" y="${((h - side) / 2).toFixed(1)}" width="${side}" height="${side}" fill="white"/>`);
}

async function main(): Promise<void> {
  gc();
  const mod = await import("manifold-3d");
  const wasm = await mod.default();
  wasm.setup();
  const engine = createManifoldEngine(wasm);

  const rtu = await starterPart("starter.rooftop_unit");
  const elbow = kit.parts.part("Elbow", { type: "12 in 90", category: "duct_accessory" }).sweep(kit.parts.circle(kit.units.in(12)), { on: "plan", at: kit.units.in(12), start: [0, 0], heading: "right", segments: [{ straight: kit.units.in(6) }, { bend: { radius: kit.units.in(18), angle: 90, turn: "left" } }, { straight: kit.units.in(6) }] }).build();
  const loft = kit.parts.part("Square to round", { type: "24-16", category: "duct_accessory" }).loft([{ profile: kit.parts.rect(kit.units.in(24), kit.units.in(24)), at: kit.units.in(0) }, { profile: kit.parts.circle(kit.units.in(16)), at: kit.units.in(20) }]).build();

  const out: Record<string, unknown> = {};
  const buildCold = (name: string, def: PartTypeDefinition) => {
    const ms: number[] = [];
    let tris = 0;
    for (let i = 0; i < WARMUP + samples; i++) {
      setPartMeshProvider(new MeshCache(engine));
      const t = timeSync(() => partMesh(def, {}, "fine"));
      tris = t.value.triangleCount;
      if (i >= WARMUP) ms.push(t.ms);
    }
    out[`part.mesh.build.${name}`] = { ...stats(ms), triangles: tris };
  };
  buildCold("rtu", rtu);
  buildCold("elbow", elbow);
  buildCold("loft", loft);

  // Coarse is what a 1M-element plan draws far away: its own, lighter mesh.
  const cache = new MeshCache(engine);
  setPartMeshProvider(cache);
  out["part.mesh.rtu.coarse_triangles"] = partMesh(rtu, {}, "coarse").triangleCount;
  partMesh(rtu, {}, "fine");
  const hits: number[] = [];
  for (let i = 0; i < 2000; i++) hits.push(timeSync(() => partMesh(rtu, {}, "fine")).ms * 1000);
  out["part.mesh.cache_hit"] = { ...stats(hits.slice(200)), unit: "us" };

  const pieceMs: number[] = [];
  let pieceCount = 0;
  for (let i = 0; i < WARMUP + samples; i++) {
    setPartMeshProvider(new MeshCache(engine));
    const t = timeSync(() => partConvexPieces(rtu, {}, "medium"));
    pieceCount = t.value.pieces.length;
    if (i >= WARMUP) pieceMs.push(t.ms);
  }
  out["part.clash.pieces.build.rtu"] = { ...stats(pieceMs), pieces: pieceCount };

  // After an edit: the touched unit's (cached) pieces against two pipes, one in the curb's hollow and one through the casing.
  setPartMeshProvider(cache);
  const pieces = partConvexPieces(rtu, {}, "medium").pieces;
  const placed = () => pieces.map((p) => hullConvex(Array.from({ length: p.positions.length / 3 }, (_, i) => p3(p.positions[i * 3] ?? 0, p.positions[i * 3 + 1] ?? 0, p.positions[i * 3 + 2] ?? 0)), p.indices));
  const pipe = (z: number) => [prismConvex([{ x: -400, y: -30 }, { x: 400, y: -30 }, { x: 400, y: 30 }, { x: -400, y: 30 }], z - 30, z + 30)];
  const inCurb = pipe(7 * IN);
  const inCasing = pipe(40 * IN);
  const clash: number[] = [];
  let curbMeasure = "";
  let casingMeasure = "";
  for (let i = 0; i < WARMUP + samples; i++) {
    const t = timeSync(() => {
      const body = placed();
      return [measurePair(body, inCurb, 300), measurePair(body, inCasing, 300)] as const;
    });
    curbMeasure = t.value[0].kind;
    casingMeasure = t.value[1].kind;
    if (i >= WARMUP) clash.push(t.ms);
  }
  out["lint.clash.part_mesh.after_edit"] = { ...stats(clash), pipeInCurbHollow: curbMeasure, pipeThroughCasing: casingMeasure };
  setPartMeshProvider(null);
  process.stdout.write(`${JSON.stringify({ suite: "g15-part-solids", samples, results: out }, null, 2)}\n`);

  if (pictures) {
    mkdirSync(pictures, { recursive: true });
    setPartMeshProvider(new MeshCache(engine));
    for (const view of PART_VIEWS) writeFileSync(join(pictures, `rtu-${view}.svg`), squared(partViewSvg(partViewLinework(rtu, view, rtu.typeValues), 900)));
    writeFileSync(join(pictures, "rtu-3d.svg"), squared(shadedSvg(partMesh(rtu, {}, "fine"))));
    writeFileSync(join(pictures, "rtu-3d-coarse.svg"), squared(shadedSvg(partMesh(rtu, {}, "coarse"))));
    setPartMeshProvider(null);
    process.stdout.write(`[perf/g15] pictures written to ${pictures}\n`);
  }
}

main().catch((err: unknown) => {
  console.error("[perf/g15] failed", err);
  process.exit(1);
});
