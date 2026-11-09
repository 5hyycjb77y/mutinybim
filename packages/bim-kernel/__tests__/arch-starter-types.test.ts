/**
 * @jest-environment node
 *
 * Architecture follow-ups (A4): starter wall, door and window types. A
 * drawing that names a starter type the model doesn't have adds the type in
 * the same change (one Undo takes both away) and draws at the type's size;
 * picking a starter in Properties (set_element_type) adds it the same way.
 * The rows are the Architecture add-on's; with no add-on shipping one, the
 * id is refused as before.
 *
 * Fails on the previous code: no `kernel.starter_element_type` point, and a
 * type id the model didn't have was refused ("make the type first").
 */
import { ARCHITECTURE_PACK, ARCHITECTURE_STARTER_TYPES } from "@permitzip/bim-pack-architecture";
import { defaultStarterType, starterElementTypeRowProblems, type BimElement } from "../src";
import { PackSet, withPackSet } from "../src/packs";
import { element, twoLevels } from "./a13a-fixtures";

const PARTITION = "architecture.type.interior_partition";
const DOOR = "architecture.type.door_single_flush_3070";
const WINDOW = "architecture.type.window_fixed_3040";

const withArchitecture = <T>(fn: () => T): T => withPackSet(PackSet.create([ARCHITECTURE_PACK]), fn);
const thickness = (el: BimElement): number => (el.kind === "wall" ? el.thickness : NaN);

describe("arch starter types", () => {
  it("the Architecture rows are well formed, with one tool default each for walls, doors and windows", () => {
    expect(starterElementTypeRowProblems(ARCHITECTURE_STARTER_TYPES)).toEqual([]);
    withArchitecture(() => {
      expect(defaultStarterType("wall")?.id).toBe(PARTITION);
      expect(defaultStarterType("opening", "door")?.id).toBe(DOOR);
      expect(defaultStarterType("opening", "window")?.id).toBe(WINDOW);
    });
  });

  it("drawing a wall with the starter partition adds the type and draws it 4 7/8 in thick; one undo takes both away", () => {
    withArchitecture(() => {
      const m = twoLevels("arch-starter-wall");
      const before = Object.keys(m.head.elements).sort();
      const cs = m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }], typeId: PARTITION });
      const type = element(m.head, PARTITION);
      expect(type.kind === "element_type" ? type.name : null).toBe('Interior partition 4 7/8"');
      expect(thickness(element(m.head, "w-1"))).toBe(124);
      expect(thickness(element(m.head, "w-2"))).toBe(124);
      expect(cs.elements.map((e) => e.id)).toContain(PARTITION);
      m.ok({ type: "undo", revision: cs.revision });
      expect(Object.keys(m.head.elements).sort()).toEqual(before);
    });
  });

  it("a door drawn with the starter door is 3'-0\" x 7'-0\"; a starter window type refuses a door", () => {
    withArchitecture(() => {
      const m = twoLevels("arch-starter-door");
      m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
      m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "w", s: 2000, side: 1, typeId: DOOR });
      const d = element(m.head, "d");
      expect(d.kind === "opening" ? [d.width, d.height] : null).toEqual([914, 2134]);
      expect(m.refused({ type: "create_hosted", elementId: "d2", kind: "opening", openingType: "door", hostId: "w", s: 4500, side: 1, typeId: WINDOW })).toMatch(/is a window type, not a door type/);
    });
  });

  it("picking a starter type in Properties adds it with the change", () => {
    withArchitecture(() => {
      const m = twoLevels("arch-starter-pick");
      m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } } });
      m.ok({ type: "set_element_type", elementIds: ["w"], typeId: "architecture.type.exterior_cmu_8" });
      const w = element(m.head, "w");
      expect(w.kind === "wall" ? w.typeId : null).toBe("architecture.type.exterior_cmu_8");
      expect(element(m.head, "architecture.type.exterior_cmu_8").kind).toBe("element_type");
    });
  });

  it("an id no add-on ships is refused as before", () => {
    withArchitecture(() => {
      const m = twoLevels("arch-starter-none");
      expect(m.refused({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 6000, y: 0 } }, typeId: "zz.type.nothing" })).toMatch(/make the type first/);
    });
  });
});
