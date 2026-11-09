import { sha256HexOf } from "../../authorship/canonical";
import { canonicalJson } from "../../canonical";
import { blockingOpenQuestions } from "../../questions/question-index";
import { holdReason } from "../../questions/holds";
import { divergencesIn } from "../../submittals/records";
import { DIVERGENCE_KIND } from "../../submittals/types";
import type { DivergenceElement } from "../../submittals/types";
import type { Question } from "../../questions/types";
import { staleRecords, type Validity } from "../../validity";
import { findingRefId, findingSubjects, findingWords, type FindingRef } from "../ref";
import type { FindingChange, FindingChangeContext, FindingReadContext, FindingSourceRow } from "./point";

/**
 * Three kernel producers whose findings are few and indexed already, so each
 * reads its own index again only when an edit touched its kind:
 *
 * - question holds: an open question marked to hold the issue (blocking);
 * - reliance: a record whose reliance may no longer hold (validity's
 *   incremental index; the finding id is C10's `reliance:<record id>`);
 * - divergence: an approved difference from the design basis (information).
 */

const QUESTION_KIND = "question";

export function questionFindingRef(q: Question, ctx: FindingReadContext): FindingRef {
  return {
    id: findingRefId("question", q.id),
    source: { kind: "question", id: q.id, version: "1" },
    severity: "blocking",
    subjects: findingSubjects([q.id, ...q.anchor.elementIds]),
    lineageId: ctx.lineageId,
    revision: ctx.model.revision,
    words: findingWords(holdReason(q)),
    fix: { commandHint: "answer_question" },
  };
}

function touchesKind(ctx: FindingChangeContext, kind: string): boolean {
  for (const id of ctx.changedIds) if (ctx.model.elements[id]?.kind === kind || ctx.previous.elements[id]?.kind === kind) return true;
  return false;
}

export const QUESTION_HOLD_FINDING_SOURCE: FindingSourceRow = {
  id: "question",
  label: "Open questions that hold an issue",
  all: (ctx) => blockingOpenQuestions(ctx.model.elements).map((q) => questionFindingRef(q, ctx)),
  changed: (ctx) => (touchesKind(ctx, QUESTION_KIND) ? "reread" : null),
};

/** The version of a "may no longer hold" finding: what changed, so a decision made against these changes re-opens when others come. */
function relianceVersion(v: Validity & { readonly state: "may_not_hold" }): string {
  return sha256HexOf(canonicalJson(v.changes.map((c) => [c.id, c.kind]).sort())).slice(0, 16);
}

export function relianceFindingRef(recordId: string, v: Validity & { readonly state: "may_not_hold" }, ctx: FindingReadContext): FindingRef {
  return {
    id: findingRefId("reliance", recordId),
    source: { kind: "reliance", id: recordId, version: relianceVersion(v) },
    severity: "warning",
    subjects: findingSubjects([recordId, ...v.changes.map((c) => c.id as string)]),
    lineageId: ctx.lineageId,
    revision: ctx.model.revision,
    words: findingWords(v.words),
  };
}

export const RELIANCE_FINDING_SOURCE: FindingSourceRow = {
  id: "reliance",
  label: "Approvals and answers that may no longer hold",
  all: (ctx) => [...staleRecords(ctx.model.elements)].map(([id, v]) => relianceFindingRef(id, v, ctx)),
  changed(ctx): FindingChange | null {
    const before = staleRecords(ctx.previous.elements);
    const after = staleRecords(ctx.model.elements);
    // The validity index shares its map when an edit touched nothing a record relied on.
    if (before === after) return null;
    const retire: string[] = [];
    const put: FindingRef[] = [];
    for (const id of before.keys()) if (!after.has(id)) retire.push(findingRefId("reliance", id));
    for (const [id, v] of after) if (before.get(id) !== v) put.push(relianceFindingRef(id, v, ctx));
    return retire.length === 0 && put.length === 0 ? null : { retire, put };
  },
};

export function divergenceFindingRef(d: DivergenceElement, ctx: FindingReadContext): FindingRef {
  const b = d.divergence.designBasis;
  return {
    id: findingRefId("divergence", d.id),
    source: { kind: "divergence", id: d.id, version: "1" },
    severity: "info",
    subjects: findingSubjects([d.id, ...(b.elementIds ?? []), ...(b.typeIds ?? [])]),
    lineageId: ctx.lineageId,
    revision: ctx.model.revision,
    words: findingWords(`${d.divergence.approvedProduct.label} was approved in place of the design basis (${d.divergence.approvedBy})`),
  };
}

export const DIVERGENCE_FINDING_SOURCE: FindingSourceRow = {
  id: "divergence",
  label: "Approved differences from the design",
  all: (ctx) => divergencesIn(ctx.model.elements).map((d) => divergenceFindingRef(d, ctx)),
  changed: (ctx) => (touchesKind(ctx, DIVERGENCE_KIND) ? "reread" : null),
};
