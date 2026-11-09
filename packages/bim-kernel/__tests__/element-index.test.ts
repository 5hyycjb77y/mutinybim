/**
 * @jest-environment node
 *
 * The indexed element reads must equal the plain-object reads they replace,
 * on committed records, plain records and drafts (predictions), including
 * removals, re-additions and elements whose chunk a commit copied.
 */
import { draftElements, elementCount, elementEntries, elementKeys, elementValues, elementsOfKind, freezeElements, type BimElement } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

function sameAsPlain(record: Readonly<Record<string, BimElement>>): void {
  expect(elementValues(record)).toEqual(Object.values(record));
  expect(elementEntries(record)).toEqual(Object.entries(record));
  expect(elementKeys(record)).toEqual(Object.keys(record));
  expect(elementCount(record)).toBe(Object.keys(record).length);
  expect(elementsOfKind(record, "tap")).toEqual(Object.values(record).filter((el) => el.kind === "tap"));
  expect(elementsOfKind(record, "duct_segment", "terminal")).toEqual(Object.values(record).filter((el) => el.kind === "duct_segment" || el.kind === "terminal"));
}

describe("indexed element reads", () => {
  const model = createDemoModel();
  const frozen = freezeElements(model.elements);

  it("match plain reads on committed and plain records", () => {
    sameAsPlain(frozen);
    sameAsPlain({ ...model.elements });
  });

  it("match plain reads on a draft with writes, removals and a re-added id", () => {
    const draft = draftElements(frozen);
    const [first, second, third] = Object.values(frozen);
    if (!first || !second || !third) throw new Error("demo model too small");
    draft[first.id] = { ...first, version: first.version + 1 };
    Reflect.deleteProperty(draft, second.id);
    Reflect.deleteProperty(draft, third.id);
    draft[third.id] = { ...third, version: third.version + 7 };
    draft["perf-new"] = { ...first, id: "perf-new" as BimElement["id"] } as BimElement;
    sameAsPlain(draft);
    // And on the next revision, which shares every chunk the draft did not write.
    const next = freezeElements(draft);
    sameAsPlain(next);
    sameAsPlain(frozen);
  });
});
