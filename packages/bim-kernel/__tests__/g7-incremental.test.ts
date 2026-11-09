/**
 * @jest-environment node
 *
 * Round 7 lane G: incremental by declared reads. The graph is carried from
 * one revision to the next; an edit re-runs only the (rule, anchor)
 * evaluations whose reads it touched, and an unrelated edit re-runs none.
 * Counted with `graphStats().ruleRuns`, which only a carried state keeps
 * growing (a fresh state would start over at the full count).
 *
 * Fails on the code before round 7: no graph engine, no reverse index.
 */
import { graphStats, requirementsAt, requirementsOf, unbindRequirementsSnapshot } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { bindStudy, floor, run, ZT_PACK } from "./g7-fixtures";

const ID = "g7-incremental";

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
});
afterAll(() => unbindRequirementsSnapshot(ID));

describe("g7 incremental: an edit re-runs only the rules that read it", () => {
  it("counts evaluations: a related edit re-runs a few, an unrelated one re-runs zero", () => {
    const m0 = floor(ID);
    requirementsOf(m0);
    const full = graphStats(m0).ruleRuns;
    expect(full).toBeGreaterThan(10);

    // Office 101 now holds 60 people: only Office 101's rules re-run.
    const m1 = run(m0, { type: "edit_space", spaceId: "S101", occupants: 60 });
    requirementsOf(m1);
    const afterRelated = graphStats(m1).ruleRuns;
    const related = afterRelated - full;
    expect(related).toBeGreaterThan(0);
    expect(related).toBeLessThanOrEqual(6);
    expect(requirementsAt(m1, { kind: "space", id: "S101" }).find((r) => r.key === "arch.exit_count")?.value).toBe(2);

    // A new level nothing reads: zero rules re-run.
    const m2 = run(m1, { type: "create_level", levelId: "L9", name: "Level 9", elevationMm: 30000 });
    requirementsOf(m2);
    const afterUnrelated = graphStats(m2).ruleRuns;
    expect(afterUnrelated - afterRelated).toBe(0);

    // A newer hazard decision for Room 104 re-runs only the two rules that read the hazard there.
    const m3 = run(m2, {
      type: "supersede_determination",
      determinationId: "D-haz-S104",
      newDeterminationId: "D-haz-S104-b",
      value: "light",
      reasoning: "Synthetic test decision: lighter storage.",
      decidedBy: "K. Example",
      decidedAt: "2026-10-31T15:00:00.000Z",
      confidence: "high",
    });
    requirementsOf(m3);
    const hazardRuns = graphStats(m3).ruleRuns - afterUnrelated;
    expect(hazardRuns).toBeGreaterThan(0);
    expect(hazardRuns).toBeLessThanOrEqual(2);
    expect(requirementsAt(m3, { kind: "space", id: "S104" }).find((r) => r.key === "fp.head_count")?.value).toBe(1);
  });
});
