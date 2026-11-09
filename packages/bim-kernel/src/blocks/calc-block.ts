import { placeCalcSheet, type CalcSheetContext } from "../calc-sheets/point";
import { renderCalcSheet } from "../calc-sheets/render";
import { DEFAULT_SETTINGS, asRevision, type ElementId, type ModelState } from "../types";
import type { CalcBlockSpec, RenderedBlock } from "./types";

/**
 * A calculation block (round 12 S12): the block's template built for its
 * subject (`placeCalcSheet`), worked out against the model and the host's
 * tables and limits, and drawn as the sheet's table (`renderCalcSheet`), so a
 * calculation hashes, freezes at issue and reads "changed since" like every
 * block. The governing cell is named in the text, so moving it changes the
 * hash.
 *
 * Stored blocks with `calc` are written only to peers that advertise
 * `BLOCKS_CALC_FEATURE` (an older peer would draw the caption as text).
 */

export const BLOCKS_CALC_FEATURE = "blocks:calc";

export type CalcBlockContext = CalcSheetContext;

const NO_LIBRARY: CalcBlockContext = { tables: { table: () => null }, limits: {} };

export function renderCalcBlock(model: Pick<ModelState, "elements">, calc: CalcBlockSpec, subjectId: ElementId | undefined, ctx: CalcBlockContext = NO_LIBRARY): RenderedBlock {
  // Hosts pass whole model states; a caller with only elements gets an empty network and default settings.
  const full: ModelState = { modelId: "", revision: asRevision(0), connections: [], settings: DEFAULT_SETTINGS, ...model };
  const placed = placeCalcSheet(full, calc.template, { ...(subjectId !== undefined ? { subjectId } : {}), ...(calc.options ? { options: calc.options } : {}) }, ctx);
  if ("refused" in placed) {
    console.error("[bim-kernel/blocks] a calculation block can't be worked out", { template: calc.template, refused: placed.refused });
    return { text: placed.refused, unresolved: [calc.template], dependsOn: subjectId !== undefined ? [subjectId] : [] };
  }
  const rendered = renderCalcSheet(placed.spec, placed.evaluation, { withTitle: false });
  const deps = new Set(rendered.dependsOn);
  if (subjectId !== undefined) deps.add(subjectId);
  return { ...rendered, dependsOn: [...deps].sort() };
}
