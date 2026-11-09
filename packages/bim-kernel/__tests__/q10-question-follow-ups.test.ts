/**
 * @jest-environment node
 *
 * Round 10 lane Q10 (BUILD ON Q9 custody and validity):
 *
 * - A forward names one person as the new addressee (`questions:forward_person`);
 *   a peer without the feature refuses a forward to a person in plain words, and
 *   an older peer's own edits keep the stored person byte for byte.
 * - The forward history and the people a question is or was asked of read as data.
 * - Which answers one edit made stale, from the edit's changed ids only (an
 *   area-loaded session never reports an unloaded element as removed).
 *
 * Fails on round 9: `questionForwards`, `questionAddresseePeople`,
 * `answersMadeStaleByEdit` and `QUESTION_FORWARD_PERSON_FEATURE` don't exist, and a
 * forward to a person saved on a peer that can't say it stores it.
 */
import {
  QUESTION_FORWARD_PERSON_FEATURE,
  answersMadeStaleByEdit,
  answersTo,
  commandSchema,
  executeCommand,
  planCommit,
  questionAddresseePeople,
  questionForwards,
  questionThread,
  staleRecords,
  withUpgradePolicy,
  type Actor,
  type BimElement,
  type ModelState,
} from "../src";
import { floor } from "./g7-fixtures";

const RAO: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };
const EXAMPLE: Actor = { id: "user-example", name: "K. Example", kind: "human" };
const LEE_AGENT: Actor = { id: "agent:user-lee:run-7", name: "Agent", kind: "agent" };
const OLDER = (f: string) => f !== QUESTION_FORWARD_PERSON_FEATURE;
const ARCH = { provider: "host", subject: "user-arch", displayName: "A. Arch" };

let tick = 0;
type Done = { readonly model: ModelState; readonly changedIds: readonly string[] };

/** Committed as the model server does (versions move), with the ids the changeset touched. */
function exec(m: ModelState, command: unknown, actor: Actor, policy: (f: string) => boolean = () => true): Done {
  tick += 1;
  const at = new Date(Date.UTC(2026, 10, 2, 12, 0, tick)).toISOString();
  const d = withUpgradePolicy(policy, () => planCommit(m, [], { idempotencyKey: `q10-${tick}`, baseRevision: m.revision, actor, command: commandSchema.parse(command) }, () => at));
  if (!d.ok) throw new Error(`${(command as { type: string }).type}: ${d.error.message}`);
  return { model: d.model, changedIds: [...d.changeset.elements.map((e) => e.id), ...(d.changeset.removedIds ?? [])] };
}

const run = (m: ModelState, command: unknown, actor: Actor, policy?: (f: string) => boolean) => exec(m, command, actor, policy).model;

function refused(m: ModelState, command: unknown, actor: Actor, policy: (f: string) => boolean): string {
  const r = withUpgradePolicy(policy, () => executeCommand(m, commandSchema.parse(command), { actorId: actor.id, actor }));
  if (r.ok) throw new Error("saved; expected a refusal");
  return r.error.message;
}

const asked = (id: string) => run(floor(id), { type: "add_question", questions: [{ questionId: "Q-beam", text: "Is there a beam over 102?", askOf: "Structural", askOfAuthor: { provider: "host", subject: "user-example", displayName: "K. Example" }, anchor: { elementIds: ["S102"] } }] }, RAO);

describe("q10 forward to a person", () => {
  it("q10-forward-to-person: the forward names the person, the former addressee is kept, and both read as data", () => {
    const m = run(asked("q10-a"), { type: "forward_question", questionId: "Q-beam", askOf: "A. Arch", askOfAuthor: ARCH, note: "Architect's call" }, EXAMPLE);
    const q = questionThread(m.elements, "Q-beam")?.question;
    expect(q?.askOfAuthor).toMatchObject({ subject: "user-arch", kind: "person", displayName: "A. Arch" });
    expect(q?.formerAddressees).toEqual([{ label: "Structural", author: expect.objectContaining({ subject: "user-example" }) }]);
    const forwards = questionForwards(m.elements, "Q-beam");
    expect(forwards).toHaveLength(1);
    expect(forwards[0]).toMatchObject({ questionId: "Q-beam", from: { label: "Structural" }, to: { label: "A. Arch", author: { subject: "user-arch" } }, by: { subject: "user-example" }, note: "Architect's call" });
    expect(questionAddresseePeople(m.elements, "Q-beam").map((a) => a.subject)).toEqual(["user-arch", "user-example"]);
  });

  it("an agent forwarding records itself acting for its person", () => {
    const m = run(asked("q10-b"), { type: "forward_question", questionId: "Q-beam", askOf: "A. Arch", askOfAuthor: ARCH }, LEE_AGENT);
    expect(questionForwards(m.elements, "Q-beam")[0]?.by).toMatchObject({ kind: "agent", onBehalfOf: { subject: "user-lee" } });
  });

  it("q10-mixed-version: a peer without questions:forward_person refuses a forward to a person in plain words; by name still works", () => {
    const m = asked("q10-c");
    expect(refused(m, { type: "forward_question", questionId: "Q-beam", askOf: "A. Arch", askOfAuthor: ARCH }, EXAMPLE, OLDER)).toBe(
      "Forwarding Q-1 'Is there a beam over 102?' to one named person can't be saved yet: the model server this model is open on is an older version that doesn't store who a question was forwarded to. Forward it to A. Arch by name instead, or try again once the server is updated",
    );
    const byName = run(m, { type: "forward_question", questionId: "Q-beam", askOf: "Architect" }, EXAMPLE, OLDER);
    expect(questionThread(byName.elements, "Q-beam")?.question.askOf).toBe("Architect");
  });

  it("q10-old-peer-keeps-forward: an older peer's own reply keeps the forwarded person and the former addressees byte for byte", () => {
    const m = run(asked("q10-d"), { type: "forward_question", questionId: "Q-beam", askOf: "A. Arch", askOfAuthor: ARCH }, EXAMPLE);
    const before = questionThread(m.elements, "Q-beam")?.question;
    const after = run(m, { type: "reply_question", questionId: "Q-beam", text: "Thanks, looking" }, RAO, OLDER);
    const kept = questionThread(after.elements, "Q-beam")?.question;
    expect(JSON.stringify(kept?.askOfAuthor)).toBe(JSON.stringify(before?.askOfAuthor));
    expect(JSON.stringify(kept?.formerAddressees)).toBe(JSON.stringify(before?.formerAddressees));
    expect(questionForwards(after.elements, "Q-beam")).toHaveLength(1);
  });

  it("nothing to read on an element that isn't a question", () => {
    const m = asked("q10-e");
    expect(questionForwards(m.elements, "S102")).toEqual([]);
    expect(questionAddresseePeople(m.elements, "nope")).toEqual([]);
  });
});

describe("q10 stale answers after one edit", () => {
  const answered = (id: string) => run(asked(id), { type: "answer_question", questionId: "Q-beam", answer: "Yes, a W12." }, EXAMPLE);

  it("q10-stale-after-agent-edit: an agent's edit to what an answer relied on names the answer once, with the page's key", () => {
    const m = answered("q10-s1");
    const answerId = answersTo(m.elements, "Q-beam")[0]?.id;
    const edit = exec(m, { type: "edit_space", spaceId: "S102", name: "Storage" }, LEE_AGENT);
    const stale = answersMadeStaleByEdit(m.elements, edit.model.elements, edit.changedIds);
    expect(stale).toEqual([{ answerId, questionId: "Q-beam", words: expect.stringMatching(/^May no longer hold — Storage 102 changed/), relianceDigest: answersTo(m.elements, "Q-beam")[0]?.answer.reliance?.digest }]);
    // The model-wide index agrees (the same answer is stale on the new head).
    expect([...staleRecords(edit.model.elements).keys()]).toEqual([answerId]);
    // Already stale: the next edit to the same room isn't a new "made stale".
    const again = exec(edit.model, { type: "edit_space", spaceId: "S102", name: "Store" }, LEE_AGENT);
    expect(answersMadeStaleByEdit(edit.model.elements, again.model.elements, again.changedIds)).toEqual([]);
  });

  it("an edit to something else makes nothing stale", () => {
    const m = answered("q10-s2");
    const edit = exec(m, { type: "edit_space", spaceId: "S104", name: "Archive" }, LEE_AGENT);
    expect(answersMadeStaleByEdit(m.elements, edit.model.elements, edit.changedIds)).toEqual([]);
  });

  it("an area-loaded session: a relied-on element that isn't loaded is never reported as removed", () => {
    const m = answered("q10-s3");
    // The agent's session loaded only part of the model: S102 isn't in it, and it edits S104.
    const { S102: _absent, ...partialBefore } = m.elements as Record<string, BimElement>;
    const edit = exec(m, { type: "edit_space", spaceId: "S104", name: "Archive" }, LEE_AGENT);
    const { S102: _alsoAbsent, ...partialAfter } = edit.model.elements as Record<string, BimElement>;
    expect(answersMadeStaleByEdit(partialBefore, partialAfter, edit.changedIds)).toEqual([]);
  });

  it("an edit that removes what an answer relied on says it was removed", () => {
    const m = answered("q10-s4");
    const answerId = answersTo(m.elements, "Q-beam")[0]?.id;
    const before = m.elements as Record<string, BimElement>;
    const { S102: _gone, ...after } = before;
    expect(answersMadeStaleByEdit(before, after, ["S102"])).toEqual([expect.objectContaining({ answerId, words: expect.stringMatching(/was removed/) })]);
  });
});
