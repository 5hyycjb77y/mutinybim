/**
 * @jest-environment node
 *
 * The plumbing adapter now reads its piped services and source roles from the
 * service registry instead of hard-coded strings. Equivalence: on the plumbing
 * riser fixture and on a model with every starter plumbing part placed (every source role:
 * water heaters, meter, gas regulator, grease interceptor, sewer parts), the
 * adapter answers exactly what the round-4 adapter answered for every part
 * as a source, every part's connectors, and every source × member connector.
 * The 7929 QA fixture has no parts (load rows only), so its golden is its
 * donut totals (the host fixture tests); the 7903 82 kW = 342 A
 * study is loads-7303-electrical. Both unchanged.
 */
import { paramValue, type ModelState } from "../src";
import { plumbingStarterTypes } from "@permitzip/bim-pack-plumbing";
import { plumbingSourceRole, type PlumbingSourceRole } from "@permitzip/bim-pack-plumbing";
import { compare } from "./r5s-old-plumbing-adapter";
import { DrainageBuilding, FT } from "./drainage-fixtures";
import { stackRisers } from "./fixtures/stack-risers";

/** Every starter plumbing part placed once, plus the drainage roles (sewer connection, pump, valve). */
function everyStarterPart(): ModelState {
  const b = new DrainageBuilding();
  b.manhole({ invertFt: -8 });
  let x = 0;
  for (const entry of plumbingStarterTypes("test")) {
    const id = `p-${entry.id.replace(/[^a-z0-9]+/gi, "-")}`;
    b.ok({ type: "place_part", partId: id, typeId: entry.id, partType: entry.definition, levelId: "lvl-1", position: { x, y: 0 }, mark: id });
    x += 6 * FT;
  }
  return b.head;
}

describe("plumbing adapter: registry-driven answers equal the round-4 answers", () => {
  it("the plumbing riser fixture", () => {
    expect(compare(stackRisers().head).parts).toBeGreaterThan(0);
  });

  it("every starter plumbing part and every drainage role, as source and as member", () => {
    const m = everyStarterPart();
    const roles = new Set(Object.values(m.elements).flatMap((e) => (e.kind === "part" ? [plumbingSourceRole(m.elements, e)] : [])));
    for (const r of ["water_heater", "water_meter", "gas_meter", "grease_interceptor", "sewer_connection"]) expect(roles.has(r as PlumbingSourceRole)).toBe(true);
    const { pairs } = compare(m);
    expect(pairs).toBeGreaterThan(500);
    // The fixture types never carry a type-level plumbing_source; the roles above come from the starter designators and heater kinds.
    const gi = Object.values(m.elements).find((e) => e.kind === "part" && plumbingSourceRole(m.elements, e) === "grease_interceptor");
    const giType = gi?.kind === "part" ? m.elements[gi.typeId] : undefined;
    expect(giType?.kind === "part_type" && gi?.kind === "part" ? paramValue(giType.definition, gi.values, "plumbing_source") : "none").toBeUndefined();
  });
});
