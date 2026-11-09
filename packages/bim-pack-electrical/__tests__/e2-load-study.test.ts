/**
 * @jest-environment node
 *
 * ROADMAP E1, the electrical demo 1 on 7303 (7903 locally): the SD load study in the
 * model, before anything is drawn. A plan-only 400 A 120/240 V single-phase
 * service, the kitchen list and two rooftop units as planned items put on
 * circuits of their own, lighting 5 kW and receptacles 2 kW as estimates on
 * the Kitchen naming the service: the service reads 82 kW = 342 A against
 * 400 A in the electrical engine itself, so the Load summary block, the panel
 * schedule and the Service size check all say the same number.
 *
 * Before this change the electrical engine only counted circuits: the
 * estimates naming the service were left out (75 kW = 313 A here), and K-1
 * (208 V 3-phase) was refused as "no free 3-pole space left in its 30
 * circuits" on an empty panel.
 */
import { LOAD_SUMMARY_TEMPLATE, asElementId, blockFreshness, blockFreshnessLabel, blockHashInput, renderFieldBlock, type Command, type ParamDef, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { ElectricalLoadEngine, electricalDiagramGraph, panelSchedule, planDedicatedCircuits, planServiceLayout, CONNECTED_LOAD_ONLY } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const num = (name: string, label: string, unit: ParamDef["unit"]): ParamDef => ({ name, label, kind: "number", unit, min: 0 });

/** The shape the Equipment list gives every pasted row: no drawn connectors, the nameplate in values. */
const LISTED: PartTypeDefinition = {
  familyName: "Equipment, from an equipment list",
  typeName: "Listed item",
  category: "mechanical_equipment",
  typeParams: [],
  typeValues: {},
  instanceParams: [{ name: "description", label: "Description", kind: "text" }, num("voltage", "Voltage", "v"), num("phases", "Phases", "none"), num("load_va", "Load", "va"), { name: "load_class", label: "Load class", kind: "text" }],
  connectors: [],
  geometry: [{ kind: "box", center: [0, 0, 450], size: [600, 600, 900] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "equipment-list@1" },
};

/** The test fixture list: 50 kW of kitchen equipment, then RTU-1 and RTU-2 at 12.5 kW. */
const LIST: ReadonlyArray<readonly [mark: string, volts: number, phases: number, va: number, cls: string]> = [
  ["K-1", 208, 3, 15000, "kitchen"],
  ["K-2.1", 240, 1, 8000, "kitchen"],
  ["K-2.2", 240, 1, 8000, "kitchen"],
  ["K-3", 240, 1, 6000, "kitchen"],
  ["K-4", 240, 1, 5500, "kitchen"],
  ["K-5", 120, 1, 2000, "kitchen"],
  ["K-6", 240, 1, 3000, "kitchen"],
  ["K-7.1", 120, 1, 500, "kitchen"],
  ["K-7.2", 120, 1, 500, "kitchen"],
  ["K-8", 120, 1, 1500, "kitchen"],
  ["RTU-1", 240, 1, 12500, "hvac"],
  ["RTU-2", 240, 1, 12500, "hvac"],
];

const STANDARD = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100];
const breakerFor = (a: number) => STANDARD.find((r) => r >= a - 1e-9) ?? null;

function study() {
  const b = new Building();
  const layout = planServiceLayout(b.head, { levelId: "lvl-1", serviceA: 400, system: "120/240", meter: false, planOnly: true, equipment: [] });
  if (!layout.ok) throw new Error(layout.reason);
  b.ok(layout.command);
  const mdp = layout.items[0]?.partId ?? "";
  LIST.forEach(([mark, voltage, phases, load_va, load_class], i) =>
    b.ok({ type: "plan_part", partId: `item-${mark}`, typeId: "type:listed", ...(i === 0 ? { partType: LISTED } : {}), mark, values: { voltage, phases, load_va, load_class }, note: "From the equipment list" }),
  );
  b.ok({ type: "create_space", spaces: [{ spaceId: "sp-kitchen", number: "101", name: "Kitchen", levelId: "lvl-1", outline: [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 10000 }, { x: 0, y: 10000 }] }] } as Command);
  for (const [designator, loadClass] of [["E-LTG", "lighting"], ["E-REC", "receptacle"]] as const) b.ok({ type: "save_connection_type", entry: { designator, loadClass, description: designator } });
  b.ok({
    type: "create_load",
    loads: [
      { id: "est-ltg", anchor: { kind: "space", id: "sp-kitchen" }, connectionType: "E-LTG", values: { va: 5000 }, servedBy: mdp },
      { id: "est-rec", anchor: { kind: "space", id: "sp-kitchen" }, connectionType: "E-REC", values: { va: 2000 }, servedBy: mdp },
    ],
  } as Command);
  const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
  return { b, mdp, engine };
}

const ids = (marks: readonly string[]) => marks.map((m) => `item-${m}`);
const kw = (va: number) => Math.round(va) / 1000;

describe("E1: the SD load study from planned items and estimates", () => {
  it("each planned item goes on a circuit of its own, sized for its load; K-1 is refused for its voltage, in words", () => {
    const { b, mdp, engine } = study();
    const plan = planDedicatedCircuits(b.head, ids(LIST.map((r) => r[0])), mdp, { linkIdFor: (id) => `c-${id}`, engine, breakerFor });
    expect(plan.refused).toEqual([{ partId: "item-K-1", name: "K-1", reason: "K-1 needs 208 V 3-phase; MDP is 120/240 V 1-phase 3-wire, so it can't serve it" }]);
    expect(plan.circuits).toHaveLength(11);
    const fryer = plan.circuits.find((c) => c.name === "K-2.1");
    // 8,000 VA at 240 V = 33.3 A → 35 A, two poles; the RTU 12,500 VA = 52.1 A → 60 A.
    expect(fryer).toMatchObject({ poles: 2, va: 8000, breakerA: 35, planned: true });
    expect(plan.circuits.find((c) => c.name === "RTU-1")).toMatchObject({ poles: 2, breakerA: 60 });
    expect(plan.circuits.find((c) => c.name === "K-5")).toMatchObject({ poles: 1, breakerA: 20 });
    expect(plan.command?.type).toBe("batch_edits");
    if (!plan.command) throw new Error("a batch");
    b.ok(plan.command);
    const schedule = panelSchedule(b.head.elements, mdp);
    expect(schedule?.circuits.filter((c) => c.role === "branch")).toHaveLength(11);
    // No breaker below its load: no circuit_overloaded findings.
    expect(engine.report(b.head, asElementId(mdp))?.findings.filter((f) => f.kind === "circuit_overloaded")).toEqual([]);
  });

  it("the service reads 82 kW = 342 A at 240 V single-phase against 400 A once K-1 is fixed, the same in the Load summary block", () => {
    const { b, mdp, engine } = study();
    const first = planDedicatedCircuits(b.head, ids(LIST.map((r) => r[0])), mdp, { linkIdFor: (id) => `c-${id}`, engine, breakerFor });
    if (!first.command) throw new Error("a batch");
    b.ok(first.command);
    // With K-1 refused: 35 kW kitchen + 25 kW RTUs + 7 kW estimates. Old code: 60 kW (estimates left out).
    expect(kw(engine.report(b.head, asElementId(mdp))?.connectedVa ?? 0)).toBe(67);

    // The flag's fix: the dishwasher comes 240 V single-phase.
    b.ok({ type: "set_parameters", id: "item-K-1", scope: "instance", values: { voltage: 240, phases: 1 } });
    const k1 = planDedicatedCircuits(b.head, ["item-K-1"], mdp, { linkIdFor: (id) => `c-${id}`, engine, breakerFor });
    expect(k1.refused).toEqual([]);
    if (!k1.command) throw new Error("a batch");
    b.ok(k1.command);

    const report = engine.report(b.head, asElementId(mdp));
    if (!report) throw new Error("MDP report");
    expect(report.connectedVa).toBe(82000);
    // 82,000 / 240 = 341.67 A.
    expect(report.connectedA).toBeCloseTo(341.67, 2);
    expect(report.capacity.limitA).toBe(400);
    expect(report.findings.filter((f) => f.kind === "overloaded")).toEqual([]);
    expect(report.links.length).toBe(12);
    const block = renderFieldBlock(b.head, { template: LOAD_SUMMARY_TEMPLATE });
    expect(block.text.split("\n")[0]).toBe("Total connected 82.00 kVA = 342 A at 120/240V");
  });

  it("an estimate and the circuited device inside it count once; the engine follows each edit from its changed ids", () => {
    const { b, mdp, engine } = study();
    const plan = planDedicatedCircuits(b.head, ids(["K-2.1", "RTU-1"]), mdp, { linkIdFor: (id) => `c-${id}`, engine, breakerFor });
    if (!plan.command) throw new Error("a batch");
    b.ok(plan.command);
    // 8 + 12.5 on circuits, 5 + 2 estimated.
    expect(kw(engine.report(b.head, asElementId(mdp))?.connectedVa ?? 0)).toBe(27.5);

    // A real 1 kW light in the Kitchen, its load naming the service: it sits inside the 5 kW lighting estimate.
    b.place("lt-1", "light", { load_va: 1000, load_class: "lighting" }, "LT-1", { x: 5000, y: 5000 });
    engine.report(b.head, asElementId(mdp));
    let cs = b.ok({ type: "create_load", loads: [{ id: "dev-lt-1", anchor: { kind: "part", partId: "lt-1" }, connectionType: "E-LTG", values: { va: 1000 }, servedBy: mdp }] } as Command);
    engine.advance(b.head, cs.elements.map((e) => e.id));
    expect(kw(engine.report(b.head, asElementId(mdp))?.connectedVa ?? 0)).toBe(27.5);

    // Circuited: the circuit counts it, the estimate counts what is left of 5 kW. Still 27.5.
    const light = planDedicatedCircuits(b.head, ["lt-1"], mdp, { linkIdFor: (id) => `c-${id}`, engine, breakerFor });
    if (!light.command) throw new Error("a batch");
    cs = b.ok(light.command);
    engine.advance(b.head, cs.elements.map((e) => e.id));
    const after = engine.report(b.head, asElementId(mdp));
    expect(kw(after?.connectedVa ?? 0)).toBe(27.5);
    expect(after?.links.find((l) => l.linkId === "c-lt-1")?.inventory.va).toBe(1000);

    // The estimate goes up to 7 kW: only its record changed, and the service follows.
    cs = b.ok({ type: "edit_load_point", loadId: "est-ltg", values: { va: 7000 } } as Command);
    engine.advance(b.head, cs.elements.map((e) => e.id));
    expect(kw(engine.report(b.head, asElementId(mdp))?.connectedVa ?? 0)).toBe(29.5);
  });

  it("the SD issue freezes 82 kW = 342 A; a circuit change after it reads Changed since SD issue; the one-line marks planned loads", () => {
    const { b, mdp, engine } = study();
    b.ok({ type: "set_parameters", id: "item-K-1", scope: "instance", values: { voltage: 240, phases: 1 } });
    const plan = planDedicatedCircuits(b.head, ids(LIST.map((r) => r[0])), mdp, { linkIdFor: (id) => `c-${id}`, engine, breakerFor });
    if (!plan.command) throw new Error("a batch");
    b.ok(plan.command);
    const issued = blockHashInput(renderFieldBlock(b.head, { template: LOAD_SUMMARY_TEMPLATE }));
    expect(blockFreshnessLabel(blockFreshness(issued, { valueHash: issued }, "SD"))).toBe("Matches SD issue");

    // RTU-2 comes off its circuit after the issue: 82 − 12.5 = 69.5 kW = 290 A.
    b.ok({ type: "remove_link_members", linkId: "c-item-RTU-2", elementIds: ["item-RTU-2"] });
    const live = renderFieldBlock(b.head, { template: LOAD_SUMMARY_TEMPLATE });
    expect(live.text.split("\n")[0]).toBe("Total connected 69.50 kVA = 290 A at 120/240V");
    expect(live.dependsOn).toContain("c-item-RTU-2");
    expect(blockFreshnessLabel(blockFreshness(blockHashInput(live), { valueHash: issued }, "SD"))).toBe("Changed since SD issue");

    // The one-line draws the planned loads under the MDP, dashed and marked, with their circuit.
    const graph = electricalDiagramGraph(b.head.elements, { showLoads: true });
    const rtu1 = graph.roots.flatMap((r) => r.children).find((n) => n.elementId === "item-RTU-1");
    expect(rtu1?.planned).toBe(true);
    expect(rtu1?.lines.map((l) => l.text)).toEqual(expect.arrayContaining(["RTU-1", "NOT PLACED"]));
    expect(rtu1?.feed?.deviceLabel).toBe("60A/2P");
  });

  it("models with no loads naming a panel read exactly as before", () => {
    const { b, mdp, engine } = study();
    b.ok({ type: "delete_elements", ids: ["est-ltg", "est-rec"], policy: "refuse" } as Command);
    const report = engine.report(b.head, asElementId(mdp));
    expect(report?.connectedVa).toBe(0);
    expect(engine.loads(b.head, mdp)?.estimates).toBeUndefined();
  });
});
