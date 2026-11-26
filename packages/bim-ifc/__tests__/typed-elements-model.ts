import { KNOWN_COMPONENT_CATEGORIES, asElementId, type BimElement, type ModelState, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";

/**
 * A synthetic model with an element type on every kind, class and component
 * category that takes one (walls, openings, slabs, columns, beams, components,
 * ceilings), and a part of every part category, so an export of it holds
 * every type entity the writer makes from the registry. Built through the
 * kernel's commands; the parts are stored records. No client data.
 *
 * Not here: rooms and grid lines (written as IfcSpace and IfcGrid, with no
 * type object), and roofs and stairs (the pack that makes them keeps no
 * `typeId` on the record).
 */

const SQUARE = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }];

/** Every part category a built-in class recognises, and one no class does. */
export const PART_CATEGORIES = ["mechanical_equipment", "air_terminal", "duct_accessory", "pipe_accessory", "plumbing_fixture", "electrical_equipment", "electrical_device", "lighting_fixture", "generic", "zz_unknown"] as const;

/** Component categories: the known ones, and one a newer peer might send. */
export const COMPONENT_CATEGORIES: readonly string[] = [...KNOWN_COMPONENT_CATEGORIES, "paving"];

function partType(category: string): PartTypeDefinition {
  return {
    familyName: `Family ${category}`,
    typeName: `Type ${category}`,
    // `zz_unknown` stands for a stored category this release doesn't know.
    category: category as PartTypeDefinition["category"],
    typeParams: [{ name: "manufacturer", label: "Manufacturer", kind: "text" }],
    typeValues: { manufacturer: "Synthetic Co." },
    instanceParams: [],
    connectors: [],
    geometry: [{ kind: "box", center: [0, 0, 250], size: [500, 500, 500] }],
    symbol: [],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  };
}

export function typedElementsModel(): ModelState {
  const m = twoLevels("typed-elements");
  let n = 0;
  /** A new element type; its id. */
  const type = (name: string, forKinds: readonly string[], values: Readonly<Record<string, string | number>> = { "zz.note": `${name} value` }): string => {
    const typeId = `et-${++n}`;
    m.ok({ type: "create_element_type", typeId, name, values, forKinds });
    return typeId;
  };

  m.ok({ type: "create_element", elementId: "wall", levelId: "L1", kind: "wall", typeId: type("Partition A", ["wall"]), size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: -2000 }, end: { x: 12_000, y: -2000 } } });
  for (const [i, openingType] of ["door", "window", "cased_opening"].entries()) {
    m.ok({ type: "create_hosted", elementId: `opening-${openingType}`, kind: "opening", openingType, hostId: "wall", s: 1500 + i * 3000, side: 1, size: { widthMm: 900, heightMm: 2100 }, typeId: type(`Opening ${openingType}`, ["opening"]) });
  }
  for (const [i, classId] of [undefined, "struct.floor_deck", "struct.roof_deck"].entries()) {
    m.ok({ type: "create_element", elementId: `slab-${i}`, levelId: "L1", kind: "slab", ...(classId ? { classId } : {}), typeId: type(`Slab ${classId ?? "plain"}`, ["slab"]), placement: { kind: "area", outline: SQUARE.map((p) => ({ x: p.x + i * 7000, y: p.y + 10_000 })) } });
  }
  for (const [i, classId] of [undefined, "struct.column_steel"].entries()) {
    m.ok({ type: "create_element", elementId: `column-${i}`, levelId: "L1", kind: "column", ...(classId ? { classId } : {}), typeId: type(`Column ${classId ?? "plain"}`, ["column"]), placement: { kind: "point", position: { x: i * 3000, y: 20_000 } }, size: { widthMm: 300, depthMm: 300, heightMm: 3000 } });
  }
  for (const [i, classId] of [undefined, "struct.beam_steel"].entries()) {
    m.ok({ type: "create_element", elementId: `beam-${i}`, levelId: "L2", kind: "beam", ...(classId ? { classId } : {}), label: "W16x26", typeId: type(`Beam ${classId ?? "plain"}`, ["beam"]), placement: { kind: "line", start: { x: 0, y: 22_000 + i * 1000 }, end: { x: 4000, y: 22_000 + i * 1000 } } });
  }
  for (const [i, category] of COMPONENT_CATEGORIES.entries()) {
    m.ok({ type: "create_element", elementId: `component-${category}`, levelId: "L1", kind: "component", category, label: `A ${category}`, typeId: type(`Component ${category}`, ["component"]), placement: { kind: "point", position: { x: i * 2000, y: 26_000 } }, size: { widthMm: 600, depthMm: 600 } });
  }
  m.ok({ type: "create_element", elementId: "component-footing-pad", levelId: "L1", kind: "component", category: "footing", classId: "struct.footing_pad", typeId: type("Pad footing", ["component"]), placement: { kind: "point", position: { x: 0, y: 30_000 } }, size: { widthMm: 1500, depthMm: 1500 } });
  m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "ceiling", levelId: "L1", outline: SQUARE, heightMm: 2700, typeId: type("ACT 2x2", ["ceiling"], { "architecture.fire_rating": "1 HR" }) }] });

  const base = { version: 1, authoredRev: {} };
  const parts: BimElement[] = PART_CATEGORIES.flatMap((category, i): BimElement[] => [
    { ...base, id: asElementId(`pt-${category}`), kind: "part_type", definition: partType(category) },
    { ...base, id: asElementId(`part-${category}`), kind: "part", typeId: asElementId(`pt-${category}`), levelId: asElementId("L1"), position: { x: i * 1500, y: 38_000 }, offsetMm: 0, rotationDeg: 0, mark: `P-${i + 1}`, values: {} },
  ]);
  return { ...m.head, elements: { ...m.head.elements, ...Object.fromEntries(parts.map((p) => [p.id, p])) } };
}
