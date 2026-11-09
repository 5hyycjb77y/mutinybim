/**
 * @jest-environment node
 *
 * Questions in the lint (ROADMAP F7): a question whose anchored elements were
 * deleted, and a sheet issued while a question marked to hold it is open (or
 * past the phase it had to close by). Before this change there was no
 * question element and no `questions` pack: neither finding could exist, and
 * the imports below do not resolve on that code.
 */
import { asElementId, commandSchema, executeCommand, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { executeQuestionCommand, type QuestionCommand } from "../../bim-kernel/src/questions/commands";
import { ALL_RULES, LintEngine } from "../src";
import { questionRules } from "../src/rules/packs/questions";
import { config } from "./fixtures";

const L1 = asElementId("lvl-1");

function apply(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = executeCommand(model, commandSchema.parse(command));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function ask(model: ModelState, command: QuestionCommand): ModelState {
  const r = executeQuestionCommand(model, command);
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

function base(): ModelState {
  const demo = createDemoModel("questions-lint");
  const level: BimElement = { id: L1, kind: "level", version: 1, authoredRev: {}, name: "L1", elevationMm: 0 };
  return apply(
    { ...demo, elements: { ...demo.elements, [L1]: level } },
    {
      type: "batch_documents",
      label: "M-101",
      commands: [
        { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Plan" },
        { type: "create_view", viewId: "v1", name: "L1", viewType: "floor_plan", props: { level: "L1" }, crop: { min: { x: 0, y: 0 }, max: { x: 7000, y: 6000 } } },
        { type: "place_viewport", viewportId: "vp1", sheetId: "s1", viewId: "v1", center: { x: 300, y: 300 } },
      ],
    },
  );
}

function issued(model: ModelState, description: string): ModelState {
  return apply(model, { type: "set_sheet_properties", sheetId: "s1", revisions: [{ number: "1", date: "2026-10-27", description }] });
}

function fired(model: ModelState): Map<string, string[]> {
  const e = new LintEngine([...ALL_RULES, ...questionRules]);
  e.build(model);
  const out = new Map<string, string[]>();
  for (const f of e.check({ config: config({ ruleset: "issue" }) })) out.set(f.rule, [...(out.get(f.rule) ?? []), f.message]);
  return out;
}

const beam = (over: Partial<Extract<QuestionCommand, { type: "add_question" }>["questions"][number]> = {}): QuestionCommand => ({
  type: "add_question",
  questions: [{ questionId: "q-beam", text: "Is there a beam here?", askOf: "structural", anchor: { elementIds: ["sd-1"] }, blocksIssue: true, ...over }],
});

describe("questions pack", () => {
  it("a sheet issued while a holding question is open is flagged; answering it clears the finding", () => {
    const m = issued(ask(base(), beam()), "Issued for permit");
    expect(fired(m).get("question-open-on-issued-sheet")).toEqual([
      "M-101 was issued (Rev 1) while Q-1 'Is there a beam here?' is open and marked to hold it. Answer or withdraw it in Coordination › Questions",
    ]);
    const answered = ask(m, { type: "answer_question", questionId: "q-beam", answer: "No beam" });
    expect(fired(answered).get("question-open-on-issued-sheet")).toBeUndefined();
  });

  it("an open question past the phase it had to close by is flagged even when it doesn't hold the issue", () => {
    const m = issued(ask(base(), beam({ blocksIssue: false, closeBy: "DD" })), "Issued for DD");
    expect(fired(m).get("question-open-on-issued-sheet")).toEqual([
      "M-101 went out for DD (Rev 1) while Q-1 'Is there a beam here?', due by DD, is open. Answer or withdraw it in Coordination › Questions",
    ]);
    // "DD" is a whole word: "ADDENDUM 1" is not the DD set.
    expect(fired(issued(ask(base(), beam({ blocksIssue: false, closeBy: "DD" })), "ADDENDUM 1")).get("question-open-on-issued-sheet")).toBeUndefined();
  });

  it("a sheet that was never issued is not flagged", () => {
    expect(fired(ask(base(), beam())).get("question-open-on-issued-sheet")).toBeUndefined();
  });

  it("a question whose element was deleted says it points at nothing", () => {
    const m = ask(base(), beam());
    const { ["sd-1"]: _gone, ...rest } = m.elements;
    const gone: ModelState = { ...m, elements: rest };
    expect(fired(gone).get("question-anchor-gone")).toEqual(["Q-1 'Is there a beam here?' points at nothing: what it was pinned to was deleted. Pin it again or withdraw it in Coordination › Questions"]);
    expect(fired(m).get("question-anchor-gone")).toBeUndefined();
  });
});
