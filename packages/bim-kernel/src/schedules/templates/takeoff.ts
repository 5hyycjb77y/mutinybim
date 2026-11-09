import { qtoMeasuredClasses } from "../../qto/fields";
import type { ScheduleColumnDef, ScheduleDefinitionV2 } from "../definition";

/**
 * Takeoff by cost code and stage (`qto.schedule`): every measured element,
 * grouped by its cost code and then its construction stage, with a total of
 * each quantity per group and for the model. An ordinary v2 schedule through
 * the existing engine: it opens in the grid, prints on a sheet and reads the
 * model live. Each heading says what its quantity is measured from, and the
 * MEASURED FROM column says it per row (Nielsen 2). Quantities only: prices
 * are never part of the model (product owner decision 4).
 */

export const TAKEOFF_SCHEDULE_TEMPLATE_ID = "qto.schedule";
export const TAKEOFF_SCHEDULE_NAME = "Takeoff by cost code and stage";
export const TAKEOFF_SCHEDULE_DESCRIPTION =
  "Every measured element grouped by its cost code, then its construction stage, with totals per group: lengths along centrelines, wall face areas less doors and windows, floor and ceiling areas less their holes, counts and weights";

const field = (path: string, heading: string, hideWhenEmpty = false): ScheduleColumnDef => ({ id: path, kind: "field", path, heading, ...(hideWhenEmpty ? { hideWhenEmpty: true } : {}) });
const quantity = (path: string, heading: string): ScheduleColumnDef => ({ id: path, kind: "field", path, heading, total: true, hideWhenEmpty: true });

/** The template's definition. `name` defaults to the template's name. */
export function takeoffScheduleDefinition(name: string = TAKEOFF_SCHEDULE_NAME): ScheduleDefinitionV2 {
  return {
    name,
    source: { kind: "classes", classes: [...qtoMeasuredClasses()], includeSubclasses: true },
    columns: [
      field("qto.code", "COST CODE"),
      field("qto.stage", "STAGE"),
      field("qto.group", "WHAT"),
      field("qto.size", "SIZE", true),
      quantity("qto.count", "COUNT"),
      quantity("qto.length", "LENGTH (CENTRELINE)"),
      quantity("qto.area_net", "WALL FACE AREA (LESS OPENINGS)"),
      quantity("qto.area", "AREA (LESS HOLES)"),
      quantity("qto.volume", "VOLUME"),
      quantity("qto.mass", "WEIGHT (FROM TYPE)"),
      field("qto.code_warning", "CODE CHECK", true),
      field("qto.measured_from", "MEASURED FROM"),
    ],
    filters: [],
    sort: [
      { path: "qto.code", direction: "asc" },
      { path: "qto.stage", direction: "asc" },
      { path: "qto.group", direction: "asc" },
    ],
    groups: [
      { path: "qto.code", header: true, footer: true, totals: true },
      { path: "qto.stage", header: true, footer: true, totals: true },
    ],
    grandTotals: true,
    itemize: true,
    presentation: { kind: "list" },
    display: { textSizeMm: 2.5, emptyText: "NOTHING MEASURED YET" },
  };
}
