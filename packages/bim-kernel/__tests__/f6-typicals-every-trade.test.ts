/**
 * @jest-environment node
 *
 * Typicals in every trade (ROADMAP F6). A typical bathroom repeated 24 times
 * counts 24 times wherever its total is taken from outside it — at the
 * building drain, the cold-water service, the hot riser, in the project's
 * counted total and at a house source — and once inside unit 001's own
 * space and at unit 001's own source. One load lifecycle, one quantity bag:
 * fixture units, gas input (MBH) and airflow (CFM) take the same path.
 *
 * Fails on the code before F6: typicals multiplied only in the electrical
 * engine, so the drain read 30 DFU (not 260), the project counted 8 DFU for the
 * unit (not 192), and a typical's copies changing moved nothing.
 */
import { builtinPartTypes, DEFAULT_SETTINGS, RequirementsEngine, allocate, asElementId, allocationPolicyOf, applyChangeset, canonicalJson, elementsOfKind, modelSpaceLocator, planCommit, requirementsEngineOf, sourceFiguresOf, type Changeset, type Command, type ModelState } from "../src";
import { PipeHydraulicsEngine, PlumbingNetworkEngine, type DrainageReport } from "@permitzip/bim-pack-plumbing";
import { STACK_TOTALS, stackLoadPointCommand, threeStoreyStack } from "./fixtures/three-storey-stack";

const HP = asElementId("hp");
const NOW = () => "2026-10-28T08:00:00.000Z";

class Model {
  head: ModelState = { modelId: "f6", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  readonly log: Changeset[] = [];
  private seq = 0;

  ok(command: Command): Changeset {
    const d = planCommit(this.head, [], { idempotencyKey: `f6-${++this.seq}`, baseRevision: this.head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW, this.log);
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    expect(canonicalJson(applyChangeset(this.head, d.changeset))).toBe(canonicalJson(d.model));
    this.head = d.model;
    this.log.push(d.changeset);
    return d.changeset;
  }
}

const changed = (cs: Changeset): string[] => [...cs.elements.map((e) => e.id), ...(cs.removedIds ?? [])];
const array = (count: number): Command => ({ type: "set_group_typical", groupId: "g-bath", mark: "001", array: { count, columns: 6, spacingMm: { x: 10_000, y: 0 } } });

/** The three-storey stack with Level 1's restroom (its branches, fittings and fixtures) in one group. */
function stackWithBathroom(): { m: Model; net: PlumbingNetworkEngine; step: (c: Command) => void } {
  const m = new Model();
  const b = threeStoreyStack();
  for (const c of b.setup) m.ok(c);
  m.ok(stackLoadPointCommand(b.points));
  const net = new PlumbingNetworkEngine();
  const step = (c: Command) => {
    const cs = m.ok(c);
    net.advance(m.head, changed(cs));
  };
  for (const s of ["sys-san", "sys-cw", "sys-hw"]) net.systemTotal(m.head, s);
  step({ type: "create_group", groupId: "g-bath", name: "Restroom 001" });
  step({ type: "assign_elements_to_group", ids: Object.keys(m.head.elements).filter((id) => /(^|:)(san|cw|hw)-L1/.test(id)), groupId: "g-bath" });
  return { m, net, step };
}

describe("pipe totals: a typical's branch counts once per instance where it joins the building's pipe", () => {
  it("×24 gives 24× DFU at the building drain and 24× WSFU at the service, 1× in unit 001's own branch", () => {
    const { m, net, step } = stackWithBathroom();
    // Grouping alone changes nothing: it is not a typical yet.
    expect(net.systemTotal(m.head, "sys-san")?.value).toBe(STACK_TOTALS.dfuBase);
    step(array(24));
    const per = STACK_TOTALS;
    expect(net.systemTotal(m.head, "sys-san")?.value).toBe(per.dfuPerFloor * 24 + per.dfuPerFloor * 2);
    expect(net.carries(m.head, "san-L1-s1")?.value).toBe(per.dfuPerFloor);
    expect(net.systemTotal(m.head, "sys-cw")?.value).toBe(per.cwPerFloor * 24 + per.cwPerFloor * 2);
    expect(net.systemTotal(m.head, "sys-hw")?.value).toBe(per.hwPerFloor * 24 + per.hwPerFloor * 2);
    // The pipe report (sizing) reads the same walk: the building drain sizes for 260 DFU.
    const report = new PipeHydraulicsEngine().report(m.head, "sys-san") as DrainageReport;
    expect(report.totalFixtureUnits).toBe(260);
  });

  it("the live engine rebuilds when the copies change (no edit to any pipe) and agrees with a fresh build", () => {
    const { m, net, step } = stackWithBathroom();
    step(array(24));
    expect(net.systemTotal(m.head, "sys-san")?.value).toBe(260);
    step(array(12));
    expect(net.systemTotal(m.head, "sys-san")?.value).toBe(10 * 12 + 20);
    expect(net.systemTotal(m.head, "sys-cw")?.value).toBe(new PlumbingNetworkEngine().systemTotal(m.head, "sys-cw")?.value);
    step({ type: "clear_group_typical", groupId: "g-bath" });
    expect(net.systemTotal(m.head, "sys-san")?.value).toBe(30);
  });

  it("a fixture's value changing inside the typical moves the drain by 24× its change, incrementally", () => {
    const { m, net, step } = stackWithBathroom();
    step(array(24));
    const before = net.stats.rebuilds;
    step({ type: "edit_load_point", loadId: "lp:san-L1-1-s1:start", values: { dfu: 6 } });
    // WC-FT is 4 DFU; now 6: +2 per instance.
    expect(net.systemTotal(m.head, "sys-san")?.value).toBe(260 + 2 * 24);
    expect(net.carries(m.head, "san-L1-s1")?.value).toBe(12);
    expect(net.stats.rebuilds).toBe(before);
    expect(new PlumbingNetworkEngine().systemTotal(m.head, "sys-san")?.value).toBe(308);
  });
});

/**
 * Unit 001's bathroom S1 (in the typical) with an estimate and devices, a
 * corridor S2 outside it, a house source HP outside the unit and the unit's
 * own source A001 inside it.
 */
function unitModel(): Model {
  const m = new Model();
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  const sq = (x: number) => [{ x, y: 0 }, { x: x + 3000, y: 0 }, { x: x + 3000, y: 3000 }, { x, y: 3000 }];
  m.ok({ type: "create_space", spaces: [{ spaceId: "s1", number: "001-B", name: "Bathroom 001", levelId: "lvl-1", outline: sq(0) }, { spaceId: "s2", number: "C1", name: "Corridor", levelId: "lvl-1", outline: sq(10_000) }] });
  const place = (partId: string, typeId: string, x: number, y: number, panel: string) => {
    const t = builtinPartTypes().find((p) => p.id === typeId);
    if (!t) throw new Error(`no starter type ${typeId}`);
    m.ok({ type: "place_part", partId, typeId, ...(m.head.elements[typeId] ? {} : { partType: t.definition }), levelId: "lvl-1", position: { x, y }, values: { panel_name: panel } });
  };
  place("hp", "builtin:panelboard-225@1", -5000, 0, "HP");
  place("a001", "builtin:panelboard-125-208-1ph@1", 2500, 2500, "A001");
  const at = (x: number, y = 1000) => ({ kind: "point" as const, levelId: "lvl-1", position: { x, y } });
  m.ok({
    type: "create_load",
    loads: [
      { id: "est-1", anchor: { kind: "space", id: "s1" }, values: { dfu: 8, wsfu_total: 10, mbh: 30, cfm: 50 }, servedBy: "hp" },
      { id: "lav-1", anchor: at(1000), values: { dfu: 3, wsfu_total: 2 }, servedBy: "hp" },
      { id: "fan-1", anchor: at(1500), values: { cfm: 20 }, servedBy: "hp" },
      { id: "own-1", anchor: at(2000), values: { dfu: 1 }, servedBy: "a001" },
      { id: "cor-1", anchor: at(11_000), values: { dfu: 2, wsfu_total: 1, mbh: 5 }, servedBy: "hp" },
    ],
  });
  m.ok({ type: "create_group", groupId: "g-001", name: "Unit 001" });
  m.ok({ type: "assign_elements_to_group", ids: ["s1", "est-1", "lav-1", "fan-1", "own-1", "a001"], groupId: "g-001" });
  return m;
}

const unitArray = (count: number): Command => ({ type: "set_group_typical", groupId: "g-001", mark: "001", array: { count, columns: 6, spacingMm: { x: 20_000, y: 0 } } });

/** The carried engine (each commit advances it) and one built fresh from the same record must agree. */
function bothEngines(m: Model) {
  const carried = requirementsEngineOf(m.head.elements);
  const fresh = new RequirementsEngine({ locator: modelSpaceLocator, policy: allocationPolicyOf(m.head.elements) });
  fresh.advance(m.head, []);
  return { carried, fresh };
}

describe("requirement totals: one load lifecycle, every quantity", () => {
  it("before it is a typical, unit 001 counts once everywhere", () => {
    const m = unitModel();
    const { carried } = bothEngines(m);
    // Estimate 8 DFU over S1, devices 3+1 under it: the estimate counts (max). Corridor 2.
    expect(carried.counted(m.head).dfu).toBe(10);
  });

  it("×24: the project counts the unit 24 times, unit 001's space once, per quantity", () => {
    const m = unitModel();
    requirementsEngineOf(m.head.elements).counted(m.head);
    m.ok(unitArray(24));
    const { carried, fresh } = bothEngines(m);
    for (const e of [carried, fresh]) {
      const c = e.counted(m.head);
      expect(c.dfu).toBe(8 * 24 + 2);
      expect(c.wsfu_total).toBe(10 * 24 + 1);
      expect(c.mbh).toBe(30 * 24 + 5);
      expect(c.cfm).toBe(50 * 24);
      const s1 = e.scopeFigures(m.head, { kind: "space", id: "s1" });
      expect([s1.allocated.dfu, s1.actual.dfu, s1.counted.dfu]).toEqual([8, 4, 8]);
      expect(s1.counted.cfm).toBe(50);
      // The estimate reads in unit 001's terms: "estimate 8 DFU, devices so far 4 DFU".
      expect(e.allocatedActual(m.head, "est-1")?.actual.dfu).toBe(4);
    }
    // A Loads list totals to the project figure: each row adds its share once per instance.
    const rows = elementsOfKind(m.head.elements, "load_point").reduce((sum, lp) => sum + (carried.countedOf(m.head, lp.id)?.dfu ?? 0), 0);
    expect(rows).toBe(8 * 24 + 2);
    // The batch form says the same.
    const batch = allocate(m.head.elements, elementsOfKind(m.head.elements, "load_point"), modelSpaceLocator(m.head.elements), "max");
    expect(batch.counted.dfu).toBe(8 * 24 + 2);
  });

  it("a house source counts each instance; the unit's own source counts its unit once", () => {
    const m = unitModel();
    m.ok(unitArray(24));
    const house = sourceFiguresOf(m.head.elements, HP);
    expect(house.counted.dfu).toBe(8 * 24 + 2);
    expect(house.counted.cfm).toBe(50 * 24);
    expect(house.allocated.dfu).toBe(8 * 24);
    expect(house.actual.dfu).toBe(3 * 24 + 2);
    const own = sourceFiguresOf(m.head.elements, asElementId("a001"));
    expect(own.counted.dfu).toBe(1);
  });

  it("devices that exceed the estimate count instead, once per instance; changing the copies re-counts without touching a load", () => {
    const m = unitModel();
    requirementsEngineOf(m.head.elements).counted(m.head);
    m.ok(unitArray(24));
    m.ok({ type: "create_load", loads: [{ id: "wc-1", anchor: { kind: "point", levelId: "lvl-1", position: { x: 500, y: 2000 } }, values: { dfu: 6 }, servedBy: "hp" }] });
    m.ok({ type: "assign_elements_to_group", ids: ["wc-1"], groupId: "g-001" });
    // Devices 3 + 1 + 6 = 10 > 8 per unit.
    expect(requirementsEngineOf(m.head.elements).counted(m.head).dfu).toBe(10 * 24 + 2);
    m.ok(unitArray(12));
    const { carried, fresh } = bothEngines(m);
    expect(carried.counted(m.head).dfu).toBe(10 * 12 + 2);
    expect(fresh.counted(m.head).dfu).toBe(10 * 12 + 2);
    // At HP: the devices it serves in S1 are 3 + 6 = 9 > 8 per unit.
    expect(sourceFiguresOf(m.head.elements, HP).counted.dfu).toBe(9 * 12 + 2);
  });
});

describe("estimate counting per space", () => {
  it("a space's own setting decides its estimates; others keep the model's", () => {
    const m = unitModel();
    m.ok({ type: "create_load", loads: [{ id: "wc-1", anchor: { kind: "point", levelId: "lvl-1", position: { x: 500, y: 2000 } }, values: { dfu: 6 } }, { id: "est-2", anchor: { kind: "space", id: "s2" }, values: { dfu: 5 } }] });
    const e = () => requirementsEngineOf(m.head.elements);
    e().counted(m.head);
    // Model default (max): S1 devices 10 > estimate 8 → 10; S2 estimate 5 > corridor 2 → 5.
    expect(e().counted(m.head).dfu).toBe(15);
    m.ok({ type: "edit_space", spaceId: "s1", estimateCounting: "allocation_only" });
    expect(e().counted(m.head).dfu).toBe(8 + 5);
    expect(e().scopeFigures(m.head, { kind: "space", id: "s1" }).counted.dfu).toBe(8);
    expect(e().allocatedActual(m.head, "est-1")?.governing.dfu).toBe("allocated");
    m.ok({ type: "edit_space", spaceId: "s1", estimateCounting: "actual_only" });
    expect(e().counted(m.head).dfu).toBe(10 + 5);
    m.ok({ type: "edit_space", spaceId: "s2", estimateCounting: "actual_only" });
    expect(e().counted(m.head).dfu).toBe(10 + 2);
    // Fresh build agrees with the carried engine.
    expect(bothEngines(m).fresh.counted(m.head).dfu).toBe(12);
    // Back to the model's setting.
    m.ok({ type: "edit_space", spaceId: "s1", estimateCounting: null });
    m.ok({ type: "edit_space", spaceId: "s2", estimateCounting: null });
    expect(e().counted(m.head).dfu).toBe(15);
    expect(m.head.elements["s1"]).not.toHaveProperty("estimateCounting");
  });

  it("the batch allocation and the sources read the same per-space setting", () => {
    const m = unitModel();
    m.ok({ type: "create_load", loads: [{ id: "wc-1", anchor: { kind: "point", levelId: "lvl-1", position: { x: 500, y: 2000 } }, values: { dfu: 6 }, servedBy: "hp" }] });
    expect(sourceFiguresOf(m.head.elements, HP).counted.dfu).toBe(9 + 2);
    m.ok({ type: "edit_space", spaceId: "s1", estimateCounting: "allocation_only" });
    expect(sourceFiguresOf(m.head.elements, HP).counted.dfu).toBe(8 + 2);
    const batch = allocate(m.head.elements, elementsOfKind(m.head.elements, "load_point"), modelSpaceLocator(m.head.elements), allocationPolicyOf(m.head.elements));
    expect(batch.counted.dfu).toBe(8 + 2);
  });
});
