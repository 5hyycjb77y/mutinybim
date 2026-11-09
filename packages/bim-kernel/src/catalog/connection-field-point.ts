import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { QuantityKey, QuantityTotals } from "../quantities";

/**
 * Connection fields (contract 1.11.0, `kernel.connection_field` v1).
 *
 * The connection type in the core is trade-neutral. An add-on adds its
 * fields to it (a load, a load class, a rated potential; any trade's own)
 * with a default equal to what records stored before the move, so old
 * models read the same.
 */

export type ConnectionFieldValue = number | string | boolean | null;

export interface ConnectionFieldRow {
  /** `<pack>.<field>`; a first-party row moved out of the core keeps its stored key (`loadVa`). */
  readonly id: string;
  readonly label: string;
  /** The stored key on the connection record. */
  readonly key: string;
  readonly valueType: "number" | "text" | "boolean";
  /** A unit-library code for a number (`VA`, `V`). */
  readonly unit?: string;
  /** What a record with no stored value reads as. Equal to today's stored default. */
  readonly defaultValue: ConnectionFieldValue;
  /** Strict writer: why a value can't be saved, in words; null when it can. Absent: any value of `valueType`. (Additive.) */
  check?(value: ConnectionFieldValue): string | null;
  /** A number field that gives this quantity when the record's bag has none (a rated load standing in for `va`). (Additive.) */
  readonly standsFor?: QuantityKey;
  /** A text field naming the record's load kind, which estimates are matched to real loads by; `appliesTo` says for which records (all when absent). (Additive.) */
  readonly loadKind?: { appliesTo?(record: ConnectionFieldRecord): boolean };
}

/** A connection record as the point reads it: any stored fields. */
export type ConnectionFieldRecord = Readonly<Record<string, unknown>>;

/**
 * The fields an add-on adds to the connection type, for typed reads. Empty in
 * the kernel; an add-on that contributes rows declares its own with a module
 * augmentation (`declare module "@permitzip/bim-kernel" { interface
 * ConnectionTypeFields { … } }`), as `CatalogEntryTypes` is extended.
 */
export interface ConnectionTypeFields {}

export const CONNECTION_FIELD_POINT = defineExtensionPoint<ConnectionFieldRow>({
  id: "kernel.connection_field",
  version: 1,
  label: "Connection fields",
  idOf: (row) => row.id,
});

/** Problems with connection field rows (pack conformance), in words. */
export function connectionFieldRowProblems(rows: readonly ConnectionFieldRow[]): string[] {
  const out: string[] = [];
  const keys = new Map<string, string>();
  for (const row of rows) {
    if (row.label.trim().length === 0) out.push(`connection field ${row.id} has no label`);
    const held = keys.get(row.key);
    if (held !== undefined) out.push(`connection field ${row.id}: key ${row.key} is already ${held}'s`);
    keys.set(row.key, row.id);
    const d = row.defaultValue;
    const ok = d === null || (row.valueType === "number" ? typeof d === "number" && Number.isFinite(d) : row.valueType === "text" ? typeof d === "string" : typeof d === "boolean");
    if (!ok) out.push(`connection field ${row.id}: default doesn't match its ${row.valueType} type`);
    if (row.standsFor !== undefined && row.valueType !== "number") out.push(`connection field ${row.id}: only a number field can stand in for a quantity`);
    if (row.loadKind !== undefined && row.valueType !== "text") out.push(`connection field ${row.id}: only a text field can name a load kind`);
  }
  if (rows.filter((r) => r.loadKind !== undefined).length > 1) out.push("more than one connection field names the load kind");
  return out;
}

const tableOf = (set: PackSet): ReadonlyMap<string, ConnectionFieldRow> => new Map(set.items(CONNECTION_FIELD_POINT).map((r) => [r.key, r] as const));

/** The row for a stored key in the set in force. */
export function connectionFieldRow(key: string): ConnectionFieldRow | null {
  return activePackSet().memo("kernel.connection_field#byKey", tableOf).get(key) ?? null;
}

/** One field's value on a connection record: stored, else the row's default; null with no row and nothing stored. */
export function connectionFieldValue(record: Readonly<Record<string, unknown>>, key: string): ConnectionFieldValue {
  const stored = record[key];
  if (typeof stored === "number" || typeof stored === "string" || typeof stored === "boolean") return stored;
  return connectionFieldRow(key)?.defaultValue ?? null;
}

/** Every connection field the set in force adds, in row order. */
export function connectionFieldRows(): readonly ConnectionFieldRow[] {
  return [...activePackSet().memo("kernel.connection_field#byKey", tableOf).values()];
}

/**
 * The record as a writer stores it: each field in force that the record
 * doesn't carry gets its row's default (a null default stores nothing).
 * Fields no row in force reads are kept as they are.
 */
export function withConnectionFieldDefaults<T extends ConnectionFieldRecord>(record: T): T {
  const stored: ConnectionFieldRecord = record;
  let out: Record<string, unknown> | null = null;
  for (const row of connectionFieldRows()) {
    if (stored[row.key] !== undefined || row.defaultValue === null) continue;
    out ??= { ...stored };
    out[row.key] = row.defaultValue;
  }
  return out === null ? record : { ...record, ...out };
}

const typeOk = (row: ConnectionFieldRow, v: unknown): v is ConnectionFieldValue =>
  v === null || (row.valueType === "number" ? typeof v === "number" && Number.isFinite(v) : row.valueType === "text" ? typeof v === "string" : typeof v === "boolean");

/** Why a record's connection fields can't be saved, in words (each field in force, as its row checks it). */
export function connectionFieldProblems(record: ConnectionFieldRecord): string[] {
  const out: string[] = [];
  for (const row of connectionFieldRows()) {
    const v = record[row.key];
    if (v === undefined) continue;
    if (!typeOk(row, v)) {
      out.push(`${row.label} must be ${row.valueType === "number" ? "a number" : row.valueType === "text" ? "text" : "yes or no"}`);
      continue;
    }
    const problem = row.check?.(v) ?? null;
    if (problem !== null) out.push(`${row.label}: ${problem}`);
  }
  return out;
}

/** The totals with each empty quantity a field stands in for filled from the record (`standsFor`); unchanged with no such field in force. */
export function withConnectionStandIns(record: ConnectionFieldRecord, totals: QuantityTotals): QuantityTotals {
  let out: QuantityTotals = totals;
  for (const row of connectionFieldRows()) {
    if (row.standsFor === undefined || out[row.standsFor] !== 0) continue;
    const v = connectionFieldValue(record, row.key);
    if (typeof v === "number" && v > 0) out = { ...out, [row.standsFor]: v };
  }
  return out;
}

/** The record's load kind from the field that names one (`loadKind`); `applying` honours the row's `appliesTo`. Null with no such field in force. */
export function connectionLoadKind(record: ConnectionFieldRecord, applying: boolean): string | null {
  for (const row of connectionFieldRows()) {
    if (!row.loadKind) continue;
    if (applying && row.loadKind.appliesTo && !row.loadKind.appliesTo(record)) return null;
    const v = connectionFieldValue(record, row.key);
    return typeof v === "string" ? v : null;
  }
  return null;
}
