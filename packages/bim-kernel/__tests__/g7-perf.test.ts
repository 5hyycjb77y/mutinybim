/**
 * @jest-environment node
 *
 * Round 7 lane G perf rows (proposed budgets in an internal design note):
 *   requirements.graph.one_edit, requirements.graph.why,
 *   requirements.graph.depends_on.wall, requirements.graph.impact_preview.merge_3_rooms,
 *   requirements.snapshot.bind.2k_rules, plus the cold derivation for reference.
 *
 * Measured on a synthetic floor of 4,000 rooms (about 23,000 elements),
 * scaled down from the 250k target because this laptop's swap is nearly
 * full during the round; every hot path here is per-anchor or per-edit, so
 * none of them grows with the element count. The numbers are logged for the
 * perf gate; the expectations only catch a full-model pass on a hot path
 * (hundreds of ms) and count rule evaluations exactly.
 */
import { bindRequirementsSnapshot, DEFAULT_SETTINGS, dependsOn, graphStats, requirementsAt, requirementsOf, unbindRequirementsSnapshot, why, type BimElement, type ModelState, type RuleRecord } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { FT, run, STUDY, ZT_PACK } from "./g7-fixtures";

const ID = "g7-perf";
const COLS = 80;
// G7_PERF_ROWS=544 builds about 250k elements (the target size); the default keeps the jest run light.
const ROWS = Number(process.env.G7_PERF_ROWS ?? 50);
const SIZE = 4000;

const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const partition = { level: "Level 1", zone: "Z1", discipline: "architecture" as const };

function det(id: string, subject: string, key: string, value: string): BimElement {
  return { id, kind: "determination", version: 1, authoredRev: {}, determination: { subject: { kind: "space", id: subject }, key, value, inputs: [], reasoning: "Synthetic.", decidedBy: "Test", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high", status: "recorded" } } as unknown as BimElement;
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

function median(fn: () => unknown, n = 9): number {
  const s: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    s.push(performance.now() - t);
  }
  s.sort((a, b) => a - b);
  return s[Math.floor(n / 2)] ?? 0;
}

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindRequirementsSnapshot(ID, STUDY);
});
afterAll(() => unbindRequirementsSnapshot(ID));

describe("g7 requirements graph perf", () => {
  it("one edit, why, depends-on, impact preview and a 2k-rule bind stay per-anchor", () => {
    const m0 = grid();
    const elementCount = Object.keys(m0.elements).length;
    let t = performance.now();
    const all = requirementsOf(m0);
    const cold = performance.now() - t;
    const stats = graphStats(m0);
    expect(all.length).toBeGreaterThan(20_000);

    // One edit: Office R10-11 now holds 60 people; only its rules re-run.
    const m1 = run(m0, { type: "edit_space", spaceId: "R10-11", occupants: 60 });
    t = performance.now();
    const exits = requirementsAt(m1, { kind: "space", id: "R10-11" }).find((r) => r.key === "arch.exit_count");
    const oneEdit = performance.now() - t;
    expect(exits?.value).toBe(2);
    const reran = graphStats(m1).ruleRuns - stats.ruleRuns;
    expect(reran).toBeGreaterThan(0);
    expect(reran).toBeLessThanOrEqual(6);

    const whyMs = median(() => why(m1, { kind: "element", id: "H1-R10-12" }));
    expect(why(m1, { kind: "element", id: "H1-R10-12" }).items.length).toBeGreaterThan(0);
    const wallMs = median(() => dependsOn(m1, { kind: "element", id: "WV-R20-40" }));
    expect(dependsOn(m1, { kind: "element", id: "WV-R20-40" }).items.length).toBeGreaterThan(0);
    const merge = { removedIds: ["WV-R30-21", "WV-R30-22", "WV-R30-23"], label: "Merge four rooms" };
    const mergeMs = median(() => dependsOn(m1, merge), 5);
    expect(dependsOn(m1, merge).items.length).toBeGreaterThan(0);
    // The preview ran on the touched neighbourhood: nothing new was evaluated on the model's own state.
    expect(graphStats(m1).ruleRuns - stats.ruleRuns).toBe(reran);

    const rules: RuleRecord[] = Array.from({ length: 2_000 }, (_, i) => ({ ...(STUDY.rules[0] as RuleRecord), ruleId: `bulk-${i}`, provider: "zb.bulk", applies: { spaceUses: [`unused-${i % 50}`] } }));
    t = performance.now();
    bindRequirementsSnapshot(ID, { source: { id: "zb.bulk", label: "Bulk test rules", version: "1.0.0", contract: "^1.0.0", capabilities: { rules: true }, visibility: "firm" }, revision: "b1", rules });
    const bind = performance.now() - t;
    t = performance.now();
    requirementsAt(m1, { kind: "space", id: "R10-11" });
    const rebind = performance.now() - t;
    unbindRequirementsSnapshot(ID, "zb.bulk");

    const after = graphStats(m1);
    process.stderr.write(
      `[g7 requirements graph] ${elementCount} elements, ${all.length} requirements, ${stats.evaluations} evaluations, ${after.edges} reverse edges over ${after.reverseKeys} keys; ` +
        `cold ${cold.toFixed(0)} ms; one_edit ${oneEdit.toFixed(2)} ms (${reran} rule runs); why ${whyMs.toFixed(2)} ms; depends_on.wall ${wallMs.toFixed(2)} ms; ` +
        `impact_preview.merge_3_rooms ${mergeMs.toFixed(2)} ms; snapshot.bind.2k_rules ${bind.toFixed(1)} ms (+ ${rebind.toFixed(1)} ms first read after)\n`,
    );
    // Guards against a full-model pass on a hot path only; the budgets are the perf gate's.
    expect(oneEdit).toBeLessThan(200);
    expect(whyMs).toBeLessThan(200);
    expect(wallMs).toBeLessThan(200);
    expect(mergeMs).toBeLessThan(500);
    expect(bind + rebind).toBeLessThan(2_000);
  });
});
