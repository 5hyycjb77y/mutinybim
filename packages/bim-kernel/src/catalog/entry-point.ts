import type { z } from "zod";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import type { BimElement, ElementId } from "../types";
import type { AuthoredWrite } from "../command-core";
import { KERNEL_CATALOG_ROWS } from "./kernel-rows";

/**
 * Catalog record types (contract 1.10.0, `kernel.catalog_entry` v1).
 *
 * A catalog record is a named, shared type row in the model (`service_catalog`
 * elements: `etype:<prefix>:<NAME>`). The kernel keeps the reader (look a
 * record up by name, list them in order) and the trade-neutral connection
 * type; what each other record type holds, how its name is read and how one
 * line of it prints is the add-on's row. The stored type id and the id prefix
 * are frozen once records exist, so a row keeps both byte for byte.
 */

/** One heading a picker groups a record type's fields under ("Construction", "Rating"). */
export interface CatalogEntrySection {
  readonly id: string;
  readonly label: string;
  /** The entry's field names shown under it, in order. */
  readonly fields: readonly string[];
}

export interface CatalogEntryTypeRow {
  /** The stored record type (`entry.type`). Frozen: stored records carry it. A first-party row keeps its bare id; another add-on's is `<pack>.<name>`. */
  readonly type: string;
  /** The element id segment (`etype:<idPrefix>:<NAME>`). Frozen with `type`. Lower case letters, digits and underscores. */
  readonly idPrefix: string;
  /** What a person calls one ("Rack type"). */
  readonly label: string;
  /** Strict writer for a new or edited entry. Readers stay tolerant: a stored entry that doesn't match is kept as stored. */
  readonly schema: z.ZodType<object>;
  /** The name a record is keyed by (its designator, mark or name). */
  nameOf(entry: object): string;
  /** One line as a schedule prints it. Absent: the name. */
  summary?(entry: object): string;
  /** Field groups for pickers and property lists. Absent: one flat list. */
  readonly sections?: readonly CatalogEntrySection[];
  /** The trade word a saved record stores on its element (`ServiceCatalogElement.trade`). Frozen with `type`. Absent: "general". (Round 12, additive.) */
  trade?(entry: object): string;
  /** What names a record of this type, so a rename follows and a delete refuses while it is used. Absent: nothing names one. (Round 12, additive.) */
  readonly references?: CatalogEntryReferences;
}

/** An element that names a catalog record. */
export interface CatalogEntryUse {
  readonly id: ElementId;
  /** How a refusal names it ("MDP-1,3,5", "load point K-3"). */
  readonly name: string;
}

export interface CatalogEntryReferences {
  /** What a list of them is called in a refusal ("devices and load points"). */
  readonly plural: string;
  /** Elements naming the record whose key (`catalogKey`) is `key`, in model order. */
  find(elements: Readonly<Record<string, BimElement>>, key: string): readonly CatalogEntryUse[];
  /** `el` renamed to name the record `name`, with the value the edit authors on it (if any); null when `el` isn't one of this row's uses. */
  rename(el: BimElement, name: string): { readonly element: BimElement; readonly authored?: { readonly field: string; readonly value: AuthoredWrite["value"] } } | null;
}

export const CATALOG_ENTRY_POINT = defineExtensionPoint<CatalogEntryTypeRow>({
  id: "kernel.catalog_entry",
  version: 1,
  label: "Catalog record types",
  idOf: (row) => row.type,
  // Stored record types are bare words (`load_policy`); namespacing is checked below for other add-ons' rows.
  namespaced: false,
  builtins: () => KERNEL_CATALOG_ROWS,
});

const TYPE_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;
const PREFIX_ID = /^[a-z][a-z0-9_]*$/;

/** Problems with catalog record type rows (pack conformance), in words. */
export function catalogEntryRowProblems(rows: readonly CatalogEntryTypeRow[], reservedPrefixes: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const types = new Set<string>();
  const prefixes = new Set<string>();
  for (const row of rows) {
    if (!TYPE_ID.test(row.type)) out.push(`catalog record type "${row.type}" must be lower case words with underscores (a pack's own: <pack>.<name>)`);
    if (types.has(row.type)) out.push(`catalog record type ${row.type} is registered twice`);
    types.add(row.type);
    if (!PREFIX_ID.test(row.idPrefix)) out.push(`catalog record type ${row.type}: id prefix "${row.idPrefix}" must be lower case letters, digits and underscores`);
    if (prefixes.has(row.idPrefix) || reservedPrefixes.has(row.idPrefix)) out.push(`catalog record type ${row.type}: id prefix "${row.idPrefix}" is already taken`);
    prefixes.add(row.idPrefix);
    if (row.label.trim().length === 0) out.push(`catalog record type ${row.type} has no label`);
    if (typeof row.nameOf !== "function") out.push(`catalog record type ${row.type}: nameOf must be a function`);
    if (row.summary !== undefined && typeof row.summary !== "function") out.push(`catalog record type ${row.type}: summary must be a function`);
    if (typeof row.schema?.safeParse !== "function") out.push(`catalog record type ${row.type} has no schema`);
  }
  return out;
}

const TABLE_KEY = "kernel.catalog_entry#table";
const tableOf = (set: PackSet): ReadonlyMap<string, CatalogEntryTypeRow> => new Map(set.items(CATALOG_ENTRY_POINT).map((r) => [r.type, r] as const));

/** The row for a stored record type in the set in force, or null: that type's records are kept as stored and listed by their id. */
export function catalogEntryRow(type: string): CatalogEntryTypeRow | null {
  return activePackSet().memo(TABLE_KEY, tableOf).get(type) ?? null;
}

/** Every catalog record type the set in force reads, in row order. */
export function catalogEntryRows(): readonly CatalogEntryTypeRow[] {
  return [...activePackSet().memo(TABLE_KEY, tableOf).values()];
}
