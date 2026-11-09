/**
 * @jest-environment node
 *
 * Round 9 lane Q9 (the product owner's answer 3, FIX FIRST): temporal validity, a generic
 * kernel facility. An answer records what it relied on (its question's
 * elements and requirements, the revision, a digest of the facts). When a
 * later revision changes one of them, the answer reads "May no longer hold —
 * Office 102 changed in Rev N" and the pin shows a warning; nothing reopens.
 * The check is incremental: a revision re-checks only the records filed under
 * the ids it changed. A second record kind adopts the facility by registering
 * a source, with no edit to it.
 *
 * Fails on the first Q9 pass and on round 8b: there was no reliance, no
 * validity index and no "may no longer hold".
 */
import {
  answersTo,
  answerValidity,
  commandSchema,
  planCommit,
  questionPinsOn,
  questionThread,
  registerRelianceSource,
  relianceFor,
  readReliance,
  recordValidity,
  staleRecords,
  validityOf,
  validityStats,
  withUpgradePolicy,
  type Actor,
  type BimElement,
  type ModelState,
} from "../src";
import { floor } from "./g7-fixtures";

const RAO: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };
const EXAMPLE: Actor = { id: "user-example", name: "K. Example", kind: "human" };

let key = 0;
function commit(m: ModelState, command: unknown, actor: Actor = RAO, policy: (f: string) => boolean = () => true): ModelState {
  key += 1;
  const d = withUpgradePolicy(policy, () => planCommit(m, [], { idempotencyKey: `q9-validity-${key}`, baseRevision: m.revision, actor, command: commandSchema.parse(command) }, () => "2026-11-02T10:00:00.000Z"));
  if (!d.ok) throw new Error(d.error.message);
  return d.model;
}

function answered(id: string): ModelState {
  let m = commit(floor(id), { type: "add_question", questions: [{ questionId: "Q-room", text: "Is 102 an office?", askOf: "Architect", anchor: { elementIds: ["S102"] } }] });
  m = commit(m, { type: "answer_question", questionId: "Q-room", answer: "Yes, an office for four." }, EXAMPLE);
  return m;
}

describe("q9 temporal validity", () => {
  it("an answer records what it relied on: the question's elements, the revision and a digest of the facts", () => {
    const m = answered("q9v-a");
    const r = answersTo(m.elements, "Q-room")[0]?.answer.reliance;
    expect(r?.revision).toBe(m.revision - 1);
    expect(r?.facts.map((f) => f.id)).toEqual(["S102"]);
    expect(r?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(answerValidity(m.elements, "Q-room")).toEqual({ state: "holds" });
  });

  it("a later revision that changes what it relied on: 'May no longer hold — Office 102 changed in Rev N'; the question stays answered and its pin warns", () => {
    const m = answered("q9v-b");
    const before = staleRecords(m.elements);
    expect(before.size).toBe(0);
    const edited = commit(m, { type: "edit_space", spaceId: "S102", name: "Storage" });
    const v = answerValidity(edited.elements, "Q-room");
    expect(v).toMatchObject({ state: "may_not_hold", words: `May no longer hold — Storage 102 changed in Rev ${edited.revision}` });
    expect(questionThread(edited.elements, "Q-room")?.question.status).toBe("answered");
    expect(questionPinsOn(edited, "L1" as never).find((p) => p.questionId === "Q-room")?.mayNoLongerHold).toBe(true);
  });

  it("an edit to something else keeps it holding, and the check is incremental: only the records filed under the changed ids are re-checked", () => {
    const m = answered("q9v-c");
    staleRecords(m.elements);
    const other = commit(m, { type: "edit_space", spaceId: "S104", name: "Archive" });
    expect(answerValidity(other.elements, "Q-room")).toEqual({ state: "holds" });
    expect(validityStats(other.elements)).toMatchObject({ filed: 1, rechecks: 0, stale: 0 });
    const relied = commit(other, { type: "edit_space", spaceId: "S102", name: "Open office" });
    expect(validityStats(relied.elements)).toMatchObject({ filed: 1, rechecks: 1, stale: 1 });
  });

  it("the same facts again (undo, or set back) hold again: the digest decides, not the version", () => {
    const m = answered("q9v-d");
    staleRecords(m.elements);
    const changed = commit(m, { type: "edit_space", spaceId: "S102", name: "Storage" });
    const back = commit(changed, { type: "edit_space", spaceId: "S102", name: "Office" });
    expect(answerValidity(changed.elements, "Q-room").state).toBe("may_not_hold");
    expect(answerValidity(back.elements, "Q-room")).toEqual({ state: "holds" });
  });

  it("a removed element is named as removed", () => {
    const m = answered("q9v-e");
    const r = readReliance(answersTo(m.elements, "Q-room")[0]?.answer.reliance);
    if (!r) throw new Error("no reliance");
    const { S102: _gone, ...rest } = m.elements;
    expect(validityOf(rest, r, m.elements)).toMatchObject({ state: "may_not_hold", words: "May no longer hold — Office 102 was removed" });
  });

  it("an older server stores no reliance (the peer doesn't read it) and the answer has nothing to check", () => {
    let m = commit(floor("q9v-f"), { type: "add_question", questions: [{ questionId: "Q-room", text: "Is 102 an office?", askOf: "Architect", anchor: { elementIds: ["S102"] } }] });
    m = commit(m, { type: "answer_question", questionId: "Q-room", answer: "Yes." }, EXAMPLE, (f) => f !== "validity:reliance");
    expect(answersTo(m.elements, "Q-room")[0]?.answer.reliance).toBeUndefined();
    expect(answerValidity(commit(m, { type: "edit_space", spaceId: "S102", name: "Storage" }).elements, "Q-room")).toEqual({ state: "holds" });
  });

  it("generic: another record kind adopts it by registering a source, with no edit to the facility", () => {
    const m0 = floor("q9v-g");
    const approval = { id: "APR-1", kind: "test_approval", version: 1, authoredRev: {}, reliance: relianceFor(m0, { elementIds: ["W-12"] }) } as unknown as BimElement;
    registerRelianceSource({ name: "test_approval", kinds: ["test_approval"], relianceOf: (el) => readReliance((el as unknown as { reliance?: unknown }).reliance) });
    const m: ModelState = { ...m0, elements: { ...m0.elements, "APR-1": approval } };
    expect(recordValidity(m.elements, "APR-1")).toEqual({ state: "holds" });
    const wall = m.elements["W-12"];
    if (!wall) throw new Error("no wall");
    const moved = { ...m.elements, "W-12": { ...wall, version: wall.version + 1, start: { x: 4100, y: 2000 } } as unknown as BimElement };
    expect(recordValidity(moved, "APR-1").state).toBe("may_not_hold");
  });
});
