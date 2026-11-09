/**
 * @jest-environment node
 *
 * IFC 4.3 ADD2 export of a synthetic model (no client data). Each case names
 * what it would catch: a GlobalId that moves between exports, a planned
 * element that grows a body, a pack class that needs an exporter change, a
 * reserved Pset_ name of our own, a broken string or unit.
 */
import { PackSet, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";
import {
  BUILTIN_CLASSES,
  CLASS_POINT,
  IFC_ORGANIZATION_PSET,
  LEGACY_IFC_ORGANIZATION_PSET,
  asElementId,
  builtinRegistryBuilder,
  isIfcOrganizationPset,
  type BimElement,
  firstPartyServiceRegistry,
} from "@permitzip/bim-kernel";
import {
  danglingReferences,
  entityCounts,
  exportIfc,
  ifcEntityName,
  ifcGuidToUuid,
  isInstantiableEntity,
  predefinedTypes,
  readStep,
  rootedEntities,
  sha1,
  stepReal,
  stepString,
  uuidToIfcGuid,
  uuidV5,
  type IfcExportOptions,
  type ReadEntity,
  type StepFile,
} from "../src";
import { PROJECT_ID, TIME_STAMP, syntheticModel } from "./c5i-model";

const project = { id: PROJECT_ID, name: "Synthetic kitchen", number: "0001" };
const opts = (over: Partial<IfcExportOptions> = {}): IfcExportOptions => ({ model: syntheticModel(), project, timeStamp: TIME_STAMP, ...over });

function ofType(file: StepFile, type: string): ReadEntity[] {
  return [...file.entities.values()].filter((e) => e.type === type);
}

function named(file: StepFile, type: string, name: string): ReadEntity {
  const hit = ofType(file, type).find((e) => e.args[2]?.kind === "string" && e.args[2].value === name);
  if (!hit) throw new Error(`no ${type} named ${name}`);
  return hit;
}

/** Property set names and their properties' names, attached to an entity. */
function setsOf(file: StepFile, target: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const rel of ofType(file, "IFCRELDEFINESBYPROPERTIES")) {
    const related = rel.args[4];
    const setRef = rel.args[5];
    if (related?.kind !== "list" || !related.items.some((t) => t.kind === "ref" && t.id === target) || setRef?.kind !== "ref") continue;
    const set = file.entities.get(setRef.id);
    const name = set?.args[2];
    const members = set?.type === "IFCPROPERTYSET" ? set.args[4] : set?.args[5];
    if (!set || name?.kind !== "string" || members?.kind !== "list") continue;
    out.set(
      name.value,
      members.items.map((m) => {
        const p = m.kind === "ref" ? file.entities.get(m.id) : undefined;
        const n = p?.args[0];
        return n?.kind === "string" ? n.value : "?";
      }),
    );
  }
  return out;
}

describe("GlobalIds", () => {
  it("compress a UUID losslessly into 22 IFC base-64 characters", () => {
    expect(uuidToIfcGuid("00000000-0000-0000-0000-000000000000")).toBe("0000000000000000000000");
    expect(uuidToIfcGuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe("3$$$$$$$$$$$$$$$$$$$$$");
    for (const u of [PROJECT_ID, "12345678-9abc-4def-8123-456789abcdef", uuidV5(PROJECT_ID, "x")]) expect(ifcGuidToUuid(uuidToIfcGuid(u))).toBe(u);
  });

  it("derive UUIDv5 with the RFC test vector and SHA-1 with FIPS's", () => {
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    expect([...sha1(new TextEncoder().encode("abc"))].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("export twice → identical bytes and the same GlobalId for every record", () => {
    const a = exportIfc(opts());
    const b = exportIfc(opts());
    expect(b.text).toBe(a.text);
    expect(b.report.globalIds).toEqual(a.report.globalIds);
    const guids = rootedEntities(readStep(a.text)).map((e) => e.globalId);
    expect(new Set(guids).size).toBe(guids.length);
  });

  it("an unrelated edit leaves every other record's GlobalId alone, and the imported storey keeps its own", () => {
    const before = exportIfc(opts()).report.globalIds;
    const extra: BimElement = { id: asElementId("wall-2"), version: 1, authoredRev: {}, kind: "wall", start: { x: 0, y: 0 }, end: { x: 0, y: 6000 }, thickness: 150, height: 3000, wallType: "Partition" };
    const after = exportIfc(opts({ model: syntheticModel([extra]) })).report.globalIds;
    for (const [rid, guid] of Object.entries(before)) expect(after[rid]).toBe(guid);
    expect(after["lvl-2"]).toBe("3YvctVUKr0kugbFTf53O9L");
  });

  it("placing a planned element keeps its GlobalId (SD to CD)", () => {
    const planned = exportIfc(opts()).report.globalIds["fryer-1"];
    const model = syntheticModel();
    const fryer = model.elements["fryer-1"];
    if (fryer?.kind !== "part") throw new Error("fixture");
    const placedFryer: BimElement = { ...fryer, planned: undefined, position: { x: 2000, y: 2000 } };
    const placed = exportIfc(opts({ model: { ...model, elements: { ...model.elements, "fryer-1": placedFryer } } })).report.globalIds["fryer-1"];
    expect(placed).toBe(planned);
  });
});

describe("the file", () => {
  const result = exportIfc(opts());
  const file = readStep(result.text);

  it("is IFC4X3_ADD2 with no dangling references", () => {
    expect(file.schemas).toEqual(["IFC4X3_ADD2"]);
    expect(danglingReferences(file)).toEqual([]);
    expect(result.text).toMatch(/^ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION\(\('ViewDefinition \[ReferenceView\]'\),'2;1'\);/);
  });

  it("has the spatial tree, spaces, zones, systems and circuits the model has", () => {
    const counts = entityCounts(file);
    expect(counts.IFCPROJECT).toBe(1);
    expect(counts.IFCSITE).toBe(1);
    expect(counts.IFCBUILDING).toBe(1);
    expect(counts.IFCBUILDINGSTOREY).toBe(2);
    expect(counts.IFCSPACE).toBe(3);
    expect(counts.IFCZONE).toBe(1);
    expect(counts.IFCSPATIALZONE).toBe(1);
    expect(counts.IFCDISTRIBUTIONSYSTEM).toBe(2);
    expect(counts.IFCDISTRIBUTIONCIRCUIT).toBe(1);
    expect(result.report.counts).toMatchObject({ storeys: 2, spaces: 3, zones: 2, systems: 2, circuits: 1, planned: 1 });
    expect(result.report.skipped).toEqual({ part_type: 2, view: 1 });
  });

  it("writes a planned element with its typed entity and no placement or body", () => {
    const fryer = named(file, "IFCELECTRICDISTRIBUTIONBOARD", "K-2");
    expect(fryer.args[5]).toEqual({ kind: "null" });
    expect(fryer.args[6]).toEqual({ kind: "null" });
    expect(setsOf(file, fryer.id).get("MutinyBIM_Placement")).toEqual(["State"]);
    const state = ofType(file, "IFCPROPERTYSINGLEVALUE").find((p) => p.args[0]?.kind === "string" && p.args[0].value === "State" && p.args[2]?.kind === "typed" && p.args[2].value.kind === "string" && p.args[2].value.value === "PLANNED");
    expect(state).toBeDefined();
    const contained = ofType(file, "IFCRELCONTAINEDINSPATIALSTRUCTURE").find((r) => r.args[4]?.kind === "list" && r.args[4].items.some((t) => t.kind === "ref" && t.id === fryer.id));
    const structure = contained?.args[5]?.kind === "ref" ? file.entities.get(contained.args[5].id) : undefined;
    expect(structure?.type).toBe("IFCSPACE");
  });

  it("gives a placed element a body and its type through IfcRelDefinesByType", () => {
    const ahu = named(file, "IFCUNITARYEQUIPMENT", "AHU-1");
    expect(ahu.args[6]?.kind).toBe("ref");
    const type = ofType(file, "IFCUNITARYEQUIPMENTTYPE")[0];
    expect(type?.args[2]).toEqual({ kind: "string", value: "AHU 2000 CFM" });
    const rel = ofType(file, "IFCRELDEFINESBYTYPE").find((r) => r.args[5]?.kind === "ref" && r.args[5].id === type?.id);
    expect(rel?.args[4]).toEqual({ kind: "list", items: [{ kind: "ref", id: ahu.id }] });
  });

  it("nests ports on their element and connects the duct to the air handler", () => {
    const ahu = named(file, "IFCUNITARYEQUIPMENT", "AHU-1");
    const nest = ofType(file, "IFCRELNESTS").find((r) => r.args[4]?.kind === "ref" && r.args[4].id === ahu.id);
    const portRef = nest?.args[5]?.kind === "list" ? nest.args[5].items[0] : undefined;
    const port = portRef?.kind === "ref" ? file.entities.get(portRef.id) : undefined;
    expect(port?.type).toBe("IFCDISTRIBUTIONPORT");
    expect(port?.args.slice(7)).toEqual([
      { kind: "enum", value: "SOURCE" },
      { kind: "enum", value: "DUCT" },
      { kind: "enum", value: "AIRCONDITIONING" },
    ]);
    const connects = ofType(file, "IFCRELCONNECTSPORTS");
    expect(connects).toHaveLength(1);
    expect([connects[0]?.args[4], connects[0]?.args[5]]).toContainEqual({ kind: "ref", id: port?.id });
  });

  it("writes the load point as a port with its fixture units as a quantity set", () => {
    const lp = named(file, "IFCDISTRIBUTIONPORT", "P41-1");
    expect(setsOf(file, lp.id).get("MutinyBIM_FixtureUnits")?.sort()).toEqual(["ColdWaterSupplyFixtureUnits", "DrainageFixtureUnits", "HotWaterSupplyFixtureUnits"]);
    expect(lp.args[8]).toEqual({ kind: "enum", value: "PIPE" });
    expect(lp.args[9]).toEqual({ kind: "enum", value: "DOMESTICCOLDWATER" });
  });

  it("writes grease waste as a USERDEFINED distribution system and serves the zone's spaces", () => {
    const gw = named(file, "IFCDISTRIBUTIONSYSTEM", "Grease Waste 1");
    expect(gw.args[4]).toEqual({ kind: "string", value: "GreaseWaste" });
    expect(gw.args[6]).toEqual({ kind: "enum", value: "USERDEFINED" });
    const sa = named(file, "IFCDISTRIBUTIONSYSTEM", "Supply Air 1");
    const serves = ofType(file, "IFCRELSERVICESBUILDINGS").find((r) => r.args[4]?.kind === "ref" && r.args[4].id === sa.id);
    expect(serves?.args[5]?.kind === "list" ? serves.args[5].items.length : 0).toBe(2);
  });

  it("writes the outlined fire area as an IfcSpatialZone FIRESAFETY and the thermal zone as an IfcZone over its spaces", () => {
    const fire = named(file, "IFCSPATIALZONE", "Fire area A");
    expect(fire.args[8]).toEqual({ kind: "enum", value: "FIRESAFETY" });
    const zone = named(file, "IFCZONE", "Zone 1");
    const group = ofType(file, "IFCRELASSIGNSTOGROUP").find((r) => r.args[6]?.kind === "ref" && r.args[6].id === zone.id);
    expect(group?.args[4]?.kind === "list" ? group.args[4].items.length : 0).toBe(2);
  });

  it("writes space quantities and occupancy in the standard sets", () => {
    const kitchen = ofType(file, "IFCSPACE").find((s) => s.args[9]?.kind === "enum" && s.args[9].value === "SPACE" && s.args[2]?.kind === "string" && s.args[2].value === "101");
    if (!kitchen) throw new Error("no kitchen space");
    const sets = setsOf(file, kitchen.id);
    expect(sets.get("Qto_SpaceBaseQuantities")?.sort()).toEqual(["Height", "NetFloorArea"]);
    expect(sets.get("Pset_SpaceOccupancyRequirements")).toEqual(["OccupancyNumber"]);
    const room = ofType(file, "IFCSPACE").find((s) => s.args[9]?.kind === "enum" && s.args[9].value === "INTERNAL");
    const agg = ofType(file, "IFCRELAGGREGATES").find((r) => r.args[4]?.kind === "ref" && r.args[4].id === kitchen.id);
    expect(agg?.args[5]).toEqual({ kind: "list", items: [{ kind: "ref", id: room?.id }] });
  });

  it("puts parameters in their IFC homes and never under a reserved name of our own", () => {
    const type = ofType(file, "IFCUNITARYEQUIPMENTTYPE")[0];
    const sets = type?.args[5];
    const names = sets?.kind === "list" ? sets.items.map((r) => (r.kind === "ref" ? file.entities.get(r.id)?.args[2] : undefined)).map((n) => (n?.kind === "string" ? n.value : "?")) : [];
    expect(names.sort()).toEqual(["MutinyBIM_Mechanical", "Pset_ElectricalDeviceCommon", "Pset_ManufacturerTypeInformation"]);
    const ours = ofType(file, "IFCPROPERTYSET").map((s) => (s.args[2]?.kind === "string" ? s.args[2].value : ""));
    const standard = new Set(["Pset_ElectricalDeviceCommon", "Pset_ManufacturerTypeInformation", "Pset_SpaceCommon", "Pset_SpaceOccupancyRequirements"]);
    expect(ours.filter((n) => n.startsWith("Pset_") && !standard.has(n))).toEqual([]);
    expect(ours).toContain(IFC_ORGANIZATION_PSET);
  });

  it("writes units from bim-units: millimetres, and SI for every value type used", () => {
    const si = ofType(file, "IFCSIUNIT").map((u) => u.args.slice(1).map((a) => (a.kind === "enum" ? a.value : "$")).join(" "));
    expect(si).toContain("LENGTHUNIT MILLI METRE");
    expect(si).toContain("ELECTRICVOLTAGEUNIT $ VOLT");
    const derived = ofType(file, "IFCDERIVEDUNIT").map((u) => u.args[1]);
    expect(derived).toContainEqual({ kind: "enum", value: "VOLUMETRICFLOWRATEUNIT" });
    const airflow = ofType(file, "IFCPROPERTYSINGLEVALUE").find((p) => p.args[0]?.kind === "string" && p.args[0].value === "SupplyAirflow");
    expect(airflow?.args[2]?.kind === "typed" ? airflow.args[2].type : "").toBe("IFCVOLUMETRICFLOWRATEMEASURE");
    const value = airflow?.args[2]?.kind === "typed" && airflow.args[2].value.kind === "number" ? airflow.args[2].value.value : 0;
    expect(value).toBeCloseTo(2000 * 0.000471947443, 9);
  });

  it("writes the organization set under its new name; readers still accept the old one", () => {
    expect(IFC_ORGANIZATION_PSET).toBe("MutinyBIM_Organization");
    expect(isIfcOrganizationPset(LEGACY_IFC_ORGANIZATION_PSET)).toBe(true);
    expect(isIfcOrganizationPset("MutinyBIM_Organization")).toBe(true);
    expect(isIfcOrganizationPset("Pset_WallCommon")).toBe(false);
    const wall = ofType(file, "IFCWALL")[0];
    expect(setsOf(file, wall?.id ?? 0).get("MutinyBIM_Organization")?.sort()).toEqual(["Group", "Phase Created", "Phase Demolished", "Status"]);
  });
});

describe("registry-driven classes", () => {
  it("a pack class with an IFC hint exports as that entity with no exporter change", () => {
    const registry = builtinRegistryBuilder()
      .addClass({
        id: "zz.widget",
        label: "Widgets",
        discipline: "structure",
        parent: "mep.mechanical_equipment",
        ifc: { entity: "IfcBeam", predefinedType: "JOIST", typeEntity: "IfcBeamType" },
        recognize: { partCategories: ["mechanical_equipment"], where: [{ path: "type.param.manufacturer", op: "present" }] },
        source: "library:zz@1",
      })
      .build();
    const file = readStep(exportIfc(opts({ registry })).text);
    const widget = named(file, "IFCBEAM", "AHU-1");
    expect(widget.args[8]).toEqual({ kind: "enum", value: "JOIST" });
    expect(ofType(file, "IFCBEAMTYPE")).toHaveLength(1);
    expect(ofType(file, "IFCUNITARYEQUIPMENT")).toHaveLength(0);
  });

  it("a class contributed by a pack through the class extension point exports under that pack's set, with no registry passed", () => {
    const pack = definePack({ id: "zz", name: "Widgets", version: "1.0.0", kernel: "^1.0.0" }, [
      contribute(CLASS_POINT, [{ id: "zz.air_handler", label: "Air handlers", discipline: "mechanical", parent: "mep.mechanical_equipment", ifc: { entity: "IfcAirToAirHeatRecovery", typeEntity: "IfcAirToAirHeatRecoveryType" }, recognize: { partCategories: ["mechanical_equipment"] } }]),
    ]);
    const outside = readStep(exportIfc(opts()).text);
    expect(ofType(outside, "IFCAIRTOAIRHEATRECOVERY")).toHaveLength(0);
    const inside = readStep(withPackSet(PackSet.create([pack]), () => exportIfc(opts())).text);
    expect(named(inside, "IFCAIRTOAIRHEATRECOVERY", "AHU-1")).toBeDefined();
    expect(ofType(inside, "IFCAIRTOAIRHEATRECOVERYTYPE")).toHaveLength(1);
  });

  it("an element no class recognises, or a hint the schema lacks, is an IfcBuildingElementProxy with the reason", () => {
    const legacy: BimElement = { id: asElementId("tap-1"), version: 1, authoredRev: {}, kind: "elbow", systemClass: "supply", position: { x: 0, y: 0 }, profile: { shape: "round", diameter: 300 } };
    const registry = builtinRegistryBuilder()
      .addClass({ id: "zz.gizmo", label: "Gizmos", discipline: "general", ifc: { entity: "IfcNoSuchThing" }, recognize: { elementKinds: ["wall"] }, source: "library:zz@1" })
      .build();
    const r = exportIfc(opts({ model: syntheticModel([legacy]), registry }));
    const file = readStep(r.text);
    const proxies = ofType(file, "IFCBUILDINGELEMENTPROXY");
    expect(proxies.map((p) => (p.args[4]?.kind === "string" ? p.args[4].value : "")).sort()).toEqual(["Gizmos", "elbow"]);
    expect(r.report.warnings.some((w) => w.includes("IfcNoSuchThing"))).toBe(true);
    expect(r.report.warnings.some((w) => w.startsWith("tap-1"))).toBe(true);
  });

  it("every built-in class and service row names an IFC4X3_ADD2 entity and enumeration member (IFC-1, IFC-5)", () => {
    const nonElements = new Set(["IfcSpace", "IfcZone", "IfcDistributionSystem", "IfcDistributionCircuit", "IfcDistributionPort", "IfcSite", "IfcBuildingStorey", "IfcGrid"]);
    for (const cls of BUILTIN_CLASSES) {
      if (!cls.ifc || nonElements.has(cls.ifc.entity)) continue;
      expect([cls.id, ifcEntityName(cls.ifc.entity)]).toEqual([cls.id, cls.ifc.entity]);
      if (cls.ifc.typeEntity) expect([cls.id, isInstantiableEntity(cls.ifc.typeEntity)]).toEqual([cls.id, true]);
    }
    // Every built-in (bare-id) row: the kernel's Other and the first-party trades' rows, as round 13's stand-in list held them.
    for (const row of firstPartyServiceRegistry().rows.filter((r) => !/[.:]/.test(r.id))) expect([row.id, predefinedTypes(row.ifc.system).has(row.ifc.predefinedType)]).toEqual([row.id, true]);
    const generic = BUILTIN_CLASSES.filter((c) => ["IfcEnergyConversionDevice", "IfcFlowController", "IfcFlowTerminal"].includes(c.ifc?.entity ?? "")).map((c) => c.id);
    expect(generic).toEqual([]);
  });

  it("refines a generic run fitting by its run domain", () => {
    const elbow: BimElement = {
      id: asElementId("elb-1"),
      version: 1,
      authoredRev: {},
      kind: "run_fitting",
      fittingType: "elbow",
      label: "Smooth radius elbow",
      domain: "duct",
      systemId: asElementId("sys-sa"),
      levelId: asElementId("lvl-1"),
      position: { x: 6000, y: 1000, z: 400 },
      ports: [],
    };
    const file = readStep(exportIfc(opts({ model: syntheticModel([elbow]) })).text);
    expect(ofType(file, "IFCDUCTFITTING")[0]?.args[8]).toEqual({ kind: "enum", value: "BEND" });
  });
});

describe("typicals", () => {
  it("write the original and each copy as an IfcElementAssembly of one assembly type; members sit in the original only", () => {
    const group: BimElement = {
      id: asElementId("grp-unit-a"),
      version: 1,
      authoredRev: {},
      kind: "organization",
      entry: {
        type: "group",
        name: "Unit A",
        color: "#336699",
        description: "Typical unit",
        locked: false,
        defaultVisibility: "show",
        order: 5,
        typical: { label: "Unit", mark: "001", basePoint: { x: 0, y: 0 }, copies: [{ id: "c2", mark: "002", offset: { x: 12000, y: 0 }, rotationDeg: 0 }, { id: "c3", mark: "003", offset: { x: 24000, y: 0 }, rotationDeg: 180 }] },
      },
    };
    const unitWall: BimElement = { id: asElementId("wall-unit"), version: 1, authoredRev: {}, kind: "wall", start: { x: 0, y: 0 }, end: { x: 3000, y: 0 }, thickness: 120, height: 2700, wallType: "Demising", groupId: "grp-unit-a", partition: { level: "lvl-1", zone: "Z1", discipline: "architecture" } };
    const r = exportIfc(opts({ model: syntheticModel([group, unitWall]) }));
    const file = readStep(r.text);
    const assemblies = ofType(file, "IFCELEMENTASSEMBLY");
    expect(assemblies.map((a) => (a.args[7]?.kind === "string" ? a.args[7].value : "")).sort()).toEqual(["001", "002", "003"]);
    expect(ofType(file, "IFCELEMENTASSEMBLYTYPE")).toHaveLength(1);
    expect(r.report.counts.assemblies).toBe(3);
    const wall = ofType(file, "IFCWALL").find((w) => r.report.globalIds["wall-unit"] === (w.args[0]?.kind === "string" ? w.args[0].value : ""));
    const original = assemblies.find((a) => a.args[7]?.kind === "string" && a.args[7].value === "001");
    const agg = ofType(file, "IFCRELAGGREGATES").find((x) => x.args[4]?.kind === "ref" && x.args[4].id === original?.id);
    expect(agg?.args[5]).toEqual({ kind: "list", items: [{ kind: "ref", id: wall?.id }] });
    const containedTwice = ofType(file, "IFCRELCONTAINEDINSPATIALSTRUCTURE").some((c) => c.args[4]?.kind === "list" && c.args[4].items.some((t) => t.kind === "ref" && t.id === wall?.id));
    expect(containedTwice).toBe(false);
    expect(danglingReferences(file)).toEqual([]);
  });
});

describe("STEP text", () => {
  it("escapes apostrophes, backslashes and every character outside printable ASCII", () => {
    expect(stepString("Acme's \\ duct")).toBe("'Acme''s \\\\ duct'");
    expect(stepString("Café ½ 😀")).toBe("'Caf\\X2\\00E9\\X0\\ \\X2\\00BD\\X0\\ \\X2\\D83DDE00\\X0\\'");
    const file = readStep(exportIfc(opts()).text);
    const manufacturer = ofType(file, "IFCPROPERTYSINGLEVALUE").find((p) => p.args[0]?.kind === "string" && p.args[0].value === "Manufacturer");
    expect(manufacturer?.args[2]).toEqual({ kind: "typed", type: "IFCLABEL", value: { kind: "string", value: 'Acme\'s "Air" Co.' } });
    expect(named(file, "IFCWALLTYPE", 'Partition 4 1/2"')).toBeDefined();
  });

  it("writes reals with a decimal point and no negative zero", () => {
    expect(stepReal(0)).toBe("0.");
    expect(stepReal(-0)).toBe("0.");
    expect(stepReal(4000)).toBe("4000.");
    expect(stepReal(0.1 + 0.2)).toBe("0.3");
    expect(stepReal(1e-5)).toBe("0.00001");
    expect(stepReal(1e-7)).toBe("1.E-07");
    expect(stepReal(1.5e21)).toBe("1.5E21");
    expect(stepReal(-2.5e-7)).toBe("-2.5E-07");
  });
});
