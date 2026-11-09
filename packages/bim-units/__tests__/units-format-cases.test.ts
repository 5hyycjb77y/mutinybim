/**
 * @jest-environment node
 *
 * The three `units.format.100k` cases (CFM grouped, MBH to one place,
 * feet-inches to 1/16"), checked for output only. Their timing is enforced by
 * the schedules suite of the BIM perf gate (`npm run perf:bim:ci`), not here:
 * Jest workers sharing a runner measure contention, not the formatter.
 */
import { formatter, PROFILE_US_DECIMAL_FEET, PROFILE_US_FEET_INCHES, toSI } from "@permitzip/bim-units";

const N = 100_000;

describe("units.format.100k cases", () => {
  it("CFM, decimal, grouped, with the unit suffix", () => {
    const format = formatter("flow_air", PROFILE_US_DECIMAL_FEET);
    expect(format(toSI(50, "cfm"))).toBe("50 CFM");
    expect(format(toSI(1250.5, "cfm"))).toBe("1,251 CFM");
    expect(format(toSI(20049.9, "cfm"))).toBe("20,050 CFM");
  });

  it("MBH, decimal, one place", () => {
    const format = formatter("flow_gas_energy", PROFILE_US_DECIMAL_FEET);
    expect(format(toSI(0.25, "MBH"))).toBe("0.3 MBH");
    expect(format(toSI(199, "MBH"))).toBe("199.0 MBH");
    expect(format(toSI(3999.25, "MBH"))).toBe("3,999.3 MBH");
  });

  it("length, feet-inches to 1/16\"", () => {
    const format = formatter("length", PROFILE_US_FEET_INCHES);
    expect(format(toSI(0, "ft"))).toBe(`0'-0"`);
    expect(format(toSI(10.52, "ft"))).toBe(`10'-6 1/4"`);
    expect(format(toSI(50_000 / 37, "ft"))).toBe(`1,351'-4 3/16"`);
  });

  it("every one of the perf gate's 100,000 inputs per case formats to text", () => {
    const cases: ReadonlyArray<readonly [string, (si: number) => string, (i: number) => number]> = [
      ["cfm_grouped", formatter("flow_air", PROFILE_US_DECIMAL_FEET), (i) => toSI(50 + ((i * 7919) % 20000) + (i % 10) / 10, "cfm")],
      ["mbh_1dp", formatter("flow_gas_energy", PROFILE_US_DECIMAL_FEET), (i) => toSI(((i * 31) % 4000) + 0.25, "MBH")],
      ["ft_in_16th", formatter("length", PROFILE_US_FEET_INCHES), (i) => toSI(((i * 104729) % 50000) / 37, "ft")],
    ];
    for (const [label, format, input] of cases) {
      let empty = 0;
      for (let i = 0; i < N; i++) if (format(input(i)).length === 0) empty++;
      expect({ label, empty }).toEqual({ label, empty: 0 });
    }
  });
});
