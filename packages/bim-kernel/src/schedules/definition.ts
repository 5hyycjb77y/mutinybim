import type { Precision, UnitCode } from "@permitzip/bim-units";
import { PART_CATEGORY_LABELS } from "../parts";
import type { FormScheduleDefinition } from "./forms/types";

/**
 * Schedule definitions, stored on a schedule view (`ViewProps.schedule`).
 *
 * v1 (`ScheduleDefinition`) is one hard-coded category with a flat list of
 * field keys. It still prints exactly as it always has (`schedule.ts`) and
 * reads into the v2 engine through `scheduleV1ToV2` (`engine/v1.ts`).
 *
 * v2 (`ScheduleDefinitionV2`, SCHEDULES-PLAN §5a) lists object classes from
 * the registry, related elements or a catalog, with typed columns: fields,
 * formulas, relationship aggregates, expandable sub-tables and shared
 * library parameters. Schedule types are templates, never enums.
 */

// ---------------------------------------------------------------- v1

/** What a v1 schedule lists: one part category, the native legacy kinds, or the set's sheets. */
export const SCHEDULE_CATEGORIES = [
  "mechanical_equipment",
  "air_terminal",
  "duct_accessory",
  "pipe_accessory",
  "plumbing_fixture",
  "electrical_equipment",
  "electrical_device",
  "lighting_fixture",
  "generic",
  "sheet_list",
  /** Routed duct segments: size, insulation, inside and outside size, airflow and velocity. */
  "duct",
  /** Routed pipe segments: system, size, material, insulation and outside size. */
  "pipe",
] as const;
export type ScheduleCategory = (typeof SCHEDULE_CATEGORIES)[number];

export const SCHEDULE_CATEGORY_LABELS: Readonly<Record<ScheduleCategory, string>> = {
  ...PART_CATEGORY_LABELS,
  sheet_list: "Sheet list",
  duct: "Duct",
  pipe: "Pipe",
};

export const SCHEDULE_FILTER_OPS = ["equals", "not_equals", "contains", "greater_than", "less_than"] as const;
export type ScheduleFilterOp = (typeof SCHEDULE_FILTER_OPS)[number];

export interface ScheduleColumn {
  /** Field key from `scheduleFields` (mark, family, type, level, cfm, a parameter name…). */
  readonly field: string;
  /** Column heading; absent: the field's label. */
  readonly heading?: string;
  /** Column width on paper, mm; absent: sized to its longest text. */
  readonly widthMm?: number;
}

export interface ScheduleDefinition {
  readonly category: ScheduleCategory;
  /** Title row; absent: the category's name. */
  readonly title?: string;
  readonly columns: readonly ScheduleColumn[];
  /** Applied in order; text compares case-insensitively, numbers numerically. */
  readonly sort?: readonly { readonly field: string; readonly descending?: boolean }[];
  /** All must hold. */
  readonly filters?: readonly { readonly field: string; readonly op: ScheduleFilterOp; readonly value: string }[];
  /** Only elements on this level (by name). Absent: every level. */
  readonly level?: string;
  /** Combine rows whose shown values all match, with a count column. */
  readonly itemize?: boolean;
  /** Text height of the rows, paper mm. Absent: 2.5 (3/32"). */
  readonly textSizeMm?: number;
  /** The row an empty schedule prints under its headings. Absent: "NONE"; "": headings only. */
  readonly emptyText?: string;
}

// ---------------------------------------------------------------- v2 (§5a, §5b)

export type ScheduleColumnId = string;
export type ScheduleColumnKind = "field" | "formula" | "aggregate" | "expand" | "parameter";
/** How an `expand` sub-table prints: indented child rows, the parent row only, or not at all. */
export type ExpandPaper = "nested" | "summary" | "hidden";
export type AggregateFn = "sum" | "count" | "min" | "max" | "avg" | "list";

/** A conditional highlight: a boolean formula over the row (`{load} > 0.8 * {capacity_a}`) with the reason shown in a tooltip. */
export interface ColumnHighlight {
  readonly when: string;
  readonly tone: "warning" | "danger";
  readonly reason: string;
}

interface ColumnDefBase {
  readonly id: ScheduleColumnId;
  /** Absent: the field's label. */
  readonly heading?: string;
  /** Display unit, overriding the profile for this column. */
  readonly unit?: UnitCode;
  readonly precision?: Precision;
  /** Show a total in group footers and the grand total. Refused when the kind or relationship can't add. */
  readonly total?: boolean;
  readonly hideWhenEmpty?: boolean;
  /** Grid width, px (per-person widths live in the host's prefs). */
  readonly width?: number;
  /** Paper width, mm. Absent: sized to its longest text. */
  readonly widthMm?: number;
  readonly highlights?: readonly ColumnHighlight[];
}

export type ScheduleColumnDef =
  | (ColumnDefBase & { readonly kind: "field"; readonly path: string })
  | (ColumnDefBase & { readonly kind: "parameter"; readonly path: string })
  | (ColumnDefBase & { readonly kind: "formula"; readonly expression: string; readonly calculation?: string })
  | (ColumnDefBase & { readonly kind: "aggregate"; readonly fn: AggregateFn; readonly relationship: string; readonly path?: string })
  | (ColumnDefBase & { readonly kind: "expand"; readonly relationship: string; readonly columns: readonly string[]; readonly paper: ExpandPaper });

/** Narrows any source to part of the building. Absent fields: no limit. */
export interface ScheduleScope {
  /** Level names, matched case-insensitively. */
  readonly levels?: readonly string[];
  readonly systems?: readonly string[];
  readonly zones?: readonly string[];
  readonly rooms?: readonly string[];
  readonly phase?: string;
  /** Include read-only rows from linked models that carry property sets. */
  readonly links?: boolean;
}

export type ScheduleSource =
  | { readonly kind: "classes"; readonly classes: readonly string[]; readonly includeSubclasses: boolean; readonly scope?: ScheduleScope }
  | { readonly kind: "related"; readonly from: string; readonly relationship: string; readonly depth?: number }
  | { readonly kind: "catalog"; readonly catalog: string };

export type FilterOp = "equals" | "not_equals" | "contains" | "greater_than" | "less_than" | "present" | "absent";

export interface ScheduleFilter {
  readonly path: string;
  readonly op: FilterOp;
  readonly value?: string;
}

export interface ScheduleSort {
  readonly path: string;
  readonly direction: "asc" | "desc";
}

export interface ScheduleGroup {
  readonly path: string;
  readonly header: boolean;
  readonly footer: boolean;
  readonly totals: boolean;
}

/**
 * A library item a schedule uses, copied into the model so prints never change behind its back (§3a).
 * The same header as `@permitzip/bim-library`'s `LibraryPin`, with the item's body as `body`
 * (the host checks the content hash with `checkPin`; the kernel never asks a library).
 */
export interface SchedulePin {
  readonly id: string;
  /** Library item type. `formula`: a named calculation (`PZ.GasDemandBtuh`) the schedule's formulas may call. */
  readonly type?: string;
  readonly revision: number;
  readonly contentHash: string;
  /** The item as pinned. A calculation: `{ key, expression, params?, result }`; its expression names params bare (`input_mbh`), and braces (`{cfm}`) mean a field of the row. */
  readonly body: unknown;
}

/** How the schedule prints: a list of rows, or a form (panel slot grid, feeder schedule…) laid out by a template. */
export type SchedulePresentation =
  | { readonly kind: "list" }
  | {
      readonly kind: "form";
      /** Built-in form kind (`panel`, `feeder`…) or a firm template key. */
      readonly template: string;
      /** The model's own copy of the form (template, bound equipment, rules). Absent: the built-in template for `template`. */
      readonly form?: FormScheduleDefinition;
    };

export interface ScheduleDefinitionV2 {
  readonly name: string;
  readonly source: ScheduleSource;
  readonly columns: readonly ScheduleColumnDef[];
  readonly filters: readonly ScheduleFilter[];
  readonly sort: readonly ScheduleSort[];
  readonly groups: readonly ScheduleGroup[];
  readonly grandTotals: boolean;
  /** False: rows whose shown values all match combine into one, with a count. */
  readonly itemize: boolean;
  readonly presentation: SchedulePresentation;
  readonly display: { readonly profile?: string; readonly textSizeMm: number; readonly emptyText: string };
  readonly pins?: readonly SchedulePin[];
}
