/**
 * @jest-environment node
 *
 * Splitting a room is incremental (perf row `spaces.split.one_line`, 5 / 10 ms
 * at 250k): the split traces each new sub-room once and the follow-the-walls
 * hook re-traces nothing, because a separation line lies inside the room it
 * splits and that room's trace ignores its own lines. The changeset holds the
 * line, the sub-rooms and the loads it moved, never the parent or a
 * neighbour. Fails on the round 13 build before this change: the hook traced
 * the parent again (three traces for a two-way split).
 */
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { roomAtStats } from "../src/spaces/boundaries/room-at";
import { LINE, officeWithLoads } from "./a13b-split-fixtures";

const ID = "a13b-split-incremental";

beforeAll(() => bindModelPacks(ID, PackSet.create([])));
afterAll(() => unbindModelPacks(ID));

describe("a13b split is incremental", () => {
  it("traces each sub-room once and writes only the line, the sub-rooms and the moved loads", () => {
    const m = officeWithLoads(ID);
    const before = roomAtStats.traces;
    const changeset = m.ok({ type: "split_space", spaceId: "s-101", line: LINE, typedLoadsTo: "101A" });
    expect(roomAtStats.traces - before).toBe(2);
    const kinds = changeset.elements.map((el) => `${el.kind}:${el.id}`).sort();
    expect(kinds.filter((k) => k.startsWith("space:"))).toEqual(["space:s-101-A", "space:s-101-B"]);
    expect(kinds.filter((k) => k.startsWith("space_separator:"))).toHaveLength(1);
    expect(kinds.every((k) => /^(space|space_separator|load_point):/.test(k))).toBe(true);
  });
});
