import { defineExtensionPoint } from "../packs/contract";
import type { BimElement, ElementId } from "../types";

/**
 * What else a block that read an element depends on (v1), from the pack that
 * knows (a board's loads read every link it feeds). `collect` adds ids and
 * returns true when it applies; the first that applies wins, else the
 * element's type is the only extra dependency. A leaf file (no renderer
 * imports) so calculation sheets can read it without a cycle; `render.ts`
 * re-exports it.
 */
export interface BlockDependencyDef {
  readonly id: string;
  collect(elements: Readonly<Record<string, BimElement>>, id: ElementId, out: Set<ElementId>): boolean;
}

export const BLOCK_DEPENDENCY_POINT = defineExtensionPoint<BlockDependencyDef>({ id: "kernel.block_dependency", version: 1, label: "Block dependencies", idOf: (d) => d.id });
