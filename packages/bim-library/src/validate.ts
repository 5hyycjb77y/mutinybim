import { KIND_IDS, builtinRegistry, disciplineLabel, listDisciplines, type DisciplineDef, type Kind, type Registry, type UnitCatalog } from "@permitzip/bim-kernel";
import type { z } from "zod";
import { extendRegistry } from "./apply";
import type { FormulaEngine, FormulaFieldContext, FormulaTypeContext, FormulaValue } from "./formula";
import { contentHashOf, withContentHash } from "./hash";
import { libraryItemIssues as scriptOrPartIssues } from "./items/checks";
import type { ResolvedLibrary } from "./layering";
import type { LibraryProblem } from "./provider";
import {
  ITEM_SECTIONS,
  ITEM_TYPE_LABELS,
  LIBRARY_ITEM_TYPES,
  MUTINYBIM_LIBRARY_ENGINE_VERSION,
  libraryBundleSchema,
  makeItem,
  type CalculationItem,
  type ExampleValue,
  type LibraryBundle,
  type LibraryItem,
  type LibraryItemType,
  type OperandType,
} from "./schema";

/**
 * Validation on load and on publish (SCHEDULES-PLAN §3a): the schema, unique
 * ids and keys, content hashes, classes and fields as a registry layer, units
 * against their kinds, every calculation's expression and result type, cycles
 * between calculations, and every example run as a test. Any problem refuses
 * the whole bundle: a library never half-loads.
 */

export interface LibraryEnvironment {
  readonly formula: FormulaEngine;
  readonly units: UnitCatalog;
  /** What the bundle's classes and fields extend. Absent: the kernel's built-in registry. */
  readonly registry?: Registry;
  /** Lower layers already resolved, whose calculations this bundle may call. */
  readonly lower?: ResolvedLibrary;
  /** The schedule engine's check of a template's definition: plain-words problems, none when valid. */
  readonly checkScheduleTemplate?: (definition: Readonly<Record<string, unknown>>) => readonly string[];
  /** The tag engine's check of a tag type's definition. */
  readonly checkTagType?: (definition: Readonly<Record<string, unknown>>) => readonly string[];
  /**
   * Disciplines a class, template or discipline item may name besides this
   * bundle's and the layers' below: the built-in rows and first-party
   * add-ons' by default; a host that installs more add-ons passes theirs too.
   */
  readonly disciplines?: readonly DisciplineDef[];
}

export type LoadResult =
  | {
      readonly ok: true;
      /** Every item's `contentHash` set. */
      readonly bundle: LibraryBundle;
      readonly items: readonly LibraryItem[];
      /** The environment's registry extended with this bundle's classes, fields and relationships. */
      readonly registry: Registry;
    }
  | { readonly ok: false; readonly problems: readonly LibraryProblem[] };

/** Every item of a parsed bundle, with its type. */
export function bundleItems(bundle: LibraryBundle): LibraryItem[] {
  return [
    ...bundle.units.map((body) => makeItem("unit_profile", body)),
    ...bundle.classes.map((body) => makeItem("class", body)),
    ...bundle.relationships.map((body) => makeItem("relationship", body)),
    ...bundle.fields.map((body) => makeItem("field", body)),
    ...bundle.formulas.map((body) => makeItem("formula", body)),
    ...bundle.scheduleTemplates.map((body) => makeItem("schedule_template", body)),
    ...bundle.tagTypes.map((body) => makeItem("tag_type", body)),
    ...bundle.disciplines.map((body) => makeItem("discipline", body)),
    ...bundle.partTypes.map((body) => makeItem("part_type", body)),
    ...bundle.scripts.map((body) => makeItem("script", body)),
    ...bundle.designLimits.map((body) => makeItem("design_limit", body)),
    ...bundle.lookupTables.map((body) => makeItem("lookup_table", body)),
    ...bundle.elementTypes.map((body) => makeItem("element_type", body)),
    ...bundle.titleBlocks.map((body) => makeItem("title_block", body)),
    ...bundle.keynoteTables.map((body) => makeItem("keynote_table", body)),
  ];
}

/** A bundle's header with these items as its sections. */
export function bundleWithItems(header: LibraryBundle, items: readonly LibraryItem[]): LibraryBundle {
  return {
    ...header,
    units: items.flatMap((i) => (i.type === "unit_profile" ? [i.body] : [])),
    classes: items.flatMap((i) => (i.type === "class" ? [i.body] : [])),
    fields: items.flatMap((i) => (i.type === "field" ? [i.body] : [])),
    formulas: items.flatMap((i) => (i.type === "formula" ? [i.body] : [])),
    relationships: items.flatMap((i) => (i.type === "relationship" ? [i.body] : [])),
    scheduleTemplates: items.flatMap((i) => (i.type === "schedule_template" ? [i.body] : [])),
    tagTypes: items.flatMap((i) => (i.type === "tag_type" ? [i.body] : [])),
    disciplines: items.flatMap((i) => (i.type === "discipline" ? [i.body] : [])),
    partTypes: items.flatMap((i) => (i.type === "part_type" ? [i.body] : [])),
    scripts: items.flatMap((i) => (i.type === "script" ? [i.body] : [])),
    designLimits: items.flatMap((i) => (i.type === "design_limit" ? [i.body] : [])),
    lookupTables: items.flatMap((i) => (i.type === "lookup_table" ? [i.body] : [])),
    elementTypes: items.flatMap((i) => (i.type === "element_type" ? [i.body] : [])),
    titleBlocks: items.flatMap((i) => (i.type === "title_block" ? [i.body] : [])),
    keynoteTables: items.flatMap((i) => (i.type === "keynote_table" ? [i.body] : [])),
  };
}

export type ParseResult = { readonly ok: true; readonly bundle: LibraryBundle } | { readonly ok: false; readonly problems: readonly LibraryProblem[] };

/** JSON and schema only: what can be checked of one file before the layers below it are known. */
export function parseBundle(input: string | unknown): ParseResult {
  let raw: unknown = input;
  const text = typeof input === "string" ? input : undefined;
  if (text !== undefined) {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const at = /position (\d+)/.exec(message);
      const line = at?.[1] === undefined ? undefined : lineAtOffset(text, Number(at[1]));
      return { ok: false, problems: [{ message: `The library file is not valid JSON: ${message}`, ...(line === undefined ? {} : { line }) }] };
    }
  }
  const locate = (p: LibraryProblem): LibraryProblem => (text === undefined ? p : locateIn(text, p));

  const parsed = libraryBundleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((issue) => locate(schemaProblem(raw, issue))) };
  return { ok: true, bundle: parsed.data };
}

/** Validates a bundle given as JSON text (problems carry line numbers) or as a parsed value. */
export function loadBundle(input: string | unknown, env: LibraryEnvironment): LoadResult {
  const parsed = parseBundle(input);
  if (!parsed.ok) return parsed;
  const text = typeof input === "string" ? input : undefined;
  const problems = checkBundle(parsed.bundle, env);
  if (problems.length > 0) return { ok: false, problems: text === undefined ? problems : problems.map((p) => locateIn(text, p)) };

  const items = bundleItems(parsed.bundle).map(withContentHash);
  const reg = extendRegistry(env.registry ?? builtinRegistry(), items);
  if (!reg.ok) return { ok: false, problems: reg.problems };
  return { ok: true, bundle: bundleWithItems(parsed.bundle, items), items, registry: reg.registry };
}

/** The problem with the line of its item in `text`, when it names an item found there. */
export function locateIn(text: string, p: LibraryProblem): LibraryProblem {
  if (p.line !== undefined || p.itemId === undefined) return p;
  const line = lineOfItem(text, p.itemId);
  return line === undefined ? p : { ...p, line };
}

function describeItem(type: LibraryItemType, key: string | undefined, id: string | undefined): string {
  return `${ITEM_TYPE_LABELS[type]} ${key ?? id ?? "(unnamed)"}`;
}

function schemaProblem(raw: unknown, issue: z.core.$ZodIssue): LibraryProblem {
  const [section, index, ...rest] = issue.path;
  const type = LIBRARY_ITEM_TYPES.find((t) => ITEM_SECTIONS[t] === section);
  if (type === undefined || typeof index !== "number") {
    const where = issue.path.length === 0 ? "The library" : `The library's "${issue.path.join(".")}"`;
    return { message: `${where}: ${issue.message}.` };
  }
  const entry = readEntry(raw, String(section), index);
  const id = typeof entry?.id === "string" ? entry.id : undefined;
  const key = typeof entry?.key === "string" ? entry.key : undefined;
  const field = rest.length === 0 ? "" : ` "${rest.join(".")}"`;
  return {
    itemType: type,
    ...(id === undefined ? {} : { itemId: id }),
    ...(key === undefined ? {} : { itemKey: key }),
    message: `${describeItem(type, key, id)}${field}: ${issue.message}.`,
  };
}

function readEntry(raw: unknown, section: string, index: number): Readonly<Record<string, unknown>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const list: unknown = (raw as Readonly<Record<string, unknown>>)[section];
  if (!Array.isArray(list)) return undefined;
  const entry: unknown = list[index];
  return typeof entry === "object" && entry !== null ? (entry as Readonly<Record<string, unknown>>) : undefined;
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The line of the item's `"id": "<id>"` in the source text. */
export function lineOfItem(text: string, id: string): number | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"id"\\s*:\\s*"${escaped}"`).exec(text);
  return match ? lineAtOffset(text, match.index) : undefined;
}

function problemFor(item: LibraryItem, message: string): LibraryProblem {
  return { itemId: item.body.id, itemKey: item.body.key, itemType: item.type, message: `${describeItem(item.type, item.body.key, item.body.id)}: ${message}` };
}

/** Everything wrong with a schema-valid bundle; empty when it loads. */
export function checkBundle(bundle: LibraryBundle, env: LibraryEnvironment): LibraryProblem[] {
  const problems: LibraryProblem[] = [];
  const items = bundleItems(bundle);

  const required = bundle.requires?.mutinybim;
  if (required !== undefined) {
    const verdict = satisfies(MUTINYBIM_LIBRARY_ENGINE_VERSION, required);
    if (verdict === "unreadable") problems.push({ message: `The library requires MutinyBIM "${required}", which is not a version range this reader understands (use ">=x.y.z" or "x.y.z").` });
    else if (!verdict) problems.push({ message: `The library requires MutinyBIM ${required}; this is ${MUTINYBIM_LIBRARY_ENGINE_VERSION}.` });
  }

  const ids = new Map<string, LibraryItem>();
  const keys = new Map<string, LibraryItem>();
  for (const item of items) {
    const prior = ids.get(item.body.id);
    if (prior) problems.push(problemFor(item, `uses id ${item.body.id}, which ${describeItem(prior.type, prior.body.key, prior.body.id)} already has.`));
    else ids.set(item.body.id, item);
    const k = `${item.type}\u0000${item.body.key}`;
    const sameKey = keys.get(k);
    if (sameKey) problems.push(problemFor(item, `is defined twice in this library (ids ${sameKey.body.id} and ${item.body.id}).`));
    else keys.set(k, item);
    const stored = item.body.contentHash;
    if (stored !== undefined && stored !== contentHashOf(item)) problems.push(problemFor(item, "its contentHash doesn't match its content. Remove the hash or publish the item again."));
  }

  for (const item of items) problems.push(...checkUnits(item, env.units));
  problems.push(...checkDisciplines(items, env));

  const reg = extendRegistry(env.registry ?? builtinRegistry(), items);
  if (!reg.ok) problems.push(...reg.problems);

  for (const item of items) {
    if (item.type === "schedule_template" && env.checkScheduleTemplate) for (const m of env.checkScheduleTemplate(item.body.definition)) problems.push(problemFor(item, m));
    if (item.type === "tag_type" && env.checkTagType) for (const m of env.checkTagType(item.body.definition)) problems.push(problemFor(item, m));
    if (item.type === "tag_type" && reg.ok) for (const cls of item.body.appliesTo) if (!reg.registry.getClass(cls)) problems.push(problemFor(item, `applies to class ${cls}, which does not exist.`));
    if (item.type === "part_type" || item.type === "script") for (const m of scriptOrPartIssues(item)) problems.push(problemFor(item, m));
  }

  if (reg.ok) problems.push(...checkCalculations(items, reg.registry, env));
  return problems;
}

/** Where a discipline nobody here registers would come from, in words. */
function unknownDisciplineWords(id: string): string {
  const words = `"${disciplineLabel(id)}" (${id})`;
  if (id.startsWith("firm:")) return `names discipline ${words}, which isn't in this library or the ones below it. Add it under Disciplines first.`;
  const dot = id.indexOf(".");
  if (dot > 0) return `names discipline ${words}, which comes from the ${id.slice(0, dot)} add-on, and that add-on isn't installed here.`;
  return `names discipline ${words}, which isn't a built-in discipline. Use a firm discipline (firm:${id}) and add it under Disciplines.`;
}

/**
 * Disciplines a bundle names must be registered: built-in, a first-party (or
 * host-installed) add-on's, this bundle's or a lower layer's. A discipline
 * item's parent too, and never itself or a cycle through this bundle.
 */
function checkDisciplines(items: readonly LibraryItem[], env: LibraryEnvironment): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  const own = new Map<string, string | undefined>();
  for (const item of items) if (item.type === "discipline") own.set(item.body.key, item.body.parent);
  const known = new Set<string>([...(env.disciplines ?? listDisciplines()).map((d) => d.id), ...(env.lower?.ofType("discipline") ?? []).map((r) => r.item.body.key), ...own.keys()]);
  for (const item of items) {
    if (item.type === "class" && !known.has(item.body.discipline)) out.push(problemFor(item, unknownDisciplineWords(item.body.discipline)));
    if (item.type === "schedule_template" && item.body.discipline !== undefined && !known.has(item.body.discipline)) out.push(problemFor(item, unknownDisciplineWords(item.body.discipline)));
    if (item.type !== "discipline" || item.body.parent === undefined) continue;
    const parent = item.body.parent;
    if (!known.has(parent)) {
      out.push(problemFor(item, `sits under a parent that isn't registered: ${unknownDisciplineWords(parent).replace(/^names discipline /, "")}`));
      continue;
    }
    const seen = new Set([item.body.key]);
    for (let p: string | undefined = parent; p !== undefined && own.has(p); p = own.get(p)) {
      if (seen.has(p)) {
        out.push(problemFor(item, `sits under itself (${[...seen, p].join(" → ")}). Pick a parent outside that circle.`));
        break;
      }
      seen.add(p);
    }
  }
  return out;
}

function checkUnits(item: LibraryItem, units: UnitCatalog): LibraryProblem[] {
  const out: LibraryProblem[] = [];
  const check = (what: string, kind: Kind, unit: string) => {
    if (!units.unitAllowed(kind, unit)) out.push(problemFor(item, `${what} is a ${kind.replace(/_/g, " ")}, and "${unit}" is not a ${kind.replace(/_/g, " ")} unit.`));
  };
  const operand = (what: string, t: OperandType) => {
    if (t.valueType === "quantity") check(what, t.kind, t.unit);
  };
  switch (item.type) {
    case "unit_profile":
      for (const kind of KIND_IDS) {
        const entry = item.body.kinds[kind];
        if (entry) check(`Its ${kind.replace(/_/g, " ")} entry`, kind, entry.unit);
      }
      break;
    case "field": {
      const f = item.body;
      if (f.valueType === "quantity") {
        if (f.kind === undefined || f.unit === undefined) out.push(problemFor(item, "is a quantity, so it needs a kind and a unit."));
        else check("It", f.kind, f.unit);
      }
      if (f.valueType === "choice" && f.choices === undefined) out.push(problemFor(item, "is a choice with no choices."));
      break;
    }
    case "formula":
      operand("Its result", item.body.result);
      for (const p of item.body.params ?? []) operand(`Its input ${p.name}`, p.type);
      break;
    case "script":
      for (const [name, p] of Object.entries(item.body.manifest.parameters)) if (p.type === "quantity") check(`Its parameter ${name}`, p.kind, p.unit);
      break;
    default:
      break;
  }
  return out;
}

interface CalcEntry {
  readonly item: Extract<LibraryItem, { type: "formula" }>;
  readonly local: boolean;
}

function checkCalculations(items: readonly LibraryItem[], registry: Registry, env: LibraryEnvironment): LibraryProblem[] {
  const problems: LibraryProblem[] = [];
  const calcs = new Map<string, CalcEntry>();
  for (const r of env.lower?.ofType("formula") ?? []) calcs.set(r.item.body.key, { item: r.item, local: false });
  for (const item of items) if (item.type === "formula") calcs.set(item.body.key, { item, local: true });

  const graph = new Map<string, readonly string[]>();
  let typed = true;
  for (const { item, local } of calcs.values()) {
    const calc = item.body;
    const check = env.formula.check(calc.expression, typeContext(calc, registry, calcs), { expect: calc.result });
    if (!check.ok) {
      typed = false;
      if (local) for (const e of check.errors) problems.push(problemFor(item, `${e.message} (characters ${e.span.start + 1}–${e.span.end} of "${calc.expression}").`));
      continue;
    }
    graph.set(calc.key, check.references.calculations);
    if (!local) continue;
    for (const cls of calc.appliesTo) if (!registry.getClass(cls)) problems.push(problemFor(item, `applies to class ${cls}, which does not exist.`));
    for (const ref of check.references.calculations) {
      if (!calcs.has(ref)) problems.push(problemFor(item, `calls ${ref}, which is not in this library or the ones below it.`));
    }
    if (!sameType(check.resultType, calc.result)) problems.push(problemFor(item, `says it returns ${describeType(calc.result)}, but its expression gives ${describeType(check.resultType)}.`));
  }

  const cycles = findCycles(graph);
  for (const cycle of cycles) {
    const local = cycle.map((k) => calcs.get(k)).find((e) => e?.local);
    const message = `Calculations ${listWords(cycle)} use each other in a circle (${[...cycle, cycle[0]].join(" → ")}), so none of them can be worked out.`;
    if (local) problems.push({ itemId: local.item.body.id, itemKey: local.item.body.key, itemType: "formula", message });
  }
  if (!typed || cycles.length > 0 || problems.length > 0) return problems;

  for (const { item, local } of calcs.values()) {
    if (!local) continue;
    (item.body.examples ?? []).forEach((example, i) => {
      const label = `Example ${i + 1}`;
      let got: FormulaValue;
      try {
        got = evaluateCalculation(item.body, example.inputs, calcs, registry, env, 0);
      } catch (err) {
        problems.push(problemFor(item, `${label} could not be worked out: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      const mismatch = compareExample(got, example.expected, example.tolerance ?? 1e-9, env.units);
      if (mismatch) problems.push(problemFor(item, `${label} expected ${formatValue(example.expected)} but got ${formatValue(got)}${mismatch === "unit" ? " (a different kind of quantity)" : ""}.`));
    });
  }
  return problems;
}

/** How many relationships deep `sum(serves, sum(served_by, …))` may reach. */
const MAX_RELATIONSHIP_DEPTH = 2;

/** `{path}` and relationships on `classes`, as the registry describes them. */
function fieldContext(classes: readonly string[], registry: Registry, depth: number): FormulaFieldContext {
  return {
    field(path) {
      for (const cls of classes) {
        const described = registry.describePath(cls, path);
        if (!described.ok || described.many) continue;
        const f = described.field;
        if (f.valueType === "quantity" && f.kind !== undefined && f.unit !== undefined) return { valueType: "quantity", kind: f.kind, unit: f.unit };
        if (f.valueType === "boolean") return { valueType: "boolean" };
        if (f.valueType === "text" || f.valueType === "choice") return { valueType: "text" };
      }
      return undefined;
    },
    relationship(name) {
      if (depth >= MAX_RELATIONSHIP_DEPTH) return undefined;
      const rel = registry.relationship(name);
      // Only one a provider can walk, starting from a class the calculation applies to.
      if (!rel?.resolve || !classes.some((cls) => registry.relationshipsFor(cls).some((r) => r.id === name))) return undefined;
      const to = rel.to === "any" ? registry.listClasses({ includeAbstract: true }).map((c) => c.id) : rel.to;
      return { label: rel.label, ...fieldContext(to, registry, depth + 1) };
    },
  };
}

function typeContext(calc: CalculationItem, registry: Registry, calcs: ReadonlyMap<string, CalcEntry>): FormulaTypeContext {
  return {
    key: calc.key,
    params: calc.params ?? [],
    ...fieldContext(calc.appliesTo, registry, 0),
    calculation(key) {
      const entry = calcs.get(key);
      return entry ? { params: entry.item.body.params ?? [], result: entry.item.body.result, expression: entry.item.body.expression } : undefined;
    },
  };
}

const MAX_CALL_DEPTH = 32;

function evaluateCalculation(calc: CalculationItem, inputs: Readonly<Record<string, ExampleValue>>, calcs: ReadonlyMap<string, CalcEntry>, registry: Registry, env: LibraryEnvironment, depth: number): FormulaValue {
  if (depth > MAX_CALL_DEPTH) throw new Error(`calculations call each other more than ${MAX_CALL_DEPTH} deep`);
  return env.formula.evaluate(calc.expression, inputs, {
    ...typeContext(calc, registry, calcs),
    call(key, args) {
      const callee = calcs.get(key)?.item.body;
      if (!callee) throw new Error(`${key} is not in the library`);
      const params = callee.params ?? [];
      if (args.length !== params.length) throw new Error(`${key} takes ${params.length} input${params.length === 1 ? "" : "s"}, not ${args.length}`);
      const calleeInputs: Record<string, ExampleValue> = {};
      params.forEach((p, i) => {
        const arg = args[i];
        if (arg !== undefined) calleeInputs[p.name] = arg;
      });
      return evaluateCalculation(callee, calleeInputs, calcs, registry, env, depth + 1);
    },
  }, { expect: calc.result });
}

function sameType(a: OperandType, b: OperandType): boolean {
  if (a.valueType !== b.valueType) return false;
  return a.valueType !== "quantity" || (b.valueType === "quantity" && a.kind === b.kind);
}

function describeType(t: OperandType): string {
  return t.valueType === "quantity" ? `a ${t.kind.replace(/_/g, " ")} in ${t.unit}` : t.valueType === "boolean" ? "yes/no" : "text";
}

function compareExample(got: FormulaValue, expected: ExampleValue, tolerance: number, units: UnitCatalog): "value" | "unit" | null {
  const close = (a: number, b: number) => Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
  if (typeof expected === "object") {
    if (typeof got === "number") return close(got, expected.value) ? null : "value";
    if (typeof got !== "object") return "value";
    let converted: number;
    try {
      converted = got.unit === expected.unit ? got.value : units.convert(got.value, got.unit, expected.unit);
    } catch (err) {
      if (err instanceof Error) return "unit";
      throw err;
    }
    return close(converted, expected.value) ? null : "value";
  }
  if (typeof expected === "number") {
    const v = typeof got === "object" ? got.value : got;
    return typeof v === "number" && close(v, expected) ? null : "value";
  }
  return got === expected ? null : "value";
}

function formatValue(v: FormulaValue | ExampleValue): string {
  if (typeof v === "object") return `${v.value.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${v.unit}`;
  if (typeof v === "number") return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return typeof v === "string" ? `"${v}"` : v ? "yes" : "no";
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Every cycle of the call graph, each once, as the keys around it in order. */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let next = 0;
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      const selfLoop = component.length === 1 && (graph.get(v) ?? []).includes(v);
      if (component.length > 1 || selfLoop) out.push(component.reverse());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return out;
}

/** `>=x.y.z` or an exact `x.y.z`; "unreadable" for anything else. */
function satisfies(version: string, range: string): boolean | "unreadable" {
  const m = /^\s*(>=)?\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(range);
  if (!m) return "unreadable";
  const want = [Number(m[2]), Number(m[3]), Number(m[4])];
  const have = version.split(".").map(Number);
  const cmp = (have[0] ?? 0) - (want[0] ?? 0) || (have[1] ?? 0) - (want[1] ?? 0) || (have[2] ?? 0) - (want[2] ?? 0);
  return m[1] === ">=" ? cmp >= 0 : cmp === 0;
}
