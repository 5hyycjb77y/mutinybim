/**
 * @jest-environment node
 *
 * Round 9 P9: a model server builds its head straight from the rows it read
 * (`elementsFromRows`) instead of a plain object the first join indexes
 * again. The record must read exactly like `Object.fromEntries` of the same
 * rows (content, key order, a repeated id, integer-like ids, JSON), be
 * indexed already (the first join pays nothing to index it).
 */
import { elementCount, elementValues, elementsFromRows, elementsOfKind, isFrozenElements, recordSlots, type BimElement, type Level } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";

const level = (id: string, name: string, elevationMm: number): Level => ({ id: id as Level["id"], kind: "level", version: 1, authoredRev: {}, name, elevationMm });

/** Rows as storage hands them back: parsed copies, so no string or object is shared with the generator. */
function parsedRows(elements: readonly BimElement[]): BimElement[] {
  return elements.map((e) => JSON.parse(JSON.stringify(e)) as BimElement);
}

describe("p9-elements-from-rows: the head built from boot rows reads as the plain record did", () => {
  it("a synthetic model: same keys in the same order, same JSON, same counts by kind", () => {
    const model = createFullBimModel(FULL_BIM_TIERS.XS);
    const values = elementValues(model.elements);
    const plain = Object.fromEntries(parsedRows(values).map((e) => [e.id, e]));
    const direct = elementsFromRows(parsedRows(values));
    expect(Object.keys(direct)).toEqual(Object.keys(plain));
    expect(JSON.stringify(direct)).toBe(JSON.stringify(plain));
    expect(elementCount(direct)).toBe(values.length);
    for (const kind of ["level", "run_segment", "part", "space"] as const) expect(elementsOfKind(direct, kind).map((e) => e.id)).toEqual(elementsOfKind(plain, kind).map((e) => e.id));
  });

  it("is committed and already indexed: no plain copy for the first read to index", () => {
    const direct = elementsFromRows([level("l1", "Level 1", 0), level("l2", "Level 2", 4000)]);
    expect(isFrozenElements(direct)).toBe(true);
    expect(recordSlots(direct)?.size).toBe(2);
    expect(() => {
      (direct as Record<string, BimElement>).l3 = level("l3", "Level 3", 8000);
    }).toThrow(TypeError);
  });

  it("a repeated id keeps its first position and its last row, as Object.fromEntries does", () => {
    const rows = [level("a", "A", 0), level("b", "B", 1), level("a", "A again", 2), level("c", "C", 3)];
    const direct = elementsFromRows(rows);
    const plain = Object.fromEntries(rows.map((e) => [e.id, e]));
    expect(Object.keys(direct)).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(direct)).toBe(JSON.stringify(plain));
    expect((direct.a as Level).name).toBe("A again");
  });

  it("integer-like ids come first in numeric order, exactly as on a plain object", () => {
    const rows = [level("z", "Z", 0), level("10", "Ten", 1), level("2", "Two", 2), level("b", "B", 3)];
    const direct = elementsFromRows(rows);
    expect(Object.keys(direct)).toEqual(Object.keys(Object.fromEntries(rows.map((e) => [e.id, e]))));
    expect(Object.keys(direct)).toEqual(["2", "10", "z", "b"]);
  });

  it("refuses a row that is not an element", () => {
    expect(() => elementsFromRows([null as unknown as BimElement])).toThrow(/Not an element row/);
  });
});
