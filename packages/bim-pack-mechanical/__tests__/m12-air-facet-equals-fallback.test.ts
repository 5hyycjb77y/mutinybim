/**
 * @jest-environment node
 *
 * Round 12's open handshake, closed in round 13 (K13 step 5): Mechanical's
 * air load section row equals the kernel's transitional fallback row field
 * for field, and it is the row the set in force reads for "air", so the
 * coordinator can delete `requirements/facet-fallback.ts` with nothing read
 * differently.
 *
 * Fails on round 12's code: Mechanical contributed no load section; "air"
 * came only from the fallback.
 */
import { LOAD_SECTION_POINT, loadSectionRows } from "@permitzip/bim-kernel";
import { ROUND13_LOAD_SECTION_IDS, round13LoadSection } from "../../bim-kernel/__tests__/fixtures/k14-round13-stand-ins";
import { MECHANICAL_AIR_LOAD_SECTION, MECHANICAL_CONTRIBUTIONS } from "../src";

describe("m12-air-facet-equals-fallback", () => {
  it("equals round 13's air row byte for byte (the kernel's stand-in, frozen when K14 deleted it)", () => {
    expect(JSON.stringify(MECHANICAL_AIR_LOAD_SECTION)).toBe(round13LoadSection("air").json);
  });

  it("is contributed by the add-on and is the row the set in force reads for air", () => {
    expect(MECHANICAL_CONTRIBUTIONS.find((c) => c.pointId === LOAD_SECTION_POINT.id)?.items).toEqual([MECHANICAL_AIR_LOAD_SECTION]);
    expect(loadSectionRows().find((r) => r.id === "air")).toBe(MECHANICAL_AIR_LOAD_SECTION);
    expect(loadSectionRows().map((r) => r.id)).toEqual(ROUND13_LOAD_SECTION_IDS);
  });
});
