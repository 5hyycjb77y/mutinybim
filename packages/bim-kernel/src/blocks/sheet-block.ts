import type { DrawingItem } from "../documents";
import { DEFAULT_NOTE_SIZE_MM, NOTE_LIMITS, type NoteParagraph } from "../annotation/rich-text";
import { layoutNote } from "../annotation/text-layout";
import type { TextBlock } from "../annotation/text-note";
import type { ModelState } from "../types";
import { renderFieldBlock, type BlockRenderOptions } from "./render";
import type { RenderedBlock } from "./types";

/**
 * A field block as the sheet draws it: a text box at the item's point (paper
 * mm, top-left), the title bold on the first line, then the rendered lines.
 * The same `TextBlock` notes use, so screen and PDF lay it out identically.
 */

/** Paper mm the box is wide when the item doesn't say (about 6 inches). */
export const DEFAULT_FIELD_BLOCK_WIDTH_MM = 152.4;

/** Per sheet render: a block id → the rendered value to draw instead of the live one (an issued copy draws its snapshot). */
export type FrozenBlocks = Readonly<Record<string, RenderedBlock>>;

export function fieldBlockParagraphs(title: string | undefined, text: string): NoteParagraph[] {
  const lines = text.split("\n").map((line): NoteParagraph => ({ runs: line.length ? [{ text: line }] : [] }));
  return title ? [{ runs: [{ text: title, bold: true }] }, ...lines] : lines;
}

/** The text box for a field block item, or null for any other item. */
export function fieldBlockTextBlock(model: Pick<ModelState, "elements">, item: DrawingItem, opts: BlockRenderOptions & { readonly frozen?: FrozenBlocks } = {}): TextBlock | null {
  if (item.shape !== "field_block" || !item.block) return null;
  const at = item.points[0];
  if (!at) return null;
  const rendered = opts.frozen?.[item.id] ?? renderFieldBlock(model, item.block, opts);
  const width = Math.min(NOTE_LIMITS.maxWidthMm, Math.max(NOTE_LIMITS.minWidthMm, item.note?.box.width ?? DEFAULT_FIELD_BLOCK_WIDTH_MM));
  const layout = layoutNote(fieldBlockParagraphs(item.block.title, rendered.text), { width, height: null, size: item.textSize ?? DEFAULT_NOTE_SIZE_MM });
  return { itemId: item.id, origin: { x: at.x, y: at.y }, rotation: 0, layout };
}
