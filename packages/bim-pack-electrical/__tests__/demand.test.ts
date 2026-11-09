/**
 * @jest-environment node
 *
 * Article 220 demand at a node from its raw inventory, by hand. The V2
 * point: kitchen equipment demand is set by the count at the node, so the MDP
 * (six units below it) and the panel serving two of them get different
 * factors for the same freezer, and the MDP's demand is not the sum of its
 * panels' demands.
 */
import { builtinCalcRegistry, type CalcRun } from "@permitzip/bim-calc";
import { type DemandDetail } from "@permitzip/bim-pack-electrical";

const registry = builtinCalcRegistry();

function demand(inputs: Record<string, unknown>, necEdition: "2020" | "2023" = "2020"): CalcRun & { detail: DemandDetail } {
  const r = registry.run({ calc: "nec.demand_load", inputs, necEdition });
  if (!r.ok) throw new Error(r.reason);
  return r.run as CalcRun & { detail: DemandDetail };
}
const rowOf = (r: { detail: DemandDetail }, key: string) => r.detail.rows.find((x) => x.key === key);

// The ANALYSIS.md example building: E.05 reach-in freezer 1320 VA (220.56) on L1 with one more kitchen item; the MDP also feeds four more kitchen items elsewhere.
const L1_KITCHEN = [
  { class: "kitchen", va: 1320, label: "E.05 reach-in freezer" },
  { class: "kitchen", va: 1800, label: "K.10 prep refrigerator" },
];
const OTHER_KITCHEN = [
  { class: "kitchen", va: 5000, label: "K.12 fryer" },
  { class: "kitchen", va: 5000, label: "K.14 fryer" },
  { class: "kitchen", va: 3000, label: "K.23 warmer" },
  { class: "kitchen", va: 2000, label: "K.30 booster" },
];

describe("kitchen equipment demand depends on the count at the node (220.56)", () => {
  const l1 = demand({ node: "L1", voltage_v: 208, phases: 3, loads: L1_KITCHEN });
  const mdp = demand({ node: "MDP", voltage_v: 480, phases: 3, loads: [...L1_KITCHEN, ...OTHER_KITCHEN] });

  it("L1 serves 2 units: 100%, 3120 VA", () => {
    expect(l1.detail.kitchenUnits).toBe(2);
    expect(rowOf(l1, "kitchen")?.demandVa).toBe(3120);
  });

  it("the MDP has 6 units below it: 65% of 18,120 VA = 11,778 VA (above the two largest, 10,000 VA)", () => {
    expect(mdp.detail.kitchenUnits).toBe(6);
    expect(rowOf(mdp, "kitchen")?.demandVa).toBeCloseTo(18120 * 0.65, 6);
    expect(rowOf(mdp, "kitchen")?.cite[0]?.text).toBe("NEC 2020 Table 220.56, 6 units: 65%");
  });

  it("the same freezer counts at 100% on L1 and 65% at the MDP; the MDP is not the sum of its panels' demands", () => {
    const otherPanel = demand({ node: "L2", voltage_v: 208, phases: 3, loads: OTHER_KITCHEN });
    const sumOfPanels = (rowOf(l1, "kitchen")?.demandVa ?? 0) + (rowOf(otherPanel, "kitchen")?.demandVa ?? 0);
    expect(rowOf(otherPanel, "kitchen")?.demandVa).toBeCloseTo(15000 * 0.8, 6);
    expect(rowOf(mdp, "kitchen")?.demandVa).toBeLessThan(sumOfPanels);
  });

  it("never less than the two largest: 20, 18, 3 and 3 kVA at 80% would be 35.2 kVA; the floor is 38 kVA", () => {
    const r = demand({ voltage_v: 208, phases: 3, loads: [20000, 18000, 3000, 3000].map((va) => ({ class: "kitchen", va })) });
    expect(rowOf(r, "kitchen")?.demandVa).toBe(38000);
    expect(rowOf(r, "kitchen")?.cite[0]?.text).toMatch(/not less than the two largest loads$/);
  });

  it("is independent of the order the inventory arrives in", () => {
    const loads = [...L1_KITCHEN, ...OTHER_KITCHEN, { class: "lighting", va: 1600, quantity: 2 }, { class: "receptacle", va: 180, quantity: 80 }];
    const a = demand({ voltage_v: 480, phases: 3, loads });
    const b = demand({ voltage_v: 480, phases: 3, loads: [...loads].reverse() });
    expect(b.detail.demandVa).toBe(a.detail.demandVa);
    expect(b.detail.sizingVa).toBe(a.detail.sizingVa);
  });
});

describe("the other classes", () => {
  it("receptacles: 80 x 180 VA = 14,400 VA → 10,000 + 50% of 4,400 = 12,200 VA (2023 cites Table 220.47)", () => {
    const r = demand({ voltage_v: 208, phases: 3, loads: [{ class: "receptacle", va: 180, quantity: 80 }] }, "2023");
    expect(rowOf(r, "receptacle")?.demandVa).toBe(12200);
    expect(rowOf(r, "receptacle")?.cite[0]?.text).toBe("NEC 2023 Table 220.47, first 10 kVA at 100%, remainder at 50%");
  });

  it("lighting is continuous: 2 x 20 x 40 W troffers = 1,600 VA x 2 at 100%, sized at 125% (4,000 VA)", () => {
    const r = demand({ voltage_v: 480, phases: 3, loads: [{ class: "lighting", va: 1600, quantity: 2 }] });
    expect(r.detail.demandVa).toBe(3200);
    expect(r.detail.sizingVa).toBe(4000);
    expect(rowOf(r, "lighting")?.cite[0]?.text).toBe("NEC 2020 Table 220.42, all others, 100%");
  });

  it("dwelling lighting 10,000 VA → 3,000 + 35% of 7,000 = 5,450 VA; warehouse 20,000 VA → 12,500 + 50% of 7,500 = 16,250 VA", () => {
    expect(demand({ occupancy: "dwelling", voltage_v: 240, phases: 1, loads: [{ class: "lighting", va: 10000 }] }).detail.demandVa).toBe(5450);
    expect(demand({ occupancy: "warehouse", voltage_v: 480, phases: 3, loads: [{ class: "lighting", va: 20000 }] }).detail.demandVa).toBe(16250);
  });

  it("motors at 100% plus 25% of the largest (RTU-1 here); heating vs cooling keeps only the larger", () => {
    const r = demand({
      voltage_v: 480,
      phases: 3,
      loads: [
        { class: "hvac", va: 26600, label: "RTU-1" },
        { class: "hvac", va: 15000, label: "RTU-2" },
        { class: "motor", va: 600, label: "EF-1" },
        { class: "heating", va: 4500, label: "WH-1 heat" },
        { class: "cooling", va: 3000, label: "split AC" },
      ],
    });
    expect(rowOf(r, "largest_motor")?.demandVa).toBe(26600 * 0.25);
    expect(rowOf(r, "largest_motor")?.basis).toBe("25% of RTU-1 (26600 VA)");
    expect(r.detail.omittedNoncoincident).toBe("cooling");
    expect(r.detail.demandVa).toBe(26600 + 15000 + 600 + 4500 + 6650);
    expect(r.citations.map((c) => c.clause)).toEqual(expect.arrayContaining(["220.50", "430.24", "220.60"]));
  });

  it("current, sizing current and the smallest standard device: 100 kVA demand at 480 V 3-phase = 120.3 A", () => {
    const r = demand({ voltage_v: 480, phases: 3, loads: [{ class: "other", va: 100000 }] });
    expect(r.detail.demandA).toBeCloseTo(100000 / (Math.sqrt(3) * 480), 6);
    expect(r.detail.minimumOcpdA).toBe(125);
    for (const v of r.values) expect(v.cite.length).toBeGreaterThan(0);
  });
});
