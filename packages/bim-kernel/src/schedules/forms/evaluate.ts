import { defineExtensionPoint } from "../../packs/contract";
import { activePackSet } from "../../packs/scope";
import { firstPartyStoredOwner } from "../../packs/first-party/manifests";
import { packNotLoadedMessage } from "../../packs/set";
import type { ModelState } from "../../types";
import { empty, type EvaluatedForm } from "./support";
import type { FormScheduleDefinition, FormTemplate } from "./types";
import type { ScheduleSource } from "../definition";

export type { EvaluatedForm, FormAlign, FormGrid } from "./support";

/**
 * A form schedule as it prints at one model state, from the pack that owns
 * its kind (`FORM_SCHEDULE_POINT`): the shared shape is in `./support.ts`, the
 * kinds themselves in their packs.
 */


/**
 * One form schedule kind (v1), from the pack that owns it: how it evaluates
 * and (round 15, additive) what a person calls it, the template a new one
 * starts from, whether it is the schedule of one element, and what it lists.
 * The kernel names no kind: New schedule, the agent tools and the firm
 * template library list the rows in force.
 */
export interface FormScheduleDef {
  /** The stored form kind (`FormScheduleDefinition.kind`). */
  readonly kind: string;
  evaluate(model: Pick<ModelState, "elements">, def: FormScheduleDefinition): EvaluatedForm;
  /** What a person calls it (the menus' words). Absent: the kind. */
  readonly label?: string;
  /** The built-in template a new one starts from (before a firm saves its own). Absent: the kind can't be made new. */
  readonly template?: FormTemplate;
  /** Set when it is the schedule of one element: what that element is, in words (the refusal names it). */
  readonly boundTo?: string;
  /** What it lists, for the grid and agents. Absent: nothing listed outside the form. */
  readonly source?: ScheduleSource;
  /** Where it sorts among the kinds in force, lowest first. Absent: after the ordered ones, in contribution order. */
  readonly order?: number;
}

/** Form schedule evaluators, by stored form kind (bare: kinds are stored). */
export const FORM_SCHEDULE_POINT = defineExtensionPoint<FormScheduleDef>({ id: "kernel.form_schedule", version: 1, label: "Form schedules", idOf: (f) => f.kind, namespaced: false });

/** The form kind row in force for `kind`, or null (its add-on is off or not installed). */
export function formScheduleRow(kind: string): FormScheduleDef | null {
  return formDef(kind);
}

function formDef(kind: string): FormScheduleDef | null {
  const set = activePackSet();
  return set.memo("kernel.form_schedule#table", () => new Map(set.items(FORM_SCHEDULE_POINT).map((f) => [f.kind, f] as const))).get(kind) ?? null;
}

/** The form schedule as it prints at this model state (cached per pack set, model state and definition). */
export function evaluateFormSchedule(model: Pick<ModelState, "elements">, def: FormScheduleDefinition): EvaluatedForm {
  const set = activePackSet();
  const evaluated = set.memo("kernel.form_schedule#evaluated", () => new WeakMap<object, WeakMap<FormScheduleDefinition, EvaluatedForm>>());
  let byDef = evaluated.get(model.elements);
  if (!byDef) {
    byDef = new WeakMap();
    evaluated.set(model.elements, byDef);
  }
  const known = byDef.get(def);
  if (known) return known;
  const row = formDef(def.kind);
  if (!row) console.error("[bim-kernel/schedules] no pack in this model's set evaluates this form kind; it prints empty", { kind: def.kind });
  const out = row ? row.evaluate(model, def) : empty(def, def.kind.replace(/_/g, " ").toUpperCase(), (() => { const owner = firstPartyStoredOwner("form", def.kind); return owner ? packNotLoadedMessage(owner) : `No add-on in this model evaluates ${def.kind} schedules`; })());
  byDef.set(def, out);
  return out;
}

/** The form kinds in force that a person can make new (their rows carry a template), in their order. */
export function formScheduleKinds(): readonly string[] {
  const set = activePackSet();
  return set.memo("kernel.form_schedule#kinds", (s) => {
    const rows = s.items(FORM_SCHEDULE_POINT).filter((f) => f.template !== undefined);
    return rows.map((f, i) => ({ f, i })).sort((a, b) => (a.f.order ?? Number.MAX_SAFE_INTEGER) - (b.f.order ?? Number.MAX_SAFE_INTEGER) || a.i - b.i).map(({ f }) => f.kind);
  });
}

/** What a person calls a form kind; for a kind no add-on in force names, the kind in words. */
export function formScheduleKindLabel(kind: string): string {
  return formDef(kind)?.label ?? kind.replace(/_/g, " ");
}

/** Whether a form kind is the schedule of one element, as its row says. */
export function isBoundFormKind(kind: string): boolean {
  return formDef(kind)?.boundTo !== undefined;
}

/** The built-in template a new schedule of this kind starts from, from the add-on that owns it. Throws, in words, when none in force has it. */
export function builtinFormTemplate(kind: string): FormTemplate {
  const template = formDef(kind)?.template;
  if (template) return template;
  const owner = firstPartyStoredOwner("form", kind);
  throw new Error(owner ? packNotLoadedMessage(owner) : `No add-on loaded here makes ${kind.replace(/_/g, " ")} schedules`);
}
