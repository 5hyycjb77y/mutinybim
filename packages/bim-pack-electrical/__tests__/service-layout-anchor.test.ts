/**
 * @jest-environment node
 *
 * Electrical › Service layout used to drop the lineup at the level origin
 * (0,0) no matter where the electrical room was; the engineer then had to move every
 * piece. Now the lineup goes at a picked point or along the south wall of a
 * room (the electrical room first in the list), still as one edit and one
 * undo, and says where in the preview.
 */
import { elementsOfKind, type PartInstance } from "@permitzip/bim-kernel";
import { findServiceRoom, planServiceLayout, serviceLayoutRooms, type ServiceLayoutRequest } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const FT = 304.8;
const IN = 25.4;

const REQUEST: Omit<ServiceLayoutRequest, "levelId"> = {
  serviceA: 400,
  system: "208Y/120",
  equipment: [
    { kind: "panel", name: "L1", fedFrom: "MDP", busA: 225, mains: "MCB" },
    { kind: "panel", name: "L2", fedFrom: "MDP", busA: 100 },
  ],
};

function withRooms(): Building {
  const b = new Building();
  b.ok({
    type: "add_architecture",
    levelId: "lvl-1",
    walls: [],
    openings: [],
    casework: [],
    rooms: [
      { roomId: "rm-office", number: "101", name: "OFFICE", outline: [{ x: 0, y: 0 }, { x: 12 * FT, y: 0 }, { x: 12 * FT, y: 10 * FT }, { x: 0, y: 10 * FT }] },
      { roomId: "rm-elec", number: "104", name: "ELEC", outline: [{ x: 40 * FT, y: 20 * FT }, { x: 60 * FT, y: 20 * FT }, { x: 60 * FT, y: 32 * FT }, { x: 40 * FT, y: 32 * FT }] },
      { roomId: "rm-closet", number: "105", name: "ELEC CLOSET", outline: [{ x: 70 * FT, y: 0 }, { x: 74 * FT, y: 0 }, { x: 74 * FT, y: 3 * FT }, { x: 70 * FT, y: 3 * FT }] },
    ],
  });
  return b;
}

const parts = (b: Building): PartInstance[] => elementsOfKind(b.head.elements, "part");

describe("service layout anchor", () => {
  it("lists electrical rooms first, and finds a room by number or name", () => {
    const b = withRooms();
    const rooms = serviceLayoutRooms(b.head);
    expect(rooms.map((r) => r.label)).toEqual(["104 ELEC", "105 ELEC CLOSET", "101 OFFICE"]);
    expect(rooms.slice(0, 2).every((r) => r.electrical)).toBe(true);
    expect(findServiceRoom(b.head, "104")?.id).toBe("rm-elec");
    expect(findServiceRoom(b.head, "elec")?.id).toBe("rm-elec");
    expect(findServiceRoom(b.head, "nowhere")).toBeNull();
  });

  it("places the lineup inside the electrical room along its south wall, as one edit with one undo", () => {
    const b = withRooms();
    const p = planServiceLayout(b.head, { levelId: "lvl-1", roomId: "rm-elec", ...REQUEST });
    if (!p.ok) throw new Error(p.reason);
    expect(p.where).toBe("in 104 ELEC, along its south wall");
    expect(p.notes).toEqual([]);
    const cs = b.ok(p.command);
    const placed = parts(b);
    expect(placed).toHaveLength(4);
    for (const part of placed) {
      expect(part.position.x).toBeGreaterThan(40 * FT);
      expect(part.position.x).toBeLessThan(60 * FT);
      expect(part.position.y).toBeGreaterThan(20 * FT);
      expect(part.position.y).toBeLessThan(23 * FT);
    }
    // One undo takes the whole lineup out.
    b.ok({ type: "undo", revision: cs.revision });
    expect(parts(b)).toHaveLength(0);
  });

  it("says when the lineup doesn't fit the room or leaves less than 3 ft in front of it", () => {
    const b = withRooms();
    const p = planServiceLayout(b.head, { levelId: "lvl-1", roomId: "rm-closet", ...REQUEST });
    if (!p.ok) throw new Error(p.reason);
    expect(p.notes.some((n) => /runs past the east wall/.test(n))).toBe(true);
    expect(p.notes.some((n) => /less than 3 ft of working space/.test(n))).toBe(true);
  });

  it("starts the lineup at a picked point, which wins over a room", () => {
    const b = withRooms();
    const origin = { x: 100 * FT, y: 50 * FT };
    const p = planServiceLayout(b.head, { levelId: "lvl-1", origin, roomId: "rm-elec", ...REQUEST });
    if (!p.ok) throw new Error(p.reason);
    expect(p.where).toMatch(/^in a row from the picked point/);
    b.ok(p.command);
    const xs = parts(b).map((part) => part.position.x);
    expect(Math.min(...xs)).toBeGreaterThan(origin.x);
    expect(Math.min(...xs)).toBeLessThan(origin.x + 40 * IN);
    expect(parts(b).every((part) => part.position.y === origin.y)).toBe(true);
  });

  it("refuses a room that isn't in the model, in words", () => {
    const b = withRooms();
    const p = planServiceLayout(b.head, { levelId: "lvl-1", roomId: "rm-gone", ...REQUEST });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/no room rm-gone/);
  });

  it("still defaults to the level origin when nothing says where", () => {
    const b = withRooms();
    const p = planServiceLayout(b.head, { levelId: "lvl-1", ...REQUEST });
    if (!p.ok) throw new Error(p.reason);
    expect(p.where).toBe("in a row from the level origin");
  });
});
