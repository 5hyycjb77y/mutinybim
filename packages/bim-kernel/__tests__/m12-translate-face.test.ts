/**
 * @jest-environment node
 *
 * Round 12 lane M12, move step 1: how a move travels through a duct run is
 * the Mechanical add-on's, behind the network adapter's `translate` face
 * (contract 1.10.0). The kernel's move command makes a trade-neutral working
 * copy (`TranslateWorkingCopy`), moves what it moves itself, and asks each
 * network for the rest; `solver.ts` and `part-commands.ts` name no duct kind.
 *
 * Old models move identically: moving the demo's unit with Move gives the
 * same elements as round 1's `move_equipment` (round 11 ran both through the
 * kernel's Propagator), the run follows, and the stored command and its
 * authored position are unchanged.
 *
 * Fails on round 11's code: `TranslateWorkingCopy` and the Mechanical
 * adapter's `translate` didn't exist; `solver.ts` held `Propagator` and
 * `part-commands.ts` had an `equipment` case.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NETWORK_ADAPTER_POINT,
  TrackedReader,
  TranslateWorkingCopy,
  elementsOfKind,
  executeCommand,
  recomputeDerived,
  translateThroughNetworks,
  type BimElement,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { activePackSet } from "../src/packs";

const SRC = path.resolve(__dirname, "../src");
const demo = (): ModelState => recomputeDerived(createDemoModel("m12-translate")).model;

function first(model: ModelState, kind: string): BimElement {
  const el = elementsOfKind(model.elements, kind as BimElement["kind"])[0];
  if (!el) throw new Error(`the demo model has no ${kind}`);
  return el;
}

describe("m12 translate face", () => {
  it("the Mechanical network row carries the move rule", () => {
    const row = activePackSet().items(NETWORK_ADAPTER_POINT).find((i) => i.id === "mechanical");
    expect(typeof row?.translate).toBe("function");
  });

  it("Move on the unit gives the same model as move_equipment, and the run follows", () => {
    const m = demo();
    const unit = first(m, "equipment");
    const delta = { x: 0, y: 610 };
    const moved = executeCommand(m, { type: "move_elements", ids: [unit.id], delta });
    const legacy = executeCommand(m, { type: "move_equipment", equipmentId: unit.id, delta });
    if (!moved.ok || !legacy.ok) throw new Error(`move refused: ${JSON.stringify(moved.ok ? legacy : moved)}`);
    expect(JSON.stringify(moved.model.elements)).toBe(JSON.stringify(legacy.model.elements));
    expect(moved.changedIds).toEqual(legacy.changedIds);
    // The duct off the outlet moved with it: more than the unit changed.
    expect(moved.changedIds.length).toBeGreaterThan(1);
    const before = m.elements[unit.id];
    const after = moved.model.elements[unit.id];
    expect(after?.kind === "equipment" && before?.kind === "equipment" && after.position.y - before.position.y).toBe(610);
  });

  it("a wall is left to the kernel and a fixed diffuser still refuses in words", () => {
    const m = demo();
    const ctx = new TranslateWorkingCopy(new TrackedReader(m));
    const terminal = first(m, "terminal");
    // The air network moves units on their own; a diffuser moves only with its run.
    expect(translateThroughNetworks(ctx, terminal.id, { x: 10, y: 0 })).toBe(false);
    expect(ctx.touched.size).toBe(0);
    const refused = executeCommand(m, { type: "move_elements", ids: [terminal.id], delta: { x: 10, y: 0 } });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toMatch(/can't be moved on its own/);
    // Sliding a branch into a fixed diffuser is the add-on's refusal, word for word.
    const tap = first(m, "tap");
    const slid = executeCommand(m, { type: "slide_branch", tapId: tap.id, s: 0 });
    expect(slid.ok || slid.error.code).not.toBe("internal");
  });

  it("the working copy records what a move set and authored", () => {
    const m = demo();
    const unit = first(m, "equipment");
    const ctx = new TranslateWorkingCopy(new TrackedReader(m));
    expect(translateThroughNetworks(ctx, unit.id, { x: 305, y: 0 })).toBe(true);
    expect(ctx.touched.has(unit.id)).toBe(true);
    expect(ctx.authored.map((a) => [a.elementId, a.field])).toEqual([[unit.id, "position"]]);
    // The stored model is untouched.
    expect(m.elements[unit.id]).toBe(unit);
  });

  it("solver.ts names no duct kind; neither it nor the move command holds a propagation", () => {
    const solver = readFileSync(path.join(SRC, "solver.ts"), "utf8");
    const parts = readFileSync(path.join(SRC, "part-commands.ts"), "utf8");
    const move = parts.slice(parts.indexOf("function moveElements("), parts.indexOf("function rotateElements("));
    expect(move.length).toBeGreaterThan(0);
    for (const source of [solver, move]) {
      expect(source).not.toMatch(/\bPropagator\b/);
      expect(source).not.toMatch(/"(equipment|duct_segment|tap|elbow|terminal)"/);
      expect(source).not.toMatch(/\b(translateInto|connectionAt)\b/);
    }
    expect(solver).not.toMatch(/duct/i);
  });
});
