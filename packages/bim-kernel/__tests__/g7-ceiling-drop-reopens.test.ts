/**
 * @jest-environment node
 *
 * Round 7 lane G: dropping Room 104's ceiling from 10 ft to 8 ft re-opens
 * its head spacing. Each head covers less area under a low ceiling (the
 * synthetic rule's own words), so the count goes from 2 to 3, the two heads
 * already there no longer meet it, and "what re-opens" names the ceiling and
 * the room as the cause. Rules that don't read the ceiling stay put.
 *
 * Fails on the code before round 7: no graph engine, no ceiling input, no
 * re-open on room makeup.
 */
import { dependsOn, requirementsAt, unbindRequirementsSnapshot, type ModelState } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { bindStudy, FT, floor, run, ZT_PACK } from "./g7-fixtures";

const ID = "g7-ceiling";

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

const headsIn104 = (m: ModelState) => requirementsAt(m, { kind: "space", id: "S104" }).find((r) => r.key === "fp.head_count");

describe("g7 ceiling drop re-opens head spacing", () => {
  it("lowering CLG-104 to 8 ft raises Room 104's head count to 3 and the two heads no longer meet it", () => {
    const model = floor(ID);
    expect(headsIn104(model)).toMatchObject({ value: 2, fulfilment: { state: "met" } });

    const lowered = run(model, { type: "edit_ceiling", ceilingId: "CLG-104", heightMm: 8 * FT });
    const after = headsIn104(lowered);
    expect(after).toMatchObject({ value: 3, unit: "ea", fulfilment: { state: "not_met", elementIds: ["SP-14", "SP-15"] } });
    expect(after?.reads).toContain("CLG-104");
    expect(after?.cause).toContain("Room 104");
  });

  it("asked before the edit, what re-opens names the ceiling and the room, and only the ceiling's readers move", () => {
    const model = floor(ID);
    requirementsAt(model, { kind: "space", id: "S104" });
    const lowered = run(model, { type: "edit_ceiling", ceilingId: "CLG-104", heightMm: 8 * FT });
    const answer = dependsOn(model, { changedIds: ["CLG-104"], after: lowered.elements, label: "Lower Room 104's ceiling to 8 ft" });

    expect(answer.items.map((i) => i.label)).toEqual(["Head spacing in Room 104"]);
    const [item] = answer.items;
    expect(item?.cause).toBe("ceiling in Room 104 lowered: 2 ea → 3 ea");
    expect(item?.edges?.[0]).toMatchObject({ from: { kind: "space", id: "S104" }, kind: "anchors" });
    expect(answer.more).toBe(0);
    // Exit count, occupant load and finish class in Room 104 don't read the ceiling.
    expect(answer.items.some((i) => /Exit count|Occupant load|finish/i.test(i.label))).toBe(false);
  });
});
