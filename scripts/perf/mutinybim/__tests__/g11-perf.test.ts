/**
 * @jest-environment node
 *
 * Round 11 lane G11 perf rows, through the run lock (G11_PERF=1):
 *
 *   requirements.applies_at.one_edit  before: the g7 study alone; after: the same study plus a
 *                                     stage-tied and an anchor-tied rule. Same edit, same read.
 *   gate.freeze / gate.compare.two_gates
 *   basis.read_map.schedule           before: today's "where it came from" column; after: the
 *                                     confidence column through `readBasis`, every row.
 *
 * G11_PERF_ROWS=544 is about 250k elements, 2176 about 1M (NODE_OPTIONS=--max-old-space-size=12288).
 * Prints `[g11 <row>] …`; the budgets are the perf gate's, set from these numbers (never raised).
 */
import { bindRequirementsSnapshot, requirementsAt, requirementsOf, type ModelState } from "@permitzip/bim-kernel";
import { bindModelPacks, PackSet } from "@permitzip/bim-kernel/packs";
import { run, STUDY, ZT_PACK } from "../../../../packages/bim-kernel/__tests__/g7-fixtures";
import { appliesAtRules, roomGrid, timedCompare, timedFreeze } from "../gates";
import { basisColumn, plainSourceColumn } from "../basis";
import { p50p95 } from "../synthetic-250k";

const go = process.env.G11_PERF === "1" ? describe : describe.skip;
const ROWS = Number(process.env.G11_PERF_ROWS ?? 50);
const EDITS = 9;

function oneEdits(m0: ModelState): { p50: number; p95: number } {
  requirementsOf(m0);
  const samples: number[] = [];
  let m = m0;
  for (let i = 0; i < EDITS; i++) {
    const room = `R${(10 + i) % ROWS}-${(11 + i * 3) % 80}`;
    m = run(m, { type: "edit_space", spaceId: room, occupants: 60 + i });
    const t = performance.now();
    requirementsAt(m, { kind: "space", id: room });
    samples.push(performance.now() - t);
  }
  return p50p95(samples);
}

go("g11 perf", () => {
  it("requirements.applies_at.one_edit: no rise over the graph's own row", () => {
    const before = roomGrid("g11-perf-before", ROWS);
    bindModelPacks(before.modelId, PackSet.create([ZT_PACK]));
    bindRequirementsSnapshot(before.modelId, STUDY);
    const b = oneEdits(before);
    const after = roomGrid("g11-perf-after", ROWS);
    bindModelPacks(after.modelId, PackSet.create([ZT_PACK]));
    bindRequirementsSnapshot(after.modelId, { ...STUDY, revision: "r-applies-at", rules: [...STUDY.rules, ...appliesAtRules(STUDY.source.id)] });
    const a = oneEdits(after);
    const n = Object.keys(after.elements).length;
    process.stderr.write(`[g11 requirements.applies_at.one_edit] ${n} elements; before p50 ${b.p50} / p95 ${b.p95} ms; after p50 ${a.p50} / p95 ${a.p95} ms\n`);
    expect(a.p50).toBeLessThan(200);
  });

  it("gate.freeze and gate.compare.two_gates, off the edit path", () => {
    const m0 = roomGrid("g11-perf-gate", ROWS);
    const freezes: number[] = [];
    const first = timedFreeze(m0, "due_diligence");
    for (let i = 0; i < 3; i++) freezes.push(timedFreeze(m0, "due_diligence").ms);
    const totalsOnly: number[] = [];
    for (let i = 0; i < 3; i++) totalsOnly.push(timedFreeze(m0, "due_diligence", first.body.stateDigest).ms);
    const template = m0.elements["WV-R0-0"];
    if (!template) throw new Error("[g11 perf] the grid has no wall WV-R0-0");
    const m1: ModelState = { ...m0, elements: { ...m0.elements, "WX-1": { ...template, id: "WX-1" } as ModelState["elements"][string] } };
    const second = timedFreeze(m1, "feasibility");
    const compares: number[] = [];
    for (let i = 0; i < 9; i++) compares.push(timedCompare(first.body, second.body).ms);
    const f = p50p95(freezes);
    const fc = p50p95(totalsOnly);
    const c = p50p95(compares);
    process.stderr.write(`[g11 gate.freeze] ${Object.keys(m0.elements).length} elements, ${first.lines} lines; first freeze (every record hashed) ${first.ms.toFixed(0)} ms; again on the same records p50 ${f.p50} / p95 ${f.p95} ms; with a host checkpoint digest p50 ${fc.p50} / p95 ${fc.p95} ms; next revision (one record added) ${second.ms.toFixed(0)} ms\n[g11 gate.compare.two_gates] p50 ${c.p50} / p95 ${c.p95} ms (${timedCompare(first.body, second.body).changed} lines changed)\n`);
    expect(timedCompare(first.body, second.body).changed).toBeGreaterThan(0);
  });

  it("basis.read_map.schedule: one confidence column over every row", () => {
    const m = roomGrid("g11-perf-basis", ROWS);
    const plain: number[] = [];
    const basis: number[] = [];
    let rows = 0;
    let recorded = 0;
    for (let i = 0; i < 7; i++) {
      plain.push(plainSourceColumn(m).ms);
      const r = basisColumn(m);
      basis.push(r.ms);
      rows = r.rows;
      recorded = r.recorded;
    }
    const p = p50p95(plain);
    const q = p50p95(basis);
    process.stderr.write(`[g11 basis.read_map.schedule] ${rows} rows (${recorded} with a basis or an old ladder); before (provenance.source column) p50 ${p.p50} / p95 ${p.p95} ms; after (readBasis) p50 ${q.p50} / p95 ${q.p95} ms\n`);
    expect(recorded).toBeGreaterThan(0);
  });
});
