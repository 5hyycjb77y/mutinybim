/**
 * @jest-environment node
 *
 * t8-bare-kernel-tree (@mutinybim-bare-kernel): with no add-on in force the
 * kernel hosts no taps and totals nothing, so a model whose taps are off
 * their ducts and whose airflow is zeroed stays exactly as stored. With the
 * Mechanical add-on alone the same model derives exactly as the kernel did
 * before round 8 lane T (tap positions and airflow per element); with only
 * another add-on (risers host taps) its taps are placed and the ducts' are
 * not. Before lane T the kernel did the air side itself, whatever was loaded.
 * Round 11 K11: only a kind whose row places it is placed; that other add-on
 * places its own clamp, and a tap (Mechanical's kind) is kept as stored.
 */
import { asElementId, draftElements, ELEMENT_KIND_POINT, elementsOfKind, freezeElements, NETWORK_ADAPTER_POINT, recomputeDerived, treeNetwork, type BimElement, type ModelState, type RiserSegment } from "@permitzip/bim-kernel";
import { type TapFitting } from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { activePackSet, contribute, definePack, PACK_CONTRACT_VERSION, PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { recomputeDerived as refRecompute } from "../../bim-kernel/__tests__/reference/derived";
import { asReference } from "../../bim-kernel/__tests__/reference/adapt";
import { MECHANICAL_PACK } from "../src";

const MECHANICAL = PackSet.create([MECHANICAL_PACK]);

/** The demo model with every tap pushed off its duct and every total zeroed. */
function stale(): ModelState {
  const m = createDemoModel("t8-bare");
  const w = draftElements(m.elements);
  for (const el of Object.values(m.elements)) {
    if (el.kind === "tap") w[el.id] = { ...el, position: { x: el.position.x + 40, y: el.position.y + 40 } };
    else if (el.kind === "duct_segment") w[el.id] = { ...el, flowCfm: 0 };
    else if (el.kind === "equipment") w[el.id] = { ...el, totalCfm: 0 };
  }
  return { ...m, elements: freezeElements(w) };
}

describe("t8-bare-kernel-tree", () => {
  it("with no add-on, nothing declares a tree: no tap moves, no total changes", () => {
    expect(activePackSet().items(NETWORK_ADAPTER_POINT)).toEqual([]);
    const tree = treeNetwork();
    expect(tree.hostsTaps("duct_segment")).toBe(false);
    expect(tree.totals).toEqual([]);
    expect(recomputeDerived(stale()).changedIds).toEqual([]);
  });

  it("with the Mechanical add-on alone, the stale model derives exactly as the kernel did before", () => {
    const model = stale();
    const want = refRecompute(asReference(model));
    expect(want.changedIds.length).toBeGreaterThan(0);
    withPackSet(MECHANICAL, () => {
      const got = recomputeDerived(model);
      expect(got.changedIds).toEqual(want.changedIds);
      for (const id of want.changedIds) expect(got.model.elements[id]).toEqual(want.model.elements[id]);
    });
  });

  it("with only another add-on (risers host its clamps), its clamp is placed and the ducts' taps are left alone", () => {
    // Round 11 K11: placement is the hosted kind's row (`hostedBy.placement`), so the add-on brings its own hosted kind.
    const pack = definePack({ id: "t8bare", name: "Riser test add-on", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [
      contribute(NETWORK_ADAPTER_POINT, [{ id: "t8bare.tree", tree: { tapHosts: [{ kind: "riser_segment", place: (host, tap) => (host.kind === "riser_segment" ? { x: host.position.x, y: host.position.y + tap.s } : null), span: () => 1000 }] } }]),
      contribute(ELEMENT_KIND_POINT, [{ kind: "t8bare.clamp", label: "Riser clamp", nature: "physical", connectorEnds: { ends: [{ end: "host", role: "upstream" }], hostedBy: { field: "hostId", placement: { along: "s", side: "side", at: "position" } } } }]),
    ]);
    const model = stale();
    const tap = elementsOfKind(model.elements, "tap")[0];
    if (!tap) throw new Error("demo model has no tap");
    const riser: RiserSegment = { id: asElementId("t8-bare-riser"), version: 1, authoredRev: {}, kind: "riser_segment", riserId: "R-1", service: "water", position: { x: 500, y: 700 }, profile: { shape: "round", diameter: 80 } };
    const clamp = { id: asElementId("t8-bare-clamp"), version: 1, authoredRev: {}, kind: "t8bare.clamp", hostId: riser.id, s: 250, side: 1, position: { x: 0, y: 0 } } as unknown as BimElement;
    // A tap moved onto the riser: its own add-on (Mechanical) isn't loaded here, so it is kept as stored, never placed (round 10 placed it).
    const moved: TapFitting = { ...tap, hostId: riser.id, s: 250 };
    const w = draftElements(model.elements);
    w[riser.id] = riser;
    w[clamp.id] = clamp;
    w[moved.id] = moved;
    withPackSet(PackSet.create([pack]), () => {
      const out = recomputeDerived({ ...model, elements: freezeElements(w) });
      expect(out.changedIds).toEqual([clamp.id]);
      expect(Reflect.get(out.model.elements[clamp.id] ?? {}, "position")).toEqual({ x: 500, y: 950 });
      expect(out.model.elements[moved.id]).toBe(moved);
    });
  });
});
