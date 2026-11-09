import { documentIndex } from "../commands/views";
import type { DrawingItem } from "../documents";
import type { ElementId, ModelState, Sheet } from "../types";
import { BLOCK_TABLE_SEPARATOR } from "./hash";
import { renderFieldBlock, sheetFieldBlocks, type BlockRenderOptions } from "./render";
import type { BlockTableKind } from "./table-spec";
import type { FieldBlockSpec, RenderedBlock } from "./types";

/**
 * One live block, many placements (ROADMAP F5, KERNEL-REQUIREMENTS-MODEL §3.6).
 * A block's definition is the `block` spec on its `field_block` item; the
 * sheet it sits on draws it there, and any other host (a report, the agent)
 * holds only the item's id and renders the same spec through here. Editing the
 * definition (`edit_field_block`) is the one write, so every placement shows
 * the same text after it, and the same hash freezes at issue.
 */

/** What a block is, in words a picker shows: a load summary, or one of the computed tables. */
export type ModelBlockKind = "text" | BlockTableKind;

export interface ModelBlockRef {
  readonly blockId: ElementId;
  /** The sheet it is drawn on (its home placement). */
  readonly sheetId: ElementId;
  readonly sheetNumber: string;
  readonly sheetName: string;
  readonly kind: ModelBlockKind;
  readonly title: string | null;
  readonly spec: FieldBlockSpec;
}

export function modelBlockKind(spec: FieldBlockSpec): ModelBlockKind {
  return spec.table?.kind ?? "text";
}

function refOf(item: DrawingItem, sheet: Pick<Sheet, "id" | "number" | "title">): ModelBlockRef | null {
  if (!item.block) return null;
  return { blockId: item.id, sheetId: sheet.id, sheetNumber: sheet.number, sheetName: sheet.title, kind: modelBlockKind(item.block), title: item.block.title ?? null, spec: item.block };
}

/** Every live block in the model, sheet by sheet (sheet order, then item id). Reads the document index, never the elements. */
export function modelBlocks(model: Pick<ModelState, "elements" | "connections">): ModelBlockRef[] {
  const out: ModelBlockRef[] = [];
  for (const sheet of documentIndex(model).sheets) {
    for (const item of sheetFieldBlocks(model, sheet.id)) {
      const ref = refOf(item, sheet);
      if (ref) out.push(ref);
    }
  }
  return out;
}

/** One block by id, or null when it is gone (deleted, or not a live block). */
export function modelBlock(model: Pick<ModelState, "elements" | "connections">, blockId: string): ModelBlockRef | null {
  const el = model.elements[blockId];
  if (el?.kind !== "drawing_item" || el.shape !== "field_block" || !el.block || el.deleted) return null;
  const sheet = documentIndex(model).sheets.find((s) => s.id === el.ownerId);
  return sheet ? refOf(el, sheet) : null;
}

/** A block's value now, the same one its sheet draws (`fieldBlockTextBlock` renders this spec). */
export function renderModelBlock(model: Pick<ModelState, "elements" | "connections">, blockId: string, opts: BlockRenderOptions = {}): (ModelBlockRef & { readonly rendered: RenderedBlock }) | null {
  const ref = modelBlock(model, blockId);
  return ref ? { ...ref, rendered: renderFieldBlock(model, ref.spec, opts) } : null;
}

export { BLOCK_TABLE_SEPARATOR };

export interface BlockTextTable {
  /** Lines before the table (none for today's tables). */
  readonly lead: readonly string[];
  readonly header: readonly string[] | null;
  readonly rows: readonly (readonly string[])[];
  /** Lines after it: zone and building totals, the counted total, notes. */
  readonly notes: readonly string[];
}

/**
 * A rendered block's text as a table, for hosts that draw real table cells
 * (a report): the first line holding " | " is the header; following lines
 * with as many cells are rows; every other line is a note, in order. A text
 * block has no header and comes back as notes only, so the host prints it as
 * paragraphs. The text itself is what hashes and freezes; this only splits it.
 */
export function blockTextTable(text: string): BlockTextTable {
  const lines = text.split("\n");
  const lead: string[] = [];
  const rows: string[][] = [];
  const notes: string[] = [];
  let header: string[] | null = null;
  for (const line of lines) {
    if (header === null) {
      if (line.includes(BLOCK_TABLE_SEPARATOR)) header = line.split(BLOCK_TABLE_SEPARATOR);
      else lead.push(line);
      continue;
    }
    const cells = line.split(BLOCK_TABLE_SEPARATOR);
    if (notes.length === 0 && cells.length === header.length) rows.push(cells);
    else notes.push(line);
  }
  return header === null ? { lead: [], header: null, rows: [], notes: lead } : { lead, header, rows, notes };
}
