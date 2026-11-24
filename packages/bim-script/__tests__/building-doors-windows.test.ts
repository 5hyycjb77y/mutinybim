/**
 * @jest-environment node
 *
 * Verifies `building.door`, `building.flipDoor`, and `building.window` typed
 * operation / swing / hinge / handing / partitioning support through `runScript`.
 */
import {
  DEFAULT_SETTINGS,
  ELEMENTS_CORE_FEATURE,
  ELEMENTS_CREATE_FEATURE,
  executeCommand,
  WALLS_TOP_CONSTRAINT_FEATURE,
  withUpgradePolicy,
  type ModelState,
  type Opening,
  type Revision,
} from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { building, defineScript, runScript, sliceModel, units } from "../src";

describe("building.door, building.flipDoor, and building.window script ergonomics", () => {
  beforeAll(() => {
    installFirstPartyAddOns();
  });

  it("writes canonical door operation, swing, hinge, handing, fireRating, flipDoor, and window partitioning", async () => {
    const script = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["wall", "opening"] },
      parameters: {},
      run(ctx) {
        const l1 = building.level(ctx, { name: "Level 1", elevation: units.ft(0), id: "L1" });
        const walls = building.walls(ctx, {
          level: l1,
          points: [
            { x: units.ft(0), y: units.ft(0) },
            { x: units.ft(40), y: units.ft(0) },
            { x: units.ft(40), y: units.ft(20) },
            { x: units.ft(0), y: units.ft(20) },
          ],
          closed: true,
          thickness: units.in(8),
          height: units.ft(10),
        });
        building.door(ctx, {
          id: "d-double",
          wall: walls.element(1),
          along: units.ft(8),
          width: units.ft(6),
          height: units.ft(7),
          mark: "D1",
          operation: "double",
          swing: "outward",
          fireRating: "90 min",
          external: true,
        });
        const dFlip = building.door(ctx, {
          id: "d-flip",
          wall: walls.element(1),
          along: units.ft(20),
          width: units.in(36),
          height: units.in(84),
          mark: "D2",
          handing: "RHR",
        });
        building.flipDoor(ctx, dFlip, "both");
        building.door(ctx, {
          id: "d-overhead",
          wall: walls.element(1),
          along: units.ft(32),
          width: units.ft(10),
          height: units.ft(8),
          mark: "D3",
          operation: "overhead",
          frameDepth: units.in(6),
        });
        building.window(ctx, {
          id: "w-dh",
          wall: walls.element(2),
          along: units.ft(10),
          width: units.ft(4),
          height: units.ft(5),
          sill: units.ft(3),
          mark: "W1",
          partitioning: "double_hung",
          external: true,
        });
      },
    });

    const empty: ModelState = { modelId: "dw-script", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    const out = await runScript(script, {
      slice: sliceModel(empty, script.manifest.reads, [], [ELEMENTS_CORE_FEATURE, ELEMENTS_CREATE_FEATURE, WALLS_TOP_CONSTRAINT_FEATURE]),
      values: {},
      scriptHash: "sha256:door-window-test",
    });
    expect(out.kind).toBe("edits");
    if (out.kind !== "edits") throw new Error("expected edits output");

    let model = empty;
    withUpgradePolicy(
      () => true,
      () => {
        for (const batch of out.batches) {
          for (const cmd of batch.commands) {
            const r = executeCommand(model, cmd);
            if (!r.ok) throw new Error(`${cmd.type}: ${r.error.message}`);
            model = { ...r.model, revision: (model.revision + 1) as Revision };
          }
        }
      },
    );

    const dDouble = model.elements["d-double"] as Opening;
    expect(dDouble.values).toMatchObject({
      "architecture.door_operation": "DOUBLE_DOOR_SINGLE_SWING",
      "architecture.door_swing": "OUTWARD",
      "host.side": -1,
      "arch.fire_rating": "90 min",
      "architecture.is_external": true,
    });

    // Started as RHR (SINGLE_SWING_RIGHT, side -1), flipped "both" -> SINGLE_SWING_LEFT, side 1, LH!
    const dFlipped = model.elements["d-flip"] as Opening;
    expect(dFlipped.values).toMatchObject({
      "architecture.door_operation": "SINGLE_SWING_LEFT",
      "host.side": 1,
      "architecture.door_handing": "LH",
    });

    const dOverhead = model.elements["d-overhead"] as Opening;
    expect(dOverhead.values?.["architecture.door_operation"]).toBe("ROLLINGUP");
    expect(dOverhead.values?.["architecture.frame_depth"]).toBeCloseTo(6 * 25.4, 1);

    const wDh = model.elements["w-dh"] as Opening;
    expect(wDh.values).toMatchObject({
      "architecture.window_partitioning": "DOUBLE_PANEL_HORIZONTAL",
      "architecture.is_external": true,
    });
  });
});
