import { z } from "zod";
import { lookupTableSchema, type LookupTable } from "@permitzip/bim-kernel/policy";
import { ITEM_ID_PATTERN, itemBase } from "../item-base";

/**
 * The `lookup_table` library item (round 13 wave 0): one table a firm or
 * project keeps (equipment heat factors, a unit-count to flow table), rows by
 * columns with units and a citation. The body is the kernel's writer shape
 * (`lookupTableSchema`) plus the item fields; the item's `key` is the table's
 * id, so a project item with the same key replaces the firm's.
 */
export const lookupTableItemSchema = lookupTableSchema
  .omit({ id: true })
  .extend({
    ...itemBase,
    key: z.string().regex(ITEM_ID_PATTERN, "a table id such as firm:heat_factors"),
  })
  .strict();

export type LookupTableItem = z.infer<typeof lookupTableItemSchema>;

/** The table a stored item holds, as `lookupTable` reads it. */
export function lookupTableFromItem(item: LookupTableItem): LookupTable {
  return { id: item.key, slot: item.slot, name: item.name, columns: item.columns, rows: item.rows, citation: item.citation, ...(item.stages ? { stages: item.stages } : {}) };
}
