/**
 * @jest-environment node
 *
 * A13b: bounded spaces change nothing for the shapes before them. Outline,
 * rooms and typed (none) spaces write the same bytes as round 12, with or
 * without a bounding row in force and with or without the peer feature;
 * the bounded writer is gated on `spaces:bounded`, so a round 12 peer is
 * never sent one; and placing a bounded space leaves the other spaces'
 * records untouched.
 *
 * Fails on round 12's code: `place_space_in_walls` doesn't exist (the gate
 * and the untouched-neighbours cases are refused as an unknown command).
 */
import { asElementId, canonicalJson, withUpgradePolicy, type BimElement } from "../src";
import { withPackSet } from "../src/packs";
import { executeSpaceDesignCommand, SPACES_BOUNDED_NOT_YET, type SpaceDesignCommand } from "../src/spaces/space-commands";
import { SPACES_BOUNDED_FEATURE } from "../src/spaces/boundary-facts";
import { box, modelWith, BUILTINS } from "./a13b-fixtures";

const room: BimElement = { id: asElementId("r-1"), kind: "room", version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "A", discipline: "architecture" }, number: "201", name: "Lab", outline: [{ x: 10000, y: 0 }, { x: 14000, y: 0 }, { x: 14000, y: 3000 }, { x: 10000, y: 3000 }], areaSqM: 12 } as BimElement;
const OUTLINE = [{ x: 20000, y: 0 }, { x: 23000, y: 0 }, { x: 23000, y: 3000 }, { x: 20000, y: 3000 }];

const CREATE: SpaceDesignCommand = {
  type: "create_space",
  spaces: [
    { spaceId: "s-outline", number: "301", name: "Drawn", levelId: "L1", outline: OUTLINE },
    { spaceId: "s-none", number: "302", name: "Typed" },
  ],
};

// Round 12's bytes for each old shape, as the command writes them (the commit stamps version and authored revisions).
const ROUND_12 = {
  "s-outline": '{"authoredRev":{},"bounds":{"kind":"outline","outline":[{"x":20000,"y":0},{"x":23000,"y":0},{"x":23000,"y":3000},{"x":20000,"y":3000}]},"id":"s-outline","kind":"space","levelId":"L1","name":"Drawn","number":"301","origin":{"kind":"drawn"},"partition":{"discipline":"architecture","level":"*","zone":"*"},"version":0}',
  "s-none": '{"authoredRev":{},"bounds":{"kind":"none"},"id":"s-none","kind":"space","name":"Typed","number":"302","origin":{"kind":"typed"},"partition":{"discipline":"architecture","level":"*","zone":"*"},"version":0}',
  "space:r-1": '{"authoredRev":{},"bounds":{"kind":"rooms","roomIds":["r-1"]},"id":"space:r-1","kind":"space","levelId":"L1","name":"Lab","number":"201","origin":{"kind":"from_room","roomId":"r-1"},"partition":{"discipline":"architecture","level":"*","zone":"*"},"version":0}',
} as const;

function oldShapes(wrap: <T>(fn: () => T) => T): Record<string, string> {
  const m = modelWith([...box("w", 0, 0, 6000, 4000), room]);
  const a = wrap(() => executeSpaceDesignCommand(m, CREATE));
  if (!a.ok) throw new Error(a.error.message);
  const b = wrap(() => executeSpaceDesignCommand(a.model, { type: "make_spaces_from_rooms", roomIds: ["r-1"] }));
  if (!b.ok) throw new Error(b.error.message);
  return Object.fromEntries(Object.keys(ROUND_12).map((k) => [k, canonicalJson(b.model.elements[k])]));
}

const peerReads = <T>(fn: () => T): T => withUpgradePolicy((f) => f === SPACES_BOUNDED_FEATURE, fn);

describe("a13b old spaces identical", () => {
  it("outline, rooms and typed spaces write round 12's bytes, whatever bounds and whatever the peer reads", () => {
    const bare = oldShapes((fn) => fn());
    expect(bare).toEqual(ROUND_12);
    expect(oldShapes((fn) => withPackSet(BUILTINS, fn))).toEqual(ROUND_12);
    expect(oldShapes((fn) => withPackSet(BUILTINS, () => peerReads(fn)))).toEqual(ROUND_12);
  });

  it("a peer without spaces:bounded is never sent a bounded space", () => {
    const m = modelWith(box("w", 0, 0, 6000, 4000));
    const r = withPackSet(BUILTINS, () => executeSpaceDesignCommand(m, { type: "place_space_in_walls", spaceId: "s-b", levelId: "L1", seed: { x: 3000, y: 2000 } }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toBe(SPACES_BOUNDED_NOT_YET);
    expect(!r.ok && r.error.code).toBe("invalid_value");
  });

  it("placing a bounded space leaves every other space's record as it was", () => {
    const m = modelWith([...box("w", 0, 0, 6000, 4000), room]);
    const a = executeSpaceDesignCommand(m, CREATE);
    if (!a.ok) throw new Error(a.error.message);
    const before = canonicalJson([a.model.elements["s-outline"], a.model.elements["s-none"]]);
    const b = withPackSet(BUILTINS, () => peerReads(() => executeSpaceDesignCommand(a.model, { type: "place_space_in_walls", spaceId: "s-b", levelId: "L1", seed: { x: 3000, y: 2000 } })));
    if (!b.ok) throw new Error(b.error.message);
    expect(b.changedIds).toEqual(["s-b"]);
    expect(canonicalJson([b.model.elements["s-outline"], b.model.elements["s-none"]])).toBe(before);
    const placed = b.model.elements["s-b"];
    expect(placed?.kind === "space" && placed.bounds.kind).toBe("bounded");
  });
});
