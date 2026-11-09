/**
 * @jest-environment node
 *
 * A13b, the product owner's decision 2: removing the separation line merges the
 * sub-rooms back. `merge_space_children` drops the line and the sub-rooms,
 * puts the by-area load back on the room once, and moves every other load
 * on a sub-room (the copier, one added after the split) back to the room.
 * Undo of the split restores the room and its loads exactly.
 *
 * Fails on round 12's code: there is no `split_space` or
 * `merge_space_children`.
 */
import { asElementId, canonicalJson, type BimElement } from "../src";
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { Log } from "./a13a-fixtures";
import { LINE, officeWithLoads, vaOn } from "./a13b-split-fixtures";

const ID = "a13b-merge";

beforeAll(() => bindModelPacks(ID, PackSet.create([])));
afterAll(() => unbindModelPacks(ID));

/** Every record without its revision stamps (an undo or a re-made record is a new revision). */
function content(elements: Readonly<Record<string, BimElement>>): string {
  const strip = (el: BimElement | undefined) => {
    if (!el) return null;
    const { version: _v, authoredRev: _a, classId: _c, classSource: _s, schemaVersion: _sv, ...rest } = el as BimElement & { classId?: unknown; classSource?: unknown; schemaVersion?: unknown };
    return rest;
  };
  return canonicalJson(Object.fromEntries(Object.keys(elements).sort().map((k) => [k, strip(elements[k])])));
}

describe("a13b merge back", () => {
  it("merge drops the line and the sub-rooms and puts every load back on the room", () => {
    const m = officeWithLoads(ID);
    const before = content(m.head.elements);
    const total = vaOn(m, "s-101");
    m.ok({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101B" });
    const late = { id: asElementId("lp-late"), kind: "load_point", version: 1, authoredRev: {}, connectionType: "", values: { va: 50 }, anchor: { kind: "space", id: "s-101-A" } } as unknown as BimElement;
    const withLate = new Log({ ...m.head, elements: { ...m.head.elements, [late.id]: late } });
    withLate.ok({ type: "merge_space_children", spaceId: "s-101" });
    const els = withLate.head.elements;
    expect(["s-101-A", "s-101-B", "s-101:line", "lp-lights@s-101-A", "lp-lights@s-101-B"].map((id) => els[id])).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(vaOn(withLate, "s-101")).toBeCloseTo(total + 50, 6);
    const { "lp-late": _late, ...rest } = els;
    expect(content(rest)).toBe(before);
  });

  it("undo of the split restores the room and its loads exactly", () => {
    const m = officeWithLoads(ID);
    const before = content(m.head.elements);
    const cs = m.ok({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101A" });
    m.ok({ type: "undo", revision: cs.revision });
    expect(content(m.head.elements)).toBe(before);
  });

  it("a room that isn't split has nothing to merge; a split room can't be split again", () => {
    const m = officeWithLoads(ID);
    expect(m.refused({ type: "merge_space_children", spaceId: "s-101" })).toBe("Office 101 isn't split; there is nothing to merge");
    m.ok({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101A" });
    expect(m.refused({ type: "split_space", spaceId: "s-101", line: LINE, separatorId: "x", typedLoadsTo: "101A" })).toBe("Office 101 is already split into 101A and 101B. Split one of those, or remove the line first");
  });
});
