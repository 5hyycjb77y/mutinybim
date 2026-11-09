/**
 * @jest-environment node
 *
 * Round 8b lane B: `stateAt` (the server's `state_at`) equals a full rebuild
 * of the model at that revision on 200 random edits, reading only the asked ids.
 * Fails on round 8's code: there is no stateAt.
 */
import { asElementId, canonicalJson, stateAt } from "@permitzip/bim-kernel";
import { randomHistory, rng } from "./b8-fixtures";

describe("b8-state-at", () => {
  const { head, snapshots, changesets } = randomHistory(200, 81);
  const ids = [...Object.keys(head.elements), "not-an-element"].map(asElementId);

  it("matches the rebuilt model at 60 random revisions and id sets", () => {
    const next = rng(4);
    for (let i = 0; i < 60; i++) {
      const revision = Math.floor(next() * (head.revision + 1));
      const asked = ids.filter(() => next() < 0.6);
      const got = stateAt(head, revision, changesets, asked);
      const rebuilt = snapshots[revision];
      if (!rebuilt) throw new Error(`no snapshot at ${revision}`);
      expect(Object.keys(got).sort()).toEqual([...asked].sort());
      for (const id of asked) expect(canonicalJson(got[id] ?? null)).toBe(canonicalJson(rebuilt.elements[id] ?? null));
    }
  });

  it("at the head it reads the head (no history needed)", () => {
    expect(stateAt(head, head.revision, [], ids)["sd-1"]).toBe(head.elements["sd-1"]);
  });

  it("refuses when the history back to the revision is not kept", () => {
    expect(() => stateAt(head, 10, changesets.slice(20), ids)).toThrow(/no longer kept/);
  });
});
