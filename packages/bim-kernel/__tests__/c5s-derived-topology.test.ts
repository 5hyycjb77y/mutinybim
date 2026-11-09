/**
 * @jest-environment node
 *
 * Round 5c f-scale (audit §4, H): an edit that changes the network's shape
 * (elements removed, added or re-hosted) on a fully derived model no longer
 * falls back to `recomputeDerived` over the whole model. The derived values
 * and the order of `changedIds` equal the full recompute on the same working
 * copy, over random sequences of topology edits.
 *
 * Fails on the old code by the pass count: the fallback walked every element
 * several times (`elementValues` at least twice per edit).
 */
import * as store from "../src/store";
import { asElementId, recomputeDerived, recomputeDerivedAfter, type BimElement, type ElementId, type ModelState } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { airflowOf } from "@permitzip/bim-pack-mechanical";

jest.mock("../src/store", () => {
  const actual: typeof import("../src/store") = jest.requireActual("../src/store");
  return { ...actual, elementValues: jest.fn(actual.elementValues) };
});
const elementValuesSpy = store.elementValues as jest.MockedFunction<typeof store.elementValues>;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T | undefined {
  return xs[Math.floor(r() * xs.length)];
}

type Edit = (w: Record<string, BimElement>) => ElementId[];

function removeOne(el: BimElement | undefined): Edit {
  return (w) => {
    if (!el) return [];
    delete w[el.id];
    return [el.id];
  };
}

/** A topology edit on a model: what it writes into a working copy and the ids it touches. */
function randomTopologyEdit(r: () => number, m: ModelState, step: number): Edit {
  const e = m.elements;
  const roll = r();
  if (roll < 0.25) {
    return removeOne(pick(r, store.elementsOfKind(e, "terminal")));
  }
  if (roll < 0.4) {
    return removeOne(pick(r, store.elementsOfKind(e, "tap")));
  }
  if (roll < 0.55) {
    return removeOne(pick(r, store.elementsOfKind(e, "duct_segment")));
  }
  if (roll < 0.7) {
    // A tap moved to another segment: its branch now hangs under a different trunk.
    const tap = pick(r, store.elementsOfKind(e, "tap"));
    const host = pick(r, store.elementsOfKind(e, "duct_segment"));
    return (w) => {
      if (!tap || !host || host.id === tap.hostId) return [];
      w[tap.id] = { ...tap, hostId: host.id, s: 300 };
      return [tap.id];
    };
  }
  if (roll < 0.85) {
    // A new terminal, connected to nothing yet, and another terminal's airflow changed in the same edit.
    const source = pick(r, store.elementsOfKind(e, "terminal"));
    const other = pick(r, store.elementsOfKind(e, "terminal"));
    return (w) => {
      if (!source || !other) return [];
      const id = asElementId(`c5s-terminal-${step}`);
      w[id] = { ...source, id, cfm: 123 };
      w[other.id] = { ...other, cfm: (airflowOf(other) ?? 0) + 25 };
      return [id, other.id];
    };
  }
  // The element a tag or dimension points at goes away.
  const tag = pick(r, store.elementsOfKind(e, "tag"));
  return (w) => {
    if (!tag || !w[tag.targetId]) return [];
    const target = tag.targetId;
    delete w[target];
    return [target];
  };
}

function values(m: ModelState): string {
  return JSON.stringify(store.elementEntries(m.elements));
}

describe("c5s derived values after a topology edit", () => {
  it("equal the full recompute, values and changedIds order, over random topology edits", () => {
    const start = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5s-topology" });
    for (const seed of [3, 11, 97]) {
      const r = rng(seed);
      let m: ModelState = { ...start, elements: store.freezeElements(start.elements) };
      let compared = 0;
      for (let step = 0; step < 30; step++) {
        const edit = randomTopologyEdit(r, m, step);
        const w1 = store.draftElements(m.elements);
        const w2 = store.draftElements(m.elements);
        const touched = edit(w1);
        if (touched.length === 0) continue;
        expect(edit(w2)).toEqual(touched);
        const fast = recomputeDerivedAfter(m, w1, touched);
        const full = recomputeDerived({ ...m, elements: w2 });
        expect(fast.changedIds).toEqual(full.changedIds);
        expect(values(fast.model)).toBe(values(full.model));
        compared += 1;
        m = { ...fast.model, elements: store.freezeElements(fast.model.elements) };
      }
      expect(compared).toBeGreaterThan(20);
    }
  });

  it("walks the touched paths, not the model", () => {
    const start = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "c5s-topology-count" });
    const m: ModelState = { ...start, elements: store.freezeElements(start.elements) };
    const terminal = store.elementsOfKind(m.elements, "terminal")[3];
    if (!terminal) throw new Error("fixture has no terminal");
    // Establish the base is fully derived (once per model, as a confirmed head already is).
    recomputeDerivedAfter(m, store.draftElements(m.elements), []);
    const w = store.draftElements(m.elements);
    delete w[terminal.id];
    elementValuesSpy.mockClear();
    const out = recomputeDerivedAfter(m, w, [terminal.id]);
    expect(out.changedIds.length).toBeGreaterThan(0);
    expect(elementValuesSpy).not.toHaveBeenCalled();
  });
});
