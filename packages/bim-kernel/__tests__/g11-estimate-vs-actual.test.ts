/**
 * @jest-environment node
 *
 * Round 11 G11 (D3, D4): estimate versus actual is two gates' totals
 * compared by basis on one copy. A wall surveyed after the first freeze
 * moves metres from "not recorded" to "measured"; priced with the reader's
 * own list (in the reader's process; no gate stores money), the cost moves
 * the same way. Fails on round 10's code: no gates to compare.
 */
import type { CostRate, CostSourceDef } from "../src";
import { PackSet, withPackSet } from "../src/packs";
import { compareGates, gateCostByBasis } from "../src/lifecycle/freeze";
import type { GateElement } from "../src/lifecycle/records";
import { floor } from "./g7-fixtures";
import { KS, lifecycle, wall, withElements } from "./g11-fixtures";

const CODE = { system: "firm:cost_codes", code: "TEST-0100" };
const rate: CostRate = { classification: CODE, unitRate: { minor: 15_000, currency: "USD" }, measure: "qto.length", per: "m", provenance: { ownedBy: { party: "owner-dev" }, source: "owner test rates", date: "2026-10-01" } };
const OWNER: CostSourceDef = { id: "book.owner", party: { kind: "developer", id: "owner-dev", label: "Owner" }, basis: "estimate", currency: "USD", effectiveDate: "2026-10-01", visibility: { kind: "party_only" }, rates: () => [rate] };
const SET = PackSet.create([]);

function coded(m: ReturnType<typeof floor>): ReturnType<typeof floor> {
  const walls = Object.values(m.elements).filter((e) => e.kind === "wall");
  return withElements(m, walls.map((w) => ({ ...w, classification: [CODE] })));
}

const gateOf = (m: ReturnType<typeof floor>, id: string): GateElement["gate"] => (m.elements[id] as unknown as GateElement).gate;

describe("g11 estimate versus actual between two gates", () => {
  it("compares quantities by basis, and prices them with the reader's own list", () => {
    let m = coded(floor("g11-eva"));
    m = lifecycle(m, { type: "freeze_stage", gateId: "G-1", stageId: "due_diligence", frozenBy: KS, frozenAt: "2026-11-02T15:00:00Z" });
    // A 4 m wall, surveyed: its record carries the one basis.
    m = withElements(m, [wall("W-40", 0, 6000, 4000, 6000, { classification: [CODE], provenance: { basis: { maturity: "measured", source: { kind: "survey", ref: "Survey 2026-11-03" } } } })]);
    m = lifecycle(m, { type: "freeze_stage", gateId: "G-2", stageId: "feasibility", frozenBy: KS, frozenAt: "2026-11-04T15:00:00Z" });
    const a = gateOf(m, "G-1");
    const b = gateOf(m, "G-2");
    const cmp = withPackSet(SET, () => compareGates(a, b, { sourceId: "book.owner", reader: "owner-dev", extra: [OWNER] }, SET));
    expect(cmp.sameLineage).toBe(true);
    expect(cmp.from).toEqual({ stageId: "due_diligence", revision: a.revision, lineageId: "main" });
    const length = cmp.lines.find((l) => l.group === "code:firm:cost_codes:TEST-0100" && l.measure === "qto.length");
    expect(length).toMatchObject({ before: 28, after: 32, delta: 4 });
    expect(length?.byBasis).toEqual([
      { basis: "measured", before: 0, after: 4 },
      { basis: "not_recorded", before: 28, after: 28 },
    ]);
    // $150.00 per m, in the reader's process.
    expect(cmp.cost).toEqual([
      { basis: "measured", currency: "USD", before: null, after: 60_000 },
      { basis: "not_recorded", currency: "USD", before: 420_000, after: 420_000 },
    ]);
    // Nothing priced was written: the gates hold quantities only.
    expect(a.totals.costByBasis).toBeUndefined();
    expect(b.totals.costByBasis).toBeUndefined();
  });

  it("a party that may not read the list learns nothing, and a basis the list prices nothing of has no amount", () => {
    const m = lifecycle(coded(floor("g11-eva-2")), { type: "freeze_stage", gateId: "G-1", stageId: "due_diligence", frozenBy: KS, frozenAt: "2026-11-02T15:00:00Z" });
    const lines = gateOf(m, "G-1").totals.quantities.lines;
    expect(() => gateCostByBasis(lines, { sourceId: "book.owner", reader: "gc-acme", extra: [OWNER] }, SET)).toThrow(/no price list "book.owner" you can read/);
    const uncoded = lines.filter((l) => !l.group.startsWith("code:"));
    expect(gateCostByBasis(uncoded, { sourceId: "book.owner", reader: "owner-dev", extra: [OWNER] }, SET)).toEqual({});
  });
});
