/**
 * @jest-environment node
 *
 * Round 8 lane W perf row `validate.incremental.250k` (in-process, warm):
 * the validation step of one edit on a model that already has open issues,
 * after the head's ledger exists. Measured as `checkEdit` (incremental
 * validation plus the "is this issue new / on an edited element" pass) on
 * the states real commands produce, then committed, edit after edit.
 *
 * Two models, both with open issues:
 * - the all-discipline building (`createFullBimModel`) with 2,000 parts whose
 *   type and level don't exist and tags whose targets don't;
 * - lane F's room grid (544 x 80 rooms), whose 21,760 heads name a type that
 *   isn't in the model: round 7 spent about 2 s per edit here, almost all of
 *   it matching each open issue to its earlier report one by one.
 *
 * W8_PERF_SCALE=250k builds the target size (about 250k elements each),
 * W8_PERF_SCALE=1M the building at about 1M; the default keeps the jest run light. Round 7's check on the same states is
 * logged beside it. The expectations only catch a full-model pass on the hot
 * path; the budget is the perf gate's.
 */
import { checkEdit, executeCommand, issuesOf, planCommit, validateModel, type BimElement, type Command, type ElementId, type ModelState, type ValidationIssue } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";

const SCALE = process.env.W8_PERF_SCALE;
const AT_SCALE = SCALE === "250k" || SCALE === "1M";
const NOW = () => "2026-11-01T00:00:00.000Z";

function broken(model: ModelState, parts: number): ModelState {
  const els: Record<string, BimElement> = { ...model.elements };
  for (let i = 0; i < parts; i++) {
    els[`w8-part-${i}`] = { version: 1, authoredRev: {}, id: `w8-part-${i}`, kind: "part", typeId: "w8-missing-type", levelId: "w8-missing-level", position: { x: i * 100, y: 0 }, offsetMm: 0, rotationDeg: 0, mark: `P${i}`, values: {} } as unknown as BimElement;
  }
  const tag = Object.values(model.elements).find((e) => e.kind === "tag");
  for (let i = 0; tag && i < parts / 10; i++) els[`w8-tag-${i}`] = { ...tag, id: `w8-tag-${i}`, targetId: `w8-gone-${i}` } as unknown as BimElement;
  return { ...model, elements: els };
}

function roomGrid(rows: number): ModelState {
  const COLS = 80;
  const SIZE = 4000;
  const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const partition = { level: "Level 1", zone: "Z1", discipline: "architecture" as const };
  const els: BimElement[] = [{ id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement];
  const det = (id: string, subject: string, key: string, value: string) =>
    ({ id, kind: "determination", version: 1, authoredRev: {}, determination: { subject: { kind: "space", id: subject }, key, value, inputs: [], reasoning: "Synthetic.", decidedBy: "Test", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high", status: "recorded" } }) as unknown as BimElement;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const id = `R${r}-${c}`;
      const storage = (r * COLS + c) % 4 === 0;
      const x0 = c * SIZE;
      const y0 = r * SIZE;
      els.push({ version: 1, authoredRev: {}, id, kind: "space", name: storage ? "Room" : "Office", number: `${r}${String(c).padStart(2, "0")}`, levelId: "L1", bounds: { kind: "outline", outline: rect(x0, y0, x0 + SIZE, y0 + SIZE) }, origin: { kind: "drawn" }, use: { libraryId: "test", useId: storage ? "storage" : "office" }, occupants: 4 } as unknown as BimElement);
      els.push(det(`DO-${id}`, id, "occupancy", storage ? "S-1" : "B"), det(`DH-${id}`, id, "hazard", storage ? "ordinary_1" : "light"));
      if (c < COLS - 1) els.push({ version: 1, authoredRev: {}, partition, id: `WV-${id}`, kind: "wall", start: { x: x0 + SIZE, y: y0 }, end: { x: x0 + SIZE, y: y0 + SIZE }, thickness: 150, height: 3000, wallType: "Partition" } as unknown as BimElement);
      if (r < rows - 1) els.push({ version: 1, authoredRev: {}, partition, id: `WH-${id}`, kind: "wall", start: { x: x0, y: y0 + SIZE }, end: { x: x0 + SIZE, y: y0 + SIZE }, thickness: 150, height: 3000, wallType: "Partition" } as unknown as BimElement);
      if (storage) for (const k of [1, 3]) els.push({ version: 1, authoredRev: {}, id: `H${k}-${id}`, kind: "part", typeId: "pt-head", levelId: "L1", position: { x: x0 + k * 1000, y: y0 + k * 1000 }, offsetMm: 2700, rotationDeg: 0, mark: `H${k}`, values: {} } as unknown as BimElement);
    }
  }
  return { modelId: "w8-grid", revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: createFullBimModel(FULL_BIM_TIERS.XS).settings };
}

function idsOf(model: ModelState, kind: string): ElementId[] {
  return Object.values(model.elements)
    .filter((e) => e.kind === kind)
    .map((e) => e.id);
}

function roundSeven(before: readonly ValidationIssue[], after: ModelState): void {
  for (const issue of validateModel(after)) before.find((b) => b.code === issue.code && issue.elementIds.every((id) => b.elementIds.includes(id)));
}

interface Row {
  readonly elements: number;
  readonly open: number;
  readonly firstMs: number;
  readonly samples: number[];
  readonly byType: Map<string, number[]>;
  readonly roundSeven: number[];
}

function measure(start: ModelState, commands: (head: ModelState, i: number) => Command, edits: number): Row {
  let head = start;
  const open = issuesOf(head).length;
  const samples: number[] = [];
  const byType = new Map<string, number[]>();
  const old: number[] = [];
  let firstMs = 0;
  let n = 0;
  for (let i = 0; i < edits; i++) {
    const command = commands(head, i);
    const t0 = performance.now();
    const r = executeCommand(head, command);
    if (i === 0) firstMs = performance.now() - t0;
    if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
    const changed = [...r.changedIds, ...r.removedIds];
    const base: ModelState = { ...head, connections: r.model.connections };
    // Warm: the head's ledger exists (the command just used it); this is one edit's validation step.
    const t = performance.now();
    const check = checkEdit(head, base, r.model, changed);
    const ms = performance.now() - t;
    samples.push(ms);
    byType.set(command.type, [...(byType.get(command.type) ?? []), ms]);
    expect(check.refusal).toBeNull();
    expect(check.open.length).toBe(r.openIssues?.length ?? 0);
    // Round 7 is quadratic in open issues: one sample at 1M.
    if (i < (SCALE === "1M" ? 1 : 6)) {
      const o = performance.now();
      roundSeven(issuesOf(head), r.model);
      old.push(performance.now() - o);
    }
    n += 1;
    const d = planCommit(head, [], { idempotencyKey: `w8-perf-${start.modelId}-${n}`, baseRevision: head.revision, actor: { id: "agent", name: "Agent", kind: "agent" }, command }, NOW, []);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    head = d.model;
  }
  // The last head's open issues are still full validation's.
  expect(JSON.stringify(issuesOf(head))).toBe(JSON.stringify(validateModel(head)));
  return { elements: Object.keys(start.elements).length, open, firstMs, samples, byType, roundSeven: old };
}

function pct(list: readonly number[], p: number): number {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}

function log(name: string, row: Row): void {
  process.stderr.write(
    `[w8 validate.incremental] ${name}: ${row.elements} elements, ${row.open} open issues; ` +
      `p50 ${pct(row.samples, 0.5).toFixed(2)} ms, p95 ${pct(row.samples, 0.95).toFixed(2)} ms, max ${pct(row.samples, 1).toFixed(2)} ms over ${row.samples.length}; ` +
      `first edit after load (builds the ledger) ${row.firstMs.toFixed(0)} ms; round 7's check p50 ${pct(row.roundSeven, 0.5).toFixed(1)} ms; ` +
      `max by command: ${[...row.byType].map(([type, list]) => `${type} ${pct(list, 1).toFixed(1)}`).join(", ")}\n`,
  );
}

describe("w8 validate.incremental perf", () => {
  it("the all-discipline building with open issues: each edit re-checks its neighbourhood only", () => {
    const model = broken(createFullBimModel(SCALE === "1M" ? FULL_BIM_TIERS["1M"] : AT_SCALE ? FULL_BIM_TIERS["250k"] : FULL_BIM_TIERS.XS), AT_SCALE ? 2000 : 200);
    const walls = idsOf(model, "wall");
    const tags = idsOf(model, "tag").filter((id) => !id.startsWith("w8-"));
    const terminals = idsOf(model, "terminal");
    const equipment = idsOf(model, "equipment");
    const taps = idsOf(model, "tap");
    const row = measure(
      model,
      (head, i): Command => {
        switch (i % 5) {
          case 0:
            return { type: "move_wall", wallId: walls[(i * 7919) % walls.length] ?? "", delta: { x: 10, y: 0 } };
          case 1:
            return { type: "move_tag", tagId: tags[(i * 104729) % tags.length] ?? "", offset: { x: 40, y: 40 } };
          case 2:
            return { type: "set_terminal_cfm", terminalId: terminals[(i * 31) % terminals.length] ?? "", cfm: 200 + i };
          case 3:
            return { type: "move_equipment", equipmentId: equipment[(i * 13) % equipment.length] ?? "", delta: { x: 5, y: 0 } };
          default: {
            const tapId = taps[(i * 101) % taps.length] ?? "";
            const tap = head.elements[tapId];
            return { type: "slide_branch", tapId, s: (tap?.kind === "tap" ? tap.s : 0) + (i % 2 === 0 ? 25 : -25) };
          }
        }
      },
      40,
    );
    log("all-discipline building", row);
    expect(pct(row.samples, 0.95)).toBeLessThan(AT_SCALE ? 120 : 30);
  });

  it("lane F's room grid with 21,760 heads of a missing type: no issue-by-issue matching", () => {
    const model = roomGrid(SCALE === "1M" ? 2176 : AT_SCALE ? 544 : 50);
    const walls = idsOf(model, "wall");
    const row = measure(
      model,
      (_head, i): Command => (i % 2 === 0 ? { type: "move_wall", wallId: walls[(i * 7919) % walls.length] ?? "", delta: { x: 10, y: 0 } } : { type: "delete_elements", ids: [walls[(i * 104729) % walls.length] ?? ""], policy: "cascade" }),
      30,
    );
    log("room grid", row);
    expect(pct(row.samples, 0.95)).toBeLessThan(AT_SCALE ? 120 : 30);
  });
});
