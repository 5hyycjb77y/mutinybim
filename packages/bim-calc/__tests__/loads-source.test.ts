/**
 * @jest-environment node
 *
 * Load totals by source before anything is drawn (ROADMAP F2 / P1): the grease
 * interceptor's sizing calc takes the rows that name it as source, and a
 * panel's connected load reads in amps at its voltage.
 *
 * Golden: 7329 Corner Cafe grease interceptor sizing detail (Plumbing Demo 1,
 * frame f_0013): three-compartment sink 28" × 20" × 14", 3 bowls = 23,520 in³;
 * 0.75 × 23,520 / 231 = 76.36 gpm at a 1-minute drain-down.
 */
import { DEFAULT_SETTINGS, applyChangeset, builtinPartType, planCommit, type Changeset, type Command, type ModelState, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { builtinCalcRegistry } from "../src";
import { greaseInterceptorFixtures, sourceLoad } from "../src/loads/source-load";

const NOW = () => "2026-10-27T20:00:00.000Z";

class Model {
  head: ModelState = { modelId: "src", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  private readonly log: Changeset[] = [];
  private seq = 0;
  ok(command: Command): void {
    const d = planCommit(this.head, [], { idempotencyKey: `src-${++this.seq}`, baseRevision: this.head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW, this.log);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    expect(applyChangeset(this.head, d.changeset).revision).toBe(d.model.revision);
    this.head = d.model;
    this.log.push(d.changeset);
  }
}

const PANEL: PartTypeDefinition = {
  familyName: "Panelboard",
  typeName: "400 A 120/240 V",
  category: "electrical_equipment",
  typeParams: [
    { name: "voltage", label: "Voltage", kind: "number", unit: "v", min: 0 },
    { name: "phases", label: "Phases", kind: "choice", choices: ["1", "3"] },
    { name: "circuits", label: "Circuits", kind: "number", unit: "count", min: 0 },
  ],
  typeValues: { voltage: 240, phases: "1", circuits: 42 },
  instanceParams: [{ name: "panel_name", label: "Panel name", kind: "text" }],
  connectors: [{ id: "feeder", label: "Power", domain: "electrical", systemKind: "power", position: [0, 0, 300], direction: [0, 0, 1], shape: "none", voltage: { param: "voltage" }, poles: 2 }],
  geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 300, 600] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 300] }],
  tagFields: ["panel_name"],
  source: { kind: "builtin", libraryVersion: "test" },
};

describe("load totals by source", () => {
  it("a sink row served by GI-1 is in GI-1's sizing calc: 76.36 gpm, as the 7329 sheet", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    const gi = builtinPartType("builtin:plumbing-grease-interceptor@1");
    if (!gi) throw new Error("starter GI exists");
    m.ok({ type: "place_part", partId: "gi-1", typeId: gi.id, partType: gi.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "GI-1" });
    const bowl = [
      { name: "Compartment length", unit: "in", value: 28 },
      { name: "Compartment width", unit: "in", value: 20 },
      { name: "Compartment depth", unit: "in", value: 14 },
      { name: "Compartments", unit: "", value: 3 },
    ];
    m.ok({ type: "create_load", loads: [{ id: "load-P434A-1", mark: "P434A-1", note: "Three compartment sink", values: { wsfu_cold: 3, wsfu_hot: 3, wsfu_total: 4, dfu: 3, gph_demand: 90, custom: bowl }, servedBy: "gi-1" }, { id: "load-FS3-1", mark: "FS3-1", values: { dfu: 5 }, servedBy: "gi-1" }] });
    const input = greaseInterceptorFixtures(m.head, "gi-1");
    expect(input.fixtures).toEqual([{ label: "P434A-1", quantity: 1, length_in: 28, width_in: 20, depth_in: 14, compartments: 3 }]);
    expect(input.missing).toEqual(["FS3-1"]);
    const r = builtinCalcRegistry().run({ calc: "plumbing.grease_interceptor", inputs: { fixtures: input.fixtures, drain_down_min: 1 }, state: "VA" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.run.values.find((v) => v.key === "required_gpm")?.value).toBe(76.4);
    expect(r.run.detail).toMatchObject({ requiredGpm: expect.closeTo(76.36, 2) });
  });

  it("a panel's connected load from the loads that name it, in amps at its voltage", () => {
    const m = new Model();
    m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok({ type: "place_part", partId: "mdp", typeId: "type-mdp", partType: PANEL, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "MDP", values: { panel_name: "MDP" } });
    m.ok({ type: "create_load", loads: [{ id: "l-kitchen", values: { va: 57000 }, servedBy: "mdp" }, { id: "l-rtus", values: { va: 25000 }, servedBy: "mdp" }] });
    const s = sourceLoad(m.head, "mdp");
    expect([s.name, s.counted.va, s.voltageV, s.phases, s.amps, s.policy]).toEqual(["MDP", 82000, 240, 1, 342, "max"]);
  });
});
