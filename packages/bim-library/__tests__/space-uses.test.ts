/**
 * @jest-environment node
 *
 * Space uses (F3): one row per use carrying several codes' rates, each with
 * its clause; firms replace or add rows. Before this file there was no space
 * use anywhere, so a space could not get a default occupancy or a rate.
 */
import { BUILTIN_SPACE_USES, SPACE_USE_RATE_TARGETS, spaceUseCatalog, spaceUseRowSchema } from "@permitzip/bim-library";

describe("space uses", () => {
  it("ships rows that carry IMC, NEC, IBC and IPC values with a clause on every one", () => {
    const dining = BUILTIN_SPACE_USES.find((r) => r.id === "restaurant_dining");
    expect(dining?.occupantsPer1000Ft2?.value).toBe(70);
    expect(dining?.rates.map((r) => [r.key, r.value, r.unit, `${r.cite.code} ${r.cite.clause}`])).toEqual([
      ["outdoor_air_people", 7.5, "cfm/occ", "IMC Table 403.3.1.1"],
      ["outdoor_air_area", 0.18, "cfm/ft2", "IMC Table 403.3.1.1"],
      ["lighting", 1.5, "VA/ft2", "NEC Table 220.12"],
    ]);
    expect(dining?.occupantLoadFactor).toMatchObject({ ft2PerOccupant: 15, area: "net" });
    expect(dining?.occupancy?.group).toBe("A-2");
    // Nothing here has been checked against a code library record yet, and every row says so.
    expect(BUILTIN_SPACE_USES.flatMap((r) => r.rates).every((r) => r.cite.verified === false)).toBe(true);
  });

  it("refuses a rate in a unit that isn't a rate of that kind", () => {
    const bad = { id: "x", revision: 1, name: "X", category: "Firm", rates: [{ key: "outdoor_air_area", value: 1, unit: "cfm", cite: { code: "IMC", edition: null, clause: "T", verified: false } }] };
    expect(spaceUseRowSchema.safeParse(bad).success).toBe(false);
    expect(SPACE_USE_RATE_TARGETS.outdoor_air_area.kind).toBe("airflow_per_area");
  });

  it("layers a firm's rows: same id replaces, a new id adds, a bad row is reported and left out", () => {
    const firmDining = { ...BUILTIN_SPACE_USES[0], name: "Dining (firm standard)", revision: 2 };
    const brewery = { id: "firm.brewhouse", revision: 1, name: "Brewhouse", category: "Food and beverage", rates: [{ key: "exhaust_area", value: 0.7, unit: "cfm/ft2", cite: { code: "Firm", edition: null, clause: "PZ-M-12", verified: true } }] };
    const { catalog, issues } = spaceUseCatalog([firmDining, brewery, { id: "Bad Id" }]);
    expect(catalog.get("restaurant_dining")?.name).toBe("Dining (firm standard)");
    expect(catalog.get("firm.brewhouse")?.rates).toHaveLength(1);
    expect(catalog.rows).toHaveLength(spaceUseCatalog([]).catalog.rows.length + 1);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/^Row 3:/);
  });
});
