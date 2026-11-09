/**
 * @jest-environment node
 */
import {
  BUILTIN_PART_TYPES,
  applyChangeset,
  asElementId,
  canonicalJson,
  convertFullExtract,
  convertRevitType,
  executeCommand,
  partTypeDefinitionSchema,
  partTypeIssues,
  planCommit,
  resolveConnectors,
  resolveGeometry,
  sliceChangeset,
  sliceModel,
  validateModel,
  type BimElement,
  type Changeset,
  type Command,
  type CommandRequest,
  type LibraryEntry,
  type ModelState,
  type PartCategory,
  type Tag,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const NOW = () => "2026-10-19T00:00:00.000Z";
const id = asElementId;
function libraryType(pred: (t: LibraryEntry) => boolean): LibraryEntry {
  const found = BUILTIN_PART_TYPES.find(pred);
  if (!found) throw new Error("starter library is missing a type");
  return found;
}
const DIFFUSER = libraryType((t) => t.definition.category === "air_terminal");
const RECEPTACLE = libraryType((t) => t.definition.category === "electrical_device");

interface Person {
  readonly id: string;
  readonly name: string;
  readonly session: string;
}
const PRIYA: Person = { id: "priya", name: "Priya", session: "tab-priya" };
const MARCO: Person = { id: "marco", name: "Marco", session: "tab-marco" };

let counter = 0;
function request(who: Person, base: number, command: Command): CommandRequest {
  counter += 1;
  return { idempotencyKey: `${who.id}-${counter}-key`, baseRevision: base, actor: { id: who.id, name: who.name, kind: "human" }, command, clientSessionId: who.session };
}

/** In-test sequencer: the same planCommit the authority runs, with the whole log as undo history. */
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  submit(who: Person, command: Command, base: number = this.head.revision) {
    const req = request(who, base, command);
    const decision = planCommit(this.head, this.log.filter((cs) => cs.revision > base), req, NOW, this.log);
    if (decision.ok) {
      // Every client applies the changeset whole; it must land on exactly the authority's model.
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(who: Person, command: Command, base?: number): Changeset {
    const d = this.submit(who, command, base);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  el(key: string): BimElement {
    const found = this.head.elements[key];
    if (!found) throw new Error(`missing ${key}`);
    return found;
  }
}

function withLevel(): Model {
  const m = new Model(createDemoModel());
  m.ok(PRIYA, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  return m;
}

function placeDiffuser(m: Model, partId = "p-1", who: Person = PRIYA, position = { x: 1000, y: 2000 }) {
  return m.submit(who, {
    type: "place_part",
    partId,
    typeId: DIFFUSER.id,
    partType: DIFFUSER.definition,
    levelId: "lvl-1",
    position,
    offsetMm: 2743,
    values: { airflow: 180 },
  });
}

function addTag(m: Model, targetId: string): ModelState {
  const tag: Tag = { id: id("tag-1"), kind: "tag", version: 1, authoredRev: {}, targetId: id(targetId), offset: { x: 300, y: 300 }, text: "SD", position: { x: 0, y: 0 } };
  const elements = { ...Object.fromEntries(Object.entries(m.head.elements)), [tag.id]: tag };
  // Seeded directly (no tag-creation command yet); derived values recomputed by a no-op command.
  m.head = { ...m.head, elements };
  return m.head;
}

describe("starter library", () => {
  it("every built-in type is a valid definition with resolvable geometry and connectors", () => {
    expect(BUILTIN_PART_TYPES.length).toBeGreaterThanOrEqual(12);
    const categories = new Set(BUILTIN_PART_TYPES.map((t) => t.definition.category));
    const wanted: PartCategory[] = ["air_terminal", "mechanical_equipment", "electrical_device", "electrical_equipment", "lighting_fixture", "plumbing_fixture"];
    for (const c of wanted) expect(categories.has(c)).toBe(true);
    for (const t of BUILTIN_PART_TYPES) {
      expect(partTypeDefinitionSchema.safeParse(t.definition).success).toBe(true);
      expect(partTypeIssues(t.definition)).toEqual([]);
      for (const prim of resolveGeometry(t.definition)) {
        if (prim.kind === "box") expect(prim.size.every((n) => n > 0)).toBe(true);
      }
      for (const c of resolveConnectors(t.definition)) expect(["duct", "pipe", "electrical"]).toContain(c.domain);
    }
  });
});

describe("levels and place_part", () => {
  it("places any part on a level, pinning its type into the model in the same change", () => {
    const m = withLevel();
    const d = placeDiffuser(m);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const part = m.el("p-1");
    expect(part.kind).toBe("part");
    if (part.kind !== "part") return;
    expect(part.levelId).toBe("lvl-1");
    expect(part.offsetMm).toBe(2743);
    expect(part.partition).toEqual({ level: "Level 1", zone: "Z1", discipline: "mechanical" });
    const type = m.el(DIFFUSER.id);
    expect(type.kind === "part_type" && type.definition.typeName).toBe(DIFFUSER.definition.typeName);
    expect(d.changeset.before).toEqual({ "p-1": null, [DIFFUSER.id]: null });
    expect(validateModel(m.head)).toEqual([]);
  });

  it("an electrical device lands in the electrical discipline", () => {
    const m = withLevel();
    m.ok(PRIYA, { type: "place_part", partId: "r-1", typeId: RECEPTACLE.id, partType: RECEPTACLE.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 457, values: { circuit: "LP-1-12" } });
    const r = m.el("r-1");
    expect(r.partition?.discipline).toBe("electrical");
  });

  it("refuses with a plain reason: unknown type, wrong values, a type parameter at instance scope, duplicate ids and level names", () => {
    const m = withLevel();
    const noType = m.submit(PRIYA, { type: "place_part", partId: "p-x", typeId: "nope", levelId: "lvl-1", position: { x: 0, y: 0 } });
    expect(!noType.ok && noType.error.message).toMatch(/isn't in this model yet/);
    const bad = m.submit(PRIYA, { type: "place_part", partId: "p-x", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, values: { airflow: -5 } });
    expect(!bad.ok && bad.error.message).toMatch(/Airflow must be at least 0/);
    const typeParam = m.submit(PRIYA, { type: "place_part", partId: "p-x", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, values: { face_size: 300 } });
    expect(!typeParam.ok && typeParam.error.message).toMatch(/type parameter; change it with Edit type/);
    expect(placeDiffuser(m).ok).toBe(true);
    const dup = placeDiffuser(m);
    expect(!dup.ok && dup.error.code).toBe("already_exists");
    const level = m.submit(PRIYA, { type: "create_level", levelId: "lvl-2", name: "level 1", elevationMm: 4000 });
    expect(!level.ok && level.error.message).toMatch(/already a level named Level 1/);
  });

  it("levels and types reach every area; a part reaches the people loading its level", () => {
    const m = withLevel();
    const d = placeDiffuser(m);
    if (!d.ok) throw new Error(d.error.message);
    const other = sliceModel(m.head, { areas: [{ level: "Level 2" }] });
    expect(other.elements["lvl-1"]).toBeDefined();
    expect(other.elements[DIFFUSER.id]).toBeDefined();
    expect(other.elements["p-1"]).toBeUndefined();
    const sliced = sliceChangeset(d.changeset, { areas: [{ level: "Level 1" }], disciplines: ["mechanical"] });
    expect(sliced.elements.map((e) => e.id).sort()).toEqual(["p-1", DIFFUSER.id].sort());
  });
});

describe("move, rotate, copy", () => {
  it("moves parts (plan and height), and tags on them follow", () => {
    const m = withLevel();
    placeDiffuser(m);
    addTag(m, "p-1");
    m.ok(PRIYA, { type: "move_elements", ids: ["p-1"], delta: { x: 500, y: -250 }, dzMm: 100 });
    const part = m.el("p-1");
    expect(part.kind === "part" && part.position).toEqual({ x: 1500, y: 1750 });
    expect(part.kind === "part" && part.offsetMm).toBe(2843);
    const tag = m.el("tag-1");
    expect(tag.kind === "tag" && tag.position).toEqual({ x: 1800, y: 2050 });
  });

  it("moves legacy equipment exactly as move_equipment does (its ducts follow)", () => {
    const viaParts = executeCommand(createDemoModel(), { type: "move_elements", ids: ["ahu-1"], delta: { x: 0, y: -300 } });
    const legacy = executeCommand(createDemoModel(), { type: "move_equipment", equipmentId: "ahu-1", delta: { x: 0, y: -300 } });
    expect(viaParts.ok && legacy.ok).toBe(true);
    if (viaParts.ok && legacy.ok) expect(canonicalJson(viaParts.model)).toBe(canonicalJson(legacy.model));
  });

  it("refuses to move a duct piece on its own, and height on non-parts", () => {
    const m = withLevel();
    const seg = m.submit(PRIYA, { type: "move_elements", ids: ["seg-run-1"], delta: { x: 10, y: 0 } });
    expect(!seg.ok && seg.error.code).toBe("wrong_kind");
    const dz = m.submit(PRIYA, { type: "move_elements", ids: ["ahu-1"], delta: { x: 0, y: 0 }, dzMm: 10 });
    expect(!dz.ok && dz.error.message).toMatch(/only parts move up and down/);
  });

  it("rotates about the insertion point, or about a pivot for several parts", () => {
    const m = withLevel();
    placeDiffuser(m);
    placeDiffuser(m, "p-2", PRIYA, { x: 3000, y: 2000 });
    m.ok(PRIYA, { type: "rotate_elements", ids: ["p-1"], angleDeg: 90 });
    const one = m.el("p-1");
    expect(one.kind === "part" && [one.position, one.rotationDeg]).toEqual([{ x: 1000, y: 2000 }, 90]);
    m.ok(PRIYA, { type: "rotate_elements", ids: ["p-1", "p-2"], angleDeg: 180 });
    const a = m.el("p-1");
    const b = m.el("p-2");
    expect(a.kind === "part" && b.kind === "part" && [a.position, b.position, a.rotationDeg]).toEqual([{ x: 3000, y: 2000 }, { x: 1000, y: 2000 }, 270]);
  });

  it("copies parts with new ids and no mark", () => {
    const m = withLevel();
    placeDiffuser(m);
    m.ok(PRIYA, { type: "set_parameters", id: "p-1", scope: "instance", mark: "SD-7" });
    m.ok(PRIYA, { type: "copy_elements", ids: ["p-1"], newIds: ["p-1-copy"], delta: { x: 1200, y: 0 } });
    const copy = m.el("p-1-copy");
    expect(copy.kind === "part" && [copy.position, copy.mark, copy.values.airflow]).toEqual([{ x: 2200, y: 2000 }, "", 180]);
    const again = m.submit(PRIYA, { type: "copy_elements", ids: ["p-1"], newIds: ["p-1-copy"], delta: { x: 0, y: 0 } });
    expect(!again.ok && again.error.code).toBe("already_exists");
  });
});

describe("set_parameters", () => {
  it("instance values are validated against the instance schema; null clears back to the default", () => {
    const m = withLevel();
    placeDiffuser(m);
    m.ok(PRIYA, { type: "set_parameters", id: "p-1", scope: "instance", values: { airflow: 220, room: "101" } });
    let part = m.el("p-1");
    expect(part.kind === "part" && part.values).toEqual({ airflow: 220, room: "101" });
    const bad = m.submit(PRIYA, { type: "set_parameters", id: "p-1", scope: "instance", values: { airflow: "lots" } });
    expect(!bad.ok && bad.error.message).toMatch(/Airflow must be a number/);
    m.ok(PRIYA, { type: "set_parameters", id: "p-1", scope: "instance", values: { room: null } });
    part = m.el("p-1");
    expect(part.kind === "part" && part.values).toEqual({ airflow: 220 });
  });

  it("type values change the type every instance shares, and only through the type scope", () => {
    const m = withLevel();
    placeDiffuser(m);
    const wrongScope = m.submit(PRIYA, { type: "set_parameters", id: "p-1", scope: "instance", values: { neck_diameter: 254 } });
    expect(!wrongScope.ok && wrongScope.error.message).toMatch(/change it with Edit type/);
    m.ok(PRIYA, { type: "set_parameters", id: "p-1", scope: "type", values: { neck_diameter: 254 } });
    const type = m.el(DIFFUSER.id);
    expect(type.kind === "part_type" && type.definition.typeValues.neck_diameter).toBe(254);
    const instanceOnType = m.submit(PRIYA, { type: "set_parameters", id: DIFFUSER.id, scope: "type", values: { airflow: 10 } });
    expect(!instanceOnType.ok && instanceOnType.error.message).toMatch(/set on each part, not on the type/);
  });

  it("legacy air terminals take their airflow through the same command", () => {
    const m = new Model(createDemoModel());
    m.ok(PRIYA, { type: "set_parameters", id: "sd-1", scope: "instance", values: { cfm: 400 } });
    const trunk = m.el("seg-trunk");
    expect(trunk.kind === "duct_segment" && trunk.flowCfm).toBe(700);
  });

  it("two people setting the same value: the second one, planned before the first, conflicts", () => {
    const m = withLevel();
    placeDiffuser(m);
    const base = m.head.revision;
    m.ok(MARCO, { type: "set_parameters", id: "p-1", scope: "instance", values: { airflow: 300 } }, base);
    const late = m.submit(PRIYA, { type: "set_parameters", id: "p-1", scope: "instance", values: { airflow: 250 } }, base);
    expect(!late.ok && late.error.code).toBe("conflict");
    expect(!late.ok && late.conflict?.withActor.name).toBe("Marco");
  });
});

describe("delete_elements dependency policy", () => {
  it("refuse lists the tag; cascade deletes it too and says so", () => {
    const m = withLevel();
    placeDiffuser(m);
    addTag(m, "p-1");
    const refused = m.submit(PRIYA, { type: "delete_elements", ids: ["p-1"], policy: "refuse" });
    expect(!refused.ok && refused.error.code).toBe("has_dependents");
    expect(!refused.ok && refused.error.message).toMatch(/1 item that depend on it \(tag tag-1\)/);
    expect(m.head.elements["p-1"]).toBeDefined();
    const cs = m.ok(PRIYA, { type: "delete_elements", ids: ["p-1"], policy: "cascade" });
    expect([...(cs.removedIds ?? [])].sort()).toEqual(["p-1", "tag-1"]);
    expect(m.head.elements["p-1"]).toBeUndefined();
    expect(m.head.elements["tag-1"]).toBeUndefined();
  });

  it("disconnect cuts a terminal's connection and airflow recomputes; refuse names the connection", () => {
    const m = new Model(createDemoModel());
    const refused = m.submit(PRIYA, { type: "delete_elements", ids: ["sd-1"], policy: "refuse" });
    expect(!refused.ok && refused.error.message).toMatch(/1 connection/);
    const cs = m.ok(PRIYA, { type: "delete_elements", ids: ["sd-1"], policy: "disconnect" });
    expect(cs.removedConnections?.map((c) => c.id)).toEqual(["c-run-1-sd"]);
    expect(m.head.connections.some((c) => c.id === "c-run-1-sd")).toBe(false);
    const trunk = m.el("seg-trunk");
    expect(trunk.kind === "duct_segment" && trunk.flowCfm).toBe(300);
  });

  it("a level with parts on it: refuse lists them, cascade takes them with it", () => {
    const m = withLevel();
    placeDiffuser(m);
    const refused = m.submit(PRIYA, { type: "delete_elements", ids: ["lvl-1"], policy: "disconnect" });
    expect(!refused.ok && refused.error.code).toBe("has_dependents");
    const cs = m.ok(PRIYA, { type: "delete_elements", ids: ["lvl-1"], policy: "cascade" });
    expect([...(cs.removedIds ?? [])].sort()).toEqual(["lvl-1", "p-1"]);
  });

  it("deleting what someone changed after you looked conflicts instead of discarding their work", () => {
    const m = withLevel();
    placeDiffuser(m);
    const base = m.head.revision;
    m.ok(MARCO, { type: "move_elements", ids: ["p-1"], delta: { x: 100, y: 0 } }, base);
    const del = m.submit(PRIYA, { type: "delete_elements", ids: ["p-1"], policy: "refuse" }, base);
    expect(!del.ok && del.error.code).toBe("conflict");
    expect(!del.ok && del.error.message).toMatch(/Marco changed p-1 after you looked/);
  });
});

describe("collaborative undo", () => {
  it("undo removes a placed part and its newly pinned type; undoing the undo puts them back", () => {
    const m = withLevel();
    const placed = placeDiffuser(m);
    if (!placed.ok) throw new Error(placed.error.message);
    const undone = m.ok(PRIYA, { type: "undo", revision: placed.changeset.revision });
    expect([...(undone.removedIds ?? [])].sort()).toEqual(["p-1", DIFFUSER.id].sort());
    expect(m.head.elements["p-1"]).toBeUndefined();
    m.ok(PRIYA, { type: "undo", revision: undone.revision });
    const back = m.el("p-1");
    expect(back.kind === "part" && back.position).toEqual({ x: 1000, y: 2000 });
  });

  it("refuses to overwrite another participant's newer change, naming them", () => {
    const m = withLevel();
    placeDiffuser(m);
    const mine = m.ok(PRIYA, { type: "move_elements", ids: ["p-1"], delta: { x: 1000, y: 0 } });
    m.ok(MARCO, { type: "set_parameters", id: "p-1", scope: "instance", values: { airflow: 90 } });
    const undo = m.submit(PRIYA, { type: "undo", revision: mine.revision });
    expect(!undo.ok && undo.error.code).toBe("undo_refused");
    expect(!undo.ok && undo.error.message).toBe(`Marco changed this since (revision ${mine.revision + 1}); undo would overwrite their work`);
    const part = m.el("p-1");
    expect(part.kind === "part" && part.position.x).toBe(2000);
  });

  it("is per person: nobody undoes someone else's change, and undo goes newest first", () => {
    const m = withLevel();
    placeDiffuser(m);
    const first = m.ok(PRIYA, { type: "move_elements", ids: ["p-1"], delta: { x: 1, y: 0 } });
    m.ok(PRIYA, { type: "move_elements", ids: ["p-1"], delta: { x: 1, y: 0 } });
    const notMine = m.submit(MARCO, { type: "undo", revision: first.revision });
    expect(!notMine.ok && notMine.error.message).toMatch(/only undo your own changes; Priya made/);
    const outOfOrder = m.submit(PRIYA, { type: "undo", revision: first.revision });
    expect(!outOfOrder.ok && outOfOrder.error.message).toMatch(/You changed this again in revision/);
  });

  it("undo of a delete restores the part, its tag and cut connections", () => {
    const m = new Model(createDemoModel());
    const del = m.ok(PRIYA, { type: "delete_elements", ids: ["sd-1"], policy: "disconnect" });
    m.ok(PRIYA, { type: "undo", revision: del.revision });
    expect(m.el("sd-1").kind).toBe("terminal");
    expect(m.head.connections.some((c) => c.id === "c-run-1-sd")).toBe(true);
    const trunk = m.el("seg-trunk");
    expect(trunk.kind === "duct_segment" && trunk.flowCfm).toBe(650);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses to remove a type someone else has since placed", () => {
    const m = withLevel();
    const placed = placeDiffuser(m);
    if (!placed.ok) throw new Error(placed.error.message);
    m.ok(MARCO, { type: "place_part", partId: "p-marco", typeId: DIFFUSER.id, levelId: "lvl-1", position: { x: 0, y: 0 } });
    const undo = m.submit(PRIYA, { type: "undo", revision: placed.changeset.revision });
    expect(!undo.ok && undo.error.message).toMatch(/1 other part now uses what this change added/);
  });
});

describe("Revit converter", () => {
  it("maps category, type parameters (lengths from feet, others from Revit's display), box and connectors", () => {
    const result = convertRevitType(
      {
        id: 101,
        category: "Mechanical Equipment",
        builtInCategory: "OST_MechanicalEquipment",
        family: "Sample Fan Family",
        typeName: "Sample 900 CFM",
        parameters: [
          { name: "Width", storage: "Double", hasValue: true, value: 2, display: "2' - 0\"", dataType: "autodesk.spec.aec:length-2.0.0" },
          { name: "Fan Airflow", storage: "Double", hasValue: true, value: 15, display: "900 CFM", dataType: "autodesk.spec.aec.hvac:airFlow-2.0.0" },
          { name: "Voltage", storage: "Double", hasValue: true, value: 1291.67, display: "120 V", dataType: "autodesk.spec.aec.electrical:electricalPotential-2.0.0" },
          { name: "Has Damper", storage: "Integer", hasValue: true, value: 1, display: "Yes" },
          { name: "Manufacturer", storage: "String", hasValue: true, value: "Acme" },
          { name: "Type Id", storage: "ElementId", hasValue: true, value: 5 },
          { name: "Family", storage: "String", hasValue: true, value: "Sample Fan Family" },
        ],
      },
      {
        point: [10, 20, 0],
        rotation: 0,
        bbox: { min: [9, 19.5, 8], max: [11, 20.5, 9] },
        parameters: [
          { name: "Mark", storage: "String", hasValue: true, value: "EF-1" },
          { name: "Serves", storage: "String", hasValue: true, readOnly: false, value: "Toilets" },
          { name: "System Classification", storage: "String", hasValue: true, readOnly: true, value: "Exhaust Air", display: "Exhaust Air" },
        ],
        connectors: [
          { domain: "DomainHvac", shape: "Round", origin: [11, 20, 8.5], direction: [1, 0, 0], radius: 0.25, flow: 15 },
          { domain: "DomainElectrical", origin: [10, 20, 9], direction: [0, 0, 1] },
        ],
      },
      { origin: "test" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.definition;
    expect(result.id).toBe("revit:sample-fan-family:sample-900-cfm");
    expect(d.category).toBe("mechanical_equipment");
    expect(d.typeValues).toEqual({ width: 609.6, fan_airflow: 900, voltage: 120, has_damper: true, manufacturer: "Acme" });
    expect(d.typeParams.find((p) => p.name === "fan_airflow")?.unit).toBe("cfm");
    expect(d.instanceParams.map((p) => p.name)).toEqual(["serves"]);
    expect(d.geometry).toEqual([{ kind: "box", center: [0, 0, 2590.8], size: [609.6, 304.8, 304.8] }]);
    expect(d.connectors[0]).toMatchObject({ domain: "duct", systemKind: "exhaust_air", shape: "round", diameter: 152.4, flow: 900, position: [304.8, 0, 2590.8] });
    expect(d.connectors[1]).toMatchObject({ domain: "electrical", systemKind: "power" });
    expect(partTypeIssues(d)).toEqual([]);
  });

  it("pairs a full extract's types with a placed instance's box and connectors", () => {
    const results = convertFullExtract({
      types: [
        { id: 7, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", family: "Sample Receptacle", typeName: "Duplex", parameters: [{ name: "Voltage", storage: "Double", hasValue: true, value: 1291.7, display: "120 V" }] },
        { id: 8, category: "Pipes", family: "Pipe Types", typeName: "Copper", parameters: [] },
      ],
      elements: [
        { id: 70, typeId: 7, location: { point: [0, 0, 1.5], rotation: 0 }, bbox: null },
        { id: 71, typeId: 7, location: { point: [5, 5, 1.5], rotation: 0 }, bbox: { min: [4.9, 4.95, 1.3], max: [5.1, 5.05, 1.7] } },
      ],
      connectors: [{ elementId: 71, connectors: [{ domain: "DomainElectrical", origin: [5, 5, 1.5], direction: [0, -1, 0] }] }],
    });
    const [receptacle, pipe] = results;
    expect(receptacle?.ok && receptacle.definition.geometry[0]).toEqual({ kind: "box", center: [0, 0, 0], size: [60.96, 30.48, 121.92] });
    expect(receptacle?.ok && receptacle.definition.connectors[0]?.domain).toBe("electrical");
    expect(pipe?.ok).toBe(false);
  });

  it("refuses runs and system families with a reason instead of inventing a part", () => {
    const r = convertRevitType({ id: 1, category: "Ducts", family: "Rectangular Duct", typeName: "Radius Elbows", parameters: [] }, null);
    expect(!r.ok && r.reason).toMatch(/connected run/);
  });
});
