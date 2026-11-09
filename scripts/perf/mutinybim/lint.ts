/**
 * One run of the coordination lint workload, in one process: the tier's
 * full-building model (250k) plus a synthetic linked architecture model of
 * 100k elements laid over the same footprint (walls, slabs, beams, columns,
 * spaces), as the lint engine sees them.
 *
 * - lint.index.cold: a fresh engine indexes the model and the linked model.
 * - lint.advance.50: after one committed edit touching at most 50 elements
 *   (outside the timing), the engine is told what changed (`advance`) and
 *   finds what is new in the edit's scope: the before and after findings
 *   near it plus the index update. What the lint block waits on.
 * - lint.block.build: the rest of the block: the diff, "what's here", the
 *   caps and serialising it.
 * - lint.memory.index: heap held by the index, MB.
 *
 * Invariants: scoped findings after advance that differ from a fresh
 * engine's on the same revision (must be 0), blocks over 2 KB (must be 0),
 * edits touching more than 50 elements (must be 0).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/lint.ts --tier=250k --samples=21
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts.
 */
import { elementValues, executeCommand, freezeElements, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { capBlock, DEFAULT_LINT_CONFIG, LintEngine, LINT_BLOCK_MAX_BYTES, type LinkedElement, type LinkedModelIndex, type LintBlock } from "@permitzip/bim-lint";
import { emit, gc, memoryMB, timeSync, type Sample } from "./lib";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const COLD_SAMPLES = 3;
const LINKED_ELEMENTS = 100_000;
const MAX_CHANGED = 50;
/**
 * Edits run before the timed ones and not counted. The first scoped run in a
 * process compiles the rule code: on a laptop it takes 11-14 ms against a warm
 * p95 of about 4 ms, and with three processes per CI run those first calls are
 * three of the 63 samples, so they decided p95 and p99 on a slower CPU. The
 * row is a warm measurement (`cache: warm`); what a first call costs is
 * reported as `info.advanceWarmupMs`, never dropped silently.
 */
const WARMUP_EDITS = 3;
const FT = 304.8;

/** A linked architecture model over the host's footprint: a grid of rooms per floor, with their walls, slab, beams and columns. */
function syntheticLinked(model: ModelState, count: number): LinkedModelIndex {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of elementValues(model.elements)) {
    if ("start" in el && "end" in el && typeof el.start === "object") {
      for (const p of [el.start, el.end] as Array<{ x: number; y: number }>) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    }
  }
  const floors = opts.floors;
  const perFloor = Math.ceil(count / floors / 5);
  const side = Math.ceil(Math.sqrt(perFloor));
  const dx = (x1 - x0) / side;
  const dy = (y1 - y0) / side;
  const storeys = Array.from({ length: floors }, (_, f) => ({ name: `LEVEL ${f + 1}`, elevationMm: f * 14 * FT }));
  const elements: LinkedElement[] = [];
  for (let f = 0; f < floors && elements.length < count; f++) {
    const z = f * 14 * FT;
    for (let i = 0; i < side && elements.length < count; i++) {
      for (let j = 0; j < side && elements.length < count; j++) {
        const ax = x0 + i * dx;
        const ay = y0 + j * dy;
        const g = `${f}-${i}-${j}`;
        elements.push(
          { globalId: `w-${g}`, name: "Basic Wall", ifcClass: "IFCWALL", kind: "wall", storey: storeys[f]?.name ?? null, box: [ax, ay, z, ax + 150, ay + dy, z + 12 * FT] },
          { globalId: `s-${g}`, name: "Floor", ifcClass: "IFCSLAB", kind: "slab", storey: storeys[f]?.name ?? null, box: [ax, ay, z - 300, ax + dx, ay + dy, z] },
          { globalId: `b-${g}`, name: "W12x26", ifcClass: "IFCBEAM", kind: "beam", storey: storeys[f]?.name ?? null, box: [ax, ay + dy / 2 - 75, z + 13 * FT, ax + dx, ay + dy / 2 + 75, z + 14 * FT - 300] },
          { globalId: `c-${g}`, name: "Column", ifcClass: "IFCCOLUMN", kind: "column", storey: storeys[f]?.name ?? null, box: [ax, ay, z, ax + 300, ay + 300, z + 14 * FT] },
          { globalId: `sp-${g}`, name: `Room ${g}`, ifcClass: "IFCSPACE", kind: "space", storey: storeys[f]?.name ?? null, box: [ax, ay, z, ax + dx, ay + dy, z + 12 * FT] },
        );
      }
    }
  }
  return { modelId: "linked-perf", label: "Architecture", discipline: "architecture", storeys, elements };
}

function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? 0;
}

const ids = (fs: ReadonlyArray<{ id: string }>) => fs.map((f) => f.id).sort().join("\n");

function main(): void {
  const base = createFullBimModel(opts);
  let model: ModelState = { ...base, elements: freezeElements({ ...base.elements }) };
  const linked = [syntheticLinked(model, LINKED_ELEMENTS)];
  const totalElements = Object.keys(model.elements).length;
  gc();

  const cold: number[] = [];
  for (let i = 0; i < COLD_SAMPLES; i++) {
    const fresh = new LintEngine();
    cold.push(timeSync(() => fresh.build(model, linked)).ms);
  }
  gc();
  const heapBefore = memoryMB().heap;
  const engine = new LintEngine();
  engine.build(model, linked);
  const heapAfter = memoryMB().heap;

  const config = DEFAULT_LINT_CONFIG;
  const radius = config.scope_radius_ft * FT;
  const equipment = elementValues(model.elements).filter((e) => e.kind === "equipment").map((e) => e.id);
  const advance: number[] = [];
  const block: number[] = [];
  let mismatches = 0;
  let oversize = 0;
  let tooWide = 0;
  let worstChanged = 0;
  const warmup: number[] = [];
  for (let i = -WARMUP_EDITS; i < samplesPerRun; i++) {
    const timed = i >= 0;
    // Warm-up edits move equipment the timed edits don't reach first (slots after the last timed one).
    const slot = timed ? i : samplesPerRun - i;
    if (i === 0) gc();
    const target = equipment[(slot * 7919) % equipment.length];
    if (!target) throw new Error("[perf/lint] the model has no equipment to move");
    const edited = executeCommand(model, { type: "move_equipment", equipmentId: target, delta: { x: (i % 2 === 0 ? 1 : -1) * FT, y: 0 } });
    if (!edited.ok) throw new Error(`[perf/lint] edit refused: ${edited.error.message}`);
    const changed = [...edited.changedIds, ...edited.removedIds].map(String);
    if (timed) {
      worstChanged = Math.max(worstChanged, changed.length);
      if (changed.length > MAX_CHANGED) tooWide += 1;
    }
    const before = model;
    const after = edited.model;
    const t = timeSync(() => {
      const scope = { ...engine.scopeFor(changed, engine.boxesIn(before, changed), engine.boxesIn(after, changed), radius), pairsFrom: changed };
      const was = engine.run(scope, { config });
      engine.advance(after, changed);
      const now = engine.run(scope, { config, previous: before, editedByAgent: true });
      return { scope, was, now };
    });
    if (!timed) {
      warmup.push(t.ms);
      model = after;
      continue;
    }
    advance.push(t.ms);
    const b = timeSync((): LintBlock => {
      const had = new Set(t.value.was.map((f) => f.id));
      const has = new Set(t.value.now.map((f) => f.id));
      const near = engine.near(changed, radius, 6);
      return capBlock({
        status: "ok",
        ruleset: config.ruleset,
        rev: after.revision,
        ms: 0,
        new: t.value.now.filter((f) => !had.has(f.id)).slice(0, config.max_findings).map((f) => ({ rule: f.rule, sev: f.severity, ids: f.elementIds, msg: f.message })),
        resolved: t.value.was.filter((f) => !has.has(f.id)).map((f) => f.id),
        near: { level: near.level, room: near.room, host: near.host, radius_ft: config.scope_radius_ft, within: near.within.map((w) => `${w.name} (${w.distanceFt} ft ${w.direction})`) },
        open_errors: t.value.now.filter((f) => f.severity === "error").length,
        truncated: false,
      });
    });
    block.push(b.ms);
    if (new TextEncoder().encode(JSON.stringify(b.value)).length > LINT_BLOCK_MAX_BYTES) oversize += 1;
    if (i % 7 === 0) {
      const fresh = new LintEngine();
      fresh.build(after, linked);
      if (ids(fresh.run(t.value.scope, { config, previous: before, editedByAgent: true })) !== ids(t.value.now)) mismatches += 1;
      // The check's whole second engine (350k elements) is garbage now: collect it here, untimed, or its collection
      // lands inside a timed edit a few samples later (laptop: samples 4, 12 and 19 at 9-11 ms against a 2.5 ms median).
      gc();
    }
    model = after;
  }

  const samples: Sample[] = [
    { metric: "lint.index.cold", values: cold, counts: { networkElements: totalElements + LINKED_ELEMENTS }, note: `${totalElements} native + ${LINKED_ELEMENTS} linked elements` },
    { metric: "lint.advance.50", values: advance, counts: { networkElements: worstChanged }, note: `p99 ${percentile(advance, 99).toFixed(2)} ms (budget 25); edits touched at most ${worstChanged} elements` },
    { metric: "lint.block.build", values: block, note: "diff, what's here, caps, serialise" },
    { metric: "lint.memory.index", values: [Math.max(0, heapAfter - heapBefore)], note: "heap held by one engine (native + linked index)" },
  ];
  emit({
    suite: "lint",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { tier, nativeElements: totalElements, linkedElements: LINKED_ELEMENTS, samplesPerRun, edit: "move one piece of equipment 1 ft" },
    samples,
    invariants: { "lint.advanceMismatches": mismatches, "lint.blocksOver2KB": oversize, "lint.editsOver50": tooWide },
    info: { memory: memoryMB(), advanceP99: percentile(advance, 99), advanceWarmupMs: warmup.map((ms) => Number(ms.toFixed(2))) },
  });
}

try {
  main();
} catch (err) {
  console.error("[perf/lint] failed", err);
  process.exit(1);
}
