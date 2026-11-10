import type { PartTypeDefinition } from "@permitzip/bim-kernel";

/**
 * The host services the part tools need beyond the caller: the firm's own
 * part library. A host keeps it wherever it keeps firm data; the tools only
 * read one part, by its model id, to place a size of it.
 */

/** One part of the firm library: its definition, with every size in its types table. */
export interface FirmPartEntry {
  readonly definition: PartTypeDefinition;
  /**
   * Set when the part places as this one type id (a part type a script made
   * and saved to the library under its key) instead of one type per row of
   * its types table.
   */
  readonly typeId?: string;
}

/** The firm part library as the caller may read it. */
export interface FirmPartsSource {
  /** The part whose definition has this model id (or a script-made part saved under this type id), or null when the library has none. */
  get(modelId: string): Promise<FirmPartEntry | null>;
}
