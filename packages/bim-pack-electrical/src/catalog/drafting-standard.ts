import { z } from "zod";
import { catalogEntryOf, type CatalogEntryTypeRow, type ModelState } from "@permitzip/bim-kernel";

/**
 * Electrical drafting standard (product decision, Nov 4 2026): how a typical's repeated
 * home runs are labelled is a template, set by the firm and the project, not
 * a hard-coded choice. The project's choice is a catalog record in the model
 * (`electrical_drafting`, one per model), so plans and printed sheets read the
 * same words everywhere; the firm's standard is a library tag type keyed
 * `electrical.typ_label` (`definition.template`) that seeds it.
 *
 * Tokens: `{circuit}` (the home run's tag, "P2-1") and `{count}` (how many
 * units carry the circuit). A template must say `{count}`.
 */

export const DRAFTING_STANDARD_NAME = "Electrical drafting";
export const TYP_LABEL_TAG_TYPE_KEY = "electrical.typ_label";
export const TYP_LABEL_TOKENS = ["circuit", "count"] as const;

export const TYP_LABEL_PRESETS = [
  { id: "circuit_count", label: "Circuit, count and TYP. (P2-1 (3) TYP.)", template: "{circuit} ({count}) TYP." },
  { id: "count_only", label: "Count and TYP. only ((3) TYP.)", template: "({count}) TYP." },
] as const;

export const DEFAULT_TYP_LABEL_TEMPLATE: string = TYP_LABEL_PRESETS[0].template;

/** Why a template can't be used, in words, or null. */
export function typLabelTemplateProblem(template: string): string | null {
  const t = template.trim();
  if (t.length === 0) return "The label is empty: write it with {count}, e.g. ({count}) TYP.";
  if (t.length > 60) return "The label is longer than 60 characters";
  const unknown = [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1] ?? "").filter((tok) => !(TYP_LABEL_TOKENS as readonly string[]).includes(tok));
  if (unknown.length > 0) return `The label uses {${unknown[0]}}, which isn't a field here: use {circuit} or {count}`;
  if (!t.includes("{count}")) return "The label must say how many units carry the circuit: add {count}";
  return null;
}

/** The label a template gives ("P2-1 (3) TYP."), extra spaces collapsed when `{circuit}` is empty. */
export function typLabelFrom(template: string, circuit: string, count: number): string {
  return template.replace(/\{circuit\}/g, circuit).replace(/\{count\}/g, String(count)).replace(/\s+/g, " ").trim();
}

export const draftingStandardSchema = z.object({
  type: z.literal("electrical_drafting"),
  name: z.literal(DRAFTING_STANDARD_NAME),
  typLabelTemplate: z.string().trim().min(1).max(60).refine((t) => typLabelTemplateProblem(t) === null, { message: "a label with {count}, and {circuit} only as the other field" }),
  /** Where the template came from: a preset, the firm's standard (with its library revision), or typed for this project. */
  source: z.union([
    z.object({ kind: z.literal("preset"), presetId: z.string().min(1).max(40) }),
    z.object({ kind: z.literal("firm"), itemId: z.string().min(1).max(200), revision: z.number().int().positive() }),
    z.object({ kind: z.literal("project") }),
  ]),
});
export type DraftingStandardEntry = z.infer<typeof draftingStandardSchema>;

export const DRAFTING_STANDARD_ROW: CatalogEntryTypeRow = {
  type: "electrical_drafting",
  idPrefix: "edraft",
  label: "Electrical drafting standard",
  schema: draftingStandardSchema,
  nameOf: (entry) => {
    const name = (entry as { readonly name?: unknown }).name;
    return typeof name === "string" ? name : "";
  },
  trade: () => "electrical",
};

/** The project's typical-label template: its drafting record, else the default preset. */
export function typLabelTemplateOf(model: Pick<ModelState, "elements">): string {
  const entry = catalogEntryOf(model.elements, "electrical_drafting", DRAFTING_STANDARD_NAME);
  const t = entry?.typLabelTemplate;
  return typeof t === "string" && typLabelTemplateProblem(t) === null ? t : DEFAULT_TYP_LABEL_TEMPLATE;
}

/** A firm tag type item's template (`definition.template`) when it is the typical label and usable; else null. */
export function firmTypLabelTemplate(item: { readonly key: string; readonly definition: Readonly<Record<string, unknown>> }): string | null {
  if (item.key !== TYP_LABEL_TAG_TYPE_KEY) return null;
  const t = item.definition.template;
  return typeof t === "string" && typLabelTemplateProblem(t) === null ? t.trim() : null;
}
