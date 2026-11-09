/**
 * Round 11 lane G11 perf rows:
 *
 *   requirements.applies_at.one_edit  the graph's one-edit row with a stage-tied rule and an
 *                                     anchor-tied rule bound (no rise over the graph's own row)
 *   gate.freeze                       one freeze of the whole revision (state digest and totals
 *                                     by basis), off the edit path
 *   gate.compare.two_gates            estimate versus actual between two gates
 *
 * The model is round 7 lane G's room grid (`g7-perf.test.ts`): 80 rooms a row, each with its
 * occupancy and hazard determinations and walls between, a ceiling and two heads in every
 * fourth room. `rows` 544 is about 250k elements, 2176 about 1M. Synthetic, no client data.
 */
import { DEFAULT_SETTINGS, type BimElement, type ModelState, type RuleRecord } from "@permitzip/bim-kernel";
import { compareGates, freezeGate } from "../../../packages/bim-kernel/src/lifecycle/freeze";
import type { GateBody } from "../../../packages/bim-kernel/src/lifecycle/records";

const COLS = 80;
const SIZE = 4000;
const FT = 304.8;

const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const partition = { level: "Level 1", zone: "Z1", discipline: "architecture" as const };

function det(id: string, subject: string, key: string, value: string): BimElement {
  return { id, kind: "determination", version: 1, authoredRev: {}, determination: { subject: { kind: "space", id: subject }, key, value, inputs: [], reasoning: "Synthetic.", decidedBy: "Test", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high", status: "recorded" } } as unknown as BimElement;
}

/** The g7 room grid at `rows` rows; every 10th wall records a measured basis so the totals split. */
export function roomGrid(modelId: string, rows: number): ModelState {
  const els: BimElement[] = [{ id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const id = `R${r}-${c}`;
      const storage = (r * COLS + c) % 4 === 0;
      const x0 = c * SIZE;
      const y0 = r * SIZE;
      const basis = (r * COLS + c) % 10 === 0 ? { provenance: { basis: { maturity: "measured" } } } : {};
      els.push({ version: 1, authoredRev: {}, id, kind: "space", name: storage ? "Room" : "Office", number: `${r}${String(c).padStart(2, "0")}`, levelId: "L1", bounds: { kind: "outline", outline: rect(x0, y0, x0 + SIZE, y0 + SIZE) }, origin: { kind: "drawn" }, use: { libraryId: "test", useId: storage ? "storage" : "office" }, occupants: 4 } as unknown as BimElement);
      els.push(det(`DO-${id}`, id, "occupancy", storage ? "S-1" : "B"), det(`DH-${id}`, id, "hazard", storage ? "ordinary_1" : "light"));
      if (c < COLS - 1) els.push({ version: 1, authoredRev: {}, partition, id: `WV-${id}`, kind: "wall", start: { x: x0 + SIZE, y: y0 }, end: { x: x0 + SIZE, y: y0 + SIZE }, thickness: 150, height: 3000, wallType: "Partition", ...basis } as unknown as BimElement);
      if (r < rows - 1) els.push({ version: 1, authoredRev: {}, partition, id: `WH-${id}`, kind: "wall", start: { x: x0, y: y0 + SIZE }, end: { x: x0 + SIZE, y: y0 + SIZE }, thickness: 150, height: 3000, wallType: "Partition" } as unknown as BimElement);
      if (storage) {
        els.push({ version: 1, authoredRev: {}, partition, id: `C-${id}`, kind: "ceiling", levelId: "L1", spaceId: id, outline: rect(x0, y0, x0 + SIZE, y0 + SIZE), form: "flat", heightMm: 10 * FT } as unknown as BimElement);
        for (const k of [1, 3]) els.push({ version: 1, authoredRev: {}, id: `H${k}-${id}`, kind: "part", typeId: "pt-head", levelId: "L1", position: { x: x0 + k * 1000, y: y0 + k * 1000 }, offsetMm: 2700, rotationDeg: 0, mark: `H${k}`, values: {}, classId: "zt.head" } as unknown as BimElement);
      }
    }
  }
  return { modelId, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

/** Two rules tied by `appliesAt`: one to a stage, one to two named rooms. Bound beside the g7 study for the applies_at row. */
export function appliesAtRules(provider: string): RuleRecord[] {
  const base = { provider, citation: { instrument: "Test Building Code", edition: "2024", section: "T-9" }, summary: "Synthetic.", discipline: "architecture", applies: { spaceUses: ["office", "storage"] }, verification: { status: "verified", by: "Test author" } } as const;
  return [
    { ...base, ruleId: "dd-occ-check", title: "Occupant load checked in design development", reads: ["space.area"], parameters: { per: { value: 100, unit: "ft2/occ" } }, appliesAt: { stages: ["due_diligence", "design_development"] }, produces: [{ key: "arch.dd_check", anchor: "space", value: "ceil({space.area} / {param.per}, 1 occ)", unit: "occ", compare: "at_least" }] },
    { ...base, ruleId: "two-rooms", title: "Two named rooms keep a clear width", reads: [], parameters: { width: { value: 36, unit: "in" } }, appliesAt: { anchors: [{ kind: "space", id: "R0-0" }, { kind: "space", id: "R1-1" }] }, produces: [{ key: "arch.clear_width", anchor: "space", value: "{param.width}", unit: "in", compare: "at_least" }] },
  ];
}

const KS = { provider: "unsigned", subject: "perf", kind: "person" as const, displayName: "Perf" };

/** One freeze of the revision, timed; the body for comparisons. With `checkpointDigest` (a host's checkpoint of this revision) the state digest isn't recomputed. */
export function timedFreeze(model: ModelState, stageId: string, checkpointDigest?: string): { readonly ms: number; readonly body: GateBody; readonly lines: number } {
  const t = performance.now();
  const out = freezeGate(model, { stageId, frozenBy: KS, frozenAt: "2026-11-02T15:00:00Z", ...(checkpointDigest ? { stateDigest: checkpointDigest } : {}) });
  const ms = performance.now() - t;
  if (!out.ok) throw new Error(`[perf/gates] freeze refused: ${out.message}`);
  return { ms, body: out.body, lines: out.body.totals.quantities.lines.length };
}

/** Estimate versus actual between two gates, timed (quantities only; pricing is the reader's). */
export function timedCompare(a: GateBody, b: GateBody): { readonly ms: number; readonly changed: number } {
  const t = performance.now();
  const cmp = compareGates(a, b);
  return { ms: performance.now() - t, changed: cmp.lines.length };
}
