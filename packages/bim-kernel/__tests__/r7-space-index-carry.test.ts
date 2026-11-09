/**
 * @jest-environment node
 *
 * The space index rides each new revision (registerRevisionCarry): after an
 * edit, reading a space's measure moves the index by the changed ids instead
 * of re-reading every space. Before, nothing called advanceSpaceIndex, so the
 * first read after any edit re-read the whole model (the requirements graph's
 * one-edit read took 17 ms at 250k elements against a 10 ms limit).
 */
import { spaceIndexStats, spaceMeasure, type ElementId } from "../src";
import { floor, run } from "./g7-fixtures";

const S101 = "S101" as ElementId;

describe("r7 space index carry", () => {
  it("an edit moves the index by what changed; the next read re-reads no other space", () => {
    const m0 = floor("r7-space-index-carry");
    expect(spaceMeasure(m0.elements, S101)?.areaM2).toBeCloseTo(16, 3);
    const before = spaceIndexStats(m0.elements);
    const m1 = run(m0, { type: "edit_space", spaceId: "S101", occupants: 9 });
    expect(spaceMeasure(m1.elements, S101)?.areaM2).toBeCloseTo(16, 3);
    const after = spaceIndexStats(m1.elements);
    expect(after.fullSyncs).toBe(before.fullSyncs);
    expect(after.measured - before.measured).toBeLessThanOrEqual(1);
  });
});
