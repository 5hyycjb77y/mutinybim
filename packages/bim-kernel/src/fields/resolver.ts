import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { BimElement, ElementId } from "../types";
import { isParamFieldPath, resolveParamField } from "./params";
import { PIPE_FIELD_PATHS, resolvePipingField } from "./piping";
import { fillTemplate, parseFieldTemplate } from "./template";

/**
 * Field paths: the one place that says what a value printed on a drawing
 * reads from the model (G7, relationship-aware text). Schedules, tags and
 * diagrams ask for a path here instead of each reading part values their own
 * way, so every printed copy of a value is the same live value and a
 * template never holds dummy text.
 *
 * The paths themselves come from `FIELD_RESOLVER_POINT`: the kernel answers
 * pipe paths (size, length, slope, inverts); each trade's pack answers its
 * own (a board's supply chain, fixture units, gas loads, stacks). The first
 * row in resolution order that answers a path wins; unknown paths, broken
 * chains and missing values resolve to a null value with empty text, so a
 * template drops them instead of printing a placeholder.
 */

type Elements = Readonly<Record<string, BimElement>>;

export type FieldScalar = string | number | boolean | null;

export interface ResolvedField {
  readonly path: string;
  /** A number for quantities (sorting, filtering); else the text; null when there is no value. */
  readonly value: FieldScalar;
  /** As it prints (upper-case is the caller's choice); "" when there is no value. */
  readonly text: string;
}

export interface FieldOptions {
  /** Code rules id for demand figures ("nec-2023"); absent: connected loads only. */
  readonly rules?: string | null;
  /** The "Supply from" template; absent: the pack's default. */
  readonly supplyFrom?: string;
}

export interface FieldPathInfo {
  readonly path: string;
  readonly label: string;
  /** What the path starts from. */
  readonly on: "device" | "panel" | "circuit" | "feeder" | "any" | "load_point" | "pipe";
  readonly example: string;
}

/**
 * One family of field paths (v1). `resolve` answers a path on an element, or
 * null so the next row tries it; `depth` is how many templates deep the read
 * is (a row that fills a template from fields passes `depth + 1` to
 * `formatFieldTemplateAt`). Lower `resolveRank` asks first; lower `listRank`
 * lists first.
 */
export interface FieldResolverDef {
  readonly id: string;
  readonly resolveRank: number;
  readonly listRank: number;
  /** The paths it lists for pickers, agent tools and checks. */
  readonly paths: readonly FieldPathInfo[];
  resolve(elements: Elements, elementId: string, path: string, opts: FieldOptions, depth: number): { readonly value: FieldScalar; readonly text: string } | null;
  /** Paths it answers beyond the listed ones (`param.<name>`, hops ending on a field). */
  resolvable?(path: string): boolean;
  /** Bare names (no dot) it computes rather than reads from a parameter. */
  readonly computedBare?: ReadonlySet<string>;
  /** Elements beyond the subject that a template on it reads (its supply), for invalidation. */
  reads?(elements: Elements, elementId: string): readonly ElementId[];
}

const PIPING: FieldResolverDef = {
  id: "piping",
  resolveRank: 20,
  listRank: 20,
  paths: PIPE_FIELD_PATHS,
  resolve: (elements, elementId, path) => resolvePipingField(elements, elementId, path),
};

/** `param.<name>` on a part, for every trade: after the pack rows that answer their own prefixes, before the hop rows. */
const PARAMS: FieldResolverDef = {
  id: "params",
  resolveRank: 45,
  listRank: 90,
  paths: [],
  resolve: (elements, elementId, path) => resolveParamField(elements, elementId, path),
  resolvable: isParamFieldPath,
};

/** Field resolvers (v1). The built-in rows answer pipe paths and `param.<name>`; each trade's are its pack's. */
export const FIELD_RESOLVER_POINT = defineExtensionPoint<FieldResolverDef>({ id: "kernel.field_resolver", version: 1, label: "Field resolvers", idOf: (r) => r.id, builtins: () => [PIPING, PARAMS] });

interface ResolverTable {
  readonly byResolve: readonly FieldResolverDef[];
  readonly paths: readonly FieldPathInfo[];
  readonly listed: ReadonlySet<string>;
}

function table(): ResolverTable {
  const set = activePackSet();
  return set.memo("kernel.field_resolver#table", () => {
    const rows = set.items(FIELD_RESOLVER_POINT).map((row, i) => ({ row, i }));
    const byResolve = [...rows].sort((a, b) => a.row.resolveRank - b.row.resolveRank || a.i - b.i).map((r) => r.row);
    const paths = [...rows].sort((a, b) => a.row.listRank - b.row.listRank || a.i - b.i).flatMap((r) => r.row.paths);
    return { byResolve, paths, listed: new Set(paths.map((p) => p.path)) };
  });
}

/** The field paths every client (schedules, tags, diagrams, pickers, agent tools) can ask for in the set in force. `param.<name>` reads any parameter. */
export function fieldPaths(): readonly FieldPathInfo[] {
  return table().paths;
}

/** For a row's template fills: one path at a template depth. */
export function resolveFieldAt(elements: Elements, elementId: string, path: string, opts: FieldOptions, depth: number): ResolvedField {
  for (const row of table().byResolve) {
    const r = row.resolve(elements, elementId, path, opts, depth);
    if (r) return { path, value: r.value, text: r.text };
  }
  return { path, value: null, text: "" };
}

/** One field path of an element (a part or a link). Throws nothing: an unknown path is a null value. */
export function resolveField(elements: Elements, elementId: string, path: string, opts: FieldOptions = {}): ResolvedField {
  return resolveFieldAt(elements, elementId, path, opts, 0);
}

/** `resolveField(...).text`. */
export function fieldText(elements: Elements, elementId: string, path: string, opts: FieldOptions = {}): string {
  return resolveFieldAt(elements, elementId, path, opts, 0).text;
}

/** Whether a tag or column field name is a relationship or computed field a resolver answers (not a plain parameter). */
export function isRelationshipField(name: string): boolean {
  if (name.includes(".")) return true;
  return table().byResolve.some((r) => r.computedBare?.has(name) === true);
}

/**
 * Whether a dotted path is one a resolver can answer: a listed path, or one
 * a row says it answers (`param.<name>`, hops ending on a field). Anything
 * else always resolves empty, so a schedule refuses it.
 */
export function isResolvableFieldPath(path: string): boolean {
  const t = table();
  if (t.listed.has(path)) return true;
  return t.byResolve.some((r) => r.resolvable?.(path) === true);
}

// ------------------------------------------------------------------ templates

export interface TemplateResult {
  readonly text: string;
  /** Paths in the template that had no value (dropped from the text). */
  readonly missing: readonly string[];
  /** Element ids the text read, for invalidation (the element and what its resolvers say it reads). */
  readonly reads: readonly ElementId[];
}

/** For a row's template fills: `formatFieldTemplate` at a template depth. */
export function formatFieldTemplateAt(elements: Elements, elementId: string, template: string, opts: FieldOptions, depth: number): TemplateResult {
  const el = elements[elementId];
  const reads: ElementId[] = el ? [el.id] : [];
  if (el) for (const row of table().byResolve) reads.push(...(row.reads?.(elements, elementId) ?? []));
  const parsed = parseFieldTemplate(template);
  // A template that doesn't parse prints as written, so a typo is visible on the sheet rather than silently blank.
  if (!parsed.ok) return { text: template, missing: [], reads };
  const filled = fillTemplate(parsed.parts, (p) => resolveFieldAt(elements, elementId, p, opts, depth).text);
  const text = filled.text.replace(/\s{1,64}/g, " ").replace(/\s{0,64},/g, ",").replace(/^[\s,]{1,64}|[\s,]{1,64}$/g, "");
  return { text, missing: filled.missing, reads };
}

/**
 * A text template filled from live fields: "{bus_rating}A BUS {mains_text}".
 * Grammar in `template.ts`: a field with no value drops out together with
 * the text glued to its right; `[ … ]` prints only when every field inside
 * has a value; `{path|fallback}` prints the fallback instead. Runs of spaces
 * collapse.
 */
export function formatFieldTemplate(elements: Elements, elementId: string, template: string, opts: FieldOptions = {}): TemplateResult {
  return formatFieldTemplateAt(elements, elementId, template, opts, 0);
}
