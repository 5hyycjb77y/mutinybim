/**
 * @jest-environment node
 *
 * Round 7 lane Q: elements measure themselves through `MEASURE_RULE_POINT`.
 *
 * - A wall's face area is net of the doors and windows hosted in it, and
 *   re-measures when an opening changes (the wall record itself unchanged).
 * - A ceiling's area is net of its holes.
 * - Pipe length by size and material comes from the Plumbing add-on's own
 *   rule (its class rule wins over the kernel's generic run rule).
 *
 * Fails on the old code: nothing read the measure-rule point, so there was no
 * `qto.*` value anywhere.
 */
import { asElementId, measureElement, measuredValue, measureRuleFor, type BimElement } from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK } from "../src";
import { ceilingRecord, FT, modelOf, openingRecord, rect, wallRecord } from "../../bim-kernel/__tests__/q7-fixtures";

const SQ_FT = FT * FT;
const M2 = 1e6;

describe("q7 measure rules", () => {
  it("a wall's net face area is its face less the doors and windows in it", () => {
    const m = modelOf([wallRecord("w1", { x: 0, y: 0 }, { x: 20 * FT, y: 0 }), openingRecord("d1", "w1", "door", 3 * FT, 7 * FT), openingRecord("n1", "w1", "window", 4 * FT, 4 * FT, 12 * FT)]);
    const gross = (20 * FT * 10 * FT) / M2;
    const openings = (3 * 7 + 4 * 4) * (SQ_FT / M2);
    expect(measuredValue(m.elements, "w1", "qto.area_gross")).toBeCloseTo(gross, 6);
    expect(measuredValue(m.elements, "w1", "qto.area_net")).toBeCloseTo(gross - openings, 6);
    expect(measuredValue(m.elements, "w1", "qto.length")).toBeCloseTo((20 * FT) / 1000, 6);
    expect(measuredValue(m.elements, "d1", "qto.count")).toBe(1);

    // The window grows; the wall record is the same object, and its net area still follows.
    const n1 = m.elements.n1;
    if (n1?.kind !== "opening") throw new Error("n1 is an opening");
    const grown: Record<string, BimElement> = { ...m.elements, n1: { ...n1, width: 6 * FT } };
    expect(grown.w1).toBe(m.elements.w1);
    expect(measuredValue(grown, "w1", "qto.area_net")).toBeCloseTo(gross - (3 * 7 + 6 * 4) * (SQ_FT / M2), 6);
  });

  it("a ceiling's area is net of its holes", () => {
    const m = modelOf([ceilingRecord("c1", rect(0, 0, 20 * FT, 15 * FT), [rect(5 * FT, 5 * FT, 9 * FT, 9 * FT)])]);
    expect(measuredValue(m.elements, "c1", "qto.area")).toBeCloseTo(((20 * 15 - 4 * 4) * SQ_FT) / M2, 6);
  });

  it("pipe length by size and material comes from the Plumbing add-on's rule", () => {
    const pipe = (id: string, nominalMm: number, material: string, lengthFt: number, rise = 0): BimElement => {
      const record: unknown = {
        id: asElementId(id),
        kind: "run_segment",
        version: 1,
        authoredRev: {},
        domain: "pipe",
        systemId: asElementId("sys"),
        levelId: asElementId("lvl-1"),
        start: { x: 0, y: 0, z: 0 },
        end: { x: lengthFt * FT, y: 0, z: rise },
        size: { shape: "pipe", nominalMm, material },
        links: {},
        branches: [],
        flow: 0,
      };
      return record as BimElement;
    };
    const m = modelOf([pipe("p1", 50.8, "copper", 30), pipe("p2", 101.6, "cast_iron", 40, 3 * FT)]);
    const p1 = m.elements.p1;
    const p2 = m.elements.p2;
    if (!p1 || !p2) throw new Error("pipes");
    const plumbing = PackSet.create([PLUMBING_GAS_PACK]);
    withPackSet(plumbing, () => {
      expect(measureRuleFor(m.elements, p1)?.id).toBe("plumbing_gas.pipe");
      expect(measureElement(m.elements, p1)?.sizeGroup).toBe('2" copper');
      expect(measureElement(m.elements, p2)?.sizeGroup).toBe('4" cast iron');
      expect(measuredValue(m.elements, "p1", "qto.length")).toBeCloseTo((30 * FT) / 1000, 6);
      expect(measuredValue(m.elements, "p2", "qto.length")).toBeCloseTo(Math.hypot(40 * FT, 3 * FT) / 1000, 6);
    });
  });
});
