import { canonicalJson } from "../canonical";
import type { RenderedBlock } from "./types";

/** The text a table-form block puts between cells (`blockTextTable` splits on it). */
export const BLOCK_TABLE_SEPARATOR = " | ";

/** The bytes a block's value hash covers: the rendered text, what didn't resolve, and the library pins. Never the revision or the dependencies. Leaf file; `render.ts` re-exports it. */
export function blockHashInput(rendered: Pick<RenderedBlock, "text" | "unresolved">, libraryPins: Readonly<Record<string, string>> = {}): string {
  return canonicalJson({ v: 1, text: rendered.text, unresolved: [...rendered.unresolved], pins: libraryPins });
}
