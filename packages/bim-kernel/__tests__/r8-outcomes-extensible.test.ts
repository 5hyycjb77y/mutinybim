/**
 * @jest-environment node
 *
 * Round 8 lane R: answer outcomes are a registry (`kernel.question_outcome`
 * v1). The kernel ships five; a test add-on adds its own with no kernel edit,
 * a reader keeps an outcome id its set doesn't know and words it, and a row
 * that would tie an answer to anything commercial is left out.
 *
 * Fails on round 7's code: answers had no outcome and there was no registry.
 */
import {
  BUILTIN_QUESTION_OUTCOME_IDS,
  QUESTION_OUTCOME_POINT,
  listQuestionOutcomes,
  questionOutcomeDef,
  questionOutcomeLabel,
  questionOutcomeProblems,
  readQuestionAnswerBody,
  type QuestionOutcomeDef,
} from "../src";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs";

const REFERRED: QuestionOutcomeDef = { id: "wf.referred_on", label: "Referred to the owner", questionStatus: "answered", links: ["wf.owner_record"] };
const PRICED: QuestionOutcomeDef = { id: "wf.priced_reply", label: "Priced reply", questionStatus: "answered" };
const LINKS_CO: QuestionOutcomeDef = { id: "wf.revise", label: "Revise", questionStatus: "answered", links: ["change_order"] };
const WORKFLOW = definePack({ id: "wf", name: "Formal question workflow (test)", version: "1.0.0", kernel: "^1.5.0" }, [contribute(QUESTION_OUTCOME_POINT, [REFERRED, PRICED, LINKS_CO])]);

describe("r8 answer outcomes are extensible", () => {
  it("ships the five built-in outcomes, each with a label and the status it leaves", () => {
    expect(BUILTIN_QUESTION_OUTCOME_IDS).toEqual(["clarification", "not_in_scope", "judgment_recorded", "design_revision", "branch_opened"]);
    expect(questionOutcomeDef("not_in_scope")).toMatchObject({ label: "Not in scope", questionStatus: "not_in_scope" });
    expect(questionOutcomeDef("judgment_recorded")?.links).toEqual(["determination"]);
    expect(questionOutcomeDef("design_revision")?.links).toEqual(["revision_range", "branch"]);
    for (const o of listQuestionOutcomes()) expect(questionOutcomeProblems(o)).toEqual([]);
  });

  it("a test add-on adds an outcome with no kernel edit; rows that tie an answer to money are left out", () => {
    withPackSet(PackSet.create([WORKFLOW]), () => {
      const ids = listQuestionOutcomes().map((o) => o.id);
      expect(ids).toEqual([...BUILTIN_QUESTION_OUTCOME_IDS, "wf.referred_on"]);
      expect(questionOutcomeLabel("wf.referred_on")).toBe("Referred to the owner");
      expect(questionOutcomeDef("wf.priced_reply")).toBeNull();
      expect(questionOutcomeDef("wf.revise")).toBeNull();
    });
    expect(questionOutcomeProblems(PRICED)).toEqual(["answer outcome wf.priced_reply is commercial; an answer never links a change order or a price"]);
    expect(questionOutcomeProblems(LINKS_CO)).toEqual(['answer outcome wf.revise links "change_order"; an answer never links a change order or a price']);
  });

  it("without the add-on, a stored answer keeps the outcome and reads it in words, never the raw id", () => {
    expect(questionOutcomeDef("wf.referred_on")).toBeNull();
    expect(questionOutcomeLabel("wf.referred_on")).toBe("Referred on");
    const a = readQuestionAnswerBody({ questionId: "Q-1", text: "Sent on.", by: "Architect", at: "2026-11-01", outcome: "wf.referred_on" });
    expect(a.ok && a.value.outcome).toBe("wf.referred_on");
  });
});
