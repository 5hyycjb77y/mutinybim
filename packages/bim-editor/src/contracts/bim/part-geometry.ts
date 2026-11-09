import { loadManifoldEngine, MeshCache } from "@permitzip/bim-geometry";
import { elementValues, partGeometryReady, setPartMeshProvider, type ModelState } from "@permitzip/bim-kernel";

/**
 * Load the solid geometry engine once per process (browser tab, server
 * instance) and register it with the kernel, so modeled parts can draw.
 * A failed load is not cached: the next call tries again.
 */
let loading: Promise<void> | null = null;

export function initPartGeometry(): Promise<void> {
  if (partGeometryReady()) return Promise.resolve();
  loading ??= loadManifoldEngine()
    .then((engine) => setPartMeshProvider(new MeshCache(engine)))
    .catch((err: unknown) => {
      loading = null;
      console.error("[bim] geometry engine failed to load; modeled parts can't be drawn", err);
      throw err;
    });
  return loading;
}

/** Whether any part type in the model is modeled (needs the engine to draw). */
export function hasModeledParts(model: ModelState): boolean {
  for (const el of elementValues(model.elements)) if (el.kind === "part_type" && el.definition.model) return true;
  return false;
}
