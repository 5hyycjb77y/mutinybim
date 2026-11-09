import { elementValues } from "../store";
import type { BimElement, ElementId, ModelState } from "../types";
import { asElementId } from "../types";
import { firstPartyStoredOwner } from "../packs/first-party/manifests";
import { packNotLoadedMessage } from "../packs/set";
import { ZERO_TOTALS } from "../quantities";
import { connectionFieldRows, connectionFieldValue, withConnectionStandIns } from "./connection-field-point";
import { catalogEntryRow } from "./entry-point";
import { catalogKey } from "./kernel-rows";
import { connectionTypeTrade, type CatalogEntry, type CatalogEntryOf, type CatalogEntryType, type CatalogTrade, type ConnectionTypeEntry, type ServiceCatalogElement } from "./types";

export { catalogKey } from "./kernel-rows";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Reading the catalog: look a record up by the name the model holds, list
 * them in order. Generic over record types: each type's id prefix and how its
 * name is read come from its row (`CATALOG_ENTRY_POINT`); the kernel's own
 * rows are the connection type and the load policy.
 */

/** The id segment of a record type, from its row; throws the plain reason when no row in force reads that type. */
function prefixOf(type: string): string {
  const row = catalogEntryRow(type);
  if (row) return row.idPrefix;
  const owner = firstPartyStoredOwner("catalog", type);
  throw new Error(owner ? packNotLoadedMessage(owner) : `No add-on loaded here reads catalog records of type "${type}"`);
}

/** The element id of a record: derived from its name, so a lookup is one read. */
export function catalogElementId(type: string, name: string): ElementId {
  return asElementId(`etype:${prefixOf(type)}:${catalogKey(name)}`);
}

/** The name a record is keyed by (its row's `nameOf`); a record of a type nothing here reads gives its `name` field, else "". */
export function catalogEntryName(entry: CatalogEntry | { readonly type: string }): string {
  const row = catalogEntryRow(entry.type);
  if (row) return row.nameOf(entry);
  const name = (entry as { readonly name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

/** The record of `type` named `name`, or null. */
export function catalogEntryOf<T extends CatalogEntryType>(elements: Elements, type: T, name: string): CatalogEntryOf<T> | null {
  if (name.trim() === "") return null;
  const el = elements[catalogElementId(type, name)];
  return el?.kind === "service_catalog" && el.entry.type === type ? (el.entry as CatalogEntryOf<T>) : null;
}

export function connectionTypeOf(elements: Elements, designator: string): ConnectionTypeEntry | null {
  return catalogEntryOf(elements, "connection_type", designator);
}

export interface CatalogRecord<E = CatalogEntry> {
  readonly id: ElementId;
  readonly entry: E;
}

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

const recordCache = new WeakMap<object, ReadonlyMap<string, readonly CatalogRecord[]>>();

function allRecords(elements: Elements): ReadonlyMap<string, readonly CatalogRecord[]> {
  const known = recordCache.get(elements);
  if (known) return known;
  const by = new Map<string, CatalogRecord[]>();
  for (const el of elementValues(elements)) {
    if (el.kind !== "service_catalog") continue;
    // A record type nothing here reads (an add-on not loaded, a newer build) is kept as stored and listed under its type.
    const list = by.get(el.entry.type);
    if (list) list.push({ id: el.id, entry: el.entry });
    else by.set(el.entry.type, [{ id: el.id, entry: el.entry }]);
  }
  for (const list of by.values()) list.sort((a, b) => compare(catalogEntryName(a.entry), catalogEntryName(b.entry)));
  recordCache.set(elements, by);
  return by;
}

const NONE: readonly CatalogRecord[] = [];

/** Every record of one type, by name (numbers in natural order: F100 before F1000). One scan per model state, then cached. */
export function catalogRecords<T extends CatalogEntryType>(model: Pick<ModelState, "elements">, type: T): readonly CatalogRecord<CatalogEntryOf<T>>[] {
  return (allRecords(model.elements).get(type) ?? NONE) as readonly CatalogRecord<CatalogEntryOf<T>>[];
}

export const connectionTypes = (model: Pick<ModelState, "elements">) => catalogRecords(model, "connection_type");

/** Connection types a trade's picker lists (records saved before trades read as the first trade). */
export function connectionTypesOfTrade(model: Pick<ModelState, "elements">, trade: CatalogTrade): readonly CatalogRecord<ConnectionTypeEntry>[] {
  return connectionTypes(model).filter((r) => connectionTypeTrade(r.entry) === trade);
}

export function isCatalogElement(el: BimElement | undefined): el is ServiceCatalogElement {
  return el?.kind === "service_catalog";
}

/** A connection type's load summary: "120 V, 1 pole, 1,320 VA" (the potential and the load from the fields that stand for them, when in force). */
export function connectionTypeSummary(entry: ConnectionTypeEntry): string {
  const poles = entry.poles === 1 ? "1 pole" : entry.poles === 2 ? "2 poles" : "3-phase";
  const va = withConnectionStandIns(entry, ZERO_TOTALS).va;
  const load = va > 0 ? `${Math.round(va).toLocaleString("en-US")} VA` : entry.motorHp ? `${entry.motorHp} hp` : "no load";
  const potential = connectionFieldRows().find((r) => r.valueType === "number" && r.unit === "V");
  const v = potential ? connectionFieldValue(entry, potential.key) : null;
  return `${typeof v === "number" ? `${v} V, ` : ""}${poles}, ${load}`;
}
