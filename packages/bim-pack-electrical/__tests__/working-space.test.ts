/**
 * @jest-environment node
 *
 * NEC 110.26(A) working space: table depth by voltage to ground and
 * condition, the 30 in. / 6½ ft minimums, the engineer's extra depth, and a
 * clearance zone the kernel accepts as-is.
 */
import { clearanceZoneSchema } from "@permitzip/bim-kernel";
import { necEdition } from "@permitzip/bim-calc";
import { necWorkingSpace, workingSpaceZone } from "@permitzip/bim-pack-electrical";

const FT = 304.8;
const IN = 25.4;
const nec = necEdition("2023");
const panel = { equipmentWidthMm: 20 * IN, equipmentHeightMm: 60 * IN };

describe("NEC 110.26(A) working space", () => {
  it.each([
    [120, 1, 3],
    [120, 3, 3],
    [277, 1, 3],
    [277, 2, 3.5],
    [277, 3, 4],
    [600, 3, 4],
    [750, 2, 4],
    [750, 3, 5],
  ] as const)("%s V to ground, condition %s: %s ft deep", (volts, condition, ft) => {
    const r = necWorkingSpace(nec, { voltageToGround: volts, condition, ...panel });
    expect(r.ok && r.space.depthMm).toBeCloseTo(ft * FT, 3);
  });

  it("is at least 30 in. wide and 6½ ft high, or the equipment's size when bigger", () => {
    const small = necWorkingSpace(nec, { voltageToGround: 277, condition: 1, ...panel });
    expect(small.ok && [small.space.widthMm, small.space.heightMm]).toEqual([30 * IN, 6.5 * FT]);
    const big = necWorkingSpace(nec, { voltageToGround: 277, condition: 1, equipmentWidthMm: 90 * IN, equipmentHeightMm: 90 * IN });
    expect(big.ok && [big.space.widthMm, big.space.heightMm]).toEqual([90 * IN, 90 * IN]);
  });

  it("cites the table and clauses for the adopted edition", () => {
    const r = necWorkingSpace(nec, { voltageToGround: 277, condition: 3, ...panel });
    expect(r.ok && r.space.citations.map((c) => c.text)).toEqual(["NEC 2023 Table 110.26(A)(1), condition 3, 277 V to ground", "NEC 2023 110.26(A)(2)", "NEC 2023 110.26(A)(3)"]);
    expect(r.ok && r.space.summary).toMatch(/^4'-0" deep \(condition 3, 277 V\), 2'-6" wide, 6'-6" high/);
  });

  it("refuses over 1000 V instead of guessing", () => {
    expect(necWorkingSpace(nec, { voltageToGround: 2400, condition: 1, ...panel })).toEqual({ ok: false, reason: expect.stringMatching(/above the 1000 V/) });
  });

  it("draws the engineer's double clearance and records why, as a zone measured from the floor", () => {
    const made = workingSpaceZone(nec, { voltageToGround: 277, condition: 2, depthMultiplier: 2, ...panel }, { offsetMm: 6 * IN });
    if (!made.zone) throw new Error(made.reason);
    expect(clearanceZoneSchema.parse(made.zone)).toEqual(made.zone);
    expect(made.zone).toMatchObject({ purpose: "working_space", face: "front", fromFloor: true, offset: 6 * IN, basis: { code: "nec_110_26", edition: "2023", condition: 2, depthMultiplier: 2 } });
    expect(made.zone.depth).toBeCloseTo(7 * FT, 3);
  });
});
