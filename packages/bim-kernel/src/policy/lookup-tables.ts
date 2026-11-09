import { z } from "zod";

/**
 * Firm lookup tables (contract 1.11.0; library item type `lookup_table`).
 *
 * One library item kind for every table a firm keeps: equipment heat
 * factors, a unit-count to flow table, later structural load tables or an
 * owner's cost table. Rows by columns with units and a citation. Add-ons ship
 * no third-party table; with none set, the check that needs one says what to
 * add and never guesses.
 */

export const LOOKUP_TABLE_ITEM_TYPE = "lookup_table";

const cell = z.union([z.number(), z.string(), z.null()]);

export const lookupTableSchema = z.object({
  id: z.string().min(1),
  /** The slot a check asks for (`<pack>.<table>`, named by the add-on that reads it). */
  slot: z.string().min(1),
  name: z.string().min(1),
  columns: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), unit: z.string().optional() })).min(1),
  rows: z.array(z.array(cell)),
  citation: z.object({ source: z.string().min(1), section: z.string().optional(), edition: z.string().optional() }),
  /** Lifecycle stage ids it applies at; absent: every stage. */
  stages: z.array(z.string()).optional(),
});
export type LookupTable = z.infer<typeof lookupTableSchema>;

/** Problems with one stored table, in words (rows whose length doesn't match the columns). */
export function lookupTableProblems(table: LookupTable): string[] {
  const out: string[] = [];
  table.rows.forEach((row, i) => {
    if (row.length !== table.columns.length) out.push(`${table.name}: row ${i + 1} has ${row.length} cells, the table has ${table.columns.length} columns`);
  });
  const keys = new Set<string>();
  for (const c of table.columns) {
    if (keys.has(c.key)) out.push(`${table.name}: column ${c.key} is named twice`);
    keys.add(c.key);
  }
  return out;
}

/**
 * The table for a slot at a stage: the project's over the firm's (by slot,
 * the first that applies at the stage), or null so the caller can say what
 * to add.
 */
export function lookupTable(slot: string, stage: string | undefined, sources: { readonly project?: readonly LookupTable[]; readonly firm?: readonly LookupTable[] }): LookupTable | null {
  const applies = (t: LookupTable): boolean => t.slot === slot && (stage === undefined || t.stages === undefined || t.stages.length === 0 || t.stages.includes(stage));
  return sources.project?.find(applies) ?? sources.firm?.find(applies) ?? null;
}
