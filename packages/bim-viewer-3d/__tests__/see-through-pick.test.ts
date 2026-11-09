/**
 * @jest-environment node
 *
 * Nov 8 red main (mech-air): in the Top-down plan a click on a new wall
 * selected the room's mounting plane instead. The plane is drawn see-through
 * at 9 ft, above the wall's top, so a ray looking down hit it first, and the
 * first hit won. A see-through plane now loses the pick to anything solid
 * under the pointer, within the same few pixels of tolerance a thin wall
 * needs; with nothing solid there, the plane is still picked.
 */
import { SEE_THROUGH_PICK_GROUPS, choosePickHits, pickPreferringSolid } from "../src/viewer";

const OFFSETS = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]] as const;

describe("a see-through plane over the work", () => {
  it("is drawn by the mounting plane group", () => {
    expect(SEE_THROUGH_PICK_GROUPS.has("mounting_plane")).toBe(true);
    expect(SEE_THROUGH_PICK_GROUPS.has("wall")).toBe(false);
  });

  it("on one ray: the solid element behind the plane wins, the plane is kept as the fallback", () => {
    expect(choosePickHits([{ pick: "plane", seeThrough: true }, { pick: "wall", seeThrough: false }])).toEqual({ solid: "wall", seeThrough: "plane" });
    expect(choosePickHits([{ pick: "plane", seeThrough: true }])).toEqual({ solid: null, seeThrough: "plane" });
  });

  it("a wall a pixel or two beside the pointer wins over the plane right under it", () => {
    const exact = (dx: number) => (dx === 3 ? { solid: "wall", seeThrough: "plane" } : { solid: null, seeThrough: "plane" });
    expect(pickPreferringSolid(OFFSETS, exact, () => null)).toBe("wall");
  });

  it("a solid near miss in plan wins over the plane; with nothing solid, the plane is picked", () => {
    const planeOnly = () => ({ solid: null, seeThrough: "plane" });
    expect(pickPreferringSolid(OFFSETS, planeOnly, () => "receptacle")).toBe("receptacle");
    expect(pickPreferringSolid(OFFSETS, planeOnly, () => null)).toBe("plane");
    expect(pickPreferringSolid(OFFSETS, () => null, () => null)).toBeNull();
  });
});
