/**
 * @jest-environment node
 *
 * E1 acceptance: the reference building (480 V MDP → H1 and transformer T1 →
 * 208 V L1; RTU-1, RTU-2, MUA-1, EF-1; receptacles, kitchen equipment,
 * lighting incl. a 300 ft site circuit) through the kernel aggregation engine
 * with the NEC 2023 pack. Every connected, demand, sizing and per-phase figure
 * and every capacity limit is worked by hand below, independent of the code.
 */
import { ELECTRICAL_LOAD_CLASSES } from "@permitzip/bim-kernel";
import { CONNECTED_LOAD_ONLY, ElectricalLoadEngine, type ElectricalNodeReport, LOAD_CLASSES, necElectricalRules } from "@permitzip/bim-pack-electrical";
import { resolveNecEdition } from "@permitzip/bim-calc";
import { Building, referenceBuilding } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const V480 = Math.sqrt(3) * 480; // 831.38 VA per amp
const V208 = Math.sqrt(3) * 208; // 360.27 VA per amp

function report(engine: ElectricalLoadEngine, b: Building, id: string): ElectricalNodeReport {
  const r = engine.report(b.head, id);
  if (!r) throw new Error(`no report for ${id}`);
  return r;
}

const lines = (r: ElectricalNodeReport) => Object.fromEntries(r.demand.lines.map((l) => [l.key, [Math.round(l.connectedVa * 100) / 100, Math.round(l.demandVa * 100) / 100]]));

/*
 * Hand calculation, NEC 2023 (other occupancy: general lighting at 100%).
 *
 * L1 (and T1, which carries only L1):
 *   receptacles 14 x 180 = 2,520 (under 10 kVA: 100%)            2,520
 *   kitchen E.05 1,320 + K-1 1,500 + K-2 1,800 = 4,620, 3 units 90%  4,158
 *     (two largest 3,300 < 4,158)
 *   HVAC EF-1 600                                                    600
 *   other WH-1 4,500 (continuous)                                  4,500
 *   largest motor: 25% of EF-1 600                                   150
 *   calculated load                                               11,928
 *   sizing: + 25% of 4,500 continuous = 13,053 VA = 36.23 A at 208 V
 * H1:
 *   lighting 40 x 40 + 6 x 150 = 2,500 (continuous)                2,500
 *   kitchen K-3 9,000, 1 unit 100%                                  9,000
 *   HVAC RTU-1 24,000 + RTU-2 15,000 + MUA-1 10,000               49,000
 *   largest motor: 25% of RTU-1 24,000                             6,000
 *   calculated load                                               66,500
 *   sizing: + 25% of 2,500 = 67,125 VA = 80.74 A at 480 V
 * MDP (the raw inventory of both, not H1 + L1's demands):
 *   lighting 2,500; receptacles 2,520; HVAC 49,600; other 4,500
 *   kitchen 13,620, 4 units 80% = 10,896 (two largest 10,800 < 10,896)
 *     — not 4,158 + 9,000 = 13,158
 *   largest motor RTU-1 +6,000
 *   calculated load 76,016; sizing + 25% of 7,000 = 77,766 VA = 93.54 A
 */
describe("E1 acceptance: the reference building under NEC 2023", () => {
  const b = referenceBuilding();
  const engine = new ElectricalLoadEngine(necElectricalRules("2023"));

  it("L1: connected, demand by class, sizing and per-phase", () => {
    const r = report(engine, b, "l1");
    expect(r.connectedVa).toBeCloseTo(12_240, 6);
    expect(lines(r)).toEqual({ receptacle: [2520, 2520], kitchen: [4620, 4158], hvac: [600, 600], other: [4500, 4500], largest_motor: [0, 150] });
    expect(r.demand.demandVa).toBeCloseTo(11_928, 6);
    expect(r.demand.sizingVa).toBeCloseTo(13_053, 6);
    expect(r.sizingA).toBeCloseTo(13_053 / V208, 6);
    expect(r.perPhase.map((p) => p.va)).toEqual([4650, 4650, 2940]);
    expect(r.perPhase.map((p) => Math.round(p.amps * 100) / 100)).toEqual([38.75, 38.75, 24.5]);
    expect(r.demand.lines.find((l) => l.key === "kitchen")?.cite).toEqual(["NEC 2023 Table 220.56, 3 units: 90%"]);
    expect(r.rules).toEqual({ id: "nec-2023", label: "NEC 2023 Article 220", placeholder: false });
  });

  it("H1: connected, demand by class, sizing and per-phase", () => {
    const r = report(engine, b, "h1");
    expect(r.connectedVa).toBeCloseTo(60_500, 6);
    expect(lines(r)).toEqual({ lighting: [2500, 2500], kitchen: [9000, 9000], hvac: [49_000, 49_000], largest_motor: [0, 6000] });
    expect(r.demand.demandVa).toBeCloseTo(66_500, 6);
    expect(r.demand.sizingVa).toBeCloseTo(67_125, 6);
    expect(r.demand.largestMotor).toMatchObject({ va: 24_000, adderVa: 6000 });
    expect(r.perPhase.map((p) => Math.round(p.va * 100) / 100)).toEqual([20_133.33, 20_133.33, 20_233.33]);
  });

  it("T1 carries L1's inventory and gets the same demand", () => {
    const r = report(engine, b, "t1");
    expect(r.connectedVa).toBeCloseTo(12_240, 6);
    expect(r.demand.demandVa).toBeCloseTo(11_928, 6);
    expect(r.perPhase.map((p) => p.va)).toEqual([4650, 4650, 2940]);
  });

  it("MDP: 220.56 counts all four kitchen units here (80%), not the panels' own counts", () => {
    const r = report(engine, b, "mdp");
    expect(r.connectedVa).toBeCloseTo(72_740, 6);
    expect(lines(r)).toEqual({ lighting: [2500, 2500], receptacle: [2520, 2520], kitchen: [13_620, 10_896], hvac: [49_600, 49_600], other: [4500, 4500], largest_motor: [0, 6000] });
    expect(r.demand.demandVa).toBeCloseTo(76_016, 6);
    expect(r.demand.sizingVa).toBeCloseTo(77_766, 6);
    expect(r.sizingA).toBeCloseTo(77_766 / V480, 6);
    expect(r.perPhase.map((p) => Math.round(p.va * 100) / 100)).toEqual([24_783.33, 24_783.33, 23_173.33]);
    const kitchenAtPanels = (report(engine, b, "l1").demand.lines.find((l) => l.key === "kitchen")?.demandVa ?? 0) + (report(engine, b, "h1").demand.lines.find((l) => l.key === "kitchen")?.demandVa ?? 0);
    expect(kitchenAtPanels).toBeCloseTo(13_158, 6);
  });

  /*
   * Capacity, all in amps at the node:
   *   MDP: 800 A bus and 800 A main → 800 A.
   *   H1: 225 A bus; 225 A feeding breaker; upstream: MDP has 800 x 831.38 − 77,766
   *       = 587,341 VA left (706 A), so H1 could take (67,125 + 587,341) / 831.38 = 787 A → 225 A, its bus.
   *   T1: 75 kVA / 360.27 = 208.18 A; its 100 A primary breaker is 100 x 831.38 / 360.27
   *       = 230.77 A at 208 V → 208 A, its rating.
   *   L1: 225 A bus and main; T1 has 75,000 − 13,053 = 61,947 VA left (172 A), so L1 can
   *       take (13,053 + 61,947) / 360.27 = 208.18 A → 208 A, upstream.
   */
  it("capacity: each limit with its reason", () => {
    expect(report(engine, b, "mdp").capacity).toMatchObject({ limitA: 800, limitedBy: { kind: "bus" } });
    const h1 = report(engine, b, "h1").capacity;
    expect(h1).toMatchObject({ limitA: 225, limitedBy: { kind: "bus" } });
    expect(h1.reason).toBe("H1 can carry 225 A, limited by its 225 A bus (also the 225 A breaker in MDP that feeds it: 225 A; what is left in MDP (706 A spare of 800 A): 787 A)");
    const t1 = report(engine, b, "t1").capacity;
    expect(t1.limitedBy?.kind).toBe("transformer");
    expect(t1.limitA).toBeCloseTo(75_000 / V208, 6);
    expect(t1.limits.find((l) => l.kind === "feeding_breaker")?.amps).toBeCloseTo((100 * V480) / V208, 6);
    const l1 = report(engine, b, "l1").capacity;
    expect(l1.limitedBy?.kind).toBe("upstream");
    expect(l1.limitA).toBeCloseTo(75_000 / V208, 6);
    expect(l1.headroomA).toBeCloseTo((75_000 - 13_053) / V208, 6);
    expect(l1.reason).toBe("L1 can carry 208 A, limited by what is left in T1 (172 A spare of 208 A) (also its 225 A bus: 225 A; its 225 A main breaker: 225 A)");
  });

  it("capacity: a 200 A feeding breaker, then 4/0 AL feeder conductors (180 A at 75°C), take over H1", () => {
    const c = new Building();
    c.head = b.head;
    c.ok({ type: "edit_service_link", linkId: "f-h1", electrical: { ratingA: 200 } });
    const fed = report(engine, c, "h1");
    expect(fed.capacity).toMatchObject({ limitA: 200, limitedBy: { kind: "feeding_breaker" } });
    expect(fed.findings.find((f) => f.kind === "bus_above_feeding_breaker")?.message).toBe("H1's 225 A bus is fed by a 200 A breaker in MDP, so it can carry no more than the breaker");
    c.ok({ type: "edit_service_link", linkId: "f-h1", electrical: { conductors: { sets: 1, phaseSize: "4/0", material: "al" } } });
    const wire = report(engine, c, "h1").capacity;
    expect(wire).toMatchObject({ limitA: 180, limitedBy: { kind: "feeder_conductors" } });
    expect(wire.limitedBy?.description).toBe("its feeder conductors (#4/0 AL, 180 A: 180 A for #4/0 Al at 75°C terminations)");
    expect(wire.limitedBy?.cite).toContain("NEC 2023 Table 310.16, aluminum 90°C column");
  });

  it("an overloaded transformer is a finding at it and at the panel it feeds, and blocks nothing", () => {
    const c = new Building();
    c.head = b.head;
    c.ok({ type: "set_parameters", id: "t1", scope: "type", values: { kva: 10 } });
    const t1 = report(engine, c, "t1");
    expect(t1.findings.find((f) => f.kind === "overloaded")?.message).toBe("T1 is overloaded: it needs 36 A (the calculated load with continuous loads at 125%) and can carry 28 A, limited by its 10 kVA rating (28 A at 120/208 V 3-phase 4-wire)");
    expect(report(engine, c, "l1").findings.map((f) => f.kind)).toContain("overloaded");
    c.place("r-more", "receptacle", { voltage: 120, load_va: 180 }, "R-MORE");
    c.ok({ type: "create_service_link", linkId: "c-more", sourceId: "l1", positions: [8], members: [{ elementId: "r-more" }] });
    c.valid();
  });

  it("MUA-1 on L1 is refused with the plain reason", () => {
    const c = new Building();
    c.head = b.head;
    c.place("mua2", "mech3", { voltage: 480, load_va: 10_000 }, "MUA-2");
    expect(c.refused({ type: "create_service_link", linkId: "c-mua2", sourceId: "l1", members: [{ elementId: "mua2" }] })).toBe("MUA-2 needs 480 V 3-phase; L1 is 120/208 V 3-phase 4-wire, so it can't serve it");
  });

  it("the edition comes from the project's Code Study, else the state, else it asks", () => {
    expect(resolveNecEdition({ necEdition: "2020" })).toMatchObject({ ok: true, edition: { edition: "2020" } });
    expect(resolveNecEdition({ state: "VA" })).toMatchObject({ ok: true, edition: { edition: "2020" } });
    expect(resolveNecEdition({})).toMatchObject({ ok: false });
  });
});

describe("the kernel and the code pack agree on load classes", () => {
  it("every kernel class is a class the demand calc takes, and the reverse", () => {
    expect([...ELECTRICAL_LOAD_CLASSES]).toEqual([...LOAD_CLASSES]);
  });

  it("connected-only rules and NEC rules see the same connected totals", () => {
    const b = referenceBuilding();
    const plain = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY);
    const nec = new ElectricalLoadEngine(necElectricalRules("2020"));
    for (const id of ["mdp", "h1", "t1", "l1"]) expect(nec.report(b.head, id)?.demand.connectedVa).toBeCloseTo(plain.report(b.head, id)?.connectedVa ?? -1, 6);
  });
});

describe("a model panel's heater is continuous when nothing on it says (NEC 424.4(B), bug log #34 follow-up)", () => {
  /*
   * P1 (208 V 3-phase) serves one 15,000 VA unit heater, load class heating, no continuous flag:
   *   calculated 15,000 VA at 100% (220.51)
   *   sizing 125% x 15,000 = 18,750 VA = 18,750 / (√3 x 208) = 52.04 A (215.2(A)(1)(a), 424.4(B))
   * Its branch circuit (default 20 A breaker) is checked the same way: 52.0 A, not 41.6 A.
   */
  function panelWithHeater(): Building {
    const b = new Building();
    b.place("p1", "panel208", { panel_name: "P1" }, "P1");
    b.place("uh1", "mech3", { voltage: 208, load_va: 15_000, load_class: "heating" }, "UH-1");
    b.ok({ type: "create_service_link", linkId: "c-uh1", sourceId: "p1", positions: [1, 3, 5], members: [{ elementId: "uh1" }] });
    return b;
  }

  for (const edition of ["2020", "2023"] as const) {
    it(`NEC ${edition}: sized at 125%: 18,750 VA = 52.04 A, the 125% cited to 424.4(B)`, () => {
      const r = report(new ElectricalLoadEngine(necElectricalRules(edition)), panelWithHeater(), "p1");
      expect(r.demand.demandVa).toBeCloseTo(15_000, 6);
      expect(r.demand.continuousVa).toBeCloseTo(15_000, 6);
      expect(r.demand.sizingVa).toBeCloseTo(18_750, 6);
      expect(r.sizingA).toBeCloseTo(18_750 / V208, 6);
      expect(r.demand.lines.find((l) => l.key === "heating")?.cite).toEqual([`NEC ${edition} 220.51, fixed electric space heating at 100% of the connected load`]);
      expect(r.findings.find((f) => f.kind === "circuit_overloaded")?.message).toMatch(/needs 52\.0 A with continuous loads at 125%/);
    });
  }

  it("connected-only rules (no code edition) keep lighting as the only continuous default", () => {
    expect(report(new ElectricalLoadEngine(CONNECTED_LOAD_ONLY), panelWithHeater(), "p1").demand.sizingVa).toBeCloseTo(15_000, 6);
  });
});
