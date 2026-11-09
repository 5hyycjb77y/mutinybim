import { z } from "zod";
import { ELECTRICAL_LOAD_CLASSES, connectionTypeObjectSchema, type CatalogEntryTypeRow } from "@permitzip/bim-kernel";
import { CIRCUIT_TEMPLATE_ROW, circuitTemplateSchema, type CircuitTemplateEntry } from "./circuit-templates";
import { DEFAULT_LOAD_CLASS, DEFAULT_LOAD_VA, DEFAULT_VOLTAGE, MAX_LOAD_VA, MAX_VOLTAGE } from "./connection-fields";
import { FEEDER_TYPE_ROW, feederTypeSchema, type FeederTypeEntry } from "./feeder-types";
import { DRAFTING_STANDARD_ROW, draftingStandardSchema, type DraftingStandardEntry } from "./drafting-standard";

export * from "./circuit-templates";
export * from "./connection-fields";
export * from "./feeder-types";
export * from "./drafting-standard";

/**
 * Electrical's catalog record types (`CATALOG_ENTRY_POINT`, round 12): feeder
 * types and room templates. Typed reads narrow through the kernel's
 * `CatalogEntryTypes`, which this add-on extends.
 */
declare module "@permitzip/bim-kernel" {
  interface CatalogEntryTypes {
    feeder_type: FeederTypeEntry;
    circuit_template: CircuitTemplateEntry;
    electrical_drafting: DraftingStandardEntry;
  }
}

export const ELECTRICAL_CATALOG_ROWS: readonly CatalogEntryTypeRow[] = [FEEDER_TYPE_ROW, CIRCUIT_TEMPLATE_ROW, DRAFTING_STANDARD_ROW];

/** Poles a connection type's load takes (Electrical's reading of the shared record). */
export const CONNECTION_TYPE_POLES = [1, 2, 3] as const;

/** A connection type with Electrical's fields read strictly and filled with this add-on's defaults (the same values its rows give). */
const electricalConnectionTypeSchema = connectionTypeObjectSchema.extend({
  loadVa: z.number().min(0).max(MAX_LOAD_VA).default(DEFAULT_LOAD_VA),
  voltage: z.number().positive().max(MAX_VOLTAGE).default(DEFAULT_VOLTAGE),
  loadClass: z.enum(ELECTRICAL_LOAD_CLASSES).default(DEFAULT_LOAD_CLASS),
});

/** The records the Electrical types dialog and the electrical agent tool edit. */
export const electricalCatalogEntrySchema = z.discriminatedUnion("type", [electricalConnectionTypeSchema, feederTypeSchema, circuitTemplateSchema, draftingStandardSchema]);
