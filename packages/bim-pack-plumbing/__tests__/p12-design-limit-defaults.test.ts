/**
 * @jest-environment node
 *
 * Round 12 lane P12 (product decision, Nov 3 2026): Plumbing and gas ships its starting
 * design limits per piping system, each with its source: cold, hot and
 * recirculating water velocity, water pressure loss, a 20 % margin on water
 * and gas mains, low and medium pressure gas drop and drain fill. The firm's
 * row with the same id replaces the default. Installs only Plumbing and gas
 * (@mutinybim-bare-kernel).
 *
 * Fails on round 11's code: there was no design limit point and the add-on
 * had no limits.
 */
import { designLimitProblems, designLimitsFor, type DesignLimit } from "@permitzip/bim-kernel/policy";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_DESIGN_LIMIT_DEFAULTS, PLUMBING_GAS_PACK } from "../src";

const ALLOWED_SOURCES = ["PermitZIP practice (plumbing review video, Oct 2026)", "PermitZIP practice (product decision, Nov 3 2026)", "Common design practice; firm to confirm"];

describe("p12-design-limit-defaults", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("every default is a valid limit with one of our own cited sources", () => {
    expect(designLimitProblems(PLUMBING_DESIGN_LIMIT_DEFAULTS)).toEqual([]);
    for (const l of PLUMBING_DESIGN_LIMIT_DEFAULTS) {
      expect(l.id.startsWith("plumbing_gas.")).toBe(true);
      expect(ALLOWED_SOURCES).toContain(l.citation.source);
    }
  });

  it("each system gets its own limit: cold water 8 ft/s, hot 5, recirculating 3", () => {
    const max = (system: string): number | undefined => designLimitsFor({ quantity: "velocity", system }, undefined)[0]?.limit.band.max;
    expect([max("domestic_cold_water"), max("domestic_hot_water"), max("domestic_hot_water_return")]).toEqual([8, 5, 3]);
    expect(designLimitsFor({ quantity: "velocity", system: "sanitary" }, undefined)).toEqual([]);
  });

  it("gas and water mains carry a 20 % margin; low and medium pressure gas have their own drop", () => {
    expect(designLimitsFor({ quantity: "ratio", system: "natural_gas" }, undefined).map((r) => r.limit.band)).toEqual([{ min: 20 }]);
    expect(designLimitsFor({ quantity: "ratio", system: "domestic_cold_water" }, undefined).map((r) => r.limit.band)).toEqual([{ min: 20 }]);
    expect(designLimitsFor({ quantity: "pressure", system: "natural_gas.low_pressure" }, undefined).map((r) => `${r.limit.band.max} ${r.limit.unit}`)).toEqual(["0.5 in_wc"]);
    expect(designLimitsFor({ quantity: "pressure", system: "natural_gas.medium_pressure" }, undefined).map((r) => `${r.limit.band.max} ${r.limit.unit}`)).toEqual(["1 psi"]);
  });

  it("a firm's row with the same id replaces the default", () => {
    const base = PLUMBING_DESIGN_LIMIT_DEFAULTS.find((l) => l.id === "plumbing_gas.cold_water_velocity");
    if (!base) throw new Error("cold water velocity default");
    const firm: DesignLimit = { ...base, band: { max: 7 }, citation: { source: "Our standard" } };
    const [hit] = designLimitsFor({ quantity: "velocity", system: "domestic_cold_water" }, undefined, { firm: [firm] });
    expect(hit?.limit.band.max).toBe(7);
    expect(hit?.layer).toBe("firm");
  });
});
