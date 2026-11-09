/**
 * @jest-environment node
 *
 * Round 11 lane K11: any hosted kind whose row says where it sits along its
 * host (`hostedBy.placement`) is placed by the tree face's rule for the
 * host's kind and checked like a tap: end clearance against the host's span,
 * spacing from every other placed record on that host, and "has no host"
 * when its host is gone. A test add-on's balancing damper on a duct is
 * placed, refused near the duct's end and too close to a branch, the same
 * way in the full check and the incremental one; a hosted kind with no
 * placement joins the tree and is never placed. The kernel names no kind.
 *
 * Fails on round 10's code: `derived.ts` / `validate.ts` placed and checked
 * only `tap` records (they read `s` / `side`), so the damper kept its stored
 * position, sat anywhere on its duct and was never spacing-checked.
 */
import {
  asElementId,
  elementKindRowProblems,
  ELEMENT_KIND_POINT,
  elementsOfKind,
  firstIssueAfter,
  freezeElements,
  KERNEL_ELEMENT_KINDS,
  recomputeDerived,
  validateModel,
  type BimElement,
  type ElementKindItem,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";
import { networkOf } from "../src/network";

const DAMPER: ElementKindItem = {
  kind: "k11hy.damper",
  label: "Balancing damper",
  nature: "physical",
  connectorEnds: { ends: [{ end: "on", role: "upstream" }], hostedBy: { field: "ductRef", placement: { along: "offsetMm", side: "face", at: "at" } } },
};
/** Hosted, never placed: it hangs under its duct only. */
const LABEL: ElementKindItem = { kind: "k11hy.label", label: "Duct label", nature: "physical", connectorEnds: { ends: [{ end: "on", role: "upstream" }], hostedBy: { field: "ductRef" } } };
const HYDRONIC = PackSet.create([definePack({ id: "k11hy", name: "K11 hydronic", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [DAMPER, LABEL])])]);

const settled = (id: string): ModelState => recomputeDerived(createDemoModel(id)).model;

function record(fields: Record<string, unknown>): BimElement {
  return { version: 1, authoredRev: {}, systemClass: "supply", ...fields } as unknown as BimElement;
}

/** A duct that hosts a tap, the tap, and the duct's length. */
function hostedDuct(model: ModelState) {
  for (const tap of elementsOfKind(model.elements, "tap")) {
    const duct = model.elements[tap.hostId];
    if (duct?.kind === "duct_segment") return { tap, duct, length: Math.hypot(duct.end.x - duct.start.x, duct.end.y - duct.start.y) };
  }
  throw new Error("the demo model has no tap on a duct");
}

function withDamper(model: ModelState, ductId: string, offsetMm: number): ModelState {
  const damper = record({ id: "DMP-1", kind: "k11hy.damper", ductRef: ductId, offsetMm, face: 1, at: { x: 0, y: 0 } });
  const label = record({ id: "LBL-1", kind: "k11hy.label", ductRef: ductId, at: { x: 0, y: 0 } });
  return { ...model, elements: freezeElements({ ...model.elements, [damper.id]: damper, [label.id]: label }) };
}

const at = (m: ModelState, id: string): unknown => Reflect.get(m.elements[id] ?? {}, "at");

describe("k11 hostedBy.placement places and checks any hosted kind", () => {
  it("the damper is placed on its duct by the duct's own rule (the same place a branch at that offset gets); the label is not placed", () => {
    const base = settled("k11-hosted");
    const { tap, duct, length } = hostedDuct(base);
    const offset = Math.round(length / 2);
    const model = withDamper(base, duct.id, offset);
    withPackSet(HYDRONIC, () => {
      const out = recomputeDerived(model);
      expect(out.changedIds).toEqual(["DMP-1"]);
      // The same rule a tap at that offset and side gets.
      const asTap = recomputeDerived({ ...base, elements: freezeElements({ ...base.elements, [tap.id]: { ...tap, s: offset, side: 1 } }) }).model.elements[tap.id];
      expect(at(out.model, "DMP-1")).toEqual(asTap?.kind === "tap" ? asTap.position : null);
      expect(at(out.model, "LBL-1")).toEqual({ x: 0, y: 0 });
      expect(networkOf(out.model).hostedTaps(duct.id)).toEqual(expect.arrayContaining(["DMP-1", "LBL-1", tap.id]));
    });
    // Without its add-on the damper is kept as stored.
    expect(recomputeDerived(model).changedIds).toEqual([]);
  });

  it("near the duct's end, too close to a branch, or off a missing duct: refused in the tap's words, in the full and the incremental check", () => {
    const base = settled("k11-hosted-2");
    const { tap, duct, length } = hostedDuct(base);
    withPackSet(HYDRONIC, () => {
      const nearEnd = recomputeDerived(withDamper(base, duct.id, 100)).model;
      const end = validateModel(nearEnd).filter((i) => i.elementIds.includes(asElementId("DMP-1")));
      expect(end).toEqual([{ code: "outside_host", message: `DMP-1 is within ${base.settings.tapEndClearanceMm} mm of the end of ${duct.id}`, elementIds: ["DMP-1", duct.id] }]);

      const close = recomputeDerived(withDamper(base, duct.id, tap.s + 100)).model;
      const spacing = validateModel(close).filter((i) => i.code === "tap_spacing");
      expect(spacing).toHaveLength(1);
      expect(spacing[0]?.elementIds).toEqual(expect.arrayContaining(["DMP-1", tap.id]));

      const orphan = recomputeDerived(withDamper(base, "no-such-duct", 1000)).model;
      expect(validateModel(orphan).filter((i) => i.elementIds.includes(asElementId("DMP-1"))).map((i) => i.message)).toContain("DMP-1 has no host");

      // The incremental check over a valid base reaches the same first issue.
      const clear = tap.s + 900 < length - base.settings.tapEndClearanceMm ? tap.s + 900 : tap.s - 900;
      const valid = recomputeDerived(withDamper(base, duct.id, clear)).model;
      expect(validateModel(valid)).toEqual([]);
      const edited: ModelState = { ...valid, elements: freezeElements({ ...valid.elements, "DMP-1": record({ ...(valid.elements["DMP-1"] as unknown as Record<string, unknown>), offsetMm: tap.s + 100 }) }) };
      const settledEdit = recomputeDerived(edited).model;
      const first = firstIssueAfter(valid, settledEdit, [asElementId("DMP-1")]);
      expect(first?.code).toBe("tap_spacing");
      expect(first).toEqual(validateModel(settledEdit)[0]);
    });
  });

  it("names a malformed placement in words", () => {
    const kernel = new Set<string>(KERNEL_ELEMENT_KINDS);
    expect(elementKindRowProblems([{ ...DAMPER, connectorEnds: { ends: [], hostedBy: { field: "ductRef", placement: { along: "offsetMm", side: "offsetMm", at: "" } } } }], kernel)).toEqual([
      "element kind k11hy.damper: hostedBy placement names an empty field",
      "element kind k11hy.damper: hostedBy placement's fields (along, side, at) and its host field must all differ",
    ]);
    expect(elementKindRowProblems([DAMPER, LABEL], kernel)).toEqual([]);
  });
});
