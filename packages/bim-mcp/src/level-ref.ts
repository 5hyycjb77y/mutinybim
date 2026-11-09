import { modelLevels, resolveLevelRef as resolveKernelLevelRef, resolveModelLevel, type Level, type ModelState } from "@permitzip/bim-kernel";

/**
 * Level inputs on the MutinyBIM tools: the kernel's one rule (id, else the
 * one level with that name, exact then loose), with the refusal pointing the
 * agent to bim_list_levels.
 */

const LIST_HINT = "bim_list_levels lists them.";

/** A level element by id or name: for edits that place on a level. */
export function resolveLevelRef(model: Pick<ModelState, "elements" | "connections">, ref: string): { readonly ok: true; readonly id: string; readonly level: Level } | { readonly ok: false; readonly message: string } {
  const found = resolveKernelLevelRef(modelLevels(model), ref);
  return found.ok ? { ok: true, id: found.level.id, level: found.level } : { ok: false, message: `${found.message} ${LIST_HINT}` };
}

/** A level by id or name, as the canonical name areas, filters, views and schedules match on. */
export function resolveAreaLevel(model: Pick<ModelState, "elements" | "connections">, ref: string): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string } {
  const found = resolveModelLevel(model, ref);
  return found.ok ? { ok: true, name: found.name } : { ok: false, message: `${found.message} ${LIST_HINT}` };
}
