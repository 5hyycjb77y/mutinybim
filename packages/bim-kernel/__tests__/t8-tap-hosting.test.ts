/**
 * @jest-environment node
 *
 * Round 8 lane T: tap hosting and the tree's totals are an add-on's
 * declaration on the kernel's network adapter hook (`NetworkAdapterItem.tree`,
 * tree-network.ts), not kernel code. Before, the kernel hard-coded the host
 * kind (`TAP_HOST = "duct_segment"`), where a tap sits on it, and the airflow
 * sum (terminal `cfm` into `flowCfm` / `totalCfm`) in network.ts and
 * derived.ts; PR #2937 only renamed those words.
 *
 * - Equivalence: on seeded mechanical models (demo, heavy S, and both with
 *   taps knocked off their hosts, totals zeroed and terminal values changed),
 *   tap positions, airflow totals per element, the order of `changedIds` and
 *   tap placement validity equal the frozen pre-index kernel (./reference).
 * - Incremental edits equal the full recompute and the reference.
 * - A second add-on declares its own tap host and its own quantity on the
 *   same hook, beside the Mechanical add-on's; two add-ons claiming one host
 *   kind are refused loudly.
 * - The kernel's tree code names no host kind and no quantity.
 *
 * Fails on the old code: `NetworkAdapterItem.tree`, `treeNetwork`,
 * `computeTreeTotals` and `NetworkIndex.tree` did not exist, and a pack could
 * not make a riser host taps.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  asElementId,
  computeTreeTotals,
  draftElements,
  elementsOfKind,
  freezeElements,
  isFullyDerived,
  NETWORK_ADAPTER_POINT,
  recomputeDerived,
  recomputeDerivedAfter,
  treeNetwork,
  validateModel,
  type BimElement,
  type ElementId,
  type ModelState,
  type NetworkAdapterItem,
  type RiserSegment,
  type TreeNetworkFace,
  type TreeTotal,
} from "../src";
import {
  type TapFitting,
} from "@permitzip/bim-pack-mechanical";
import { contribute, definePack, PACK_CONTRACT_VERSION, PackSet, withPackSet } from "../src/packs";
import { networkOf } from "../src/network";
import { AIRFLOW_TOTAL, computeAirflow } from "@permitzip/bim-pack-mechanical";
import { createDemoModel, createHeavyModel, HEAVY_TIERS } from "@permitzip/bim-pack-mechanical/seed";
import { computeAirflow as refAirflow, recomputeDerived as refRecompute } from "./reference/derived";
import { validateModel as refValidate } from "./reference/validate";
import { asReference } from "./reference/adapt";
import { airflowOf } from "@permitzip/bim-pack-mechanical";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Taps off their hosts, every total zeroed, a third of the terminals re-valued: everything derived is stale. */
function stale(model: ModelState, seed: number): ModelState {
  const r = rng(seed);
  const w = draftElements(model.elements);
  for (const el of Object.values(model.elements)) {
    if (el.kind === "tap") w[el.id] = { ...el, position: { x: el.position.x + 50, y: el.position.y - 25 } };
    else if (el.kind === "duct_segment") w[el.id] = { ...el, flowCfm: 0 };
    else if (el.kind === "equipment") w[el.id] = { ...el, totalCfm: 1 };
    else if (el.kind === "terminal" && r() < 0.33) w[el.id] = { ...el, cfm: 50 + Math.round(r() * 400) };
  }
  return { ...model, elements: freezeElements(w) };
}

const MODELS: ReadonlyArray<readonly [string, () => ModelState]> = [
  ["demo", () => createDemoModel("t8-demo")],
  ["heavy S", () => createHeavyModel({ ...HEAVY_TIERS.S, modelId: "t8-heavy" })],
  ["demo, stale", () => stale(createDemoModel("t8-demo-stale"), 1)],
  ["heavy S, stale", () => stale(createHeavyModel({ ...HEAVY_TIERS.S, modelId: "t8-heavy-stale" }), 2)],
];

describe("t8 tap hosting and airflow totals: identical to the kernel before the move", () => {
  it.each(MODELS)("%s: tap positions, airflow per element, changedIds order and tap validity", (_name, build) => {
    const model = build();
    const got = recomputeDerived(model);
    const want = refRecompute(asReference(model));
    expect(got.changedIds).toEqual(want.changedIds);
    for (const id of want.changedIds) expect(got.model.elements[id]).toEqual(want.model.elements[id]);
    expect(Object.fromEntries(computeAirflow(model))).toEqual(Object.fromEntries(refAirflow(asReference(model))));
    expect(isFullyDerived(got.model)).toBe(true);
    expect(validateModel(got.model)).toEqual(refValidate(asReference(got.model)));
  });

  it("a stale model really is stale (the comparison above is not vacuous)", () => {
    const model = stale(createDemoModel("t8-check"), 3);
    const changed = recomputeDerived(model).changedIds.map((id) => model.elements[id]?.kind);
    expect(new Set(changed)).toEqual(new Set(["tap", "duct_segment", "equipment"]));
  });

  it("incremental edits (terminal values, taps slid, terminals removed) equal the full recompute and the reference", () => {
    const head = recomputeDerived(createHeavyModel({ ...HEAVY_TIERS.S, modelId: "t8-edits" })).model;
    expect(isFullyDerived(head)).toBe(true);
    const terminals = elementsOfKind(head.elements, "terminal");
    const taps = elementsOfKind(head.elements, "tap");
    const r = rng(7);
    for (let i = 0; i < 30; i++) {
      const w: Record<string, BimElement> = draftElements(head.elements);
      const touched: ElementId[] = [];
      const kind = i % 3;
      if (kind === 0) {
        const t = terminals[Math.floor(r() * terminals.length)];
        if (!t) continue;
        w[t.id] = { ...t, cfm: (airflowOf(t) ?? 0) + 25 + i };
        touched.push(t.id);
      } else if (kind === 1) {
        const tap = taps[Math.floor(r() * taps.length)];
        if (!tap) continue;
        w[tap.id] = { ...tap, s: tap.s + 100 };
        touched.push(tap.id);
      } else {
        const t = terminals[Math.floor(r() * terminals.length)];
        if (!t) continue;
        delete w[t.id];
        touched.push(t.id);
      }
      const full = recomputeDerived({ ...head, elements: freezeElements(draftElements(w)) });
      const ref = refRecompute(asReference({ ...head, elements: freezeElements(draftElements(w)) }));
      const after = recomputeDerivedAfter(head, w, touched);
      expect(after.changedIds).toEqual(full.changedIds);
      expect(full.changedIds).toEqual(ref.changedIds);
      for (const id of full.changedIds) {
        expect(after.model.elements[id]).toEqual(full.model.elements[id]);
        expect(full.model.elements[id]).toEqual(ref.model.elements[id]);
      }
      expect(after.changedIds.length).toBeGreaterThan(0);
    }
  });

  it("the Mechanical add-on declares the host and the quantity; the kernel resolves them from the pack set", () => {
    const tree = treeNetwork();
    expect(tree.hostsTaps("duct_segment")).toBe(true);
    const duct = elementsOfKind(createDemoModel("t8-span").elements, "duct_segment")[0];
    expect(duct && tree.tapSpan(duct)).toBe(duct ? Math.hypot(duct.end.x - duct.start.x, duct.end.y - duct.start.y) : null);
    expect(tree.totals).toContain(AIRFLOW_TOTAL);
    const declared = PackSet.create([]).items(NETWORK_ADAPTER_POINT).filter((i) => i.tree);
    expect(declared.map((i) => i.id)).toEqual(["mechanical"]);
  });
});

/** A second add-on on the same hook: risers host taps, and it counts the leaves below each node (stored nowhere). */
const LEAVES: TreeTotal = {
  id: "t8riser.leaves",
  ownKinds: ["terminal"],
  own: (el) => (el.kind === "terminal" ? 1 : undefined),
  storedKinds: [],
  stored: () => undefined,
  withTotal: (el) => el,
};

const RISER_TREE: TreeNetworkFace = {
  tapHosts: [{ kind: "riser_segment", place: (host, tap) => (host.kind === "riser_segment" ? { x: host.position.x + 100 * tap.side, y: host.position.y + tap.s } : null), span: (host) => (host.kind === "riser_segment" ? 3000 : null) }],
  totals: [LEAVES],
};

const RISER_ADAPTER: NetworkAdapterItem = { id: "t8riser.tree", tree: RISER_TREE };

const RISER_PACK = definePack({ id: "t8riser", name: "Riser test add-on", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(NETWORK_ADAPTER_POINT, [RISER_ADAPTER])]);
const WITH_RISER = PackSet.create([RISER_PACK]);

/** The demo model with one riser, and one of its taps moved off its duct onto the riser. */
function withRiserTap(): { readonly model: ModelState; readonly riser: RiserSegment; readonly tap: TapFitting; readonly duct: ElementId } {
  const base = recomputeDerived(createDemoModel("t8-riser")).model;
  const tap = elementsOfKind(base.elements, "tap")[0];
  if (!tap) throw new Error("demo model has no tap");
  const riser: RiserSegment = { id: asElementId("t8-riser-1"), version: 1, authoredRev: {}, kind: "riser_segment", riserId: "R-1", service: "sprinkler", position: { x: 1000, y: 2000 }, profile: { shape: "round", diameter: 100 } };
  const w = draftElements(base.elements);
  w[riser.id] = riser;
  const moved: TapFitting = { ...tap, hostId: riser.id, s: 300 };
  w[tap.id] = moved;
  return { model: { ...base, elements: freezeElements(w) }, riser, tap: moved, duct: tap.hostId };
}

describe("t8 a second add-on declares its own tap host on the same hook", () => {
  it("risers host taps under its set: the tap is placed by its rule and hangs under the riser in the tree", () => {
    const { model, riser, tap } = withRiserTap();
    withPackSet(WITH_RISER, () => {
      const tree = treeNetwork();
      expect(tree.hostsTaps("riser_segment")).toBe(true);
      expect(tree.hostsTaps("duct_segment")).toBe(true);
      expect(tree.tapSpan(riser)).toBe(3000);
      const out = recomputeDerived(model);
      const placed = out.model.elements[tap.id];
      expect(placed?.kind === "tap" ? placed.position : null).toEqual({ x: 1000 + 100 * tap.side, y: 2300 });
      expect(out.changedIds).toContain(tap.id);
      const net = networkOf(out.model);
      expect(net.children(riser.id)).toEqual([tap.id]);
      expect(net.parent(tap.id)).toBe(riser.id);
      // Its own quantity, beside airflow: the leaves below the riser are the leaves below the moved tap.
      const leaves = computeTreeTotals(out.model, LEAVES);
      const below = (id: ElementId): number => (out.model.elements[id]?.kind === "terminal" ? 1 : 0) + net.children(id).reduce((n, c) => n + below(c), 0);
      expect(leaves.get(riser.id)).toBe(below(tap.id));
      expect(leaves.get(riser.id)).toBeGreaterThan(0);
      expect(isFullyDerived(out.model)).toBe(true);
    });
  });

  it("without the add-on the riser hosts nothing: the tap stays where it is and hangs under no one", () => {
    const { model, riser, tap } = withRiserTap();
    expect(treeNetwork().hostsTaps("riser_segment")).toBe(false);
    const out = recomputeDerived(model);
    expect(out.changedIds).not.toContain(tap.id);
    expect(networkOf(out.model).children(riser.id)).toEqual([]);
    expect(networkOf(out.model).parent(tap.id)).toBeUndefined();
  });

  it("an index built under one set is not reused under another that declares other hosts", () => {
    const { model, riser } = withRiserTap();
    expect(networkOf(model).children(riser.id)).toEqual([]);
    withPackSet(WITH_RISER, () => expect(networkOf(model).children(riser.id)).toHaveLength(1));
    expect(networkOf(model).children(riser.id)).toEqual([]);
  });

  it("two add-ons claiming one host kind are refused, loudly", () => {
    const clash: TreeNetworkFace = { tapHosts: [{ kind: "duct_segment", place: () => null, span: () => null }] };
    const pack = definePack({ id: "t8clash", name: "Clash", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(NETWORK_ADAPTER_POINT, [{ id: "t8clash.tree", tree: clash }])]);
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => withPackSet(PackSet.create([pack]), () => treeNetwork())).toThrow(/two add-ons declare that duct_segment hosts taps/);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("t8 the kernel's tree code names no host kind and no quantity", () => {
  const src = (f: string) => readFileSync(path.resolve(__dirname, "../src", f), "utf8");

  it("derived.ts and tree-network.ts name no element field a trade keeps or reads", () => {
    for (const f of ["derived.ts", "tree-network.ts"]) {
      expect([f, src(f).match(/duct_segment|flowCfm|totalCfm|\.cfm\b|"terminal"/g) ?? []]).toEqual([f, []]);
    }
  });

  it("network.ts has no tap host and no quantity, and names no duct kind (connector ends are the add-ons' kind rows since round 10 K10)", () => {
    const text = src("network.ts");
    expect(text.match(/TAP_HOST|flowCfm|totalCfm|\.cfm\b/g) ?? []).toEqual([]);
    expect(text.split("\n").filter((l) => /duct_segment|"tap"|"equipment"/.test(l)).map((l) => l.trim())).toEqual([]);
  });
});
