/**
 * @jest-environment node
 *
 * Allocated vs actual as schedule columns (Product decision, Oct 27, decision 4: shown
 * everywhere a total is shown). A space list, a zone list and a panel list
 * read the estimate, the devices so far and what counts, per quantity, with
 * typed units; a load list reads each load's stage and status. The columns
 * read one requirements engine per model state, carried from commit to
 * commit by the changed ids, never rebuilt from every load after an edit.
 *
 * On the old code none of these fields exist (`registry.field` is undefined,
 * every read below is null), no engine is carried (`requirementsEngineStats`
 * has no carries), and a zone that gains a space never re-claims the devices
 * in it (the zone case reads devices 0 while a fresh engine reads 900 VA).
 */
import {
  DEFAULT_SETTINGS,
  LOADS_FIELD_PROVIDER,
  RequirementsEngine,
  applyChangeset,
  asElementId,
  canonicalJson,
  buildClassIndex,
  fieldProviderRegistry,
  fixedSpaceLocator,
  freezeElements,
  modelSpaceLocator,
  planCommit,
  requirementsEngineOf,
  requirementsEngineStats,
  type BimElement,
  type Changeset,
  type Command,
  type FieldValue,
  type LoadPointElement,
  type ModelState,
  type PartTypeDefinition,
  type Space,
  type Zone,
} from "../src";
import { distributionType } from "./fixtures/electrical-building";

const NOW = () => "2026-10-27T21:00:00.000Z";

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

const box = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const space = (id: string, number: string, name: string, outline: ReturnType<typeof box>): Space => ({
  id: asElementId(id),
  kind: "space",
  version: 1,
  authoredRev: {},
  number,
  name,
  levelId: asElementId("lvl-1"),
  bounds: { kind: "outline", outline },
  origin: { kind: "drawn" },
});

class Model {
  head: ModelState;
  private readonly log: Changeset[] = [];
  private seq = 0;
  constructor(initial: readonly BimElement[]) {
    this.head = { modelId: "cols", revision: 0 as ModelState["revision"], elements: Object.fromEntries(initial.map((s) => [s.id, s])), connections: [], settings: DEFAULT_SETTINGS };
  }
  ok(command: Command): void {
    const d = planCommit(this.head, [], { idempotencyKey: `cols-${++this.seq}`, baseRevision: this.head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW, this.log);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
    this.head = d.model;
    this.log.push(d.changeset);
  }
}

/** Kitchen x 0–9 m, Dining x 0–9 m above it; the rooftop units stand outside both. */
function restaurant(): Model {
  const m = new Model([space("sp-kitchen", "101", "Kitchen", box(0, -3000, 9000, 3000)), space("sp-dining", "102", "Dining", box(0, 3000, 9000, 9000))]);
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "place_part", partId: "mdp", typeId: "type-mdp", partType: distributionType("Panelboard", "400 A 120/240 V", 240, "1", 42, 400, "400 A main"), levelId: "lvl-1", position: { x: 20000, y: 0 }, mark: "MDP", values: { panel_name: "MDP" } });
  const places: Array<readonly [string, number, number]> = [["fryer", 2000, 0], ["oven", 4000, 0], ["rtu-1", 15000, 0]];
  places.forEach(([id, x, y], i) => m.ok({ type: "place_part", partId: id, typeId: "type-equip", ...(i === 0 ? { partType: EQUIPMENT } : {}), levelId: "lvl-1", position: { x, y }, mark: id.toUpperCase() }));
  for (const [designator, loadClass] of [["E-LTG", "lighting"], ["E-REC", "receptacle"], ["E-KIT", "kitchen"], ["E-HVAC", "hvac"]] as const) m.ok({ type: "save_connection_type", entry: { designator, loadClass } });
  m.ok({
    type: "create_load",
    loads: [
      { id: "est-ltg", anchor: { kind: "space", id: "sp-kitchen" }, connectionType: "E-LTG", values: { va: 5000 }, servedBy: "mdp" },
      { id: "est-rec", anchor: { kind: "space", id: "sp-dining" }, connectionType: "E-REC", values: { va: 2000 }, servedBy: "mdp" },
      { id: "dev-fryer", anchor: { kind: "part", partId: "fryer" }, connectionType: "E-KIT", values: { va: 15000 }, servedBy: "mdp" },
      { id: "dev-oven", anchor: { kind: "part", partId: "oven" }, connectionType: "E-KIT", values: { va: 20000 }, servedBy: "mdp" },
      { id: "dev-rtu-1", anchor: { kind: "part", partId: "rtu-1" }, connectionType: "E-HVAC", values: { va: 12500 }, servedBy: "mdp" },
    ],
  });
  return m;
}

const registry = fieldProviderRegistry();

/** A column as a schedule reads it: the element's classes, the field, its reader. */
function cell(m: ModelState, id: string, path: string): FieldValue {
  const el = m.elements[id];
  if (!el) throw new Error(`no ${id}`);
  for (const cls of buildClassIndex(registry, m).classesOf(el.id)) {
    const f = registry.field(cls, path);
    if (f?.read) return f.read(el, { elements: m.elements });
  }
  return null;
}

describe("load columns: allocated vs actual on spaces, panels and loads", () => {
  it("registers each quantity in its trade's group with a typed unit", () => {
    const va = registry.field("gen.space", "loads.allocated.va");
    expect(va).toMatchObject({ label: "Estimate: electrical load", valueType: "quantity", kind: "power_apparent", unit: "VA", group: "Loads · Electrical" });
    expect(registry.field("gen.zone", "loads.actual.dfu")).toMatchObject({ kind: "fixture_units_drainage", unit: "DFU", group: "Loads · Drainage" });
    expect(registry.field("mep.electrical_equipment", "loads.counted.mbh")).toMatchObject({ kind: "flow_gas_energy", group: "Loads · Gas" });
    expect(registry.field("mep.load_point", "load.stage")?.choices).toEqual(["Estimate", "Load point", "Device"]);
    expect(LOADS_FIELD_PROVIDER.fields?.some((f) => f.path === "loads.allocated.min_inlet_pressure")).toBe(false);
  });

  it("a space list: Dining's estimate with no devices yet, then a receptacle below it, then one above it", () => {
    const m = restaurant();
    expect(cell(m.head, "sp-dining", "loads.allocated.va")).toBe(2000);
    expect(cell(m.head, "sp-dining", "loads.actual.va")).toBeNull();
    expect(cell(m.head, "sp-dining", "loads.counted.va")).toBe(2000);
    // The fryer and oven are kitchen equipment, not lighting: they count as themselves beside the 5 kW lighting estimate.
    expect(cell(m.head, "sp-kitchen", "loads.allocated.va")).toBe(5000);
    expect(cell(m.head, "sp-kitchen", "loads.actual.va")).toBe(35000);
    expect(cell(m.head, "sp-kitchen", "loads.counted.va")).toBe(40000);

    m.ok({ type: "place_part", partId: "rec", typeId: "type-equip", levelId: "lvl-1", position: { x: 1000, y: 5000 }, mark: "REC-1" });
    m.ok({ type: "create_load", loads: [{ id: "dev-rec", anchor: { kind: "part", partId: "rec" }, connectionType: "E-REC", values: { va: 800 }, servedBy: "mdp" }] });
    expect(cell(m.head, "sp-dining", "loads.actual.va")).toBe(800);
    expect(cell(m.head, "sp-dining", "loads.counted.va")).toBe(2000);
    expect(cell(m.head, "sp-dining", "loads.estimate_vs_devices")).toBe("estimate 2,000 VA, devices so far 800 VA");

    m.ok({ type: "edit_load_point", loadId: "dev-rec", values: { va: 2500 } });
    expect(cell(m.head, "sp-dining", "loads.counted.va")).toBe(2500);
    expect(cell(m.head, "sp-dining", "loads.estimate_vs_devices")).toBe("devices 2,500 VA exceed the estimate 2,000 VA; the devices count");
    expect(cell(m.head, "est-rec", "loads.estimate_vs_devices")).toBe("devices 2,500 VA exceed the estimate 2,000 VA; the devices count");
  });

  it("a panel list: MDP's estimates, devices and the counted total (7 kW + 47.5 kW = 54.5 kW)", () => {
    const m = restaurant();
    expect(cell(m.head, "mdp", "loads.allocated.va")).toBe(7000);
    expect(cell(m.head, "mdp", "loads.actual.va")).toBe(47500);
    expect(cell(m.head, "mdp", "loads.counted.va")).toBe(54500);
    expect(cell(m.head, "mdp", "loads.estimate_vs_devices")).toBe("estimate 7,000 VA, devices so far 47,500 VA");
    // Equipment nobody names as a source: empty cells, never zeros standing in for "unknown".
    expect(cell(m.head, "fryer", "loads.counted.va")).toBeNull();
    expect(cell(m.head, "fryer", "loads.allocated.va")).toBeNull();
  });

  it("a load list: stage and status in operator words", () => {
    const m = restaurant();
    expect([cell(m.head, "est-rec", "load.stage"), cell(m.head, "est-rec", "load.status")]).toEqual(["Estimate", "Placed"]);
    expect([cell(m.head, "dev-fryer", "load.stage"), cell(m.head, "dev-fryer", "load.status")]).toEqual(["Device", "Attached to a device"]);
  });

  it("each commit carries the engine by its changed ids; the carried figures equal a fresh build", () => {
    const m = restaurant();
    expect(cell(m.head, "sp-dining", "loads.counted.va")).toBe(2000);
    expect(cell(m.head, "mdp", "loads.counted.va")).toBe(54500);
    const builds = requirementsEngineStats.builds;
    const carries = requirementsEngineStats.carries;
    m.ok({ type: "edit_load_point", loadId: "est-rec", values: { va: 3000 } });
    m.ok({ type: "edit_load_point", loadId: "dev-oven", values: { va: 22000 } });
    expect(cell(m.head, "sp-dining", "loads.counted.va")).toBe(3000);
    expect(cell(m.head, "sp-kitchen", "loads.actual.va")).toBe(37000);
    // The panel's remembered figures were forgotten for the loads that name it: 8 kW + 49.5 kW.
    expect([cell(m.head, "mdp", "loads.allocated.va"), cell(m.head, "mdp", "loads.actual.va"), cell(m.head, "mdp", "loads.counted.va")]).toEqual([8000, 49500, 57500]);
    expect(requirementsEngineStats.builds).toBe(builds);
    expect(requirementsEngineStats.carries).toBe(carries + 2);
    const carried = requirementsEngineOf(m.head.elements);
    for (const id of ["sp-kitchen", "sp-dining"]) {
      const rebuilt = new RequirementsEngine({ locator: modelSpaceLocator, policy: "max" }).scopeFigures(m.head, { kind: "space", id });
      expect(canonicalJson(carried.scopeFigures(m.head, { kind: "space", id }))).toBe(canonicalJson(rebuilt));
    }
  });
});

describe("a zone that gains or loses a space re-claims the devices standing in it", () => {
  const SP_A = asElementId("sp-a");
  const SP_B = asElementId("sp-b");
  const ZONE = asElementId("z-1");
  const zone = (spaceIds: readonly string[]): Zone => ({ id: ZONE, kind: "zone", version: 1, authoredRev: {}, name: "Zone 1", purpose: "electrical_load_region", spaceIds: spaceIds.map(asElementId) });
  const load = (id: string, rest: Omit<LoadPointElement, "id" | "kind" | "version" | "authoredRev" | "connectionType">): LoadPointElement => ({ id: asElementId(id), kind: "load_point", version: 1, authoredRev: {}, connectionType: "", ...rest });
  const estimate = load("est-zone", { anchor: { kind: "zone", id: ZONE }, values: { va: 1000 } });
  const device = load("dev-b", { anchor: { kind: "point", levelId: asElementId("lvl-1"), position: { x: 0, y: 0 } }, values: { va: 900 } });
  /** Device in space B; the zone lists whatever the zone record says. */
  const perRecord = (elements: Readonly<Record<string, BimElement>>) => {
    const z = elements[ZONE];
    return { ...fixedSpaceLocator({ zones: z?.kind === "zone" ? { [ZONE]: z.spaceIds } : {} }), spaceAt: () => SP_B };
  };
  const at = (rev: number, els: readonly BimElement[]): ModelState => ({ modelId: "z", revision: rev as ModelState["revision"], elements: freezeElements(Object.fromEntries(els.map((e) => [e.id, e]))), connections: [], settings: DEFAULT_SETTINGS });

  it("devices so far 900 VA once space B joins the zone", () => {
    const m0 = at(1, [zone([SP_A]), estimate, device]);
    const engine = new RequirementsEngine({ locator: perRecord });
    expect(engine.allocatedActual(m0, estimate.id)?.actual.va).toBe(0);
    const m1 = at(2, [zone([SP_A, SP_B]), estimate, device]);
    engine.advance(m1, [ZONE]);
    expect(engine.allocatedActual(m1, estimate.id)?.actual.va).toBe(900);
    expect(engine.counted(m1)).toEqual(new RequirementsEngine({ locator: perRecord }).counted(m1));
    expect(engine.scopeFigures(m1, { kind: "zone", id: ZONE })).toMatchObject({ estimateIds: [estimate.id], actualIds: [device.id] });
  });

  it("devices so far back to 0 once space B leaves the zone; the device counts as itself again", () => {
    const m0 = at(1, [zone([SP_A, SP_B]), estimate, device]);
    const engine = new RequirementsEngine({ locator: perRecord });
    expect(engine.counted(m0).va).toBe(1000);
    const m1 = at(2, [zone([SP_A]), estimate, device]);
    engine.advance(m1, [ZONE]);
    expect(engine.allocatedActual(m1, estimate.id)?.actual.va).toBe(0);
    expect(engine.counted(m1).va).toBe(1900);
    expect(engine.counted(m1)).toEqual(new RequirementsEngine({ locator: perRecord }).counted(m1));
  });
});
