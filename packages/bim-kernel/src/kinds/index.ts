import { peerReads } from "../elements/feature";
import { registerSchemaStep, schemaSteps } from "../schema-version/registry";
import { KINDS_ADDON_OWNED_FEATURE, elementKindTable, type ElementKindItem, type ElementKindTable, type ElementKindValue } from "../registry/element-kind-point";
import type { BimElement, ParamValue } from "../types";

/**
 * Reading and writing the values add-on-owned kinds keep (`ELEMENT_KIND_POINT`),
 * by parameter key, in either stored form:
 *
 * - **flat**: the field records written before contract 1.7.0 store it under
 *   (the row's `stored` name). Every old model is in this form, and every
 *   record stays in it while any peer lacks `kinds:addon_owned`.
 * - **parameter**: `values[key]`, written by the upgrade on edit
 *   (`schema-version/upgrade.ts`) once every peer reads it.
 *
 * Readers accept both on every record, so a model opens identically whatever
 * mix it holds. Writers keep a record in the form it is in; only the gated
 * upgrade moves it.
 */

/** Any stored record, read by field name without assuming its kind's shape. */
type AnyRecord = { readonly [field: string]: unknown };

function asAnyRecord(el: object): AnyRecord {
  return el as AnyRecord;
}

/** A record's own field, as stored, without assuming its shape. Records are plain parsed objects, so a plain read is an own read (a hot path: no `hasOwnProperty`). */
export function storedField(el: object, name: string): unknown {
  return asAnyRecord(el)[name];
}

/** `field` on `el` as stored when `el`'s kind row marks that shape field authored (`KindShapeField.authored`); undefined otherwise, so the caller's other fields answer. */
export function authoredShapeField(el: BimElement, field: string, table: ElementKindTable = elementKindTable()): unknown {
  const f = table.row(el.kind)?.shape?.fields.find((x) => x.name === field);
  return f?.authored === true ? storedField(el, field) : undefined;
}

/** A record as stored before contract 1.7.0: its kind's shape plus the flat fields its add-on reads (the demo and scale models are written this way). */
export type StoredRecord<T extends BimElement> = T & { readonly [flatField: string]: unknown };

/** `el`, written in the stored form older peers keep (flat fields beside the kind's shape), with its key order as written. */
export function storedRecord<T extends BimElement>(el: StoredRecord<T>): T {
  return el;
}

/** A record's parameter values (`values`), or undefined when it keeps none. */
function parameterValues(el: BimElement): Readonly<Record<string, ParamValue>> | undefined {
  const v = asAnyRecord(el).values;
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Readonly<Record<string, ParamValue>>) : undefined;
}

function applies(value: ElementKindValue, el: BimElement): boolean {
  return value.appliesTo === undefined || value.appliesTo(el);
}

/** The value `key` on `el`, read from either stored form; null when its kind's row keeps no such value, or this record doesn't. */
export function kindValue(el: BimElement, key: string, table: ElementKindTable = elementKindTable()): number | null {
  const value = table.valueOf(el.kind, key);
  if (!value || value.key !== key || !applies(value, el)) return null;
  return readKindValue(el, value);
}

/** `spec`'s value on `el`, from either stored form (no row lookup: for an add-on reading its own values on a hot path). */
export function readKindValue(el: BimElement, value: ElementKindValue): number | null {
  const rec = asAnyRecord(el);
  if (value.stored !== undefined) {
    // Most stored records are still in the flat form: read it first.
    const s = rec[value.stored];
    if (typeof s === "number") return s;
  }
  const values = rec.values;
  if (typeof values === "object" && values !== null) {
    const p = (values as AnyRecord)[value.key];
    if (typeof p === "number") return p;
  }
  return null;
}

/** The headline value of `el`'s kind (its row's first value) and how it reads; null when it has none or this record keeps none. */
export function headlineKindValue(el: BimElement, table: ElementKindTable = elementKindTable()): { readonly value: number; readonly spec: ElementKindValue } | null {
  const spec = table.row(el.kind)?.values?.find((v) => applies(v, el));
  if (!spec) return null;
  const value = readKindValue(el, spec);
  return value === null ? null : { value, spec };
}

/** True when `el` keeps `key` in the parameter form. */
function inParameterForm(el: BimElement, key: string): boolean {
  const values = parameterValues(el);
  return values !== undefined && Object.prototype.hasOwnProperty.call(values, key);
}

/**
 * `el` keeping `value` under `key`, in the form the record is already in.
 * A record that keeps it in neither form (a new one) takes the parameter
 * form when the peers read it, else the flat field. Throws when the kind's
 * row keeps no such value on this record.
 */
export function withKindValue<T extends BimElement>(el: T, key: string, value: number, table: ElementKindTable = elementKindTable()): T {
  const spec = table.valueOf(el.kind, key);
  if (!spec || spec.key !== key || !applies(spec, el)) {
    const message = `[bim-kernel/kinds] a ${el.kind} doesn't keep ${key}`;
    console.error(message, { id: el.id });
    throw new Error(message);
  }
  return writeKindValue(el, spec, value);
}

/** `el` keeping `value` for `spec`, in the form the record is in (no row lookup; see `withKindValue`). */
export function writeKindValue<T extends BimElement>(el: T, spec: ElementKindValue, value: number): T {
  const flat = spec.stored;
  const useParameter = inParameterForm(el, spec.key) || flat === undefined || (storedField(el, flat) === undefined && peerReads(KINDS_ADDON_OWNED_FEATURE));
  if (useParameter) return Object.assign({}, el, { values: { ...(parameterValues(el) ?? {}), [spec.key]: value } });
  return Object.assign({}, el, { [flat]: value });
}

/**
 * The value an intent or an authored write names by `field` (the flat name
 * stored in old changesets, or the parameter key). Undefined when
 * `field` isn't a value of `el`'s kind, so the caller's other fields answer.
 */
export function kindFieldValue(el: BimElement, field: string, table: ElementKindTable = elementKindTable()): number | undefined {
  const spec = table.valueOf(el.kind, field);
  if (!spec || !applies(spec, el)) return undefined;
  return readKindValue(el, spec) ?? undefined;
}

/** `el` with every value its row keeps moved from the flat field into `values` (the upgrade on edit). Records already lifted, or with nothing to lift, come back unchanged. */
export function liftKindRecord(el: BimElement, row: ElementKindItem): BimElement {
  let values: Record<string, ParamValue> | null = null;
  const drop: string[] = [];
  for (const spec of row.values ?? []) {
    if (spec.stored === undefined || !applies(spec, el)) continue;
    const s = storedField(el, spec.stored);
    if (typeof s !== "number") continue;
    values ??= { ...(parameterValues(el) ?? {}) };
    if (!Object.prototype.hasOwnProperty.call(values, spec.key)) values[spec.key] = s;
    drop.push(spec.stored);
  }
  if (values === null) return el;
  const out: Record<string, unknown> = { ...el, values };
  for (const name of drop) delete out[name];
  return out as unknown as BimElement;
}

/** `el` as an older peer stores it: every parameter value its row has a flat field for, back in that field. The reverse of `liftKindRecord`. */
export function lowerKindRecord(el: BimElement, row: ElementKindItem): BimElement {
  const values = parameterValues(el);
  if (!values) return el;
  const rest: Record<string, ParamValue> = { ...values };
  const flat: Record<string, number> = {};
  for (const spec of row.values ?? []) {
    const v = rest[spec.key];
    if (spec.stored === undefined || typeof v !== "number") continue;
    flat[spec.stored] = v;
    delete rest[spec.key];
  }
  if (Object.keys(flat).length === 0) return el;
  const out: Record<string, unknown> = { ...el, ...flat };
  if (Object.keys(rest).length > 0) out.values = rest;
  else delete out.values;
  delete out.schemaVersion;
  return out as unknown as BimElement;
}

/** Whether `el` holds a flat field its row would lift (a record still at the first schema version). */
function holdsFlatValue(el: BimElement, row: ElementKindItem): boolean {
  return (row.values ?? []).some((spec) => spec.stored !== undefined && applies(spec, el) && typeof storedField(el, spec.stored) === "number");
}

/** The schema step that lifts a kind's flat values into its parameters on edit, written only once every peer reads `kinds:addon_owned`. */
export const KIND_LIFT_STEP = "kinds:lift_values";

/**
 * Register the lift for each row whose values have a flat field (at the
 * owning add-on's load, once per kind). Gated, so the feature joins
 * `gatedRecordFeatures()` and every peer that loaded the add-on advertises it.
 */
export function registerKindLiftSteps(rows: readonly ElementKindItem[]): void {
  for (const row of rows) {
    if (!(row.values ?? []).some((v) => v.stored !== undefined)) continue;
    if (schemaSteps(row.kind).some((s) => s.name === KIND_LIFT_STEP)) continue;
    registerSchemaStep({
      kind: row.kind as BimElement["kind"],
      from: 1,
      to: 2,
      name: KIND_LIFT_STEP,
      feature: KINDS_ADDON_OWNED_FEATURE,
      detect: (record) => holdsFlatValue(record, row),
      upgrade: (record) => liftKindRecord(record, row),
    });
  }
}

/** `el` as an older peer stores it, by the set's rows (unchanged when its kind is the kernel's or keeps nothing in the parameter form). */
export function lowerForOlderPeer(el: BimElement, table: ElementKindTable = elementKindTable()): BimElement {
  const row = table.row(el.kind);
  return row ? lowerKindRecord(el, row) : el;
}

/** The refusal when a command would store a record of a kind older peers don't store, and a peer lacks `kinds:addon_owned`. */
export function olderServerKindRefusal(row: ElementKindItem): string {
  return `${row.label} can't be saved yet: the model server this model is open on is an older version that doesn't store ${row.label.toLowerCase()} records. Try again once the server is updated. Nothing changed`;
}

export * from "./ends";
export * from "./anchor";
export * from "./rows";
