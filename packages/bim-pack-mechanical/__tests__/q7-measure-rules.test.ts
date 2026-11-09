/**
 * @jest-environment node
 *
 * Round 7 lane Q: duct length and sheet-metal surface by size come from the
 * Mechanical add-on's own measure rule (`MEASURE_RULE_POINT`), with no
 * kernel edit: a 12x8 duct 50 ft long is 50 ft of 12"x8" and
 * 2 × (12 + 8) in × 50 ft of surface.
 *
 * Fails on the old code: the add-on contributed no measure rule.
 */
import { asElementId, measureElement, measureRuleFor, type BimElement } from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_PACK } from "../src";
import { FT, modelOf } from "../../bim-kernel/__tests__/q7-fixtures";

const IN = 25.4;

function duct(id: string, lengthFt: number): BimElement {
  const r: unknown = {
    id: asElementId(id),
    kind: "run_segment",
    version: 1,
    authoredRev: {},
    domain: "duct",
    systemId: asElementId("sys"),
    levelId: asElementId("lvl-1"),
    start: { x: 0, y: 0, z: 0 },
    end: { x: lengthFt * FT, y: 0, z: 0 },
    size: { shape: "rect", width: 12 * IN, height: 8 * IN },
    links: {},
    branches: [],
    flow: 0,
  };
  return r as BimElement;
}

describe("q7 mechanical measure rule", () => {
  it("measures duct length and surface by size", () => {
    const d = duct("d1", 50);
    const m = modelOf([d]);
    withPackSet(PackSet.create([MECHANICAL_PACK]), () => {
      expect(measureRuleFor(m.elements, d)?.id).toBe("mechanical.duct");
      const dm = measureElement(m.elements, d);
      expect(dm?.sizeGroup).toBe('12"x8"');
      expect(dm?.values["qto.length"]).toBeCloseTo((50 * FT) / 1000, 6);
      expect(dm?.values["qto.area_surface"]).toBeCloseTo(((2 * (12 + 8) * IN) / 1000) * ((50 * FT) / 1000), 6);
    });
  });
});
