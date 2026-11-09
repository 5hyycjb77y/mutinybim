/**
 * @jest-environment node
 *
 * Round 13 lane A13a: the building classes leave the kernel. No `arch.*` row
 * is in `registry/builtin.ts`; the Architecture add-on contributes them with
 * the same ids, listed ahead of the kernel's `gen.building_element`, so
 * with the add-on installed (every host) elements classify, upgrade and
 * store exactly the ids round 12 did. The add-on also brings type parameters
 * with their IFC homes and the fire-resistance and smoke-barrier ratings.
 *
 * Fails on round 12's code: the rows were kernel built-ins (no
 * `gen.building_element`, no Architecture classes, parameters or ratings).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { asElementId, elementClass, fieldProviderRegistry, type BimElement } from "../src";
import { ratingKindRow, ratingOf, formatRating } from "../src/routing/rated-routes";
import { activeClassRegistry, BUILDING_FALLBACK_CLASS_ID, BUILTIN_CLASSES } from "../src/registry";
import { withPackParameters } from "../src/fields/pack-parameters";
import { builtinClassOf } from "../src/elements/recognise";
import { addonOffNote } from "../src/elements/building-fallback";
import { ARCHITECTURE_PACK, ratingHours } from "@permitzip/bim-pack-architecture";
import { element, twoLevels } from "./a13a-fixtures";

describe("a13a classes out of kernel", () => {
  it("the kernel's own class list names no arch class; the fallback is there", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "registry", "builtin.ts"), "utf8");
    expect(source).not.toMatch(/"arch\.[a-z]/);
    expect(BUILTIN_CLASSES.map((c) => c.id).filter((id) => id.startsWith("arch."))).toEqual([]);
    expect(BUILTIN_CLASSES.find((c) => c.id === BUILDING_FALLBACK_CLASS_ID)?.recognize?.elementKinds).toEqual(["wall", "slab", "opening", "room", "component", "ceiling"]);
  });

  it("with the add-on installed, walls and doors classify and upgrade to the ids round 12 stored", () => {
    const m = twoLevels();
    m.ok({ type: "create_elements", idPrefix: "w", kind: "wall", levelId: "L1", points: [{ x: 0, y: 0 }, { x: 6000, y: 0 }] });
    m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "w-1", s: 1500, side: 1, size: { widthMm: 900 } });
    const wall = element(m.head, "w-1");
    const door = element(m.head, "d");
    expect(wall).toMatchObject({ classId: "arch.wall", classSource: "recognised", partition: { discipline: "architecture" } });
    expect(door).toMatchObject({ classId: "arch.door" });
    expect(elementClass(m.head.elements, wall)).toBe("arch.wall");
    const cls = activeClassRegistry().getClass("arch.wall");
    expect(cls).toMatchObject({ source: "builtin", ifc: { entity: "IfcWall" } });
    expect(cls?.parent).toBeUndefined();
    expect(addonOffNote(wall, m.head.elements)).toBeNull();
    if (wall.kind === "wall") {
      const bare = { ...wall, classId: undefined, classSource: undefined };
      expect(builtinClassOf(bare)).toBe("arch.wall");
    }
    expect(ARCHITECTURE_PACK.contributions.map((c) => c.pointId)).toEqual(["kernel.class", "kernel.parameter_set", "kernel.rating_kind", "kernel.class_plan_graphics", "kernel.element_kind", "kernel.field_provider", "kernel.ifc_relation", "kernel.ifc_import_rule", "kernel.library_rows", "kernel.class_solids", "kernel.linked_plan_display", "kernel.tag_style_preset", "kernel.starter_element_type", "kernel.surface_face"]);
  });

  it("wall, door and floor types carry parameters with their IFC homes", () => {
    const fields = fieldProviderRegistry();
    expect(fields.field("arch.wall", "thickness")).toMatchObject({ unit: "mm", source: "provider:architecture.building" });
    expect(fields.field("arch.room", "name")?.writer.kind).toBe("none");
    const reg = withPackParameters(activeClassRegistry());
    expect(reg.field("arch.wall", "architecture.wall_function")).toMatchObject({ valueType: "choice", ifc: { pset: "MutinyBIM_Architecture", property: "WallFunction" } });
    expect(reg.field("arch.wall", "architecture.wall_function")?.choices).toContain("PLUMBINGWALL");
    expect(reg.field("arch.wall", "architecture.is_external")?.ifc).toEqual({ pset: "Pset_WallCommon", property: "IsExternal" });
    // Room bounding is the kernel's own key, not the add-on's.
    expect(reg.field("arch.wall", "architecture.room_bounding")).toBeUndefined();
    expect(reg.field("arch.door", "architecture.door_operation")?.choices).toContain("DOUBLE_DOOR_SINGLE_SWING");
    expect(reg.field("arch.slab", "architecture.slab_function")?.choices).toEqual(["FLOOR", "ROOF", "LANDING", "BASESLAB", "USERDEFINED", "NOTDEFINED"]);
  });

  it("fire resistance and smoke barrier read from the element, then its type", () => {
    const m = twoLevels();
    m.ok({ type: "create_element_type", typeId: "gyp-1hr", name: "Gyp 1-HR", forKinds: ["wall"], values: { "arch.fire_resistance": 1, "architecture.smoke_barrier": true } });
    m.ok({ type: "create_element", elementId: "w", kind: "wall", levelId: "L1", typeId: "gyp-1hr", placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 } } });
    m.ok({ type: "create_hosted", elementId: "d", kind: "opening", openingType: "door", hostId: "w", s: 1000, side: 1, size: { widthMm: 900 }, values: { "arch.fire_rating": "45 min" } });
    const row = ratingKindRow("fire_resistance");
    if (!row) throw new Error("no fire resistance row");
    expect(ratingOf(m.head.elements, element(m.head, "w"), "fire_resistance")).toBe(1);
    expect(formatRating(row, 1)).toBe("1-hour");
    expect(ratingOf(m.head.elements, element(m.head, "d"), "fire_resistance")).toBe(0.75);
    expect(formatRating(row, 0.75)).toBe("45-minute");
    expect(ratingOf(m.head.elements, element(m.head, "w"), "smoke_barrier")).toBe(1);
    expect(ratingOf(m.head.elements, element(m.head, "d"), "smoke_barrier")).toBeNull();
    expect([ratingHours("1-1/2 hr"), ratingHours("90 min"), ratingHours("2"), ratingHours("rated")]).toEqual([1.5, 1.5, 2, null]);
  });

  it("with the add-on on, the fallback classifies nothing the add-on covers (a louver stays unclassed, as in round 12)", () => {
    expect(activeClassRegistry().getClass(BUILDING_FALLBACK_CLASS_ID)?.recognize?.elementKinds).toEqual([]);
    const louver = { id: asElementId("l"), version: 1, authoredRev: {}, kind: "opening", openingType: "louver", mark: "", hostId: asElementId("w"), offset: 0, width: 1, height: 1, position: { x: 0, y: 0 } } as BimElement;
    expect(elementClass({}, louver)).toBeNull();
    if (louver.kind === "opening") expect(builtinClassOf(louver)).toBeNull();
  });
});
