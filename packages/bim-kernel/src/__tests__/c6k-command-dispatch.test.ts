/**
 * @jest-environment node
 *
 * `kernel.packs.command_dispatch` (round 6 lane K): a command type may be a
 * pack's (`COMMAND_POINT`). Both shapes parse through `commandSchema`, the
 * parser every host uses: a kernel command (`move_tag`) and the first-party
 * pack command (`place_service_layout`). What a parse costs is measured in
 * plain Node by the BIM perf gate (scripts/perf/mutinybim/command-dispatch.ts),
 * against the same budgets this test used to hold.
 */
import { commandSchema } from "..";

const MOVE_TAG = { type: "move_tag", tagId: "t-1", offset: { x: 10, y: 20 } };
const LAYOUT = {
  type: "place_service_layout",
  label: "Service layout",
  levelId: "lvl-1",
  partTypes: [],
  equipment: [{ partId: "p-1", typeId: "t-1", position: { x: 0, y: 0 }, values: { name: "MDP" } }],
  feeders: [],
};

describe("c6k kernel.packs.command_dispatch", () => {
  it("parses a kernel command and a pack command", () => {
    expect(commandSchema.safeParse(MOVE_TAG).success).toBe(true);
    expect(commandSchema.safeParse(LAYOUT).success).toBe(true);
  });

  it("rejects a command whose type no kernel or pack registers", () => {
    expect(commandSchema.safeParse({ ...MOVE_TAG, type: "not_a_command" }).success).toBe(false);
  });
});
