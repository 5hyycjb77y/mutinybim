/**
 * @jest-environment node
 *
 * Round 8 lane F: an edit checked before anyone approves it.
 *
 * - f8-preflight-refused: a command the model refuses answers `refused` with
 *   the rule's words, and nothing re-opens (the card is never offered).
 * - f8-preflight-reopens: taking out three walls answers what re-opens and
 *   the quantity change, on a preview; the model is untouched.
 * - f8-fingerprint: an unrelated edit to the model keeps the answer's
 *   fingerprint; an edit that changes the answer changes it (the stale card
 *   re-asks only when what it says would change).
 * - f8-preview-indexes-forked: the preview's input indexes fork from the
 *   head's and give the same requirements as indexes built from scratch.
 *
 * Fails on round 7: there is no `previewEdit`, and `previewStateIn` rebuilt
 * the indexes for every preview.
 */
import { DEFAULT_SETTINGS, dependsOn, previewEdit, requirementsOf, unbindRequirementsSnapshot, type BimElement, type ModelState } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { withModelPacks } from "../src/packs/scope";
import { graphStateIn, previewStateIn } from "../src/graph/engine";
import { anchorKeyOf } from "../src/graph/inputs";
import { draftElements } from "../src/store";
import { bindStudy, floor, FT, run, writes, ZT_PACK } from "./g7-fixtures";

const ID = "f8-preview";

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

const REMOVE_THREE = { type: "delete_elements", ids: ["W-12", "W-13", "W-14"], policy: "cascade" } as const;

describe("f8 previewEdit", () => {
  it("f8-preflight-refused: a command the model refuses says why, and nothing re-opens", () => {
    const model = floor(ID);
    const answer = writes(() => previewEdit(model, { type: "move_wall", wallId: "W-404", delta: { x: 1000, y: 0 } }));
    expect(answer.status).toBe("refused");
    if (answer.status !== "refused") return;
    expect(answer.message.length).toBeGreaterThan(0);
    expect(answer.fingerprint).toMatch(/^[0-9a-f]{14}$/);
  });

  it("f8-preflight-reopens: three walls out re-opens the offices, with the quantity change; the model is untouched", () => {
    const model = floor(ID);
    requirementsOf(model);
    const before = JSON.stringify(model.elements);
    const answer = writes(() => previewEdit(model, REMOVE_THREE));
    expect(answer.status).toBe("checked");
    if (answer.status !== "checked") return;
    expect(answer.reopens.length).toBe(5);
    expect(answer.more).toBe(1);
    expect(answer.reopens.map((r) => r.what)).toContain("Exit count in Office 101, Office 102 and Office 103");
    for (const r of answer.reopens) expect(r.because).toMatch(/removed/);
    expect(answer.quantityChanges.length).toBeGreaterThan(0);
    expect(answer.removedIds).toEqual(expect.arrayContaining(["W-12", "W-13", "W-14"]));
    expect(answer.headRevision).toBe(Number(model.revision));
    expect(JSON.stringify(model.elements)).toBe(before);
    // The same answer the graph gives for the proposed removal.
    const direct = dependsOn(model, { removedIds: ["W-12", "W-13", "W-14"] });
    expect(answer.reopens.map((r) => r.what)).toEqual(direct.items.map((i) => i.label));
  });

  it("f8-fingerprint: unrelated edits keep it, an edit that changes the answer changes it", () => {
    const m0 = floor(ID);
    const first = writes(() => previewEdit(m0, REMOVE_THREE));
    // Room 104, beyond the three walls: renaming it changes nothing they re-open.
    const unrelated = run(m0, { type: "edit_space", spaceId: "S104", name: "Store" });
    const same = writes(() => previewEdit(unrelated, REMOVE_THREE));
    expect(same.status).toBe("checked");
    expect(same.fingerprint).toBe(first.fingerprint);
    expect(same.headRevision).toBe(Number(unrelated.revision));
    // W-14 already gone: removing the three now refuses (or answers differently).
    const moved = run(m0, { type: "delete_elements", ids: ["W-14"], policy: "cascade" });
    const changed = writes(() => previewEdit(moved, REMOVE_THREE));
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });
});

describe("f8-preview-indexes-forked", () => {
  function requirementsAtAnchors(model: ModelState, changed: readonly string[] | undefined, after: Readonly<Record<string, BimElement>>) {
    return withModelPacks(model.modelId, () => {
      const base = graphStateIn(model);
      const preview = previewStateIn({ ...model, elements: after }, base, changed);
      const out: Record<string, unknown> = {};
      for (const id of Object.keys(after)) {
        const el = after[id];
        if (el?.kind !== "space") continue;
        const ref = { kind: "space" as const, id };
        out[anchorKeyOf(ref)] = preview.requirementsAt(ref).map((r) => [r.key, r.value, r.status, r.fulfilment.state, r.fulfilment.elementIds.join("|")]);
      }
      return out;
    });
  }

  it("removing walls: forked indexes give the same requirements as rebuilt ones", () => {
    const model = floor(ID);
    requirementsOf(model);
    const after = draftElements(model.elements);
    for (const id of ["W-12", "W-13", "W-14"]) delete after[id];
    expect(requirementsAtAnchors(model, ["W-12", "W-13", "W-14"], after)).toEqual(requirementsAtAnchors(model, undefined, after));
  });

  it("moving a located part and changing a determination: forked equals rebuilt", () => {
    const model = floor(ID);
    requirementsOf(model);
    const head = Object.values(model.elements).find((e) => e.kind === "part");
    const det = Object.values(model.elements).find((e) => e.kind === "determination");
    expect(head).toBeDefined();
    expect(det).toBeDefined();
    if (!head || head.kind !== "part" || !det) return;
    const after = draftElements(model.elements);
    after[head.id] = { ...head, position: { x: head.position.x + 4000, y: head.position.y } };
    delete after[det.id];
    const changed = [head.id, det.id];
    expect(requirementsAtAnchors(model, changed, after)).toEqual(requirementsAtAnchors(model, undefined, after));
  });
});

// ── agent.preflight.one_edit.250k ───────────────────────────────────────────

const PERF_ID = "f8-preview-perf";
const COLS = 80;
// F8_PERF_ROWS=544 builds about 250k elements (the target); the default keeps the jest run light.
const ROWS = Number(process.env.F8_PERF_ROWS ?? 50);
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
      // No parts: a part with no type is an open issue, and a model with open issues re-validates in full on every edit, which this row doesn't measure.
      if (storage) els.push({ version: 1, authoredRev: {}, partition, id: `C-${id}`, kind: "ceiling", levelId: "L1", spaceId: id, outline: rect(x0, y0, x0 + SIZE, y0 + SIZE), form: "flat", heightMm: 10 * FT } as unknown as BimElement);
    }
  }
  return { modelId: PERF_ID, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

describe("f8 agent.preflight.one_edit perf", () => {
  beforeAll(() => {
    bindModelPacks(PERF_ID, PackSet.create([ZT_PACK]));
    bindStudy(PERF_ID);
  });
  afterAll(() => unbindRequirementsSnapshot(PERF_ID));

  it("one edit's preflight (validation + what re-opens) stays on the touched neighbourhood", () => {
    const model = grid();
    const elementCount = Object.keys(model.elements).length;
    requirementsOf(model);
    const edits = [
      { type: "move_wall", wallId: "WV-R20-40", delta: { x: 300, y: 0 } },
      { type: "delete_elements", ids: ["WV-R30-21", "WV-R30-22", "WV-R30-23"], policy: "cascade" },
      { type: "edit_space", spaceId: "R10-11", occupants: 60 },
    ] as const;
    const samples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const edit = edits[i % edits.length];
      if (!edit) continue;
      const t = performance.now();
      const answer = writes(() => previewEdit(model, edit));
      samples.push(performance.now() - t);
      expect(answer.status === "refused" ? `${edit.type}: ${answer.message}` : answer.status).toBe("checked");
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)] ?? 0;
    const p95 = samples[samples.length - 1] ?? 0;
    // The same preview state with indexes forked vs rebuilt (round 7's path), for the record.
    const after = draftElements(model.elements);
    const removed = ["WV-R30-21", "WV-R30-22", "WV-R30-23"];
    for (const id of removed) delete after[id];
    const time = (changed: readonly string[] | undefined) =>
      withModelPacks(PERF_ID, () => {
        const base = graphStateIn(model);
        const t = performance.now();
        previewStateIn({ ...model, elements: after }, base, changed).requirementsAt({ kind: "space", id: "R30-22" });
        return performance.now() - t;
      });
    const forked = Math.min(time(removed), time(removed), time(removed));
    const rebuilt = Math.min(time(undefined), time(undefined), time(undefined));
    process.stderr.write(`[f8 agent.preflight.one_edit] ${elementCount} elements; p50 ${p50.toFixed(1)} ms, max ${p95.toFixed(1)} ms over ${samples.length}; preview state forked ${forked.toFixed(1)} ms vs rebuilt ${rebuilt.toFixed(1)} ms\n`);
    // Guards a full-model pass only; the budget (60 / 120 ms at 250k) is the perf gate's.
    expect(p50).toBeLessThan(ROWS > 100 ? 120 : 60);
  });
});
