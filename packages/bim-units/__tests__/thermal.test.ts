import { BUILTIN_PROFILES, formatQuantity, PROFILE_METRIC_MM, PROFILE_US_DECIMAL_FEET, PROFILE_US_FEET_INCHES, convert, findUnit, KINDS, parseQuantity, qty, to, unitAllowed, UNITS } from "@permitzip/bim-units";

describe("thermal units", () => {
  it("converts thermal resistance using temperature differences, without an offset", () => {
    expect(convert(1, "h.degF/Btu", "K/W")).toBeCloseTo(1.895634, 6);
    expect(convert(0, "h.degF/Btu", "K/W")).toBe(0);
    expect(to(qty("thermal_resistance", 2, "h.degF/Btu"), "K/W")).toBeCloseTo(3.791268, 6);
  });

  it("converts insulation R-values separately from total thermal resistance", () => {
    expect(convert(1, "h.ft2.degF/Btu", "m2.K/W")).toBeCloseTo(0.1761102, 7);
    expect(to(qty("thermal_resistance_area", 20, "h.ft2.degF/Btu"), "m2.K/W")).toBeCloseTo(3.522204, 6);
    expect(unitAllowed("thermal_resistance", "m2.K/W")).toBe(false);
    expect(unitAllowed("thermal_resistance_area", "K/W")).toBe(false);
    expect(() => convert(1, "K/W", "m2.K/W")).toThrow();
    expect(KINDS.thermal_resistance_area.dimension.L).toBe(0);
    expect(KINDS.thermal_resistance.dimension.L).toBe(-2);
  });

  it("converts IT-Btu specific heat to SI", () => {
    expect(convert(1, "Btu/lb.degF", "J/kg.K")).toBeCloseTo(4186.8, 8);
    expect(convert(1, "Btu/lb.degF", "kJ/kg.K")).toBeCloseTo(4.1868, 10);
    expect(to(qty("specific_heat", 4.1868, "kJ/kg.K"), "Btu/lb.degF")).toBeCloseTo(1, 10);
    expect(convert(0, "Btu/lb.degF", "J/kg.K")).toBe(0);
    expect(() => convert(1, "J/kg.K", "K/W")).toThrow();
  });

  it.each([
    ["K/W", "K/W"],
    ["m2.K/W", "m2.K/W"],
    ["J/kg.K", "J/kg.K"],
    ["h.degF/Btu", "K/W"],
    ["h.ft2.degF/Btu", "m2.K/W"],
    ["Btu/lb.degF", "J/kg.K"],
    ["kJ/kg.K", "J/kg.K"],
  ] as const)("round-trips %s through %s", (from, si) => {
    for (const value of [0, 0.001, 1, 123.456]) {
      expect(convert(convert(value, from, si), si, from)).toBeCloseTo(value, 10);
    }
    expect(UNITS[from].offset).toBe(0);
  });

  it("looks up and parses the compound unit symbols", () => {
    expect(findUnit("h·ft²·°F/Btu", "thermal_resistance_area")).toBe("h.ft2.degF/Btu");
    expect(to(parseQuantity("20 h·ft²·°F/Btu", "thermal_resistance_area"), "m2.K/W")).toBeCloseTo(3.522204, 6);
    expect(to(parseQuantity("1 Btu/(lb·°F)", "specific_heat"), "J/kg.K")).toBeCloseTo(4186.8, 8);
    expect(findUnit("BTU/lb/F", "specific_heat")).toBe("Btu/lb.degF");
    expect(findUnit("kj/kgk", "specific_heat")).toBe("kJ/kg.K");
    expect(KINDS.specific_heat.aggregation.default).toBe("none");
  });

  it("displays each new kind in the profile's unit system", () => {
    for (const profile of [PROFILE_US_DECIMAL_FEET, PROFILE_US_FEET_INCHES]) {
      expect(formatQuantity(qty("thermal_resistance", 2, "h.degF/Btu"), "thermal_resistance", profile)).toBe("2.00 h·°F/Btu");
      expect(formatQuantity(qty("thermal_resistance_area", 20, "h.ft2.degF/Btu"), "thermal_resistance_area", profile)).toBe("20.00 h·ft²·°F/Btu");
      expect(formatQuantity(qty("specific_heat", 1, "Btu/lb.degF"), "specific_heat", profile)).toBe("1.00 Btu/(lb·°F)");
    }
    expect(formatQuantity(qty("thermal_resistance", 2, "K/W"), "thermal_resistance", PROFILE_METRIC_MM)).toBe("2.00 K/W");
    expect(formatQuantity(qty("thermal_resistance_area", 3.5, "m2.K/W"), "thermal_resistance_area", PROFILE_METRIC_MM)).toBe("3.50 m²·K/W");
    expect(formatQuantity(qty("specific_heat", 4186.8, "J/kg.K"), "specific_heat", PROFILE_METRIC_MM)).toBe("4.19 kJ/(kg·K)");
    for (const profile of BUILTIN_PROFILES) {
      for (const kind of ["thermal_resistance", "thermal_resistance_area", "specific_heat"] as const) {
        expect(profile.kinds[kind]).toBeDefined();
      }
    }
  });
});
