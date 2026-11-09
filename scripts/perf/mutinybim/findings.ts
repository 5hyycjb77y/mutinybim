/**
 * The finding ledger (round 11 lane F11, D2), in one process, on the tier's
 * full-building model plus a synthetic linked architecture model of 100k
 * elements (the same workload as `lint.ts`).
 *
 * - lint.advance.50 (reference, re-measured here on the same edits): one
 *   committed edit touching at most 50 elements; the lint engine advances and
 *   finds the before and after findings in the edit's scope.
 * - findings.ledger.one_edit: the same lint work plus the ledger moving by
 *   the changed ids (lint's change handed in, every kernel source asked what
 *   the edit moved). Budget: ≤ lint.advance.50 + 10 %.
 * - findings.ledger.apply: the ledger's own part of that (the difference).
 * - findings.ledger.open: the first read of the list on an opened model
 *   (every kernel source in full, and lint's full check as the lint feed).
 *
 * Invariants: ledger findings after the edits that differ from a fresh
 * ledger's on the same revision (must be 0).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/findings.ts --tier=250k --samples=21
 *
 * Prints one `@@perf-result` JSON line.
 */
import { elementValues, executeCommand, freezeElements, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { DEFAULT_LINT_CONFIG, LintEngine, type Finding, type LinkedElement, type LinkedModelIndex } from "@permitzip/bim-lint";
import { FindingLedger, lintFindingChange, lintFindingSource } from "../../../packages/bim-kernel/src/findings/api";
import { emit, gc, memoryMB, percentile, timeSync, type Sample } from "./lib";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const LINKED_ELEMENTS = 100_000;
const FT = 304.8;

/** The same linked architecture model `lint.ts` lays over the host's footprint. */
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
  const side = Math.ceil(Math.sqrt(Math.ceil(count / floors / 5)));
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
        const storey = storeys[f]?.name ?? null;
        elements.push(
          { globalId: `w-${g}`, name: "Basic Wall", ifcClass: "IFCWALL", kind: "wall", storey, box: [ax, ay, z, ax + 150, ay + dy, z + 12 * FT] },
          { globalId: `s-${g}`, name: "Floor", ifcClass: "IFCSLAB", kind: "slab", storey, box: [ax, ay, z - 300, ax + dx, ay + dy, z] },
          { globalId: `b-${g}`, name: "W12x26", ifcClass: "IFCBEAM", kind: "beam", storey, box: [ax, ay + dy / 2 - 75, z + 13 * FT, ax + dx, ay + dy / 2 + 75, z + 14 * FT - 300] },
          { globalId: `c-${g}`, name: "Column", ifcClass: "IFCCOLUMN", kind: "column", storey, box: [ax, ay, z, ax + 300, ay + 300, z + 14 * FT] },
          { globalId: `sp-${g}`, name: `Room ${g}`, ifcClass: "IFCSPACE", kind: "space", storey, box: [ax, ay, z, ax + dx, ay + dy, z + 12 * FT] },
        );
      }
    }
  }
  return { modelId: "linked-perf", label: "Architecture", discipline: "architecture", storeys, elements };
}

const ids = (l: FindingLedger) => l.findings().map((f) => f.id).join("\n");

function main(): void {
  const base = createFullBimModel(opts);
  let model: ModelState = { ...base, elements: freezeElements({ ...base.elements }) };
  const linked = [syntheticLinked(model, LINKED_ELEMENTS)];
  const totalElements = Object.keys(model.elements).length;
  const config = DEFAULT_LINT_CONFIG;
  const radius = config.scope_radius_ft * FT;
  const engine = new LintEngine();
  engine.build(model, linked);
  const ref = new LintEngine();
  ref.build(model, linked);
  gc();

  const fullCheck = (m: ModelState): Finding[] => {
    const e = new LintEngine();
    e.build(m, linked);
    return e.check({ config });
  };
  const ledger = new FindingLedger({ feeds: [lintFindingSource(fullCheck)] });
  const open = timeSync(() => ledger.open(model));
  const openKernel = timeSync(() => new FindingLedger().open(model));
  const openCount = ledger.stats().findings;
  gc();

  const equipment = elementValues(model.elements).filter((e) => e.kind === "equipment").map((e) => e.id);
  const lintOnly: number[] = [];
  const withLedger: number[] = [];
  const ledgerPart: number[] = [];
  let worstChanged = 0;
  const bySource = new Map<string, number[]>();
  for (let i = 0; i < samplesPerRun; i++) {
    const target = equipment[(i * 7919) % equipment.length];
    if (!target) throw new Error("[perf/findings] the model has no equipment to move");
    const edited = executeCommand(model, { type: "move_equipment", equipmentId: target, delta: { x: (i % 2 === 0 ? 1 : -1) * FT, y: 0 } });
    if (!edited.ok) throw new Error(`[perf/findings] edit refused: ${edited.error.message}`);
    const changed = [...edited.changedIds, ...edited.removedIds].map(String);
    worstChanged = Math.max(worstChanged, changed.length);
    const before = model;
    const after = edited.model;

    // The reference row on a second engine advanced in lockstep, so both rows time the same lint work at the same warmth.
    const lintT = timeSync(() => {
      const scope = { ...ref.scopeFor(changed, ref.boxesIn(before, changed), ref.boxesIn(after, changed), radius), pairsFrom: changed };
      const was = ref.run(scope, { config });
      ref.advance(after, changed);
      return ref.run(scope, { config, previous: before, editedByAgent: true }).length + was.length;
    });
    lintOnly.push(lintT.ms);

    let applyMs = 0;
    const t = timeSync(() => {
      const scope = { ...engine.scopeFor(changed, engine.boxesIn(before, changed), engine.boxesIn(after, changed), radius), pairsFrom: changed };
      const was = engine.run(scope, { config });
      engine.advance(after, changed);
      const now = engine.run(scope, { config, previous: before, editedByAgent: true });
      const a = performance.now();
      ledger.apply(after, changed, new Map([["lint_rule", lintFindingChange(was, now, after, "main")]]));
      applyMs = performance.now() - a;
    });
    withLedger.push(t.ms);
    ledgerPart.push(applyMs);
    let inSources = 0;
    for (const [id, ms] of Object.entries(ledger.stats().sourceMs)) {
      bySource.set(id, [...(bySource.get(id) ?? []), ms]);
      inSources += ms;
    }
    bySource.set("(ledger itself)", [...(bySource.get("(ledger itself)") ?? []), applyMs - inSources]);
    model = after;
  }
  const fresh = new FindingLedger({ feeds: [lintFindingSource(fullCheck)] });
  fresh.open(model);
  const mismatches = ids(fresh) === ids(ledger) ? 0 : 1;

  const samples: Sample[] = [
    { metric: "lint.advance.50", values: lintOnly, counts: { networkElements: worstChanged }, note: "reference: the same edits, lint only" },
    { metric: "findings.ledger.one_edit", values: withLedger, counts: { networkElements: worstChanged }, note: "lint's one-edit work plus the ledger moving by the changed ids" },
    { metric: "findings.ledger.apply", values: ledgerPart, note: "the ledger's own part of the one-edit row" },
    { metric: "findings.ledger.open", values: [open.ms], counts: { networkElements: openCount }, note: `first read on an opened model, lint's full check included; kernel sources alone ${openKernel.ms.toFixed(1)} ms` },
  ];
  emit({
    suite: "findings",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { tier, nativeElements: totalElements, linkedElements: LINKED_ELEMENTS, samplesPerRun, edit: "move one piece of equipment 1 ft" },
    samples,
    invariants: { "findings.ledgerMismatches": mismatches },
    info: { memory: memoryMB(), openFindings: openCount, openKernelMs: openKernel.ms, applyP50BySource: Object.fromEntries([...bySource].map(([id, v]) => [id, Number((percentile(v, 0.5) ?? 0).toFixed(3))])), firstApplyBySource: Object.fromEntries([...bySource].map(([id, v]) => [id, Number((v[0] ?? 0).toFixed(3))])) },
  });
}

try {
  main();
} catch (err) {
  console.error("[perf/findings] failed", err);
  process.exit(1);
}
