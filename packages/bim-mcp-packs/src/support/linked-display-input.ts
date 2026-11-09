import { z } from "zod";
import {
  IFC_CATEGORY_PATTERN,
  LINE_WEIGHTS,
  MAX_REFERENCE_TRANSPARENCY_PCT,
  REFERENCE_DISPLAY_PRESETS,
  referenceDisplayPreset,
  referencePresetDisplay,
  withPens,
  type ReferenceCategoryDisplay,
  type ReferenceDisplay,
} from "@permitzip/bim-kernel";

/**
 * How agents set and read a view's linked-model display: the same presets
 * the panels offer (normal, halftone, transparent, underlay, hidden) plus the
 * see-through amount and per-IFC-category exceptions. Only the linked models
 * named change; the others keep what the view had.
 */

const categoryInput = z
  .object({ visible: z.boolean().optional(), halftone: z.boolean().optional() })
  .strict()
  .nullable()
  .describe("null clears this category's exception.");

export const linkedModelDisplayInput = z
  .object({
    display: z
      .enum(REFERENCE_DISPLAY_PRESETS)
      .optional()
      .describe("normal: full colour. halftone: grey linework on paper, grey and 30% see-through in 3D (architecture). transparent: grey and 60% see-through in 3D. underlay: screened lighter on paper, faint beneath our work in 3D. hidden: not drawn or printed."),
    visible: z.boolean().optional(),
    halftone: z.boolean().optional(),
    transparency_pct: z.number().min(0).max(MAX_REFERENCE_TRANSPARENCY_PCT).optional().describe("3D only: how see-through, 0-90."),
    underlay: z.boolean().optional(),
    categories: z
      .record(z.string().regex(IFC_CATEGORY_PATTERN, "Use an IFC category such as IFCWALL."), categoryInput)
      .optional()
      .describe('Per IFC category of the linked model, e.g. {"IFCDOOR": {"visible": false}, "IFCWALL": {"halftone": false}}.'),
    cut_line_weight: z.enum(LINE_WEIGHTS).nullable().optional().describe("Drawings: pen for what the cut passes through (walls). null goes back to wide."),
    beyond_line_weight: z.enum(LINE_WEIGHTS).nullable().optional().describe("Drawings: pen for what is seen below the cut (furniture, slab edges). null goes back to thin."),
  })
  .strict();

export const linkedModelsInput = z
  .record(z.string().min(1).max(200), linkedModelDisplayInput)
  .describe("Per linked model id: how it draws in this view (plans, sections, sheets, PDFs, pictures and the live 3D canvas). Linked models you leave out keep their setting.");

export type LinkedModelDisplayInput = z.infer<typeof linkedModelDisplayInput>;

/** The view's linked-model map after applying what the agent sent. */
export function linkedModelsPatch(current: Readonly<Record<string, ReferenceDisplay>> | undefined, input: Readonly<Record<string, LinkedModelDisplayInput>>): Record<string, ReferenceDisplay> {
  const out: Record<string, ReferenceDisplay> = { ...(current ?? {}) };
  for (const [id, change] of Object.entries(input)) {
    const previous = out[id];
    const start: ReferenceDisplay = change.display ? withPens(referencePresetDisplay(change.display), previous) : (previous ?? referencePresetDisplay("halftone"));
    const categories: Record<string, ReferenceCategoryDisplay> = { ...(start.categories ?? {}) };
    for (const [category, c] of Object.entries(change.categories ?? {})) {
      if (c === null) delete categories[category];
      else categories[category] = c;
    }
    const { categories: _old, cutPen, beyondPen, ...rest } = start;
    const cut = change.cut_line_weight === undefined ? cutPen : (change.cut_line_weight ?? undefined);
    const beyond = change.beyond_line_weight === undefined ? beyondPen : (change.beyond_line_weight ?? undefined);
    out[id] = {
      ...rest,
      ...(cut ? { cutPen: cut } : {}),
      ...(beyond ? { beyondPen: beyond } : {}),
      ...(change.visible !== undefined ? { visible: change.visible } : {}),
      ...(change.halftone !== undefined ? { halftone: change.halftone } : {}),
      ...(change.transparency_pct !== undefined ? { transparencyPct: Math.round(change.transparency_pct) } : {}),
      ...(change.underlay !== undefined ? { underlay: change.underlay } : {}),
      ...(Object.keys(categories).length > 0 ? { categories } : {}),
    };
  }
  return out;
}

/** A view's linked-model display as an agent reads it. */
export function linkedModelsSummary(references: Readonly<Record<string, ReferenceDisplay>>) {
  return Object.fromEntries(
    Object.entries(references).map(([id, d]) => [
      id,
      {
        display: referenceDisplayPreset(d),
        visible: d.visible,
        halftone: d.halftone,
        ...(d.transparencyPct !== undefined ? { transparency_pct: d.transparencyPct } : {}),
        ...(d.underlay ? { underlay: true } : {}),
        ...(d.categories ? { categories: d.categories } : {}),
        ...(d.cutPen ? { cut_line_weight: d.cutPen } : {}),
        ...(d.beyondPen ? { beyond_line_weight: d.beyondPen } : {}),
      },
    ]),
  );
}
