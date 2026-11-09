/**
 * @jest-environment node
 *
 * IFC 4.3 names in the linked-model reader (KERNEL-AUDIT IFC-3, IFC-4): an
 * element assigned to an IfcBuiltSystem lists it as a system, an element
 * inside an IfcSpatialZone names the zone, and ports nested by IfcRelNests
 * (IFC4 and 4.3) survive conversion alongside the IFC2x3 port relationship.
 * Each assertion fails on the round-5b reader.
 */
import type { ItemData } from "@thatopen/fragments";
import * as WEBIFC from "web-ifc";
import { configureIfcImporter, EXTRA_IFC_CLASSES, EXTRA_IFC_RELATIONS, type ConfigurableIfcImporter } from "../src/ifc-import";
import { readReferenceItem, SYSTEM_CLASSES } from "../src/item-properties";

function item(localId: number, category: string, attrs: Readonly<Record<string, string>>, relations: Readonly<Record<string, ItemData[]>> = {}): ItemData {
  const out: ItemData = { _localId: { value: localId }, _category: { value: category } };
  for (const [k, v] of Object.entries(attrs)) out[k] = { value: v };
  for (const [k, v] of Object.entries(relations)) out[k] = v;
  return out;
}

describe("IFC 4.3 entities in the linked-model reader", () => {
  it("lists IfcBuiltSystem and IfcSpatialZone among the groups an element can belong to", () => {
    expect(SYSTEM_CLASSES.has("IFCBUILTSYSTEM")).toBe(true);
    expect(SYSTEM_CLASSES.has("IFCSPATIALZONE")).toBe(true);
    expect(SYSTEM_CLASSES.has("IFCBUILDINGSYSTEM")).toBe(true);
  });

  it("reads an element's IfcBuiltSystem and the IfcSpatialZone it stands in", async () => {
    const system = item(7, "IFCBUILTSYSTEM", { Name: "Foundation", ObjectType: "Footings" });
    const zone = item(8, "IFCSPATIALZONE", { Name: "Fire area A" });
    const footing = item(5, "IFCFOOTING", { Name: "F-1", GlobalId: "2CwS2GsarBRvnoKhdQGITK" }, { HasAssignments: [system], ContainedInStructure: [zone] });
    const props = await readReferenceItem((ids) => ids.map((id) => (id === 5 ? footing : item(id, "IFCPROPERTYSET", {}))), 5);
    expect(props.systems).toEqual(["Foundation · Footings"]);
    expect(props.container).toBe("Zone Fire area A");
  });

  it("keeps IfcRelNests port links, the 4.3 system entities and spatial zones through conversion", () => {
    expect(EXTRA_IFC_RELATIONS.map(([rel]) => rel)).toEqual(expect.arrayContaining([WEBIFC.IFCRELNESTS, WEBIFC.IFCRELCONNECTSPORTTOELEMENT]));
    expect(EXTRA_IFC_CLASSES).toEqual(expect.arrayContaining([WEBIFC.IFCBUILTSYSTEM, WEBIFC.IFCSPATIALZONE]));
    const added: number[] = [];
    const importer: ConfigurableIfcImporter = { classes: { abstract: { add: (v: number) => added.push(v) } }, relations: new Map([[WEBIFC.IFCRELNESTS, { forRelating: "IsNestedBy", forRelated: "Nests" }]]) };
    configureIfcImporter(importer);
    expect(importer.relations.get(WEBIFC.IFCRELNESTS)).toEqual({ forRelating: "IsNestedBy", forRelated: "Nests" });
    expect(added).toContain(WEBIFC.IFCBUILTSYSTEM);
  });
});
