import { compileSnapshot } from "./compile";
import type { RequirementsSnapshot } from "./source";

/**
 * Host-bound requirements snapshots, per open model (the way `bindModelPacks`
 * binds a pack set). A host fetches a provider's rules asynchronously, then
 * binds the immutable snapshot here; the kernel's reads stay synchronous.
 * One snapshot per source id per model: binding a newer one replaces it.
 */

const byModel = new Map<string, Map<string, RequirementsSnapshot>>();
/** Bumped on every bind and unbind, so the engine can tell its cached bindings are stale with one compare. */
let generation = 0;

/** Bind (or replace) a source's snapshot on an open model. Its rules are read and compiled here, once per snapshot. */
export function bindRequirementsSnapshot(modelId: string, snapshot: RequirementsSnapshot): void {
  compileSnapshot(snapshot);
  let held = byModel.get(modelId);
  if (!held) {
    held = new Map();
    byModel.set(modelId, held);
  }
  held.set(snapshot.source.id, snapshot);
  generation += 1;
}

/** Forget one source's snapshot, or every snapshot when `sourceId` is absent (the host closed the model). */
export function unbindRequirementsSnapshot(modelId: string, sourceId?: string): void {
  const held = byModel.get(modelId);
  if (!held) return;
  if (sourceId === undefined) byModel.delete(modelId);
  else {
    held.delete(sourceId);
    if (held.size === 0) byModel.delete(modelId);
  }
  generation += 1;
}

/** The snapshots bound to a model, in bind order. */
export function boundSnapshots(modelId: string): readonly RequirementsSnapshot[] {
  const held = byModel.get(modelId);
  return held ? [...held.values()] : [];
}

/** Changes whenever any model's bindings change. */
export function snapshotGeneration(): number {
  return generation;
}
