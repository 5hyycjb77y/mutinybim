import { z } from "zod";
import type { ModelElementBase } from "../types";
import { withConnectionFieldDefaults, type ConnectionTypeFields } from "./connection-field-point";
import { quantityBagSchema } from "../quantities";

export { ELECTRICAL_LOAD_CLASSES, type ElectricalLoadClass } from "./load-classes";

/**
 * The project's service catalog, for every trade: records engineers author
 * once and the model refers to by name.
 *
 * The kernel keeps the reader (`model.ts`) and two record types every trade
 * shares:
 * - **Connection type**: a symbol designator ("E.05", "P01", "K07") with what
 *   is connected there, one equipment-list row for every trade (a fryer's
 *   power, fuel input and waste on one record). Parts and load points name
 *   it, so editing the record updates everything using it.
 * - **Load allocation policy**: how estimates count once real loads exist.
 *
 * Every other record type is an add-on's row (`CATALOG_ENTRY_POINT`, contract
 * 1.10.0): its schema, how its name is read and what names it. Each record is
 * one model element of kind `service_catalog`, so it syncs, undoes and
 * conflicts like everything else. Ids come from the record's key
 * (`etype:<prefix>:<NAME>`), so finding one by name never scans the model.
 */

const text = (max: number) => z.string().trim().max(max);
const key = (max: number) => z.string().trim().min(1).max(max);

/** Which trade a connection type belongs to: where its pickers list it. One record may still carry another trade's values (a dishwasher: hot water, waste and 120 V). */
export const CATALOG_TRADES = ["electrical", "plumbing", "gas", "mechanical"] as const;
export type CatalogTrade = (typeof CATALOG_TRADES)[number];

/**
 * A connection type for any trade. Records written before trades existed have
 * no `trade` and no `quantities` and read as the first trade
 * (`connectionTypeTrade`). A trade's own fields (a rated load, its class) are
 * an add-on's rows (`CONNECTION_FIELD_POINT`): kept as stored, filled with the
 * row's default on save (`withConnectionFieldDefaults`), never named here.
 */
const connectionTypeCoreSchema = z.object({
  type: z.literal("connection_type"),
  /** The symbol designator drawn beside the device ("E.05", "P01", "K07"). */
  designator: key(20),
  /** Absent: the first trade (records saved before trades). */
  trade: z.enum(CATALOG_TRADES).optional(),
  /** What it serves: "Reach-in freezer", "Water closet, flush tank". */
  description: text(120).default(""),
  /** How it connects: "5-20R receptacle", "Hardwired via junction box". */
  connection: text(60).default(""),
  poles: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  continuous: z.boolean().default(false),
  /** For a motor load: horsepower, so its full-load current comes from the code tables when no VA is given. */
  motorHp: z.number().positive().max(1000).optional(),
  comments: text(200).default(""),
  /** Other quantities (quantities/): units, gph, input, flow, connection sizes, the engineer's own parameters. */
  quantities: quantityBagSchema.optional(),
});
/** The shared fields read strictly; every other field kept as sent (an add-on's, checked by its row on save). */
export const connectionTypeObjectSchema = connectionTypeCoreSchema.loose();

/** A stored connection type: the shared fields, plus the fields add-ons declare (`ConnectionTypeFields`), filled on save. */
export type ConnectionTypeEntry = z.output<typeof connectionTypeObjectSchema> & ConnectionTypeFields;

/**
 * Reads a connection type, filling each add-on field in force from its row.
 * A field whose add-on isn't in force stays absent, so a reader that can meet
 * such a record reads the field through `connectionFieldValue`.
 */
export const connectionTypeSchema = connectionTypeObjectSchema.transform((value) => withConnectionFieldDefaults(value) as ConnectionTypeEntry);
export type ConnectionTypeInput = z.input<typeof connectionTypeCoreSchema> & Partial<ConnectionTypeFields>;

/** What `save_connection_type` takes: only the designator is required; the kernel fills a trade's unused fields with their defaults. */
export const connectionTypeSaveSchema = connectionTypeCoreSchema.omit({ type: true }).partial().required({ designator: true }).loose();

export function connectionTypeTrade(entry: { readonly trade?: CatalogTrade }): CatalogTrade {
  return entry.trade ?? CATALOG_TRADES[0];
}

/**
 * How estimates count once real loads exist inside them (requirements/types.ts
 * `AllocationPolicy`): one record per model, every trade. Absent: the firm
 * default (`max`: an estimate counts until the real loads inside it add up to more).
 */
export const loadPolicyEntrySchema = z.object({
  type: z.literal("load_policy"),
  name: key(40),
  policy: z.enum(["max", "actual_only", "allocation_only"]),
});
export type LoadPolicyEntry = z.infer<typeof loadPolicyEntrySchema>;

/**
 * Stored record types by id. The kernel's two are here; an add-on that
 * registers a record type adds its entry type with a module augmentation
 * (`declare module "@permitzip/bim-kernel" { interface CatalogEntryTypes { … } }`),
 * so typed reads (`catalogRecords(model, "<type>")`) narrow without the
 * kernel naming the add-on.
 */
export interface CatalogEntryTypes {
  connection_type: ConnectionTypeEntry;
  load_policy: LoadPolicyEntry;
}

export type CatalogEntryType = keyof CatalogEntryTypes & string;
export type CatalogEntry = CatalogEntryTypes[CatalogEntryType];
export type CatalogEntryOf<T extends CatalogEntryType> = CatalogEntryTypes[T];

export interface ServiceCatalogElement extends ModelElementBase {
  readonly kind: "service_catalog";
  /** The record's trade as stored: a connection type's own, else what its row says. */
  readonly trade: string;
  readonly entry: CatalogEntry;
}
