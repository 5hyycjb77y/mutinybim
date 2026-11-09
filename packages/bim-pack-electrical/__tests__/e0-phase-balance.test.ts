/**
 * @jest-environment node
 *
 * E0 B10: a nearly empty panel is not "unbalanced". Electrical Demo 2 showed
 * "A 50 VA, B 180 VA → B is 135% above the average" on a panel with two
 * receptacles. The warning now needs both the percentage target and an
 * absolute floor in VA.
 */
import { CONNECTED_LOAD_ONLY, ElectricalLoadEngine, PHASE_UNBALANCE_FLOOR_VA, phaseUnbalance } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function panelWith(loads: readonly { readonly slot: number; readonly va: number }[]): Building {
  const b = new Building();
  b.place("p1", "panel208", { panel_name: "P1" });
  loads.forEach(({ slot, va }, i) => {
    b.place(`r${i}`, "receptacle", { voltage: 120, load_va: va }, `R-${i}`);
    b.ok({ type: "create_service_link", linkId: `c${i}`, sourceId: "p1", positions: [slot], members: [{ elementId: `r${i}` }] });
  });
  return b;
}

function unbalancedFindings(b: Building): string[] {
  const r = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).report(b.head, "p1");
  if (!r) throw new Error("no report for P1");
  return r.findings.filter((f) => f.kind === "unbalanced").map((f) => f.message);
}

describe("phase unbalance has an absolute floor", () => {
  it("no warning on a nearly empty panel (50 VA on A, 180 VA on B)", () => {
    // Slot 1 is phase A, slot 3 is phase B. Old rule: B is 135% above the average → warning.
    expect(unbalancedFindings(panelWith([{ slot: 1, va: 50 }, { slot: 3, va: 180 }]))).toEqual([]);
  });

  it("still warns when the spread is real (percentage and VA both past the line)", () => {
    // Slots 1, 7, 13 are all phase A on a 3-phase panel.
    const msgs = unbalancedFindings(panelWith([{ slot: 1, va: 1000 }, { slot: 7, va: 1000 }, { slot: 13, va: 1000 }, { slot: 3, va: 180 }]));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/^P1's phases are unbalanced: A 3,000 VA, B 180 VA, C 0 VA; A is \d+% above the average/);
  });

  it("phaseUnbalance: the floor and the percentage are both required", () => {
    expect(phaseUnbalance([{ va: 50 }, { va: 180 }, { va: 0 }])).toBeNull();
    // 30% off the average but only 300 VA: below the floor.
    expect(phaseUnbalance([{ va: 1300 }, { va: 1000 }, { va: 700 }])).toBeNull();
    // 1,500 VA off but only 5% of a large average: below the percentage.
    expect(phaseUnbalance([{ va: 31_500 }, { va: 30_000 }, { va: 28_500 }])).toBeNull();
    const hit = phaseUnbalance([{ va: 6000 }, { va: 3000 }, { va: 3000 }]);
    expect(hit?.offVa).toBe(2000);
    expect(hit?.offVa).toBeGreaterThanOrEqual(PHASE_UNBALANCE_FLOOR_VA);
    expect(hit?.fraction).toBeCloseTo(0.5, 6);
  });
});
