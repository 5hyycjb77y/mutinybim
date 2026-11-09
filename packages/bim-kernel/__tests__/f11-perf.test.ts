/**
 * @jest-environment node
 *
 * Round 11 lane F11 perf (F11_PERF=1; F11_PERF_ROWS=544 is about 250k
 * elements, 2176 about 1M): the requirements graph's one-edit row and the
 * ledger moving by the same edit, on round 7's room grid (n8's): 80 rooms a
 * row, each with occupancy and hazard determinations, walls between, and a
 * ceiling and two heads in every fourth room (the ceiling at 8 ft on even
 * rows, so their head count isn't met: real findings). Each edit changes one storage
 * room's hazard. Logged: the graph re-deriving that room (`requirementsAt`,
 * what the Checklist pays) and the ledger's `apply` on the same revision
 * (which reads the same anchors, so the graph's work is shared, not
 * repeated), and the ledger's first open. The lint rows are
 * `scripts/perf/mutinybim/findings.ts`. Ceilings here only catch a
 * full-model pass; the budgets are the perf gate's.
 */
import { bindRequirementsSnapshot, DEFAULT_SETTINGS, executeCommand, requirementsAt, unbindRequirementsSnapshot, type BimElement, type ModelState } from "../src";
import { FindingLedger } from "../src/findings/api";
import { bindModelPacks, PackSet } from "../src/packs";
import { FT, STUDY, writes, ZT_PACK } from "./g7-fixtures";

const ID = "f11-perf";
const COLS = 80;
const ROWS = Number(process.env.F11_PERF_ROWS ?? 50);
const SIZE = 4000;
const EDITS = 21;
const maybe = process.env.F11_PERF === "1" ? describe : describe.skip;
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";

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
        els.push({ version: 1, authoredRev: {}, partition, id: `C-${id}`, kind: "ceiling", levelId: "L1", spaceId: id, outline: rect(x0, y0, x0 + SIZE, y0 + SIZE), form: "flat", heightMm: (r % 2 === 0 ? 8 : 10) * FT } as unknown as BimElement);
        for (const k of [1, 3]) els.push({ version: 1, authoredRev: {}, id: `H${k}-${id}`, kind: "part", typeId: "pt-head", levelId: "L1", position: { x: x0 + k * 1000, y: y0 + k * 1000 }, offsetMm: 2700, rotationDeg: 0, mark: `H${k}`, values: {}, classId: "zt.head" } as unknown as BimElement);
      }
    }
  }
  return { modelId: ID, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

const pct = (s: readonly number[], p: number) => [...s].sort((a, b) => a - b)[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))] ?? 0;

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindRequirementsSnapshot(ID, STUDY);
});
afterAll(() => unbindRequirementsSnapshot(ID));

maybe("f11-perf", () => {
  it("the ledger after one edit reads only the anchors the edit reached, sharing the graph's work", () => {
    let m = grid();
    const elementCount = Object.keys(m.elements).length;
    const ledger = new FindingLedger();
    let t = performance.now();
    ledger.open(m);
    const open = performance.now() - t;
    const graph: number[] = [];
    const apply: number[] = [];
    for (let i = 0; i < EDITS; i++) {
      // A different storage room each time (column a multiple of four); its hazard flips, so its hazard class and head count re-derive.
      const room = `R${(i * 7) % ROWS}-${(i * 8) % COLS}`;
      const value = i % 2 === 0 ? "light" : "ordinary_1";
      const r = writes(() => executeCommand(m, { type: "supersede_determination", determinationId: `DH-${room}`, newDeterminationId: `DH-${room}-${i}`, value, ...decided }));
      if (!r.ok) throw new Error(r.error.message);
      m = { ...r.model, revision: (m.revision + 1) as ModelState["revision"] };
      const changed = [...r.changedIds, ...r.removedIds].map(String);
      t = performance.now();
      requirementsAt(m, { kind: "space", id: room });
      graph.push(performance.now() - t);
      t = performance.now();
      ledger.apply(m, changed);
      apply.push(performance.now() - t);
    }
    const fresh = new FindingLedger();
    fresh.open(m);
    expect(ledger.findings().map((f) => f.id)).toEqual(fresh.findings().map((f) => f.id));
    process.stderr.write(
      `[f11 perf] ${elementCount} elements, ${ledger.stats().findings} findings; open ${open.toFixed(0)} ms; ` +
        `graph one edit p50 ${pct(graph, 0.5).toFixed(2)} / p95 ${pct(graph, 0.95).toFixed(2)} ms; ledger apply p50 ${pct(apply, 0.5).toFixed(2)} / p95 ${pct(apply, 0.95).toFixed(2)} ms\n`,
    );
    if (ABSOLUTE_BUDGETS) expect(pct(apply, 0.5)).toBeLessThan(200);
  });
});
