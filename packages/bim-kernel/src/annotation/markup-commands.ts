import { z } from "zod";
import { canonicalJson } from "../canonical";
import { refuse, type ExecuteResult } from "../command-core";
import { documentIndex, executeDocumentEdit } from "../commands/views";
import { DOCUMENT_FIELDS } from "../document-fields";
import { sheetPaperSize, type DrawingItem } from "../documents";
import { peerReads } from "../elements/feature";
import { roundVec } from "../geometry";
import type { TrackedReader } from "../model";
import { asElementId, type ModelState } from "../types";
import {
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_WIDTH_MM,
  MARKUP_SMART_SHAPES,
  MARKUP_STATUSES,
  MARKUP_TOOLS,
  SHEET_MARKUPS_FEATURE,
  sheetMarkupSpecSchema,
  type SheetMarkupSpec,
} from "./markups";

/**
 * Sheet review markup commands: add, update (colour/width/status/yellow-line
 * backcheck note), and clear review strokes on sheets. Deleting a single
 * stroke uses `delete_drawing_item` and undo uses `restore_document_elements`,
 * keeping the same sync, conflict and undo spine as every other sheet object.
 */

const id = z.string().min(1).max(200);
const paperPoint = z.object({ x: z.number().finite(), y: z.number().finite() });
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const addMarkupSpecInput = z
  .object({
    tool: z.enum(MARKUP_TOOLS).optional(),
    color: hexColor.optional(),
    widthMm: z.number().finite().min(0.3).max(30).optional(),
    opacity: z.number().finite().min(0.1).max(1).optional(),
    status: z.enum(MARKUP_STATUSES).optional(),
    smartShape: z.enum(MARKUP_SMART_SHAPES).optional(),
    author: z.string().trim().min(1).max(120).optional(),
    createdAt: z.string().trim().min(1).max(64).optional(),
    addressedNote: z.string().trim().min(1).max(500).optional(),
    addressedColor: hexColor.optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const sheetMarkupCommandSchemas = [
  z.object({
    type: z.literal("add_sheet_markup"),
    itemId: id,
    sheetId: id,
    /** Paper-mm points along the stroke (1 point = a dot tap; up to 500 points). */
    points: z.array(paperPoint).min(1).max(500),
    markup: addMarkupSpecInput.optional(),
  }),
  z.object({
    type: z.literal("update_sheet_markup"),
    itemId: id,
    points: z.array(paperPoint).min(1).max(500).optional(),
    tool: z.enum(MARKUP_TOOLS).optional(),
    color: hexColor.optional(),
    widthMm: z.number().finite().min(0.3).max(30).optional(),
    opacity: z.number().finite().min(0.1).max(1).nullable().optional(),
    status: z.enum(MARKUP_STATUSES).optional(),
    smartShape: z.enum(MARKUP_SMART_SHAPES).nullable().optional(),
    addressedNote: z.string().trim().min(1).max(500).nullable().optional(),
    addressedColor: hexColor.nullable().optional(),
    note: z.string().trim().min(1).max(500).nullable().optional(),
  }),
  z.object({
    type: z.literal("clear_sheet_markups"),
    sheetId: id,
    /** Only remove markups matching these statuses; absent removes all markups on the sheet. */
    statuses: z.array(z.enum(MARKUP_STATUSES)).min(1).max(3).optional(),
  }),
] as const satisfies readonly z.ZodObject[];

export type SheetMarkupCommand = z.infer<(typeof sheetMarkupCommandSchemas)[number]>;

const TYPES: ReadonlySet<string> = new Set(sheetMarkupCommandSchemas.map((s) => s.shape.type.value));

export function isSheetMarkupCommand(command: { readonly type: string }): command is SheetMarkupCommand {
  return TYPES.has(command.type);
}

function checkPeerSupport(elementIds: readonly string[]): void {
  if (!peerReads(SHEET_MARKUPS_FEATURE)) {
    refuse(
      "invalid_value",
      "Sheet markups can't be saved yet: the model server this model is open on is an older version that doesn't store sheet markups. Try again once the server is updated",
      elementIds.map(asElementId),
    );
  }
}

function liveMarkup(reader: TrackedReader, itemId: string): DrawingItem {
  const el = reader.find(asElementId(itemId));
  if (!el || ("deleted" in el && el.deleted)) refuse("element_not_found", "That markup no longer exists. Someone may have removed it.", [asElementId(itemId)]);
  if (el.kind !== "drawing_item" || el.shape !== "markup" || !el.markup) refuse("wrong_kind", `${itemId} is not a sheet markup.`, [asElementId(itemId)]);
  return el;
}

const SHEET_MARGIN_MM = 50;

function checkSheetPoints(points: readonly { readonly x: number; readonly y: number }[], paper: { readonly x: number; readonly y: number }, itemId: string): void {
  for (const p of points) {
    if (p.x < -SHEET_MARGIN_MM || p.y < -SHEET_MARGIN_MM || p.x > paper.x + SHEET_MARGIN_MM || p.y > paper.y + SHEET_MARGIN_MM) {
      refuse("invalid_value", `Markup stroke falls outside the ${paper.x} × ${paper.y} mm sheet bounds.`, [asElementId(itemId)]);
    }
  }
}

export function executeSheetMarkupCommand(model: ModelState, command: SheetMarkupCommand): ExecuteResult {
  return executeDocumentEdit(model, ({ reader, write, authored }) => {
    switch (command.type) {
      case "add_sheet_markup": {
        checkPeerSupport([command.itemId]);
        const itemId = asElementId(command.itemId);
        const existing = model.elements[itemId];
        if (existing) {
          refuse(
            "already_exists",
            "deleted" in existing && existing.deleted
              ? `${itemId} belonged to a removed ${existing.kind.replace(/_/g, " ")}; ids aren't reused. Use a new id.`
              : `${itemId} is already used by another element`,
            [itemId],
          );
        }
        const sheet = reader.find(asElementId(command.sheetId));
        if (!sheet || ("deleted" in sheet && sheet.deleted)) refuse("element_not_found", "The sheet you're marking up no longer exists.", [asElementId(command.sheetId)]);
        if (sheet.kind !== "sheet") refuse("wrong_kind", "Review markups go on sheets. Open a sheet to mark it up.", [sheet.id]);
        const paper = sheetPaperSize(sheet);
        const points = command.points.map(roundVec);
        checkSheetPoints(points, paper, command.itemId);
        const rawSpec = command.markup ?? {};
        const parsed = sheetMarkupSpecSchema.parse({
          tool: rawSpec.tool ?? "marker",
          color: rawSpec.color ?? DEFAULT_MARKER_COLOR,
          widthMm: rawSpec.widthMm ?? DEFAULT_MARKER_WIDTH_MM,
          status: rawSpec.status ?? "open",
          ...(rawSpec.opacity !== undefined ? { opacity: rawSpec.opacity } : {}),
          ...(rawSpec.smartShape !== undefined ? { smartShape: rawSpec.smartShape } : {}),
          ...(rawSpec.author !== undefined ? { author: rawSpec.author } : {}),
          ...(rawSpec.createdAt !== undefined ? { createdAt: rawSpec.createdAt } : {}),
          ...(rawSpec.addressedNote !== undefined ? { addressedNote: rawSpec.addressedNote } : {}),
          ...(rawSpec.addressedColor !== undefined ? { addressedColor: rawSpec.addressedColor } : {}),
          ...(rawSpec.note !== undefined ? { note: rawSpec.note } : {}),
        });
        const item: DrawingItem = {
          version: 0,
          authoredRev: {},
          id: itemId,
          kind: "drawing_item",
          ownerId: sheet.id,
          shape: "markup",
          points,
          markup: parsed,
          ...(sheet.partition ? { partition: sheet.partition } : {}),
        };
        write(item);
        authored.push({ elementId: itemId, field: DOCUMENT_FIELDS.markup, value: canonicalJson(parsed) });
        authored.push({ elementId: itemId, field: DOCUMENT_FIELDS.points, value: canonicalJson(points) });
        return;
      }
      case "update_sheet_markup": {
        checkPeerSupport([command.itemId]);
        const item = liveMarkup(reader, command.itemId);
        const sheet = reader.find(item.ownerId);
        if (!sheet || sheet.kind !== "sheet" || sheet.deleted) refuse("element_not_found", "That markup's sheet no longer exists.", [item.id, item.ownerId]);
        const points = command.points ? command.points.map(roundVec) : item.points;
        if (command.points) checkSheetPoints(points, sheetPaperSize(sheet), item.id);
        const cur = item.markup as SheetMarkupSpec;
        const nextSpec: SheetMarkupSpec = {
          tool: command.tool ?? cur.tool,
          color: command.color ?? cur.color,
          widthMm: command.widthMm ?? cur.widthMm,
          status: command.status ?? cur.status,
          ...(command.opacity === null ? {} : command.opacity !== undefined ? { opacity: command.opacity } : cur.opacity !== undefined ? { opacity: cur.opacity } : {}),
          ...(command.smartShape === null ? {} : command.smartShape !== undefined ? { smartShape: command.smartShape } : cur.smartShape !== undefined ? { smartShape: cur.smartShape } : {}),
          ...(cur.author !== undefined ? { author: cur.author } : {}),
          ...(cur.createdAt !== undefined ? { createdAt: cur.createdAt } : {}),
          ...(command.addressedNote === null ? {} : command.addressedNote !== undefined ? { addressedNote: command.addressedNote } : cur.addressedNote !== undefined ? { addressedNote: cur.addressedNote } : {}),
          ...(command.addressedColor === null ? {} : command.addressedColor !== undefined ? { addressedColor: command.addressedColor } : cur.addressedColor !== undefined ? { addressedColor: cur.addressedColor } : {}),
          ...(command.note === null ? {} : command.note !== undefined ? { note: command.note } : cur.note !== undefined ? { note: cur.note } : {}),
        };
        const merged: DrawingItem = {
          ...item,
          points,
          markup: nextSpec,
        };
        write(merged);
        if (command.points) authored.push({ elementId: item.id, field: DOCUMENT_FIELDS.points, value: canonicalJson(points) });
        authored.push({ elementId: item.id, field: DOCUMENT_FIELDS.markup, value: canonicalJson(nextSpec) });
        return;
      }
      case "clear_sheet_markups": {
        checkPeerSupport([command.sheetId]);
        const sheet = reader.find(asElementId(command.sheetId));
        if (!sheet || ("deleted" in sheet && sheet.deleted)) refuse("element_not_found", "The sheet no longer exists.", [asElementId(command.sheetId)]);
        if (sheet.kind !== "sheet") refuse("wrong_kind", "Only sheets hold review markups.", [sheet.id]);
        const allowed = command.statuses ? new Set(command.statuses) : null;
        const markups = documentIndex(model).markupsBySheet.get(sheet.id) ?? [];
        for (const item of markups) {
          if (item.deleted || item.shape !== "markup" || !item.markup) continue;
          if (allowed && !allowed.has(item.markup.status)) continue;
          reader.find(item.id);
          write({ ...item, deleted: true });
          authored.push({ elementId: item.id, field: DOCUMENT_FIELDS.deleted, value: "true" });
        }
        return;
      }
    }
  });
}
