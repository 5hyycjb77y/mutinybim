import { PARAM_UNIT_BINDINGS, toSI, type Kind, type UnitCode } from "@permitzip/bim-units";
import { PARAM_NAME } from "../../part-dim";
import { paramUnitBinding, type ParamDef } from "../../parts";
import type { FieldDef, FieldValue, Registry, RelationshipDef } from "../../registry/types";
import { elementsOfKind } from "../../store";
import type { BimElement, ModelState, ParamValue } from "../../types";
import { isRelationshipField, isResolvableFieldPath } from "../../fields/resolver";
import { BASE_FIELDS as LEGACY_BASE_FIELDS, DUCT_FIELDS as LEGACY_DUCT_FIELDS, legacyScheduleRecord, PANEL_FIELDS, PIPE_FIELDS as LEGACY_PIPE_FIELDS, POWERED_FIELDS, SHEET_FIELDS as LEGACY_SHEET_FIELDS } from "../records";
import type { CellValue, ColumnWriter, ValueType } from "./types";

/**
 * How the row engine reads one field path off one element.
 *
 * A registry field (a trade provider's reader, a library shared field) wins.
 * Until a provider registers a path, the v1 vocabulary (mark, family, type,
 * level, part parameters, duct values and the live electrical fields of
 * `fields/resolver.ts`) reads through `legacyScheduleRecord`, typed with the
 * `PARAM_UNITS` → unit adapter, so every v1 schedule reads into v2 unchanged.
 * Quantities always leave here in canonical SI.
 */

export type Elements = ModelState["elements"];

export interface FieldType {
  readonly valueType: ValueType;
  readonly kind?: Kind;
  /** The unit the model stores (and the default display unit). */
  readonly unit?: UnitCode;
  readonly choices?: readonly string[];
  readonly label: string;
  readonly writer: ColumnWriter | null;
  readonly lockedReason?: string;
  readonly sourceRef?: string;
  /** How an edit gets back into the model (the field's `writer`); absent when locked. */
  readonly target?: FieldWriteTarget;
}

/** A field's writer, as the cell-edit planner needs it (`edit.ts`). */
export type FieldWriteTarget = { readonly kind: "parameter"; readonly scope: "instance" | "type"; readonly name: string } | { readonly kind: "command"; readonly command: string; readonly argument: string };

/** Reads a path off an element. `reads` collects every element id the value came from. */
export interface PathReader {
  readonly type: FieldType;
  /** Steps through relationships before the field (empty for an own field). */
  readonly steps: readonly RelationshipDef[];
  /** The value can reach many elements (needs an aggregate or expand column). */
  readonly many: boolean;
  /** Depends on model state no read set captures (v1 live electrical fields): every change re-reads it. */
  readonly coarse: boolean;
  read(el: BimElement, elements: Elements, reads: string[]): CellValue;
  /** The final field read straight off an element already reached through the steps. */
  readAt(el: BimElement, elements: Elements, reads: string[]): CellValue;
}

// ---------------------------------------------------------------- registry fields

function writerOf(field: FieldDef): Pick<FieldType, "writer" | "lockedReason" | "sourceRef" | "target"> {
  const w = field.writer;
  if (w.kind === "parameter") return { writer: { scope: w.scope }, target: { kind: "parameter", scope: w.scope, name: w.name } };
  if (w.kind === "command") return { writer: { scope: "instance" }, target: { kind: "command", command: w.command, argument: w.argument } };
  return { writer: null, lockedReason: w.reason, ...(w.sourceRef === undefined ? {} : { sourceRef: w.sourceRef }) };
}

function registryType(field: FieldDef): FieldType {
  const valueType: ValueType = field.valueType === "quantity" ? "quantity" : field.valueType === "boolean" ? "boolean" : field.valueType === "choice" ? "choice" : "text";
  return {
    valueType,
    ...(field.kind === undefined ? {} : { kind: field.kind as Kind }),
    ...(field.unit === undefined ? {} : { unit: field.unit as UnitCode }),
    ...(field.choices === undefined ? {} : { choices: field.choices }),
    label: field.label,
    ...writerOf(field),
  };
}

/** A registry field value as a cell: quantities to SI, element lists to their count of ids as text. */
function registryCell(v: FieldValue, type: FieldType): CellValue {
  if (v === null || v === undefined) return null;
  if (type.valueType === "quantity") {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return type.unit ? toSI(v, type.unit) : v;
  }
  if (type.valueType === "boolean") return typeof v === "boolean" ? v : null;
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function partTypeId(el: BimElement): string | null {
  return el.kind === "part" ? el.typeId : null;
}

/** Elements a relationship step reaches from each of `from`, deduplicated in order. */
export function resolveStep(step: RelationshipDef, from: readonly BimElement[], elements: Elements, reads: string[]): BimElement[] {
  const resolve = step.resolve;
  if (!resolve) return [];
  const out: BimElement[] = [];
  const seen = new Set<string>();
  for (const el of from) {
    for (const id of resolve(el, { elements })) {
      if (seen.has(id)) continue;
      seen.add(id);
      // Recorded even when it doesn't exist yet: the row must re-read when it appears.
      reads.push(id);
      const target = elements[id];
      if (!target) continue;
      const t = partTypeId(target);
      if (t) reads.push(t);
      out.push(target);
    }
  }
  return out;
}

function registryReader(registry: Registry, classId: string, path: string): PathReader | null {
  const d = registry.describePath(classId, path);
  if (!d.ok || !d.field.read) return null;
  const field = d.field;
  const read = field.read;
  if (!read) return null;
  const type: FieldType = d.steps.length === 0 ? registryType(field) : { ...withoutTarget(registryType(field)), writer: null, lockedReason: `Read through ${d.steps.map((s) => s.label.toLowerCase()).join(" › ")}`, sourceRef: path };
  return {
    type,
    steps: d.steps,
    many: d.many,
    coarse: false,
    read(el, elements, reads) {
      reads.push(el.id);
      const t = partTypeId(el);
      if (t) reads.push(t);
      let at: BimElement[] = [el];
      for (const step of d.steps) at = resolveStep(step, at, elements, reads);
      const first = at[0];
      return first === undefined ? null : registryCell(read(first, { elements }), type);
    },
    readAt(el, elements, reads) {
      reads.push(el.id);
      const t = partTypeId(el);
      if (t) reads.push(t);
      return registryCell(read(el, { elements }), type);
    },
  };
}

// ---------------------------------------------------------------- v1 vocabulary

const LOCKED_MODEL = "Comes from the model; change it there";
const LOCKED_LIVE = "Read live from its connections; change the circuit or feeder";

const LEGACY_QUANTITIES: Readonly<Record<string, { readonly kind: Kind; readonly unit: UnitCode; readonly label: string }>> = {
  cfm: { kind: "flow_air", unit: "cfm", label: "CFM" },
  length: { kind: "length", unit: "mm", label: "LENGTH" },
  velocity_fpm: { kind: "velocity", unit: "ft/min", label: "VELOCITY (FPM)" },
  friction_in_per_100ft: { kind: "pressure_gradient", unit: "in_wc/100ft", label: "FRICTION (IN/100 FT)" },
  count: { kind: "count", unit: "ea", label: "COUNT" },
};

/** Every parameter definition by name across the model's part types (an indexed read, reused across revisions). */
function paramDefs(elements: Elements): ReadonlyMap<string, { def: ParamDef; scope: "instance" | "type"; conflicting: boolean }> {
  const out = new Map<string, { def: ParamDef; scope: "instance" | "type"; conflicting: boolean }>();
  for (const t of elementsOfKind(elements, "part_type")) {
    const note = (def: ParamDef, scope: "instance" | "type") => {
      const seen = out.get(def.name);
      if (!seen) out.set(def.name, { def, scope, conflicting: false });
      else if (seen.def.kind !== def.kind || seen.def.unit !== def.unit || seen.scope !== scope) out.set(def.name, { ...seen, conflicting: true });
    };
    for (const p of t.definition.typeParams) note(p, "type");
    for (const p of t.definition.instanceParams) note(p, "instance");
  }
  return out;
}

function paramType(def: ParamDef, scope: "instance" | "type"): FieldType {
  if (def.formula) return paramTypeOf(def, scope);
  return { ...paramTypeOf(def, scope), target: { kind: "parameter", scope, name: def.name } };
}

function paramTypeOf(def: ParamDef, scope: "instance" | "type"): FieldType {
  const label = (def.label || def.name).toUpperCase();
  const writer: ColumnWriter = { scope };
  if (def.formula) return { valueType: def.kind === "text" || def.kind === "choice" ? "text" : def.kind === "boolean" ? "boolean" : "text", label, writer: null, lockedReason: `Calculated by the part: ${def.formula}` };
  if (def.kind === "length") return { valueType: "quantity", kind: "length", unit: "mm", label, writer };
  if (def.kind === "angle") return { valueType: "quantity", kind: "angle", unit: "deg", label, writer };
  if (def.kind === "number") {
    const binding = paramUnitBinding(def.unit) ?? PARAM_UNIT_BINDINGS.none;
    return { valueType: "quantity", kind: binding.kind, unit: binding.unit, label, writer };
  }
  if (def.kind === "boolean") return { valueType: "boolean", label, writer };
  if (def.kind === "choice" && def.choices) return { valueType: "choice", choices: def.choices, label, writer };
  return { valueType: "text", label, writer };
}

function rawParam(el: BimElement, elements: Elements, name: string): ParamValue | undefined {
  if (el.kind !== "part") return undefined;
  const type = elements[el.typeId];
  if (type?.kind !== "part_type") return undefined;
  const def = type.definition;
  const inst = def.instanceParams.find((p) => p.name === name);
  if (inst) return el.values[name] ?? inst.default;
  const typed = def.typeParams.find((p) => p.name === name);
  if (typed) return def.typeValues[name] ?? typed.default;
  return undefined;
}

/**
 * The last v1 record built: a row reads several v1 columns of one element in
 * a row, and building the record (type, level, every parameter) is most of a
 * v1 cell's cost. Keyed by the element, the element record and the live
 * fields it was built with, so a new revision or element never reads a stale one.
 */
let lastRecord: { el: BimElement; elements: Elements; live: string; rec: ReturnType<typeof legacyScheduleRecord> } | null = null;

function recordOf(el: BimElement, elements: Elements, live: readonly string[]): ReturnType<typeof legacyScheduleRecord> {
  const key = live.length === 0 ? "" : live.join("\u0000");
  if (lastRecord && lastRecord.el === el && lastRecord.elements === elements && lastRecord.live === key) return lastRecord.rec;
  const rec = legacyScheduleRecord({ elements }, el, live);
  lastRecord = { el, elements, live: key, rec };
  return rec;
}

function legacyRecordCell(el: BimElement, elements: Elements, path: string, live: readonly string[], reads: string[], type: FieldType): CellValue {
  const rec = recordOf(el, elements, live);
  if (!rec) {
    reads.push(el.id);
    return null;
  }
  for (const id of rec.reads) reads.push(id);
  if (type.valueType === "quantity") {
    if (path === "count") return 1;
    const n = rec.numbers[path];
    return n === undefined || !type.unit ? null : toSI(n, type.unit);
  }
  const text = rec.values[path];
  return text === undefined || text === "" ? null : text;
}

/** True when a v1 column names a built-in field (mark, level, cfm, a duct or sheet value, a live electrical path), not a part parameter. */
export function isV1BuiltinField(path: string): boolean {
  return path in LEGACY_BASE_FIELDS || path in LEGACY_SHEET_FIELDS || path in LEGACY_DUCT_FIELDS || path in LEGACY_PIPE_FIELDS || path in LEGACY_QUANTITIES || isRelationshipField(path);
}

/** The v1 reader for a path, or null when the v1 vocabulary doesn't know it. */
export function legacyReader(path: string, elements: Elements): PathReader | null {
  const base = LEGACY_BASE_FIELDS[path] ?? LEGACY_SHEET_FIELDS[path] ?? LEGACY_DUCT_FIELDS[path] ?? LEGACY_PIPE_FIELDS[path];
  const quantity = LEGACY_QUANTITIES[path];
  if (quantity || base !== undefined) {
    const type: FieldType = quantity
      ? { valueType: "quantity", kind: quantity.kind, unit: quantity.unit, label: base ?? quantity.label, writer: null, lockedReason: LOCKED_MODEL }
      : { valueType: "text", label: base ?? path.toUpperCase(), ...(path === "mark" ? { writer: { scope: "instance" as const }, target: { kind: "command" as const, command: "set_parameters", argument: "mark" } } : { writer: null, lockedReason: LOCKED_MODEL }) };
    const read = (el: BimElement, els: Elements, reads: string[]) => legacyRecordCell(el, els, path, [], reads, type);
    return { type, steps: [], many: false, coarse: false, read, readAt: read };
  }
  if (isRelationshipField(path)) {
    if (path.includes(".") && !isResolvableFieldPath(path)) return null;
    const paramLabel = path.includes(".") ? undefined : paramDefs(elements).get(path)?.def.label;
    const type: FieldType = { valueType: "text", label: POWERED_FIELDS[path] ?? PANEL_FIELDS[path] ?? (paramLabel ? paramLabel.toUpperCase() : path.replace(/[._]/g, " ").toUpperCase()), writer: null, lockedReason: LOCKED_LIVE, sourceRef: path };
    const read = (el: BimElement, els: Elements, reads: string[]) => legacyRecordCell(el, els, path, [path], reads, type);
    return { type, steps: [], many: false, coarse: true, read, readAt: read };
  }
  const param = paramDefs(elements).get(path);
  if (!param) return null;
  const type: FieldType = param.conflicting ? { valueType: "text", label: (param.def.label || path).toUpperCase(), writer: null, lockedReason: "Part types disagree on this parameter's unit" } : paramType(param.def, param.scope);
  const read = (el: BimElement, els: Elements, reads: string[]): CellValue => {
    reads.push(el.id);
    if (el.kind === "part") reads.push(el.typeId);
    const v = rawParam(el, els, path);
    if (v === undefined) return null;
    if (type.valueType === "quantity") return typeof v === "number" && type.unit ? toSI(v, type.unit) : null;
    if (type.valueType === "boolean") return typeof v === "boolean" ? v : null;
    return typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
  };
  return { type, steps: [], many: false, coarse: false, read, readAt: read };
}

// ---------------------------------------------------------------- one reader per (class, path)

/** Readers for paths, compiled once per registry, class and path. */
export class FieldReaders {
  private readonly cache = new Map<string, PathReader | null>();
  private registryPaths: ReadonlySet<string> | undefined;
  constructor(
    private readonly registry: Registry,
    private readonly elements: () => Elements,
  ) {}

  /**
   * True when the registry owns a dotted path somewhere (a field of some
   * class, or a walk through a resolvable relationship): then a class without
   * it reads empty, never a v1 live value that happens to share the name.
   */
  private registryOwns(path: string): boolean {
    this.registryPaths ??= new Set(this.registry.listClasses({ includeAbstract: true }).flatMap((c) => this.registry.fieldsFor(c.id).map((f) => f.path)));
    if (!path.includes(".")) return false;
    if (this.registryPaths.has(path)) return true;
    const head = path.split(".")[0];
    return head !== undefined && this.registry.relationship(head)?.resolve !== undefined;
  }

  /** The reader for `path` on elements of `classId` (registry first, then v1, then a parameter name the class's fields store). */
  get(classId: string | null, path: string): PathReader | null {
    const key = `${classId ?? ""}\u0000${path}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const own = classId ? registryReader(this.registry, classId, path) : null;
    const reader = own ?? (this.registryOwns(path) ? null : legacyReader(path, this.elements())) ?? (classId ? this.parameterField(classId, path) : null);
    this.cache.set(key, reader);
    return reader;
  }

  /**
   * A bare part-parameter name that one of the class's fields writes
   * (`mca` → `own.mca` on equipment). v1 schedules name nameplate values by
   * their parameter, and a model with no part declaring it yet must still
   * open: the column reads blank until a part has a value. The heading stays
   * the v1 one (the name, upper case).
   */
  private parameterField(classId: string, path: string): PathReader | null {
    if (path.includes(".")) return null;
    const field = this.registry.fieldsFor(classId).find((f) => f.writer.kind === "parameter" && f.writer.name === path && f.read !== undefined);
    if (!field) return null;
    const reader = registryReader(this.registry, classId, field.path);
    return reader ? { ...reader, type: { ...reader.type, label: path.replace(/_/g, " ").toUpperCase() } } : null;
  }

  /**
   * A parameter column's reader: the field it names, or, when no part type
   * declares a parameter by that name yet, one that reads it off whatever
   * part has it (blank until one does). Null for a name that can't be a parameter.
   */
  parameter(classes: readonly string[], path: string): PathReader | null {
    const known = this.first(classes, path);
    if (known || !PARAM_NAME.test(path)) return known;
    const type: FieldType = { valueType: "text", label: path.replace(/_/g, " ").toUpperCase(), writer: null, lockedReason: `No part type has a parameter called ${path} yet; add it to the part type to fill this column.` };
    const read = (el: BimElement, els: Elements, reads: string[]): CellValue => {
      reads.push(el.id);
      if (el.kind === "part") reads.push(el.typeId);
      const v = rawParam(el, els, path);
      return v === undefined || v === "" ? null : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
    };
    return { type, steps: [], many: false, coarse: false, read, readAt: read };
  }

  /** Up to three field paths on `classes` that look like `path`, closest first (for "did you mean"). */
  suggest(classes: readonly string[], path: string): string[] {
    const candidates = new Set<string>();
    for (const c of classes) for (const f of this.registry.fieldsFor(c)) if (f.read !== undefined) candidates.add(f.path);
    for (const k of Object.keys({ ...LEGACY_BASE_FIELDS, ...LEGACY_QUANTITIES })) candidates.add(k);
    const wanted = path.toLowerCase();
    const tail = wanted.split(".").pop() ?? wanted;
    const scored: { path: string; score: number }[] = [];
    for (const c of candidates) {
      if (c === path) continue;
      const lower = c.toLowerCase();
      const cTail = lower.split(".").pop() ?? lower;
      // A match on the last segment alone ranks just behind a whole-path match.
      const d = Math.min(editDistance(wanted, lower), editDistance(tail, cTail) + (lower === cTail ? 0 : 0.5));
      const limit = Math.max(1, Math.floor(tail.length / 3)) + 0.5;
      const prefix = Math.min(tail.length, cTail.length) >= 3 && (cTail.startsWith(tail) || tail.startsWith(cTail));
      if (d <= limit || prefix) scored.push({ path: c, score: d });
    }
    return scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).slice(0, 3).map((s) => s.path);
  }

  /** The first class in `classes` that has a reader for the path. */
  first(classes: readonly string[], path: string): PathReader | null {
    for (const c of classes) {
      const r = this.get(c, path);
      if (r) return r;
    }
    return classes.length === 0 ? this.get(null, path) : null;
  }
}

/** Levenshtein distance with adjacent swaps (a typo counts once). */
function editDistance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const row = rows[i] as number[];
    const prev = rows[i - 1] as number[];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      row[j] = v;
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

function withoutTarget(t: FieldType): FieldType {
  return { valueType: t.valueType, label: t.label, writer: t.writer, ...(t.kind === undefined ? {} : { kind: t.kind }), ...(t.unit === undefined ? {} : { unit: t.unit }), ...(t.choices === undefined ? {} : { choices: t.choices }) };
}
