/**
 * @jest-environment node
 *
 * The aggregation engine on the reference building, with no code pack
 * (CONNECTED_LOAD_ONLY): connected and per-phase totals worked by hand at
 * every panel, incremental recompute, demand input independent of how the
 * panels below are arranged, findings that report rather than block, and
 * proposals from the old free-text circuit / fed-from values. The NEC
 * demand and capacity figures are in packages/bim-calc/__tests__.
 */
import { accumulateBelow, sumMonoid, type Command } from "@permitzip/bim-kernel";
import { CONNECTED_LOAD_ONLY, demandLoads, ElectricalLoadEngine, proposeLinksFromText, type ElectricalNodeReport } from "@permitzip/bim-pack-electrical";
import { Building, referenceBuilding, referenceDistribution } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function report(engine: ElectricalLoadEngine, b: Building, id: string): ElectricalNodeReport {
  const r = engine.report(b.head, id);
  if (!r) throw new Error(`no report for ${id}`);
  return r;
}

const phases = (r: ElectricalNodeReport) => r.perPhase.map((p) => Math.round(p.va * 100) / 100);

describe("aggregation core", () => {
  it("each node's total is its own plus its children's totals, children first", () => {
    const children: Record<string, string[]> = { a: ["b", "c"], b: ["d"], c: [], d: [] };
    const own: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 };
    const t = accumulateBelow(["a", "b", "c", "d"], (n) => children[n] ?? [], (n) => own[n], sumMonoid);
    expect(Object.fromEntries(t)).toEqual({ a: 10, b: 6, c: 3, d: 4 });
  });
});

describe("electrical loads: the reference building, connected", () => {
  const b = referenceBuilding();
  const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);

  /*
   * H1: RTU-1 8,000 + RTU-2 5,000 + MUA-1 3,333.33 + K-3 3,000 on every phase;
   * lighting 800 on A (13) and on B (15), site 900 on C (17).
   *   A = B = 20,133.33, C = 20,233.33; total 60,500.
   * L1: A = 540 + 540 + 2,250 + 1,320 = 4,650 (circuits 1, 7, 13, 2);
   *     B = 540 + 360 + 2,250 + 1,500 = 4,650 (3, 9, 15, 4);
   *     C = 540 + 600 + 1,800 = 2,940 (5, 11, 6); total 12,240.
   * T1 carries L1. MDP: H1 on 1,3,5 and T1 on 2,4,6 (A, B, C each):
   *   A = B = 24,783.33, C = 23,173.33; total 72,740.
   */
  it("H1: connected, per-phase VA and amps", () => {
    const r = report(engine, b, "h1");
    expect(r.connectedVa).toBeCloseTo(60_500, 6);
    expect(phases(r)).toEqual([20_133.33, 20_133.33, 20_233.33]);
    expect(r.connectedA).toBeCloseTo(60_500 / (Math.sqrt(3) * 480), 6);
    expect(r.perPhase[0]?.amps).toBeCloseTo(20_133.333 / 277, 2);
  });

  it("L1, T1 and MDP: connected and per-phase totals at every node", () => {
    expect(report(engine, b, "l1").connectedVa).toBeCloseTo(12_240, 6);
    expect(phases(report(engine, b, "l1"))).toEqual([4650, 4650, 2940]);
    expect(phases(report(engine, b, "t1"))).toEqual([4650, 4650, 2940]);
    const mdp = report(engine, b, "mdp");
    expect(mdp.connectedVa).toBeCloseTo(72_740, 6);
    expect(phases(mdp)).toEqual([24_783.33, 24_783.33, 23_173.33]);
  });

  it("names the supply of every fed node, as live model data", () => {
    expect(report(engine, b, "h1").supplyFrom).toMatchObject({ sourceName: "MDP", name: "MDP-1,3,5", ratingA: 225, poles: 3, feederType: "F225", text: "MDP via 225 A 3-pole breaker (F225)" });
    expect(report(engine, b, "l1").supplyFrom).toMatchObject({ sourceName: "T1", name: "T1 to L1", ratingA: null, text: "T1" });
    expect(report(engine, b, "mdp").supplyFrom).toBeNull();
  });

  it("lists distribution top down", () => {
    expect(engine.distribution(b.head)).toEqual(["mdp", "h1", "t1", "l1"]);
  });

  it("says plainly that connected-only totals are not a code calculation", () => {
    const r = report(engine, b, "l1");
    expect(r.rules.placeholder).toBe(true);
    expect(r.demand.notes.join(" ")).toMatch(/not a code calculation/);
  });
});

describe("electrical loads: aggregation rules", () => {
  it("passes each node its raw inventory: counts, totals and the two largest are exact", () => {
    const b = referenceBuilding();
    const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    const loads = engine.loads(b.head, "mdp");
    if (!loads) throw new Error("mdp");
    const kitchen = demandLoads(loads.inventory).filter((l) => l.loadClass === "kitchen");
    expect(kitchen.reduce((a, l) => a + l.quantity, 0)).toBe(4);
    expect(kitchen.reduce((a, l) => a + l.va * l.quantity, 0)).toBeCloseTo(13_620, 6);
    expect(kitchen.slice(0, 2).map((l) => [l.label, l.va])).toEqual([
      ["K-3", 9000],
      ["K-2", 1800],
    ]);
    const receptacles = demandLoads(loads.inventory).filter((l) => l.loadClass === "receptacle");
    expect(receptacles.reduce((a, l) => a + l.quantity, 0)).toBe(14);
  });

  it("the inventory at the top does not depend on how the panels below are arranged", () => {
    const loads = [1200, 1500, 1800, 900, 600];
    const flat = referenceDistribution();
    const deep = referenceDistribution();
    deep.place("l2", "panel208", { panel_name: "L2" });
    deep.ok({ type: "create_service_link", linkId: "f-l2", sourceId: "l1", members: [{ elementId: "l2" }] });
    loads.forEach((va, i) => {
      for (const [b, panel] of [
        [flat, "l1"],
        [deep, i % 2 === 0 ? "l1" : "l2"],
      ] as const) {
        const id = b.place(`k${i}`, "kitchen", { voltage: 120, load_va: va, load_class: "kitchen" });
        b.ok({ type: "create_service_link", linkId: `c-k${i}`, sourceId: panel, members: [{ elementId: id }] });
      }
    });
    const inputs = (b: Building) => {
      const l = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).loads(b.head, "mdp");
      if (!l) throw new Error("mdp");
      return demandLoads(l.inventory);
    };
    expect(inputs(deep)).toEqual(inputs(flat));
  });

  it("recomputes only the path from an edited load to the top, and reuses the rest", () => {
    const b = referenceBuilding();
    const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    for (const id of engine.distribution(b.head)) engine.report(b.head, id);
    const before = engine.stats.computed;
    b.ok({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 2500 } });
    expect(report(engine, b, "mdp").connectedVa).toBeCloseTo(73_740, 6);
    // L1, T1 and MDP recompute; H1 is reused.
    expect(engine.stats.computed - before).toBe(3);
    expect(report(engine, b, "h1").connectedVa).toBeCloseTo(60_500, 6);
    expect(engine.stats.computed - before).toBe(3);
    const h1 = report(engine, b, "h1");
    expect(report(engine, b, "h1")).toBe(h1);
  });

  it("told what changed (advance), it reuses everything off the changed path and still matches a fresh engine", () => {
    const b = referenceBuilding();
    const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    const snapshot = (e: ElectricalLoadEngine) => e.distribution(b.head).map((id) => {
      const r = e.report(b.head, id);
      return [id, r?.connectedVa, r?.perPhase.map((p) => p.va), r?.capacity.reason, r?.findings.map((f) => f.message)];
    });
    snapshot(engine);
    const commit = (command: Command) => {
      const cs = b.ok(command);
      const computedBefore = engine.stats.computed;
      engine.advance(b.head, [...cs.elements.map((e) => e.id), ...(cs.removedIds ?? [])]);
      expect(snapshot(engine)).toEqual(snapshot(new ElectricalLoadEngine(CONNECTED_LOAD_ONLY)));
      // At most the building's four nodes recompute.
      expect(engine.stats.computed - computedBefore).toBeLessThanOrEqual(4);
    };
    commit({ type: "set_parameters", id: "k1", scope: "instance", values: { load_va: 2500 } });
    commit({ type: "edit_service_link", linkId: "f-h1", electrical: { ratingA: 200 } });
    commit({ type: "remove_link_members", linkId: "c-off1", elementIds: ["off1-r1"] });
    commit({ type: "create_service_link", linkId: "c-x", sourceId: "l1", positions: [8], members: [{ elementId: "off1-r1" }] });
    commit({ type: "remove_link_members", linkId: "c-lt1", elementIds: ["lta1", "lta2"] });
    commit({ type: "delete_elements", ids: ["k2"], policy: "disconnect" });
    commit({ type: "set_parameters", id: "t1", scope: "type", values: { kva: 45 } });
    commit({ type: "edit_service_link", linkId: "c-off2", sourceId: "l1", positions: [10] });
    commit({ type: "set_parameters", id: "rtu2", scope: "instance", values: { load_va: 16_000 } });
  });

  it("a new circuit, a moved member and a deleted device all reach the totals", () => {
    const b = referenceBuilding();
    const engine = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    expect(report(engine, b, "l1").connectedVa).toBeCloseTo(12_240, 6);
    b.place("r-new", "receptacle", { voltage: 120, load_va: 180 }, "R-NEW");
    b.ok({ type: "create_service_link", linkId: "c-new", sourceId: "l1", positions: [8], members: [{ elementId: "r-new" }] });
    expect(report(engine, b, "l1").connectedVa).toBeCloseTo(12_420, 6);
    b.ok({ type: "remove_link_members", linkId: "c-off1", elementIds: ["off1-r1"] });
    expect(report(engine, b, "l1").connectedVa).toBeCloseTo(12_240, 6);
    b.ok({ type: "delete_elements", ids: ["k2"], policy: "disconnect" });
    expect(report(engine, b, "mdp").connectedVa).toBeCloseTo(72_740 - 1800, 6);
  });
});

describe("electrical loads: findings report, never block", () => {
  it("a member a later edit made incompatible is a finding, and unrelated edits still commit", () => {
    const b = referenceDistribution();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R-1");
    b.ok({ type: "create_service_link", linkId: "c-r1", sourceId: "l1", members: [{ elementId: "r1" }] });
    b.ok({ type: "set_parameters", id: "r1", scope: "instance", values: { voltage: 277 } });
    b.valid();
    b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "R-2");
    b.ok({ type: "create_service_link", linkId: "c-r2", sourceId: "l1", members: [{ elementId: "r2" }] });
    const r = report(new ElectricalLoadEngine(CONNECTED_LOAD_ONLY), b, "l1");
    expect(r.findings.filter((f) => f.kind === "incompatible").map((f) => f.message)).toEqual(["L1-1: R-1 needs 277 V, 1 pole; L1 is 120/208 V 3-phase 4-wire, so it can't serve it"]);
  });

  it("unbalanced phases, a load with nothing to count and an overloaded branch circuit", () => {
    const b = referenceBuilding();
    b.place("jb", "receptacle", { voltage: 120 }, "JB-1");
    b.ok({ type: "create_service_link", linkId: "c-jb", sourceId: "l1", positions: [17], members: [{ elementId: "jb" }] });
    const heavy = Array.from({ length: 14 }, (_, i) => ({ elementId: b.place(`hv${i}`, "receptacle", { voltage: 120, load_va: 180 }) }));
    b.ok({ type: "create_service_link", linkId: "c-heavy", sourceId: "l1", positions: [19], members: heavy, description: "Workroom" });
    const r = report(new ElectricalLoadEngine(CONNECTED_LOAD_ONLY), b, "l1");
    const byKind = Object.fromEntries(r.findings.map((f) => [f.kind, f.message]));
    expect(byKind.no_load).toBe("JB-1 on L1-17 has no load to count: give the connector a design load, or set load_va (or watts, or MCA)");
    // 14 x 180 = 2,520 VA on 120 V = 21 A on a 20 A breaker.
    expect(byKind.circuit_overloaded).toBe("L1-19 (Workroom) needs 21.0 A with continuous loads at 125%, on a 20 A breaker");
    expect(byKind.unbalanced).toMatch(/^L1's phases are unbalanced: A 7,170 VA, B 4,650 VA, C 2,940 VA; A is 46% above the average/);
  });
});

describe("proposals from free-text circuit and fed-from values", () => {
  it("proposes what the text says, checked against the model; nothing is wired until a proposal is run", () => {
    const b = new Building();
    b.place("mdp", "switchboard", { panel_name: "MDP" });
    b.place("h1", "panel480", { panel_name: "H1", fed_from: "MDP" });
    b.place("t1", "transformer", { panel_name: "T1" });
    b.place("l1", "panel208", { panel_name: "L1", fed_from: "T1" });
    b.place("lp", "panel208", { panel_name: "LP-1A", fed_from: "MDP" });
    b.place("r1", "receptacle", { voltage: 120, load_va: 180, circuit: "L1-3" }, "R-1");
    b.place("r2", "receptacle", { voltage: 120, load_va: 180, circuit: "L1 - 3" }, "R-2");
    b.place("r3", "receptacle", { voltage: 120, load_va: 180, circuit: "LP-1A-12" }, "R-3");
    b.place("mua", "mech3", { voltage: 480, load_va: 10_000, circuit: "L1-5,7,9" }, "MUA-1");
    b.place("x", "receptacle", { voltage: 120, load_va: 180, circuit: "see plans" }, "R-9");
    const before = b.head;
    const proposals = proposeLinksFromText(b.head);
    expect(b.head).toBe(before);
    const byId = Object.fromEntries(proposals.map((p) => [p.id, p]));
    expect(byId["feeder:h1"]).toMatchObject({ status: "ready", sourceName: "MDP", reason: `Feed H1 from MDP (its "Fed from" says MDP), on the lowest free breaker positions that fit` });
    expect(byId["feeder:l1"]).toMatchObject({ status: "ready", sourceName: "T1" });
    expect(byId["feeder:lp"]).toMatchObject({ status: "refused", reason: `LP-1A's "Fed from" says MDP, but LP-1A needs 120/208 V 3-phase 4-wire; MDP is 277/480 V 3-phase 4-wire, so it can't feed it` });
    expect(byId["branch:l1:3"]).toMatchObject({ status: "ready", positions: [3], reason: "Put 2 devices (R-1, R-2) on L1-3, as their circuit text says" });
    expect(byId["branch:lp:12"]).toMatchObject({ status: "ready", sourceName: "LP-1A", positions: [12] });
    expect(byId["branch:l1:5,7,9"]).toMatchObject({ status: "refused" });
    expect(byId["text:x"]).toMatchObject({ status: "unmatched" });

    // The engineer confirms two: each runs as an ordinary command, undoable like any other.
    for (const id of ["feeder:l1", "branch:l1:3"]) {
      const command = byId[id]?.command;
      if (!command) throw new Error(id);
      b.ok(command);
    }
    b.valid();
    const again = Object.fromEntries(proposeLinksFromText(b.head).map((p) => [p.id, p]));
    expect(again["branch:l1:3"]).toBeUndefined();
    expect(again["feeder:l1"]).toBeUndefined();
    expect(again["feeder:h1"]?.status).toBe("ready");
  });

  it("adds to the circuit already on those positions instead of making a second one", () => {
    const b = referenceDistribution();
    b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "R-1");
    b.ok({ type: "create_service_link", linkId: "c-3", sourceId: "l1", positions: [3], members: [{ elementId: "r1" }] });
    b.place("r2", "receptacle", { voltage: 120, load_va: 180, circuit: "L1-3" }, "R-2");
    const [p] = proposeLinksFromText(b.head);
    expect(p).toMatchObject({ status: "ready", command: { type: "add_link_members", linkId: "c-3" }, reason: "Add R-2 to L1-3, as their circuit text says" });
  });
});
