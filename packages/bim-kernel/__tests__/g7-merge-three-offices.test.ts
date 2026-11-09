/**
 * @jest-environment node
 *
 * Round 7 lane G: "what happens if I take out these three walls?" Removing
 * W-12, W-13 and W-14 on the synthetic floor merges Offices 101–103 and
 * opens 102 to the corridor. Before the edit, `dependsOn` lists what
 * re-opens: occupancy, exits, outside air, hazard and corridor separation
 * in the offices (each with the walls named as the cause), ranked, the top
 * five and "and 1 more" (the corridor's width). The answer carries the
 * quantity change (fewer walls) and never copies the model.
 *
 * Fails on the code before round 7: no `dependsOn`, no re-open on room
 * makeup.
 */
import { dependsOn, DEPENDS_ON_EMPTY, requirementsOf, unbindRequirementsSnapshot } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { bindStudy, floor, ZT_PACK } from "./g7-fixtures";

const ID = "g7-merge";

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

const OFFICES = "Office 101, Office 102 and Office 103";

describe("g7 merge three offices: what re-opens, ranked, with causes", () => {
  it("removing W-12, W-13 and W-14 re-opens five office requirements first, then the corridor", () => {
    const model = floor(ID);
    requirementsOf(model);
    const before = JSON.stringify(model.elements);
    const answer = dependsOn(model, { removedIds: ["W-12", "W-13", "W-14"], label: "Merge Offices 101–103" });

    expect(answer.items.map((i) => i.label)).toEqual([
      `Corridor separation in ${OFFICES}`,
      `Exit count in ${OFFICES}`,
      `Hazard class in ${OFFICES}`,
      `Occupant load in ${OFFICES}`,
      `Outside air in ${OFFICES}`,
    ]);
    expect(answer.more).toBe(1);
    for (const item of answer.items) {
      expect(item.weight).toBe(3);
      expect(item.node.kind).toBe("requirement");
      expect(new Set(item.edges?.map((e) => e.cause))).toEqual(
        new Set(["wall W-12 bounding Office 101 removed: re-opens", "walls W-12, W-13 and W-14 bounding Office 102 removed: re-opens", "wall W-13 bounding Office 103 removed: re-opens"]),
      );
      expect(item.cause).toMatch(/bounding Office 10[123] removed/);
    }

    expect(answer.quantityDeltas.length).toBeGreaterThan(0);
    expect(answer.quantityDeltas.some((d) => d.delta < 0)).toBe(true);
    // Evaluated on the touched neighbourhood: the model itself is unchanged.
    expect(JSON.stringify(model.elements)).toBe(before);
  });

  it("asked about one wall without an edit, it says what would re-open if the wall changes", () => {
    const answer = dependsOn(floor(ID), { kind: "element", id: "W-12" });
    expect(answer.items.map((i) => i.label)).toContain("Exit count in Office 101 and Office 102");
    expect(answer.items[0]?.cause).toMatch(/^if wall W-12 bounding Office 10[12] changes/);
  });

  it("something no rule reads re-opens nothing, and says so", () => {
    const answer = dependsOn(floor(ID), { kind: "element", id: "L1" });
    expect(answer).toMatchObject({ items: [], more: 0, empty: DEPENDS_ON_EMPTY, quantityDeltas: [] });
  });
});
