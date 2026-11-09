/**
 * Mesh solids merged into one draw per key (walls per level and category), so
 * a storey of joined walls is one mesh and one outline, not one per wall. Each
 * batch keeps which element every triangle belongs to, so a click on the
 * batch still picks one wall. Pure, no three.js: scene metres in and out.
 */
import type { ElementId } from "@permitzip/bim-kernel";
import type { RenderGroup, Solid } from "./native-geometry";

export interface MeshBatch {
  readonly key: string;
  readonly group: RenderGroup;
  /** World scene metres (no offset to apply). */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** The elements in this batch, in the order they were added. */
  readonly owners: readonly ElementId[];
  /** Per triangle, its owner's index in `owners`. */
  readonly triangleOwner: Uint32Array;
}

/** Whether a solid can join a batch as it is: a mesh with no turn or tilt to apply (prism solids are built in world axes). */
export function batchable(s: Solid): boolean {
  return s.shape === "mesh" && s.mesh !== undefined && s.yaw === 0 && (s.pitch ?? 0) === 0 && !s.vertical;
}

/**
 * Merge the solids `keyOf` names a key for into one batch per key; the rest
 * come back untouched. Solids of one element stay together in one batch.
 */
export function batchMeshSolids(solids: readonly Solid[], keyOf: (s: Solid) => string | null): { readonly batches: readonly MeshBatch[]; readonly rest: readonly Solid[] } {
  const groups = new Map<string, Solid[]>();
  const rest: Solid[] = [];
  for (const s of solids) {
    const key = batchable(s) ? keyOf(s) : null;
    if (key === null) {
      rest.push(s);
      continue;
    }
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const batches: MeshBatch[] = [];
  for (const [key, list] of groups) {
    const first = list[0];
    if (!first) continue;
    let vertexCount = 0;
    let indexCount = 0;
    for (const s of list) {
      vertexCount += (s.mesh?.positions.length ?? 0) / 3;
      indexCount += s.mesh?.indices.length ?? 0;
    }
    const positions = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    const triangleOwner = new Uint32Array(indexCount / 3);
    const owners: ElementId[] = [];
    const ownerIndex = new Map<ElementId, number>();
    let v = 0;
    let t = 0;
    for (const s of list) {
      const mesh = s.mesh;
      if (!mesh) continue;
      let owner = ownerIndex.get(s.elementId);
      if (owner === undefined) {
        owner = owners.length;
        owners.push(s.elementId);
        ownerIndex.set(s.elementId, owner);
      }
      const [cx, cy, cz] = s.center;
      const p = mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        positions[(v + i / 3) * 3] = (p[i] ?? 0) + cx;
        positions[(v + i / 3) * 3 + 1] = (p[i + 1] ?? 0) + cy;
        positions[(v + i / 3) * 3 + 2] = (p[i + 2] ?? 0) + cz;
      }
      const idx = mesh.indices;
      for (let i = 0; i < idx.length; i++) indices[t * 3 + i] = (idx[i] ?? 0) + v;
      for (let k = 0; k < idx.length / 3; k++) triangleOwner[t + k] = owner;
      v += p.length / 3;
      t += idx.length / 3;
    }
    batches.push({ key, group: first.group, positions, indices, owners, triangleOwner });
  }
  return { batches, rest };
}

/** The element a hit on a batch's triangle `faceIndex` belongs to, or null. */
export function batchOwnerAt(batch: Pick<MeshBatch, "owners" | "triangleOwner">, faceIndex: number | null | undefined): ElementId | null {
  if (faceIndex === null || faceIndex === undefined) return null;
  const owner = batch.triangleOwner[faceIndex];
  return owner === undefined ? null : (batch.owners[owner] ?? null);
}
