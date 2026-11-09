/**
 * @jest-environment node
 *
 * Round 13 lane A13a: an outside add-on's curtain wall, with zero kernel
 * edits. The test add-on `zz` registers a `zz.curtain_wall` kind (with a
 * `create` face), a join row that joins walls, and a bounding row. Then
 * `create_element` draws one closing a room of walls, it joins the walls at
 * both corners, hosts a door (which cuts it), and bounds the room.
 *
 * Fails on round 12's code: kind rows had no `create` face and there was
 * no create command, no join solve, no host voids and no bounding index.
 */
import { asElementId, type BimElement, type ElementId, type Vec2 } from "../src";
import { ELEMENT_KIND_POINT } from "../src";
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { voidsOf } from "../src/hosting/void-point";
import { endCleanupsOf, LINE_JOIN_POINT } from "../src/joins/point";
import { lineJoinPlanGraphics } from "../src/joins/plan";
import { kindRowFaceProblems } from "../src/registry/kind-row-faces";
import { BOUNDING_ELEMENT_POINT, boundarySegmentsOnLevel, boundsRooms } from "../src/spaces/boundaries/point";
import { twoLevels } from "./a13a-fixtures";

interface CurtainRecord {
  readonly id: ElementId;
  readonly kind: "zz.curtain_wall";
  readonly levelId: string;
  readonly start: Vec2;
  readonly end: Vec2;
  readonly thickness: number;
}

function curtain(el: BimElement): CurtainRecord | null {
  const kind: string = el.kind;
  if (kind !== "zz.curtain_wall") return null;
  return el as unknown as CurtainRecord;
}

const PACK = definePack({ id: "zz", name: "ZZ curtain walls", version: "1.0.0", kernel: "^1.11.0" }, [
  contribute(ELEMENT_KIND_POINT, [
    {
      kind: "zz.curtain_wall",
      label: "Curtain wall",
      nature: "physical",
      planGraphics: lineJoinPlanGraphics,
      create: {
        placements: ["line"],
        make: (input) => {
          if (input.placement.kind !== "line") return { refused: "A curtain wall is drawn on a line" };
          const record: CurtainRecord = { id: asElementId(input.id), kind: "zz.curtain_wall", levelId: input.levelId, start: input.placement.start, end: input.placement.end, thickness: input.size?.thicknessMm ?? 100 };
          return { ...record, version: 0, authoredRev: {} } as unknown as BimElement;
        },
      },
    },
  ]),
  contribute(LINE_JOIN_POINT, [
    {
      kind: "zz.curtain_wall",
      label: "Curtain wall",
      styles: ["butt"],
      joinsWith: ["wall"],
      line: (el) => {
        const c = curtain(el);
        return c ? { start: c.start, end: c.end, widthMm: c.thickness, levelId: asElementId(c.levelId) } : null;
      },
      priority: () => 1,
    },
  ]),
  contribute(BOUNDING_ELEMENT_POINT, [
    {
      kind: "zz.curtain_wall",
      label: "Curtain wall",
      boundsByDefault: true,
      segments: (el, _elements, levelId) => {
        const c = curtain(el);
        return c && c.levelId === levelId ? [{ elementId: c.id, start: c.start, end: c.end }] : [];
      },
    },
  ]),
]);

describe("a13a outside pack curtain wall", () => {
  it("is drawn by create_element, joins the walls it meets, hosts a door that cuts it, and bounds the room", () => {
    withPackSet(PackSet.create([PACK]), () => {
      const m = twoLevels();
      m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", size: { thicknessMm: 200 }, points: [{ x: 0, y: 4000 }, { x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }] });
      m.ok({ type: "create_element", elementId: "cw", kind: "zz.curtain_wall", levelId: "L1", size: { thicknessMm: 80 }, placement: { kind: "line", start: { x: 6000, y: 4000 }, end: { x: 0, y: 4000 } } });
      expect(m.head.elements["cw"]).toMatchObject({ kind: "zz.curtain_wall", levelId: "L1", thickness: 80 });

      const ends = endCleanupsOf(m.head, asElementId("cw"));
      if (!Array.isArray(ends)) throw new Error("curtain wall didn't join");
      expect(ends.map((e) => [e.style, e.with])).toEqual([
        ["butt", ["w-3"]],
        ["butt", ["w-1"]],
      ]);

      m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "cw", s: 3000, side: 1, size: { widthMm: 900 } });
      expect(m.head.elements["d"]).toMatchObject({ hostId: "cw", position: { x: 3000, y: 4000 } });
      const voids = voidsOf(m.head, asElementId("cw"));
      expect(Array.isArray(voids) && voids.map((v) => [v.elementId, v.role])).toEqual([["d", "fill"]]);

      const cw = m.head.elements["cw"] as BimElement;
      expect(boundsRooms(cw, m.head.elements)).toBe(true);
      const segs = boundarySegmentsOnLevel(m.head, asElementId("L1"));
      expect(Array.isArray(segs) && segs.map((s) => s.elementId)).toContain("cw");

      expect(m.refused({ type: "create_element", elementId: "cw2", kind: "zz.curtain_wall", levelId: "L1", placement: { kind: "area", outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] } })).toBe("A curtain wall is drawn on a line, not as an area");
    });
  });

  it("a create face that doesn't say how to draw is refused in words", () => {
    expect(kindRowFaceProblems("zz.x", { create: { placements: [], make: 1 } })).toEqual(["element kind zz.x: create names no placement (point, line or area)", "element kind zz.x: create.make must be a function"]);
    expect(kindRowFaceProblems("zz.x", { create: { placements: ["volume"], make: () => null } })).toEqual(['element kind zz.x: create placement "volume" must be point, line or area']);
  });
});
