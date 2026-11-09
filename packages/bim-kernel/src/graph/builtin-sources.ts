import type { RequirementsSourceRow } from "./source";

/**
 * The built-in rows of `kernel.requirements_source`. A leaf: it imports types
 * only, so `source.ts` can name it as the point's builtins without an import
 * cycle; `sources/local.ts` registers the `local` row when it loads, and the
 * engine imports that module, so the row is there before any read.
 */

const rows = new Map<string, RequirementsSourceRow>();
/** Stable between registrations: `PackSet.items` caches by the builtins list's identity. */
let list: readonly RequirementsSourceRow[] = Object.freeze([]);

/** Register a built-in source row (re-registering the same id replaces it, so a module reloaded in tests stays single). */
export function registerBuiltinRequirementsSource(row: RequirementsSourceRow): void {
  rows.set(row.descriptor.id, row);
  list = Object.freeze([...rows.values()]);
}

/** The built-in rows, in registration order. */
export function builtinRequirementsSources(): readonly RequirementsSourceRow[] {
  return list;
}
