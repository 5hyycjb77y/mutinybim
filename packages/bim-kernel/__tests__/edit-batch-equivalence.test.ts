/**
 * @jest-environment node
 *
 * A pasted CFM column derives and validates once per run of cells, not once
 * per cell, and walks airflow by slot. It must land exactly where the same
 * cells sent one after another land, and where a full rebuild lands: same
 * elements, same airflow order, same refusals naming the same step.
 */
import {
  canonicalJson,
  commandSchema,
  draftElements,
  executeCommand,
  isFullyDerived,
  recomputeDerived,
  type BimElement,
  type Command,
  type ModelState,
} from "../src";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { createDemoModel, createHeavyModel } from "@permitzip/bim-pack-mechanical/seed";

type CfmStep = { type: "set_terminal_cfm"; terminalId: string; cfm: number };

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function terminalsOf(model: ModelState): BimElement[] {
  return Object.values(model.elements).filter((el) => el.kind === "terminal");
}

const cfmOf = (el: BimElement | undefined): number | undefined => (el?.kind === "terminal" ? el.cfm : undefined);

/** Cells with repeats, unchanged values, fractional values and edits that cancel each other out. */
function randomCells(model: ModelState, seed: number, count: number): CfmStep[] {
  const next = random(seed);
  const terminals = terminalsOf(model);
  const cells: CfmStep[] = [];
  for (let i = 0; i < count; i++) {
    const t = terminals[Math.floor(next() * terminals.length)] as BimElement;
    const roll = next();
    const now = cells.findLast((c) => c.terminalId === t.id)?.cfm ?? cfmOf(t) ?? 0;
    const cfm = roll < 0.15 ? now : roll < 0.3 ? (cfmOf(t) ?? 0) : roll < 0.45 ? Math.round(next() * 200000) / 100 : 50 + Math.floor(next() * 40) * 5;
    cells.push({ type: "set_terminal_cfm", terminalId: t.id, cfm });
  }
  return cells;
}

function runOneByOne(model: ModelState, steps: readonly Command[]): { ok: true; model: ModelState; changed: string[] } | { ok: false; message: string } {
  let at = model;
  const changed: string[] = [];
  for (const [i, step] of steps.entries()) {
    const r = executeCommand(at, commandSchema.parse(step));
    if (!r.ok) return { ok: false, message: `Step ${i + 1} of ${steps.length} (${step.type.replace(/_/g, " ")}): ${r.error.message}` };
    at = r.model;
    for (const id of r.changedIds) if (!changed.includes(id)) changed.push(id);
  }
  return { ok: true, model: at, changed };
}

/** Every element of both models, as canonical JSON by id. */
function snapshot(model: ModelState): Map<string, string> {
  return new Map(Object.entries(model.elements).map(([id, el]) => [id, canonicalJson(el)]));
}

/** The base with only the authored CFM values written, nothing re-derived: what a full rebuild starts from. */
function authoredOnly(model: ModelState, cells: readonly CfmStep[]): ModelState {
  const elements = draftElements(model.elements);
  for (const c of cells) {
    const el = elements[c.terminalId];
    if (el?.kind === "terminal") elements[c.terminalId] = { ...el, cfm: c.cfm };
  }
  return { ...model, elements };
}

const MODELS: ReadonlyArray<readonly [string, () => ModelState]> = [
  ["full-BIM XS", () => createFullBimModel(FULL_BIM_TIERS.XS)],
  ["demo", () => createDemoModel()],
  ["heavy", () => createHeavyModel({ units: 3, segmentsPerTrunk: 6 })],
];

describe.each(MODELS)("batch_edits CFM runs on the %s model", (_name, build) => {
  const start = build();
  const terminals = terminalsOf(start);

  it("has terminals to paste into", () => {
    expect(terminals.length).toBeGreaterThan(1);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("random paste %i: batch == one by one == full rebuild", (seed) => {
    const cells = randomCells(start, seed, Math.min(120, terminals.length * 3));
    const batch = executeCommand(start, commandSchema.parse({ type: "batch_edits", commands: cells }));
    const one = runOneByOne(start, cells);
    if (!batch.ok || !one.ok) throw new Error(batch.ok ? (one.ok ? "" : one.message) : batch.error.message);

    // Same elements as one by one.
    expect(snapshot(batch.model)).toEqual(snapshot(one.model));

    // Same as a full rebuild from the authored values, airflow order included.
    const rebuilt = recomputeDerived(authoredOnly(start, cells));
    expect(snapshot(batch.model)).toEqual(snapshot(rebuilt.model));
    expect(isFullyDerived(batch.model)).toBe(true);
    const touched = new Set(cells.map((c) => c.terminalId));
    expect(batch.changedIds.filter((id) => !touched.has(id))).toEqual(rebuilt.changedIds.filter((id) => !touched.has(id)));

    // Changed ids: every cell's terminal plus every element that ends up different. One by one also lists
    // elements that changed and changed back within the paste; those are equal to the base.
    const before = snapshot(start);
    const after = snapshot(batch.model);
    const differs = [...after.keys()].filter((id) => after.get(id) !== before.get(id));
    expect(new Set(batch.changedIds)).toEqual(new Set([...touched, ...differs]));
    const batchChanged = new Set<string>(batch.changedIds);
    for (const id of one.changed) if (!batchChanged.has(id)) expect(after.get(id)).toBe(before.get(id));

    // Authored writes and intents: one per terminal, the last value pasted into it.
    const last = new Map(cells.map((c) => [c.terminalId, c.cfm]));
    expect(batch.authored).toEqual([...last].map(([elementId, value]) => ({ elementId, field: "cfm", value })));
    expect(batch.intents).toEqual([...last].map(([elementId, value]) => ({ kind: "field_equals", elementId, field: "cfm", value })));
  });

  it("refuses a cell that is not a terminal with the message one-by-one gives, naming its step", () => {
    const cells: CfmStep[] = randomCells(start, 99, 12);
    const notTerminal = Object.values(start.elements).find((el) => el.kind !== "terminal") as BimElement;
    cells.splice(7, 0, { type: "set_terminal_cfm", terminalId: notTerminal.id, cfm: 100 });
    const batch = executeCommand(start, commandSchema.parse({ type: "batch_edits", commands: cells }));
    const one = runOneByOne(start, cells);
    expect(batch.ok).toBe(false);
    expect(one.ok).toBe(false);
    if (batch.ok || one.ok) return;
    expect(batch.error.message).toBe(one.message);
    expect(batch.error.message).toMatch(/^Step 8 of 13 \(set terminal cfm\): /);
  });

  it("runs other edits between CFM runs step by step, landing where one by one lands", () => {
    const equipment = Object.values(start.elements).find((el) => el.kind === "equipment");
    if (!equipment) return;
    const steps: Command[] = [
      ...randomCells(start, 7, 10),
      commandSchema.parse({ type: "move_equipment", equipmentId: equipment.id, delta: { x: 50, y: 0 } }),
      ...randomCells(start, 8, 10),
    ];
    const batch = executeCommand(start, commandSchema.parse({ type: "batch_edits", commands: steps }));
    const one = runOneByOne(start, steps);
    expect(batch.ok).toBe(one.ok);
    if (!batch.ok || !one.ok) {
      if (!batch.ok && !one.ok) expect(batch.error.message).toBe(one.message);
      return;
    }
    expect(snapshot(batch.model)).toEqual(snapshot(one.model));
  });
});
