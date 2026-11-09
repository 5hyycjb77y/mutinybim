/**
 * @jest-environment node
 *
 * Round 11 L11 (product owner answer 1), the overlay read:
 * - l11-overlay-differences: added, removed and changed records with their
 *   values, against the common ancestor, only the ids either side changed;
 * - l11-overlay-settled: an accept back, and a design edit that cites the
 *   difference, each settle it.
 * Fails on round 10's code: there is no compare between two copies.
 */
import { compareLineages, lineageDifferenceId } from "../src/lineages/compare";
import { acceptBack } from "../src/lineages/acts";
import { Copies, level } from "./l11-fixtures";

function contractorCopy() {
  const c = new Copies("design", [level("L1", "Level 1"), level("L2", "Level 2", 3000), level("L3", "Level 3", 6000), level("L9", "Untouched", 9000)]);
  c.fork("gc", "design", "shop"); // pinned at 0
  c.edit("gc", { set: [level("L2", "Level 2", 3050)] }); // changed (elevation)
  c.edit("gc", { set: [level("L5", "Mezzanine", 1500)] }); // added
  c.edit("gc", { remove: ["L3"] }); // removed
  c.edit("design", { set: [level("L1", "Level 1 (ground)")] }); // design moved on
  return c;
}

describe("l11-overlay-differences", () => {
  it("lists added, removed and changed records with values, against the common ancestor", () => {
    const c = contractorCopy();
    const { ancestor, differences } = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0));
    expect(ancestor).toEqual({ lineageId: "design", revision: 0 });
    const byId = Object.fromEntries(differences.map((d) => [d.recordId, d]));
    expect(Object.keys(byId)).toEqual(["L1", "L2", "L3", "L5"]); // never the untouched L9
    expect(byId["L2"]).toMatchObject({ kind: "level", change: "changed", changedOn: "b", fields: [{ key: "elevationMm", before: 3000, after: 3050 }] });
    expect(byId["L5"]).toMatchObject({ change: "added", changedOn: "b" });
    expect(byId["L3"]).toMatchObject({ change: "removed", changedOn: "b" });
    expect(byId["L1"]).toMatchObject({ change: "changed", changedOn: "a", fields: [{ key: "name", before: "Level 1 (ground)", after: "Level 1" }] });
    for (const d of differences) expect(d.settled).toBeUndefined();
  });

  it("reads a record both sides changed the same way as unchanged", () => {
    const c = contractorCopy();
    c.edit("design", { set: [level("L2", "Level 2", 3050)] });
    const d = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0)).differences.find((x) => x.recordId === "L2");
    expect(d).toMatchObject({ change: "unchanged", changedOn: "both" });
    expect(d?.fields).toBeUndefined();
  });

  it("gives a difference an id that stays while the copy's record stays, and changes when the copy edits it again", () => {
    const c = contractorCopy();
    const first = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0)).differences.find((x) => x.recordId === "L2");
    c.edit("design", { set: [level("L1", "Level 1 (G)")] });
    const second = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0)).differences.find((x) => x.recordId === "L2");
    expect(second?.id).toBe(first?.id);
    c.edit("gc", { set: [level("L2", "Level 2", 3060)] });
    const third = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0)).differences.find((x) => x.recordId === "L2");
    expect(third?.id).not.toBe(first?.id);
    expect(third?.id).toBe(lineageDifferenceId({ lineageId: "design", revision: 0 }, "L2", c.head("gc").elements["L2"] ?? null));
  });
});

describe("l11-overlay-settled", () => {
  it("an accept back settles the differences it took", () => {
    const c = contractorCopy();
    const result = acceptBack({ lookup: c.lookup, child: c.side("gc", 0), target: c.side("design", 0), recordIds: ["L5"] });
    if (!result.ok) throw new Error("expected the accept back to land");
    c.commit("design", result.landing);
    const { differences } = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0), { acts: [{ ref: "signoff:41", act: result.act }] });
    const l5 = differences.find((d) => d.recordId === "L5");
    expect(l5).toMatchObject({ change: "unchanged", changedOn: "both", settled: { by: "accepted_back", actRef: "signoff:41" } });
    expect(differences.find((d) => d.recordId === "L2")?.settled).toBeUndefined();
  });

  it("an accept back of an earlier version of the record doesn't settle a later one", () => {
    const c = contractorCopy();
    const result = acceptBack({ lookup: c.lookup, child: c.side("gc", 0), target: c.side("design", 0), recordIds: ["L2"] });
    if (!result.ok) throw new Error("expected the accept back to land");
    c.edit("gc", { set: [level("L2", "Level 2", 3100)] });
    const l2 = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0), { acts: [{ ref: "signoff:42", act: result.act }] }).differences.find((d) => d.recordId === "L2");
    expect(l2?.settled).toBeUndefined();
  });

  it("a design edit whose changeset cites the difference settles it as matched in design", () => {
    const c = contractorCopy();
    const l2 = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0)).differences.find((d) => d.recordId === "L2");
    if (!l2) throw new Error("no L2 difference");
    const cs = c.edit("design", { set: [level("L2", "Level 2", 3050)], cites: [l2.id] });
    const after = compareLineages(c.lookup, c.side("design", 0), c.side("gc", 0)).differences.find((d) => d.recordId === "L2");
    expect(after).toMatchObject({ id: l2.id, change: "unchanged", settled: { by: "matched_in_design", actRef: `revision:${cs.revision}` } });
  });
});
