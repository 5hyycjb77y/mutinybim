/**
 * What an answer did (contract 1.5.0, reserved; NEXT-BATCH-8 §10). An answer
 * names one outcome: a clarification, "not in scope", a decision recorded, a
 * design revision, a branch opened, or one a workflow registers. Outcomes are
 * a registry, so an add-on or a firm's workflow adds its own without a kernel
 * edit.
 *
 * Commercially neutral by construction: an outcome may link only to model
 * things (a determination, a revision range, a branch, or a kind a workflow
 * names), never to anything commercial. Whether a change that followed an
 * answer matters commercially is a separate classification a responsible
 * professional makes (lane O); nothing here creates or implies one.
 *
 * Imports only the contract, so every layer may read it.
 */
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { QuestionStatus } from "./types";

/** What an answer's link points at. Open: a workflow may name its own model-side kind. */
export type QuestionOutcomeLinkKind = "determination" | "revision_range" | "branch" | (string & {});

export interface QuestionOutcomeDef {
  /** The stored id. Bare for built-ins, `<ns>.<name>` for an add-on. Frozen once stored. */
  readonly id: string;
  /** What people read ("Clarification"). */
  readonly label: string;
  /** One plain sentence on what choosing it means. */
  readonly description?: string;
  /** The status the question takes when an answer with this outcome is recorded. */
  readonly questionStatus: Extract<QuestionStatus, "answered" | "not_in_scope">;
  /** The link kinds an answer with this outcome may carry; none: it carries no links. */
  readonly links?: readonly QuestionOutcomeLinkKind[];
}

const BUILTIN_OUTCOMES: readonly QuestionOutcomeDef[] = Object.freeze([
  { id: "clarification", label: "Clarification", description: "The answer explains; nothing in the design changes.", questionStatus: "answered" },
  { id: "not_in_scope", label: "Not in scope", description: "The person asked says it isn't theirs to answer; disregard.", questionStatus: "not_in_scope" },
  { id: "judgment_recorded", label: "Decision recorded", description: "A judgment call, recorded as a decision the model can cite.", questionStatus: "answered", links: ["determination"] },
  { id: "design_revision", label: "Design revision", description: "The design was revised; the answer links the revisions or the branch.", questionStatus: "answered", links: ["revision_range", "branch"] },
  { id: "branch_opened", label: "Branch opened", description: "A branch was opened to work the answer through.", questionStatus: "answered", links: ["branch"] },
]);

/** The built-in outcome ids every peer of contract 1.5.0 reads. */
export const BUILTIN_QUESTION_OUTCOME_IDS: readonly string[] = Object.freeze(BUILTIN_OUTCOMES.map((o) => o.id));

/** Answer outcomes (v1), by stored id. Built-ins are the kernel's; add-ons and workflows add the rest. */
export const QUESTION_OUTCOME_POINT = defineExtensionPoint<QuestionOutcomeDef>({
  id: "kernel.question_outcome",
  version: 1,
  label: "Answer outcomes",
  idOf: (o) => o.id,
  builtins: () => BUILTIN_OUTCOMES,
});

/**
 * Words an outcome id, label or link kind may never carry: an answer is never
 * linked to anything commercial. Checked on every registered row and every
 * stored link.
 */
const COMMERCIAL = /\b(change\s+orders?|co|costs?|costing|pric(e|es|ed|ing)|fees?|invoices?|payments?|money|amounts?|dollars?|budgets?|charges?)\b/i;

/** Whether a link kind or outcome word names something commercial (never allowed on an answer). Matches whole words: `wf.price_quote`, `changeOrder`, "Cost impact". */
export function isCommercialWord(text: string): boolean {
  return COMMERCIAL.test(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._:\-/]+/g, " "));
}

/**
 * Why a registered outcome row breaks the contract, in words, or an empty
 * list. The pack conformance check and a firm library writer call it.
 */
export function questionOutcomeProblems(def: QuestionOutcomeDef): string[] {
  const problems: string[] = [];
  if (!def.label.trim()) problems.push(`answer outcome ${def.id} needs a label`);
  if (def.questionStatus !== "answered" && def.questionStatus !== "not_in_scope") problems.push(`answer outcome ${def.id} must leave the question answered or not in scope`);
  if (isCommercialWord(def.id) || isCommercialWord(def.label) || isCommercialWord(def.description ?? "")) problems.push(`answer outcome ${def.id} is commercial; an answer never links a change order or a price`);
  for (const k of def.links ?? []) if (isCommercialWord(k)) problems.push(`answer outcome ${def.id} links "${k}"; an answer never links a change order or a price`);
  return problems;
}

interface OutcomeTable {
  readonly rows: readonly QuestionOutcomeDef[];
  readonly byId: ReadonlyMap<string, QuestionOutcomeDef>;
}

function table(set: PackSet = activePackSet()): OutcomeTable {
  return set.memo("kernel.question_outcome#table", () => {
    const rows = set.items(QUESTION_OUTCOME_POINT).filter((r) => questionOutcomeProblems(r).length === 0);
    return { rows, byId: new Map(rows.map((r) => [r.id, r] as const)) };
  });
}

/** Every answer outcome in the set in force: built-ins, then add-ons. A row that breaks the contract is left out. */
export function listQuestionOutcomes(set?: PackSet): readonly QuestionOutcomeDef[] {
  return table(set).rows;
}

/** The registered row for a stored outcome id, or null when this set doesn't know it (readers keep the id). */
export function questionOutcomeDef(id: string, set?: PackSet): QuestionOutcomeDef | null {
  return table(set).byId.get(id) ?? null;
}

/** A stored outcome in words: the registry's label, else the id's own words ("wf.referred_on" → "Referred on"). Never the raw id. */
export function questionOutcomeLabel(id: string, set?: PackSet): string {
  const row = table(set).byId.get(id);
  if (row) return row.label;
  const words = (id.split(/[.:]/).pop() ?? id).replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Other";
}
