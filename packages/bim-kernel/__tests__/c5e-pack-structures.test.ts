/**
 * @jest-environment node
 *
 * A pack's storm structures are parts with ports (5c follow-up, lane F's gaps
 * 3, 4, 5 and 7): a synthetic pack contributes a gravity service, a class and
 * a pipe material; a part type with two pipe connectors is placed, given the
 * pack's class, and joined to another by a run segment of the pack's system
 * in the pack's pipe material, all through existing commands. Zones, systems
 * and run segments carry values. Fails on the code before this change: parts
 * had no `classId`, zones / systems / run segments no `values`, `route_run`
 * took only the kernel's system kinds and pipe sizes only its twelve materials.
 */
import {
  asElementId,
  commandSchema,
  DEFAULT_SETTINGS,
  partTypeDefinitionSchema,
  planCommit,
  serviceById,
  withUpgradePolicy,
  type BimElement,
  type ModelState,
  type PartTypeDefinition,
} from "../src";
import { CLASS_POINT } from "../src/registry";
import { PackSet, bindModelPacks, contribute, definePack, unbindModelPacks, withModelPacks } from "../src/packs";
import { SERVICE_POINT } from "../src/services/registry";
import { PIPE_MATERIAL_POINT, pipeMaterialOf } from "../src/routing/pipe/materials";
import { readClassifiedElement } from "../src/elements";

const sanitary = serviceById("sanitary");
if (!sanitary) throw new Error("the built-in sanitary row");

const PACK = definePack({ id: "civtest", name: "Civil test", version: "1.0.0", kernel: "^1.0.0" }, [
  contribute(SERVICE_POINT, [{ ...sanitary, id: "civtest.storm", label: "Storm", discipline: "civil", regime: "gravity", connector: "pipe", adapter: undefined, asLoad: false, sourceRoles: [] }]),
  contribute(CLASS_POINT, [{ id: "civtest.manhole", label: "Manholes", discipline: "civil", ifc: { entity: "IfcDistributionChamberElement", predefinedType: "MANHOLE" } }]),
  contribute(PIPE_MATERIAL_POINT, [{ id: "civtest.rcp", label: "Reinforced concrete pipe", fallback: "pe" }]),
]);
const SET = PackSet.create([PACK]);

/** A pack defines its part types through the schema: it checks them and types its own system kind without a cast. */
const STRUCTURE: PartTypeDefinition = partTypeDefinitionSchema.parse({
  familyName: "Storm manhole",
  typeName: "48 in.",
  category: "pipe_accessory",
  typeParams: [],
  typeValues: {},
  instanceParams: [{ name: "rim_elevation", label: "Rim", kind: "length" }, { name: "invert_elevation", label: "Invert", kind: "length" }],
  connectors: [
    { id: "in", label: "Inlet", domain: "pipe", systemKind: "civtest.storm", position: [-600, 0, 300], direction: [-1, 0, 0], shape: "round", diameter: 304.8, flowDirection: "in" },
    { id: "out", label: "Outlet", domain: "pipe", systemKind: "civtest.storm", position: [600, 0, 300], direction: [1, 0, 0], shape: "round", diameter: 304.8, flowDirection: "out" },
  ],
  geometry: [{ kind: "cylinder", center: [0, 0, 0], radius: 600, height: 2400, axis: "z" }],
  symbol: [{ kind: "circle", center: [0, 0], radius: 600 }],
  tagFields: [],
  source: { kind: "builtin", libraryVersion: "test" },
});

let seq = 0;
const MODEL_ID = "c5e-storm";

/** One commit with the model's pack set bound and every feature read (the host's normal path). */
function tryCommit(head: ModelState, command: unknown): { ok: true; model: ModelState } | { ok: false; message: string } {
  seq += 1;
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "unparsed" };
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `c5e-storm-${seq}`, baseRevision: head.revision, actor: { id: "agent:test", name: "Test", kind: "agent" }, command: parsed.data }, () => "2026-10-29T00:00:00.000Z"));
  return d.ok ? { ok: true, model: d.model } : { ok: false, message: d.error.message };
}

function commit(head: ModelState, command: unknown): ModelState {
  const r = tryCommit(head, command);
  if (!r.ok) throw new Error(`${(command as { type: string }).type}: ${r.message}`);
  return r.model;
}

function site(): ModelState {
  let m: ModelState = { modelId: MODEL_ID, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-site", name: "Site", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "mh1", typeId: "pt-mh", partType: STRUCTURE, levelId: "lvl-site", position: { x: 0, y: 0 }, mark: "MH-1", values: { rim_elevation: 3000, invert_elevation: 600 } });
  m = commit(m, { type: "place_part", partId: "mh2", typeId: "pt-mh", levelId: "lvl-site", position: { x: 30_000, y: 0 }, mark: "MH-2", values: { rim_elevation: 2800, invert_elevation: 300 } });
  return m;
}

/** A storm pipe leaving `partId`'s outlet to an open end at `x` (the next structure is joined the same way from its inlet). */
const storm = (partId: string, x: number, materialId = "civtest.rcp") => ({
  type: "route_run",
  idPrefix: `p-${partId}`,
  levelId: "lvl-site",
  domain: "pipe",
  size: { shape: "pipe", nominalMm: 304.8, material: "pvc", materialId },
  system: { id: "sys-storm", kind: "civtest.storm", name: "Storm 1" },
  points: [{ x, y: 0 }],
  from: { kind: "part", partId, connectorId: "out" },
});

const get = (m: ModelState, id: string): BimElement => {
  const el = m.elements[id];
  if (!el) throw new Error(`${id} exists`);
  return el;
};

describe("a pack's storm structures are parts with ports, joined by its own pipe", () => {
  beforeAll(() => bindModelPacks(MODEL_ID, SET));
  afterAll(() => unbindModelPacks(MODEL_ID));

  it("places the structure type, gives it the pack's class, and routes a pack-material pipe of the pack's system between two", () => {
    let m = site();
    m = commit(m, { type: "set_element_class", elementIds: ["mh1", "mh2"], classId: "civtest.manhole" });
    expect(get(m, "mh1")).toMatchObject({ kind: "part", classId: "civtest.manhole" });
    m = commit(m, storm("mh1", 15_000));
    const segments = Object.values(m.elements).filter((e) => e.kind === "run_segment");
    expect(segments).toHaveLength(1);
    const seg = segments[0];
    if (seg?.kind !== "run_segment" || seg.size.shape !== "pipe") throw new Error("a pipe segment");
    // The pack's material, stored beside its built-in fallback (what the kernel's tables and older readers use).
    expect(seg.size).toMatchObject({ material: "pe", materialId: "civtest.rcp" });
    const size = seg.size;
    expect(withModelPacks(MODEL_ID, () => pipeMaterialOf(size))).toEqual({ id: "civtest.rcp", label: "Reinforced concrete pipe", fallback: "pe", known: true });
    // A host without the pack still reads it: kept by id, in words, with the kernel's fallback.
    expect(pipeMaterialOf(size)).toEqual({ id: "civtest.rcp", label: "Rcp", fallback: "pe", known: false });
    expect(seg.links.start).toEqual({ elementId: "mh1", port: "out" });
    expect(get(m, "mh1")).toMatchObject({ links: { out: { elementId: seg.id, port: "start" } } });
    expect(get(m, "sys-storm")).toMatchObject({ kind: "mep_system", systemKind: "civtest.storm" });
  });

  it("refuses a material, a class or a system kind the model's packs don't have, in plain words", () => {
    const m = site();
    const material = tryCommit(m, storm("mh1", 15_000, "civtest.vitrified_clay"));
    expect(material.ok ? "" : material.message).toBe("Vitrified clay (civtest.vitrified_clay) isn't a pipe material this model knows. Add the pack that defines it to the model, or choose one of the built-in materials");
    const cls = tryCommit(m, { type: "set_element_class", elementIds: ["mh1"], classId: "civtest.catch_basin" });
    expect(cls.ok ? "" : cls.message).toBe('"civtest.catch_basin" isn\'t a class this model knows: add the pack that defines civtest classes to the model, or choose a class it has');
    const wrongKind = tryCommit(m, { type: "set_element_class", elementIds: ["mh1"], classId: "arch.wall" });
    expect(wrongKind.ok ? "" : wrongKind.message).toBe("Walls is a class of walls; Part MH-1 is a part");
    const kind = tryCommit(m, { ...storm("mh1", 15_000), from: undefined, elevationMm: 0, points: [{ x: 0, y: 5000 }, { x: 10_000, y: 5000 }], system: { id: "sys-x", kind: "civtest.combined", name: "X" } });
    expect(kind.ok ? "" : kind.message).toMatch(/can't carry "Combined": it isn't a system this version of the model knows/);
  });

  it("a part's type parameters go through set_parameters; a pack parameter must belong to the part's class (round 3: pack parameters on parts)", () => {
    const typeParam = tryCommit(site(), { type: "set_element_values", elementIds: ["mh1"], values: { rim_elevation: 1 } });
    expect(typeParam.ok ? "" : typeParam.message).toBe("rim_elevation is a parameter of Part MH-1's type; set it with set_parameters");
    const notItsClass = tryCommit(site(), { type: "set_element_values", elementIds: ["mh1"], values: { "civil.rim": 1 } });
    expect(notItsClass.ok ? "" : notItsClass.message).toMatch(/^civil\.rim isn't a parameter of Part MH-1's class/);
  });

  it("zones, systems and run segments carry values; the readers hand them back as stored", () => {
    let m = commit(site(), storm("mh1", 15_000));
    const seg = Object.values(m.elements).find((e) => e.kind === "run_segment");
    if (!seg) throw new Error("a segment");
    m = commit(m, { type: "set_element_values", elementIds: ["sys-storm", seg.id], values: { "civtest.min_slope": 0.005, "civtest.manning_n": 0.013 } });
    expect(get(m, "sys-storm")).toMatchObject({ values: { "civtest.min_slope": 0.005 } });
    expect(get(m, seg.id)).toMatchObject({ values: { "civtest.manning_n": 0.013 } });
    for (const id of ["sys-storm", seg.id, "mh1"]) {
      const el = get(m, id);
      const read = readClassifiedElement(el);
      expect(read.ok && read.element).toBe(el);
    }
  });
});

describe("without the pack bound", () => {
  it("the same class and material are refused: the model doesn't have the pack", () => {
    let m: ModelState = { modelId: "c5e-storm-unbound", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    m = commit(m, { type: "create_level", levelId: "lvl-site", name: "Site", elevationMm: 0 });
    const zoneish = { ...m, elements: { ...m.elements, z1: { id: asElementId("z1"), version: 1, authoredRev: {}, kind: "zone", name: "Catchment C1", purpose: "drainage_catchment", spaceIds: [] } as BimElement } };
    const cls = tryCommit(zoneish, { type: "set_element_class", elementIds: ["z1"], classId: "civtest.manhole" });
    expect(cls.ok ? "" : cls.message).toMatch(/isn't a class this model knows/);
    const values = tryCommit(zoneish, { type: "set_element_values", elementIds: ["z1"], values: { "civtest.runoff_coefficient": 0.9 } });
    expect(values.ok && values.model.elements["z1"]).toMatchObject({ values: { "civtest.runoff_coefficient": 0.9 } });
  });
});
