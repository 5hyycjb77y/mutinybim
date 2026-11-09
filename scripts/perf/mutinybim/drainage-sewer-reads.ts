/**
 * drainage.sewer_reads — what the drainage lint pack reads on every lint pass
 * (ROADMAP P4), on the synthetic 14-storey tower with 2,800 drainage loads, a
 * sewer connection, a sewage pump and a basement.
 *
 *   node --import tsx scripts/perf/mutinybim/drainage-sewer-reads.ts [--samples=7]
 *
 *   drainage.sewer_reads.edit   after one committed load edit: the parts that play a drainage role,
 *                               every floor against the sewer, fixture units at the connection and the
 *                               pump check (new model state, so the per-state indexes are built once)
 *   drainage.sewer_reads.warm   the same reads again on the same state (what the second and later
 *                               rules in the pass pay)
 *
 * Prints one JSON object (median and p95 per metric, plus the counts read).
 */
import { asElementId, DEFAULT_SETTINGS, elementsOfKind, planCommit, type BimElement, type Command, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { dfuAtSewerConnection, drainageParts, floorsAgainstSewer, sewagePumpCheck, sewerConnectionOf } from "@permitzip/bim-pack-plumbing";
import { SEWAGE_PUMP, SEWER_CONNECTION } from "../../../packages/bim-kernel/__tests__/drainage-fixtures";
import { emit } from "./lib";

const args = process.argv.slice(2);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 7);
const FT = 304.8;
const LOADS_PER_LEVEL = 200;

let seq = 0;
function commit(model: ModelState, command: Command): ModelState {
  seq += 1;
  const d = planCommit(model, [], { idempotencyKey: `perf-drainage-${seq}-key`, baseRevision: model.revision, actor: { id: "agent:perf", name: "Perf", kind: "agent" }, command });
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

function pct(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0) * 100) / 100;
}

function build(): ModelState {
  let model = createFullBimModel({ floors: 14, zonesPerFloor: 2, rooms: { cols: 8, rows: 9 }, modelId: "synthetic-tower-14-drainage" });
  const elements: Record<string, BimElement> = { ...model.elements };
  const basement = asElementId("lvl-B1");
  elements[basement] = { id: basement, kind: "level", version: 1, authoredRev: {}, name: "B1", elevationMm: -12 * FT };
  for (let i = 0; i < 13; i++) {
    const id = asElementId(`lvl-L${String(i + 1).padStart(2, "0")}`);
    elements[id] = { id, kind: "level", version: 1, authoredRev: {}, name: `L${String(i + 1).padStart(2, "0")}`, elevationMm: i * 4000 };
  }
  model = { ...model, elements, settings: model.settings ?? DEFAULT_SETTINGS };
  model = commit(model, { type: "place_part", partId: "mh-1", typeId: "type-manhole", partType: SEWER_CONNECTION, levelId: basement, position: { x: 0, y: -20 * FT }, mark: "MH-1", values: { sewer_invert: -10 * FT, sewer_rim: -2 * FT, elevation_confidence: "verified", building_drain_size_in: 8, building_drain_slope_in_per_ft: 0.125 } });
  model = commit(model, { type: "place_part", partId: "sgp-1", typeId: "type-pump", partType: SEWAGE_PUMP, levelId: basement, position: { x: 10 * FT, y: -20 * FT }, mark: "SGP-1", values: { pump_rated_gpm: 50, pump_rated_head_ft: 25 } });
  for (const level of elementsOfKind(model.elements, "level")) {
    for (let start = 0; start < LOADS_PER_LEVEL; start += 500) {
      const n = Math.min(500, LOADS_PER_LEVEL - start);
      model = commit(model, { type: "create_load", loads: Array.from({ length: n }, (_, i) => ({ id: `${level.id}-d${start + i}`, anchor: { kind: "point" as const, levelId: level.id, position: { x: (start + i) * 2 * FT, y: 0 } }, values: { dfu: 2 + ((start + i) % 3) } })) });
    }
  }
  return model;
}

function reads(model: ModelState): { floors: number; dfu: number } {
  const els = model.elements;
  const parts = drainageParts(els);
  let floors = 0;
  let dfu = 0;
  for (const id of parts.sewerConnections) {
    const conn = sewerConnectionOf(els, id);
    if (!conn) continue;
    floors += floorsAgainstSewer(els, conn).length;
    dfu += dfuAtSewerConnection(els, conn.id).dfu;
  }
  for (const id of parts.pumps) sewagePumpCheck(els, id);
  return { floors, dfu };
}

const edit: number[] = [];
const warm: number[] = [];
let counts = { elements: 0, loads: 0, floors: 0, dfu: 0 };
const base = build();
for (let i = 0; i < samples; i++) {
  const target = `lvl-B1-d${i}`;
  const next = commit(base, { type: "edit_load_point", loadId: target, values: { dfu: 4 + i } });
  let got = { floors: 0, dfu: 0 };
  edit.push(time(() => (got = reads(next))));
  warm.push(time(() => reads(next)));
  counts = { elements: Object.keys(next.elements).length, loads: elementsOfKind(next.elements, "load_point").length, ...got };
}

const row = (xs: readonly number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length });
process.stderr.write(`${JSON.stringify({ suite: "drainage", metrics: { "drainage.sewer_reads.edit": row(edit), "drainage.sewer_reads.warm": row(warm) }, counts }, null, 2)}\n`);
const c = { totalElements: counts.elements, affectedElements: 1 };
emit({
  suite: "batch",
  workload: { tower: "14 storeys + basement", drainageLoads: counts.loads, samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: counts,
  samples: [
    { metric: "drainage.sewer_reads.edit", values: edit, counts: c, note: "Drainage parts, every floor against the sewer, DFU at the connection and the pump check, on the state after one load edit." },
    { metric: "drainage.sewer_reads.warm", values: warm, counts: c, note: "The same reads again on the same state." },
  ],
});
