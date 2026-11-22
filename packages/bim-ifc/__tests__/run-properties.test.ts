/** @jest-environment node */
import { asElementId, builtinRegistryBuilder, type RunSegment, type RunSize } from "@permitzip/bim-kernel";
import { exportIfc, readStep } from "../src";
import { syntheticModel, PROJECT_ID, TIME_STAMP } from "./c5i-model";
import { ofType, ref, refs, text } from "./a13a-ifc-support";

it.each([
  [{ shape: "rect", width: 12 * 25.4, height: 8 * 25.4 }, "304.8x203.2 mm Supply Air 1", { NominalDiameterOrWidth: 304.8, NominalHeight: 203.2 }],
  [{ shape: "rect", width: 400, height: 300 }, "400x300 mm Supply Air 1", { NominalDiameterOrWidth: 400, NominalHeight: 300 }],
  [{ shape: "round", diameter: 250 }, "250 mm round Supply Air 1", { NominalDiameterOrWidth: 250 }],
  [{ shape: "oval", width: 500, height: 200 }, "500x200 mm oval Supply Air 1", { NominalDiameterOrWidth: 500, NominalHeight: 200 }],
] satisfies [RunSize, string, Record<string, number>][])("exports %j with a name and standard dimensions", (size, name, expected) => {
  const run: RunSegment = { id: asElementId("sample-run"), kind: "run_segment", version: 1, authoredRev: {},
    domain: "duct", systemId: asElementId("sys-sa"), levelId: asElementId("lvl-1"),
    start: { x: 0, y: 0, z: 1000 }, end: { x: 2000, y: 0, z: 1000 }, size, flow: 2000, links: {}, branches: [] };
  const out = exportIfc({ model: syntheticModel([run]), project: { id: PROJECT_ID, name: "Synthetic runs" }, timeStamp: TIME_STAMP });
  const file = readStep(out.text);
  const entity = ofType(file, "IFCDUCTSEGMENT").find((e) => text(e, 0) === out.report.globalIds[run.id]);
  if (!entity) throw new Error("Missing run");
  expect(text(entity, 2)).toBe(name);
  const setIds = ofType(file, "IFCRELDEFINESBYPROPERTIES").filter((r) => refs(r, 4).includes(entity.id)).map((r) => ref(r, 5));
  const set = setIds.map((id) => file.entities.get(id)).find((e) => text(e, 2) === "Pset_DuctSegmentTypeCommon");
  if (!set) throw new Error("Missing duct dimensions");
  const props = refs(set, 4).map((id) => file.entities.get(id));
  expect(Object.fromEntries(props.map((p) => {
    const value = p?.args[2];
    expect(value?.kind === "typed" ? value.type : null).toBe("IFCPOSITIVELENGTHMEASURE");
    return [text(p, 0), value?.kind === "typed" && value.value.kind === "number" ? value.value.value : null];
  }))).toEqual(expected);
  // Dimension values use the file's project length unit, millimetres.
  expect(ofType(file, "IFCSIUNIT").some((u) => text(u, 1) === "LENGTHUNIT" && text(u, 2) === "MILLI" && text(u, 3) === "METRE")).toBe(true);
});

it("uses the generic dimension set for a pipe without a mapped field or system", () => {
  const model = syntheticModel();
  const original = model.elements["duct-1"];
  if (original?.kind !== "run_segment") throw new Error("Missing fixture run");
  const pipe: RunSegment = { ...original, domain: "pipe", systemId: asElementId("missing"), size: { shape: "pipe", nominalMm: 100, material: "pvc" } };
  const out = exportIfc({ model: { ...model, elements: { ...model.elements, [pipe.id]: pipe } },
    project: { id: PROJECT_ID, name: "Synthetic pipe" }, timeStamp: TIME_STAMP });
  const file = readStep(out.text);
  const entity = ofType(file, "IFCPIPESEGMENT").find((e) => text(e, 0) === out.report.globalIds[pipe.id]);
  if (!entity) throw new Error("Missing pipe");
  expect(text(entity, 2)).toMatch(/^100 mm /);
  const sets = ofType(file, "IFCRELDEFINESBYPROPERTIES").filter((r) => refs(r, 4).includes(entity.id))
    .map((r) => file.entities.get(ref(r, 5)));
  expect(sets.some((set) => text(set, 2) === "Pset_DuctSegmentTypeCommon")).toBe(false);
  const dimensions = sets.find((set) => text(set, 2) === "MutinyBIM_Run");
  if (!dimensions) throw new Error("Missing pipe dimensions");
  const property = file.entities.get(refs(dimensions, 4)[0] ?? -1);
  expect(text(property, 0)).toBe("diameter");
  expect(property?.args[2]).toEqual({ kind: "typed", type: "IFCPOSITIVELENGTHMEASURE", value: { kind: "number", value: 100 } });
});

it.each([0, -100])("omits a nonpositive dimension (%s) from positive-length properties", (width) => {
  const model = syntheticModel();
  const original = model.elements["duct-1"];
  if (original?.kind !== "run_segment") throw new Error("Missing fixture run");
  const run: RunSegment = { ...original, size: { shape: "rect", width, height: 300 } };
  const out = exportIfc({ model: { ...model, elements: { ...model.elements, [run.id]: run } },
    project: { id: PROJECT_ID, name: "Synthetic invalid dimension" }, timeStamp: TIME_STAMP });
  const file = readStep(out.text);
  const dimensions = ofType(file, "IFCPROPERTYSINGLEVALUE").filter((p) => text(p, 0) === "NominalDiameterOrWidth");
  expect(dimensions).toHaveLength(0);
  const height = ofType(file, "IFCPROPERTYSINGLEVALUE").find((p) => text(p, 0) === "NominalHeight");
  expect(height?.args[2]).toEqual({ kind: "typed", type: "IFCPOSITIVELENGTHMEASURE", value: { kind: "number", value: 300 } });
});

it("honours a caller registry without the default provider's dimension mappings", () => {
  const out = exportIfc({ model: syntheticModel(), registry: builtinRegistryBuilder().build(),
    project: { id: PROJECT_ID, name: "Custom registry" }, timeStamp: TIME_STAMP });
  const file = readStep(out.text);
  const names = ofType(file, "IFCPROPERTYSET").map((p) => text(p, 2));
  expect(names).not.toContain("Pset_DuctSegmentTypeCommon");
  expect(names).toContain("MutinyBIM_Run");
});
