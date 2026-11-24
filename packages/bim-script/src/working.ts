import type { ModelState } from "@permitzip/bim-kernel";
import { withPackSet, type PackSet } from "@permitzip/bim-kernel/packs";
import type { ScriptContext } from "./context";

/**
 * The working copy behind a running script's context, for the kit's own
 * helpers (documents.autoTag, documents.scheduleRows, checks.clashes…). Not
 * exported from the kit: a script reads the model through `ctx.model`, the
 * kit's planners read the whole working copy the way the editor's do.
 */

interface Working {
  readonly model: () => ModelState;
  readonly packs: PackSet | undefined;
  readonly touchedIds?: () => readonly string[];
  readonly features?: ReadonlySet<string>;
}

const WORKING = new WeakMap<ScriptContext, Working>();

export function bindWorking(ctx: ScriptContext, working: Working): void {
  WORKING.set(ctx, working);
}

export class KitContextError extends Error {
  constructor(helper: string) {
    super(`${helper} plans on the running script's model: call it with the ctx your script's run was given.`);
    this.name = "KitContextError";
  }
}

/** The script's model as it is now (its own edits included), inside the model's add-ons. */
export function onWorking<T>(ctx: ScriptContext, helper: string, read: (model: ModelState) => T): T {
  const w = WORKING.get(ctx);
  if (!w) throw new KitContextError(helper);
  return withPackSet(w.packs, () => read(w.model()));
}

/** Like `onWorking`, also supplying the element IDs created/edited so far by the running script. */
export function onWorkingWithTouched<T>(ctx: ScriptContext, helper: string, read: (model: ModelState, touchedIds: readonly string[]) => T): T {
  const w = WORKING.get(ctx);
  if (!w) throw new KitContextError(helper);
  return withPackSet(w.packs, () => read(w.model(), w.touchedIds ? w.touchedIds() : []));
}

/** Like `onWorking`, but undefined (no error) for a context with no working copy behind it (a test's hand-made one). */
export function onWorkingIfAny<T>(ctx: ScriptContext, read: (model: ModelState) => T): T | undefined {
  const w = WORKING.get(ctx);
  return w ? withPackSet(w.packs, () => read(w.model())) : undefined;
}

/** Whether the server/slice backing this script advertises a protocol feature. */
export function hasSliceFeature(ctx: ScriptContext, feature: string): boolean {
  return WORKING.get(ctx)?.features?.has(feature) ?? false;
}
