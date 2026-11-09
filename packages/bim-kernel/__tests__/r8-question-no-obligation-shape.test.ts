/**
 * @jest-environment node
 *
 * Round 8 lane R: a question carries no obligation. Any person or party asks
 * any party; it can be answered, declined, marked not in scope or left open.
 * No question, answer or submittal record has a date it is owed by, and a
 * question closed without an answer (declined, not in scope, withdrawn) never
 * holds an issue or shows as open.
 *
 * Fails on round 7's code: there was no `askedBy`, no `declined` or
 * `not_in_scope` status, and `CLOSED_WITHOUT_ANSWER_STATUSES` did not exist.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLOSED_WITHOUT_ANSWER_STATUSES,
  QUESTION_STATUSES,
  blockingOpenQuestions,
  executeCommand,
  openQuestionsFor,
  type BimElement,
  type DivergenceBody,
  type ElementId,
  type ModelState,
  type Question,
  type QuestionAnswerBody,
  type SubmittalBody,
} from "../src";
import { floor } from "./g7-fixtures";

type Dateish = `${string}${"due" | "Due" | "deadline" | "Deadline" | "late" | "Late" | "owed" | "Owed"}${string}`;
type DateKeys<T> = Extract<keyof T, Dateish>;

// Compile-time: none of these records has a key that names a date something is owed by.
const questionHasNone: [DateKeys<Question>] extends [never] ? true : false = true;
const answerHasNone: [DateKeys<QuestionAnswerBody>] extends [never] ? true : false = true;
const submittalHasNone: [DateKeys<SubmittalBody>] extends [never] ? true : false = true;
const divergenceHasNone: [DateKeys<DivergenceBody>] extends [never] ? true : false = true;

const SRC = join(__dirname, "..", "src");
const NEW_SOURCES = [...readdirSync(join(SRC, "questions")).map((f) => join(SRC, "questions", f)), ...readdirSync(join(SRC, "submittals")).map((f) => join(SRC, "submittals", f))].filter((f) => f.endsWith(".ts"));

function question(id: string, status: Question["status"], extra: Partial<Question> = {}): BimElement {
  const q: Question = { id: id as ElementId, version: 1, authoredRev: {}, kind: "question", type: "question", number: id, anchor: { elementIds: ["W-12" as ElementId] }, text: "Is this wall rated?", askOf: "Architect", status, blocksIssue: true, ...extra };
  return q as unknown as BimElement;
}

describe("r8 a question carries no obligation", () => {
  it("has no date it is owed by, at compile time and in what the add command stores", () => {
    expect([questionHasNone, answerHasNone, submittalHasNone, divergenceHasNone]).toEqual([true, true, true, true]);
    const r = executeCommand(floor("r8-q-a"), { type: "add_question", questions: [{ questionId: "Q-a", text: "Can this beam take the new unit?", askOf: "Structural", anchor: { elementIds: ["W-12"] } }] });
    if (!r.ok) throw new Error(r.error.message);
    const keys = Object.keys(r.model.elements["Q-a"] ?? {});
    expect(keys.filter((k) => /due|deadline|late|owed/i.test(k))).toEqual([]);
    expect(keys).not.toContain("closeBy");
    expect(keys).not.toContain("blocksIssue");
  });

  it("any party asks any party, and the statuses include declining and not in scope", () => {
    const asked: Question = { ...(question("Q-j", "open") as unknown as Question), askedBy: "Junior engineer", askOf: "Senior engineer" };
    expect(asked.askedBy).toBe("Junior engineer");
    expect(QUESTION_STATUSES).toEqual(expect.arrayContaining(["open", "answered", "declined", "not_in_scope", "withdrawn", "assumed"]));
    expect([...CLOSED_WITHOUT_ANSWER_STATUSES].sort()).toEqual(["declined", "not_in_scope", "withdrawn"]);
  });

  it("a declined or not-in-scope question never shows as open and never holds an issue; an open one stays plainly open", () => {
    const m0 = floor("r8-q-b");
    const m: ModelState = { ...m0, elements: { ...m0.elements, "Q-1": question("Q-1", "declined"), "Q-2": question("Q-2", "not_in_scope"), "Q-3": question("Q-3", "open", { closeBy: "DD" }) } };
    expect(openQuestionsFor(m, ["W-12" as ElementId]).map((q) => q.id)).toEqual(["Q-3"]);
    expect(blockingOpenQuestions(m.elements).map((q) => q.id)).toEqual(["Q-3"]);
    expect(m.elements["Q-3"]).toMatchObject({ status: "open" });
  });

  it("the kernel's question and submittal sources never call an unanswered question late or owed", () => {
    expect(NEW_SOURCES.length).toBeGreaterThan(5);
    for (const f of NEW_SOURCES) expect({ f, hits: readFileSync(f, "utf8").match(/\boverdue\b|\bowed\b|\bdueDate\b|\bdue_date\b/gi) ?? [] }).toEqual({ f, hits: [] });
  });
});
