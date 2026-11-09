import { z } from "zod";
import { canonicalJson } from "../canonical";
import { refuse, type ExecuteResult } from "../command-core";
import { executeDocumentEdit } from "../commands/views";
import { sheetPaperSize, type DrawingItem } from "../documents";
import { roundVec } from "../geometry";
import type { TrackedReader } from "../model";
import { asElementId, type ElementId, type ModelState } from "../types";
import { fieldBlockTemplateProblem } from "./render";
import { calcSheetTemplate } from "../calc-sheets/point";
import { peerReads } from "../elements/feature";
import { BLOCKS_CALC_FEATURE } from "./calc-block";
import { calcBlockInputSchema } from "./schema";
import { blockTableInputSchema, blockTableProblem, blockTableSpec } from "./table-spec";
import type { CalcBlockSpec, FieldBlockSpec } from "./types";

/**
 * Live block commands (blocks/types.ts): place a field-bound text block on a
 * sheet and change what it says. Moving it is the ordinary
 * `update_drawing_item { points: [at] }`, removing it `delete_drawing_item`,
 * and undo `restore_document_elements`, the same as every sheet item.
 */

const id = z.string().min(1).max(200);
const paperPoint = z.object({ x: z.number().finite(), y: z.number().finite() });
/** A block as a command sends it (`FieldBlockSpec`, ids as plain strings). */
const blockInput = z.object({
  template: z.string().min(1).max(8000),
  /** The element the fields read. Absent: the project's main service. */
  subjectId: id.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  /** A computed table (ventilation, pressurization) instead of field tokens; the template is then its caption. */
  table: blockTableInputSchema.optional(),
  /** A live calculation sheet (a registered template for the subject) instead of field tokens; the template is then its caption. */
  calc: calcBlockInputSchema.optional(),
});

export const blockCommandSchemas = [
  z.object({
    type: z.literal("add_field_block"),
    itemId: id,
    sheetId: id,
    /** Top-left corner of the box on the sheet, paper mm. */
    at: paperPoint,
    block: blockInput,
    /** Cap height of the text, paper mm. Absent: the note default. */
    textSize: z.number().positive().max(50).optional(),
  }),
  z.object({
    type: z.literal("edit_field_block"),
    itemId: id,
    template: z.string().min(1).max(8000).optional(),
    /** null takes the title off. */
    title: z.string().trim().min(1).max(120).nullable().optional(),
    /** null reads the project's main service again. */
    subjectId: id.nullable().optional(),
    /** A new table (or a new scope for it); null turns it back into a text block. */
    table: blockTableInputSchema.nullable().optional(),
    /** A new calculation (or new options for it); null turns it back into a text block. */
    calc: calcBlockInputSchema.nullable().optional(),
  }),
] as const satisfies readonly z.ZodObject[];

export type BlockCommand = z.infer<(typeof blockCommandSchemas)[number]>;

function commandTypes(schemas: readonly z.ZodObject[]): ReadonlySet<string> {
  return new Set(schemas.flatMap((s) => (s.shape.type instanceof z.ZodLiteral ? [String(s.shape.type.value)] : [])));
}

const TYPES = commandTypes(blockCommandSchemas);

export function isBlockCommand(command: { readonly type: string }): command is BlockCommand {
  return TYPES.has(command.type);
}

/** A calculation as the block stores it (options copied, so the command's object is never shared). */
function calcOf(input: z.infer<typeof calcBlockInputSchema>): CalcBlockSpec {
  return { template: input.template, ...(input.options ? { options: { ...input.options } } : {}) };
}

/** The competing-edit field a block's spec is authored under (`documentFieldValue` reads it). */
const BLOCK_FIELD = "doc.block";

function checkSpec(reader: TrackedReader, spec: FieldBlockSpec, itemId: string): void {
  const problem = fieldBlockTemplateProblem(spec.template);
  if (problem) refuse("invalid_value", `The block's text can't be used. ${problem}`, [asElementId(itemId)]);
  if (spec.table) {
    const tableProblem = blockTableProblem(reader, spec.table);
    if (tableProblem) refuse("element_not_found", tableProblem, [asElementId(itemId)]);
  }
  if (spec.calc) {
    if (spec.table) refuse("invalid_value", "A block shows a table or a calculation, not both.", [asElementId(itemId)]);
    // Mixed versions: a peer that doesn't read calculation blocks would draw the caption as plain text.
    if (!peerReads(BLOCKS_CALC_FEATURE)) refuse("invalid_value", "This can't be saved yet: the model server this model is open on is an older version that doesn't draw calculation sheets. Try again once the server is updated", [asElementId(itemId)]);
    if (!calcSheetTemplate(spec.calc.template)) refuse("element_not_found", `No add-on in this model has the ${spec.calc.template} calculation. Insert › Calculation lists the ones it has.`, [asElementId(itemId)]);
  }
  if (spec.subjectId === undefined) return;
  const subject = reader.find(spec.subjectId);
  if (!subject || ("deleted" in subject && subject.deleted)) {
    refuse("element_not_found", "The element this block reads no longer exists. Pick another, or leave it reading the project's main service.", [asElementId(itemId), spec.subjectId]);
  }
}

function liveBlock(reader: TrackedReader, itemId: string): DrawingItem {
  const el = reader.find(asElementId(itemId));
  if (!el || ("deleted" in el && el.deleted)) refuse("element_not_found", "That block no longer exists. Someone may have removed it.", [asElementId(itemId)]);
  if (el.kind !== "drawing_item" || el.shape !== "field_block" || !el.block) refuse("wrong_kind", `${itemId} is not a live block.`, [asElementId(itemId)]);
  return el;
}

export function executeBlockCommand(model: ModelState, command: BlockCommand): ExecuteResult {
  return executeDocumentEdit(model, ({ reader, write, authored }) => {
    switch (command.type) {
      case "add_field_block": {
        const itemId = asElementId(command.itemId);
        const existing = model.elements[itemId];
        if (existing) refuse("already_exists", "deleted" in existing && existing.deleted ? `${itemId} belonged to a removed ${existing.kind.replace(/_/g, " ")}; ids aren't reused. Use a new id.` : `${itemId} is already used by another element`, [itemId]);
        const sheet = reader.find(asElementId(command.sheetId));
        if (!sheet || ("deleted" in sheet && sheet.deleted)) refuse("element_not_found", "The sheet you're placing the block on no longer exists.", [asElementId(command.sheetId)]);
        if (sheet.kind !== "sheet") refuse("wrong_kind", "Live blocks go on sheets. Open a sheet and place it there.", [sheet.id]);
        const paper = sheetPaperSize(sheet);
        const at = roundVec(command.at);
        if (at.x < 0 || at.y < 0 || at.x > paper.x || at.y > paper.y) refuse("invalid_value", `The block's corner is off the sheet. Put it inside the ${paper.x} × ${paper.y} mm sheet.`, [itemId]);
        const spec: FieldBlockSpec = {
          template: command.block.template,
          ...(command.block.subjectId !== undefined ? { subjectId: asElementId(command.block.subjectId) } : {}),
          ...(command.block.title !== undefined ? { title: command.block.title } : {}),
          ...(command.block.table !== undefined ? { table: blockTableSpec(command.block.table) } : {}),
          ...(command.block.calc !== undefined ? { calc: calcOf(command.block.calc) } : {}),
        };
        checkSpec(reader, spec, itemId);
        const item: DrawingItem = {
          version: 0,
          authoredRev: {},
          id: itemId,
          kind: "drawing_item",
          ownerId: sheet.id,
          shape: "field_block",
          points: [at],
          block: spec,
          ...(command.textSize ? { textSize: command.textSize } : {}),
          ...(sheet.partition ? { partition: sheet.partition } : {}),
        };
        write(item);
        authored.push({ elementId: itemId, field: BLOCK_FIELD, value: canonicalJson(spec) });
        return;
      }
      case "edit_field_block": {
        const item = liveBlock(reader, command.itemId);
        const current = item.block as FieldBlockSpec;
        if (command.template === undefined && command.title === undefined && command.subjectId === undefined && command.table === undefined && command.calc === undefined) {
          refuse("invalid_value", "Nothing to change: give the block new text, a title, what it reads or which table or calculation it shows.", [item.id]);
        }
        const calc = command.calc === null ? undefined : command.calc !== undefined ? calcOf(command.calc) : current.calc;
        const title = command.title === null ? undefined : (command.title ?? current.title);
        const table = command.table === null ? undefined : command.table !== undefined ? blockTableSpec(command.table) : current.table;
        const subjectId: ElementId | undefined = command.subjectId === null ? undefined : command.subjectId !== undefined ? asElementId(command.subjectId) : current.subjectId;
        const next: FieldBlockSpec = {
          template: command.template ?? current.template,
          ...(subjectId !== undefined ? { subjectId } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(table !== undefined ? { table } : {}),
          ...(calc !== undefined ? { calc } : {}),
        };
        checkSpec(reader, next, item.id);
        write({ ...item, block: next });
        authored.push({ elementId: item.id, field: BLOCK_FIELD, value: canonicalJson(next) });
        return;
      }
    }
  });
}
