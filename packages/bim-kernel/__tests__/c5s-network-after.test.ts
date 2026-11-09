/**
 * @jest-environment node
 *
 * Round 5c f-scale: the topology index after an edit that removes or
 * re-hosts elements is derived from the revision before (`NetworkIndex.after`,
 * the touched rows rebuilt) instead of rebuilt. Over random chains of edits
 * (network pieces, equipment, hosted taps, tags and openings removed; taps
 * re-hosted; tags re-targeted) it answers every query exactly as a fresh
 * build of the same revision, including the lazy walks (airflow rank, sort
 * by airflow, slot totals, disconnected pieces).
 *
 * Fails on the old code: `NetworkIndex.after` did not exist; every topology
 * edit rebuilt the index over the whole model (~90 ms at 250k).
 */
import { asElementId, draftElements, elementsOfKind, elementValues, freezeElements, type BimElement, type ConnectorEnd, type ElementId, type ModelState } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { NetworkIndex } from "../src/network";

const ENDS: readonly ConnectorEnd[] = ["start", "end", "in", "out", "branch", "host"];

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

function probeIds(model: Pick<ModelState, "elements" | "connections">, extra: readonly string[]): ElementId[] {
  const ids = new Set<string>(extra);
  for (const e of elementValues(model.elements)) {
    ids.add(e.id);
    if (e.kind === "tap" || e.kind === "opening") ids.add(e.hostId);
    if (e.kind === "tag") ids.add(e.targetId);
  }
  for (const c of model.connections) {
    ids.add(c.a.elementId);
    ids.add(c.b.elementId);
  }
  ids.add("no-such-element");
  return [...ids].map(asElementId);
}

function expectSame(got: NetworkIndex, fresh: NetworkIndex, model: Pick<ModelState, "elements" | "connections">, probe: readonly ElementId[]): void {
  expect(got.isTree).toBe(fresh.isTree);
  expect(got.order).toBe(fresh.order);
  expect(got.size).toBe(fresh.size);
  expect(got.disconnected()).toEqual(fresh.disconnected());
  for (const id of probe) {
    expect([id, got.children(id)]).toEqual([id, fresh.children(id)]);
    expect([id, got.parent(id)]).toEqual([id, fresh.parent(id)]);
    expect([id, got.hostedTaps(id)]).toEqual([id, fresh.hostedTaps(id)]);
    expect([id, got.dependents(id)]).toEqual([id, fresh.dependents(id)]);
    expect([id, got.connectionPositionsOf(id)]).toEqual([id, fresh.connectionPositionsOf(id)]);
    for (const end of ENDS) expect(got.connectionAt(id, end)).toBe(fresh.connectionAt(id, end));
    expect([id, got.airflowRank(id)]).toEqual([id, fresh.airflowRank(id)]);
  }
  const risers = new Set<string>();
  for (const e of elementsOfKind(model.elements, "riser_segment")) risers.add(e.riserId);
  for (const riser of [...risers, "no-such-riser"]) expect(got.riserSegments(riser)).toEqual(fresh.riserSegments(riser));
  const r = rng(probe.length);
  for (let i = 0; i < 10; i++) {
    const subset = probe.filter(() => r() < 0.1);
    expect(got.sortByAirflow(subset)).toEqual(fresh.sortByAirflow(subset));
  }
  const read = fresh.readerFor(model.elements);
  // The tree's totals (the first-party air tree is installed in every test that reaches the engine).
  expect(got.tree.totals.length).toBeGreaterThan(0);
  const terminals = elementsOfKind(model.elements, "terminal").slice(0, 5).map((t) => t.id);
  for (const quantity of got.tree.totals) {
    expect(got.totalsBySlot(quantity, read)).toEqual(fresh.totalsBySlot(quantity, read));
    expect(got.totalsAfter(quantity, terminals, read)).toEqual(fresh.totalsAfter(quantity, terminals, read));
  }
}

type Edit = (w: Record<string, BimElement>) => string[];

function randomEdit(r: () => number, m: ModelState): Edit {
  const e = m.elements;
  const remove = (el: BimElement | undefined): Edit => (w) => {
    if (!el) return [];
    delete w[el.id];
    return [el.id];
  };
  const roll = r();
  if (roll < 0.2) return remove(pick(r, elementsOfKind(e, "terminal")));
  if (roll < 0.35) return remove(pick(r, elementsOfKind(e, "duct_segment")));
  if (roll < 0.45) return remove(pick(r, elementsOfKind(e, "tap")));
  if (roll < 0.5) return remove(pick(r, elementsOfKind(e, "equipment")));
  if (roll < 0.6) return remove(pick(r, elementsOfKind(e, "tag", "opening", "riser_segment", "elbow")));
  if (roll < 0.8) {
    const tap = pick(r, elementsOfKind(e, "tap"));
    const host = pick(r, elementsOfKind(e, "duct_segment"));
    return (w) => {
      if (!tap || !host || !w[tap.id]) return [];
      w[tap.id] = { ...tap, hostId: r() < 0.1 ? asElementId("ghost-host") : host.id };
      return [tap.id];
    };
  }
  const tag = pick(r, elementsOfKind(e, "tag"));
  const target = pick(r, elementValues(e));
  return (w) => {
    if (!tag || !target || !w[tag.id]) return [];
    w[tag.id] = { ...tag, targetId: target.id };
    return [tag.id];
  };
}

describe("c5s topology index derived after an edit", () => {
  for (const [name, make, least] of [
    ["full-BIM XS", () => createFullBimModel(FULL_BIM_TIERS.XS), 8],
    ["demo", () => createDemoModel(), 3],
  ] as const) {
    it(`${name}: chains of edits answer exactly as a fresh build`, () => {
      const start = make();
      for (const seed of [1, 9, 77]) {
        const r = rng(seed);
        let m: ModelState = { ...start, elements: freezeElements(start.elements) };
        let index = new NetworkIndex(m.connections, m.elements);
        const probe = probeIds(m, []);
        let derived = 0;
        for (let step = 0; step < 20; step++) {
          const w = draftElements(m.elements);
          const changed = randomEdit(r, m)(w);
          if (changed.length === 0) continue;
          const to = step % 2 === 0 ? freezeElements(w) : w;
          const after = NetworkIndex.after(index, to, changed);
          const fresh = new NetworkIndex(m.connections, to);
          if (after) {
            derived += 1;
            expectSame(after, fresh, { elements: to, connections: m.connections }, probe);
          } else expect(fresh.isTree && index.isTree).toBe(false);
          m = { ...m, elements: to };
          index = after ?? fresh;
        }
        expect(derived).toBeGreaterThan(least);
      }
    });
  }

  it("refuses an edit that adds an element (a fresh build serves it)", () => {
    const start = createFullBimModel(FULL_BIM_TIERS.XS);
    const m: ModelState = { ...start, elements: freezeElements(start.elements) };
    const index = new NetworkIndex(m.connections, m.elements);
    const terminal = elementsOfKind(m.elements, "terminal")[0];
    if (!terminal) throw new Error("fixture");
    const added = draftElements(m.elements);
    added["c5s-new"] = { ...terminal, id: asElementId("c5s-new") };
    expect(NetworkIndex.after(index, freezeElements(added), ["c5s-new"])).toBeNull();
  });
});
