import {
  BUILTIN_PROFILES,
  formatter,
  KINDS,
  PROFILE_US_FEET_INCHES,
  toSI,
  unitAllowed,
  type AggregationRule,
  type DisplayProfile,
  type Kind,
  type Measure,
  type Quantity,
  type UnitCode,
} from "@permitzip/bim-units";
import {
  formulaEngine,
  inputsFromRows,
  type CellValue as FormulaCellValue,
  type CompiledFormula,
  type FormulaSchema,
  type FormulaType,
  type FormulaValue,
  type NamedCalculationSignature,
  type RowValues,
  type ValueColumn,
} from "@permitzip/bim-formula";
import { builtinRegistry } from "../../registry/builtin";
import { buildClassIndex, recognizes } from "../../registry/recognition";
import type { ObjectClass, Registry, RelationshipDef } from "../../registry/types";
import { elementOrder, elementsOfKind } from "../../store";
import { connectorEndsTable } from "../../kinds/ends";
import type { BimElement, ElementKind, ModelState } from "../../types";
import type { ScheduleColumnDef, ScheduleDefinitionV2, ScheduleFilter, SchedulePin } from "../definition";
import { planFieldEdit, type CellEditPlan, type ScheduleCellEdit } from "./edit";
import { V1_SCHEDULE_PROFILE_ID } from "./v1";
import { FieldReaders, resolveStep, type Elements, type FieldType, type PathReader } from "./fields";
import type { CellValue, ColumnId, ColumnValues, RowGroup, RowHighlight, RowKey, RowPatch, RowSet, RowSetColumn, RowUpsert, ScheduleChange, ScheduleProblem } from "./types";

/**
 * The v2 row engine (SCHEDULES-PLAN §6).
 *
 * `openSchedule` builds every row once (columnar formula evaluation, one
 * class-index pass) and keeps, per row, the element ids its values were read
 * from. `apply` re-reads only rows whose read set a change touched, plus rows
 * whose element now does or doesn't belong. It reads by id and never scans
 * the model: membership is re-tested only for the changed elements, the
 * order is patched by binary insertion, and totals re-add the kept columns.
 *
 * Dependencies no read set can see (a relationship that walks the network,
 * the v1 live electrical fields) follow their declared `DependencySignature`:
 * a change of that kind re-reads every row of the schedule. That is correct,
 * and bounded by the schedule's rows, never the model.
 */

/** What the engine reads: elements (connections are optional; network relationships read them through their providers). */
export type ScheduleModel = Pick<ModelState, "elements"> & { readonly connections?: ModelState["connections"] };

export interface ScheduleEngineContext {
  readonly viewId: string;
  readonly revision: number;
  /** Classes, fields and relationships. Absent: the kernel's built-in registry. */
  readonly registry?: Registry;
}

export class ScheduleDefinitionError extends Error {
  readonly problems: readonly ScheduleProblem[];
  constructor(problems: readonly ScheduleProblem[]) {
    super(problems.map((p) => p.message).join("\n"));
    this.name = "ScheduleDefinitionError";
    this.problems = problems;
  }
}

/** Relationships whose loads are already counted at the other end: a total over them would count twice. */
const COUNTED_AT_TARGET: Readonly<Record<string, string>> = {
  serves: "Served loads are already counted on the fixtures",
};

/** Element kinds that carry the network a `connections` dependency walks. */
const NETWORK_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(["run_segment", "run_fitting", "riser_segment", "service_link", "mep_system", "load_point"]);

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

type StorageType = "quantity" | "text" | "boolean";

interface Highlighter {
  readonly formula: CompiledFormula;
  readonly tone: RowHighlight["tone"];
  readonly reason: string;
}

interface ColumnPlan {
  readonly def: ScheduleColumnDef;
  readonly out: RowSetColumn;
  readonly storage: StorageType;
  readonly kind?: Kind;
  /** field / parameter columns. */
  readonly path?: string;
  /** formula / aggregate columns. */
  readonly formula?: CompiledFormula;
  /** expand columns. */
  readonly expand?: { readonly relationship: RelationshipDef; readonly paths: readonly string[]; readonly columns: readonly RowSetColumn[] };
  readonly highlights: readonly Highlighter[];
  /** How the column totals; null: it doesn't. */
  readonly totalRule: AggregationRule | null;
}

interface Row {
  readonly key: RowKey;
  readonly el: BimElement;
  readonly elementId: string;
  readonly elementIds: readonly string[];
  readonly classId: string | null;
  readonly cells: CellValue[];
  readonly reads: readonly string[];
  readonly children: Map<ColumnId, RowSet>;
  readonly highlights: Map<ColumnId, RowHighlight>;
  readonly sortKeys: readonly (number | string | null)[];
  readonly groupKeys: readonly string[];
  readonly slot: number;
}

/** One printed row: an element row, or several combined (itemize off). */
interface OutRow {
  readonly key: RowKey;
  readonly elementId: string;
  readonly elementIds: readonly string[];
  readonly cells: readonly CellValue[];
  readonly children: ReadonlyMap<ColumnId, RowSet>;
  readonly highlights: ReadonlyMap<ColumnId, RowHighlight>;
  readonly groupKeys: readonly string[];
}

export interface ScheduleSession {
  readonly definition: ScheduleDefinitionV2;
  rows(): RowSet;
  /** `count` rows from `offset` at the current revision (a scroll fetch); cost is the window, not the schedule. Groups and totals stay whole. */
  window(offset: number, count: number): RowSet;
  apply(change: ScheduleChange): RowPatch;
  /** The substituted expression behind a formula or aggregate cell ("199 MBH × 1000 = 199,000 Btu/h"), null when it has none. */
  explain(rowKey: RowKey, columnId: ColumnId): string | null;
  /** The model commands a cell edit becomes (through the field's writer), and what to ask first for a type-scope edit. Commits nothing. */
  planEdit(edit: ScheduleCellEdit): CellEditPlan;
}

// ---------------------------------------------------------------- plan

function formulaTypeOf(t: FieldType): FormulaType | undefined {
  if (t.valueType === "quantity") return t.kind && t.unit ? { type: "quantity", kind: t.kind, unit: t.unit } : undefined;
  if (t.valueType === "boolean") return { type: "boolean" };
  return { type: "text" };
}

function storageOf(t: FieldType): StorageType {
  return t.valueType === "quantity" ? "quantity" : t.valueType === "boolean" ? "boolean" : "text";
}

function aggregateExpression(fn: string, relationship: string, path: string | undefined): string {
  if (fn === "count") return path ? `count(${relationship}, {${path}})` : `count(${relationship})`;
  return `${fn}(${relationship}, {${path ?? "mark"}})`;
}

// ---------------------------------------------------------------- pins

function prop(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null && key in o ? (o as Record<string, unknown>)[key] : undefined;
}

function isKind(k: unknown): k is Kind {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(KINDS, k);
}

function operandType(v: unknown): FormulaType | null {
  const valueType = prop(v, "valueType");
  if (valueType === "text") return { type: "text" };
  if (valueType === "boolean") return { type: "boolean" };
  if (valueType !== "quantity") return null;
  const kind = prop(v, "kind");
  const unit = prop(v, "unit");
  if (!isKind(kind) || !isUnitOf(kind, unit)) return null;
  return { type: "quantity", kind, unit };
}

function isUnitOf(kind: Kind, unit: unknown): unit is UnitCode {
  return typeof unit === "string" && unitAllowed(kind, unit);
}

/**
 * The named calculations a schedule may call: only what the model pinned, so
 * a firm edit to the library never changes an issued print (§3a). The pinned
 * body is the library item (`{name}` reads a parameter); the formula engine
 * reads parameters as bare names.
 */
function pinnedCalculations(pins: readonly SchedulePin[] | undefined): { readonly calculations: ReadonlyMap<string, NamedCalculationSignature>; readonly problems: readonly ScheduleProblem[] } {
  const calculations = new Map<string, NamedCalculationSignature>();
  const revisions = new Map<string, number>();
  const problems: ScheduleProblem[] = [];
  for (const pin of pins ?? []) {
    if (pin.type !== undefined && pin.type !== "formula") continue;
    const key = prop(pin.body, "key");
    const expression = prop(pin.body, "expression");
    const result = operandType(prop(pin.body, "result"));
    const rawParams = prop(pin.body, "params") ?? [];
    const params: { name: string; type: FormulaType }[] = [];
    let readable = typeof key === "string" && typeof expression === "string" && result !== null && Array.isArray(rawParams);
    if (readable && Array.isArray(rawParams)) {
      for (const p of rawParams) {
        const name = prop(p, "name");
        const type = operandType(prop(p, "type"));
        if (typeof name !== "string" || !type) readable = false;
        else params.push({ name, type });
      }
    }
    if (!readable || typeof key !== "string" || typeof expression !== "string" || !result) {
      problems.push({ code: "pin", message: `The model's copy of ${typeof key === "string" ? key : pin.id} isn't a calculation a schedule can read. Update it from the library.` });
      continue;
    }
    const prior = revisions.get(key);
    if (prior !== undefined && prior !== pin.revision) {
      problems.push({ code: "pin", message: `${key} is pinned twice (revisions ${prior} and ${pin.revision}); keep one.` });
      continue;
    }
    revisions.set(key, pin.revision);
    const names = new Set(params.map((p) => p.name));
    calculations.set(key, { id: key, params, result, expression: expression.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => (names.has(name) ? name : whole)) });
  }
  return { calculations, problems };
}

class Planner {
  readonly problems: ScheduleProblem[] = [];
  readonly relationships = new Set<string>();
  coarse = false;

  constructor(
    readonly registry: Registry,
    readonly readers: FieldReaders,
    readonly classes: readonly string[],
    readonly calculations: ReadonlyMap<string, NamedCalculationSignature> = new Map(),
  ) {}

  private problem(code: ScheduleProblem["code"], message: string, columnId?: string): void {
    this.problems.push({ code, message, ...(columnId === undefined ? {} : { columnId }) });
  }

  /** A column's display unit must measure what the column holds. */
  private checkUnit(col: ScheduleColumnDef, kind: Kind | undefined): boolean {
    if (col.unit === undefined) return true;
    if (kind && unitAllowed(kind, col.unit)) return true;
    const heading = col.heading ?? col.id;
    this.problem("unit", kind ? `"${heading}" holds ${KINDS[kind].label.toLowerCase()}, which can't be shown in ${col.unit}.` : `"${heading}" isn't a quantity, so it can't have a unit.`, col.id);
    return false;
  }

  /** The class list a relationship reaches (every class for "any"). */
  private targets(rel: RelationshipDef): readonly string[] {
    return rel.to === "any" ? this.registry.listClasses({ includeAbstract: true }).map((c) => c.id) : rel.to;
  }

  schema(classes: readonly string[], depth = 0): FormulaSchema {
    return {
      field: (path) => {
        const r = this.readers.first(classes, path);
        if (!r || r.many) return undefined;
        const type = formulaTypeOf(r.type);
        return type ? { type, label: r.type.label.toLowerCase() } : undefined;
      },
      relationship: (name) => {
        const rel = this.registry.relationship(name);
        if (!rel?.resolve || depth > 2) return undefined;
        return { label: rel.label.toLowerCase(), target: this.schema(this.targets(rel), depth + 1) };
      },
      calculation: (id) => this.calculations.get(id),
    };
  }

  reader(path: string, columnId?: string, parameter = false): PathReader | null {
    const r = parameter ? this.readers.parameter(this.classes, path) : this.readers.first(this.classes, path);
    if (!r) {
      const where = this.classes.length > 0 ? this.classes.map((c) => this.registry.getClass(c)?.label ?? c).join(", ") : "this schedule";
      const near = this.readers.suggest(this.classes, path);
      const hint = near.length === 0 ? " Pick one from the field list." : ` Did you mean ${near.map((p) => `"${p}"`).join(" or ")}?`;
      this.problem("unknown_field", `"${path}" isn't a field of ${where}.${hint}`, columnId);
      return null;
    }
    if (r.coarse) this.coarse = true;
    for (const s of r.steps) this.relationships.add(s.id);
    return r;
  }

  compile(expression: string, columnId: string, expect?: FormulaType): CompiledFormula | null {
    const res = formulaEngine.compile(expression, this.schema(this.classes), expect ? { expect } : {});
    if (!res.ok) {
      for (const e of res.errors) {
        const name = expression.slice(e.span.start, e.span.end);
        if (e.code === "unknown_calculation") this.problem("pin", `${name} isn't pinned in this model, so column ${columnId} can't use it. Add it from the library.`, columnId);
        else this.problem("formula", `${e.message} (column ${columnId}, at ${e.span.start + 1})`, columnId);
      }
      return null;
    }
    for (const r of res.formula.dependencies.relationships) this.relationships.add(r.name);
    for (const f of res.formula.dependencies.fields) {
      const r = this.readers.first(this.classes, f);
      if (r?.coarse) this.coarse = true;
      for (const s of r?.steps ?? []) this.relationships.add(s.id);
    }
    return res.formula;
  }

  private totalRule(col: ScheduleColumnDef, storage: StorageType, kind: Kind | undefined, relationship: string | undefined): AggregationRule | null {
    if (!col.total) return null;
    const counted = relationship ? COUNTED_AT_TARGET[relationship] : undefined;
    if (counted) {
      this.problem("total_refused", counted, col.id);
      return null;
    }
    if (storage !== "quantity" || !kind) {
      this.problem("total_refused", `"${col.heading ?? col.id}" is text, so it can't have a total.`, col.id);
      return null;
    }
    const rule = KINDS[kind].aggregation.default;
    if (rule === "none") {
      this.problem("total_refused", `${KINDS[kind].label} values don't add up, so "${col.heading ?? col.id}" can't have a total.`, col.id);
      return null;
    }
    return rule;
  }

  private highlights(col: ScheduleColumnDef): Highlighter[] {
    const out: Highlighter[] = [];
    for (const h of col.highlights ?? []) {
      const f = this.compile(h.when, col.id, { type: "boolean" });
      if (f) out.push({ formula: f, tone: h.tone, reason: h.reason });
    }
    return out;
  }

  column(col: ScheduleColumnDef): ColumnPlan | null {
    const base = { id: col.id, ...(col.precision === undefined ? {} : { precision: col.precision }), ...(col.width === undefined ? {} : { width: col.width }) };
    if (col.kind === "field" || col.kind === "parameter") {
      const r = this.reader(col.path, col.id, col.kind === "parameter");
      if (!r) return null;
      if (r.many) {
        this.problem("unknown_field", `"${col.path}" can reach many elements; use a sum, count or list column, or an expandable sub-list.`, col.id);
        return null;
      }
      const t = r.type;
      if (!this.checkUnit(col, t.kind)) return null;
      const storage = storageOf(t);
      const out: RowSetColumn = {
        ...base,
        heading: col.heading ?? t.label,
        kind: col.kind,
        valueType: t.valueType,
        ...(t.kind === undefined ? {} : { quantityKind: t.kind }),
        ...(col.unit ?? t.unit ? { unit: col.unit ?? t.unit } : {}),
        ...(t.choices ? { choices: t.choices } : {}),
        writer: t.writer,
        ...(t.lockedReason === undefined ? {} : { lockedReason: t.lockedReason }),
        ...(t.writer === null ? { source: { kind: "field" as const, label: t.label, target: t.sourceRef ?? col.path } } : {}),
      };
      return { def: col, out, storage, ...(t.kind === undefined ? {} : { kind: t.kind }), path: col.path, highlights: this.highlights(col), totalRule: this.totalRule(col, storage, t.kind, r.steps[0]?.id) };
    }
    if (col.kind === "formula" || col.kind === "aggregate") {
      const expression = col.kind === "formula" ? col.expression : aggregateExpression(col.fn, col.relationship, col.path);
      if (col.kind === "aggregate") {
        const rel = this.registry.relationship(col.relationship);
        if (!rel?.resolve) {
          this.problem("unknown_relationship", rel ? `"${rel.label}" can't be listed yet: no provider resolves it.` : `There is no relationship "${col.relationship}".`, col.id);
          return null;
        }
      }
      const f = this.compile(expression, col.id);
      if (!f) return null;
      const t = f.type;
      const storage: StorageType = t.type === "quantity" ? "quantity" : t.type === "boolean" ? "boolean" : "text";
      const kind = t.type === "quantity" ? t.kind : undefined;
      if (!this.checkUnit(col, kind)) return null;
      const rel = col.kind === "aggregate" ? this.registry.relationship(col.relationship) : undefined;
      const out: RowSetColumn = {
        ...base,
        heading: col.heading ?? (rel ? `${rel.label} ${col.kind === "aggregate" ? col.fn : ""}`.trim().toUpperCase() : col.id.toUpperCase()),
        kind: col.kind,
        valueType: t.type,
        ...(kind === undefined ? {} : { quantityKind: kind }),
        ...(t.type === "quantity" ? { unit: col.unit ?? t.unit } : {}),
        writer: null,
        lockedReason: rel ? `Calculated from what it ${rel.label.toLowerCase()}` : `Calculated: ${expression}`,
        source: rel
          ? { kind: "relationship", label: rel.label, target: rel.id }
          : col.kind === "formula" && col.calculation
            ? { kind: "calculation", label: col.calculation, target: col.calculation }
            : { kind: "formula", label: expression, target: expression },
      };
      return { def: col, out, storage, ...(kind === undefined ? {} : { kind }), formula: f, highlights: this.highlights(col), totalRule: this.totalRule(col, storage, kind, col.kind === "aggregate" ? col.relationship : undefined) };
    }
    // expand
    const rel = this.registry.relationship(col.relationship);
    if (!rel?.resolve) {
      this.problem("unknown_relationship", rel ? `"${rel.label}" can't be expanded yet: no provider resolves it.` : `There is no relationship "${col.relationship}".`, col.id);
      return null;
    }
    this.relationships.add(rel.id);
    if (col.total) this.totalRule(col, "text", undefined, rel.id);
    const childColumns: RowSetColumn[] = [];
    for (const p of col.columns) {
      const r = this.readers.first(this.classes, `${rel.id}.${p}`) ?? this.readers.get(null, p);
      if (!r) {
        this.problem("unknown_field", `"${p}" isn't a field of what it ${rel.label.toLowerCase()}.`, col.id);
        continue;
      }
      if (r.coarse) this.coarse = true;
      const t = r.type;
      childColumns.push({
        id: p,
        heading: t.label,
        kind: "field",
        valueType: t.valueType,
        ...(t.kind === undefined ? {} : { quantityKind: t.kind }),
        ...(t.unit === undefined ? {} : { unit: t.unit }),
        writer: t.writer,
        ...(t.lockedReason === undefined ? {} : { lockedReason: t.lockedReason }),
      });
    }
    const out: RowSetColumn = { ...base, heading: col.heading ?? rel.label.toUpperCase(), kind: "expand", valueType: "text", writer: null, lockedReason: `The elements it ${rel.label.toLowerCase()}`, source: { kind: "relationship", label: rel.label, target: rel.id }, childColumns, expandLabel: rel.label };
    return { def: col, out, storage: "text", expand: { relationship: rel, paths: col.columns, columns: childColumns }, highlights: [], totalRule: null };
  }
}

// ---------------------------------------------------------------- helpers

/** Cells already hold canonical SI for their field's kind, which is what a formula operand is. */
function formulaInput(v: CellValue): FormulaCellValue {
  return typeof v === "number" ? (v as Quantity<Kind>) : v;
}

function sameCell(a: CellValue, b: CellValue): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return a === b;
}

function valueColumnCell(col: ValueColumn, i: number): CellValue {
  if (col.type === "quantity") {
    const v = col.values[i] ?? Number.NaN;
    return Number.isNaN(v) ? null : v;
  }
  if (col.type === "boolean") {
    const v = col.values[i] ?? -1;
    return v === -1 ? null : v === 1;
  }
  return col.values[i] ?? null;
}

function formulaCell(v: FormulaValue): CellValue {
  if (v.type === "empty") return null;
  if (v.type === "quantity") return Number.isFinite(v.value) ? v.value : null;
  return v.value;
}

function toColumnValues(storage: StorageType, kind: Kind | undefined, cells: readonly CellValue[]): ColumnValues {
  if (storage === "quantity") {
    const values = new Float64Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      values[i] = typeof c === "number" ? c : Number.NaN;
    }
    return { type: "quantity", kind: kind ?? "dimensionless", values };
  }
  if (storage === "boolean") {
    const values = new Int8Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      values[i] = c === true ? 1 : c === false ? 0 : -1;
    }
    return { type: "boolean", values };
  }
  return { type: "text", values: cells.map((c) => (c === null || c === undefined ? null : String(c))) };
}

function compareKeys(a: readonly (number | string | null)[], b: readonly (number | string | null)[], desc: readonly boolean[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    let c: number;
    if (typeof x === "number" && typeof y === "number") c = x - y;
    else c = COLLATOR.compare(x === null ? "" : String(x), y === null ? "" : String(y));
    if (c !== 0) return desc[i] ? -c : c;
  }
  return 0;
}

/** The display profile a schedule prints in (US feet-inches when it names none). */
/** Kinds whose v1 part parameters print in the parameter's own unit (75 kW stays kW, not 75,000 W). */
const PARAMETER_UNIT_KINDS: ReadonlySet<string> = new Set(["power_real", "power_apparent", "power_mechanical", "thermal_power"]);

const headingLabelled = (kind: Kind) => {
  const d = PROFILE_US_FEET_INCHES.kinds[kind];
  return d ? { [kind]: { ...d, label: "heading" as const } } : {};
};

/**
 * How a v1 schedule read as v2 shows numbers, so it prints as v1 did: the
 * built-in v1 quantities bare under headings that name their unit (CFM,
 * VELOCITY (FPM)), lengths in feet and inches to 1/4", and power parameters
 * in their own unit with its symbol (480 V, 75 kW).
 */
/** v1 part parameters (`formatParam`): two decimals at most, whole from 100 up (112.46 kW prints "112 kW"). */
const V1_PARAMETER_PRECISION = Object.freeze({ kind: "decimals" as const, digits: 2, wholeFrom: 100 });

const PROFILE_V1_SCHEDULE: DisplayProfile = Object.freeze({
  ...PROFILE_US_FEET_INCHES,
  id: V1_SCHEDULE_PROFILE_ID,
  name: "As v1 schedules print",
  // v1 printed plain numbers: no thousands separator, decimals only where the value has them (75 kW, 2.5 A).
  thousands: "",
  trimZeros: true,
  precision: V1_PARAMETER_PRECISION,
  kinds: Object.freeze({
    ...Object.fromEntries(
      Object.entries(PROFILE_US_FEET_INCHES.kinds)
        .filter(([kind]) => !PARAMETER_UNIT_KINDS.has(kind))
        .map(([kind, d]) => [kind, kind === "length" ? d : { ...d, precision: kind === "angle" ? { kind: "decimals" as const, digits: 2 } : V1_PARAMETER_PRECISION }]),
    ),
    ...(PROFILE_US_FEET_INCHES.kinds.length ? { length: { ...PROFILE_US_FEET_INCHES.kinds.length, precision: { kind: "fraction" as const, denominator: 4 as const } } } : {}),
    ...headingLabelled("flow_air"),
    ...headingLabelled("velocity"),
    ...headingLabelled("pressure_gradient"),
    ...headingLabelled("count"),
  }),
});

export function scheduleProfile(def: ScheduleDefinitionV2): DisplayProfile {
  const id = def.display.profile;
  if (id === V1_SCHEDULE_PROFILE_ID) return PROFILE_V1_SCHEDULE;
  return (id ? BUILTIN_PROFILES.find((p) => p.id === id) : undefined) ?? PROFILE_US_FEET_INCHES;
}

/** A cell as text, for grouping, filtering and combining rows. */
function cellText(cell: CellValue, kind: Kind | undefined, profile: DisplayProfile): string {
  if (cell === null) return "";
  if (typeof cell === "number") return kind ? formatter(kind, profile)(cell) : String(cell);
  if (typeof cell === "boolean") return cell ? "Yes" : "No";
  return cell;
}

function childSignature(set: RowSet | undefined): string {
  if (!set) return "";
  const parts: string[] = [set.rowKeys.join(",")];
  for (const [id, col] of set.values) parts.push(`${id}=${col.type === "text" ? col.values.join("\u0001") : Array.from(col.values).join(",")}`);
  return parts.join("|");
}

// ---------------------------------------------------------------- session

class Session implements ScheduleSession {
  private readonly registry: Registry;
  private elements: Elements;
  private revision: number;
  private readonly readers: FieldReaders;
  private readonly plans: readonly ColumnPlan[];
  private readonly sortSpecs: readonly { readonly path: string; readonly reader: PathReader | null; readonly desc: boolean }[];
  private readonly groupReaders: readonly (PathReader | null)[];
  private readonly filterReaders: readonly (PathReader | null)[];
  private readonly levelReader: PathReader | null;
  private readonly candidateClasses: readonly ObjectClass[];
  private readonly classes: readonly string[];
  private readonly wide: { readonly kinds: ReadonlySet<string>; readonly connections: boolean; readonly any: boolean };
  private readonly profile: DisplayProfile;
  private readonly countColumn: number;

  private readonly rowsByKey = new Map<RowKey, Row>();
  private order: Row[] = [];
  private readonly readersOf = new Map<string, Set<RowKey>>();
  private out: readonly OutRow[] = [];
  private outByKey: ReadonlyMap<RowKey, OutRow> = new Map();
  private desc: readonly boolean[] = [];
  private groups: RowGroup[] = [];
  private totals = new Map<ColumnId, Measure | null>();

  constructor(
    model: ScheduleModel,
    readonly definition: ScheduleDefinitionV2,
    private readonly viewId: string,
    revision: number,
    registry: Registry,
  ) {
    this.registry = registry;
    this.elements = model.elements;
    this.revision = revision;
    this.readers = new FieldReaders(registry, () => this.elements);
    this.profile = scheduleProfile(definition);

    const problems: ScheduleProblem[] = [];
    const src = definition.source;
    let classes: string[] = [];
    if (src.kind === "classes") {
      for (const c of src.classes) {
        if (!registry.getClass(c)) problems.push({ code: "unknown_class", message: `There is no class "${c}".` });
      }
      classes = src.classes.filter((c) => registry.getClass(c) !== undefined);
      const scope = src.scope;
      if (scope) {
        for (const key of ["systems", "zones", "rooms", "phase", "links"] as const) {
          if (scope[key] !== undefined) problems.push({ code: "unsupported_source", message: `Narrowing a schedule by ${key} isn't available yet; remove it or use a filter.` });
        }
      }
    } else if (src.kind === "related") {
      const rel = registry.relationship(src.relationship);
      if (!rel?.resolve) problems.push({ code: "unknown_relationship", message: rel ? `"${rel.label}" can't be listed yet: no provider resolves it.` : `There is no relationship "${src.relationship}".` });
      else classes = rel.to === "any" ? [] : [...rel.to];
    } else if (!CATALOGS[src.catalog]) {
      problems.push({ code: "unsupported_source", message: `There is no catalog "${src.catalog}". Catalogs: ${Object.keys(CATALOGS).join(", ")}.` });
    }

    const seen = new Set<string>();
    for (const c of definition.columns) {
      if (seen.has(c.id)) problems.push({ code: "duplicate_column", message: `Two columns are called "${c.id}".`, columnId: c.id });
      seen.add(c.id);
    }

    const pinned = pinnedCalculations(definition.pins);
    problems.push(...pinned.problems);
    const planner = new Planner(registry, this.readers, classes, pinned.calculations);
    const plans: ColumnPlan[] = [];
    for (const c of definition.columns) {
      const p = planner.column(c);
      if (p) plans.push(p);
    }
    let countColumn = plans.findIndex((p) => p.path === "count");
    if (!definition.itemize && countColumn < 0) {
      const count = planner.column({ id: "count", kind: "field", path: "count", heading: "COUNT" });
      if (count) {
        plans.push(count);
        countColumn = plans.length - 1;
      }
    }
    this.countColumn = countColumn;
    const groupPaths = definition.groups.map((g) => g.path);
    const sortSpecs = [
      ...groupPaths.filter((p) => !definition.sort.some((s) => s.path === p)).map((p) => ({ path: p, direction: "asc" as const })),
      ...definition.sort,
    ];
    const parameterPaths = new Set(definition.columns.flatMap((c) => (c.kind === "parameter" ? [c.path] : [])));
    this.sortSpecs = sortSpecs.map((s) => ({ path: s.path, reader: planner.reader(s.path, undefined, parameterPaths.has(s.path)), desc: s.direction === "desc" }));
    this.groupReaders = groupPaths.map((p) => planner.reader(p, undefined, parameterPaths.has(p)));
    this.filterReaders = definition.filters.map((f) => planner.reader(f.path, undefined, parameterPaths.has(f.path)));
    this.levelReader = src.kind === "classes" && src.scope?.levels?.length ? planner.reader("level") : null;
    problems.push(...planner.problems);
    if (problems.length > 0) throw new ScheduleDefinitionError(problems);

    this.plans = plans;
    this.classes = classes;

    const kinds = new Set<string>();
    let connections = false;
    for (const id of planner.relationships) {
      const rel = registry.relationship(id);
      if (!rel) continue;
      for (const k of rel.deps.elementKinds ?? []) kinds.add(k);
      if (rel.deps.sources) for (const k of connectorEndsTable().rootKinds) kinds.add(k);
      if (rel.deps.connections) connections = true;
    }
    if (src.kind === "related") connections = true;
    this.wide = { kinds, connections, any: planner.coarse };

    const candidates = new Map<string, ObjectClass>();
    if (src.kind === "classes") {
      for (const c of classes) {
        for (const d of src.includeSubclasses ? registry.descendants(c) : [c]) {
          const cls = registry.getClass(d);
          if (cls && !candidates.has(d)) candidates.set(d, cls);
        }
      }
    }
    this.candidateClasses = [...candidates.values()];
    this.buildAll();
  }

  // ------------------------------------------------------------ membership

  private classFor(el: BimElement): string | null | undefined {
    if (this.definition.source.kind !== "classes") return null;
    for (const cls of this.candidateClasses) if (recognizes(cls, el, this.elements)) return cls.id;
    return undefined;
  }

  private sourceElements(): BimElement[] {
    const src = this.definition.source;
    if (src.kind === "classes") {
      const index = buildClassIndex(this.registry, { elements: this.elements });
      const seen = new Set<string>();
      const out: BimElement[] = [];
      for (const c of src.classes) {
        for (const el of index.elementsOf(c, { includeSubclasses: src.includeSubclasses })) {
          if (seen.has(el.id)) continue;
          seen.add(el.id);
          out.push(el);
        }
      }
      return out;
    }
    if (src.kind === "related") {
      const from = this.elements[src.from];
      const rel = this.registry.relationship(src.relationship);
      if (!from || !rel) return [];
      let at: BimElement[] = [from];
      const all: BimElement[] = [];
      const seen = new Set<string>();
      for (let d = 0; d < Math.max(1, src.depth ?? 1); d++) {
        at = resolveStep(rel, at, this.elements, []);
        for (const el of at) if (!seen.has(el.id)) (seen.add(el.id), all.push(el));
      }
      return all;
    }
    return CATALOGS[src.catalog]?.(this.elements) ?? [];
  }

  // ------------------------------------------------------------ reading a row

  /** Per row class, per path: the reader a cell uses (null: reads empty). Resolved once, not per cell. */
  private readonly cellReaders = new Map<string | null, Map<string, PathReader | null>>();

  private cellReader(classId: string | null, path: string): PathReader | null {
    let byPath = this.cellReaders.get(classId);
    if (!byPath) this.cellReaders.set(classId, (byPath = new Map()));
    const known = byPath.get(path);
    if (known !== undefined) return known;
    let reader = this.readers.get(classId, path);
    // A class whose same-named field means something else reads empty, never a mistyped value.
    const column = this.readers.first(this.classes, path);
    if (reader && column && column !== reader && (storageOf(column.type) !== storageOf(reader.type) || column.type.kind !== reader.type.kind)) reader = null;
    byPath.set(path, reader);
    return reader;
  }

  private readCell(row: { el: BimElement; classId: string | null }, path: string, reads: string[]): CellValue {
    const reader = this.cellReader(row.classId, path);
    return reader ? reader.read(row.el, this.elements, reads) : null;
  }

  private rowValues(el: BimElement, classId: string | null, reads: string[]): RowValues {
    return {
      field: (path) => formulaInput(this.readCell({ el, classId }, path, reads)),
      related: (name) => {
        const rel = this.registry.relationship(name);
        if (!rel) return [];
        return resolveStep(rel, [el], this.elements, reads).map((target) => this.targetValues(target, classId, name, reads));
      },
    };
  }

  private targetValues(target: BimElement, ownerClass: string | null, rel: string, reads: string[]): RowValues {
    return {
      field: (path) => {
        const r = this.readers.get(ownerClass, `${rel}.${path}`);
        if (r && r.steps.length === 1) return formulaInput(r.readAt(target, this.elements, reads));
        return formulaInput(this.readers.get(null, path)?.readAt(target, this.elements, reads) ?? null);
      },
      related: () => [],
    };
  }

  private passes(row: { el: BimElement; classId: string | null }, reads: string[]): boolean {
    if (this.levelReader) {
      const wanted = this.definition.source.kind === "classes" ? (this.definition.source.scope?.levels ?? []).map((l) => l.trim().toLowerCase()) : [];
      const level = this.levelReader.read(row.el, this.elements, reads);
      if (!wanted.includes(String(level ?? "").trim().toLowerCase())) return false;
    }
    for (let i = 0; i < this.definition.filters.length; i++) {
      const f = this.definition.filters[i];
      const r = this.filterReaders[i];
      if (!f || !r) continue;
      if (!passesFilter(r.read(row.el, this.elements, reads), r.type, f, this.profile)) return false;
    }
    return true;
  }

  /** Read one row (without formula columns, which are evaluated per batch). Null: it doesn't belong. */
  private readRow(el: BimElement, classId: string | null): Row | null {
    const reads: string[] = [];
    const at = { el, classId };
    if (!this.passes(at, reads)) return null;
    const cells: CellValue[] = new Array<CellValue>(this.plans.length).fill(null);
    const children = new Map<ColumnId, RowSet>();
    for (let i = 0; i < this.plans.length; i++) {
      const plan = this.plans[i];
      if (!plan) continue;
      if (plan.path) {
        cells[i] = this.readCell(at, plan.path, reads);
      } else if (plan.expand) {
        children.set(plan.def.id, this.childRows(el, classId, plan, reads));
      }
    }
    const sortKeys = this.sortSpecs.map((s) => {
      const v = s.reader ? this.readCell(at, s.path, reads) : null;
      return typeof v === "number" ? v : v === null ? null : typeof v === "boolean" ? (v ? "Yes" : "No") : v;
    });
    const groupKeys = this.groupReaders.map((r) => {
      if (!r) return "";
      const v = r.read(el, this.elements, reads);
      return cellText(v, r.type.kind, this.profile);
    });
    const slot = elementOrder(this.elements).get(el.id) ?? Number.MAX_SAFE_INTEGER;
    return { key: el.id, el, elementId: el.id, elementIds: [el.id], classId, cells, reads: [...new Set(reads)], children, highlights: new Map(), sortKeys, groupKeys, slot };
  }

  private childRows(el: BimElement, classId: string | null, plan: ColumnPlan, reads: string[]): RowSet {
    const expand = plan.expand;
    if (!expand) throw new Error("not an expand column");
    const targets = resolveStep(expand.relationship, [el], this.elements, reads);
    const values = new Map<ColumnId, ColumnValues>();
    expand.columns.forEach((col, j) => {
      const path = expand.paths[j] ?? col.id;
      const cells = targets.map((t) => {
        const r = this.readers.get(classId, `${expand.relationship.id}.${path}`);
        if (r && r.steps.length === 1) return r.readAt(t, this.elements, reads);
        return this.readers.get(null, path)?.readAt(t, this.elements, reads) ?? null;
      });
      values.set(col.id, toColumnValues(col.valueType === "quantity" ? "quantity" : col.valueType === "boolean" ? "boolean" : "text", col.quantityKind, cells));
    });
    return { viewId: this.viewId, revision: this.revision, columns: expand.columns, rowCount: targets.length, rowKeys: targets.map((t) => t.id), elementIds: targets.map((t) => t.id), values, children: new Map() };
  }

  /** Formula columns and highlights for these rows: columnar on a full build, per row on a patch. */
  private evaluate(rows: readonly Row[], columnar: boolean): void {
    if (rows.length === 0) return;
    const formulaPlans = this.plans.map((p, i) => [p, i] as const).filter(([p]) => p.formula !== undefined || p.highlights.length > 0);
    if (formulaPlans.length === 0) return;
    const extraReads = rows.map(() => [] as string[]);
    const values = rows.map((r, k) => this.rowValues(r.el, r.classId, extraReads[k] ?? []));
    for (const [plan, i] of formulaPlans) {
      const f = plan.formula;
      if (f) {
        if (columnar) {
          const col = formulaEngine.evaluateColumn(f, inputsFromRows(f, values));
          rows.forEach((r, k) => (r.cells[i] = valueColumnCell(col, k)));
        } else {
          rows.forEach((r, k) => {
            const v = values[k];
            r.cells[i] = v ? formulaCell(formulaEngine.evaluateRow(f, v)) : null;
          });
        }
      }
      for (const h of plan.highlights) {
        rows.forEach((r, k) => {
          const v = values[k];
          if (!v || r.highlights.has(plan.def.id)) return;
          const res = formulaEngine.evaluateRow(h.formula, v);
          if (res.type === "boolean" && res.value) r.highlights.set(plan.def.id, { tone: h.tone, reason: h.reason });
        });
      }
    }
    rows.forEach((r, k) => {
      const more = extraReads[k];
      if (more && more.length > 0) (r as { reads: readonly string[] }).reads = [...new Set([...r.reads, ...more])];
    });
  }

  // ------------------------------------------------------------ index bookkeeping

  private index(row: Row): void {
    this.rowsByKey.set(row.key, row);
    for (const id of row.reads) {
      let set = this.readersOf.get(id);
      if (!set) this.readersOf.set(id, (set = new Set()));
      set.add(row.key);
    }
  }

  private unindex(row: Row): void {
    this.rowsByKey.delete(row.key);
    for (const id of row.reads) {
      const set = this.readersOf.get(id);
      if (!set) continue;
      set.delete(row.key);
      if (set.size === 0) this.readersOf.delete(id);
    }
  }

  private compare = (a: Row, b: Row): number => compareKeys(a.sortKeys, b.sortKeys, this.desc) || a.slot - b.slot || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  private buildAll(): void {
    this.desc = this.sortSpecs.map((s) => s.desc);
    const rows: Row[] = [];
    for (const el of this.sourceElements()) {
      const classId = this.classFor(el);
      if (classId === undefined) continue;
      const row = this.readRow(el, classId);
      if (row) rows.push(row);
    }
    this.evaluate(rows, true);
    for (const r of rows) this.index(r);
    this.order = rows.sort(this.compare);
    this.recombine();
  }

  // ------------------------------------------------------------ output rows, groups, totals

  /** Element rows to printed rows (combining when itemize is off), then groups and totals. */
  private recombine(): void {
    if (this.definition.itemize) {
      // One printed row per element row: the order and the row index are the output.
      this.out = this.order;
      this.outByKey = this.rowsByKey;
    } else {
      const byShown = new Map<string, { first: Row; ids: string[] }>();
      for (const r of this.order) {
        const shown = this.plans.map((p, i) => (i === this.countColumn ? "" : cellText(r.cells[i] ?? null, p.kind, this.profile))).join("\u0001");
        const g = byShown.get(shown);
        if (g) g.ids.push(r.el.id);
        else byShown.set(shown, { first: r, ids: [r.el.id] });
      }
      this.out = [...byShown.entries()].map(([shown, g]) => {
        const cells = [...g.first.cells];
        if (this.countColumn >= 0) cells[this.countColumn] = g.ids.length;
        return { key: `combined:${shown}`, elementId: g.first.el.id, elementIds: g.ids, cells, children: g.first.children, highlights: g.first.highlights, groupKeys: g.first.groupKeys };
      });
      this.outByKey = new Map(this.out.map((r) => [r.key, r]));
    }
    this.groups = this.computeGroups();
    this.totals = this.definition.grandTotals ? this.computeTotals(0, this.out.length) : new Map();
  }

  private computeTotals(start: number, count: number): Map<ColumnId, Measure | null> {
    const out = new Map<ColumnId, Measure | null>();
    this.plans.forEach((p, i) => {
      if (!p.totalRule || !p.kind) return;
      let acc: number | null = null;
      for (let k = start; k < start + count; k++) {
        const v = this.out[k]?.cells[i];
        if (typeof v !== "number") continue;
        const weight = this.definition.itemize || i === this.countColumn ? 1 : (this.out[k]?.elementIds.length ?? 1);
        if (acc === null) acc = p.totalRule === "sum" ? v * weight : v;
        else if (p.totalRule === "sum") acc += v * weight;
        else if (p.totalRule === "max") acc = Math.max(acc, v);
        else if (p.totalRule === "min") acc = Math.min(acc, v);
      }
      out.set(p.def.id, acc === null ? null : { kind: p.kind, value: acc });
    });
    return out;
  }

  private computeGroups(): RowGroup[] {
    const defs = this.definition.groups;
    if (defs.length === 0) return [];
    const out: RowGroup[] = [];
    for (let depth = 0; depth < defs.length; depth++) {
      const g = defs[depth];
      if (!g) continue;
      let start = 0;
      const heading = this.groupReaders[depth]?.type.label ?? g.path.toUpperCase();
      for (let k = 1; k <= this.out.length; k++) {
        const prev = this.out[k - 1];
        const at = this.out[k];
        const same = at !== undefined && prev !== undefined && at.groupKeys.slice(0, depth + 1).join("\u001f") === prev.groupKeys.slice(0, depth + 1).join("\u001f");
        if (same) continue;
        const first = this.out[start];
        if (first) {
          const totals = g.totals ? Object.fromEntries(this.computeTotals(start, k - start)) : undefined;
          out.push({ key: first.groupKeys.slice(0, depth + 1).join("\u001f"), depth, label: `${heading}: ${first.groupKeys[depth] || "(none)"}`, start, count: k - start, ...(totals ? { totals } : {}) });
        }
        start = k;
      }
    }
    return out.sort((a, b) => a.start - b.start || a.depth - b.depth);
  }

  // ------------------------------------------------------------ public

  rows(): RowSet {
    return this.slice(this.out, null);
  }

  window(offset: number, count: number): RowSet {
    const start = Math.max(0, Math.min(Math.floor(offset), this.out.length));
    const end = Math.max(start, Math.min(this.out.length, start + Math.max(0, Math.floor(count))));
    return this.slice(this.out.slice(start, end), { offset: start, totalRows: this.out.length });
  }

  private slice(out: readonly OutRow[], window: RowSet["window"] | null): RowSet {
    const values = new Map<ColumnId, ColumnValues>();
    this.plans.forEach((p, i) => {
      if (p.expand) return;
      values.set(p.def.id, toColumnValues(p.storage, p.kind, out.map((r) => r.cells[i] ?? null)));
    });
    const children = new Map<ColumnId, Map<RowKey, RowSet>>();
    const highlights = new Map<ColumnId, Map<RowKey, RowHighlight>>();
    for (const r of out) {
      for (const [col, set] of r.children) {
        let m = children.get(col);
        if (!m) children.set(col, (m = new Map()));
        m.set(r.key, set);
      }
      for (const [col, h] of r.highlights) {
        let m = highlights.get(col);
        if (!m) highlights.set(col, (m = new Map()));
        m.set(r.key, h);
      }
    }
    return {
      viewId: this.viewId,
      revision: this.revision,
      columns: this.plans.map((p) => p.out),
      rowCount: out.length,
      rowKeys: out.map((r) => r.key),
      elementIds: out.map((r) => r.elementId),
      values,
      children,
      ...(highlights.size > 0 ? { highlights } : {}),
      ...(this.definition.grandTotals ? { totals: new Map(this.totals) } : {}),
      ...(this.definition.groups.length > 0 ? { groups: this.groups } : {}),
      ...(this.definition.itemize ? {} : { rowElementIds: out.map((r) => r.elementIds) }),
      ...(window ? { window } : {}),
    };
  }

  apply(change: ScheduleChange): RowPatch {
    const fromRevision = this.revision;
    this.elements = change.model.elements;
    this.revision = change.revision;
    const removed = new Set(change.removedIds ?? []);
    const touched = new Set<string>([...change.changedIds, ...removed]);

    // Which rows to re-read.
    let all = this.wide.any && touched.size > 0;
    if (!all && this.wide.connections && ((change.connectionEndpoints?.length ?? 0) > 0 || removed.size > 0)) all = true;
    if (!all && (this.wide.connections || this.wide.kinds.size > 0)) {
      for (const id of change.changedIds) {
        const kind = this.elements[id]?.kind;
        if (kind && (this.wide.kinds.has(kind) || (this.wide.connections && NETWORK_KINDS.has(kind)))) {
          all = true;
          break;
        }
      }
      if (!all && this.wide.kinds.size > 0 && removed.size > 0) all = true;
    }
    if (!all && this.definition.source.kind === "related" && touched.size > 0) all = true;

    const recheck = new Set<string>();
    if (all) for (const key of this.rowsByKey.keys()) recheck.add(key);
    for (const id of touched) {
      for (const key of this.readersOf.get(id) ?? []) recheck.add(key);
      recheck.add(id);
    }
    if (this.definition.source.kind === "related") for (const el of this.sourceElements()) recheck.add(el.id);

    const prevOrderKeys = this.definition.itemize ? null : this.out.map((r) => r.key);
    const itemize = this.definition.itemize;
    const prevOut = itemize ? null : this.outByKey;
    const prevGroups = this.groups;
    const prevTotals = this.totals;

    const relatedMembers = this.definition.source.kind === "related" ? new Set(this.sourceElements().map((e) => e.id)) : null;
    const fresh: Row[] = [];
    let membershipChanged = false;
    let orderChanged = false;
    const leaving: Row[] = [];
    for (const key of recheck) {
      const old = this.rowsByKey.get(key);
      const el = removed.has(key) ? undefined : this.elements[key];
      let row: Row | null = null;
      if (el && (!relatedMembers || relatedMembers.has(el.id))) {
        const classId = this.classFor(el);
        if (classId !== undefined) row = this.readRow(el, classId);
      }
      if (old) {
        leaving.push(old);
        this.unindex(old);
        if (!row) membershipChanged = true;
      } else if (row) membershipChanged = true;
      if (row) {
        if (old && compareKeys(old.sortKeys, row.sortKeys, this.desc) !== 0) orderChanged = true;
        fresh.push(row);
      }
    }
    this.evaluate(fresh, false);
    for (const r of fresh) this.index(r);

    const oldByKey = new Map(leaving.map((r) => [r.key, r]));
    // Rows that kept their place (same sort keys) are swapped in where they stand.
    const placed = new Set<RowKey>();
    for (const r of fresh) {
      const old = oldByKey.get(r.key);
      if (!old || compareKeys(old.sortKeys, r.sortKeys, this.desc) !== 0) continue;
      const at = this.indexInOrder(old);
      if (at < 0) continue;
      this.order[at] = r;
      placed.add(r.key);
    }
    const moving = fresh.filter((r) => !placed.has(r.key));
    const gone = leaving.filter((r) => !placed.has(r.key));
    if (gone.length > 0 || moving.length > 0) {
      const leavingKeys = new Set(gone.map((r) => r.key));
      const keep = leavingKeys.size > 0 ? this.order.filter((r) => !leavingKeys.has(r.key)) : this.order;
      if (moving.length > keep.length / 4) {
        this.order = [...keep, ...moving].sort(this.compare);
      } else {
        for (const r of moving) {
          let lo = 0;
          let hi = keep.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const m = keep[mid];
            if (m && this.compare(m, r) <= 0) lo = mid + 1;
            else hi = mid;
          }
          keep.splice(lo, 0, r);
        }
        this.order = keep;
      }
    }
    this.recombine();

    // The patch.
    const upserts: RowUpsert[] = [];
    const removes: RowKey[] = [];
    if (itemize || !prevOut) {
      for (const now of fresh) {
        const before = oldByKey.get(now.key);
        if (before && this.sameOut(before, now)) continue;
        upserts.push(this.upsertOf(now));
      }
      for (const old of leaving) if (!this.rowsByKey.has(old.key)) removes.push(old.key);
    } else {
      for (const now of this.out) {
        const before = prevOut.get(now.key);
        if (before && this.sameOut(before, now)) continue;
        upserts.push(this.upsertOf(now));
      }
      for (const key of prevOut.keys()) if (!this.outByKey.has(key)) removes.push(key);
    }
    if (!this.definition.itemize && prevOrderKeys) {
      const nowKeys = this.out.map((r) => r.key);
      if (nowKeys.length !== prevOrderKeys.length || nowKeys.some((k, i) => k !== prevOrderKeys[i])) orderChanged = true;
    }
    const totals = this.definition.grandTotals && !sameTotals(prevTotals, this.totals) ? Object.fromEntries(this.totals) : undefined;
    const groups = JSON.stringify(prevGroups) !== JSON.stringify(this.groups) ? this.groups : undefined;
    return {
      viewId: this.viewId,
      fromRevision,
      toRevision: this.revision,
      upserts,
      removes,
      ...(membershipChanged || orderChanged || removes.length > 0 ? { order: this.out.map((r) => r.key) } : {}),
      ...(totals ? { totals } : {}),
      ...(groups ? { groups } : {}),
    };
  }

  /** Where a row stands in the order (binary search on the sort keys, slot and key), -1 if absent. */
  private indexInOrder(row: Row): number {
    let lo = 0;
    let hi = this.order.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const m = this.order[mid];
      if (!m) return -1;
      const c = this.compare(m, row);
      if (c === 0) return m.key === row.key ? mid : -1;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private sameOut(a: OutRow, b: OutRow): boolean {
    if (a.elementIds.length !== b.elementIds.length || a.elementIds.some((id, i) => id !== b.elementIds[i])) return false;
    for (let i = 0; i < a.cells.length; i++) if (!sameCell(a.cells[i] ?? null, b.cells[i] ?? null)) return false;
    if (a.highlights.size !== b.highlights.size) return false;
    for (const [k, h] of a.highlights) {
      const o = b.highlights.get(k);
      if (!o || o.tone !== h.tone || o.reason !== h.reason) return false;
    }
    for (const [k, set] of a.children) if (childSignature(set) !== childSignature(b.children.get(k))) return false;
    return a.children.size === b.children.size;
  }

  private upsertOf(r: OutRow): RowUpsert {
    const values: Record<ColumnId, CellValue> = {};
    this.plans.forEach((p, i) => {
      if (!p.expand) values[p.def.id] = r.cells[i] ?? null;
    });
    const highlights: Record<ColumnId, RowHighlight | null> = {};
    for (const p of this.plans) if (p.highlights.length > 0) highlights[p.def.id] = r.highlights.get(p.def.id) ?? null;
    return {
      rowKey: r.key,
      elementId: r.elementId,
      values,
      ...(r.children.size > 0 ? { children: Object.fromEntries(r.children) } : {}),
      ...(Object.keys(highlights).length > 0 ? { highlights } : {}),
      ...(this.definition.itemize ? {} : { elementIds: r.elementIds }),
    };
  }

  planEdit(edit: ScheduleCellEdit): CellEditPlan {
    const out = this.outByKey.get(edit.rowKey);
    if (!out) return { ok: false, reason: "That row isn't in the schedule any more; it may have just changed." };
    const plan = this.plans.find((p) => p.def.id === edit.columnId);
    if (!plan) return { ok: false, reason: `There is no column "${edit.columnId}".` };
    if (!plan.path) return { ok: false, reason: plan.out.lockedReason ?? `"${plan.out.heading}" is calculated, so it can't be typed in.` };
    const rows = out.elementIds.flatMap((id) => {
      const r = this.rowsByKey.get(id);
      return r ? [r] : [];
    });
    const first = rows[0];
    if (!first) return { ok: false, reason: "That row isn't in the schedule any more; it may have just changed." };
    return planFieldEdit(this.elements, rows.map((r) => r.el), this.readers.get(first.classId, plan.path)?.type ?? null, edit.value);
  }

  explain(rowKey: RowKey, columnId: ColumnId): string | null {
    const plan = this.plans.find((p) => p.def.id === columnId);
    const out = this.outByKey.get(rowKey);
    const row = out ? this.rowsByKey.get(out.elementId) : undefined;
    if (!plan?.formula || !row) return null;
    return formulaEngine.explain(plan.formula, this.rowValues(row.el, row.classId, [])).text;
  }
}

function sameTotals(a: ReadonlyMap<ColumnId, Measure | null>, b: ReadonlyMap<ColumnId, Measure | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (v === null || o === null || o === undefined) {
      if (v !== o) return false;
    } else if (v.value !== o.value || v.kind !== o.kind) return false;
  }
  return true;
}

function passesFilter(v: CellValue, type: FieldType, f: ScheduleFilter, profile: DisplayProfile): boolean {
  if (f.op === "present") return v !== null && v !== "";
  if (f.op === "absent") return v === null || v === "";
  const want = (f.value ?? "").trim();
  if (typeof v === "number" && type.unit) {
    const n = Number(want);
    if (Number.isFinite(n)) {
      const target = toSI(n, type.unit);
      if (f.op === "greater_than") return v > target;
      if (f.op === "less_than") return v < target;
      if (f.op === "equals") return Math.abs(v - target) <= 1e-9 * Math.max(1, Math.abs(target));
      if (f.op === "not_equals") return Math.abs(v - target) > 1e-9 * Math.max(1, Math.abs(target));
    }
  }
  const text = cellText(v, type.kind, profile).toLowerCase();
  const w = want.toLowerCase();
  switch (f.op) {
    case "equals":
      return text === w;
    case "not_equals":
      return text !== w;
    case "contains":
      return text.includes(w);
    case "greater_than":
      return COLLATOR.compare(text, w) > 0;
    case "less_than":
      return COLLATOR.compare(text, w) < 0;
  }
}

/** Catalog sources: rows that are definitions, not placed elements. */
const CATALOGS: Readonly<Record<string, (elements: Elements) => BimElement[]>> = {
  part_types: (elements) => elementsOfKind(elements, "part_type"),
};

/** Open a schedule: build every row once and keep what each row read, for `apply`. Throws `ScheduleDefinitionError` naming every problem. */
export function openSchedule(model: ScheduleModel, definition: ScheduleDefinitionV2, ctx: ScheduleEngineContext): ScheduleSession {
  return new Session(model, definition, ctx.viewId, ctx.revision, ctx.registry ?? builtinRegistry());
}

/** Rebuild from scratch: what `apply` must always equal. */
export function buildRowSet(model: ScheduleModel, definition: ScheduleDefinitionV2, ctx: ScheduleEngineContext): RowSet {
  return openSchedule(model, definition, ctx).rows();
}

/** Every problem with a definition, in plain words (empty: it builds). */
export function validateScheduleDefinition(model: ScheduleModel, definition: ScheduleDefinitionV2, ctx: ScheduleEngineContext): readonly ScheduleProblem[] {
  try {
    openSchedule(model, definition, ctx);
    return [];
  } catch (err) {
    if (err instanceof ScheduleDefinitionError) return err.problems;
    throw err;
  }
}
