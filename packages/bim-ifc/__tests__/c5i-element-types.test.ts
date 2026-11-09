/**
 * @jest-environment node
 *
 * Shared element types (5c round 3, `element_type`) export as their class's
 * IFC type object, linked to every instance by IfcRelDefinesByType, with the
 * type's values as type properties. Before, a type record was written as one
 * more building element: an extra, unnamed IfcBeam per section (found by the
 * structural pack's IFC test).
 */
import { asElementId, type BimElement } from "@permitzip/bim-kernel";
import { exportIfc, readStep, type ReadEntity, type StepFile } from "../src";
import { PROJECT_ID, TIME_STAMP, syntheticModel } from "./c5i-model";

const project = { id: PROJECT_ID, name: "Synthetic frame", number: "0002" };
const base = { version: 1, authoredRev: {} };

const elements: readonly BimElement[] = [
  { ...base, id: asElementId("et-w16"), kind: "element_type", name: "W16X26", forKinds: ["beam"], values: { "struct.section": "W16X26", "struct.weight_plf": 26 } },
  { ...base, id: asElementId("beam-a"), kind: "beam", sectionName: "W16X26", start: { x: 0, y: 0 }, end: { x: 9144, y: 0 }, typeId: asElementId("et-w16") },
  { ...base, id: asElementId("beam-b"), kind: "beam", sectionName: "W16X26", start: { x: 0, y: 7620 }, end: { x: 9144, y: 7620 }, typeId: asElementId("et-w16") },
];

function ofType(file: StepFile, type: string): ReadEntity[] {
  return [...file.entities.values()].filter((e) => e.type === type);
}

describe("element types in IFC", () => {
  const file = readStep(exportIfc({ model: syntheticModel(elements), project, timeStamp: TIME_STAMP }).text);

  it("writes the beams, and no product for the type record", () => {
    expect(ofType(file, "IFCBEAM")).toHaveLength(2);
  });

  it("writes one IfcBeamType named for the type, defining both beams", () => {
    const types = ofType(file, "IFCBEAMTYPE");
    expect(types).toHaveLength(1);
    expect(types[0]?.args[2]).toEqual({ kind: "string", value: "W16X26" });
    const typeId = types[0]?.id;
    const rel = ofType(file, "IFCRELDEFINESBYTYPE").find((r) => {
      const relating = r.args[5];
      return relating?.kind === "ref" && relating.id === typeId;
    });
    const members = rel?.args[4];
    expect(members?.kind === "list" ? members.items.length : 0).toBe(2);
  });

  it("carries the type's values as type properties", () => {
    const names = ofType(file, "IFCPROPERTYSINGLEVALUE").map((p) => p.args[0]).map((a) => (a?.kind === "string" ? a.value : ""));
    // Structural is first-party since round 14: its section field names its IFC home ("Section"); a value with no home keeps its key.
    expect(names).toEqual(expect.arrayContaining(["Section", "struct.weight_plf"]));
  });
});
