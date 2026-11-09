import { fromSI } from "@permitzip/bim-units";
import { parseCommand } from "../../command-core";
import type { Command } from "../../commands";
import { elementsOfKind } from "../../store";
import type { BimElement } from "../../types";
import type { Elements, FieldType, FieldWriteTarget } from "./fields";
import type { CellValue, ColumnId, RowKey } from "./types";

/**
 * Schedule cell edits → model commands (SCHEDULES-PLAN §6 "Edits").
 *
 * A cell goes back through its field's `writer`: a part parameter becomes
 * `set_parameters` (instance or type scope), a command writer becomes that
 * command with the value at its argument path. The plan names how many parts
 * a type-scope edit changes so the grid can ask first ("Changes all 14 parts
 * of type WH-1", D2). Nothing here commits: the host previews, commits and
 * fans out the commands like any other edit.
 */

export interface ScheduleCellEdit {
  readonly rowKey: RowKey;
  readonly columnId: ColumnId;
  /** Quantities in canonical SI (what the grid holds); null clears the value. */
  readonly value: CellValue;
}

export type CellEditPlan =
  | {
      readonly ok: true;
      /** In order; one per element (or one per type for a type-scope edit). Commit as one undo step. */
      readonly commands: readonly Command[];
      readonly scope: "instance" | "type";
      /** Every element the edit changes (all parts of the type for a type-scope edit). */
      readonly affectedElementIds: readonly string[];
      /** The question to ask before committing, null when the edit only touches the row's own elements. */
      readonly confirm: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/** Which argument names the element a command edits. */
const TARGET_ARGUMENT: Readonly<Record<string, (el: BimElement) => string>> = {
  set_parameters: () => "id",
  // `loadId` takes every load id, `lp:` ones included (`loadPointId` is its old name, still accepted by the command).
  edit_load_point: (el) => (el.kind === "load_point" ? "loadId" : "partId"),
  edit_service_link: () => "linkId",
  resize_run: () => "segmentId",
  update_level: () => "levelId",
  set_terminal_cfm: () => "terminalId",
};

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };

function isJsonObject(v: Json): v is { readonly [k: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nest(path: string, value: Json): { readonly [k: string]: Json } {
  const parts = path.split(".");
  let out: Json = value;
  for (let i = parts.length - 1; i >= 0; i--) out = { [parts[i] as string]: out };
  return isJsonObject(out) ? out : {};
}

/** The cell value in the unit the model stores, or a plain reason it doesn't fit the column. */
function modelValue(type: FieldType, value: CellValue): { ok: true; value: Json } | { ok: false; reason: string } {
  if (value === null || value === "") return { ok: true, value: null };
  if (type.valueType === "quantity") {
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: `"${type.label}" takes a number${type.unit ? ` (${type.unit})` : ""}.` };
    return { ok: true, value: type.unit ? fromSI(value, type.unit) : value };
  }
  if (type.valueType === "boolean") {
    if (typeof value !== "boolean") return { ok: false, reason: `"${type.label}" is yes or no.` };
    return { ok: true, value };
  }
  const text = String(value);
  if (type.valueType === "choice" && type.choices && !type.choices.includes(text)) return { ok: false, reason: `"${type.label}" is one of ${type.choices.join(", ")}.` };
  return { ok: true, value: text };
}

function typeName(elements: Elements, typeId: string): string {
  const t = elements[typeId];
  return t?.kind === "part_type" ? t.definition.typeName || t.definition.familyName : typeId;
}

function commandFor(target: FieldWriteTarget, el: BimElement, value: Json, scope: "instance" | "type"): { ok: true; command: Command } | { ok: false; reason: string } {
  let raw: { readonly [k: string]: Json };
  if (target.kind === "parameter") {
    raw = { type: "set_parameters", id: el.id, scope, values: { [target.name]: value } };
  } else if (target.command === "set_element_values") {
    // A pack parameter: its key has dots, so it is the values key itself, not a nested path.
    raw = { type: "set_element_values", elementIds: [el.id], values: { [target.argument]: value } };
  } else {
    const key = TARGET_ARGUMENT[target.command];
    if (!key) return { ok: false, reason: `This column is changed with "${target.command}", which a schedule can't send yet. Change it from the element.` };
    // set_parameters always names whose value it changes: the part's own (instance) or every part of its type.
    raw = { type: target.command, [key(el)]: el.id, ...(target.command === "set_parameters" ? { scope } : {}), ...nest(target.argument, value) };
  }
  const parsed = parseCommand(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `That value can't be used here${issue ? `: ${issue.message}` : ""}.` };
  }
  return { ok: true, command: parsed.data };
}

/**
 * Plan one cell edit on the elements behind a row (several for a combined
 * row). `type` is the column's field as read on that row's class.
 */
export function planFieldEdit(elements: Elements, rowElements: readonly BimElement[], type: FieldType | null, value: CellValue): CellEditPlan {
  if (!type) return { ok: false, reason: "This column isn't a field of this row, so there is nothing to change." };
  const target = type.target;
  if (!type.writer || !target) return { ok: false, reason: type.lockedReason ?? `"${type.label}" is calculated, so it can't be typed in.` };
  const v = modelValue(type, value);
  if (!v.ok) return v;
  const scope = target.kind === "parameter" ? target.scope : "instance";

  if (scope === "type") {
    const typeIds = [...new Set(rowElements.flatMap((el) => (el.kind === "part" ? [el.typeId] : [])))];
    if (typeIds.length === 0) return { ok: false, reason: `"${type.label}" belongs to a part type, and this row has no part.` };
    const commands: Command[] = [];
    for (const typeId of typeIds) {
      const representative = rowElements.find((el) => el.kind === "part" && el.typeId === typeId);
      if (!representative) continue;
      const c = commandFor(target, representative, v.value, "type");
      if (!c.ok) return c;
      commands.push(c.command);
    }
    const wanted = new Set(typeIds);
    const affected = elementsOfKind(elements, "part").filter((p) => wanted.has(p.typeId)).map((p) => p.id);
    const names = typeIds.map((t) => typeName(elements, t)).join(", ");
    const confirm = affected.length > 1 || typeIds.length > 1 ? `Changes all ${affected.length} parts of type ${names}` : null;
    return { ok: true, commands, scope, affectedElementIds: affected, confirm };
  }

  const commands: Command[] = [];
  for (const el of rowElements) {
    const c = commandFor(target, el, v.value, "instance");
    if (!c.ok) return c;
    commands.push(c.command);
  }
  return { ok: true, commands, scope, affectedElementIds: rowElements.map((el) => el.id), confirm: rowElements.length > 1 ? `Changes all ${rowElements.length} items on this row` : null };
}
