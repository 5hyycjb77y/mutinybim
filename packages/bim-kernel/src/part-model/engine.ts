import type { ConvexPieces, SolidProgram, TriangleMesh } from "@permitzip/bim-geometry";
import { canonicalJson } from "../canonical";
import { paramValue, resolveDim, type PartTypeDefinition } from "../parts";
import type { ParamValue } from "../types";
import { resolvePartModel } from "./resolve";
import type { DetailLevel } from "./schema";
import type { AnyPartModel } from "./schema-2";

/**
 * Meshes for modeled parts. The kernel never loads the geometry engine; the
 * host (browser, worker, MCP server) registers a provider once:
 *
 *   setPartMeshProvider(new MeshCache(await loadManifoldEngine()))
 *
 * Drawing a modeled part without one throws PartGeometryUnavailableError, so
 * a missing engine shows up as an error, never as a part silently drawn as a
 * box.
 */

export interface PartMeshProvider {
  get(key: string, program: () => SolidProgram): TriangleMesh;
  /** The same solid as convex pieces (clash); `MeshCache` keeps them under the same key. */
  pieces(key: string, program: () => SolidProgram): ConvexPieces;
}

export class PartGeometryUnavailableError extends Error {
  constructor() {
    super("Modeled parts need the geometry engine, and it isn't loaded yet; call initPartGeometry() first");
    this.name = "PartGeometryUnavailableError";
  }
}

export class PartModelError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "PartModelError";
  }
}

let provider: PartMeshProvider | null = null;

export function setPartMeshProvider(next: PartMeshProvider | null): void {
  provider = next;
}

export function partGeometryReady(): boolean {
  return provider !== null;
}

const modelKeys = new WeakMap<AnyPartModel, string>();

/** The model's shape, without its types table (sizes don't change the recipe). */
function modelKey(model: AnyPartModel): string {
  const hit = modelKeys.get(model);
  if (hit !== undefined) return hit;
  const { types: _sizes, ...shape } = model;
  const key = canonicalJson(shape);
  modelKeys.set(model, key);
  return key;
}

/** Everything a modeled part's mesh depends on, as one string. Parts of the same size share it. */
export function partMeshKey(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>, detail: DetailLevel): string {
  const model = def.model;
  if (!model) throw new PartModelError(`${def.typeName} has no model`, "model");
  const resolved: Record<string, ParamValue | null> = {};
  for (const p of [...def.typeParams, ...def.instanceParams]) {
    if (p.kind === "text" || p.kind === "choice" || p.kind === "material") continue;
    resolved[p.name] = paramValue(def, values, p.name) ?? null;
  }
  return `${detail}|${modelKey(model)}|${canonicalJson(resolved)}`;
}

/** The modeled part's triangles in its local frame (millimetres). */
export function partMesh(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>> = {}, detail: DetailLevel = "fine"): TriangleMesh {
  const model = def.model;
  if (!model) throw new PartModelError(`${def.typeName} has no model`, "model");
  if (!provider) throw new PartGeometryUnavailableError();
  return provider.get(partMeshKey(def, values, detail), () => programOf(def, model, values, detail));
}

function programOf(def: PartTypeDefinition, model: AnyPartModel, values: Readonly<Record<string, ParamValue>>, detail: DetailLevel): SolidProgram {
  const resolved = resolvePartModel(model, (d) => resolveDim(def, values, d), { detail });
  const first = resolved.issues[0] ?? resolved.unloaded?.[0];
  if (first) throw new PartModelError(`${def.typeName}: ${first.message}`, first.field);
  return resolved.program;
}

/**
 * The modeled part's solid as convex pieces in its local frame (millimetres):
 * what clash reads, so something passing through a hollow body is clear. One
 * set per type + size + detail level, built only when clash asks.
 */
export function partConvexPieces(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>> = {}, detail: DetailLevel = "fine"): ConvexPieces {
  const model = def.model;
  if (!model) throw new PartModelError(`${def.typeName} has no model`, "model");
  if (!provider) throw new PartGeometryUnavailableError();
  return provider.pieces(partMeshKey(def, values, detail), () => programOf(def, model, values, detail));
}
