/**
 * @jest-environment node
 *
 * `trimZeros`: decimal precision as a most, not an exact count, so a profile
 * can print "75 kW" and "2.5 A" the way v1 schedules did. Before, every
 * decimal display padded to its digits ("75.00 kW").
 */
import { formatter, PROFILE_US_FEET_INCHES, toSI, type DisplayProfile } from "@permitzip/bim-units";

const plain: DisplayProfile = { ...PROFILE_US_FEET_INCHES, id: "test.plain", trimZeros: true, thousands: "" };

describe("trimZeros", () => {
  it("drops trailing zeros and a bare decimal mark, and keeps the unit symbol", () => {
    const kw = formatter("power_real", plain, { unit: "kW", precision: { kind: "decimals", digits: 2 } });
    expect(kw(toSI(75, "kW"))).toBe("75 kW");
    expect(kw(toSI(2.5, "kW"))).toBe("2.5 kW");
    expect(kw(toSI(2.125, "kW"))).toBe("2.13 kW");
    expect(kw(toSI(0, "kW"))).toBe("0 kW");
    expect(kw(toSI(-1.5, "kW"))).toBe("-1.5 kW");
    expect(kw(toSI(1500, "kW"))).toBe("1500 kW");
  });

  it("leaves whole-number precision, fractions and the default profile alone", () => {
    expect(formatter("flow_air", plain, { unit: "cfm", precision: { kind: "decimals", digits: 0 } })(toSI(1200, "cfm"))).toBe("1200 CFM");
    expect(formatter("power_real", PROFILE_US_FEET_INCHES, { unit: "kW", precision: { kind: "decimals", digits: 2 } })(toSI(75, "kW"))).toBe("75.00 kW");
  });

  it("a column override wins over the profile, both ways", () => {
    const on = formatter("power_real", PROFILE_US_FEET_INCHES, { unit: "kW", precision: { kind: "decimals", digits: 2 }, trimZeros: true });
    const off = formatter("power_real", plain, { unit: "kW", precision: { kind: "decimals", digits: 2 }, trimZeros: false });
    expect(on(toSI(75, "kW"))).toBe("75 kW");
    expect(off(toSI(75, "kW"))).toBe("75.00 kW");
  });
});
