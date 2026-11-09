/**
 * One run of the plumbing load-point workload, in one process: the tier's
 * full-building model with a synthetic cold water system laid on it (50 trunk
 * pieces in a line, 100 branches each, a 2 WSFU load point on every branch:
 * 5,000 points), plumbing wave 1 (load-points/).
 *
 * - plumbing.load_points.cold.5k: a fresh network engine builds the system's
 *   totals (walk, own loads, totals) and reads the service.
 * - plumbing.load_points.advance.5k: after one load point's units change
 *   (committed through executeCommand, outside the timing), the engine is
 *   told what changed (`advance`) and the service is read again. Only the
 *   point's path to the service moves.
 * - plumbing.load_points.edit_commit.5k: the edit itself through
 *   executeCommand on the full head (derivation of the system's pipe flows
 *   and the edit's validation included), as Properties and the agent tool
 *   send it.
 *
 * Invariants: fresh-vs-incremental mismatches (must be 0) and engine-vs-pipe
 * flow mismatches at the service (must be 0).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/plumbing.ts --tier=250k --samples=21
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts.
 */
import { asElementId, executeCommand, freezeElements, type ModelState, recomputeDerived, syntheticPlumbing, elementValues, type Level } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { PlumbingNetworkEngine } from "@permitzip/bim-pack-plumbing";
import { emit, gc, memoryMB, timeSync, type Sample } from "./lib";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const TRUNKS = 50;
const BRANCHES = 100;
const COLD_SAMPLES = 3;

function main(): void {
  const base = createFullBimModel(opts);
  // The tier's network model has no levels; routed runs need one.
  const existing = elementValues(base.elements).find((e) => e.kind === "level");
  const level: Level = existing?.kind === "level" ? existing : { id: asElementId("synp-level"), kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  const syn = syntheticPlumbing({ levelId: level.id, trunks: TRUNKS, branchesPerTrunk: BRANCHES });
  const laid: ModelState = { ...base, elements: freezeElements({ ...base.elements, [level.id]: level, ...syn.elements }) };
  let model = recomputeDerived(laid).model;
  const totalElements = Object.keys(model.elements).length;
  const outfall = syn.trunkIds[0];
  if (!outfall) throw new Error("[perf/plumbing] no trunk");
  gc();

  const cold: number[] = [];
  for (let i = 0; i < COLD_SAMPLES; i++) {
    const t = timeSync(() => new PlumbingNetworkEngine().carries(model, outfall)?.value ?? -1);
    cold.push(t.ms);
    if (t.value !== BRANCHES * TRUNKS * 2) throw new Error(`[perf/plumbing] the service carries ${t.value} DFU, expected ${BRANCHES * TRUNKS * 2}`);
  }

  const engine = new PlumbingNetworkEngine();
  engine.carries(model, outfall);
  const advance: number[] = [];
  const commit: number[] = [];
  let mismatches = 0;
  let flowMismatches = 0;
  let deltas = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const lpId = syn.loadPointIds[(i * 977) % syn.loadPointIds.length];
    if (!lpId) throw new Error("[perf/plumbing] no load point");
    const c = timeSync(() => executeCommand(model, { type: "edit_load_point", loadPointId: lpId, values: { wsfu_cold: 3 + i } }));
    const edited = c.value;
    if (!edited.ok) throw new Error(`[perf/plumbing] edit refused: ${edited.error.message}`);
    commit.push(c.ms);
    model = edited.model;
    const head = model;
    const before = engine.stats.deltas;
    const t = timeSync(() => {
      engine.advance(head, edited.changedIds);
      return engine.carries(head, outfall)?.value ?? -1;
    });
    advance.push(t.ms);
    deltas += engine.stats.deltas - before;
    if (new PlumbingNetworkEngine().carries(head, outfall)?.value !== t.value) mismatches += 1;
    const seg = head.elements[outfall];
    if (seg?.kind !== "run_segment" || seg.flow !== t.value) flowMismatches += 1;
  }
  if (deltas === 0) throw new Error("[perf/plumbing] advance never took the one-point path");

  const counts = { totalElements, networkElements: syn.loadPointIds.length };
  const samples: Sample[] = [
    { metric: "plumbing.load_points.cold.5k", values: cold, counts, note: `A fresh engine walks the ${syn.loadPointIds.length}-point cold water system and reads the service` },
    { metric: "plumbing.load_points.advance.5k", values: advance, counts, note: "advance after one load point's units change, then the service read: the point's path to the service only" },
    { metric: "plumbing.load_points.edit_commit.5k", values: commit, counts, note: "edit_load_point through executeCommand on the full head (pipe flows re-derived for the system, the edit validated)" },
  ];
  emit({
    suite: "plumbing",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { tier, loadPoints: syn.loadPointIds.length, trunks: TRUNKS, branchesPerTrunk: BRANCHES, samplesPerRun },
    samples,
    invariants: { "plumbing.incrementalMismatches": mismatches, "plumbing.flowMismatches": flowMismatches },
    info: { memory: memoryMB() },
  });
}

try {
  main();
} catch (err) {
  console.error("[perf/plumbing] failed", err);
  process.exit(1);
}
