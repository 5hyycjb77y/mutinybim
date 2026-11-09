/**
 * @jest-environment node
 *
 * Round 8b lane B: `changedBetween` (the server's `changed_between`) equals a
 * full rebuild on 200 random edits: every id whose record differs in version
 * or presence between the two rebuilt models, plus only ids that were created
 * and removed again inside the range (absent at both ends). And Main vs a branch
 * covers both sides' changes. Fails on round 8's code: neither function exists.
 */
import { changedBetween, changedMainVsBranch, type ModelState } from "@permitzip/bim-kernel";
import { randomHistory, rng } from "./b8-fixtures";

function rebuiltDiff(a: ModelState, b: ModelState): string[] {
  const ids = new Set([...Object.keys(a.elements), ...Object.keys(b.elements)]);
  return [...ids].filter((id) => a.elements[id]?.version !== b.elements[id]?.version || !a.elements[id] !== !b.elements[id]).sort();
}

describe("b8-changed-between", () => {
  const { head, snapshots, changesets } = randomHistory(200, 82);

  it("equals the rebuilt diff for 60 random revision pairs", () => {
    const next = rng(5);
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(next() * (head.revision + 1));
      const y = Math.floor(next() * (head.revision + 1));
      const [from, to] = x <= y ? [x, y] : [y, x];
      const a = snapshots[from];
      const b = snapshots[to];
      if (!a || !b) throw new Error("missing snapshot");
      const got = changedBetween(changesets, from, to);
      const diff = rebuiltDiff(a, b);
      expect(got.filter((id) => diff.includes(id))).toEqual(diff);
      for (const id of got.filter((id) => !diff.includes(id))) {
        expect(a.elements[id]).toBeUndefined();
        expect(b.elements[id]).toBeUndefined();
      }
    }
  });

  it("Main vs a branch: what Main changed after the base plus what the branch changed", () => {
    const main = randomHistory(30, 83);
    const branch = randomHistory(12, 84, "b8-main~b1");
    const base = 10;
    const ids = changedMainVsBranch({ baseRevision: base, mainRevision: 30, mainChangesets: main.changesets, branchHead: 12, branchChangesets: branch.changesets });
    const expected = [...new Set([...changedBetween(main.changesets, base, 30), ...changedBetween(branch.changesets, base, 12)])].sort();
    expect(ids).toEqual(expected);
  });
});
