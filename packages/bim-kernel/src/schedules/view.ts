import type { Primitive } from "../drawing/sheet";
import type { ViewProps } from "../documents";
import type { ModelState, Vec2 } from "../types";
import { drawFormTable, formTable } from "./forms/layout";
import { drawScheduleV2, scheduleV2Paper } from "./paper";
import { drawScheduleTable, scheduleTable, type ScheduleTable } from "./schedule";
import { scheduleV1ToV2 } from "./engine/v1";

/**
 * A schedule view is a list schedule (`props.schedule`), a form schedule
 * (`props.formSchedule`) or a v2 schedule (`props.scheduleV2`, list or form);
 * all are tables whose paper size is their window at scale 1. The viewport,
 * crop and print paths ask here and never care which.
 */

/** The table's paper size, or null when the view has no schedule yet. */
export function scheduleViewSize(model: Pick<ModelState, "elements">, props: ViewProps | undefined): Vec2 | null {
  if (props?.formSchedule) return formTable(model, props.formSchedule).size;
  if (props?.schedule) return scheduleTable(model, props.schedule).size;
  if (props?.scheduleV2) return scheduleV2Paper(model, props.scheduleV2).table.size;
  return null;
}

/** Draw the schedule with its top-left corner at `topLeft` (paper mm). */
export function drawScheduleView(prims: Primitive[], model: Pick<ModelState, "elements">, props: ViewProps | undefined, topLeft: Vec2): void {
  if (props?.formSchedule) drawFormTable(prims, formTable(model, props.formSchedule), topLeft);
  else if (props?.schedule) drawScheduleTable(prims, scheduleTable(model, props.schedule), topLeft);
  else if (props?.scheduleV2) drawScheduleV2(prims, scheduleV2Paper(model, props.scheduleV2), topLeft);
}

/** One printed column of a list schedule on paper: the definition column it comes from (null: not sized by hand) and its edges from the table's left, mm. */
export interface ScheduleViewColumn {
  readonly columnId: string | null;
  readonly x0: number;
  readonly x1: number;
}

/** Smallest and largest width a person may drag a schedule column to on a sheet, paper mm. */
export const SCHEDULE_COLUMN_MIN_MM = 6;
export const SCHEDULE_COLUMN_MAX_MM = 400;

function columnsOf(table: ScheduleTable, ids: readonly (string | null)[]): ScheduleViewColumn[] {
  const out: ScheduleViewColumn[] = [];
  let x = 0;
  table.columnWidths.forEach((w, i) => {
    out.push({ columnId: ids[i] ?? null, x0: x, x1: x + w });
    x += w;
  });
  return out;
}

/**
 * A list schedule's printed columns with their edges, for resizing them where
 * the schedule sits on a sheet. Null for a form schedule (its template lays it
 * out) or a view with no schedule.
 */
export function scheduleViewColumns(model: Pick<ModelState, "elements">, props: ViewProps | undefined): readonly ScheduleViewColumn[] | null {
  if (props?.formSchedule) return null;
  if (props?.scheduleV2) {
    const paper = scheduleV2Paper(model, props.scheduleV2);
    return paper.kind === "list" ? columnsOf(paper.table, paper.columnIds ?? []) : null;
  }
  if (props?.schedule) return columnsOf(scheduleTable(model, props.schedule), scheduleV1ToV2(props.schedule).columns.map((c) => c.id));
  return null;
}

/** A dragged column width, rounded to a tenth of a mm and kept within what prints legibly. */
export function clampScheduleColumnWidth(widthMm: number): number {
  return Math.round(Math.min(SCHEDULE_COLUMN_MAX_MM, Math.max(SCHEDULE_COLUMN_MIN_MM, widthMm)) * 10) / 10;
}
