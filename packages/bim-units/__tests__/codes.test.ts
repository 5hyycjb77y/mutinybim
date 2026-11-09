import { KIND_IDS, KIND_UNITS, UNIT_CODES } from "@permitzip/bim-units";

describe("unit code list", () => {
  it("has unique kind ids and unit codes", () => {
    expect(new Set(KIND_IDS).size).toBe(KIND_IDS.length);
    expect(new Set(UNIT_CODES).size).toBe(UNIT_CODES.length);
  });

  it("gives every kind at least one unit and uses every unit in some kind", () => {
    const used = new Set<string>();
    for (const kind of KIND_IDS) {
      const units: readonly string[] = KIND_UNITS[kind];
      expect(units.length).toBeGreaterThan(0);
      for (const u of units) used.add(u);
    }
    expect([...UNIT_CODES].filter((u) => !used.has(u))).toEqual([]);
  });
});
