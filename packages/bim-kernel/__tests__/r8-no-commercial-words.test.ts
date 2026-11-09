/**
 * @jest-environment node
 *
 * Round 8 lane R: questions, answers, submittals and divergences are
 * commercially neutral. No field on those records names a price, a cost or a
 * change order; no built-in outcome, review state or label does; no source
 * says an unanswered question is late; and a stored answer that links a
 * change order or a price is refused by the reader.
 *
 * Fails on round 7's code: the reserved files and readers did not exist.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SUBMITTAL_REVIEW_LABELS,
  SUBMITTAL_REVIEW_STATES,
  PRODUCT_LAYERS,
  QUESTION_STATUSES,
  isCommercialWord,
  listQuestionOutcomes,
  readQuestionAnswerBody,
} from "../src";

const SRC = join(__dirname, "..", "src");
const TYPE_FILES = ["questions/types.ts", "questions/outcomes.ts", "questions/records.ts", "submittals/types.ts"].map((f) => join(SRC, f));
const COMMERCIAL_WORDS = new Set(["due", "overdue", "late", "deadline", "price", "priced", "pricing", "cost", "costs", "amount", "fee", "fees", "invoice", "payment", "money", "budget", "charge", "order", "orders"]);

/** Split an identifier into lower-case words: `changeOrderId` → change, order, id. */
function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

describe("r8 no commercial words in questions, answers and submittals", () => {
  it("no field of the new record types names a date owed, a price, a cost or a change order", () => {
    for (const f of TYPE_FILES) {
      const fields = [...readFileSync(f, "utf8").matchAll(/readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)].map((m) => m[1] ?? "");
      expect(fields.length).toBeGreaterThan(0);
      const hits = fields.filter((name) => words(name).some((w) => COMMERCIAL_WORDS.has(w)));
      expect({ f, hits }).toEqual({ f, hits: [] });
    }
  });

  it("no built-in outcome, status, review state, layer or label is commercial", () => {
    const strings = [
      ...listQuestionOutcomes().flatMap((o) => [o.id, o.label, o.description ?? "", ...(o.links ?? [])]),
      ...QUESTION_STATUSES,
      ...SUBMITTAL_REVIEW_STATES,
      ...Object.values(SUBMITTAL_REVIEW_LABELS),
      ...PRODUCT_LAYERS,
    ];
    for (const s of strings) expect({ s, commercial: isCommercialWord(s) }).toEqual({ s, commercial: false });
  });

  it("no source of the new formats calls an unanswered question overdue", () => {
    for (const f of TYPE_FILES) expect({ f, hits: readFileSync(f, "utf8").match(/overdue/gi) ?? [] }).toEqual({ f, hits: [] });
  });

  it("a stored answer that links a change order or a price is refused, in words", () => {
    const answer = { questionId: "Q-1", text: "Revised.", by: "Architect", at: "2026-11-01", outcome: "design_revision" };
    expect(readQuestionAnswerBody({ ...answer, links: [{ kind: "branch", ref: "B-1" }] }).ok).toBe(true);
    expect(readQuestionAnswerBody({ ...answer, links: [{ kind: "change_order", ref: "CO-3" }] })).toEqual({ ok: false, reason: 'an answer can\'t link "change_order"; an answer never links a change order or a price' });
    expect(readQuestionAnswerBody({ ...answer, links: [{ kind: "wf.price_quote", ref: "P-1" }] }).ok).toBe(false);
    expect(readQuestionAnswerBody({ ...answer, outcome: "wf.cost_impact" })).toEqual({ ok: false, reason: "an answer's outcome can't be commercial; an answer never links a change order or a price" });
  });
});
