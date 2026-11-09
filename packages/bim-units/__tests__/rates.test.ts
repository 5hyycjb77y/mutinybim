import { convert, dim, KINDS, kindsOfUnit, multiplyDimensions, sameDimension, unitAllowed, UNITS } from "@permitzip/bim-units";

/** Density rates (space uses × area or occupants): power per area, airflow per area, airflow per person. */
describe("density rate kinds", () => {
  it("converts the code tables' units the way the codes print them", () => {
    // NEC 220.12: 3 VA/ft² ≈ 32.3 VA/m².
    expect(convert(3, "VA/ft2", "VA/m2")).toBeCloseTo(32.29, 2);
    // ASHRAE 62.1 Table 6-1 prints 0.06 cfm/ft² as 0.3 L/s·m² and 5 cfm/person as 2.5 L/s·person (rounded in the table).
    expect(convert(0.06, "cfm/ft2", "L/s/m2")).toBeCloseTo(0.305, 3);
    expect(convert(5, "cfm/occ", "L/s/occ")).toBeCloseTo(2.36, 2);
    expect(convert(1, "W/ft2", "W/m2")).toBeCloseTo(10.764, 3);
  });

  it("keeps a rate apart from the kind that happens to share its dimension", () => {
    // cfm/ft² is L·T⁻¹, like a velocity, but it is not a velocity.
    expect(sameDimension(UNITS["cfm/ft2"].dimension, UNITS["ft/min"].dimension)).toBe(true);
    expect(kindsOfUnit("cfm/ft2")).toEqual(["airflow_per_area"]);
    expect(() => convert(1, "cfm/ft2", "ft/min")).toThrow(/measure different things/);
    expect(unitAllowed("velocity", "cfm/ft2")).toBe(false);
  });

  it("multiplies back to the load: a rate × area is power, × people is airflow", () => {
    expect(sameDimension(multiplyDimensions(KINDS.power_per_area.dimension, KINDS.area.dimension), KINDS.power_real.dimension)).toBe(true);
    expect(sameDimension(multiplyDimensions(KINDS.airflow_per_area.dimension, KINDS.area.dimension), KINDS.flow_air.dimension)).toBe(true);
    expect(sameDimension(multiplyDimensions(KINDS.airflow_per_person.dimension, KINDS.occupants.dimension), KINDS.flow_air.dimension)).toBe(true);
    expect(sameDimension(KINDS.airflow_per_person.dimension, dim({ L: 3, T: -1, C: -1 }))).toBe(true);
  });

  it("does not let rates be summed into a total", () => {
    expect(KINDS.power_per_area.aggregation.allowed).not.toContain("sum");
    expect(KINDS.airflow_per_person.aggregation.default).toBe("none");
  });
});
