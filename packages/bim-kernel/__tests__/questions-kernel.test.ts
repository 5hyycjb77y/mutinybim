/**
 * @jest-environment node
 *
 * Questions and assumptions pinned to the model (ROADMAP F7, KERNEL §3.7):
 * the pink and magenta notes become objects that point at elements or a point
 * on a level, say who they are for and whether they are open. An open one
 * marked to hold the issue holds every sheet whose views show what it points
 * at; answering it releases the sheet. The client email lists only what still
 * needs asking, skipping questions the model already answers.
 *
 * Before this change none of it existed: there was no question element, no
 * command made one, `issueHoldsFor` did not exist, and a sheet showing a
 * blocking open question issued like any other (the issue flow had no such
 * reason). Every assertion below fails on that code (the imports do not
 * resolve).
 */
import { asElementId, commandSchema, executeCommand, type BimElement, type ModelState } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { executeQuestionCommand, type QuestionCommand } from "../src/questions/commands";
import { questionAt } from "../src/questions/element";
import { issueHoldsFor, issueHoldsForSheets, modelAnswerFor, openQuestionsFor, questionPinsOn, questionsToAsk } from "../src/questions/holds";
import { advanceQuestionIndex, allQuestions, questionByNumber, questionIndexStats, questionsWithStatus } from "../src/questions/question-index";

const L1 = asElementId("lvl-1");
const SD1 = asElementId("sd-1"); // supply diffuser at (5486, 3048)
const SD2 = asElementId("sd-2"); // supply diffuser at (10058, 3048)

function docs(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

/** The demo duct system on "L1", a level element named "L1", and sheet M-101 with a cropped L1 plan around sd-1 only. */
function baseModel(): ModelState {
  const demo = createDemoModel("questions");
  const level: BimElement = { id: L1, kind: "level", version: 1, authoredRev: {}, name: "L1", elevationMm: 0 };
  let m: ModelState = { ...demo, elements: { ...demo.elements, [L1]: level } };
  m = docs(m, {
    type: "batch_documents",
    label: "M-101 and M-102",
    commands: [
      { type: "create_sheet", sheetId: "s1", number: "M-101", name: "West" },
      { type: "create_view", viewId: "v1", name: "L1 West", viewType: "floor_plan", props: { level: "L1" }, crop: { min: { x: 0, y: 0 }, max: { x: 7000, y: 6000 } } },
      { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 300, y: 300 } },
      { type: "create_sheet", sheetId: "s2", number: "M-102", name: "East" },
      { type: "create_view", viewId: "v2", name: "L1 East", viewType: "floor_plan", props: { level: "L1" }, crop: { min: { x: 9000, y: 0 }, max: { x: 12000, y: 6000 } } },
      { type: "place_viewport", viewportId: "vp2", sheetId: "s2", viewId: "v2", center: { x: 300, y: 300 } },
    ],
  });
  return m;
}

class Model {
  summary: readonly string[] = [];
  constructor(public head: ModelState) {}

  ok(command: QuestionCommand): this {
    const r = executeQuestionCommand(this.head, command);
    if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
    advanceQuestionIndex(this.head.elements, r.model.elements, r.changedIds, r.removedIds);
    this.head = { ...r.model, revision: (this.head.revision + 1) as ModelState["revision"] };
    this.summary = r.summary ?? [];
    return this;
  }

  refused(command: QuestionCommand): string {
    const r = executeQuestionCommand(this.head, command);
    if (r.ok) throw new Error(`${command.type} was accepted`);
    return r.error.message;
  }
}

const beam = (over: Partial<Extract<QuestionCommand, { type: "add_question" }>["questions"][number]> = {}): QuestionCommand => ({
  type: "add_question",
  questions: [{ questionId: "q-beam", text: "Is there a beam here?", askOf: "structural", anchor: { elementIds: [SD1] }, blocksIssue: true, ...over }],
});

describe("add, answer, withdraw", () => {
  it("numbers questions in order, starts assumptions as assumed, and says what it did", () => {
    const m = new Model(baseModel()).ok(beam());
    expect(m.summary).toEqual(["Added question Q-1 'Is there a beam here?' for structural"]);
    m.ok({ type: "add_question", questions: [{ questionId: "q-inv", type: "assumption", text: "Tie into existing 4\" sanitary; contractor to verify invert", askOf: "contractor", anchor: { point: { levelId: L1, position: { x: 2000, y: 1000 } } } }] });
    const inv = questionAt(m.head.elements, "q-inv");
    expect(inv).toMatchObject({ number: "Q-2", status: "assumed", type: "assumption" });
    expect(questionByNumber(m.head.elements, "q-1")?.id).toBe("q-beam");
  });

  it("refuses in plain words", () => {
    const m = new Model(baseModel()).ok(beam());
    expect(m.refused(beam({ questionId: "q-2", anchor: {} }))).toBe("Pin the question to something: pick the elements it is about or a point on a plan");
    expect(m.refused(beam({ questionId: "q-2", anchor: { elementIds: ["nope"] } }))).toBe("There is no element nope to pin the question to. Pick it on the plan again");
    expect(m.refused(beam({ questionId: "q-2", anchor: { elementIds: ["s1"] } }))).toBe("A question can't be pinned to a sheet. Pin it to the thing it is about, or to a point on a plan");
    expect(m.refused(beam({ questionId: "q-2", number: "q-1" }))).toMatch(/^q-1 already exists \(Q-1 'Is there a beam here\?'\)/);
    expect(m.refused(beam())).toBe("q-beam already exists; choose a new id for the question");
    expect(m.refused(beam({ questionId: "q-3", answeredBy: { elementId: SD1, field: "values.pressure" } }))).toMatch(/only placed or planned parts carry instance values/);
    m.ok({ type: "set_question_status", questionIds: ["q-beam"], status: "withdrawn" });
    expect(m.refused({ type: "answer_question", questionId: "q-beam", answer: "No beam" })).toBe("Q-1 'Is there a beam here?' was withdrawn. Ask it again first if it still needs an answer");
  });

  it("asking again clears the answer; delete removes it", () => {
    const m = new Model(baseModel()).ok(beam()).ok({ type: "answer_question", questionId: "q-beam", answer: "W12 beam, 10'-6\" AFF" });
    expect(questionAt(m.head.elements, "q-beam")).toMatchObject({ status: "answered", answer: "W12 beam, 10'-6\" AFF" });
    m.ok({ type: "set_question_status", questionIds: ["q-beam"], status: "open" });
    expect(questionAt(m.head.elements, "q-beam")?.answer).toBeUndefined();
    m.ok({ type: "delete_questions", questionIds: ["q-beam"] });
    expect(allQuestions(m.head.elements)).toEqual([]);
  });
});

describe("issue holds", () => {
  it("an open blocking question on an element a sheet shows holds that sheet only, and answering releases it", () => {
    const m = new Model(baseModel()).ok(beam());
    expect(issueHoldsFor(m.head, asElementId("s1"))).toEqual([
      { questionId: "q-beam", number: "Q-1", sheetId: "s1", reason: "Not issued: question Q-1 'Is there a beam here?' is open and holds this issue" },
    ]);
    // sd-1 is outside M-102's crop.
    expect(issueHoldsFor(m.head, asElementId("s2"))).toEqual([]);
    expect(issueHoldsForSheets(m.head, [asElementId("s1"), asElementId("s2")]).message).toBe(
      "Not issued: question Q-1 'Is there a beam here?' is open and holds this issue (sheet M-101). Answer or withdraw it in Coordination › Questions, or untick \"Holds the issue\".",
    );
    m.ok({ type: "answer_question", questionId: "q-beam", answer: "No beam; joists at 16\" o.c." });
    expect(issueHoldsFor(m.head, asElementId("s1"))).toEqual([]);
  });

  it("a question that doesn't hold the issue, or a withdrawn one, never holds", () => {
    const m = new Model(baseModel()).ok(beam({ blocksIssue: false }));
    expect(issueHoldsFor(m.head, asElementId("s1"))).toEqual([]);
    m.ok({ type: "edit_question", questionId: "q-beam", blocksIssue: true });
    expect(issueHoldsFor(m.head, asElementId("s1"))).toHaveLength(1);
    m.ok({ type: "set_question_status", questionIds: ["q-beam"], status: "withdrawn" });
    expect(issueHoldsFor(m.head, asElementId("s1"))).toEqual([]);
  });

  it("a point pin holds the sheet whose plan crop contains it", () => {
    const m = new Model(baseModel()).ok(beam({ anchor: { point: { levelId: L1, position: { x: 10000, y: 2000 } } } }));
    expect(issueHoldsFor(m.head, asElementId("s1"))).toEqual([]);
    expect(issueHoldsFor(m.head, asElementId("s2")).map((h) => h.number)).toEqual(["Q-1"]);
  });
});

describe("the index follows edits", () => {
  it("finds open questions by element and re-files only what changed", () => {
    const m = new Model(baseModel()).ok(beam()).ok({ type: "add_question", questions: [{ questionId: "q-east", text: "Ceiling height at the east diffuser?", askOf: "architect", anchor: { elementIds: [SD2] } }] });
    expect(openQuestionsFor(m.head, [SD1]).map((q) => q.number)).toEqual(["Q-1"]);
    expect(openQuestionsFor(m.head, [SD1, SD2]).map((q) => q.number)).toEqual(["Q-1", "Q-2"]);
    const before = questionIndexStats(m.head.elements).filed;
    m.ok({ type: "answer_question", questionId: "q-east", answer: "9'-0\"" });
    expect(questionIndexStats(m.head.elements).filed).toBe(before + 1);
    expect(openQuestionsFor(m.head, [SD2])).toEqual([]);
    expect(questionsWithStatus(m.head.elements, "answered").map((q) => q.id)).toEqual(["q-east"]);
  });
});

describe("what still needs asking", () => {
  it("skips answered, withdrawn and model-answered questions; asks open ones and confirms assumptions", () => {
    const m = new Model(baseModel()).ok({
      type: "add_question",
      questions: [
        { questionId: "a", text: "Which diffuser model at the west end?", askOf: "Client", anchor: { elementIds: [SD1] }, answeredBy: { elementId: SD1, field: "mark" } },
        { questionId: "b", text: "Ceiling type in the dining room?", askOf: "client", anchor: { elementIds: [SD2] } },
        { questionId: "c", text: "Is the kitchen hood by others?", askOf: "client", anchor: { elementIds: [SD2] } },
        { questionId: "d", type: "assumption", text: "Existing gas service is 2 psi", askOf: "client", anchor: { elementIds: [SD2] } },
        { questionId: "e", text: "Roof framing direction?", askOf: "structural", anchor: { elementIds: [SD2] } },
        { questionId: "f", text: "Anything else?", askOf: "client", anchor: { elementIds: [SD2] } },
      ],
    });
    m.ok({ type: "answer_question", questionId: "c", answer: "Yes, by the kitchen consultant" });
    m.ok({ type: "set_question_status", questionIds: ["f"], status: "withdrawn" });
    const asked = questionsToAsk(m.head, { askOf: "client" });
    expect(asked.ask.map((a) => [a.question.number, a.ask])).toEqual([
      ["Q-2", "answer"],
      ["Q-4", "confirm_assumption"],
    ]);
    // sd-1's mark is "SD-1": the model already answers Q-1.
    expect(asked.answeredByModel.map((a) => [a.question.number, a.value])).toEqual([["Q-1", "SD-1"]]);
  });

  it("can't tell is never answered", () => {
    const m = new Model(baseModel()).ok(beam({ answeredBy: { elementId: SD1, field: "note" } }));
    const q = questionAt(m.head.elements, "q-beam");
    if (!q) throw new Error("missing");
    expect(modelAnswerFor(m.head, q)).toEqual({ answered: false, why: "SD-1 has no note yet" });
    const plain = new Model(baseModel()).ok(beam());
    const p = questionAt(plain.head.elements, "q-beam");
    if (!p) throw new Error("missing");
    expect(modelAnswerFor(plain.head, p)).toEqual({ answered: false, why: "The question doesn't name a model value that would answer it" });
  });
});

describe("plan pins", () => {
  it("pins at the point, or at the anchored element on that level; withdrawn ones don't pin", () => {
    const m = new Model(baseModel())
      .ok(beam())
      .ok({ type: "add_question", questions: [{ questionId: "q-pt", text: "Slab depression here?", askOf: "architect", anchor: { point: { levelId: L1, position: { x: 100, y: 200 } } } }] });
    expect(questionPinsOn(m.head, L1)).toEqual([
      { questionId: "q-beam", number: "Q-1", status: "open", blocksIssue: true, position: { x: expect.closeTo(5486.4, 6), y: 3048 } },
      { questionId: "q-pt", number: "Q-2", status: "open", blocksIssue: false, position: { x: 100, y: 200 } },
    ]);
    m.ok({ type: "set_question_status", questionIds: ["q-pt"], status: "withdrawn" });
    expect(questionPinsOn(m.head, L1).map((p) => p.number)).toEqual(["Q-1"]);
  });
});
