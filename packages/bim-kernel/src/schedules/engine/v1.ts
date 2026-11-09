import { SCHEDULE_CATEGORY_CLASSES } from "../../registry/builtin";
import { SCHEDULE_CATEGORY_LABELS, type ScheduleCategory, type ScheduleColumnDef, type ScheduleDefinition, type ScheduleDefinitionV2, type ScheduleSource } from "../definition";
import { BASE_FIELDS, DUCT_FIELDS, PANEL_FIELDS, PIPE_FIELDS } from "../records";
import type { FormScheduleDefinition } from "../forms/types";
import { formScheduleRow } from "../forms/evaluate";
import { isV1BuiltinField } from "./fields";

/** The display profile of a v1 schedule read as v2: numbers print bare, as in v1, because v1 headings name the unit (CFM, LENGTH). */
export const V1_SCHEDULE_PROFILE_ID = "mutinybim.v1-schedule";

/**
 * The heading v1 prints for a field only one category names that way (a
 * pipe's "OUTSIDE DIAMETER (INSULATED)" is a duct's "OUTSIDE SIZE"; a panel's
 * "BUS"). Undefined: the field's own label already matches.
 */
function categoryHeading(category: ScheduleCategory, field: string): string | undefined {
  if (field in BASE_FIELDS) return undefined;
  if (category === "pipe") return PIPE_FIELDS[field];
  if (category === "duct") return DUCT_FIELDS[field];
  if (category === "electrical_equipment") return PANEL_FIELDS[field];
  return undefined;
}

/**
 * A v1 definition read as v2: the category's built-in class, its columns as
 * field columns, its level as a scope, its default sort made explicit. v1
 * sheets still print through `schedule.ts`, unchanged; this is how the grid,
 * the authority and agents open the same schedule in the v2 engine.
 */
export function scheduleV1ToV2(def: ScheduleDefinition): ScheduleDefinitionV2 {
  const used = new Map<string, number>();
  const columns: ScheduleColumnDef[] = def.columns.map((c) => {
    const n = (used.get(c.field) ?? 0) + 1;
    used.set(c.field, n);
    const heading = c.heading ?? categoryHeading(def.category, c.field);
    return {
      id: n === 1 ? c.field : `${c.field}_${n}`,
      // Any other v1 column names a part parameter: it opens (blank) before a part declares it, as v1 printed it.
      kind: isV1BuiltinField(c.field) ? "field" : "parameter",
      path: c.field,
      ...(heading === undefined ? {} : { heading }),
      ...(c.widthMm === undefined ? {} : { widthMm: c.widthMm }),
    };
  });
  const sort = def.sort && def.sort.length > 0 ? def.sort : [{ field: def.category === "sheet_list" ? "number" : "mark" }];
  const level = def.level?.trim();
  return {
    name: def.title ?? SCHEDULE_CATEGORY_LABELS[def.category],
    source: { kind: "classes", classes: [SCHEDULE_CATEGORY_CLASSES[def.category]], includeSubclasses: true, ...(level ? { scope: { levels: [level] } } : {}) },
    columns,
    filters: (def.filters ?? []).map((f) => ({ path: f.field, op: f.op, value: f.value })),
    sort: sort.map((s) => ({ path: s.field, direction: "descending" in s && s.descending ? "desc" : "asc" })),
    groups: [],
    grandTotals: false,
    itemize: def.itemize !== false,
    presentation: { kind: "list" },
    display: { profile: V1_SCHEDULE_PROFILE_ID, textSizeMm: def.textSizeMm ?? 2.5, emptyText: def.emptyText ?? "NONE" },
  };
}

/** What a form lists when its kind's row says nothing (or its add-on is off): nothing outside the form itself. */
const NO_FORM_SOURCE: ScheduleSource = { kind: "classes", classes: [], includeSubclasses: true };

/**
 * A v1 form schedule (an add-on's form kind) read as v2: a schedule
 * whose presentation is the form. It carries the form unchanged, so it prints
 * exactly as the v1 form does (`scheduleV2Paper`).
 */
export function formScheduleToV2(def: FormScheduleDefinition): ScheduleDefinitionV2 {
  return {
    name: def.template.name,
    source: formScheduleRow(def.kind)?.source ?? NO_FORM_SOURCE,
    columns: [],
    filters: [],
    sort: [],
    groups: [],
    grandTotals: false,
    itemize: true,
    presentation: { kind: "form", template: def.kind, form: def },
    display: { textSizeMm: def.textSizeMm ?? 2, emptyText: def.emptyText ?? "NONE" },
  };
}
