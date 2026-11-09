import type { BimElement, ElementKind, Sheet } from "@permitzip/bim-kernel";
import { isQuestion, openQuestionsOnSheet, questionLabel, QUESTION_KIND, type Question } from "../../../../bim-kernel/src/questions";
import { clip, feet } from "../format";
import type { RuleContext, RuleDef } from "../registry";

/**
 * Questions and assumptions pinned to the model (ROADMAP F7): a question that
 * points at things that were deleted, and a sheet that went out while an open
 * question marked to hold it was still open (or past the phase it had to close
 * by). Trade-neutral: nothing here knows what the anchored elements are.
 *
 * No agent tool edits questions yet, so these findings carry no `fix.tool`;
 * the message names the place a person fixes it (Coordination › Questions).
 * When the agent gains `bim_edit_question`, add `fix` here.
 */

/** The element union gains "question" when the kind is registered; until then it is a plain kind key. */
const QUESTION_KINDS: readonly ElementKind[] = [QUESTION_KIND as string as ElementKind];

const WHERE = "in Coordination › Questions";

function atOf(ctx: RuleContext, q: Question) {
  const els = ctx.model.elements;
  const p = q.anchor.point;
  if (p) {
    const lvl = els[p.levelId];
    return { level: lvl?.kind === "level" ? lvl.name : "", x_ft: feet(p.position.x), y_ft: feet(p.position.y), z_ft: 0 };
  }
  for (const id of q.anchor.elementIds) {
    const el = els[id];
    const body = el ? ctx.body(el.id) : undefined;
    if (el && body) return { level: ctx.levelNameOf(el), x_ft: feet((body.box.min.x + body.box.max.x) / 2), y_ft: feet((body.box.min.y + body.box.max.y) / 2), z_ft: feet(body.box.min.z) };
  }
  return { level: "", x_ft: 0, y_ft: 0, z_ft: 0 };
}

function lastRevision(sheet: Sheet) {
  const revs = sheet.props?.revisions ?? [];
  return revs[revs.length - 1];
}

/** "DD" matches a revision described "Issued for DD" or "DD set", as a whole word, any case. */
function namesPhase(description: string, phase: string): boolean {
  const p = phase.trim();
  if (p === "") return false;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(description);
}


export const questionRules: readonly RuleDef[] = [
  {
    id: "question-anchor-gone",
    version: 1,
    pack: "documents",
    severity: "warning",
    title: "A question or assumption pinned to elements that were deleted",
    scope: "element",
    kinds: QUESTION_KINDS,
    run: (ctx, element: BimElement) => {
      // Read through the plain kind so this narrows the same before and after "question" joins the element union.
      const el: { readonly kind: string } = element;
      if (!isQuestion(el) || el.status === "withdrawn" || el.status === "answered") return;
      const gone = el.anchor.elementIds.filter((id) => ctx.model.elements[id] === undefined);
      if (gone.length === 0) return;
      const nothingLeft = gone.length === el.anchor.elementIds.length && !el.anchor.point;
      ctx.emit({
        rule: "question-anchor-gone",
        severity: nothingLeft ? "warning" : "info",
        elementIds: [el.id],
        at: atOf(ctx, el),
        message: clip(
          nothingLeft
            ? `${questionLabel(el)} points at nothing: what it was pinned to was deleted. Pin it again or withdraw it ${WHERE}`
            : `${questionLabel(el)} was pinned to ${gone.length === 1 ? "an element" : `${gone.length} elements`} since deleted. Check it still applies ${WHERE}`,
        ),
      });
    },
  },
  {
    id: "question-open-on-issued-sheet",
    version: 1,
    pack: "process",
    severity: "warning",
    title: "A sheet issued while a question marked to hold it is still open, or past the phase the question had to close by",
    scope: "document",
    kinds: ["sheet"],
    run: (ctx, el) => {
      if (el.kind !== "sheet" || el.deleted) return;
      const rev = lastRevision(el);
      if (!rev) return;
      for (const q of openQuestionsOnSheet(ctx.model, el.id)) {
        const late = q.closeBy !== undefined && namesPhase(rev.description, q.closeBy);
        if (!late && q.blocksIssue !== true) continue;
        ctx.emit({
          rule: "question-open-on-issued-sheet",
          severity: "warning",
          elementIds: [el.id, q.id],
          at: atOf(ctx, q),
          message: clip(
            late
              ? `${el.number} went out for ${q.closeBy} (Rev ${rev.number}) while ${questionLabel(q)}, due by ${q.closeBy}, is open. Answer or withdraw it ${WHERE}`
              : `${el.number} was issued (Rev ${rev.number}) while ${questionLabel(q)} is open and marked to hold it. Answer or withdraw it ${WHERE}`,
          ),
        });
      }
    },
  },
];
