import { z } from "zod";
import { parseFieldTemplate } from "../../fields/template";
import { formScheduleRow } from "./evaluate";

/**
 * Form schedules (G6): a schedule bound to one element (a panel) or to a
 * catalog (feeder types), laid out in sections: a header of labelled values,
 * a body (a two-column slot grid or a list of rows), a summary of loads by
 * class with totals, and a notes legend. Every cell is a field-path template
 * (fields/resolver.ts), filled from the model at the revision it is drawn
 * from: nothing is typed in, so nothing goes stale.
 *
 * The template says which fields show and how; the firm keeps default
 * templates per kind and a schedule carries its own copy, so a sheet prints
 * the same everywhere and a firm template edit never rewrites issued sheets.
 */

/**
 * A stored form kind. The kinds are the add-ons' (`FORM_SCHEDULE_POINT` rows:
 * `formScheduleKinds`, `formScheduleKindLabel`, `isBoundFormKind`); the kernel
 * names none.
 */
export type FormScheduleKind = string;

export const FORM_ALIGNS = ["left", "center", "right"] as const;

export interface FormHeaderField {
  readonly label: string;
  /** Field template filled on the schedule's element ("{supply_from}", "{bus} {mains}"). */
  readonly value: string;
}

export interface FormColumn {
  readonly heading: string;
  /** Field template filled on the row's subject (the circuit in a panel, the part in a list). */
  readonly value: string;
  readonly widthMm?: number;
  readonly align?: (typeof FORM_ALIGNS)[number];
}

export interface FormNote {
  /** Printed in brackets in the NOTES column and the legend: "G" → [G]. */
  readonly mark: string;
  readonly text: string;
  /**
   * When a circuit gets the mark: a member parameter that is on ("gfci"), or
   * field=value ("load_class=Motor"). Absent: legend only (a general note).
   */
  readonly when?: string;
}

export type FormBody =
  /** Odd slots left, even slots right, the slot's load in its phase's column (panels). */
  | { readonly layout: "slots"; readonly columns: readonly FormColumn[]; readonly phaseLoads: boolean }
  /** One row per subject (a switchboard's feeders, feeder types, connection types, equipment). */
  | { readonly layout: "rows"; readonly columns: readonly FormColumn[] };

export interface FormSummary {
  /** Connected, demand factor and demand by load class, from the code rules. */
  readonly loadClasses: boolean;
  /** Total connected and demand, kVA and amps; spares and spaces. */
  readonly totals: boolean;
  /** kVA and amps on each phase. */
  readonly phaseTotals: boolean;
}

export interface FormTemplate {
  readonly name: string;
  /** Title template on the schedule's element ("PANEL {name}"); for catalogs, the text itself. */
  readonly title: string;
  readonly header: { readonly fields: readonly FormHeaderField[]; readonly columns: number };
  readonly body: FormBody;
  readonly summary?: FormSummary;
  readonly notes: readonly FormNote[];
  /** "Supply from" wording for `{supply_from}`; absent: the default ("MDP via 225A/3P via F225"). */
  readonly supplyFrom?: string;
  /** List kinds: which part categories are rows (equipment connections). Absent: the kind's default. */
  readonly categories?: readonly string[];
}

export interface FormScheduleDefinition {
  readonly kind: FormScheduleKind;
  /** Panel / switchboard schedules: the equipment it is the schedule of. */
  readonly elementId?: string;
  readonly template: FormTemplate;
  /** Code rules id for demand ("nec-2023"); absent: connected loads only, and the schedule says so. */
  readonly rules?: string;
  /** Text height of body rows, paper mm. Absent: 2.0. */
  readonly textSizeMm?: number;
  /** The row a list schedule with nothing to list prints. Absent: "NONE"; "": headings only. */
  readonly emptyText?: string;
  /** The firm template it was made from, for "update from firm template". */
  readonly templateSource?: { readonly name: string; readonly revision: number };
}

// ------------------------------------------------------------------ validation

const fieldTemplate = (max: number) =>
  z
    .string()
    .max(max)
    .superRefine((value, ctx) => {
      const parsed = parseFieldTemplate(value);
      if (!parsed.ok) ctx.addIssue({ code: "custom", message: `${parsed.error} (at character ${parsed.at + 1})` });
    });

const heading = z.string().trim().max(40);
const column = z
  .object({
    heading,
    value: fieldTemplate(160),
    widthMm: z.number().min(4).max(150).optional(),
    align: z.enum(FORM_ALIGNS).optional(),
  })
  .strict();

const note = z
  .object({
    mark: z.string().trim().min(1).max(4),
    text: z.string().trim().min(1).max(120),
    when: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const formTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    title: fieldTemplate(120),
    header: z.object({ fields: z.array(z.object({ label: z.string().trim().min(1).max(40), value: fieldTemplate(200) }).strict()).max(24).readonly(), columns: z.number().int().min(1).max(4) }).strict(),
    body: z.discriminatedUnion("layout", [
      z.object({ layout: z.literal("slots"), columns: z.array(column).min(1).max(8).readonly(), phaseLoads: z.boolean() }).strict(),
      z.object({ layout: z.literal("rows"), columns: z.array(column).min(1).max(16).readonly() }).strict(),
    ]),
    summary: z.object({ loadClasses: z.boolean(), totals: z.boolean(), phaseTotals: z.boolean() }).strict().optional(),
    notes: z.array(note).max(16).readonly(),
    supplyFrom: fieldTemplate(200).optional(),
    categories: z.array(z.string().min(1).max(40)).max(10).readonly().optional(),
  })
  .strict();

export const formScheduleSchema = z
  .object({
    kind: z.string().trim().min(1).max(60),
    elementId: z.string().min(1).max(200).optional(),
    template: formTemplateSchema,
    rules: z.string().trim().min(1).max(40).optional(),
    textSizeMm: z.number().min(1.5).max(6).optional(),
    emptyText: z.string().trim().max(60).optional(),
    templateSource: z.object({ name: z.string().min(1).max(80), revision: z.number().int().min(1) }).strict().optional(),
  })
  .strict()
  .superRefine((def, ctx) => {
    const row = formScheduleRow(def.kind);
    if (!row) {
      ctx.addIssue({ code: "custom", path: ["kind"], message: `No add-on loaded here makes ${def.kind.replace(/_/g, " ")} schedules` });
      return;
    }
    const label = (row.label ?? def.kind.replace(/_/g, " ")).toLowerCase();
    if (row.boundTo !== undefined && !def.elementId) ctx.addIssue({ code: "custom", path: ["elementId"], message: `A ${label} needs the ${row.boundTo} it is the schedule of` });
    if (row.boundTo === undefined && def.elementId) ctx.addIssue({ code: "custom", path: ["elementId"], message: `A ${label} lists the whole model; it isn't bound to one element` });
    const slots = row.template?.body.layout === "slots";
    if (slots && def.template.body.layout !== "slots") ctx.addIssue({ code: "custom", path: ["template", "body"], message: `A ${label}'s body is the slot grid` });
    if (!slots && def.template.body.layout === "slots") ctx.addIssue({ code: "custom", path: ["template", "body"], message: `Only a kind whose template is a slot grid has one; a ${label} lists rows` });
  });
