/**
 * @jest-environment node
 *
 * Round 15 gap G-K15-1: a multi-step edit (batch_edits, connect_into with many
 * sources, a script's outputs as one batch) runs each step on the step before.
 * Once a sibling revision over the same head had appended to the shared slot
 * table (a preview, a refused attempt, the same edit predicted earlier), every
 * later step rebuilt the whole record: ~70 ms a step at 250k. Steps now share
 * the head's slot table and its untouched chunks; the records still read
 * exactly like plain objects built by the same writes.
 */
import {
  asElementId,
  canonicalJson,
  commandSchema,
  draftElements,
  elementCount,
  elementEntries,
  elementOrder,
  elementSlots,
  elementValues,
  executeCommand,
  freezeElements,
  planCommit,
  type BimElement,
  type Command,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

type Rec = Record<string, BimElement>;

const [template] = Object.values(createDemoModel().elements);
if (!template) throw new Error("demo model has no elements");

function element(id: string, n: number): BimElement {
  return Object.assign({}, template, { id: asElementId(id), version: n });
}

function expectSame(actual: Readonly<Rec>, expected: Readonly<Rec>): void {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  expect(elementValues(actual)).toEqual(Object.values(expected));
  expect(elementEntries(actual)).toEqual(Object.entries(expected));
  expect(elementCount(actual)).toBe(Object.keys(expected).length);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  for (const id of Object.keys(expected)) expect(actual[id]).toEqual(expected[id]);
}

function head(count: number): { readonly record: Readonly<Rec>; readonly plain: Rec } {
  const plain: Rec = {};
  for (let i = 0; i < count; i++) plain[`e-${i}`] = element(`e-${i}`, i);
  return { record: freezeElements(draftElements(plain)), plain };
}

/** One step: add `adds` new elements and rewrite one existing one, on top of `record`. */
function step(record: Readonly<Rec>, plain: Rec, k: number, prefix: string): { readonly record: Readonly<Rec>; readonly plain: Rec } {
  const draft = draftElements(record);
  const next: Rec = { ...plain };
  for (let j = 0; j < 3; j++) {
    const id = `${prefix}-${k}-${j}`;
    draft[id] = element(id, k);
    next[id] = draft[id] as BimElement;
  }
  const touched = `e-${k * 7}`;
  draft[touched] = element(touched, 1000 + k);
  next[touched] = draft[touched] as BimElement;
  elementSlots(draft); // what the validation ledger does when an element was added
  return { record: draft, plain: next };
}

describe("G-K15-1: every step of a multi-step edit shares the head's slot table", () => {
  it("a 50-step chain after a sibling prediction never rebuilds the record (old code: a new table from step 1)", () => {
    const base = head(5000);
    const table = elementSlots(base.record).table;
    // A sibling over the same head appends first: the preview the operator saw, a refused attempt.
    step(base.record, base.plain, 0, "sibling");
    let at = base;
    for (let k = 0; k < 50; k++) {
      at = step(at.record, at.plain, k, "batch");
      expect(elementSlots(at.record).table).toBe(table);
    }
    expectSame(at.record, at.plain);
    // The head itself is untouched by both.
    expectSame(base.record, base.plain);
  });

  it("the same edit predicted twice lands in the same slots (deterministic layout)", () => {
    const base = head(2000);
    const first = step(base.record, base.plain, 3, "again");
    const second = step(base.record, base.plain, 3, "again");
    const a = elementSlots(first.record);
    const b = elementSlots(second.record);
    expect(b.table).toBe(a.table);
    expect(b.size).toBe(a.size);
    for (const id of ["again-3-0", "again-3-1", "again-3-2"]) expect(b.table.slotOf.get(id)).toBe(a.table.slotOf.get(id));
    expectSame(second.record, second.plain);
  });

  it("ids a sibling placed in another order still read in this revision's key order", () => {
    const base = head(1500);
    const sib = draftElements(base.record);
    sib["y"] = element("y", 1);
    sib["x"] = element("x", 2);
    elementSlots(sib);
    const draft = draftElements(base.record);
    draft["x"] = element("x", 3);
    draft["z"] = element("z", 4);
    draft["y"] = element("y", 5);
    const frozen = freezeElements(draft);
    expectSame(frozen, { ...base.plain, x: element("x", 3), z: element("z", 4), y: element("y", 5) });
    expectSame(freezeElements(sib), { ...base.plain, y: element("y", 1), x: element("x", 2) });
  });

  it("deleting and putting back keeps plain-object order, on top of sibling gaps", () => {
    const base = head(1200);
    step(base.record, base.plain, 0, "sibling");
    const draft = draftElements(base.record);
    delete draft["e-5"];
    draft["n-1"] = element("n-1", 1);
    const once = freezeElements(draft);
    const again = draftElements(once);
    again["e-5"] = element("e-5", 9);
    delete again["n-1"];
    again["n-1"] = element("n-1", 2);
    const expected: Rec = { ...base.plain };
    delete expected["e-5"];
    expected["e-5"] = element("e-5", 9);
    expected["n-1"] = element("n-1", 2);
    expectSame(freezeElements(again), expected);
  });

  it("an id re-created after newer keys (a system every attempt creates) forks the table once, then later steps share the fork", () => {
    const base = head(3000);
    // An earlier attempt created the system first.
    const attempt = draftElements(base.record);
    attempt["sys"] = element("sys", 1);
    elementSlots(attempt);
    // This batch places a fixture first, then the route that creates the same system.
    const first = draftElements(base.record);
    first["wc-1"] = element("wc-1", 1);
    const afterFirst = elementSlots(first).table;
    expect(afterFirst).toBe(elementSlots(base.record).table);
    const second = draftElements(first);
    second["sys"] = element("sys", 2);
    second["run-1"] = element("run-1", 2);
    const forked = elementSlots(second).table;
    expect(forked).not.toBe(afterFirst);
    let at: Readonly<Rec> = second;
    const expected: Rec = { ...base.plain, "wc-1": element("wc-1", 1), sys: element("sys", 2), "run-1": element("run-1", 2) };
    for (let k = 0; k < 20; k++) {
      const d = draftElements(at);
      d[`run-${k + 2}`] = element(`run-${k + 2}`, k);
      expected[`run-${k + 2}`] = element(`run-${k + 2}`, k);
      expect(elementSlots(d).table).toBe(forked);
      at = d;
    }
    expectSame(at, expected);
    expectSame(freezeElements(at), expected);
    // Element order (what issues are sorted by) still follows key order.
    const order = elementOrder(at);
    const positions = Object.keys(expected).map((id) => order.get(id) ?? -1);
    expect(positions.every((p, i) => p >= 0 && (i === 0 || p > (positions[i - 1] ?? -1)))).toBe(true);
    expect(new Map(order).get("sys")).toBe(order.get("sys"));
    // The attempt and the head still read as they did.
    expectSame(attempt, { ...base.plain, sys: element("sys", 1) });
    expectSame(base.record, base.plain);
  });

  it("a live id removed and put back in one edit moves to the end without rebuilding the record", () => {
    const base = head(2500);
    const draft = draftElements(base.record);
    delete draft["e-3"];
    draft["e-3"] = element("e-3", 7);
    draft["n"] = element("n", 1);
    const expected: Rec = { ...base.plain };
    delete expected["e-3"];
    expected["e-3"] = element("e-3", 7);
    expected["n"] = element("n", 1);
    expectSame(freezeElements(draft), expected);
    const next = draftElements(draft);
    next["m"] = element("m", 2);
    expectSame(next, { ...expected, m: element("m", 2) });
    expect(elementSlots(next).table).toBe(elementSlots(draft).table);
  });

  it("a table that is mostly other revisions' slots is rebuilt compact", () => {
    const base = head(1000);
    for (let s = 0; s < 6; s++) {
      const sib = draftElements(base.record);
      for (let i = 0; i < 1000; i++) sib[`sib-${s}-${i}`] = element(`sib-${s}-${i}`, i);
      elementSlots(sib);
    }
    const draft = draftElements(base.record);
    draft["mine"] = element("mine", 1);
    const slots = elementSlots(draft);
    expect(slots.size).toBe(1001);
    expectSame(draft, { ...base.plain, mine: element("mine", 1) });
  });
});

describe("G-K15-1 through the kernel: batch_edits after a preview", () => {
  const levels = (prefix: string, n: number): Command[] =>
    Array.from({ length: n }, (_, i) => commandSchema.parse({ type: "create_level", levelId: `${prefix}-${i}`, name: `${prefix} ${i}`, elevationMm: 3000 * (i + 1) }));

  it("50 steps share the head's table, land where one-by-one lands, and commit as one revision", () => {
    const model: ModelState = createDemoModel();
    const table = elementSlots(model.elements).table;
    // The operator previewed a different edit on the same head first.
    const preview = executeCommand(model, levels("preview", 1)[0] as Command);
    if (!preview.ok) throw new Error(preview.error.message);
    elementSlots(preview.model.elements);

    const batch = commandSchema.parse({ type: "batch_edits", label: "Fifty levels", commands: levels("lvl", 50) });
    const result = executeCommand(model, batch);
    if (!result.ok) throw new Error(result.error.message);
    expect(elementSlots(result.model.elements).table).toBe(table);

    let oneByOne = model;
    for (const c of levels("lvl", 50)) {
      const r = executeCommand(oneByOne, c);
      if (!r.ok) throw new Error(r.error.message);
      oneByOne = r.model;
    }
    expect(Object.keys(result.model.elements)).toEqual(Object.keys(oneByOne.elements));
    for (const [id, el] of Object.entries(oneByOne.elements)) expect(canonicalJson(result.model.elements[id])).toBe(canonicalJson(el));

    const decision = planCommit(model, [], { idempotencyKey: "k15-store-batch", baseRevision: model.revision, actor: { id: "u1", name: "Avery", kind: "human" }, command: batch });
    if (!decision.ok) throw new Error(decision.error.message);
    expect(decision.model.revision).toBe(model.revision + 1);
    expect(decision.changeset.elements.filter((el) => el.kind === "level")).toHaveLength(50);
    expect(elementSlots(decision.model.elements).table).toBe(table);
  });
});
