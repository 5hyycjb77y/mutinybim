/**
 * @jest-environment node
 *
 * Element types in the file are valid IFC4X3_ADD2 type entities (#167).
 *
 * A ceiling's element type was left out (no IfcCoveringType, no
 * IfcRelDefinesByType): the writer asked for an element's type by kind, and a
 * ceiling is not one of the element-core kinds that lookup knows. An
 * IfcFurnitureType was written without its required AssemblyPlace, and a
 * USERDEFINED type (casework, a cased opening) without the ElementType the
 * schema's where rule asks for.
 *
 * The audit at the end exports a model with a type on every kind, class and
 * category the registry offers and checks every type entity in the file: its
 * attribute count, its required attributes, and the USERDEFINED rule (and
 * the matching rule on occurrences: USERDEFINED needs an ObjectType).
 */
import { DEFAULT_SETTINGS, asElementId, asRevision, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { exportIfc, ifcEntityName, importIfc, ownAttributes, predefinedTypes, readStep, type ReadEntity, type StepFile, type StepToken } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { syntheticModel } from "./c5i-model";
import { typedElementsModel } from "./typed-elements-model";

const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Typed elements" };
const TIME_STAMP = "2026-11-25T00:00:00";
const SQUARE = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }];

/** GlobalId, OwnerHistory, Name, Description, ApplicableOccurrence, HasPropertySets, RepresentationMaps, Tag, ElementType. */
const TYPE_PREFIX = 9;
/** GlobalId, OwnerHistory, Name, Description, ObjectType, ObjectPlacement, Representation, Tag. */
const ELEMENT_PREFIX = 8;
const NAME = 2;
const OBJECT_TYPE = 4;
const ELEMENT_TYPE = 8;
/** Own attributes of a type entity that IFC4X3_ADD2 does not mark OPTIONAL (from the schema's EXPRESS, not from the writer's table). */
const REQUIRED_OWN = new Set(["PredefinedType", "AssemblyPlace", "OperationType", "PartitioningType"]);

const run = (model: ModelState) => exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP });
const ofType = (file: StepFile, type: string): ReadEntity[] => [...file.entities.values()].filter((e) => e.type === type);
const text = (t: StepToken | undefined): string | null => (t?.kind === "string" ? t.value : null);
const enumOf = (t: StepToken | undefined): string | null => (t?.kind === "enum" ? t.value : null);
const refs = (t: StepToken | undefined): number[] => (t?.kind === "list" ? t.items.flatMap((i) => (i.kind === "ref" ? [i.id] : [])) : []);
const own = (e: ReadEntity, prefix: number, attribute: string): StepToken | undefined => {
  const i = ownAttributes(ifcEntityName(e.type) ?? e.type).indexOf(attribute);
  return i < 0 ? undefined : e.args[prefix + i];
};
/** The type entity an occurrence is defined by, through IfcRelDefinesByType. */
const typeOf = (file: StepFile, occurrence: ReadEntity): ReadEntity | undefined => {
  const rel = ofType(file, "IFCRELDEFINESBYTYPE").find((r) => refs(r.args[4]).includes(occurrence.id));
  const relating = rel?.args[5];
  return relating?.kind === "ref" ? file.entities.get(relating.id) : undefined;
};
/** Every text value in the property sets a type entity carries. */
const typeValues = (file: StepFile, type: ReadEntity | undefined): string[] =>
  refs(type?.args[5]).flatMap((set) => refs(file.entities.get(set)?.args[4])).flatMap((p) => {
    const v = file.entities.get(p)?.args[2];
    return v?.kind === "typed" ? [text(v.value) ?? ""] : [];
  });

beforeAll(() => installFirstPartyAddOns());

describe("a ceiling's element type", () => {
  const model = (): ModelState => {
    const m = twoLevels("ceiling-type");
    m.ok({ type: "create_element_type", typeId: "act", name: "ACT 2x2", forKinds: ["ceiling"], values: { "architecture.fire_rating": "1 HR" } });
    for (const [i, ceilingId] of ["clg-1", "clg-2"].entries()) m.ok({ type: "create_ceiling", ceilings: [{ ceilingId, levelId: "L1", outline: SQUARE.map((p) => ({ x: p.x + i * 7000, y: p.y })), heightMm: 2700, typeId: "act" }] });
    m.ok({ type: "create_ceiling", ceilings: [{ ceilingId: "clg-plain", levelId: "L2", outline: SQUARE, heightMm: 2700 }] });
    return m.head;
  };

  it("is written once as an IfcCoveringType (CEILING) with the type's name and values, defining each ceiling that has it", () => {
    const file = readStep(run(model()).text);
    const types = ofType(file, "IFCCOVERINGTYPE");
    expect(types).toHaveLength(1);
    expect(text(types[0]?.args[NAME])).toBe("ACT 2x2");
    expect(enumOf(types[0]?.args[TYPE_PREFIX])).toBe("CEILING");
    expect(typeValues(file, types[0])).toContain("1 HR");
    const coverings = ofType(file, "IFCCOVERING");
    expect(coverings).toHaveLength(3);
    expect(coverings.filter((c) => typeOf(file, c)?.id === types[0]?.id)).toHaveLength(2);
    expect(coverings.filter((c) => typeOf(file, c) === undefined)).toHaveLength(1);
  });

  it("still comes back from the file as a ceiling", () => {
    const m = model();
    const { text: ifc, report } = run(m);
    const empty: ModelState = { modelId: "readback", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    const back = importIfc(ifc, { model: empty, referenceId: "ref", sourceKey: "rt", sourceId: "rt", label: "Round trip", disciplines: ["architecture"] });
    const ceilings = back.records.filter((r) => r.kind === "ceiling");
    expect(ceilings.map((c) => ("provenance" in c ? c.provenance?.ifcGlobalId : undefined)).sort()).toEqual(["clg-1", "clg-2", "clg-plain"].map((id) => report.globalIds[id]).sort());
    expect(back.report.classes.find((c) => c.label === "Ceilings")).toEqual({ classId: "arch.ceiling", label: "Ceilings", converted: 3, linked: [] });
  });
});

describe("an element type on casework", () => {
  const base = { version: 1, authoredRev: {} };
  const casework = (typeName: string): readonly BimElement[] =>
    [
      { ...base, id: asElementId("et-casework"), kind: "element_type", name: typeName, forKinds: ["component"], values: {} },
      { ...base, id: asElementId("cmp-casework"), kind: "component", category: "casework", typeName: "A casework", position: { x: 1000, y: 1000 }, size: { x: 600, y: 600 }, rotationDeg: 0, typeId: asElementId("et-casework"), partition: { level: "lvl-1", zone: "Z1", discipline: "architecture" } },
    ] as unknown as BimElement[];

  it("is an IfcFurnitureType with its AssemblyPlace, and says what it is in ElementType because it is USERDEFINED", () => {
    const types = ofType(readStep(run(syntheticModel(casework("Base cabinet"))).text), "IFCFURNITURETYPE");
    expect(types).toHaveLength(1);
    // GlobalId, OwnerHistory, Name, Description, ApplicableOccurrence, HasPropertySets, RepresentationMaps, Tag, ElementType, AssemblyPlace, PredefinedType
    expect(types[0]?.args).toHaveLength(11);
    expect(text(types[0]?.args[NAME])).toBe("Base cabinet");
    expect(text(types[0]?.args[ELEMENT_TYPE])).toBe("casework");
    expect(enumOf(types[0]?.args[9])).toBe("NOTDEFINED");
    expect(enumOf(types[0]?.args[10])).toBe("USERDEFINED");
  });

  it("has a Name when the stored type's name is empty (IfcTypeObject: a type is named)", () => {
    const types = ofType(readStep(run(syntheticModel(casework(""))).text), "IFCFURNITURETYPE");
    expect(types).toHaveLength(1);
    expect(text(types[0]?.args[NAME])).toBeTruthy();
  });
});

describe("every type entity the writer makes", () => {
  let model: ModelState;
  let file: StepFile;
  let report: ReturnType<typeof run>["report"];
  let types: ReadEntity[];
  beforeAll(() => {
    model = typedElementsModel();
    const out = run(model);
    file = readStep(out.text);
    report = out.report;
    types = [...file.entities.values()].filter((e) => e.type.endsWith("TYPE") && ifcEntityName(e.type) !== null);
  });

  it("covers the type entity of every kind, class and category that takes a type", () => {
    expect([...new Set(types.map((t) => ifcEntityName(t.type)))].sort()).toEqual([
      "IfcAirTerminalType", "IfcBeamType", "IfcBuildingElementProxyType", "IfcColumnType", "IfcCoveringType", "IfcDamperType", "IfcDoorType", "IfcElectricDistributionBoardType",
      "IfcFootingType", "IfcFurnishingElementType", "IfcFurnitureType", "IfcLightFixtureType", "IfcMemberType", "IfcOutletType", "IfcPlateType", "IfcSanitaryTerminalType",
      "IfcSlabType", "IfcUnitaryEquipmentType", "IfcValveType", "IfcWallType", "IfcWindowType",
    ]);
  });

  it("every element that has a type is defined by one type entity of its own entity", () => {
    const byGuid = new Map([...file.entities.values()].map((e) => [text(e.args[0]) ?? "", e]));
    const typed = Object.values(model.elements).filter((e) => e.kind !== "element_type" && e.kind !== "part_type" && typeof Reflect.get(e, "typeId") === "string");
    expect(typed.length).toBeGreaterThan(30);
    const wrong = typed.flatMap((el) => {
      const occurrence = byGuid.get(report.globalIds[el.id] ?? "");
      const type = occurrence ? typeOf(file, occurrence) : undefined;
      return occurrence && type?.type === `${occurrence.type}TYPE` ? [] : [`${el.id}: ${occurrence?.type ?? "not in the file"} defined by ${type?.type ?? "no type"}`];
    });
    expect(wrong).toEqual([]);
  });

  it("has the schema's attribute count, every required attribute and a Name", () => {
    const wrong = types.flatMap((t) => {
      const name = ifcEntityName(t.type) ?? t.type;
      const attributes = ownAttributes(name);
      const out: string[] = [];
      if (t.args.length !== TYPE_PREFIX + attributes.length) out.push(`${name} #${t.id}: ${t.args.length} attributes, the schema has ${TYPE_PREFIX + attributes.length}`);
      if (!text(t.args[NAME])) out.push(`${name} #${t.id}: no Name`);
      for (const [i, a] of attributes.entries()) {
        if (!REQUIRED_OWN.has(a)) continue;
        const v = enumOf(t.args[TYPE_PREFIX + i]);
        if (v === null) out.push(`${name} #${t.id}: ${a} is required and not set`);
        else if (a === "PredefinedType" && !predefinedTypes(name).has(v)) out.push(`${name} #${t.id}: ${v} is not one of its predefined types`);
      }
      return out;
    });
    expect(wrong).toEqual([]);
  });

  it("a USERDEFINED type says what it is in ElementType", () => {
    const userDefined = types.filter((t) => enumOf(own(t, TYPE_PREFIX, "PredefinedType")) === "USERDEFINED");
    // Casework, the cased opening's proxy and the part no class recognises.
    expect(userDefined.length).toBeGreaterThanOrEqual(3);
    expect(userDefined.filter((t) => !text(t.args[ELEMENT_TYPE])?.trim()).map((t) => `${t.type} ${text(t.args[NAME])}`)).toEqual([]);
  });

  it("a USERDEFINED occurrence says what it is in ObjectType", () => {
    const occurrences = [...file.entities.values()].filter((e) => !e.type.endsWith("TYPE") && ifcEntityName(e.type) !== null && ownAttributes(ifcEntityName(e.type) ?? "").includes("PredefinedType"));
    const userDefined = occurrences.filter((e) => enumOf(own(e, ELEMENT_PREFIX, "PredefinedType")) === "USERDEFINED");
    expect(userDefined.length).toBeGreaterThanOrEqual(3);
    expect(userDefined.filter((e) => !text(e.args[OBJECT_TYPE])?.trim()).map((e) => `${e.type} ${text(e.args[NAME])}`)).toEqual([]);
  });
});
