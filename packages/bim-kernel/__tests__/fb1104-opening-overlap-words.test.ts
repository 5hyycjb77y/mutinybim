/**
 * @jest-environment node
 *
 * Product decision, Nov 4 ("more comments" video, 2:20): a second door on the same spot
 * said "The door would overlap door arch-door-5bfc988-34de-… in this wall".
 * A door with no mark is named in words, never by its id.
 *
 * Fails on the old code: the refusal fell back to the element id.
 */
import { twoLevels } from "./a13a-fixtures";

function wallWithDoor(mark?: string) {
  const m = twoLevels("fb1104-overlap");
  m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
  m.ok({ type: "create_hosted", elementId: "arch-door-5bfc988", kind: "opening", openingType: "door", hostId: "w", s: 3000, side: 1, size: { widthMm: 900, heightMm: 2100 }, ...(mark ? { mark } : {}) });
  return m;
}

const second = { type: "create_hosted", elementId: "d2", kind: "opening", openingType: "window", hostId: "w", s: 3200, side: 1, size: { widthMm: 900, heightMm: 1200 } } as const;

describe("fb1104: an overlapping opening is named in words", () => {
  it("with no mark: the door already there, no id", () => {
    const message = wallWithDoor().refused(second);
    expect(message).toBe("The window would overlap the door already there in this wall; move it along the wall");
    expect(message).not.toMatch(/arch-door/);
  });

  it("with a mark: by its mark", () => {
    expect(wallWithDoor("101").refused(second)).toBe("The window would overlap door 101 in this wall; move it along the wall");
  });
});
