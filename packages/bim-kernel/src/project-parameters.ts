import type { ModelState, Sheet } from "./types";
import { organizationOf } from "./organization/model";

/**
 * Project parameters: the facts a project states once (its name, number,
 * address, client, engineer of record, issue date and status) and every sheet
 * prints. Each has a value type, so a date is a date and a status is one of a
 * list, not free text that drifts from sheet to sheet.
 *
 * Values are model records (`organization` entries of type
 * `project_parameter`, `organization/model.ts`), so they sync, conflict and
 * undo like any edit. A sheet's own field of the same key wins over the
 * project's; a blank sheet field takes the project's. The host may add a last
 * fallback (its project's name and number) through the drawing options.
 *
 * The standard list is trade-agnostic document data. A firm or project adds
 * its own with a definition stored beside the value (tolerant readers: an
 * unknown value type reads as text).
 */

export const PARAMETER_VALUE_TYPES = ["text", "date", "choice"] as const;
export type ParameterValueType = (typeof PARAMETER_VALUE_TYPES)[number];

export const PROJECT_PARAMETER_GROUPS = ["project", "people", "issue"] as const;
export type ProjectParameterGroup = (typeof PROJECT_PARAMETER_GROUPS)[number];

export interface ProjectParameterDef {
  /** As sheet fields name it (`date`, `status`, `owner`). Lower case, digits and underscores. */
  readonly key: string;
  readonly label: string;
  readonly valueType: ParameterValueType;
  /** `choice`: the values it may take, in the order a list shows them. */
  readonly choices?: readonly string[];
  readonly group: ProjectParameterGroup;
  /** What to type, said the way a person reads it. */
  readonly hint?: string;
}

/** What a set of drawings is issued for, in the order a project moves through them. */
export const ISSUE_STATUS_CHOICES: readonly string[] = [
  "Preliminary",
  "For review",
  "Issued for permit",
  "Issued for bid",
  "Issued for construction",
  "Record drawings",
];

export const STANDARD_PROJECT_PARAMETERS: readonly ProjectParameterDef[] = [
  { key: "project_name", label: "Project name", valueType: "text", group: "project" },
  { key: "project_number", label: "Project number", valueType: "text", group: "project" },
  { key: "address", label: "Project address", valueType: "text", group: "project", hint: "Street, city" },
  { key: "project_state", label: "Project state", valueType: "text", group: "project", hint: "Two letters (VA): prints the firm's registration number for it" },
  { key: "firm_name", label: "Firm", valueType: "text", group: "people", hint: "The firm the drawings are by" },
  { key: "client", label: "Client", valueType: "text", group: "people" },
  { key: "owner", label: "Owner", valueType: "text", group: "people", hint: "Name, city" },
  { key: "architect", label: "Architect", valueType: "text", group: "people", hint: "Name, city" },
  { key: "structural", label: "Structural engineer", valueType: "text", group: "people", hint: "Name, city" },
  { key: "civil", label: "Civil engineer", valueType: "text", group: "people", hint: "Name, city" },
  { key: "engineer_name", label: "Engineer of record", valueType: "text", group: "people" },
  { key: "engineer_license", label: "Licence number", valueType: "text", group: "people" },
  { key: "engineer_state", label: "Licence state", valueType: "text", group: "people" },
  { key: "drawn_by", label: "Drawn by", valueType: "text", group: "people" },
  { key: "checked_by", label: "Checked by", valueType: "text", group: "people" },
  { key: "date", label: "Issue date", valueType: "date", group: "issue", hint: "Prints as MM/DD/YYYY" },
  { key: "status", label: "Status", valueType: "choice", choices: ISSUE_STATUS_CHOICES, group: "issue" },
  { key: "issue_purpose", label: "Issue purpose", valueType: "text", group: "issue", hint: "Blank: the status" },
];

export const PROJECT_PARAMETER_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const PROJECT_PARAMETER_MAX_TEXT = 200;
/** Record id of one parameter's value (one record per key, so two people editing different facts never conflict). */
export const projectParameterId = (key: string) => `project-parameter:${key}`;

/** Peers that store project parameter records. They are written only when every peer advertises it. */
export const PROJECT_PARAMETERS_FEATURE = "organization:project_parameters";

const STANDARD_BY_KEY: ReadonlyMap<string, ProjectParameterDef> = new Map(STANDARD_PROJECT_PARAMETERS.map((d) => [d.key, d]));

export function standardProjectParameter(key: string): ProjectParameterDef | undefined {
  return STANDARD_BY_KEY.get(key);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as YYYY-MM-DD; null for anything else (2026-02-30 included). */
export function isoDateOf(raw: string): string | null {
  const m = ISO_DATE.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export type ParsedParameter = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

/** A value typed by a person, checked against its type: the stored form, or why it can't be stored. */
export function parseParameterValue(def: ProjectParameterDef, raw: string): ParsedParameter {
  const value = raw.trim();
  if (value.length > PROJECT_PARAMETER_MAX_TEXT) return { ok: false, reason: `${def.label} is at most ${PROJECT_PARAMETER_MAX_TEXT} characters` };
  switch (def.valueType) {
    case "date": {
      const iso = isoDateOf(value);
      return iso ? { ok: true, value: iso } : { ok: false, reason: `${def.label} must be a date (pick one, or type it as YYYY-MM-DD), not "${value}"` };
    }
    case "choice": {
      const choices = def.choices ?? [];
      const match = choices.find((c) => c.toLowerCase() === value.toLowerCase());
      return match ? { ok: true, value: match } : { ok: false, reason: `${def.label} is one of: ${choices.join(", ")}. "${value}" isn't on the list` };
    }
    default:
      return { ok: true, value };
  }
}

/** How a stored value prints: dates as MM/DD/YYYY; a value that doesn't read as its type prints as stored. */
export function formatParameterValue(def: Pick<ProjectParameterDef, "valueType"> | undefined, value: string): string {
  if (def?.valueType === "date") {
    const iso = isoDateOf(value);
    if (iso) return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The model's parameters
// ---------------------------------------------------------------------------

export interface ProjectParameters {
  /** The standard list, then the project's own, in order. */
  readonly defs: readonly ProjectParameterDef[];
  readonly byKey: ReadonlyMap<string, ProjectParameterDef>;
  /** Stored values by key (dates YYYY-MM-DD); a key with no value is absent. */
  readonly values: Readonly<Record<string, string>>;
}

const cache = new WeakMap<object, ProjectParameters>();

/** The model's project parameters: definitions and stored values. O(parameters), cached per model revision. */
export function projectParametersOf(model: Pick<ModelState, "elements" | "connections">): ProjectParameters {
  const hit = cache.get(model.elements);
  if (hit) return hit;
  const defs: ProjectParameterDef[] = [...STANDARD_PROJECT_PARAMETERS];
  const byKey = new Map<string, ProjectParameterDef>(STANDARD_BY_KEY);
  const values: Record<string, string> = {};
  for (const { entry } of organizationOf(model).projectParameters) {
    if (!byKey.has(entry.key) && entry.def) {
      const def: ProjectParameterDef = { key: entry.key, label: entry.def.label, valueType: (PARAMETER_VALUE_TYPES as readonly string[]).includes(entry.def.valueType) ? entry.def.valueType : "text", group: "project", ...(entry.def.choices ? { choices: entry.def.choices } : {}) };
      defs.push(def);
      byKey.set(entry.key, def);
    }
    if (entry.value) values[entry.key] = entry.value;
  }
  const out: ProjectParameters = { defs, byKey, values };
  cache.set(model.elements, out);
  return out;
}

/**
 * What a sheet's title block prints for each field: the sheet's own value,
 * else the project's, each formatted by its type (an ISO date prints
 * MM/DD/YYYY). Keys only the sheet has print as typed.
 */
export function sheetFieldValues(model: Pick<ModelState, "elements" | "connections">, sheet: Pick<Sheet, "props">): Readonly<Record<string, string>> {
  const params = projectParametersOf(model);
  const own = sheet.props?.fields ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.values)) out[key] = formatParameterValue(params.byKey.get(key), value);
  for (const [key, value] of Object.entries(own)) {
    if (!value.trim()) continue;
    out[key] = formatParameterValue(params.byKey.get(key), value.trim());
  }
  return out;
}

/** The sheet as its title block draws it: fields resolved through the project's parameters. The same object when nothing changes. */
export function withSheetFieldValues<S extends Sheet>(model: Pick<ModelState, "elements" | "connections">, sheet: S): S {
  const resolved = sheetFieldValues(model, sheet);
  const own = sheet.props?.fields ?? {};
  const keys = Object.keys(resolved);
  if (keys.length === Object.keys(own).length && keys.every((k) => own[k] === resolved[k])) return sheet;
  return { ...sheet, props: { ...(sheet.props ?? {}), fields: resolved } };
}
