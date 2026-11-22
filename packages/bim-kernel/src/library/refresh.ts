import { canonicalJson } from "../canonical";
import { isPartModel2 } from "../part-model/schema-2";
import type { PartModelCommand } from "../part-model/commands";
import type { PartTypeDefinition } from "../parts";
import { elementsOfKind } from "../store";
import type { ModelState } from "../types";
import { builtinPartType } from "./builtin";

export interface RefreshBuiltinPartTypesOptions {
  /** Optional allow-list of built-in type IDs to refresh. Omit to check every built-in part type present in the model. */
  readonly typeIds?: readonly string[];
  /**
   * "symbols" (default): updates only the plan symbol primitives (and schema-2
   * model symbols when present) so existing parameters, defaults, geometry, and
   * connected runs are guaranteed untouched.
   * "full": replaces the entire type definition with the latest built-in entry.
   */
  readonly mode?: "symbols" | "full";
}

export interface RefreshBuiltinPartTypesResult {
  readonly command: PartModelCommand | null;
  readonly updated: readonly { readonly typeId: string; readonly familyName: string; readonly typeName: string }[];
}

function refreshedDefinition(
  stored: PartTypeDefinition,
  latest: PartTypeDefinition,
  mode: "symbols" | "full",
): PartTypeDefinition {
  if (mode === "full") return latest;
  const nextModel =
    stored.model && latest.model && isPartModel2(stored.model) && isPartModel2(latest.model)
      ? { ...stored.model, symbols: latest.model.symbols }
      : stored.model;
  return {
    ...stored,
    symbol: latest.symbol,
    ...(nextModel !== undefined ? { model: nextModel } : {}),
  };
}

/**
 * Inspect built-in `part_type` records pinned in `model` and emit one atomic
 * `save_part_types` command upgrading stale entries to the current library
 * definitions (by default symbols only, so older saved models gain upgraded
 * annotative graphics without altering parameters, geometry, or connectors).
 */
export function refreshBuiltinPartTypes(
  model: ModelState,
  opts: RefreshBuiltinPartTypesOptions = {},
): RefreshBuiltinPartTypesResult {
  const mode = opts.mode ?? "symbols";
  const filter = opts.typeIds ? new Set(opts.typeIds) : null;
  const types: { readonly typeId: string; readonly definition: PartTypeDefinition }[] = [];
  const updated: { readonly typeId: string; readonly familyName: string; readonly typeName: string }[] = [];

  for (const el of elementsOfKind(model.elements, "part_type")) {
    if (filter && !filter.has(el.id)) continue;
    const latest = builtinPartType(el.id);
    if (!latest) continue;
    const nextDef = refreshedDefinition(el.definition, latest.definition, mode);
    if (canonicalJson(el.definition) === canonicalJson(nextDef)) continue;
    types.push({ typeId: el.id, definition: nextDef });
    updated.push({ typeId: el.id, familyName: nextDef.familyName, typeName: nextDef.typeName });
  }

  if (types.length === 0) return { command: null, updated: [] };
  const label =
    mode === "symbols"
      ? `Refresh ${types.length} built-in part ${types.length === 1 ? "symbol" : "symbols"}`
      : `Refresh ${types.length} built-in part ${types.length === 1 ? "type" : "types"}`;
  return {
    command: { type: "save_part_types", label, types },
    updated,
  };
}
