/**
 * @jest-environment node
 *
 * Round 13 lane P13: the expansion tank is a check, not a load. 50 gal heated
 * from 50 °F to 140 °F grows by the change in water's density; between a
 * 50 psi fill and 125 psi it needs about a 1.6 gal tank. A 2 gal tank passes,
 * a 1 gal one is too small, and a missing input is named, never guessed.
 *
 * Fails on round 12's code: there was no expansion tank check.
 */
import { expansionTankCheck, waterDensity } from "../src";

const base = { systemGal: 50, coldF: 50, hotF: 140, fillPsi: 50, maxPsi: 125, tankGal: 2 };

describe("p13-expansion-tank", () => {
  it("sizes from density and the tank's air between fill and maximum pressure", () => {
    const r = expansionTankCheck(base);
    if (r.kind !== "checked") throw new Error(r.message);
    const grows = 50 * (waterDensity(50) / waterDensity(140) - 1);
    expect(r.expansionGal).toBeCloseTo(grows, 9);
    expect(r.requiredGal).toBeCloseTo(grows / (1 - (50 + 14.696) / (125 + 14.696)), 9);
    expect(r.requiredGal).toBeGreaterThan(1.5);
    expect(r.requiredGal).toBeLessThan(1.7);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^50 gal heated from 50°F to 140°F grows 0\.8 gal; between 50 and 125 psi that needs a 1\.6 gal tank: 2 gal is enough$/);
    expect(expansionTankCheck({ ...base, tankGal: 1 })).toMatchObject({ kind: "checked", ok: false });
  });

  it("names what is missing", () => {
    expect(expansionTankCheck({ ...base, systemGal: null, maxPsi: null }).message).toBe("Can't size the expansion tank yet: add the system volume, the maximum system pressure");
  });
});
