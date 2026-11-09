import { elementValues, type BimElement, type ElementId, type ConductorSet } from "@permitzip/bim-kernel";
import { defineExtensionPoint, activePackSet, type PackSet } from "@permitzip/bim-kernel/packs";

/**
 * Feeder types (F225, F100T…) as schedules and tags read them.
 *
 * The catalog itself belongs to the circuiting workstream (WS-C): what a mark
 * means (conductors, ground, conduit below and above grade) is model data it
 * owns, and this file reads it. A mark the catalog lacks is known from the
 * feeders that use it: the mark written on the feeder and the conductors
 * chosen for it. Either way, a mark given to any feeder appears in the feeder
 * schedule with no separate entry.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface FeederTypeRecord {
  readonly mark: string;
  readonly description?: string;
  readonly conductors?: ConductorSet;
  /** Raceway as written ("2-1/2\" PVC"). */
  readonly conduitBelowGrade?: string;
  readonly conduitAboveGrade?: string;
}

/** What WS-C's catalog registers: every feeder type the model defines. */
export type FeederTypeCatalogReader = (elements: Elements) => readonly FeederTypeRecord[];

/** A link-type catalog a pack reads for a model (v1). */
export interface LinkTypeCatalogRow {
  readonly id: string;
  readonly read: FeederTypeCatalogReader;
}

/**
 * Link-type catalogs (v1): what a mark means, read from model data by the
 * pack that owns the catalog. The last row in set order is in force (a
 * model's own pack overrides the first-party catalog); with
 * none, types are read from the links that use them only.
 */
export const LINK_TYPE_CATALOG_POINT = defineExtensionPoint<LinkTypeCatalogRow>({ id: "kernel.link_type_catalog", version: 1, label: "Link-type catalogs", idOf: (r) => r.id });

function catalogReader(set: PackSet): FeederTypeCatalogReader | null {
  return set.items(LINK_TYPE_CATALOG_POINT).at(-1)?.read ?? null;
}

export interface FeederTypeRow extends FeederTypeRecord {
  /** The feeders that use the mark, by id. */
  readonly feederIds: readonly ElementId[];
  /** Where the row's details come from. */
  readonly from: "catalog" | "feeders";
}

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
function rowCache(set: PackSet): WeakMap<object, readonly FeederTypeRow[]> {
  return set.memo("kernel.link_type_catalog#rows", () => new WeakMap<object, readonly FeederTypeRow[]>());
}

/**
 * Every feeder type the model uses or defines, by mark: catalog entries first
 * in detail, any mark used on a feeder that the catalog lacks taken from that
 * feeder's own conductors.
 */
export function feederTypeRows(elements: Elements): readonly FeederTypeRow[] {
  const set = activePackSet();
  const cache = rowCache(set);
  const known = cache.get(elements);
  if (known) return known;
  const used = new Map<string, { ids: ElementId[]; conductors?: ConductorSet }>();
  for (const el of elementValues(elements)) {
    if (el.kind !== "service_link" || el.trade !== "electrical" || el.role !== "feeder") continue;
    const mark = el.electrical?.feederType?.trim();
    if (!mark) continue;
    const row = used.get(mark) ?? { ids: [] };
    row.ids.push(el.id);
    if (!row.conductors && el.electrical?.conductors) row.conductors = el.electrical.conductors;
    used.set(mark, row);
  }
  const rows: FeederTypeRow[] = [];
  const seen = new Set<string>();
  for (const rec of catalogReader(set)?.(elements) ?? []) {
    if (seen.has(rec.mark)) continue;
    seen.add(rec.mark);
    rows.push({ ...rec, feederIds: used.get(rec.mark)?.ids ?? [], from: "catalog" });
  }
  for (const [mark, u] of used) {
    if (seen.has(mark)) continue;
    rows.push({ mark, ...(u.conductors ? { conductors: u.conductors } : {}), feederIds: u.ids, from: "feeders" });
  }
  rows.sort((a, b) => COLLATOR.compare(a.mark, b.mark));
  cache.set(elements, rows);
  return rows;
}

export function feederTypeByMark(elements: Elements, mark: string): FeederTypeRow | null {
  return feederTypeRows(elements).find((r) => r.mark === mark) ?? null;
}
