/**
 * @jest-environment node
 *
 * Round 8b lane N: "What drives the most" in the Checklist header. The
 * ranking is read from the requirements graph's reverse index: an input
 * drives a requirement when the requirement's evaluation (or the evaluation
 * of a rule that relaxed it) read it, never the room it is anchored on.
 * Ranked most first, at most five, then "and N more"; every count equals the
 * one-input answer; an edit re-counts only the anchors it re-derived and the
 * answer equals a ranking counted from scratch.
 *
 * Fails on round 8's code: there was no `graph/sensitivity.ts` (no ranking,
 * no one-input answer).
 */
import { GRAPH_ANSWER_LIMIT, requirementsOf, unbindRequirementsSnapshot, type ModelState } from "../src";
import { SENSITIVITY_EMPTY, sensitivityOf, sensitivityRanking, sensitivityRecounted } from "../src/graph/sensitivity";
import { bindModelPacks, PackSet } from "../src/packs";
import { bindStudy, floor, run, ZT_PACK } from "./g7-fixtures";

const ID = "n8-sensitivity";
const decide = { reasoning: "Synthetic test decision.", decidedBy: "K. Example", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high" as const };

beforeAll(() => {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
  bindModelPacks("n8-empty", PackSet.create([ZT_PACK]));
});
afterAll(() => unbindRequirementsSnapshot(ID));

/** The floor recorded as fully sprinklered (a model-wide design choice). */
function decided(): ModelState {
  const m = floor(ID);
  requirementsOf(m);
  const out = run(m, { type: "record_determination", determinationId: "D-spk", subject: { kind: "model" }, key: "sprinklered", value: true, ...decide });
  requirementsOf(out);
  return out;
}

/** The same record under a new identity: a graph state and counts made from scratch. */
function fresh(m: ModelState): ModelState {
  const copy = { ...m, elements: { ...m.elements } };
  requirementsOf(copy);
  return copy;
}

const shape = (m: ModelState, limit = 50) => {
  const r = sensitivityRanking(m, { limit });
  return { inputs: r.inputs, items: r.items.map((i) => [i.node.id, i.drives, i.open, i.label]) };
};

describe("n8 sensitivity: what drives the most requirements", () => {
  it("ranks inputs by the requirements they drive, five then and N more, in operator words", () => {
    const m = decided();
    const ranking = sensitivityRanking(m);
    expect(ranking.items.length).toBe(GRAPH_ANSWER_LIMIT);
    expect(ranking.more).toBe(ranking.inputs - GRAPH_ANSWER_LIMIT);
    expect(ranking.empty).toBeUndefined();

    // Room 104's hazard drives its hazard class and its head spacing: the most of anything.
    const top = ranking.items[0];
    expect(top).toMatchObject({ node: { kind: "determination", id: "D-haz-S104" }, label: "Room 104 hazard (ordinary_1)", drives: 2 });
    expect(top?.words).toMatch(/^Room 104 hazard \(ordinary_1\) drives 2 requirements; /);
    for (let i = 1; i < ranking.items.length; i++) expect((ranking.items[i - 1]?.drives ?? 0) >= (ranking.items[i]?.drives ?? 0)).toBe(true);

    // Every count is the one-input answer from the reverse index.
    const all = sensitivityRanking(m, { limit: 1000 });
    expect(all.more).toBe(0);
    for (const item of all.items) {
      const one = sensitivityOf(m, item.node.id);
      expect([item.node.id, one.drives, one.open, one.requirements.length]).toEqual([item.node.id, item.drives, item.open, item.drives]);
      expect(one.words).toBe(item.words);
    }
  });

  it("a design choice drives the limit it relaxed; a room never drives what is anchored on it", () => {
    const m = decided();
    const spk = sensitivityOf(m, "D-spk");
    expect(spk).toMatchObject({ node: { kind: "determination", id: "D-spk" }, label: "The model sprinklered (yes)", drives: 1 });
    expect(spk.requirements.map((r) => r.key)).toEqual(["arch.allowable_area"]);

    // Room 104 carries requirements, but none of them is "driven" by the room itself.
    expect(sensitivityOf(m, "S104").drives).toBe(0);
    // Heads and the ceiling drive the head spacing they deliver toward or lower.
    expect(sensitivityOf(m, "SP-14").requirements.map((r) => r.key)).toEqual(["fp.head_count"]);
    expect(sensitivityOf(m, "CLG-104")).toMatchObject({ label: "Ceiling CLG-104 in Room 104", drives: 1 });
    // An id the graph never read drives nothing and says so with a count of zero.
    expect(sensitivityOf(m, "W-30")).toMatchObject({ drives: 0, open: 0, requirements: [] });
  });

  it("an edit re-counts only the anchors it re-derived, and equals counting from scratch", () => {
    const m0 = decided();
    sensitivityRanking(m0, { limit: 50 });
    const anchors = requirementsOf(m0).length;

    // Office 101 becomes storage-occupancy S-1: its corridor separation no longer applies.
    const m1 = run(m0, { type: "supersede_determination", determinationId: "D-occ-S101", newDeterminationId: "D-occ-S101-2", value: "S-1", ...decide });
    requirementsOf(m1);
    const after = shape(m1);
    expect(sensitivityRecounted(m1)).toBeGreaterThan(0);
    expect(sensitivityRecounted(m1)).toBeLessThan(anchors);
    expect(after.items.some(([id]) => id === "D-occ-S101")).toBe(false);
    expect(after).toEqual(shape(fresh(m1)));

    // Asked again on the same revision: answered from the cache, nothing re-counted.
    const again = sensitivityRanking(m1, { limit: 50 });
    expect(sensitivityRecounted(m1)).toBe(0);
    expect(again).toBe(sensitivityRanking(m1, { limit: 50 }));

    // Removing the design choice takes it off the list.
    const m2 = run(m1, { type: "supersede_determination", determinationId: "D-spk", newDeterminationId: "D-spk-2", value: false, ...decide });
    requirementsOf(m2);
    expect(shape(m2).items.some(([id]) => id === "D-spk")).toBe(false);
    expect(shape(m2)).toEqual(shape(fresh(m2)));
  });

  it("a model nothing applies to says so in words", () => {
    const m = floor("n8-empty");
    requirementsOf(m);
    expect(sensitivityRanking(m)).toEqual({ items: [], more: 0, inputs: 0, empty: SENSITIVITY_EMPTY });
  });
});
