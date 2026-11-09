/**
 * @jest-environment node
 *
 * Round 11 lane F11 (D2): an add-on adds its own check to the one list with
 * no kernel edit, as one row of `FINDING_SOURCE_POINT` (`kernel.finding_source`
 * v1, `<pack>.<name>`). The ledger reads it with the built-in sources, moves
 * it by the changed ids when the row says how, drops its findings when the
 * pack leaves the set, and a pack can't replace a built-in row.
 *
 * Fails on round 10's code: the point doesn't exist.
 */
import { commandSchema, planCommit, withUpgradePolicy, type Actor, type ModelState } from "../src";
import { localFindingId, findingRefId, type FindingRef } from "../src/findings/ref";
import { BUILTIN_FINDING_SOURCE_IDS, FINDING_SOURCE_POINT, FindingLedger, findingSourceRowProblems, type FindingReadContext, type FindingSourceRow } from "../src/findings/api";
import { bindModelPacks, contribute, definePack, PackSet, PACK_CONTRACT_VERSION, unbindModelPacks } from "../src/packs";
import { floor } from "./g7-fixtures";

const ID = "f11-addon";
const RAO: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };

/** A test add-on's check: an office named "Office" with fewer than five occupants is flagged (made up for the test). */
function smallOffices(ctx: FindingReadContext): FindingRef[] {
  const out: FindingRef[] = [];
  for (const el of Object.values(ctx.model.elements)) {
    if (el.kind !== "space" || el.name !== "Office") continue;
    const occupants = Reflect.get(el, "occupants");
    if (typeof occupants === "number" && occupants < 5) out.push({ id: findingRefId("f11zz.small_office", localFindingId("f11zz.small_office", [el.id])), source: { kind: "f11zz.small_office", id: "small_office", version: "1" }, severity: "info", subjects: [el.id], lineageId: ctx.lineageId, revision: ctx.model.revision, words: `${el.name} ${el.number} seats fewer than five` });
  }
  return out;
}

let changedCalls = 0;
const ROW: FindingSourceRow = {
  id: "f11zz.small_office",
  label: "Small offices (test)",
  all: smallOffices,
  changed(ctx) {
    changedCalls += 1;
    if (!ctx.changedIds.some((id) => ctx.model.elements[id]?.kind === "space" || ctx.previous.elements[id]?.kind === "space")) return null;
    return "reread";
  },
};
const PACK = definePack({ id: "f11zz", name: "Small offices (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(FINDING_SOURCE_POINT, [ROW])]);

function commit(m: ModelState, command: unknown): { model: ModelState; changed: string[] } {
  const d = withUpgradePolicy(() => true, () => planCommit(m, [], { idempotencyKey: `f11-addon-${m.revision}`, baseRevision: m.revision, actor: RAO, command: commandSchema.parse(command) }, () => "2026-11-02T10:00:00.000Z"));
  if (!d.ok) throw new Error(d.error.message);
  return { model: d.model, changed: d.changeset.elements.map((e) => e.id as string) };
}

afterEach(() => unbindModelPacks(ID));

describe("f11-addon-source-zero-kernel-edits", () => {
  it("the add-on's row joins the built-in sources; its findings are in the one list", () => {
    bindModelPacks(ID, PackSet.create([PACK]));
    const ledger = new FindingLedger();
    const m = floor(ID);
    ledger.open(m);
    expect(ledger.findings().filter((f) => f.source.kind === "f11zz.small_office").map((f) => f.subjects[0])).toEqual(["S101", "S102", "S103"]);
    expect(BUILTIN_FINDING_SOURCE_IDS).toEqual(["requirement", "question", "reliance", "divergence"]);
    expect(findingSourceRowProblems([ROW])).toEqual([]);
  });

  it("moves by the changed ids: an unrelated edit asks the row and reads nothing; a space edit re-reads it", () => {
    bindModelPacks(ID, PackSet.create([PACK]));
    const ledger = new FindingLedger();
    let m = floor(ID);
    ledger.open(m);
    changedCalls = 0;
    const wall = commit(m, { type: "add_question", questions: [{ questionId: "Q-1", text: "Paint?", askOf: "Architect", anchor: { elementIds: ["W-12"] } }] });
    ledger.apply(wall.model, wall.changed);
    expect(changedCalls).toBe(1);
    m = wall.model;
    const space = commit(m, { type: "edit_space", spaceId: "S101", name: "Lab" });
    const delta = ledger.apply(space.model, space.changed);
    expect(delta.removed).toEqual([findingRefId("f11zz.small_office", "f11zz.small_office:S101")]);
  });

  it("the pack leaves the set: its findings leave the list; a pack may not replace a built-in row", () => {
    bindModelPacks(ID, PackSet.create([PACK]));
    const ledger = new FindingLedger();
    const m = floor(ID);
    ledger.open(m);
    unbindModelPacks(ID);
    const next = commit(m, { type: "edit_space", spaceId: "S104", name: "Archive" });
    ledger.apply(next.model, next.changed);
    expect(ledger.findings().some((f) => f.source.kind === "f11zz.small_office")).toBe(false);

    expect(() => PackSet.create([definePack({ id: "f11zy", name: "Thief", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(FINDING_SOURCE_POINT, [{ ...ROW, id: "requirement" }])])]).items(FINDING_SOURCE_POINT)).toThrow();
  });
});
