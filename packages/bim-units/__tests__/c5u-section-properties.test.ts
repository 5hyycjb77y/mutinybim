import { KINDS, PROFILE_METRIC_MM, PROFILE_US_DECIMAL_FEET, convert, formatQuantity, qty, unitAllowed } from "@permitzip/bim-units";

/**
 * Section properties as kinds (5c structural proof pack, "Foundation gaps
 * found"): before 5c a pack had to carry Ix and Sx as bare numbers with the
 * unit in the key. Values are W16X26 from AISC Manual Table 1-1
 * (Ix 301 in⁴, Sx 38.4 in³).
 */
describe("section properties", () => {
  it("converts a moment of inertia between in⁴, cm⁴ and mm⁴", () => {
    expect(convert(301, "in4", "mm4")).toBeCloseTo(301 * 25.4 ** 4, 0);
    expect(convert(301, "in4", "cm4")).toBeCloseTo(12528.6, 1);
    expect(convert(12528.6, "cm4", "in4")).toBeCloseTo(301, 2);
  });

  it("converts a section modulus between in³ and mm³", () => {
    expect(convert(38.4, "in3", "mm3")).toBeCloseTo(629_263.3, 0);
    expect(convert(629.2633, "cm3", "in3")).toBeCloseTo(38.4, 3);
  });

  it("keeps section modulus a kind of its own, not a volume", () => {
    expect(KINDS.section_modulus.dimension).toEqual(KINDS.volume.dimension);
    expect(KINDS.section_modulus.aggregation.default).toBe("none");
    expect(unitAllowed("section_modulus", "in3")).toBe(true);
    expect(unitAllowed("section_modulus", "gal")).toBe(false);
    expect(unitAllowed("second_moment_of_area", "in4")).toBe(true);
    expect(unitAllowed("second_moment_of_area", "in3")).toBe(false);
  });

  it("formats in each built-in profile", () => {
    const ix = qty("second_moment_of_area", 301, "in4");
    expect(formatQuantity(ix, "second_moment_of_area", PROFILE_US_DECIMAL_FEET)).toBe("301.0 in⁴");
    expect(formatQuantity(ix, "second_moment_of_area", PROFILE_METRIC_MM)).toBe("12 528.6 cm⁴");
  });
});
