import { elementValues } from "../store";
import type { BimElement } from "../types";
import { loadPointFingerprint } from "../load-points/fingerprint";
import type { CatalogEntryTypeRow, CatalogEntryUse } from "./entry-point";
import { connectionFieldProblems, withConnectionFieldDefaults } from "./connection-field-point";
import { CATALOG_TRADES, connectionTypeSchema, connectionTypeTrade, loadPolicyEntrySchema, type CatalogTrade } from "./types";

const isCatalogTrade = (t: string): t is CatalogTrade => (CATALOG_TRADES as readonly string[]).includes(t);

/**
 * The kernel's own catalog record types (`CATALOG_ENTRY_POINT` built-ins):
 * the trade-neutral connection type and the load allocation policy. Their
 * type ids and id prefixes are frozen (`etype:connection:E.05`, `etype:loads:PROJECT`).
 */

/** How names compare: trimmed, single spaces, upper case ("f225 " is F225). */
export function catalogKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

const field = (entry: object, name: string): string => {
  const v = (entry as Readonly<Record<string, unknown>>)[name];
  return typeof v === "string" ? v : "";
};

/** Parts name a connection type in their `connection_type` value; load points by `connectionType`. */
function connectionTypeUses(elements: Readonly<Record<string, BimElement>>, key: string): CatalogEntryUse[] {
  const out: CatalogEntryUse[] = [];
  for (const el of elementValues(elements)) {
    if (el.kind === "part" && typeof el.values.connection_type === "string" && catalogKey(el.values.connection_type) === key) out.push({ id: el.id, name: el.mark || el.id });
    else if (el.kind === "load_point" && catalogKey(el.connectionType) === key) out.push({ id: el.id, name: el.mark ? `load point ${el.mark}` : "a load point" });
  }
  return out;
}

/** The connection type's strict writer: the shared fields, then each add-on field in force checked and filled by its row. */
const connectionTypeWriteSchema = connectionTypeSchema
  .superRefine((entry, ctx) => {
    for (const message of connectionFieldProblems(entry)) ctx.addIssue({ code: "custom", message });
  })
  .transform((entry) => withConnectionFieldDefaults(entry));

export const KERNEL_CATALOG_ROWS: readonly CatalogEntryTypeRow[] = [
  {
    type: "connection_type",
    idPrefix: "connection",
    label: "Connection type",
    schema: connectionTypeWriteSchema,
    nameOf: (entry) => field(entry, "designator"),
    trade: (entry) => {
      const t = field(entry, "trade");
      return connectionTypeTrade({ trade: isCatalogTrade(t) ? t : undefined });
    },
    references: {
      plural: "devices and load points",
      find: connectionTypeUses,
      rename: (el, name) => {
        if (el.kind === "part") return { element: { ...el, values: { ...el.values, connection_type: name } }, authored: { field: "values.connection_type", value: name } };
        if (el.kind === "load_point") {
          const next = { ...el, connectionType: name };
          return { element: next, authored: { field: "load_point", value: loadPointFingerprint(next) } };
        }
        return null;
      },
    },
  },
  // Stored before rows existed with the first trade's word; frozen.
  { type: "load_policy", idPrefix: "loads", label: "Load allocation", schema: loadPolicyEntrySchema, nameOf: (entry) => field(entry, "name"), trade: () => CATALOG_TRADES[0] },
];
