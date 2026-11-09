/**
 * @jest-environment node
 *
 * Round 5b f-equipment, FOUNDATION adjustments D1: parameter facets are
 * data. A facet registry value (built-in rows plus library rows) decides the
 * sections; a parameter names its facet through its group. Fails on the
 * phase-1 code: there was no facet registry, only a closed list of trades
 * with key and unit guessing, and no fire protection, architecture, civil or
 * construction facet.
 */
import { BUILTIN_FACET_REGISTRY, createFacetRegistry, facetLabel, facetOfGroup, groupParametersByFacet, unknownGroupId, withFacetRows } from "../requirements/facets";

describe("r5e parameter facets are data", () => {
  it("the built-in rows, in order, each with its discipline", () => {
    expect(BUILTIN_FACET_REGISTRY.rows.map((r) => r.id)).toEqual(["identity", "electrical", "gas", "water", "drainage", "mechanical", "structural", "fire_protection", "architecture", "civil", "construction"]);
    expect(BUILTIN_FACET_REGISTRY.byId.get("construction")?.discipline).toBe("general_contracting");
  });

  it("a group names a facet by id or label, ignoring case and spacing; nothing else is guessed", () => {
    expect(facetOfGroup("Fire protection")?.id).toBe("fire_protection");
    expect(facetOfGroup("fire_protection")?.id).toBe("fire_protection");
    expect(facetOfGroup("  ELECTRICAL ")?.id).toBe("electrical");
    expect(facetOfGroup("Kitchen")).toBeNull();
    // No synonyms and no prefix or unit guessing in the kernel.
    expect(facetOfGroup("Plumbing")).toBeNull();
    expect(facetOfGroup(undefined)).toBeNull();
  });

  it("Fire protection lands in its facet; Kitchen gets its own section after the known ones; ungrouped reads last as Other", () => {
    const items = [
      { group: "Kitchen", label: "Hood ID" },
      { label: "Whatever" },
      { group: "Fire protection", label: "K-factor" },
      { group: "Electrical", label: "MCA" },
      { group: "kitchen", label: "Hood type" },
      { group: "Life safety", label: "Fire rating" },
    ];
    expect(groupParametersByFacet(items).map((g) => [g.id, g.facet, g.label, g.items.map((i) => i.label)])).toEqual([
      ["electrical", "electrical", "Electrical", ["MCA"]],
      ["fire_protection", "fire_protection", "Fire protection", ["K-factor"]],
      ["other:kitchen", null, "Kitchen", ["Hood ID", "Hood type"]],
      ["other:life_safety", null, "Life safety", ["Fire rating"]],
      ["other:other", null, "Other", ["Whatever"]],
    ]);
  });

  it("library rows layer in as a value: a firm facet sorts by its order, no code change, no global state", () => {
    const firm = withFacetRows(BUILTIN_FACET_REGISTRY, [{ id: "firm:kitchen", label: "Kitchen", order: 65 }]);
    const groups = groupParametersByFacet([{ group: "Kitchen", label: "Hood ID" }, { group: "Mechanical", label: "Airflow" }, { group: "Structural", label: "Weight" }], firm);
    expect(groups.map((g) => g.id)).toEqual(["mechanical", "firm:kitchen", "structural"]);
    // The built-in registry is unchanged.
    expect(facetOfGroup("Kitchen")).toBeNull();
    expect(() => withFacetRows(BUILTIN_FACET_REGISTRY, [{ id: "firm:elec", label: "Electrical", order: 1 }])).toThrow(/both answer to "electrical"/);
    expect(() => createFacetRegistry([{ id: "Bad Id", label: "Bad", order: 1 }])).toThrow(/isn't a registry id/);
  });

  it("a stored facet id this release doesn't know shows its raw words", () => {
    expect(facetLabel("fire_protection")).toBe("Fire protection");
    expect(facetLabel("fa.notification")).toBe("Notification");
    expect(facetLabel(unknownGroupId("Life safety"))).toBe("Life safety");
  });
});
