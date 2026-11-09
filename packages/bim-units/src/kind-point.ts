import { KIND_IDS, KIND_UNITS } from "./codes";
import { describeDimension, dim, sameDimension } from "./dimension";
import { UnitError } from "./errors";
import { KINDS } from "./kinds";
import { isKind } from "./quantity";
import type { AggregationRule, BaseDimension, Dimension, Kind } from "./types";
import { UNITS } from "./units";

/**
 * Quantity kinds an add-on brings (contract 1.9.0, `units.unit_kind` v1).
 *
 * The built-in kinds stay a closed TypeScript union (`Kind`), so code that
 * computes in them keeps its compile-time checks. An add-on's kind is a row:
 * its id is namespaced (`acoustics.sound_absorption`), it states its
 * dimension, how its values total, and the units it may be written in (codes
 * namespaced the same way, each with its factor to coherent SI). Readers take
 * any kind id: a built-in one, a row the model's add-ons supply, or one whose
 * add-on isn't here, which they keep as stored and name ("needs its add-on").
 *
 * The point has the kernel's `ExtensionPoint` shape without importing the
 * kernel (bim-units imports nothing above it): a pack contributes rows with
 * `contribute(UNIT_KIND_POINT, rows)` and a host reads them with
 * `set.items(UNIT_KIND_POINT)`, then builds one `UnitKindTable` per set.
 */

/** An add-on's kind or unit: `<pack>.<name>`, lower case. */
export type AddonUnitId = `${string}.${string}`;
/** Any kind a stored value may name: built in, or an add-on's. */
export type UnitKindId = Kind | AddonUnitId;

export interface UnitKindUnitDef {
  /** `<pack>.<name>` for an add-on's unit ("acoustics.sabin_ft2"). */
  readonly code: string;
  readonly label: string;
  /** As printed after a number ("sabin"). */
  readonly symbol: string;
  /** coherent SI = value × factor + offset. */
  readonly factor: number;
  readonly offset?: number;
  /** Other spellings accepted when a person types one. */
  readonly aliases?: readonly string[];
}

export interface UnitKindDef {
  /** Built in: the bare kind id ("length"). An add-on's: `<pack>.<name>`. */
  readonly id: string;
  readonly label: string;
  /** Exponents per base dimension; left out: 0. */
  readonly dimension: Readonly<Partial<Record<BaseDimension, number>>>;
  readonly aggregation: { readonly default: AggregationRule; readonly allowed: readonly AggregationRule[] };
  /** Trades that use it most, for grouping in pickers (any discipline id). */
  readonly disciplines?: readonly string[];
  /** The units it may be written in; the first is its default display unit. */
  readonly units: readonly UnitKindUnitDef[];
}

/** The kernel's `ExtensionPoint<T>`, restated so this package stays dependency-free (structurally identical). */
export interface UnitKindPoint {
  readonly id: "units.unit_kind";
  readonly version: 1;
  readonly label: string;
  readonly idOf: (item: UnitKindDef) => string;
  readonly namespaced: true;
  readonly builtins: () => readonly UnitKindDef[];
}

let builtinRows: readonly UnitKindDef[] | null = null;

function rowOfBuiltin(kind: Kind): UnitKindDef {
  const k = KINDS[kind];
  const dimension: Partial<Record<BaseDimension, number>> = {};
  for (const [d, e] of Object.entries(k.dimension)) if (e !== 0) Reflect.set(dimension, d, e);
  return Object.freeze({
    id: kind,
    label: k.label,
    dimension: Object.freeze(dimension),
    aggregation: Object.freeze({ default: k.aggregation.default, allowed: k.aggregation.allowed }),
    disciplines: k.disciplines,
    units: Object.freeze(
      KIND_UNITS[kind].map((code) => {
        const u = UNITS[code];
        return Object.freeze({ code, label: u.label, symbol: u.symbol, factor: u.factor, ...(u.offset !== 0 ? { offset: u.offset } : {}), ...(u.aliases.length > 0 ? { aliases: u.aliases } : {}) });
      }),
    ),
  });
}

/** The built-in kinds as rows, in `KIND_IDS` order (read lazily, once). */
export function builtinUnitKindRows(): readonly UnitKindDef[] {
  builtinRows ??= Object.freeze(KIND_IDS.map(rowOfBuiltin));
  return builtinRows;
}

export const UNIT_KIND_POINT: UnitKindPoint = Object.freeze({
  id: "units.unit_kind",
  version: 1,
  label: "Quantity kinds",
  idOf: (item: UnitKindDef) => item.id,
  namespaced: true,
  builtins: builtinUnitKindRows,
});

const ADDON_ID = /^[a-z][a-z0-9_]{1,23}\.[a-z][a-z0-9_]{0,63}$/;

/** True for any kind a stored value may name: a built-in kind or an add-on's `<pack>.<name>`. */
export function isUnitKindId(value: unknown): value is UnitKindId {
  return typeof value === "string" && (isKind(value) || ADDON_ID.test(value));
}

/** True for any unit a stored value may name: a built-in code or an add-on's `<pack>.<name>`. */
export function isUnitCodeId(value: unknown): value is string {
  return typeof value === "string" && (Object.hasOwn(UNITS, value) || ADDON_ID.test(value));
}

/** What a library or model file says when a kind id isn't one: for schema refinements. */
export const UNIT_KIND_ID_HINT = "a quantity kind such as length or flow_air, or an add-on's kind such as acoustics.sound_absorption";

/** Problems with add-on kind rows, in words (pack conformance). Built-in rows are never checked here. */
export function unitKindRowProblems(rows: readonly UnitKindDef[]): string[] {
  const out: string[] = [];
  const codes = new Map<string, string>();
  for (const row of rows) {
    if (isKind(row.id)) {
      out.push(`kind ${row.id} is built in; an add-on can't redefine it`);
      continue;
    }
    if (!ADDON_ID.test(row.id)) out.push(`kind "${row.id}" must be "<pack>.<name>" in lower case`);
    if (row.label.trim().length === 0) out.push(`kind ${row.id} has no label`);
    for (const [d, e] of Object.entries(row.dimension)) if (typeof e !== "number" || !Number.isFinite(e)) out.push(`kind ${row.id}: the ${d} exponent isn't a number`);
    if (!row.aggregation.allowed.includes(row.aggregation.default)) out.push(`kind ${row.id}: its default total "${row.aggregation.default}" isn't one it allows`);
    if (row.units.length === 0) out.push(`kind ${row.id} has no units`);
    const ns = row.id.split(".")[0] ?? "";
    for (const u of row.units) {
      if (!ADDON_ID.test(u.code) || u.code.split(".")[0] !== ns) out.push(`kind ${row.id}: unit "${u.code}" must be "${ns}.<name>"`);
      if (Object.hasOwn(UNITS, u.code)) out.push(`kind ${row.id}: unit ${u.code} is built in`);
      if (!(Number.isFinite(u.factor) && u.factor > 0)) out.push(`kind ${row.id}: unit ${u.code} needs a factor greater than 0`);
      if (u.offset !== undefined && !Number.isFinite(u.offset)) out.push(`kind ${row.id}: unit ${u.code} has an offset that isn't a number`);
      const owner = codes.get(u.code);
      if (owner !== undefined && owner !== row.id) out.push(`unit ${u.code} is listed by ${owner} and ${row.id}`);
      codes.set(u.code, row.id);
    }
  }
  return out;
}

/** How a reader sees a stored kind id. */
export type UnitKindReading =
  | { readonly status: "known"; readonly kind: UnitKindDef; readonly dimension: Dimension }
  | { readonly status: "needs_addon"; readonly id: string; readonly words: string }
  | { readonly status: "unreadable"; readonly id: string; readonly words: string };

/**
 * The kinds of one pack set: the built-in rows plus the add-ons' (`set.items(UNIT_KIND_POINT)`
 * gives both). Built once per set; lookups are map reads.
 */
export class UnitKindTable {
  private readonly kinds = new Map<string, { readonly def: UnitKindDef; readonly dimension: Dimension; readonly units: ReadonlyMap<string, UnitKindUnitDef> }>();

  constructor(rows: readonly UnitKindDef[] = builtinUnitKindRows()) {
    const addons = rows.filter((r) => !isKind(r.id));
    const problems = unitKindRowProblems(addons);
    if (problems.length > 0) throw new UnitError("unknown_kind", `These quantity kinds can't be used: ${problems.join("; ")}.`);
    for (const row of [...builtinUnitKindRows(), ...addons]) {
      if (this.kinds.has(row.id)) continue;
      this.kinds.set(row.id, { def: row, dimension: dim(row.dimension), units: new Map(row.units.map((u) => [u.code, u])) });
    }
  }

  /** Every kind, built in first. */
  all(): readonly UnitKindDef[] {
    return [...this.kinds.values()].map((k) => k.def);
  }

  kind(id: string): UnitKindDef | null {
    return this.kinds.get(id)?.def ?? null;
  }

  /** Tolerant: a known kind, an add-on's kind whose add-on isn't here (kept as stored), or a value that isn't a kind id. */
  read(id: string): UnitKindReading {
    const k = this.kinds.get(id);
    if (k) return { status: "known", kind: k.def, dimension: k.dimension };
    if (isUnitKindId(id)) return { status: "needs_addon", id, words: `${id} (a quantity kind from the ${id.split(".")[0] ?? ""} add-on, which this model doesn't have; kept as stored)` };
    return { status: "unreadable", id, words: `"${id}" isn't a quantity kind` };
  }

  unitAllowed(kindId: string, unit: string): boolean {
    return this.kinds.get(kindId)?.units.has(unit) ?? false;
  }

  /** The unit a kind displays in when nothing says otherwise. */
  defaultUnit(kindId: string): UnitKindUnitDef | null {
    return this.kinds.get(kindId)?.def.units[0] ?? null;
  }

  private unitOf(kindId: string, unit: string): UnitKindUnitDef {
    const k = this.kinds.get(kindId);
    if (!k) throw new UnitError("unknown_kind", this.read(kindId).status === "needs_addon" ? `${kindId} comes from an add-on this model doesn't have.` : `"${kindId}" is not a known kind of quantity.`);
    const u = k.units.get(unit);
    if (!u) throw new UnitError("unit_not_in_kind", `${k.def.label} can't be written in "${unit}". Use ${k.def.units.map((x) => x.symbol || x.code).join(", ")}.`);
    return u;
  }

  /** `value` written in `unit` → coherent SI for the kind. */
  toSI(kindId: string, value: number, unit: string): number {
    if (!Number.isFinite(value)) throw new UnitError("not_finite", `${this.kind(kindId)?.label ?? kindId} must be a finite number, got ${value}.`);
    const u = this.unitOf(kindId, unit);
    return value * u.factor + (u.offset ?? 0);
  }

  fromSI(kindId: string, si: number, unit: string): number {
    const u = this.unitOf(kindId, unit);
    return (si - (u.offset ?? 0)) / u.factor;
  }

  /** Between two units of one kind (never across kinds, even of one dimension). */
  convert(kindId: string, value: number, from: string, to: string): number {
    return this.fromSI(kindId, this.toSI(kindId, value, from), to);
  }

  /** Two kinds' dimensions agree (for a formula that multiplies or compares them). */
  sameDimension(a: string, b: string): boolean {
    const ka = this.kinds.get(a);
    const kb = this.kinds.get(b);
    return ka !== undefined && kb !== undefined && sameDimension(ka.dimension, kb.dimension);
  }

  describeDimension(kindId: string): string {
    const k = this.kinds.get(kindId);
    return k ? describeDimension(k.dimension) : "unknown";
  }

  /** Total values held in coherent SI by the kind's rule (or `rule`, when the kind allows it). Null when the rule is `none` or nothing was given. */
  aggregate(kindId: string, values: readonly number[], rule?: AggregationRule): number | null {
    const k = this.kinds.get(kindId);
    if (!k) throw new UnitError("unknown_kind", `"${kindId}" is not a known kind of quantity.`);
    const r = rule ?? k.def.aggregation.default;
    if (!k.def.aggregation.allowed.includes(r)) throw new UnitError("aggregation_refused", `${k.def.label} values can't be totalled with "${r}". Allowed: ${k.def.aggregation.allowed.join(", ")}.`);
    if (r === "none" || values.length === 0) return null;
    if (r === "sum") return values.reduce((a, b) => a + b, 0);
    return r === "max" ? Math.max(...values) : Math.min(...values);
  }

  /** "12.5 sabin" in the kind's unit, `digits` decimals (add-on kinds; built-in kinds format through display profiles). */
  format(kindId: string, si: number, unit?: string, digits = 2): string {
    const u = unit ? this.unitOf(kindId, unit) : this.defaultUnit(kindId);
    if (!u) throw new UnitError("unknown_kind", `"${kindId}" is not a known kind of quantity.`);
    const v = (si - (u.offset ?? 0)) / u.factor;
    return `${v.toFixed(digits)}${u.symbol ? ` ${u.symbol}` : ""}`;
  }
}

let defaultTable: UnitKindTable | null = null;

/** Read a stored kind id with the built-in kinds only, or with `table` (a pack set's). Never throws. */
export function readUnitKind(id: string, table?: UnitKindTable): UnitKindReading {
  defaultTable ??= new UnitKindTable();
  return (table ?? defaultTable).read(id);
}
