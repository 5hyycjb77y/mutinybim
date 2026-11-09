/**
 * @jest-environment node
 *
 * Round 7 lane Q: conductor length by size comes from the Electrical
 * add-on's own measure rule (`MEASURE_RULE_POINT`), with no kernel edit.
 * A three-pole feeder of 100 ft with a neutral and a ground measures
 * 400 ft of #1 CU and 100 ft of ground; a branch with no length is counted
 * but never guessed.
 *
 * Fails on the old code: the add-on contributed no measure rule.
 */
import { asElementId, measureElement, measureRuleFor, type BimElement } from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { ELECTRICAL_PACK } from "../src";
import { modelOf } from "../../bim-kernel/__tests__/q7-fixtures";

const M_PER_FT = 0.3048;

function link(id: string, electrical: Record<string, unknown>): BimElement {
  const r: unknown = {
    id: asElementId(id),
    kind: "service_link",
    version: 1,
    authoredRev: {},
    trade: "electrical",
    role: "feeder",
    source: { elementId: asElementId("mdp"), port: "bus", positions: [2, 4, 6] },
    members: [{ elementId: asElementId("t1") }],
    description: "",
    electrical,
  };
  return r as BimElement;
}

describe("q7 electrical measure rule", () => {
  it("measures conductor length by size from the link's length and conductors", () => {
    const f = link("f1", { ratingA: 125, lengthFt: 100, conductors: { sets: 1, phaseSize: "1", neutralSize: "1", groundSize: "6", material: "cu" } });
    const b = link("f2", { ratingA: 20 });
    const m = modelOf([f, b]);
    withPackSet(PackSet.create([ELECTRICAL_PACK]), () => {
      expect(measureRuleFor(m.elements, f)?.id).toBe("electrical.conductors");
      const fm = measureElement(m.elements, f);
      expect(fm?.sizeGroup).toBe("#1 CU");
      expect(fm?.values["qto.conductor_length"]).toBeCloseTo(400 * M_PER_FT, 6);
      expect(fm?.values["qto.ground_length"]).toBeCloseTo(100 * M_PER_FT, 6);
      const bm = measureElement(m.elements, b);
      expect(bm?.values).toEqual({ "qto.count": 1 });
    });
  });
});
