/**
 * @jest-environment node
 *
 * Density loads (F3): a space use's code rates × area or occupants. The calc
 * converts each code unit through bim-units, names its clause, and agrees with
 * the kernel's live evaluation of the same pinned rates. Before this file
 * there was no rate × area calc at all.
 */
import { BUILTIN_SPACE_USES, SPACE_USE_LIBRARY_ID, SPACE_USE_RATE_TARGETS } from "@permitzip/bim-library";
import { defaultOccupants, densityLoads, pinSpaceUse } from "@permitzip/bim-calc";
import { evaluateDensity } from "../../bim-kernel/src/spaces/space-use";

const SQFT = 0.09290304;

function row(id: string) {
  const r = BUILTIN_SPACE_USES.find((u) => u.id === id);
  if (!r) throw new Error(id);
  return r;
}

describe("density loads", () => {
  it("gives a 600 ft² dining room 42 people, 423 cfm of outdoor air and 900 VA of lighting, citing each clause", () => {
    const dining = row("restaurant_dining");
    const areaM2 = 600 * SQFT;
    const occupants = defaultOccupants(dining, areaM2);
    expect(occupants).toBe(42);
    const r = densityLoads(dining, SPACE_USE_RATE_TARGETS, { areaM2, occupants });
    expect(r.bag.cfm).toBeCloseTo(423, 6);
    expect(r.bag.va).toBeCloseTo(900, 6);
    expect(r.lines.map((l) => l.source)).toEqual(["IMC 2021 Table 403.3.1.1 (not verified)", "IMC 2021 Table 403.3.1.1 (not verified)", "NEC 2020 Table 220.12 (not verified)"]);
    expect(r.missing).toEqual([]);
  });

  it("pins a row into canonical rates the kernel evaluates to the same numbers", () => {
    const pinned = pinSpaceUse(SPACE_USE_LIBRARY_ID, row("office_space"), SPACE_USE_RATE_TARGETS);
    if (typeof pinned === "string") throw new Error(pinned);
    expect(pinned.useId).toBe("office_space");
    expect(pinned.occupantsPerM2).toBeCloseTo(5 / (1000 * SQFT), 9);
    const areaM2 = 1000 * SQFT;
    const calc = densityLoads(row("office_space"), SPACE_USE_RATE_TARGETS, { areaM2, occupants: 5 });
    const kernel = evaluateDensity(pinned.rates, { areaM2, occupants: 5 });
    // 5 cfm × 5 + 0.06 × 1,000 = 85 cfm; 1.3 + 1 VA/ft² = 2,300 VA.
    expect(calc.bag.cfm).toBeCloseTo(85, 6);
    expect(kernel.bag.cfm).toBeCloseTo(85, 6);
    expect(kernel.bag.va).toBeCloseTo(calc.bag.va ?? NaN, 6);
  });

  it("says which rates couldn't apply instead of reading a missing area as zero", () => {
    const r = densityLoads(row("restaurant_dining"), SPACE_USE_RATE_TARGETS, { areaM2: null, occupants: null });
    expect(r.bag).toEqual({});
    expect(r.missing).toHaveLength(3);
    expect(r.missing[0]).toMatch(/no occupants yet/);
  });
});
