import { z } from "zod";
import type { ExecuteResult } from "../command-core";
import { asElementId, type ModelState } from "../types";
import { applyScheduleSteps, editableScheduleOf } from "../schedules/engine/steps";
import { executeViewCommand, scheduleV2Schema } from "./views";
import { peerReads } from "../elements/feature";
import { SCHEDULE_COLUMN_MAX_MM, SCHEDULE_COLUMN_MIN_MM } from "../schedules/view";

/**
 * Document edits as steps (contract 1.13.0), beside the views and sheets
 * commands. Lane D15 builds them.
 *
 * - `edit_schedule`: change a schedule view one step at a time (add, move or
 *   remove a column; its filters, sort, groups and totals), the same steps the
 *   schedule grid sends when a person drags a column or sets a filter. Each
 *   command is one undo step. Columns, filters, sorts and groups take the
 *   shapes a stored schedule (`scheduleV2`) already holds.
 * - `insert_library_view`: copy a firm library drafting view or detail into
 *   the model as a new detail view with its drawing items. The host resolves
 *   the library item and sends it pinned (id, revision, content hash and
 *   body), so the copy never changes behind the model's back; the kernel never
 *   asks a library.
 *
 * Peers that store what they write advertise the features.
 */
export const SCHEDULES_EDIT_STEPS_FEATURE = "schedules:edit_steps";
/** Peers that take the `resize_column` step (a column's paper width dragged on a sheet, batch 16-B). */
export const SCHEDULES_COLUMN_WIDTHS_FEATURE = "schedules:column_widths";

/** Until lane D15 lands, each is refused with its own words. */
export const EDIT_SCHEDULE_NOT_BUILT = "Editing a schedule step by step isn't built yet";
export const INSERT_LIBRARY_VIEW_NOT_BUILT = "Inserting a view from the library isn't built yet";

const id = z.string().min(1).max(200);
const columnId = z.string().trim().min(1).max(80);
const position = z.number().int().min(0).max(200);

/** The stored shapes a step carries, taken from the schedule a view stores. */
export const scheduleColumnSchema = scheduleV2Schema.shape.columns.unwrap().element;
export const scheduleFilterSchema = scheduleV2Schema.shape.filters.unwrap().element;
export const scheduleSortSchema = scheduleV2Schema.shape.sort.unwrap().element;
export const scheduleGroupSchema = scheduleV2Schema.shape.groups.unwrap().element;

export const scheduleEditStepSchema = z.discriminatedUnion("op", [
  /** Insert a column at `at` (0 is first); absent: last. */
  z.object({ op: z.literal("add_column"), column: scheduleColumnSchema, at: position.optional() }).strict(),
  z.object({ op: z.literal("move_column"), columnId, to: position }).strict(),
  z.object({ op: z.literal("remove_column"), columnId }).strict(),
  /** The heading people read; null: the field's own label again. */
  z.object({ op: z.literal("rename_column"), columnId, heading: z.string().trim().max(60).nullable() }).strict(),
  /** The whole filter list (replaces it; [] shows every row). */
  z.object({ op: z.literal("filter"), filters: z.array(scheduleFilterSchema).max(16) }).strict(),
  /** The whole sort, first key first (replaces it). */
  z.object({ op: z.literal("sort"), sort: z.array(scheduleSortSchema).max(8) }).strict(),
  /** The whole grouping, outermost first (replaces it). */
  z.object({ op: z.literal("group"), groups: z.array(scheduleGroupSchema).max(4) }).strict(),
  /** Show or hide a column's totals; without `columnId`, the grand totals. */
  z.object({ op: z.literal("totals"), columnId: columnId.optional(), show: z.boolean() }).strict(),
  /** Its paper width, mm; null sizes it to its text again. */
  z.object({ op: z.literal("resize_column"), columnId, widthMm: z.number().finite().min(SCHEDULE_COLUMN_MIN_MM).max(SCHEDULE_COLUMN_MAX_MM).nullable() }).strict(),
]);
export type ScheduleEditStep = z.infer<typeof scheduleEditStepSchema>;

/** A firm library item as the host pins it into a command. */
export const libraryViewPinSchema = z
  .object({
    itemId: z.string().min(1).max(200),
    revision: z.number().int().min(1),
    contentHash: z.string().min(1).max(100),
    /** The drafting view as the library stores it; its shape is checked when the copy is made. */
    body: z.record(z.string(), z.unknown()),
  })
  .strict();
export type LibraryViewPin = z.infer<typeof libraryViewPinSchema>;

export const documentStepCommandSchemas = [
  z.object({
    type: z.literal("edit_schedule"),
    viewId: id,
    /** Applied in order, as one edit. */
    steps: z.array(scheduleEditStepSchema).min(1).max(50),
  }),
  z.object({
    type: z.literal("insert_library_view"),
    /** The new detail view's id; its drawing items' ids start with `idPrefix`. */
    viewId: id,
    idPrefix: z.string().min(1).max(80),
    /** Absent: the library item's own name. */
    name: z.string().trim().min(1).max(120).optional(),
    item: libraryViewPinSchema,
  }),
] as const;

export type DocumentStepCommand = z.infer<(typeof documentStepCommandSchemas)[number]>;

const TYPES: ReadonlySet<string> = new Set(documentStepCommandSchemas.map((s) => s.shape.type.value));

export function isDocumentStepCommand(command: { readonly type: string }): command is DocumentStepCommand {
  return TYPES.has(command.type);
}

function refused(message: string, elementIds: readonly string[] = [], code: "invalid_value" | "element_not_found" | "wrong_kind" = "invalid_value"): ExecuteResult {
  return { ok: false, error: { code, message, elementIds: elementIds.map(asElementId) } };
}

/**
 * `edit_schedule`: the steps applied in order to the view's schedule, saved
 * as its v2 schedule in one edit (one undo step). An old list schedule is
 * read as v2 first, so its first edit stores it as v2 and Undo puts the old
 * one back. A step that can't be done refuses the whole edit in words.
 */
function executeEditSchedule(model: ModelState, command: Extract<DocumentStepCommand, { type: "edit_schedule" }>): ExecuteResult {
  const el = model.elements[command.viewId];
  if (!el) return refused(`There is no view ${command.viewId}.`, [command.viewId], "element_not_found");
  if (el.kind !== "view" || el.viewType !== "schedule") return refused(`"${el.kind === "view" ? el.name : command.viewId}" isn't a schedule.`, [command.viewId], "wrong_kind");
  if (command.steps.some((s) => s.op === "resize_column") && !peerReads(SCHEDULES_COLUMN_WIDTHS_FEATURE)) {
    return refused("Column widths can't be saved yet: the model server this model is open on is an older version. Try again once it is updated.", [el.id]);
  }
  const current = editableScheduleOf(el.name, el.props);
  if (!current.ok) return refused(current.reason, [el.id]);
  const applied = applyScheduleSteps(current.definition, command.steps);
  if (!applied.ok) return refused(applied.reason, [el.id]);
  const checked = scheduleV2Schema.safeParse(applied.definition);
  if (!checked.success) return refused(`That change doesn't fit the schedule: ${checked.error.issues[0]?.message ?? "check the columns"}.`, [el.id]);
  return executeViewCommand(model, { type: "set_view_properties", viewId: el.id, props: { scheduleV2: applied.definition } });
}

/** Run `edit_schedule`; `insert_library_view` is refused in words until lane D15 lands. */
export function executeDocumentStepCommand(model: ModelState, command: DocumentStepCommand): ExecuteResult {
  if (command.type === "edit_schedule") return executeEditSchedule(model, command);
  return refused(INSERT_LIBRARY_VIEW_NOT_BUILT);
}
