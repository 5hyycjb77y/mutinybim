/**
 * @jest-environment node
 *
 * 7303 Sample Grill, Electrical Demo 1 (product decision, Oct 27): the service sized from
 * area estimates and the equipment list before anything is drawn. Lighting
 * 5 kW over the Kitchen (a density estimate), receptacles 2 kW over Dining (a
 * lump), the kitchen equipment as device loads (50 kW), RTU-1 + RTU-2 25 kW:
 * the service sees 82 kW = 342 A at 240 V single-phase. A real receptacle
 * inside Dining below its estimate leaves the estimate governing ("estimate
 * 2 kW, devices so far 0.8 kW"); one that exceeds it makes the devices govern.
 */
import { DEFAULT_SETTINGS, RequirementsEngine, allocateServedBy, allocatedActualLine, allocationPolicyOf, applyChangeset, asElementId, canonicalJson, fixedSpaceLocator, formatQuantity, planCommit, type Changeset, type Command, type ModelState, type PartTypeDefinition, type Space } from "@permitzip/bim-kernel";
import { distributionOf } from "@permitzip/bim-pack-electrical";
import { distributionType } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const NOW = () => "2026-10-27T19:00:00.000Z";
const SQM_PER_SQFT = 0.09290304;

const EQUIPMENT: PartTypeDefinition = {
  familyName: "Equipment",
  typeName: "Generic",
  category: "mechanical_equipment",
  typeParams: [],
  typeValues: {},
  instanceParams: [],
  connectors: [],
  geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 600, 600] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "test" },
};

class Model {
  head: ModelState;
  private readonly log: Changeset[] = [];
  private seq = 0;
  constructor(spaces: readonly Space[]) {
    this.head = { modelId: "7303", revision: 0 as ModelState["revision"], elements: Object.fromEntries(spaces.map((s) => [s.id, s])), connections: [], settings: DEFAULT_SETTINGS };
  }
  ok(command: Command): Changeset {
    const d = planCommit(this.head, [], { idempotencyKey: `7303-${++this.seq}`, baseRevision: this.head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW, this.log);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
    this.head = d.model;
    this.log.push(d.changeset);
    return d.changeset;
  }
}

const space = (id: string, number: string, name: string): Space => ({ id: asElementId(id), kind: "space", version: 1, authoredRev: {}, number, name, levelId: asElementId("lvl-1"), bounds: { kind: "none" }, origin: { kind: "typed" } });

/** Kitchen 1,000 sf, Dining 1,500 sf (areas from the spaces module's geometry in the app; fixed here). */
const locator = fixedSpaceLocator({
  spaceOf: { fryer: asElementId("sp-kitchen"), oven: asElementId("sp-kitchen"), dish: asElementId("sp-kitchen"), sal: asElementId("sp-kitchen"), rec: asElementId("sp-dining") },
  measures: { "sp-kitchen": { areaSqM: 1000 * SQM_PER_SQFT, occupants: 0 }, "sp-dining": { areaSqM: 1500 * SQM_PER_SQFT, occupants: 60 } },
});

function sampleGrill(): Model {
  const m = new Model([space("sp-kitchen", "101", "Kitchen"), space("sp-dining", "102", "Dining")]);
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "place_part", partId: "mdp", typeId: "type-mdp", partType: distributionType("Panelboard", "400 A 120/240 V", 240, "1", 42, 400, "400 A main"), levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "MDP", values: { panel_name: "MDP" } });
  const at = (i: number) => ({ x: 2000 * (i + 1), y: 0 });
  ["fryer", "oven", "dish", "sal", "rtu-1", "rtu-2"].forEach((id, i) => m.ok({ type: "place_part", partId: id, typeId: "type-equip", ...(i === 0 ? { partType: EQUIPMENT } : {}), levelId: "lvl-1", position: at(i), mark: id.toUpperCase() }));
  for (const [designator, loadClass, description] of [["E-LTG", "lighting", "Lighting allowance"], ["E-REC", "receptacle", "Receptacles"], ["E-KIT", "kitchen", "Kitchen equipment"], ["E-HVAC", "hvac", "Rooftop unit"]] as const) {
    m.ok({ type: "save_connection_type", entry: { designator, loadClass, description } });
  }
  const mdp = "mdp";
  m.ok({
    type: "create_load",
    loads: [
      // 1,000 sf × 5 VA/sf = 5 kW, stored per square metre like every rate.
      { id: "est-ltg", anchor: { kind: "space", id: "sp-kitchen" }, connectionType: "E-LTG", basis: "density", rates: [{ key: "va", per: "area", value: 5 / SQM_PER_SQFT }], servedBy: mdp, source: { kind: "engineer", ref: "SD lighting allowance 5 VA/sf" } },
      { id: "est-rec", anchor: { kind: "space", id: "sp-dining" }, connectionType: "E-REC", values: { va: 2000 }, servedBy: mdp, source: { kind: "engineer", ref: "SD receptacle allowance" } },
      { id: "dev-fryer", anchor: { kind: "part", partId: "fryer" }, connectionType: "E-KIT", values: { va: 15000 }, servedBy: mdp },
      { id: "dev-oven", anchor: { kind: "part", partId: "oven" }, connectionType: "E-KIT", values: { va: 20000 }, servedBy: mdp },
      { id: "dev-dish", anchor: { kind: "part", partId: "dish" }, connectionType: "E-KIT", values: { va: 10000 }, servedBy: mdp },
      { id: "dev-sal", anchor: { kind: "part", partId: "sal" }, connectionType: "E-KIT", values: { va: 5000 }, servedBy: mdp },
      { id: "dev-rtu-1", anchor: { kind: "part", partId: "rtu-1" }, connectionType: "E-HVAC", values: { va: 12500 }, servedBy: mdp },
      { id: "dev-rtu-2", anchor: { kind: "part", partId: "rtu-2" }, connectionType: "E-HVAC", values: { va: 12500 }, servedBy: mdp },
    ],
  });
  return m;
}

const kw = (va: number) => Math.round(va) / 1000;

function serviceAt(m: Model): { readonly kw: number; readonly amps: number } {
  const a = allocateServedBy(m.head.elements, "mdp", locator, allocationPolicyOf(m.head.elements));
  const mdp = m.head.elements.mdp;
  const dist = mdp?.kind === "part" ? distributionOf(m.head.elements, mdp) : null;
  if (!dist) throw new Error("MDP is distribution equipment");
  expect([dist.system.lineToLine, dist.system.phases]).toEqual([240, 1]);
  return { kw: kw(a.counted.va), amps: Math.round(a.counted.va / dist.system.lineToLine) };
}

describe("7303: the service from estimates and the equipment list", () => {
  it("lighting 5 kW + receptacles 2 kW + kitchen 50 kW + RTUs 25 kW = 82 kW = 342 A at 240 V single-phase", () => {
    const m = sampleGrill();
    expect(serviceAt(m)).toEqual({ kw: 82, amps: 342 });
    const engine = new RequirementsEngine({ locator });
    expect(engine.counted(m.head).va).toBe(82000);
    const p = engine.progress(m.head, { kind: "source", id: asElementId("mdp") });
    expect([p.total, p.byStage.estimate, p.byStage.device]).toEqual([8, 2, 6]);
  });

  it("a receptacle in Dining below its estimate leaves the estimate governing; one above it makes the devices govern", () => {
    const m = sampleGrill();
    m.ok({ type: "place_part", partId: "rec", typeId: "type-equip", levelId: "lvl-1", position: { x: 0, y: 5000 }, mark: "REC-1" });
    m.ok({ type: "create_load", loads: [{ id: "dev-rec", anchor: { kind: "part", partId: "rec" }, connectionType: "E-REC", values: { va: 800 }, servedBy: "mdp" }] });
    expect(serviceAt(m)).toEqual({ kw: 82, amps: 342 });
    const engine = new RequirementsEngine({ locator });
    const figures = engine.allocatedActual(m.head, "est-rec");
    if (!figures) throw new Error("the Dining estimate has figures");
    expect(figures.governing.va).toBe("allocated");
    expect(allocatedActualLine(figures, "va", (_k, v) => `${kw(v)} kW`)).toBe("estimate 2 kW, devices so far 0.8 kW");
    // The kitchen equipment is not lighting: the Kitchen lighting estimate stays 5 kW, never "satisfied" by a fryer.
    expect(engine.allocatedActual(m.head, "est-ltg")?.actual.va).toBe(0);

    m.ok({ type: "edit_load_point", loadId: "dev-rec", values: { va: 2500 } });
    expect(serviceAt(m)).toEqual({ kw: 82.5, amps: 344 });
    const after = new RequirementsEngine({ locator }).allocatedActual(m.head, "est-rec");
    expect(after?.governing.va).toBe("actual");
    expect(after ? formatQuantity("va", after.counted.va) : "").toBe("2,500 VA");
  });
});
