/**
 * @jest-environment node
 *
 * Stacks as named objects (ROADMAP P6): a stack is a vertical run of sanitary,
 * vent or storm pipe, read from the drawn pipe (floors, size, running DFU,
 * offsets, rooms served) and named with a number a person gives it. Its tag
 * prints `4"//S/K/L//19` from fields. Before this change there was no stack
 * anywhere in the kernel: Plumbing Demo 2 typed the tag by hand, so every case
 * here fails on the old code (stacksOf, name_stacks and stack.* fields did not
 * exist).
 */
import { fieldProviderRegistry, type ModelState } from "@permitzip/bim-kernel";
import { advanceStackRunIndex, resolveStackField, stackAt, stackRunIndex, stacksOf, verticalRunIndex, verticalRunStats, stackFilter, type StackView } from "../src";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";
import { STACK_SAN, STACK_VENT, stackRisers } from "../../bim-kernel/__tests__/fixtures/stack-risers";

const FT = 304.8;
const IN = 25.4;
const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });

function sanitary(model: ModelState): StackView {
  const s = stacksOf(model.elements).stacks.find((x) => x.systemId === STACK_SAN.id && x.chain.offsets.length === 0);
  if (!s) throw new Error("no sanitary stack");
  return s;
}

/** A 3" sanitary stack with a 2 ft 45° offset on Level 2 (walls that don't line up), drawn top down. */
function withOffset(b: Building): void {
  b.ok({ type: "route_run", idPrefix: "off", levelId: "lvl-1", domain: "pipe", size: pvc(3), elevationMm: 30 * FT, system: STACK_SAN, points: [{ x: 30 * FT, y: 0 }, { x: 30 * FT, y: 0, elevationMm: 18 * FT }, { x: 32 * FT, y: 0, elevationMm: 16 * FT }, { x: 32 * FT, y: 0, elevationMm: 2 * FT }] });
}

describe("stacks from the drawn pipe", () => {
  it("finds the 4\" sanitary stack and the 3\" vent stack of the three-storey restroom stack, and not the water risers", () => {
    const b = stackRisers();
    const list = stacksOf(b.head.elements);
    expect(list.stacks.map((s) => [s.systemId, s.sizeIn, s.floors.length, s.tag])).toEqual([
      [STACK_SAN.id, 4, 3, '4"//S//?'],
      [STACK_VENT.id, 3, 3, '3"//V//?'],
    ]);
    const san = sanitary(b.head);
    // Running DFU per floor, bottom up: all 30 at the base, 10 from Level 3 through Level 2, nothing above the top branch.
    expect(san.floors.map((f) => [f.levelName, f.sizeIn, f.dfu])).toEqual([
      ["Level 1", 4, 30],
      ["Level 2", 4, 10],
      ["Level 3", 4, 0],
    ]);
    expect(san.dfuAtBase).toBe(30);
    expect(san.chain.base).not.toBeNull();
    expect(list.lost).toEqual([]);
  });

  it("lists an offset on the floor it is on, with its length and direction", () => {
    const b = stackRisers();
    withOffset(b);
    const off = stacksOf(b.head.elements).stacks.find((s) => s.chain.offsets.length > 0);
    expect(off?.floors.map((f) => [f.levelName, f.offsets.map((o) => o.text)])).toEqual([
      ["Level 1", []],
      ["Level 2", ["2'-0\" east"]],
      ["Level 3", []],
    ]);
    expect(off?.chain.offsetBends).toHaveLength(2);
  });

  it("names the stacks with the next numbers in one edit, refuses a duplicate number, a second name for the same run and a pipe that isn't a stack", () => {
    const b = stackRisers();
    const san = sanitary(b.head);
    const vent = stacksOf(b.head.elements).stacks.find((s) => s.systemId === STACK_VENT.id);
    b.ok({ type: "name_stacks", stacks: [{ stackId: "stk-a", pipeId: san.key }, { stackId: "stk-b", pipeId: vent?.key ?? "" }] });
    expect(stacksOf(b.head.elements).stacks.map((s) => s.tag)).toEqual(['4"//S//1', '3"//V//2']);

    expect(b.refused({ type: "edit_stack", stackId: "stk-b", number: "1" })).toBe("Stack 1 already exists. Give this one another number, or renumber stack 1 first");
    expect(b.refused({ type: "name_stacks", stacks: [{ stackId: "stk-c", pipeId: san.chain.pieces[1] ?? "" }] })).toBe("That pipe is already stack 1. Rename stack 1 instead");
    expect(b.refused({ type: "name_stacks", stacks: [{ stackId: "stk-d", pipeId: san.chain.base?.drainId ?? "" }] })).toMatch(/isn't a vertical sanitary, vent or storm pipe/);
    expect(b.refused({ type: "name_stacks", stacks: [{ stackId: "stk-e", pipeId: "cw-s1" }] })).toMatch(/isn't a vertical sanitary, vent or storm pipe/);

    // 19, kitchen and laundry: the tag reads as on the 6144 plans.
    b.ok({ type: "edit_stack", stackId: "stk-a", number: "19", serves: "K/L", name: "Kitchen stack" });
    const s19 = stackAt(b.head.elements, san.chain.pieces[2] ?? san.key);
    expect(s19?.tag).toBe('4"//S/K/L//19');
    expect(s19?.name).toBe("Kitchen stack");
    // Back to the derived codes.
    b.ok({ type: "edit_stack", stackId: "stk-a", serves: null });
    expect(stackAt(b.head.elements, san.key)?.tag).toBe('4"//S//19');

    // Removing the name keeps the pipe; the stack is listed again without a number.
    b.ok({ type: "delete_stacks", stackIds: ["stk-a"] });
    expect(stacksOf(b.head.elements).stacks.map((s) => s.tag)).toEqual(['3"//V//2', '4"//S//?']);
  });

  it("rooms served come from the rooms its branches reach", () => {
    const b = stackRisers();
    b.ok({ type: "add_architecture", levelId: "lvl-1", walls: [], openings: [], rooms: [{ roomId: "rm-toilets", number: "101", name: "Toilets", outline: [{ x: -2 * FT, y: -2 * FT }, { x: 20 * FT, y: -2 * FT }, { x: 20 * FT, y: 6 * FT }, { x: -2 * FT, y: 6 * FT }] }], casework: [] });
    const san = sanitary(b.head);
    expect(san.rooms).toEqual(["Toilets"]);
    expect(san.servesCode).toBe("T");
    expect(san.tag).toBe('4"//S/T//?');
  });

  it("prints from fields on any of its pipes: stack.tag, stack.number, stack.size, stack.dfu", () => {
    const b = stackRisers();
    const san = sanitary(b.head);
    b.ok({ type: "name_stacks", stacks: [{ stackId: "stk-a", pipeId: san.key, number: "19", serves: "K/L" }] });
    const pipe = san.chain.pieces[1] ?? san.key;
    expect(resolveStackField(b.head.elements, pipe, "stack.tag")).toEqual({ value: '4"//S/K/L//19', text: '4"//S/K/L//19' });
    expect(resolveStackField(b.head.elements, pipe, "stack.size")?.text).toBe('4"');
    expect(resolveStackField(b.head.elements, pipe, "stack.dfu")?.value).toBe(30);
    expect(resolveStackField(b.head.elements, "cw-s1", "stack.number")).toEqual({ value: null, text: "" });
    expect(resolveStackField(b.head.elements, pipe, "pipe.size")).toBeNull();
    // Schedules and Properties read the same values through the field registry.
    const fields = fieldProviderRegistry().fieldsFor("mep.pipe").map((f) => f.path);
    expect(fields).toEqual(expect.arrayContaining(["stack.tag", "stack.number", "stack.serves", "stack.dfu"]));
  });
});

describe("stack derivation is incremental", () => {
  it("after an edit, only the stack it touched is walked again, and the result equals a full rebuild", () => {
    const b = stackRisers();
    withOffset(b);
    const base = b.head;
    const before = stackRunIndex(base.elements);
    expect(before.chains).toHaveLength(3);
    const off = before.chains.find((c) => c.offsets.length > 0);
    const target = off?.pieces[0] ?? "";
    const cs = b.ok({ type: "route_run", idPrefix: "late", levelId: "lvl-1", domain: "pipe", size: pvc(2), elevationMm: 6 * FT, system: STACK_SAN, points: [{ x: 40 * FT, y: 0 }, { x: 32 * FT, y: 0 }], to: { kind: "run_branch", segmentId: target } });
    const changed = [...cs.elements.map((e) => e.id), ...(cs.removedIds ?? [])];
    const walkedBefore = verticalRunStats.walked;
    const advanced = advanceStackRunIndex(base.elements, b.head.elements, changed);
    expect(verticalRunStats.walked - walkedBefore).toBe(1);
    const fresh = verticalRunIndex({ ...b.head.elements }, stackFilter);
    const shape = (idx: typeof advanced) => idx.chains.map((c) => ({ key: c.key, pieces: c.pieces, offsets: c.offsets, base: c.base }));
    expect(shape(advanced)).toEqual(shape(fresh));
    // The untouched stacks are the same objects: kept, not rebuilt.
    const untouched = before.chains.filter((c) => c !== off);
    for (const c of untouched) expect(advanced.chains).toContain(c);
  });
});
