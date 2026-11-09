/**
 * @jest-environment node
 *
 * Round 13 lane A13a: space boundaries in IFC (2nd level). A room made from
 * its walls writes one `IfcRelSpaceBoundary` per bounding wall, `PHYSICAL`;
 * a separation line that splits it is an `IfcVirtualElement` (`BOUNDARY`)
 * and bounds both sub-rooms `VIRTUAL`, `INTERNAL`.
 *
 * Fails on round 12's code: no space boundaries or virtual elements were
 * written.
 */
import { danglingReferences } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { exported, ofType, ref, text } from "./a13a-ifc-support";

const ROOM = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
  { x: 6000, y: 4000 },
  { x: 0, y: 4000 },
];

describe("a13a ifc space boundaries", () => {
  it("walls bound the room PHYSICAL; a separation line is a virtual element bounding both sub-rooms VIRTUAL", () => {
    const m = twoLevels();
    m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200, heightMm: 3000 }, points: ROOM, closed: true });
    m.ok({ type: "place_space_in_walls", spaceId: "s1", levelId: "L1", seed: { x: 3000, y: 2000 }, number: "101", name: "Office" });
    const whole = exported(m.head).file;
    expect(danglingReferences(whole)).toEqual([]);
    const walls = new Set(ofType(whole, "IFCWALL").map((w) => w.id));
    const physical = ofType(whole, "IFCRELSPACEBOUNDARY").filter((b) => text(b, 7) === "PHYSICAL");
    expect(physical).toHaveLength(4);
    for (const b of physical) expect(walls.has(ref(b, 5))).toBe(true);

    m.ok({ type: "split_space", spaceId: "s1", line: { start: { x: 3000, y: 100 }, end: { x: 3000, y: 3900 } } });
    const split = exported(m.head).file;
    expect(danglingReferences(split)).toEqual([]);
    const virtual = ofType(split, "IFCVIRTUALELEMENT");
    expect(virtual).toHaveLength(1);
    expect(text(virtual[0], 8)).toBe("BOUNDARY");
    const byLine = ofType(split, "IFCRELSPACEBOUNDARY").filter((b) => ref(b, 5) === virtual[0]?.id);
    expect(byLine.map((b) => [text(b, 7), text(b, 8)])).toEqual([
      ["VIRTUAL", "INTERNAL"],
      ["VIRTUAL", "INTERNAL"],
    ]);
  });
});
