/**
 * @jest-environment node
 */
import {
  asElementId,
  draftElements,
  elementEntries,
  elementOrder,
  elementValues,
  freezeElements,
  isFrozenElements,
  plainElements,
  type BimElement,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

type Rec = Record<string, BimElement>;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function demoElement(): BimElement {
  const [first] = Object.values(createDemoModel().elements);
  if (!first) throw new Error("demo model has no elements");
  return first;
}
const template = demoElement();

function element(id: string, n: number): BimElement {
  return { ...template, id: asElementId(id), version: n };
}

/** Every observable way a caller can read a record must match a plain object built by the same steps. */
function expectSame(actual: Readonly<Rec>, expected: Readonly<Rec>, probe: readonly string[]): void {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  expect(Object.values(actual)).toEqual(Object.values(expected));
  expect(Object.entries(actual)).toEqual(Object.entries(expected));
  expect(elementValues(actual)).toEqual(Object.values(expected));
  expect(elementEntries(actual)).toEqual(Object.entries(expected));
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(Object.keys({ ...actual })).toEqual(Object.keys(expected));
  expect(Object.keys(plainElements(actual))).toEqual(Object.keys(expected));
  for (const id of probe) {
    expect(actual[id]).toBe(expected[id]);
    expect(id in actual).toBe(id in expected);
    expect(Object.prototype.hasOwnProperty.call(actual, id)).toBe(Object.prototype.hasOwnProperty.call(expected, id));
  }
}

describe("copy-on-write element records behave exactly like plain records", () => {
  it("a delete leaves a hole instead of rebuilding the record; putting the id back moves it to the end", () => {
    const plain: Rec = {};
    for (let i = 0; i < 3000; i++) plain[`e-${i}`] = element(`e-${i}`, i);
    const base = freezeElements(draftElements(plain));
    const draft = draftElements(base);
    const added = element("e-new", 1);
    const readded = element("e-17", 99);
    delete draft["e-17"];
    draft["e-new"] = added;
    const after = freezeElements(draft);
    // Same slot table: nothing was re-indexed (the old path rebuilt every element on any delete).
    expect(elementOrder(after)).toBe(elementOrder(base));
    const expected: Rec = { ...plain };
    delete expected["e-17"];
    expected["e-new"] = added;
    expectSame(after, expected, ["e-16", "e-17", "e-18", "e-new"]);
    expectSame(base, plain, ["e-17"]);
    const again = draftElements(after);
    again["e-17"] = readded;
    const back = freezeElements(again);
    expected["e-17"] = readded;
    expectSame(back, expected, ["e-17", "e-new"]);
    expect(Object.keys(back).slice(-2)).toEqual(["e-new", "e-17"]);
    // The revision with the hole is unchanged by the later re-add.
    expect("e-17" in after).toBe(false);
    expect(Object.keys(after)).toHaveLength(3000);
  });

  it("property: random writes, deletes, re-adds, index-like keys and branching revisions", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const ids = Array.from({ length: 1100 + (seed % 3) * 40 }, (_, i) => (r() < 0.05 ? String(Math.floor(r() * 50)) : `el-${i}`));
      const plainStart: Rec = {};
      ids.forEach((id, i) => (plainStart[id] = element(id, i)));
      let frozen = freezeElements(plainStart);
      let mirror: Rec = { ...plainStart };
      const probe = [...new Set([...ids.slice(0, 40), "new-a", "new-b", "7", "77", "constructor", "missing"])];
      expectSame(frozen, mirror, probe);

      for (let rev = 0; rev < 6; rev++) {
        const draft = draftElements(frozen);
        const plain: Rec = { ...mirror };
        const ops = 1 + Math.floor(r() * 30);
        for (let k = 0; k < ops; k++) {
          const roll = r();
          const existing = Object.keys(plain);
          const pick = existing[Math.floor(r() * existing.length)] ?? "el-0";
          if (roll < 0.6) {
            const el = element(pick, rev * 100 + k);
            draft[pick] = el;
            plain[pick] = el;
          } else if (roll < 0.75) {
            const id = r() < 0.3 ? String(100 + Math.floor(r() * 20)) : `new-${seed}-${rev}-${k}`;
            const el = element(id, k);
            draft[id] = el;
            plain[id] = el;
          } else if (roll < 0.9) {
            delete draft[pick];
            delete plain[pick];
          } else {
            const el = element(pick, -k);
            delete draft[pick];
            delete plain[pick];
            draft[pick] = el;
            plain[pick] = el;
          }
        }
        expectSame(draft, plain, probe);
        // A sibling built from the same revision must not see this one's appended keys.
        if (r() < 0.5) {
          const sibling = draftElements(frozen);
          const siblingPlain: Rec = { ...mirror };
          const extra = element(`sibling-${seed}-${rev}`, 1);
          sibling[extra.id] = extra;
          siblingPlain[extra.id] = extra;
          expectSame(freezeElements(draft), plain, probe);
          expectSame(freezeElements(sibling), siblingPlain, probe);
          expectSame(frozen, mirror, probe);
        }
        frozen = freezeElements(draft);
        mirror = plain;
        expectSame(frozen, mirror, probe);
      }
    }
  });

  it("committed records refuse writes loudly; drafts never change the record they came from", () => {
    const base = freezeElements(createDemoModel().elements);
    expect(isFrozenElements(base)).toBe(true);
    const [first] = Object.keys(base);
    if (!first) throw new Error("empty demo");
    const before = base[first];
    const el = base[first];
    if (!el) throw new Error("missing element");
    expect(() => Reflect.set(base, first, { ...el, version: 99 })).toThrow(TypeError);
    expect(() => Reflect.deleteProperty(base, first)).toThrow(TypeError);
    const draft = draftElements(base);
    draft[first] = { ...el, version: 99 };
    expect(base[first]).toBe(before);
    expect(draft[first]?.version).toBe(99);
  });
});
