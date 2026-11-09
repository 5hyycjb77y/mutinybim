/** @jest-environment node */
import { commandSchema, executeCommand, planCommit, questionsIn, type Command } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { ALL_RULES } from "../../bim-lint/src";

it("question commands go through the kernel's one command path and the lint runs their rules", () => {
  const m0 = createDemoModel("w");
  const command: Command = commandSchema.parse({ type: "add_question", questions: [{ questionId: "q1", text: "Is there a beam here?", askOf: "structural", anchor: { elementIds: ["sd-1"] }, blocksIssue: true }] });
  const d = planCommit(m0, [], { idempotencyKey: "k1", baseRevision: m0.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-27T00:00:00.000Z");
  if (!d.ok) throw new Error(d.error.message);
  expect(questionsIn(d.model.elements).map((q) => q.number)).toEqual(["Q-1"]);
  const b = executeCommand(d.model, commandSchema.parse({ type: "batch_edits", label: "two", commands: [{ type: "answer_question", questionId: "q1", answer: "No beam" }] }));
  expect(b.ok).toBe(true);
  expect(ALL_RULES.map((r) => r.id)).toEqual(expect.arrayContaining(["question-anchor-gone", "question-open-on-issued-sheet"]));
});
