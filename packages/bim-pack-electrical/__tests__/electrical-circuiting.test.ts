/**
 * @jest-environment node
 *
 * WS-C circuiting: phase-balanced slot choice, re-slotting several circuits at
 * once, deterministic rebalancing, the electrical catalog (connection types,
 * feeder types, room templates), equipment connections from mechanical
 * nameplates, and the Check list. The reference building is the analysis's
 * "small commercial building" (fixtures/electrical-building.ts).
 */
import { builtinPartType, catalogElementId, connectionTypes, executeCommand, partTypeIssues, resolveField, type Command, type ConnectionTypeEntry, type ModelState, type PartTypeDefinition, type Room } from "@permitzip/bim-kernel";
import { feederTypeText, feederTypes, linkConstruction, type CircuitTemplateEntry, type FeederTypeEntry } from "../src/catalog";
import { CONNECTED_LOAD_ONLY, ElectricalLoadEngine, distributionOf, electricalCheck, electricalDiagramGraph, equipmentConnectionOf, feederTypeInfoOf, panelSchedule, phaseState, planCircuitTemplate, planRebalance, suggestUnits, uncircuitedLoads, type ElectricalRules } from "@permitzip/bim-pack-electrical";
import { Building, referenceBuilding, referenceDistribution } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const positionsOf = (b: Building, id: string) => {
  const l = b.el(id);
  if (l.kind !== "service_link") throw new Error(`${id} is not a link`);
  return [...l.source.positions];
};

const E05: ConnectionTypeEntry = { type: "connection_type", designator: "E.05", description: "Reach-in freezer", connection: "5-20R receptacle", loadVa: 1320, voltage: 120, poles: 1, loadClass: "kitchen", continuous: false, comments: "" };

const F225: FeederTypeEntry = {
  type: "feeder_type",
  mark: "F225",
  ratingA: 225,
  poles: 3,
  conductors: { sets: 1, phaseSize: "4/0", neutralSize: "4/0", groundSize: "4", material: "cu" },
  insulation: "THHN",
  conduit: { type: "emt", tradeSize: "2-1/2" },
  conduitBelowGrade: null,
  description: "",
};

describe("auto-next-slot balances the phases", () => {
  it("spreads equal one-pole circuits A, B, C, then back to A (1, 3, 5, 2) and does it the same way every time", () => {
    const run = () => {
      const b = referenceDistribution();
      const out: number[][] = [];
      for (let i = 1; i <= 4; i++) {
        b.place(`r${i}`, "receptacle", { voltage: 120, load_va: 180 });
        b.ok({ type: "create_service_link", linkId: `c${i}`, sourceId: "l1", members: [{ elementId: `r${i}` }] });
        out.push(positionsOf(b, `c${i}`));
      }
      return out;
    };
    expect(run()).toEqual([[1], [3], [5], [2]]);
    expect(run()).toEqual(run());
  });

  it("puts a new load on the lightest phase, not the lowest free slot", () => {
    const b = referenceDistribution();
    b.place("heavy", "receptacle", { voltage: 120, load_va: 1500 });
    b.place("mid", "receptacle", { voltage: 120, load_va: 900 });
    b.place("next", "receptacle", { voltage: 120, load_va: 180 });
    b.ok({ type: "create_service_link", linkId: "c-heavy", sourceId: "l1", positions: [1], members: [{ elementId: "heavy" }] });
    b.ok({ type: "create_service_link", linkId: "c-mid", sourceId: "l1", positions: [3], members: [{ elementId: "mid" }] });
    b.ok({ type: "create_service_link", linkId: "c-next", sourceId: "l1", members: [{ elementId: "next" }] });
    // A 1,500, B 900, C 0: slot 5 is C. Lowest-free would have taken 2 (phase A).
    expect(positionsOf(b, "c-next")).toEqual([5]);
    expect(phaseState(b.head.elements, "l1")?.va).toEqual([1500, 900, 180]);
  });

  it("a two-pole load avoids the phases already carrying one", () => {
    const b = referenceDistribution();
    b.place("wh1", "equip2", { voltage: 208, load_va: 4500 });
    b.place("wh2", "equip2", { voltage: 208, load_va: 4500 });
    b.ok({ type: "create_service_link", linkId: "c-wh1", sourceId: "l1", members: [{ elementId: "wh1" }] });
    b.ok({ type: "create_service_link", linkId: "c-wh2", sourceId: "l1", members: [{ elementId: "wh2" }] });
    expect(positionsOf(b, "c-wh1")).toEqual([1, 3]);
    expect(positionsOf(b, "c-wh2")).toEqual([4, 6]);
    b.valid();
  });

  it("explicit slots still win, and a full panel still refuses in plain words", () => {
    const b = referenceDistribution();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 });
    b.ok({ type: "create_service_link", linkId: "c1", sourceId: "l1", positions: [40], members: [{ elementId: "r1" }] });
    expect(positionsOf(b, "c1")).toEqual([40]);
  });
});

describe("reposition_service_links", () => {
  it("swaps two circuits in one edit, which moving them one at a time can't", () => {
    const b = referenceBuilding();
    b.ok({ type: "reposition_service_links", sourceId: "l1", moves: [{ linkId: "c-off1", positions: [3] }, { linkId: "c-off2", positions: [1] }] });
    expect(positionsOf(b, "c-off1")).toEqual([3]);
    expect(positionsOf(b, "c-off2")).toEqual([1]);
    b.valid();
  });

  it("refuses a result where two circuits share a slot, or a breaker changes its number of poles", () => {
    const b = referenceBuilding();
    expect(b.refused({ type: "reposition_service_links", sourceId: "l1", moves: [{ linkId: "c-off1", positions: [5] }] })).toMatch(/Circuit 5 on L1 would hold both L1-1 and L1-5/);
    expect(b.refused({ type: "reposition_service_links", sourceId: "l1", moves: [{ linkId: "c-wh1", positions: [17] }] })).toMatch(/takes 2 positions, not 1/);
  });
});

describe("rebalance panel", () => {
  function lopsided(): Building {
    const b = referenceDistribution();
    // Everything on phase A: slots 1, 2, 7, 8 (rows 1 and 4).
    [1, 2, 7, 8].forEach((slot, i) => {
      b.place(`r${i}`, "receptacle", { voltage: 120, load_va: 1000 + 100 * i });
      b.ok({ type: "create_service_link", linkId: `c${i}`, sourceId: "l1", positions: [slot], members: [{ elementId: `r${i}` }], description: `Load ${i}` });
    });
    return b;
  }

  it("proposes moves that even the phases, and the same model gives the same moves", () => {
    const b = lopsided();
    const plan = planRebalance(b.head.elements, "l1");
    expect(plan?.before.map((p) => p.va)).toEqual([4600, 0, 0]);
    expect(plan?.moves.length).toBeGreaterThan(0);
    expect(plan?.spreadAfter).toBeLessThan(plan?.spreadBefore ?? 0);
    expect(plan?.spreadAfter).toBeLessThanOrEqual(1300);
    expect(planRebalance(b.head.elements, "l1")).toEqual(plan);
    expect(plan?.message).toMatch(/^Move \d circuits? on L1: the spread between phases goes from 4,600 VA to/);
  });

  it("applying the plan gives exactly the per-phase loads it previewed, read by the engine", () => {
    const b = lopsided();
    const plan = planRebalance(b.head.elements, "l1");
    if (!plan?.command) throw new Error("expected moves");
    b.ok(plan.command);
    const report = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).report(b.head, "l1");
    expect(report?.perPhase.map((p) => Math.round(p.va))).toEqual(plan.after.map((p) => Math.round(p.va)));
    expect(planRebalance(b.head.elements, "l1")?.moves).toEqual([]);
    b.valid();
  });

  it("leaves circuits the engineer keeps, and three-pole breakers, where they are", () => {
    const b = lopsided();
    b.place("rtu", "mech3", { voltage: 208, load_va: 9000 });
    b.ok({ type: "create_service_link", linkId: "c-rtu", sourceId: "l1", members: [{ elementId: "rtu" }] });
    const plan = planRebalance(b.head.elements, "l1", { keep: ["c0", "c1"] });
    const moved = plan?.moves.map((m) => m.linkId) ?? [];
    expect(moved).not.toContain("c0");
    expect(moved).not.toContain("c1");
    expect(moved).not.toContain("c-rtu");
  });

  it("says so when the phases are already even", () => {
    const b = referenceDistribution();
    expect(planRebalance(b.head.elements, "l1")?.message).toBe("L1's phases are already even.");
    expect(planRebalance(b.head.elements, "l1")?.command).toBeNull();
  });
});

describe("connection types", () => {
  it("a device naming E.05 takes its load, class and voltage from the record; editing the record updates every device", () => {
    const b = referenceDistribution();
    b.ok({ type: "save_catalog_entry", entry: E05 });
    b.place("frz", "receptacle", { voltage: 120, load_va: 0, connection_type: "E.05" }, "FRZ-1");
    b.ok({ type: "create_service_link", linkId: "c-frz", sourceId: "l1", members: [{ elementId: "frz" }] });
    const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    const member = engine.report(b.head, "l1")?.links.find((l) => l.linkId === "c-frz")?.members[0];
    expect(member).toMatchObject({ va: 1320, loadClass: "kitchen", from: "connection_type", classFrom: "connection_type", connectionType: "E.05" });
    const prev = b.head;
    const cs = b.ok({ type: "save_catalog_entry", entry: { ...E05, loadVa: 1500 } });
    engine.advance(b.head, cs.elements.map((e) => e.id));
    expect(prev).not.toBe(b.head);
    expect(engine.report(b.head, "l1")?.connectedVa).toBe(1500);
    expect(engine.report(b.head, "mdp")?.connectedVa).toBe(1500);
    expect(connectionTypes(b.head).map((r) => r.entry.designator)).toEqual(["E.05"]);
  });

  it("refuses deleting a record devices use, and renaming carries the devices along", () => {
    const b = referenceDistribution();
    b.ok({ type: "save_catalog_entry", entry: E05 });
    b.place("frz", "receptacle", { voltage: 120, connection_type: "E.05" }, "FRZ-1");
    expect(b.refused({ type: "delete_catalog_entry", entryType: "connection_type", name: "E.05" })).toBe("Connection type E.05 is used by FRZ-1; change it first");
    b.ok({ type: "save_catalog_entry", entry: { ...E05, designator: "E.06" }, replaces: "e.05" });
    const frz = b.el("frz");
    expect(frz.kind === "part" && frz.values.connection_type).toBe("E.06");
    expect(b.head.elements[catalogElementId("connection_type", "E.05")]).toBeUndefined();
    b.ok({ type: "save_catalog_entry", entry: { ...E05, designator: "E.06" } });
    b.valid();
  });

  it("refuses a device's connection type voltage that the panel can't serve, naming both", () => {
    const b = referenceDistribution();
    b.ok({ type: "save_catalog_entry", entry: { ...E05, designator: "M.01", voltage: 480, poles: 3, loadClass: "motor", loadVa: 10000 } });
    b.place("mua", "receptacle", { connection_type: "M.01" }, "MUA-1");
    expect(b.refused({ type: "create_service_link", linkId: "c-mua", sourceId: "l1", members: [{ elementId: "mua" }] })).toBe("MUA-1 needs 480 V 3-phase; L1 is 120/208 V 3-phase 4-wire, so it can't serve it");
  });

  it("a motor connection type with horsepower and no VA counts what the rules' motor tables say", () => {
    const b = referenceDistribution();
    b.ok({ type: "save_catalog_entry", entry: { ...E05, designator: "M.10", loadVa: 0, motorHp: 10, voltage: 480, poles: 3, loadClass: "motor" } });
    b.place("pump", "mech3", { voltage: 480, connection_type: "M.10" }, "P-1");
    b.ok({ type: "create_service_link", linkId: "c-p", sourceId: "h1", members: [{ elementId: "pump" }] });
    const rules: ElectricalRules = { ...CONNECTED_LOAD_ONLY, motorLoad: (hp, volts, poles) => ({ va: hp * 1000 + volts + poles, text: "table", cite: ["Table 430.250"] }) };
    const m = new ElectricalLoadEngine(rules).report(b.head, "h1")?.links.find((l) => l.linkId === "c-p")?.members[0];
    expect(m).toMatchObject({ va: 10_483, from: "motor_table", loadClass: "motor", basis: { text: "table", cite: ["Table 430.250"] } });
  });
});

describe("feeder types", () => {
  it("a feeder naming F225 gets its conductors from the catalog, which set a capacity limit; editing F225 updates the report", () => {
    const b = referenceDistribution();
    b.ok({ type: "save_catalog_entry", entry: F225 });
    const engine = new ElectricalLoadEngine({ ...CONNECTED_LOAD_ONLY, conductorAmpacity: (c) => ({ amps: c.phaseSize === "4/0" ? 230 : 120, basis: "test", cite: [] }) });
    const h1 = engine.report(b.head, "h1");
    expect(h1?.supplyFrom).toMatchObject({ feederType: "F225", conductors: F225.conductors, text: "MDP via 225 A 3-pole breaker (F225)" });
    expect(h1?.capacity.limits.find((l) => l.kind === "feeder_conductors")?.amps).toBe(230);
    const link = b.el("f-h1");
    expect(link.kind === "service_link" && linkConstruction(b.head.elements, link).conductorsFrom).toBe("feeder_type");
    const cs = b.ok({ type: "save_catalog_entry", entry: { ...F225, conductors: { ...F225.conductors, phaseSize: "1/0" } } });
    engine.advance(b.head, cs.elements.map((e) => e.id));
    expect(engine.report(b.head, "h1")?.capacity.limits.find((l) => l.kind === "feeder_conductors")?.amps).toBe(120);
  });

  it("prints as a feeder schedule line and lists in natural order", () => {
    const b = referenceDistribution();
    b.ok({ type: "save_catalog_entry", entry: { ...F225, mark: "F1000", ratingA: 1000, conductors: { sets: 3, phaseSize: "400", neutralSize: "400", groundSize: "2/0", material: "cu" } } });
    b.ok({ type: "save_catalog_entry", entry: F225 });
    expect(feederTypes(b.head).map((r) => r.entry.mark)).toEqual(["F225", "F1000"]);
    expect(feederTypeText(F225)).toBe("225 A 3P; 3-#4/0, 1-#4/0 N, 1-#4 EGC Cu THHN in 2-1/2 in EMT");
    expect(feederTypeText({ ...F225, conductors: { sets: 3, phaseSize: "400", neutralSize: "400", groundSize: "2/0", material: "cu" } })).toBe("225 A 3P; (3) sets of 3-400 kcmil, 1-400 kcmil N, 1-#2/0 EGC Cu THHN in 2-1/2 in EMT each");
  });

  it("finds a feeder naming a mark the catalog lacks, and a breaker that doesn't match its feeder type", () => {
    const b = referenceDistribution();
    b.ok({ type: "save_catalog_entry", entry: F225 });
    b.ok({ type: "edit_service_link", linkId: "f-h1", electrical: { ratingA: 200 } });
    const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    expect(engine.report(b.head, "h1")?.findings.map((f) => f.kind)).toContain("feeder_type_mismatch");
    expect(engine.report(b.head, "t1")?.findings.find((f) => f.kind === "missing_feeder_type")?.message).toBe("MDP-2,4,6 names feeder type F100T, which isn't in the project's feeder types; add it or pick another");
    expect(b.refused({ type: "delete_catalog_entry", entryType: "feeder_type", name: "F225" })).toBe("Feeder type F225 is used by MDP-1,3,5; change it first");
  });
});

describe("equipment connections from mechanical nameplates", () => {
  const CUT_SHEET_RTU: PartTypeDefinition = {
    familyName: "Rooftop unit",
    typeName: "From a cut sheet",
    category: "mechanical_equipment",
    typeParams: [
      { name: "voltage", label: "Voltage", kind: "number", unit: "v" },
      { name: "phase", label: "Phase", kind: "number", unit: "count" },
      { name: "mca", label: "MCA", kind: "number", unit: "a" },
      { name: "mop", label: "MOP", kind: "number", unit: "a" },
    ],
    typeValues: { voltage: 460, phase: 3, mca: 32.5, mop: 45 },
    instanceParams: [],
    connectors: [],
    geometry: [{ kind: "box", center: [0, 0, 500], size: [1000, 1000, 1000] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [1000, 1000] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "test" },
  };

  it("equipment with a nameplate but no drawn connector is circuited like a hardwired connection: 3 poles, MOP breaker, MCA load", () => {
    const b = referenceDistribution();
    b.ok({ type: "place_part", partId: "rtu", typeId: "type-cs-rtu", partType: CUT_SHEET_RTU, levelId: "lvl-1", position: { x: 9000, y: 9000 }, mark: "RTU-3", values: {} });
    b.ok({ type: "create_service_link", linkId: "c-rtu", sourceId: "h1", members: [{ elementId: "rtu" }] });
    expect(panelSchedule(b.head.elements, "h1")?.circuits[0]).toMatchObject({ name: "H1-1,3,5", poles: 3, ratingA: 45 });
    const m = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).report(b.head, "h1")?.links[0]?.members[0];
    expect(m?.from).toBe("mca");
    expect(m?.va).toBeCloseTo(32.5 * 460 * Math.sqrt(3), 6);
    expect(equipmentConnectionOf(b.head.elements, "rtu")).toMatchObject({ connector: "power", voltage: 460, poles: 3, nameplate: { mcaA: 32.5, mocpA: 45, phases: 3 }, circuit: { name: "H1-1,3,5", ratingA: 45 } });
    expect(b.refused({ type: "create_service_link", linkId: "c-rtu-l1", sourceId: "l1", members: [{ elementId: "rtu" }] })).toMatch(/is already on H1-1,3,5/);
  });

  it("flags a breaker above the nameplate's maximum overcurrent protection, and one below its MCA", () => {
    const b = referenceBuilding();
    b.ok({ type: "edit_service_link", linkId: "c-rtu1", electrical: { ratingA: 60 } });
    b.ok({ type: "edit_service_link", linkId: "c-rtu2", electrical: { ratingA: 15 } });
    const f = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).report(b.head, "h1")?.findings.filter((x) => x.kind === "equipment_protection") ?? [];
    expect(f.map((x) => [x.severity, x.message])).toEqual([
      ["error", "H1-1,3,5: RTU-1's 60 A breaker is above its 40 A maximum overcurrent protection (nameplate); use 40 A or less"],
      ["warning", "H1-2,4,6: RTU-2's minimum circuit ampacity is 18 A, more than its 15 A breaker; the breaker would trip under normal load"],
    ]);
  });
});

describe("room templates (engineer-chosen rooms and panel; no proximity grouping)", () => {
  const room = (id: string, number: string, name: string, x0: number, x1: number): Room => ({
    id: id as Room["id"],
    version: 1,
    authoredRev: {},
    partition: { level: "lvl-1", zone: "Z1", discipline: "architecture" },
    kind: "room",
    number,
    name,
    outline: [
      { x: x0, y: 0 },
      { x: x1, y: 0 },
      { x: x1, y: 4000 },
      { x: x0, y: 4000 },
    ],
    areaSqM: ((x1 - x0) * 4) / 1000,
  });

  const TEMPLATE: CircuitTemplateEntry = {
    type: "circuit_template",
    name: "Two-bedroom unit",
    description: "Bedrooms on 1 and 3, living on 5",
    rules: [
      { room: "bedroom 2", devices: "receptacles", circuit: 3 },
      { room: "bedroom", devices: "receptacles", circuit: 1 },
      { room: "living", devices: "receptacles", circuit: 5, description: "Living receptacles" },
      { room: "kitchen", devices: "all" },
    ],
  };

  function unitBuilding(): { b: Building; model: () => ModelState } {
    const b = referenceDistribution();
    b.place("ua", "panel208", { panel_name: "UNIT 101" });
    const rooms = [room("rm-1", "101-1", "Bedroom", 0, 4000), room("rm-2", "101-2", "Bedroom 2", 4000, 8000), room("rm-3", "101-3", "Living", 8000, 14000), room("rm-4", "101-4", "Bath", 14000, 16000)];
    b.head = { ...b.head, elements: { ...b.head.elements, ...Object.fromEntries(rooms.map((r) => [r.id, r])) } };
    const recep = (id: string, x: number) => b.place(id, "receptacle", { voltage: 120, load_va: 180 }, id, { x, y: 2000 });
    recep("br1-a", 1000);
    recep("br1-b", 3000);
    recep("br2-a", 5000);
    recep("lv-a", 9000);
    recep("lv-b", 12000);
    recep("bath-a", 15000);
    b.place("br1-light", "light", { voltage: 120, load_va: 60 }, "L-1", { x: 2000, y: 2000 });
    return { b, model: () => b.head };
  }

  it("matches rules top to bottom by whole words and puts each room's receptacles on its circuit; the preview is what the edit makes", () => {
    const { b } = unitBuilding();
    const plan = planCircuitTemplate(b.head, TEMPLATE, [{ panelId: "ua", roomIds: ["rm-1", "rm-2", "rm-3", "rm-4"] }]);
    const u = plan.units[0];
    expect(u?.circuits.map((c) => [c.rooms.join("+"), c.name, c.memberIds])).toEqual([
      ["Bedroom 2", "UNIT 101-3", ["br2-a"]],
      ["Bedroom", "UNIT 101-1", ["br1-a", "br1-b"]],
      ["Living", "UNIT 101-5", ["lv-a", "lv-b"]],
    ]);
    expect(u?.unmatchedRooms).toEqual(["Bath"]);
    expect(plan.made).toBe(3);
    if (!plan.command) throw new Error("expected an edit");
    b.ok(plan.command);
    expect(panelSchedule(b.head.elements, "ua")?.circuits.map((c) => [c.name, c.description, c.members.map((m) => m.elementId)])).toEqual([
      ["UNIT 101-3", "Bedroom 2 receptacles", ["br2-a"]],
      ["UNIT 101-1", "Bedroom receptacles", ["br1-a", "br1-b"]],
      ["UNIT 101-5", "Living receptacles", ["lv-a", "lv-b"]],
    ]);
    b.valid();
  });

  it("leaves devices already on a circuit alone and refuses a rule's slot already taken, in words", () => {
    const { b } = unitBuilding();
    b.ok({ type: "create_service_link", linkId: "c-pre", sourceId: "ua", positions: [1], members: [{ elementId: "bath-a" }] });
    b.ok({ type: "add_link_members", linkId: "c-pre", members: [{ elementId: "lv-b" }] });
    const plan = planCircuitTemplate(b.head, TEMPLATE, [{ panelId: "ua", roomIds: ["rm-1", "rm-3"] }]);
    const u = plan.units[0];
    expect(u?.skipped).toEqual([{ elementId: "lv-b", name: "lv-b", reason: "already on UNIT 101-1" }]);
    expect(u?.circuits.find((c) => c.rooms[0] === "Bedroom")?.refusal).toMatch(/Circuit 1 on UNIT 101 is already used by UNIT 101-1/);
    expect(plan.refused).toBe(1);
    expect(plan.made).toBe(1);
  });

  it("never picks a panel: the unit names it; suggested units group rooms by number and a panel only by its name", () => {
    const { b } = unitBuilding();
    expect(suggestUnits(b.head.elements, ["rm-1", "rm-2", "rm-3"])).toEqual([{ unit: "101", roomIds: ["rm-1", "rm-2", "rm-3"], panelId: "ua" }]);
    const bad = planCircuitTemplate(b.head, TEMPLATE, [{ panelId: "rm-1", roomIds: ["rm-1"] }]);
    expect(bad.units[0]?.skipped[0]?.reason).toBe("rm-1 is not a panel; pick the unit's panel");
    expect(bad.command).toBeNull();
  });

  it("is stored in the catalog like any record", () => {
    const { b } = unitBuilding();
    b.ok({ type: "save_catalog_entry", entry: TEMPLATE });
    expect(b.el(catalogElementId("circuit_template", "two-bedroom unit")).kind).toBe("service_catalog");
  });
});

describe("Check list", () => {
  it("lists engine findings, loads on no circuit and missing connection types, errors first, each naming what to select", () => {
    const b = referenceBuilding();
    b.place("loose1", "receptacle", { voltage: 120, load_va: 180 }, "R-9");
    b.place("loose2", "receptacle", { voltage: 120, connection_type: "E.99" }, "R-10");
    b.ok({ type: "edit_service_link", linkId: "c-rtu1", electrical: { ratingA: 60 } });
    const items = electricalCheck(new ElectricalLoadEngine(CONNECTED_LOAD_ONLY), b.head);
    expect(items[0]).toMatchObject({ severity: "error", kind: "equipment_protection", panelId: "h1" });
    expect(items.find((i) => i.kind === "uncircuited")).toMatchObject({ message: "2 loads are on no circuit: R-9, R-10. Select them and press Add to circuit", elementIds: ["loose1", "loose2"] });
    expect(items.find((i) => i.kind === "missing_connection_type")?.elementIds).toEqual(["loose2"]);
    expect(items.map((i) => i.kind)).toContain("missing_feeder_type");
    expect(uncircuitedLoads(b.head).map((l) => l.name)).toEqual(["R-9", "R-10"]);
  });
});

describe("batches are one edit", () => {
  it("runs steps against each other's result and refuses as a whole, naming the step", () => {
    const b = referenceDistribution();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 });
    const cmd: Command = {
      type: "batch_service_links",
      label: "Test batch",
      commands: [
        { type: "save_catalog_entry", entry: E05 },
        { type: "create_service_link", linkId: "c1", sourceId: "l1", positions: [1], members: [{ elementId: "r1" }] },
        { type: "create_service_link", linkId: "c2", sourceId: "l1", positions: [1], members: [] },
      ],
    };
    const r = executeCommand(b.head, cmd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/^Step 3 of 3 \(create service link\): Circuit 1 on L1 is already used by L1-1/);
    const good = { ...cmd, commands: cmd.commands.slice(0, 2) } as Command;
    b.ok(good);
    expect(b.head.elements[catalogElementId("connection_type", "E.05")]).toBeDefined();
    expect(positionsOf(b, "c1")).toEqual([1]);
  });
});

describe("built-in electrical parts", () => {
  const types = [
    "builtin:panelboard-225-mcb@1",
    "builtin:panelboard-125-208-1ph@1",
    "builtin:switchboard-sections-1600-480@1",
    "builtin:transformer-45kva@1",
    "builtin:transformer-112_5kva@1",
    "builtin:generator-150kw-480@1",
    "builtin:ats-400-480@1",
    "builtin:ct-cabinet-meter-800-480@1",
    "builtin:disconnect-nf-30-480@1",
    "builtin:disconnect-fused-60-480@1",
    "builtin:quad-receptacle@1",
    "builtin:gfci-receptacle@1",
    "builtin:countertop-receptacle@1",
    "builtin:floor-receptacle@1",
    "builtin:ceiling-receptacle@1",
    "builtin:downlight-6-led@1",
    "builtin:troffer-2x4-led-em@1",
    "builtin:exit-sign-led@1",
  ];

  function placeBuiltin(b: Building, id: string, typeId: string, values: Record<string, string | number> = {}, mark = id) {
    const entry = builtinPartType(typeId);
    if (!entry) throw new Error(`no ${typeId}`);
    b.ok({ type: "place_part", partId: id, typeId, partType: b.head.elements[typeId] ? undefined : entry.definition, levelId: "lvl-1", position: { x: 1000 * Object.keys(b.head.elements).length, y: 5000 }, mark, values } as Command);
    return id;
  }

  it("every new type is a valid part type", () => {
    for (const id of types) {
      const entry = builtinPartType(id);
      expect(entry).toBeDefined();
      expect(partTypeIssues(entry?.definition as PartTypeDefinition)).toEqual([]);
    }
  });

  it("reads each kind as distribution equipment of the right sort, with its system and ratings", () => {
    const b = referenceDistribution();
    placeBuiltin(b, "gen", "builtin:generator-150kw-480@1", { panel_name: "GEN-1" });
    placeBuiltin(b, "ats", "builtin:ats-400-480@1", { panel_name: "ATS-1" });
    placeBuiltin(b, "ds", "builtin:disconnect-fused-60-480@1", { panel_name: "DS-1" });
    placeBuiltin(b, "ct", "builtin:ct-cabinet-meter-800-480@1", { panel_name: "CT-1" });
    placeBuiltin(b, "unit", "builtin:panelboard-125-208-1ph@1", { panel_name: "A101" });
    placeBuiltin(b, "swbd", "builtin:switchboard-sections-1600-480@1", { panel_name: "MSB" });
    const info = (id: string) => {
      const el = b.el(id);
      return el.kind === "part" ? distributionOf(b.head.elements, el) : null;
    };
    expect(info("gen")).toMatchObject({ kind: "generator", input: null, kva: 187.5, spaces: null });
    expect(info("ats")).toMatchObject({ kind: "transfer_switch", input: "normal", alternateInput: "emergency", busA: 400 });
    expect(info("ds")).toMatchObject({ kind: "disconnect", input: "line", busA: 60, mainA: 40 });
    expect(info("ct")).toMatchObject({ kind: "meter", input: "line", busA: 800 });
    expect(info("unit")).toMatchObject({ kind: "panelboard", mainA: 125, spaces: 30, system: { lineToLine: 208, lineToNeutral: 120, phases: 1, wires: 3 } });
    expect(info("swbd")).toMatchObject({ kind: "switchboard", busA: 1600, mainA: 1600 });
    const swbd = b.el("swbd");
    expect(swbd.kind === "part" && b.head.elements[swbd.typeId]?.kind === "part_type").toBe(true);
  });

  it("a generator feeds a transfer switch's emergency side and sees the load behind it; the normal side carries it upstream", () => {
    const b = referenceDistribution();
    placeBuiltin(b, "gen", "builtin:generator-150kw-480@1", { panel_name: "GEN-1" });
    placeBuiltin(b, "ats", "builtin:ats-400-480@1", { panel_name: "ATS-1" });
    placeBuiltin(b, "eq", "builtin:panelboard-225-480-mcb@1", { panel_name: "EH1" });
    b.ok({ type: "create_service_link", linkId: "f-ats-n", sourceId: "mdp", members: [{ elementId: "ats", connector: "normal" }], electrical: { ratingA: 400 } });
    b.ok({ type: "create_service_link", linkId: "f-ats-e", sourceId: "gen", members: [{ elementId: "ats", connector: "emergency" }] });
    b.ok({ type: "create_service_link", linkId: "f-eh1", sourceId: "ats", members: [{ elementId: "eq" }] });
    b.place("egress", "light", { voltage: 277, load_va: 2000 }, "EM-1");
    b.ok({ type: "create_service_link", linkId: "c-em", sourceId: "eq", members: [{ elementId: "egress" }] });
    const f = b.el("f-ats-e");
    expect(f.kind === "service_link" && f.role).toBe("feeder");
    const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    expect(engine.report(b.head, "gen")?.connectedVa).toBe(2000);
    expect(engine.report(b.head, "mdp")?.connectedVa).toBe(2000);
    expect(engine.report(b.head, "ats")?.supplyFrom?.sourceName).toBe("MDP");
    expect(engine.report(b.head, "gen")?.capacity.limits.find((l) => l.kind === "transformer")?.description).toMatch(/^its 187\.5 kVA generator rating/);
    expect(b.refused({ type: "create_service_link", linkId: "x", sourceId: "ats", positions: [1], members: [{ elementId: "egress" }] })).toMatch(/is a transfer switch; what it feeds takes no breaker positions on it|already on/);
    b.valid();
  });

  it("MUA-1 through a non-fused disconnect: H1's breaker feeds the disconnect, the disconnect serves the unit", () => {
    const b = referenceDistribution();
    placeBuiltin(b, "ds", "builtin:disconnect-nf-30-480@1", { panel_name: "DS-MUA-1" });
    b.place("mua", "mech3", { voltage: 480, load_va: 10_000, mocp: 20 }, "MUA-1");
    b.ok({ type: "create_service_link", linkId: "f-ds", sourceId: "h1", members: [{ elementId: "ds" }], electrical: { ratingA: 20 } });
    b.ok({ type: "create_service_link", linkId: "c-mua", sourceId: "ds", members: [{ elementId: "mua" }] });
    expect(panelSchedule(b.head.elements, "h1")?.circuits[0]).toMatchObject({ name: "H1-1,3,5", role: "feeder", feeds: { name: "DS-MUA-1" } });
    expect(new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).report(b.head, "h1")?.connectedVa).toBe(10_000);
  });
});

describe("service equipment and the live one-line (WS-E's read of the catalog)", () => {
  it("a tap box and a CT cabinet take no breaker positions: feeding from them needs none and refuses any, in plain words", () => {
    const b = referenceDistribution();
    const place = (id: string, typeId: string, name: string) => {
      const entry = builtinPartType(typeId);
      if (!entry) throw new Error(`no ${typeId}`);
      b.ok({ type: "place_part", partId: id, typeId, partType: entry.definition, levelId: "lvl-1", position: { x: 90_000 + 2000 * Object.keys(b.head.elements).length, y: 9000 }, mark: id, values: { panel_name: name } } as Command);
    };
    place("ct", "builtin:ct-cabinet-meter-800-480@1", "CT-1");
    place("tap", "builtin:tap-box-1200-480@1", "TAP-1");
    place("sb", "builtin:switchboard-sections-1600-480@1", "MSB");
    const info = (id: string) => {
      const el = b.el(id);
      return el.kind === "part" ? distributionOf(b.head.elements, el) : null;
    };
    expect(info("tap")).toMatchObject({ kind: "tap_box", spaces: null, busA: 1200 });
    b.ok({ type: "create_service_link", linkId: "f-tap", sourceId: "ct", members: [{ elementId: "tap" }] });
    expect(b.refused({ type: "create_service_link", linkId: "f-sb", sourceId: "tap", positions: [1, 3, 5], members: [{ elementId: "sb" }] })).toBe("TAP-1 is a tap box; what it feeds takes no breaker positions on it");
    b.ok({ type: "create_service_link", linkId: "f-sb", sourceId: "tap", members: [{ elementId: "sb" }] });
    expect(positionsOf(b, "f-sb")).toEqual([]);
    b.valid();
  });

  it("a feeder naming F225 prints the catalog's conductors on the one-line, in tags and schedules; an unknown mark prints the mark alone", () => {
    const b = referenceDistribution();
    expect(feederTypeInfoOf(b.head.elements, "f225")).toEqual({ mark: "F225", conductors: null, conduitAboveGrade: null, conduitBelowGrade: null });
    expect(resolveField(b.head.elements, "h1", "supply.conductors").text).toBe("");
    b.ok({ type: "save_catalog_entry", entry: F225 });
    expect(feederTypeInfoOf(b.head.elements, "f225")).toEqual({ mark: "F225", conductors: "4#4/0 CU, 1#4 G", conduitAboveGrade: "2-1/2 in EMT", conduitBelowGrade: null });
    expect(resolveField(b.head.elements, "h1", "supply.conductors").text).toBe("4#4/0 CU, 1#4 G");
    expect(resolveField(b.head.elements, "h1", "supply.sets").value).toBe(1);
    const graph = JSON.stringify(electricalDiagramGraph(b.head.elements));
    expect(graph).toContain('"conductors":"4#4/0 CU, 1#4 G"');
    expect(graph).toContain('"typeMark":"F225"');
  });
});

describe("rebalance prefers moving the smaller circuit", () => {
  it("A 720 (540 + 180), B 180, C 0: moves the 180 VA circuit to C, not the 540 VA one", () => {
    const b = referenceDistribution();
    const load = (id: string, va: number, slot: number) => {
      b.place(id, "receptacle", { voltage: 120, load_va: va });
      b.ok({ type: "create_service_link", linkId: `c-${id}`, sourceId: "l1", positions: [slot], members: [{ elementId: id }] });
    };
    load("big", 540, 1);
    load("small", 180, 7);
    load("b", 180, 3);
    const plan = planRebalance(b.head.elements, "l1");
    expect(plan?.moves.map((m) => [m.linkId, m.from, m.to])).toEqual([["c-small", "L1-7", "L1-5"]]);
    expect(plan?.after.map((p) => p.va)).toEqual([540, 180, 180]);
  });
});
