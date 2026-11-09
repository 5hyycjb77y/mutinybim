/**
 * @jest-environment node
 *
 * Round 9 lane Q9 (FIX FIRST): question threads. Anyone asks anyone; the
 * person asked can answer with an outcome, decline or mark it not in scope;
 * anyone replies, and every entry names its author (`AuthorRef`); only the
 * asker (or an agent for the asker) asks again; declined and not-in-scope
 * questions leave the plan but stay in the list; nothing is ever late.
 *
 * Fails on round 8b's code: `reply_question` and `decline_question` don't
 * parse, answers have no outcome or author, `askedByAuthor` isn't written,
 * anyone may reopen any question, and declined questions still pin.
 */
import {
  allQuestions,
  answersTo,
  commandSchema,
  planCommit,
  executeCommand,
  isAsker,
  mayAskAgain,
  questionPinsOn,
  questionThread,
  QUESTION_OUTCOME_POINT,
  withUpgradePolicy,
  type Actor,
  type Command,
  type ModelState,
  type QuestionOutcomeDef,
} from "../src";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { floor } from "./g7-fixtures";

const ROUND_9 = () => true;
const ROUND_8B = (f: string) => f !== "questions:threads" && f !== "questions:answers";

const RAO: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };
const EXAMPLE: Actor = { id: "user-example", name: "K. Example", kind: "human" };
const CLIENT: Actor = { id: "user-client", name: "Owner's rep", kind: "human" };
const RAO_AGENT: Actor = { id: "agent:user-rao:run-1", name: "Agent", kind: "agent" };
const EXAMPLE_AGENT: Actor = { id: "agent:user-example:run-2", name: "Agent", kind: "agent" };

let clock = 0;
function at(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 2, 9, 0, clock)).toISOString();
}

function run(m: ModelState, command: Command, actor: Actor, policy: (f: string) => boolean = ROUND_9): ModelState {
  const r = withUpgradePolicy(policy, () => executeCommand(m, commandSchema.parse(command), { actorId: actor.id, actor, at: at() }));
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

function refused(m: ModelState, command: Command, actor: Actor, policy: (f: string) => boolean = ROUND_9): string {
  const r = withUpgradePolicy(policy, () => executeCommand(m, commandSchema.parse(command), { actorId: actor.id, actor, at: at() }));
  if (r.ok) throw new Error(`${command.type} was saved; expected a refusal`);
  return r.error.message;
}

function ask(m: ModelState, actor: Actor, questionId = "Q-beam", askOf = "Structural"): ModelState {
  return run(m, { type: "add_question", questions: [{ questionId, text: "Is there a beam over 102?", askOf, anchor: { elementIds: ["S102"] } }] } as Command, actor);
}

describe("q9 question threads", () => {
  it("q9-thread-replies: the asker and the person asked reply in turn; each entry carries its author, oldest first", () => {
    let m = ask(floor("q9-a"), RAO);
    m = run(m, { type: "reply_question", questionId: "Q-beam", text: "Which beam? There are two." } as Command, EXAMPLE);
    m = run(m, { type: "reply_question", questionId: "Q-beam", text: "The one at gridline 3." } as Command, RAO);
    m = run(m, { type: "answer_question", questionId: "Q-beam", answer: "W12x26 at gridline 3.", outcome: "clarification" } as Command, EXAMPLE);
    m = run(m, { type: "reply_question", questionId: "Q-beam", text: "Thanks." } as Command, RAO_AGENT);
    const thread = questionThread(m.elements, "Q-beam");
    expect(thread?.question.askedByAuthor).toMatchObject({ subject: "user-rao", kind: "person", displayName: "J. Rao" });
    expect(thread?.question.status).toBe("answered");
    const entries = thread?.entries ?? [];
    expect(entries.map((e) => e.kind)).toEqual(["reply", "reply", "answer", "reply"]);
    const authors = entries.map((e) => (e.kind === "reply" ? e.record.reply.author : e.record.answer.author));
    expect(authors.map((a) => a?.subject)).toEqual(["user-example", "user-rao", "user-example", "agent:user-rao:run-1"]);
    expect(authors[3]?.onBehalfOf).toMatchObject({ subject: "user-rao", kind: "person" });
    const answer = answersTo(m.elements, "Q-beam")[0];
    expect(answer?.answer).toMatchObject({ outcome: "clarification", by: "K. Example", text: "W12x26 at gridline 3." });
    // A reply is never an answer: the question stayed open through both replies before the answer.
    expect(entries[0]?.kind === "reply" && entries[0].record.reply.statusChange).toBeUndefined();
  });

  it("q9-only-asker-reopens: another person and another person's agent are refused; the asker and the asker's agent succeed", () => {
    let m = ask(floor("q9-b"), RAO);
    m = run(m, { type: "decline_question", questionId: "Q-beam", note: "Not ours, ask the architect." } as Command, EXAMPLE);
    const reopen = { type: "set_question_status", questionIds: ["Q-beam"], status: "open" } as Command;
    expect(refused(m, reopen, EXAMPLE)).toBe("Q-1 'Is there a beam over 102?': Only J. Rao, who asked, can ask again. You can reply to it instead");
    expect(refused(m, reopen, EXAMPLE_AGENT)).toMatch(/: Only J\. Rao, who asked, can ask again/);
    expect(refused(m, reopen, CLIENT)).toMatch(/: Only J\. Rao, who asked/);
    const byAsker = run(m, reopen, RAO);
    expect(questionThread(byAsker.elements, "Q-beam")?.question.status).toBe("open");
    const byAgent = run(m, reopen, RAO_AGENT);
    expect(questionThread(byAgent.elements, "Q-beam")?.question.status).toBe("open");
    const q = questionThread(m.elements, "Q-beam")?.question;
    if (!q) throw new Error("no question");
    expect(isAsker(q, { provider: "unsigned", subject: "agent:user-rao:run-9", kind: "agent", onBehalfOf: { provider: "unsigned", subject: "user-rao", kind: "person" } })).toBe(true);
    expect(mayAskAgain(q, null)).toEqual({ ok: false, reason: "Only J. Rao, who asked, can ask again" });
  });

  it("a reply on a declined question doesn't reopen it; Ask again records who asked again in the thread", () => {
    let m = ask(floor("q9-c"), RAO);
    m = run(m, { type: "decline_question", questionId: "Q-beam" } as Command, EXAMPLE);
    m = run(m, { type: "reply_question", questionId: "Q-beam", text: "Could you look anyway?" } as Command, RAO);
    expect(questionThread(m.elements, "Q-beam")?.question.status).toBe("declined");
    m = run(m, { type: "set_question_status", questionIds: ["Q-beam"], status: "open" } as Command, RAO);
    const entries = questionThread(m.elements, "Q-beam")?.entries ?? [];
    const changes = entries.flatMap((e) => (e.kind === "reply" && e.record.reply.statusChange ? [`${e.record.reply.author.subject}:${e.record.reply.statusChange.to}`] : []));
    expect(changes).toEqual(["user-example:declined", "user-rao:open"]);
  });

  it("q9-decline-hides-pin: declined, not in scope and withdrawn leave the plan but stay listed; answered keeps its pin; Ask again brings it back", () => {
    let m = ask(floor("q9-d"), RAO);
    m = ask(m, RAO, "Q-two", "Architect");
    m = ask(m, RAO, "Q-three", "Client");
    expect(questionPinsOn(m, "L1" as never).map((p) => p.questionId).sort()).toEqual(["Q-beam", "Q-three", "Q-two"]);
    m = run(m, { type: "decline_question", questionId: "Q-beam" } as Command, EXAMPLE);
    m = run(m, { type: "decline_question", questionId: "Q-two", not_in_scope: true, note: "Civil's" } as Command, EXAMPLE);
    m = run(m, { type: "answer_question", questionId: "Q-three", answer: "Yes." } as Command, CLIENT);
    expect(questionPinsOn(m, "L1" as never).map((p) => `${p.questionId}:${p.status}`)).toEqual(["Q-three:answered"]);
    expect(allQuestions(m.elements).map((q) => `${q.id}:${q.status}`).sort()).toEqual(["Q-beam:declined", "Q-three:answered", "Q-two:not_in_scope"]);
    m = run(m, { type: "set_question_status", questionIds: ["Q-beam"], status: "open" } as Command, RAO);
    expect(questionPinsOn(m, "L1" as never).map((p) => p.questionId).sort()).toEqual(["Q-beam", "Q-three"]);
    m = run(m, { type: "set_question_status", questionIds: ["Q-three"], status: "withdrawn" } as Command, RAO);
    expect(questionPinsOn(m, "L1" as never).map((p) => p.questionId)).toEqual(["Q-beam"]);
  });

  it("q9-anyone-asks-anyone: a junior asks a senior by name, a client asks the engineer; each is asked of whoever they name", () => {
    let m = run(floor("q9-e"), { type: "add_question", questions: [{ questionId: "Q-jr", text: "Do we upsize this branch?", askOf: "K. Example", askOfAuthor: { provider: "host", subject: "user-example", displayName: "K. Example" }, anchor: { elementIds: ["S101"] } }] } as Command, RAO);
    m = run(m, { type: "add_question", questions: [{ questionId: "Q-cl", text: "Can the unit move to the roof?", askOf: "Engineer", anchor: { elementIds: ["S103"] } }] } as Command, CLIENT);
    const jr = questionThread(m.elements, "Q-jr")?.question;
    expect(jr?.askOfAuthor).toMatchObject({ subject: "user-example", kind: "person" });
    expect(jr?.askedBy).toBe("J. Rao");
    expect(questionThread(m.elements, "Q-cl")?.question.askedByAuthor?.subject).toBe("user-client");
  });

  it("q9-no-obligation: an open question carries no date, and nothing in the record reads as late, due or owed", () => {
    const m = ask(floor("q9-f"), RAO);
    const q = questionThread(m.elements, "Q-beam")?.question;
    expect(q?.closeBy).toBeUndefined();
    expect(JSON.stringify(q)).not.toMatch(/overdue|late|due|owed|deadline/i);
  });

  it("q9-outcomes-extensible: a test add-on's outcome is an answer choice with no kernel edit; an unknown one is refused with the choices", () => {
    const def: QuestionOutcomeDef = { id: "wf.referred_on", label: "Referred to the owner", questionStatus: "answered" };
    const set = PackSet.create([definePack({ id: "wf", name: "Question workflow (test)", version: "1.0.0", kernel: "^1.5.0" }, [contribute(QUESTION_OUTCOME_POINT, [def])])]);
    const m = ask(floor("q9-g"), RAO);
    const saved = withPackSet(set, () => run(m, { type: "answer_question", questionId: "Q-beam", answer: "Passed on.", outcome: "wf.referred_on" } as Command, EXAMPLE));
    expect(answersTo(saved.elements, "Q-beam")[0]?.answer.outcome).toBe("wf.referred_on");
    expect(refused(m, { type: "answer_question", questionId: "Q-beam", answer: "x", outcome: "wf.referred_on" } as Command, EXAMPLE)).toMatch(/isn't an answer choice in this model\. Choose one of: Clarification \(clarification\)/);
  });

  it("q9-answer-never-change-order: a design-revision answer links a branch, creates no change order and no price, and refuses commercial links", () => {
    const m = ask(floor("q9-h"), RAO);
    const saved = run(m, { type: "answer_question", questionId: "Q-beam", answer: "Moving the unit.", outcome: "design_revision", links: [{ kind: "branch", ref: "move-rtu" }] } as Command, EXAMPLE);
    const added = Object.values(saved.elements).filter((e) => !m.elements[e.id]);
    expect(added.map((e) => e.kind).sort()).toEqual(["question_answer"]);
    expect(JSON.stringify(added)).not.toMatch(/change.?order|price|cost/i);
    expect(refused(m, { type: "answer_question", questionId: "Q-beam", answer: "x", outcome: "design_revision", links: [{ kind: "change_order", ref: "CO-1" }] } as Command, EXAMPLE)).toBe('Design revision links revision_range or branch, not "change_order"');
  });

  it("q9-old-peer-keeps-threads: an older server refuses thread writes in words, and an old peer's edits keep replies byte for byte", () => {
    let m = ask(floor("q9-i"), RAO);
    m = run(m, { type: "reply_question", questionId: "Q-beam", text: "Which beam?" } as Command, EXAMPLE);
    m = run(m, { type: "decline_question", questionId: "Q-beam" } as Command, EXAMPLE);
    const before = JSON.stringify(questionThread(m.elements, "Q-beam"));
    expect(refused(m, { type: "reply_question", questionId: "Q-beam", text: "x" } as Command, RAO, ROUND_8B)).toMatch(/older version that doesn't store question threads/);
    // An old peer's own edits (a new question, an edit to this one) leave the thread as it was.
    let old = run(m, { type: "add_question", questions: [{ questionId: "Q-old", text: "Ceiling height?", askOf: "Client", anchor: { elementIds: ["S101"] } }] } as Command, CLIENT, ROUND_8B);
    old = run(old, { type: "edit_question", questionId: "Q-beam", text: "Is there a beam over room 102?" } as Command, CLIENT, ROUND_8B);
    const t = questionThread(old.elements, "Q-beam");
    expect(JSON.stringify(t?.entries)).toBe(JSON.stringify(JSON.parse(before).entries));
    expect(t?.question.askedByAuthor?.subject).toBe("user-rao");
    expect(t?.question.status).toBe("declined");
    expect(questionThread(old.elements, "Q-old")?.question.askedByAuthor).toBeUndefined();
  });

  it("the model server's commit stamps the actor and its own time on a reply", () => {
    const m = ask(floor("q9-j"), RAO);
    const decided = withUpgradePolicy(ROUND_9, () =>
      planCommit(m, [], { idempotencyKey: "reply-key-1", baseRevision: m.revision, actor: EXAMPLE, command: commandSchema.parse({ type: "reply_question", questionId: "Q-beam", text: "Which beam?" }) }, () => "2026-11-02T10:00:00.000Z"),
    );
    if (!decided.ok) throw new Error(decided.error.message);
    const reply = questionThread(decided.model.elements, "Q-beam")?.entries[0];
    expect(reply?.kind === "reply" && reply.record.reply).toMatchObject({ at: "2026-11-02T10:00:00.000Z", author: { subject: "user-example", displayName: "K. Example" } });
  });
});
