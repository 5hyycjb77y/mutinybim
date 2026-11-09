/**
 * @jest-environment node
 *
 * Round 8b lane B: a branch from version N reads N's elements and none of
 * Main's later edits, and shares every element those edits didn't touch.
 * Fails on round 8's code: there is no forkState.
 */
import { ForkHistoryError, canonicalJson, changesetTouchedIds, forkState, type Changeset } from "@permitzip/bim-kernel";
import { randomHistory } from "./b8-fixtures";

describe("b8-fork-from-revision", () => {
  const history = randomHistory(40);
  const { head, snapshots, changesets } = history;

  it("from the head: the head itself (no copy)", () => {
    expect(forkState(head, head.revision, changesets)).toBe(head);
  });

  it.each([0, 1, 7, 20, 39])("from version %i: exactly that version's elements and connections", (n) => {
    const at = forkState(head, n, changesets.filter((cs) => cs.revision > n));
    const expected = snapshots[n];
    if (!expected) throw new Error(`no snapshot at ${n}`);
    expect(at.revision).toBe(n);
    expect(canonicalJson(at.elements)).toBe(canonicalJson(expected.elements));
    expect(canonicalJson(at.connections)).toBe(canonicalJson(expected.connections));
  });

  it("shares every element the later edits didn't touch (copy on write)", () => {
    const n = 20;
    const later = changesets.filter((cs) => cs.revision > n);
    const touched = new Set(later.flatMap((cs) => changesetTouchedIds(cs)));
    const at = forkState(head, n, later);
    const untouched = Object.keys(head.elements).filter((id) => !touched.has(id));
    expect(untouched.length).toBeGreaterThan(0);
    for (const id of untouched) expect(at.elements[id]).toBe(head.elements[id]);
  });

  it("refuses plainly when history is missing or unrecorded", () => {
    const later = changesets.filter((cs) => cs.revision > 10);
    expect(() => forkState(head, 10, later.slice(1))).toThrow(ForkHistoryError);
    const noBefore: Changeset[] = later.map((cs) => (cs.revision === 15 ? { ...cs, before: undefined } : cs));
    expect(() => forkState(head, 10, noBefore)).toThrow(/didn't record what it replaced/);
    expect(() => forkState(head, head.revision + 1, [])).toThrow(/newer than this model/);
  });
});
