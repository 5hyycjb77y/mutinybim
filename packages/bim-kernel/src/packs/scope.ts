/**
 * Which pack set is in force while kernel code runs.
 *
 * A host binds each open model to its set (`bindModelPacks`); the edit
 * spine, derived passes, lint and schedules run inside `withModelPacks`.
 * Code that reads an extension point calls `activePackSet()`. The scope is
 * synchronous on purpose: the kernel never awaits, and a callback that
 * returns a promise is refused, because the set would be gone by the time
 * the promise resolved.
 *
 * Outside any scope the built-in set is in force, which is exactly the
 * behaviour before packs existed.
 */
import { BUILTIN_PACK_SET, type PackSet } from "./set";
import type { ModelState } from "../types";

let current: PackSet | null = null;
const byModel = new Map<string, PackSet>();

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && "then" in value && typeof (value as { then: unknown }).then === "function";
}

/** Run `fn` with `set` in force; `null` keeps whatever is in force now. */
export function withPackSet<R>(set: PackSet | null | undefined, fn: () => R): R {
  if (!set || set === current) return fn();
  const previous = current;
  current = set;
  try {
    const result = fn();
    if (isThenable(result)) {
      const message = "[bim-kernel/packs] withPackSet callback returned a promise; the pack scope is synchronous. Re-enter withPackSet after each await.";
      console.error(message);
      throw new Error(message);
    }
    return result;
  } finally {
    current = previous;
  }
}

/** The set in force: the innermost scope's, else built-ins only. */
export function activePackSet(): PackSet {
  return current ?? BUILTIN_PACK_SET;
}

/** Bind an open model to its set. Rebinding replaces it. */
export function bindModelPacks(modelId: string, set: PackSet): void {
  byModel.set(modelId, set);
}

/** Forget a model's set when the host closes it. */
export function unbindModelPacks(modelId: string): void {
  byModel.delete(modelId);
}

/** The set bound to a model, or null when none is. */
export function modelPackSet(modelId: string): PackSet | null {
  return byModel.get(modelId) ?? null;
}

/** Run `fn` with the model's bound set in force (built-ins when none is bound). */
export function withModelPacks<R>(modelId: string, fn: () => R): R {
  return withPackSet(byModel.get(modelId) ?? null, fn);
}

/** What a model-state binder reads: the model's id, settings and records (its setup entries live there). */
export type ModelPackState = Pick<ModelState, "modelId" | "settings" | "elements" | "connections">;

/**
 * Resolves the set a model state uses from the state itself (round 8: its
 * stored add-on switches and pinned firm disciplines travel in changesets).
 * Returns null for a state it has nothing to say about (no setup entries),
 * which keeps whatever the host bound by id. The host registers one
 * (`organization/setup.ts` `createModelStateBinder` over its installed packs).
 */
export type ModelStateBinder = (model: ModelPackState) => PackSet | null;

let stateBinder: ModelStateBinder | null = null;

/** Register the host's model-state binder; returns the undo (restores the previous one). */
export function setModelStateBinder(binder: ModelStateBinder | null): () => void {
  const previous = stateBinder;
  stateBinder = binder;
  return () => {
    stateBinder = previous;
  };
}

/** The set this model state resolves to: the binder's answer, else what is bound to its id, else null (built-ins). */
export function modelStatePackSet(model: ModelPackState): PackSet | null {
  return stateBinder?.(model) ?? byModel.get(model.modelId) ?? null;
}

/**
 * Run `fn` with the set this model state resolves to. Unlike
 * `withModelPacks(id)`, a command that just switched an add-on on is seen by
 * the very next command on the resulting state, with no host rebind. Does not
 * rebind the id (a preview of a switch must not leak into reads of the head);
 * hosts rebind on commit (`bindModelPacks`).
 */
export function withModelStatePacks<R>(model: ModelPackState, fn: () => R): R {
  return withPackSet(modelStatePackSet(model), fn);
}
