/**
 * @jest-environment node
 *
 * Round 8b lane N perf row `requirements.graph.sensitivity` (in-process,
 * warm; README budget 10 / 20 ms at 250k, 40 / 80 ms at 1M): the Checklist
 * header's "What drives the most" after one edit, on a revision whose
 * requirements the Checklist has already derived. Also logged: the first
 * ranking on a cold graph state (paid once per state, beside the cold
 * derivation), a repeat on the same revision, and one input's answer.
 *
 * The room grid is round 7 lane G's (g7-perf.test.ts): 80 rooms a row, each
 * with its occupancy and hazard determinations, walls between, and a ceiling
 * and two heads in every fourth room. N8_PERF_ROWS=544 builds about 250k
 * elements, N8_PERF_ROWS=2176 about 1M; the default keeps the jest run light.
 * The expectations only catch a full-model pass on the hot path and assert
 * the incremental count; the budget is the perf gate's.
 */
import { bindRequirementsSnapshot, DEFAULT_SETTINGS, requirementsOf, unbindRequirementsSnapshot, type BimElement, type ModelState } from "../src";
import { sensitivityOf, sensitivityRanking, sensitivityRecounted } from "../src/graph/sensitivity";
import { bindModelPacks, PackSet } from "../src/packs";
import { FT, run, STUDY, ZT_PACK } from "./g7-fixtures";

const ID = "n8-perf";
const COLS = 80;
const ROWS = Number(process.env.N8_PERF_ROWS ?? 50);
const SIZE = 4000;
const EDITS = 9;

const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const partition = { level: "Level 1", zone: "Z1", discipline: "architecture" as const };
const decided = { reasoning: "Synthetic.", decidedBy: "Test", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high" as const };

function det(id: string, subject: string, key: string, value: string): BimElement {
  return { id, kind: "determination", version: 1, authoredRev: {}, determination: { subject: { kind: "space", id: subject }, key, value, inputs: [], ...decided, status: "recorded" } } as unknown as BimElement;
}

function grid(): ModelState {
  const els: BimElement[] = [{ id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const id = `R${r}-${c}`;
      const storage = (r * COLS + c) % 4 === 0;
      const x0 = c * SIZE;
      const y0 = r * SIZE;
      els.push({ version: 1, authoredRev: {}, id, kind: "space", name: storage ? "Room" : "Office", number: `${r}${String(c).padStart(2, "0")}`, levelId: "L1", bounds: { kind: "outline", outline: rect(x0, y0, x0 + SIZE, y0 + SIZE) }, origin: { kind: "drawn" }, use: { libraryId: "test", useId: storage ? "storage" : "office" }, occupants: 4 } as unknown as BimElement);
      els.push(det(`DO-${id}`, id, "occupancy", storage ? "S-1" : "B"), det(`DH-${id}`, id, "hazard", storage ? "ordinary_1" : "light"));
      if (c < COLS - 1) els.push({ version: 1, authoredRev: {}, partition, id: `WV-${id}`, kind: "wall", start: { x: x0 + SIZE, y: y0 }, end: { x: x0 + SIZE, y: y0 + SIZE }, thickness: 150, height: 3000, wallType: "Partition" } as unknown as BimElement);
      if (r < ROWS - 1) els.push({ version: 1, authoredRev: {}, partition, id: `WH-${id}`, kind: "wall", start: { x: x0, y: y0 + SIZE }, end: { x: x0 + SIZE, y: y0 + SIZE }, thickness: 150, height: 3000, wallType: "Partition" } as unknown as BimElement);
      if (storage) {
        els.push({ version: 1, authoredRev: {}, partition, id: `C-${id}`, kind: "ceiling", levelId: "L1", spaceId: id, outline: rect(x0, y0, x0 + SIZE, y0 + SIZE), form: "flat", heightMm: 10 * FT } as unknown as BimElement);
        for (const k of [1, 3]) els.push({ version: 1, authoredRev: {}, id: `H${k}-${id}`, kind: "part", typeId: "pt-head", levelId: "L1", position: { x: x0 + k * 1000, y: y0 + k * 1000 }, offsetMm: 2700, rotationDeg: 0, mark: `H${k}`, values: {}, classId: "zt.head" } as unknown as BimElement);
      }
    }
  }
  return { modelId: ID, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

const pct = (s: readonly number[], p: number) => [...s].sort((a, b) => a - b)[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindRequirementsSnapshot(ID, STUDY);
});
afterAll(() => unbindRequirementsSnapshot(ID));

describe("n8 sensitivity perf", () => {
  it("after one edit the ranking re-counts only what the edit re-derived", () => {
    let m = grid();
    const elementCount = Object.keys(m.elements).length;
    let t = performance.now();
    const all = requirementsOf(m);
    const derive = performance.now() - t;
    t = performance.now();
    const first = sensitivityRanking(m);
    const cold = performance.now() - t;
    const anchors = sensitivityRecounted(m);
    expect(first.items.length).toBe(5);

    const edits: number[] = [];
    const recounts: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      // A different storage room each time (column a multiple of four): its hazard changes, so its hazard class and head spacing re-derive, nothing else.
      const room = `R${(i * 7) % ROWS}-${(i * 8) % COLS}`;
      m = run(m, { type: "supersede_determination", determinationId: `DH-${room}`, newDeterminationId: `DH-${room}-x`, value: "light", ...decided });
      requirementsOf(m);
      t = performance.now();
      sensitivityRanking(m);
      edits.push(performance.now() - t);
      recounts.push(sensitivityRecounted(m));
    }
    t = performance.now();
    sensitivityRanking(m);
    const repeat = performance.now() - t;
    const one: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      t = performance.now();
      sensitivityOf(m, `DH-R${i % ROWS}-${(i * 4) % COLS}`);
      one.push(performance.now() - t);
    }

    process.stderr.write(
      `[n8 sensitivity] ${elementCount} elements, ${all.length} requirements, ${anchors} anchors, ${first.inputs} driving inputs; derive ${derive.toFixed(0)} ms; ` +
        `first ranking (cold state) ${cold.toFixed(1)} ms; after one edit p50 ${pct(edits, 0.5).toFixed(2)} / p95 ${pct(edits, 0.95).toFixed(2)} ms (re-counted ${Math.max(...recounts)} anchors at most); ` +
        `repeat ${repeat.toFixed(3)} ms; one input p50 ${pct(one, 0.5).toFixed(3)} ms\n`,
    );
    for (const n of recounts) expect(n).toBeLessThanOrEqual(2);
    // Guards against a full-model pass only; the budgets are the perf gate's.
    expect(pct(edits, 0.5)).toBeLessThan(200);
    expect(repeat).toBeLessThan(5);
    expect(pct(one, 0.5)).toBeLessThan(50);
  });
});
