import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";

/**
 * Add-on library rows (contract 1.12.0, `kernel.library_rows` v1).
 *
 * An add-on contributes items to the built-in library (fields on its
 * classes, classes, schedule templates, tag types, lookup table shapes and,
 * from 1.13.0, title blocks and keynote tables) as
 * plain JSON rows. The library loads them after the kernel's own built-in
 * rows, keyed by the add-on, and drops them when the add-on is off. Item ids
 * keep whatever they were stored under (`aec:field:…`), so moving a row out
 * of the built-in bundle changes no stored id. The library package parses
 * each item with its own schema; the kernel only checks the row's shape.
 */

export const LIBRARY_ROW_SECTIONS = [
  "classes",
  "fields",
  "formulas",
  "relationships",
  "scheduleTemplates",
  "tagTypes",
  "lookupTables",
  "elementTypes",
  "designLimits",
  "titleBlocks",
  "keynoteTables",
] as const;

export type LibraryRowSection = (typeof LIBRARY_ROW_SECTIONS)[number];

export interface LibraryRow {
  /** The library section the item joins. */
  readonly section: LibraryRowSection;
  /** The library item, as the library's bundle format writes it; `id` is its stored item id. */
  readonly item: Readonly<Record<string, unknown>> & { readonly id: string };
}

/** Rows one add-on contributes, in its own order. */
export interface AddonLibraryRows {
  readonly packId: string;
  readonly rows: readonly LibraryRow[];
}

/** Advertised by the peer that loads add-on library rows (lane K14). */
export const LIBRARY_ADDON_ROWS_FEATURE = "library:addon_rows";

export const LIBRARY_ROWS_POINT = defineExtensionPoint<LibraryRow>({
  id: "kernel.library_rows",
  version: 1,
  label: "Add-on library rows",
  idOf: (row) => row.item.id,
  // Library item ids are stored (`aec:field:struct.beam.camber`); they keep their library shape.
  namespaced: false,
});

const SECTIONS: ReadonlySet<string> = new Set(LIBRARY_ROW_SECTIONS);
const ITEM_ID = /^[a-z0-9][a-z0-9_-]*:[a-z0-9_.:-]+$/;

/** Problems with library rows (pack conformance), in words. */
export function libraryRowProblems(rows: readonly LibraryRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = typeof row.item?.id === "string" ? row.item.id : "";
    if (!SECTIONS.has(row.section)) out.push(`library row ${id || "(no id)"}: "${String(row.section)}" isn't a library section (one of ${LIBRARY_ROW_SECTIONS.join(", ")})`);
    if (!ITEM_ID.test(id)) out.push(`library row "${id}": the item id must be a library id such as acme:field:camber`);
    if (seen.has(id)) out.push(`library row ${id} is contributed twice`);
    seen.add(id);
  }
  return out;
}

const byPackOf = (set: PackSet): readonly AddonLibraryRows[] => set.rowsByPack(LIBRARY_ROWS_POINT);

/** The library rows each add-on in the set in force contributes (empty with every add-on off). */
export function libraryRowsOf(): readonly AddonLibraryRows[] {
  return activePackSet().memo("kernel.library_rows#byPack", byPackOf);
}
