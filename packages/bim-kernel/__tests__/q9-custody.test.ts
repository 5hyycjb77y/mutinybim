/**
 * @jest-environment node
 *
 * Round 9 lane Q9 (the product owner's answer 2): owner, addressee and an event history
 * on every question, each attributed with an AuthorRef. Close and keep
 * closed (Ask again refused in plain words; asking anew makes a new question
 * that links back), Take over (the owner, not the original author, controls
 * Ask again; the author stays in history), Forward (re-addressed; the former
 * addressee is kept). Generic acts on any question, not special cases.
 *
 * Fails on the first Q9 pass and on round 8b: none of `keep_closed`,
 * `take_over_question`, `forward_question` or `askedBefore` parsed, and only
 * the original asker could ever ask again.
 */
import { commandSchema, executeCommand, mayAskAgain, questionThread, withUpgradePolicy, type Actor, type Command, type ModelState } from "../src";
import { floor } from "./g7-fixtures";

const RAO: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };
const EXAMPLE: Actor = { id: "user-example", name: "K. Example", kind: "human" };
const LEE: Actor = { id: "user-lee", name: "M. Lee", kind: "human" };
const LEE_AGENT: Actor = { id: "agent:user-lee:run-3", name: "Agent", kind: "agent" };
const NO_CUSTODY = (f: string) => f !== "questions:custody";

let tick = 0;
function run(m: ModelState, command: unknown, actor: Actor, policy: (f: string) => boolean = () => true): ModelState {
  tick += 1;
  const r = withUpgradePolicy(policy, () => executeCommand(m, commandSchema.parse(command), { actorId: actor.id, actor, at: new Date(Date.UTC(2026, 10, 2, 10, 0, tick)).toISOString() }));
  if (!r.ok) throw new Error(`${(command as Command).type}: ${r.error.message}`);
  return r.model;
}

function refused(m: ModelState, command: unknown, actor: Actor, policy: (f: string) => boolean = () => true): string {
  const r = withUpgradePolicy(policy, () => executeCommand(m, commandSchema.parse(command), { actorId: actor.id, actor }));
  if (r.ok) throw new Error("saved; expected a refusal");
  return r.error.message;
}

const asked = (m: ModelState) => run(m, { type: "add_question", questions: [{ questionId: "Q-beam", text: "Is there a beam over 102?", askOf: "Structural", anchor: { elementIds: ["S102"] } }] }, RAO);
const reopen = { type: "set_question_status", questionIds: ["Q-beam"], status: "open" };

describe("q9 question custody", () => {
  it("close and keep closed: Ask again is refused in plain words, even for the asker; asking anew links back", () => {
    let m = asked(floor("q9c-a"));
    m = run(m, { type: "decline_question", questionId: "Q-beam", not_in_scope: true, note: "Civil's", keep_closed: "Settled at the 10/12 coordination meeting" }, EXAMPLE);
    const q = questionThread(m.elements, "Q-beam")?.question;
    expect(q?.keptClosed).toMatchObject({ by: { subject: "user-example" }, reason: "Settled at the 10/12 coordination meeting" });
    expect(refused(m, reopen, RAO)).toBe("Q-1 'Is there a beam over 102?': K. Example closed this and kept it closed: 'Settled at the 10/12 coordination meeting'. Ask a new question instead; it links back to this one.");
    expect(refused(m, { type: "answer_question", questionId: "Q-beam", answer: "x" }, EXAMPLE)).toMatch(/kept it closed/);
    const anew = run(m, { type: "add_question", questions: [{ questionId: "Q-beam-2", text: "Is there a beam over 102, now that the unit moved?", askOf: "Structural", anchor: { elementIds: ["S102"] }, askedBefore: "Q-beam" }] }, RAO);
    expect(questionThread(anew.elements, "Q-beam-2")?.question.askedBefore).toBe("Q-beam");
    const event = questionThread(m.elements, "Q-beam")?.entries.at(-1);
    expect(event?.kind === "reply" && event.record.reply).toMatchObject({ statusChange: { to: "not_in_scope" }, event: { kind: "kept_closed", reason: "Settled at the 10/12 coordination meeting" } });
  });

  it("take over: the new owner controls Ask again, the original author is kept and is then refused", () => {
    let m = asked(floor("q9c-b"));
    m = run(m, { type: "take_over_question", questionId: "Q-beam", note: "Rao is on leave" }, LEE);
    m = run(m, { type: "decline_question", questionId: "Q-beam" }, EXAMPLE);
    const q = questionThread(m.elements, "Q-beam")?.question;
    expect(q?.askedByAuthor?.subject).toBe("user-rao");
    expect(q?.ownerAuthor).toMatchObject({ subject: "user-lee", kind: "person" });
    expect(refused(m, reopen, RAO)).toMatch(/^Q-1 '.*': Only M\. Lee, who carries this question now, can ask again\. You can reply to it instead$/);
    expect(questionThread(run(m, reopen, LEE_AGENT).elements, "Q-beam")?.question.status).toBe("open");
    const took = questionThread(m.elements, "Q-beam")?.entries.find((e) => e.kind === "reply" && e.record.reply.event?.kind === "took_over");
    expect(took?.kind === "reply" && took.record.reply).toMatchObject({ author: { subject: "user-lee" }, text: "Rao is on leave", event: { from: { label: "J. Rao" }, to: { label: "M. Lee" } } });
    expect(refused(m, { type: "take_over_question", questionId: "Q-beam" }, LEE)).toBe("You already carry Q-1 'Is there a beam over 102?'");
  });

  it("an agent taking over makes its person the owner", () => {
    const m = run(asked(floor("q9c-c")), { type: "take_over_question", questionId: "Q-beam" }, LEE_AGENT);
    const q = questionThread(m.elements, "Q-beam")?.question;
    if (!q) throw new Error("no question");
    expect(q.ownerAuthor).toMatchObject({ subject: "user-lee", kind: "person" });
    expect(mayAskAgain({ ...q, status: "declined" }, { provider: "unsigned", subject: "user-lee", kind: "person" })).toEqual({ ok: true });
  });

  it("forward: re-addressed, the former addressee is kept and the event names both", () => {
    let m = asked(floor("q9c-d"));
    m = run(m, { type: "forward_question", questionId: "Q-beam", askOf: "Architect", askOfAuthor: { provider: "host", subject: "user-arch", displayName: "A. Arch" }, note: "Not ours" }, EXAMPLE);
    m = run(m, { type: "forward_question", questionId: "Q-beam", askOf: "Owner's rep" }, RAO);
    const q = questionThread(m.elements, "Q-beam")?.question;
    expect(q?.askOf).toBe("Owner's rep");
    expect(q?.askOfAuthor).toBeUndefined();
    expect(q?.formerAddressees).toEqual([{ label: "Structural" }, { label: "Architect", author: { provider: "host", subject: "user-arch", kind: "person", displayName: "A. Arch" } }]);
    const events = (questionThread(m.elements, "Q-beam")?.entries ?? []).flatMap((e) => (e.kind === "reply" && e.record.reply.event ? [`${e.record.reply.event.from?.label}->${e.record.reply.event.to?.label}`] : []));
    expect(events).toEqual(["Structural->Architect", "Architect->Owner's rep"]);
    expect(refused(m, { type: "forward_question", questionId: "Q-beam", askOf: "owner's rep" }, RAO)).toBe("Q-1 'Is there a beam over 102?' is already asked of Owner's rep");
  });

  it("an older server refuses custody in words and its edits keep the custody fields", () => {
    let m = asked(floor("q9c-e"));
    expect(refused(m, { type: "take_over_question", questionId: "Q-beam" }, LEE, NO_CUSTODY)).toMatch(/older version that doesn't store who carries a question/);
    m = run(m, { type: "take_over_question", questionId: "Q-beam" }, LEE);
    const old = run(m, { type: "edit_question", questionId: "Q-beam", text: "Is there a beam over room 102?" }, RAO, NO_CUSTODY);
    expect(questionThread(old.elements, "Q-beam")?.question.ownerAuthor?.subject).toBe("user-lee");
  });
});
