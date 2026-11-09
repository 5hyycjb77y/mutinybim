/**
 * @jest-environment node
 *
 * A13b: Find rooms from walls. A 3 × 3 grid of rooms (walls on 4 m lines
 * crossing each other) proposes the 9 rooms, each 3.8 × 3.8 m inside, in the
 * shape the Proposed rooms review shows, with a seed `place_space_in_walls`
 * makes it from. The wall bodies between the faces and the building's outer
 * ring are not rooms. A room that already has a space is not proposed again,
 * and accepting a proposal through its seed makes exactly that room.
 *
 * Fails on round 12's code: there is no detector from walls (only from
 * drawing linework) and no boundary index to read.
 */
import type { BimElement } from "../src";
import { detectRoomsFromWalls, WALL_ROOM_DETECTOR_ID } from "../src/spaces/detect";
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { L1, modelWith, wall } from "./a13b-fixtures";
import { Log } from "./a13a-fixtures";

const ID = "a13b-detect";

beforeAll(() => bindModelPacks(ID, PackSet.create([])));
afterAll(() => unbindModelPacks(ID));

function grid(): Log {
  const walls: BimElement[] = [];
  for (let i = 0; i <= 3; i++) {
    walls.push(wall(`V-${i}`, { x: i * 4000, y: 0 }, { x: i * 4000, y: 12000 }));
    walls.push(wall(`H-${i}`, { x: 0, y: i * 4000 }, { x: 12000, y: i * 4000 }));
  }
  return new Log(modelWith(walls, ID));
}

describe("a13b detect from walls", () => {
  it("a 3 × 3 grid proposes its 9 rooms and nothing else", () => {
    const m = grid();
    const found = detectRoomsFromWalls(m.head.elements, L1);
    expect(WALL_ROOM_DETECTOR_ID).toBe("walls-rooms@1");
    expect(found).toHaveLength(9);
    for (const p of found) {
      expect(p.areaM2).toBeCloseTo(3.8 * 3.8, 6);
      expect(p.confidence).toBe(1);
      expect(p.openings).toEqual([]);
    }
    expect(new Set(found.map((p) => p.key)).size).toBe(9);
  });

  it("a room that already has a space is not proposed again; accepting one by its seed makes that room", () => {
    const m = grid();
    m.ok({ type: "place_space_in_walls", spaceId: "s-mid", levelId: "L1", seed: { x: 6000, y: 6000 }, number: "105", name: "Office" });
    const found = detectRoomsFromWalls(m.head.elements, L1);
    expect(found).toHaveLength(8);
    expect(found.some((p) => p.seed.x > 4000 && p.seed.x < 8000 && p.seed.y > 4000 && p.seed.y < 8000)).toBe(false);
    const first = found[0];
    if (!first) throw new Error("no proposal");
    m.ok({ type: "place_space_in_walls", spaceId: "s-1", levelId: "L1", seed: first.seed, number: "101", name: "Office" });
    const made = m.head.elements["s-1"];
    expect(made?.kind === "space" && made.bounds.kind === "bounded" ? made.bounds.outline : null).toEqual(first.outline);
    expect(detectRoomsFromWalls(m.head.elements, L1)).toHaveLength(7);
  });
});
