/**
 * @jest-environment node
 *
 * Round 8b lane O: the `quantity_delta` read on lane B's history readers.
 * - Main vs a branch: Main removed a door after the branch started, the
 *   branch added a wall with a door; the read reports the branch head
 *   against Main's head and equals the delta over the two full models.
 * - Between two revisions of one model: equals the full-model delta.
 * - Refusals in words: backwards range, "compare with Main" on Main.
 *
 * Fails on round 8's code: there is no `quantity_delta` read.
 */
import { asElementId, changedBetween, hostedIds, quantityDeltasBetween, type ModelState } from "@permitzip/bim-kernel";
import { answerQuantityDelta, branchHistory, storeHistory, QUANTITY_DELTA_WORDS, type HistorySource } from "../src";
import { historyOf, type History } from "../../bim-kernel/__tests__/o8-fixtures";
import { FT, openingRecord, threeOffices, wallRecord } from "../../bim-kernel/__tests__/q7-fixtures";

function source(h: History, fromRevision = 0): HistorySource {
  return {
    head: async () => h.head,
    changesSince: async (revision: number) => h.changesets.filter((cs) => cs.revision > Math.max(revision, fromRevision)),
  };
}

const labels = (ds: readonly { readonly label: string }[]) => ds.map((d) => d.label).sort();

describe("o8-delta-main-vs-branch", () => {
  const base = threeOffices();
  // Main: version 1 re-types nothing (a no-op edit on W-11), version 2 removes D-12.
  const main = historyOf(base, [{ written: [base.elements["W-11"] ?? wallRecord("W-11", { x: 0, y: 0 }, { x: 0, y: FT })] }, { removedIds: ["D-12"] }], "main");
  const baseRevision = 1;
  const atBase: ModelState = main.snapshots[baseRevision] ?? base;
  // Branch from version 1: adds W-30 with a door.
  const branch = historyOf(atBase, [{ written: [wallRecord("W-30", { x: 0, y: 40 * FT }, { x: 25 * FT, y: 40 * FT }, { typeId: asElementId("t-1hr") }), openingRecord("D-30", "W-30", "door", 3 * FT, 7 * FT)] }], "branch");
  const mainReader = storeHistory(source(main));
  const branchReader = branchHistory({ baseRevision }, source(branch, baseRevision), mainReader);

  it("branch head against Main's head equals the full-model delta", async () => {
    const out = await answerQuantityDelta(
      { type: "quantity_delta", requestId: "q1", from: { model: "main", revision: "head" }, to: "head", all: true },
      { history: branchReader, main: mainReader, branch: { baseRevision }, hostedNow: (h) => hostedIds(branch.head.elements, h) },
    );
    if (out?.type !== "quantity_delta_result") throw new Error(JSON.stringify(out));
    expect(out).toMatchObject({ fromMain: true, fromRevision: 2, toRevision: 2 });
    const ids = [...new Set([...changedBetween(main.changesets, baseRevision, 2), ...changedBetween(branch.changesets, baseRevision, 2)])];
    const full = quantityDeltasBetween(main.head.elements, branch.head.elements, ids, { all: true });
    expect(labels(out.deltas)).toEqual(labels(full));
    // The branch still has D-12 (Main removed it) and adds D-30: two doors more than Main.
    expect(labels(out.deltas)).toContain("+2 doors");
    expect(labels(out.deltas)).toContain("+25 ft of 1-hour wall");
    expect(out.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("between two revisions of Main equals the full-model delta", async () => {
    const out = await answerQuantityDelta({ type: "quantity_delta", requestId: "q2", from: 0, to: "head" }, { history: mainReader, hostedNow: (h) => hostedIds(main.head.elements, h) });
    if (out?.type !== "quantity_delta_result") throw new Error(JSON.stringify(out));
    const full = quantityDeltasBetween(base.elements, main.head.elements, changedBetween(main.changesets, 0, 2));
    expect(labels(out.deltas)).toEqual(labels(full));
    expect(labels(out.deltas)).toContain("-1 door");
  });

  it("refuses in words: backwards, and comparing with Main on Main", async () => {
    expect(await answerQuantityDelta({ type: "quantity_delta", requestId: "q3", from: 2, to: 1 }, { history: mainReader })).toEqual({ type: "quantity_delta_refused", requestId: "q3", reason: QUANTITY_DELTA_WORDS.backwards });
    expect(await answerQuantityDelta({ type: "quantity_delta", requestId: "q4", from: { model: "main", revision: 0 }, to: "head" }, { history: mainReader })).toEqual({ type: "quantity_delta_refused", requestId: "q4", reason: QUANTITY_DELTA_WORDS.notOnBranch });
    expect(await answerQuantityDelta({ type: "state_at", requestId: "q5" }, { history: mainReader })).toBeNull();
  });
});
