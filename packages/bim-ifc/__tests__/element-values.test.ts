/** @jest-environment node */
import { exportIfc, readStep, type ReadEntity, type StepFile } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { ofType, ref, refs, text } from "./a13a-ifc-support";

function properties(file: StepFile, entity: ReadEntity): Record<string, Record<string, unknown>> {
  const sets = ofType(file, "IFCRELDEFINESBYPROPERTIES")
    .filter((rel) => refs(rel, 4).includes(entity.id)).map((rel) => ref(rel, 5));
  if (entity.type.endsWith("TYPE")) sets.push(...refs(entity, 5));
  return Object.fromEntries(sets.map((id) => {
    const set = file.entities.get(id);
    if (!set) throw new Error(`Missing property set #${id}`);
    return [text(set, 2), Object.fromEntries(refs(set, 4).map((propertyId) => {
      const property = file.entities.get(propertyId);
      const value = property?.args[2];
      return [text(property, 0), value?.kind === "typed" && "value" in value.value ? value.value.value : undefined];
    }))];
  }));
}

function building() {
  const m = twoLevels("element-values");
  m.ok({ type: "create_element_type", typeId: "exterior", name: "Exterior", forKinds: ["wall"], values: { "architecture.is_external": true } });
  m.ok({ type: "create_elements", idPrefix: "wall", kind: "wall", levelId: "L1", typeId: "exterior",
    size: { thicknessMm: 200, heightMm: 3000 }, points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }] });
  return m;
}

describe("IFC occurrence parameter values (#60)", () => {
  it("exports mapped instance overrides without changing the shared type or another wall", () => {
    const m = building();
    m.ok({ type: "set_element_values", elementIds: ["wall-1"], values: { "architecture.is_external": false } });
    const out = exportIfc({ model: m.head, project: { id: "element-values", name: "Synthetic walls" }, timeStamp: "2026-11-17T00:00:00" });
    const file = readStep(out.text);
    const entityOf = (id: string) => {
      const entity = [...file.entities.values()].find((e) => text(e, 0) === out.report.globalIds[id]);
      if (!entity) throw new Error(`Missing entity for ${id}`);
      return entity;
    };
    expect(properties(file, entityOf("wall-1"))["Pset_WallCommon"]).toEqual({ IsExternal: "F" });
    expect(properties(file, entityOf("wall-2"))["Pset_WallCommon"]).toBeUndefined();
    const type = ofType(file, "IFCWALLTYPE").find((entity) => text(entity, 2) === "Exterior");
    if (!type) throw new Error("Missing wall type");
    expect(properties(file, type)["Pset_WallCommon"]).toEqual({ IsExternal: "T" });
  });

  it("exports unmapped text, number, and boolean values in the occurrence's parameter set", () => {
    const m = building();
    m.ok({ type: "set_element_values", elementIds: ["wall-1"],
      values: { "sample.note": "Check on site", "sample.count": 0, "sample.reviewed": false } });
    const out = exportIfc({ model: m.head, project: { id: "element-values", name: "Synthetic walls" }, timeStamp: "2026-11-17T00:00:00" });
    const file = readStep(out.text);
    const wall = ofType(file, "IFCWALL").find((entity) => text(entity, 0) === out.report.globalIds["wall-1"]);
    if (!wall) throw new Error("Missing wall");
    expect(properties(file, wall)["MutinyBIM_Parameters"]).toEqual({
      "sample.note": "Check on site", "sample.count": 0, "sample.reviewed": "F",
    });
  });
  it("exports values on spaces through the same property mapping", () => {
    const m = building();
    m.ok({ type: "create_space", spaces: [{ spaceId: "space", number: "101", name: "Office" }] });
    m.ok({ type: "set_element_values", elementIds: ["space"], values: { "sample.note": "Review occupancy" } });
    const out = exportIfc({ model: m.head, project: { id: "element-values", name: "Synthetic walls" }, timeStamp: "2026-11-17T00:00:00" });
    const file = readStep(out.text);
    const space = ofType(file, "IFCSPACE").find((entity) => text(entity, 0) === out.report.globalIds["space"]);
    if (!space) throw new Error("Missing space");
    expect(properties(file, space)["MutinyBIM_Parameters"]).toEqual({ "sample.note": "Review occupancy" });
    expect(properties(file, space)["Pset_SpaceCommon"]).toEqual({ Reference: "101" });
  });

  it("writes a mapped millimetre quantity as an IFC length quantity", () => {
    const m = building();
    m.ok({ type: "set_element_values", elementIds: ["wall-1"], values: { "architecture.total_thickness": 250 } });
    const out = exportIfc({ model: m.head, project: { id: "element-values", name: "Synthetic walls" }, timeStamp: "2026-11-17T00:00:00" });
    const file = readStep(out.text);
    const wall = ofType(file, "IFCWALL").find((entity) => text(entity, 0) === out.report.globalIds["wall-1"]);
    if (!wall) throw new Error("Missing wall");
    const sets = ofType(file, "IFCRELDEFINESBYPROPERTIES").filter((rel) => refs(rel, 4).includes(wall.id))
      .map((rel) => file.entities.get(ref(rel, 5)));
    const quantitySet = sets.find((set) => text(set, 2) === "Qto_WallBaseQuantities");
    if (!quantitySet) throw new Error("Missing wall quantities");
    const width = refs(quantitySet, 5).map((id) => file.entities.get(id)).find((quantity) => text(quantity, 0) === "Width");
    expect(width?.type).toBe("IFCQUANTITYLENGTH");
    expect(width?.args[3]).toEqual({ kind: "number", value: 250 });
  });

});
