/**
 * @jest-environment node
 *
 * Round 8 close-out: the tap checks in validate.ts and the host check of
 * `slide_branch` ask the tree face of the pack set in force (`treeNetwork()`)
 * which kinds host taps and how far `s` runs along one, instead of testing
 * for `duct_segment` and the duct's length.
 *
 * Fails on the old code: a tap on a riser was "has no host" even under an
 * add-on that lets risers host taps, `slide_branch` refused it as "expected
 * duct_segment", and (with the ledger's rule-set check removed) a tap check
 * answered under one pack set was carried into an edit under another.
 */
import {
  asElementId,
  draftElements,
  elementsOfKind,
  executeCommand,
  freezeElements,
  issuesAfterEdit,
  issuesOf,
  NETWORK_ADAPTER_POINT,
  recomputeDerived,
  validateModel,
  type ElementId,
  type ModelState,
  type NetworkAdapterItem,
  type RiserSegment,
  type TreeNetworkFace,
} from "../src";
import {
  type TapFitting,
} from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { contribute, definePack, PACK_CONTRACT_VERSION, PackSet, withPackSet } from "../src/packs";

const RISER_SPAN = 3000;

const RISER_TREE: TreeNetworkFace = {
  tapHosts: [
    {
      kind: "riser_segment",
      place: (host, tap) => (host.kind === "riser_segment" ? { x: host.position.x + 100 * tap.side, y: host.position.y + tap.s } : null),
      span: (host) => (host.kind === "riser_segment" ? RISER_SPAN : null),
    },
  ],
};
const RISER_ADAPTER: NetworkAdapterItem = { id: "t8checks.tree", tree: RISER_TREE };
const RISER_PACK = definePack({ id: "t8checks", name: "Riser tap checks test add-on", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(NETWORK_ADAPTER_POINT, [RISER_ADAPTER])]);
const WITH_RISER = PackSet.create([RISER_PACK]);

/** The demo model with one tap moved off its duct onto a riser placed so the riser's rule leaves the tap where it was. */
function riserTap(s: number): { readonly model: ModelState; readonly riser: RiserSegment; readonly tap: TapFitting } {
  const base = recomputeDerived(createDemoModel("t8-checks")).model;
  const tap = elementsOfKind(base.elements, "tap")[0];
  if (!tap) throw new Error("demo model has no tap");
  const riser: RiserSegment = {
    id: asElementId("t8-checks-riser"),
    version: 1,
    authoredRev: {},
    kind: "riser_segment",
    riserId: "R-1",
    service: "sprinkler",
    position: { x: tap.position.x - 100 * tap.side, y: tap.position.y - s },
    profile: { shape: "round", diameter: 2000 },
  };
  const w = draftElements(base.elements);
  w[riser.id] = riser;
  const moved: TapFitting = { ...tap, hostId: riser.id, s };
  w[tap.id] = moved;
  return { model: { ...base, elements: freezeElements(w) }, riser, tap: moved };
}

const noHost = (tapId: ElementId) => (issue: { code: string; elementIds: readonly ElementId[] }) => issue.code === "disconnected" && issue.elementIds.length === 1 && issue.elementIds[0] === tapId;

describe("t8 tap checks ask the tree face", () => {
  it("a tap on a riser has a host only where an add-on lets risers host taps", () => {
    const { model, tap } = riserTap(1000);
    expect(validateModel(model).some(noHost(tap.id))).toBe(true);
    withPackSet(WITH_RISER, () => {
      const issues = validateModel(model);
      expect(issues.some(noHost(tap.id))).toBe(false);
      expect(issues.some((i) => i.code === "outside_host" && i.elementIds.includes(tap.id))).toBe(false);
    });
  });

  it("end clearance is measured against the add-on's span, not a duct length", () => {
    const { model, tap } = riserTap(RISER_SPAN - 100);
    withPackSet(WITH_RISER, () => {
      const outside = validateModel(model).filter((i) => i.code === "outside_host" && i.elementIds.includes(tap.id));
      expect(outside).toHaveLength(1);
      expect(outside[0]?.message).toContain("t8-checks-riser");
    });
  });
});

describe("t8 slide_branch asks the tree face for its host", () => {
  it("refuses a branch on a kind no add-on lets carry branches, in plain words naming the kind", () => {
    const { model, tap } = riserTap(1000);
    const res = executeCommand(model, { type: "slide_branch", tapId: tap.id, s: 1200 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("wrong_kind");
    expect(res.error.message).toContain("riser_segment");
    expect(res.error.message).toContain("can't slide");
    expect(res.error.message).not.toMatch(/expected duct_segment/);
  });

  it("under an add-on that lets a unit host taps, the branch moves by that add-on's placement rule", () => {
    const base = recomputeDerived(createDemoModel("t8-checks-unit")).model;
    const tap = elementsOfKind(base.elements, "tap")[0];
    const unit = elementsOfKind(base.elements, "equipment")[0];
    if (!tap || !unit) throw new Error("demo model has no tap or no unit");
    // The rule keeps the tap where it is at s = 1000 and runs along +y: the branch stays connected, so the edit is valid.
    const origin = { x: tap.position.x, y: tap.position.y - 1000 };
    const unitTree: TreeNetworkFace = {
      tapHosts: [{ kind: "equipment", place: (host, t) => (host.kind === "equipment" ? { x: origin.x, y: origin.y + t.s } : null), span: (host) => (host.kind === "equipment" ? RISER_SPAN : null) }],
    };
    const pack = definePack({ id: "t8unit", name: "Unit tap test add-on", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(NETWORK_ADAPTER_POINT, [{ id: "t8unit.tree", tree: unitTree }])]);
    const w = draftElements(base.elements);
    w[tap.id] = { ...tap, hostId: unit.id, s: 1000 };
    const model: ModelState = { ...base, elements: freezeElements(w) };
    withPackSet(PackSet.create([pack]), () => {
      const settled = recomputeDerived(model).model;
      const res = executeCommand(settled, { type: "slide_branch", tapId: tap.id, s: 1200 });
      if (!res.ok) throw new Error(res.error.message);
      const placed = res.model.elements[tap.id];
      if (placed?.kind !== "tap") throw new Error("the tap is gone");
      expect(placed.s).toBe(1200);
      expect(placed.position.x).toBeCloseTo(origin.x, 3);
      expect(placed.position.y).toBeCloseTo(origin.y + 1200, 3);
    });
  });

  it("a duct branch still slides as before", () => {
    const base = recomputeDerived(createDemoModel("t8-checks-duct")).model;
    const tap = elementsOfKind(base.elements, "tap")[0];
    if (!tap) throw new Error("demo model has no tap");
    const s = Math.round((tap.s + 50) * 1000) / 1000;
    const res = executeCommand(base, { type: "slide_branch", tapId: tap.id, s });
    if (!res.ok) throw new Error(res.error.message);
    const placed = res.model.elements[tap.id];
    expect(placed?.kind === "tap" ? placed.s : null).toBe(s);
  });
});

describe("t8 the incremental validation ledger re-runs tap checks when the pack set changes", () => {
  it("an answer recorded under one set is never carried into an edit under another", () => {
    const { model: prior, tap, riser } = riserTap(1000);
    // Some element neither the tap nor its host: its edit alone re-runs nothing the tap's check read.
    const other = Object.values(prior.elements).find((el) => el.id !== tap.id && el.id !== riser.id && el.kind === "terminal");
    if (!other) throw new Error("demo model has no terminal");
    const w = draftElements(prior.elements);
    w[other.id] = { ...other, version: other.version + 1 };
    const after: ModelState = { ...prior, elements: freezeElements(w) };

    // Under the default set the prior has the tap's "has no host" open; the ledger is recorded there.
    expect(issuesOf(prior).some(noHost(tap.id))).toBe(true);
    expect(issuesAfterEdit(prior, after, [other.id]).issues.some(noHost(tap.id))).toBe(true);

    withPackSet(WITH_RISER, () => {
      const next = issuesAfterEdit(prior, after, [other.id]);
      expect(next.issues.some(noHost(tap.id))).toBe(false);
      expect(next.issues).toEqual(validateModel(after));
    });
  });
});
