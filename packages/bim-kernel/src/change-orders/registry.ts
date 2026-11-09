import { defineExtensionPoint } from "../packs/contract";
import type { PackSet } from "../packs/set";
import { CHANGE_WORDS, type ChangeSignificanceKindDef } from "./types";

/** The default for every target: nobody has said what kind of change it was. */
export const UNCLASSIFIED_KIND = "unclassified";

/** The kind whose citation is required: the coordination requirement that wasn't met. */
export const REQUIRED_COORDINATION_KIND = "required_coordination_not_done";

/** Built-in kinds, in the order the picker lists them. */
export const BUILT_IN_CHANGE_KINDS: readonly ChangeSignificanceKindDef[] = Object.freeze([
  { id: UNCLASSIFIED_KIND, label: CHANGE_WORDS.notClassified, description: "Nobody has said what kind of change this was yet." },
  { id: "no_change_order", label: "Not a change order", description: "Ordinary design development; nothing commercial follows." },
  { id: "no_cost", label: "No cost", description: "A real change, but nobody's cost changes because of it." },
  {
    id: REQUIRED_COORDINATION_KIND,
    label: "Required coordination not done",
    description: "Someone didn't do coordination the requirements or specifications already asked for. Cite the requirement.",
    needsCitation: true,
  },
  { id: "owner_requested", label: "Owner requested", description: "The owner or developer asked for this change.", mayLeadToChangeOrder: true },
  { id: "error_or_omission", label: "Error or omission", description: "Fixes a mistake or something left out of the documents." },
  { id: "field_condition", label: "Field condition", description: "Found on site: an existing condition that differs from what was drawn.", mayLeadToChangeOrder: true },
]);

const KIND_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/;

/**
 * Change kinds (contract 1.6.0). A firm or add-on contributes its own on this
 * point; its ids carry its namespace ("acme.allowance").
 */
export const CHANGE_SIGNIFICANCE_POINT = defineExtensionPoint<ChangeSignificanceKindDef>({
  id: "kernel.change_significance",
  version: 1,
  label: "Change kinds",
  idOf: (k) => k.id,
  builtins: () => BUILT_IN_CHANGE_KINDS,
});

/** Problems with a contributed kind, in words (empty: fine). Used by pack conformance. */
export function changeKindProblems(def: ChangeSignificanceKindDef): string[] {
  const out: string[] = [];
  if (!KIND_ID.test(def.id)) out.push(`change kind id "${def.id}" must be lower case words joined by _ (an add-on's start with its namespace and a dot)`);
  if (def.label.trim().length === 0) out.push(`change kind ${def.id}: label is empty`);
  if (def.description.trim().length === 0) out.push(`change kind ${def.id}: description is empty`);
  return out;
}

/** Kinds available on a model: built-ins, then the set's contributions. */
export function changeKindsFor(set: PackSet): readonly ChangeSignificanceKindDef[] {
  return set.items(CHANGE_SIGNIFICANCE_POINT);
}

export function changeKindById(set: PackSet, id: string): ChangeSignificanceKindDef | null {
  return changeKindsFor(set).find((k) => k.id === id) ?? null;
}

/** How a stored kind reads. Unknown ids are kept and named, never shown as "not classified". */
export function changeKindWords(set: PackSet, id: string | null | undefined): string {
  if (id === null || id === undefined || id === UNCLASSIFIED_KIND) return CHANGE_WORDS.notClassified;
  const def = changeKindById(set, id);
  return def ? def.label : `Classified as "${id}" (from an add-on this model doesn't have)`;
}

/** Whether a classification with this kind, reason and citation may be written (null) or why not. */
export function classificationProblem(set: PackSet, input: { readonly kind: string; readonly reason: string; readonly citation?: string | null }): string | null {
  const def = changeKindById(set, input.kind);
  if (!def) return `"${input.kind}" isn't a kind of change on this model.`;
  if (input.reason.trim().length === 0) return CHANGE_WORDS.reasonRequired;
  if (def.needsCitation === true && (input.citation ?? "").trim().length === 0) return CHANGE_WORDS.citationRequired;
  return null;
}
