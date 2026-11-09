import type { BranchRef } from "@permitzip/bim-kernel";
import { BranchRefusal, type BranchRegistry } from "../branches/registry";

/**
 * Copies of copies (product decision answer 2): "Branches start from Main" is gone. A
 * branch session asked for a new branch makes a copy of itself, through a
 * registry that records a parent copy (W11's model-server lineage rows). A
 * registry that can't yet record one refuses in the "older server" words.
 */

export const COPY_OF_COPY_UNAVAILABLE = "Copies of a copy aren't available on this model server yet: it is an older release. Start the copy from the design, or ask your administrator to update the server.";

export interface ChildLineageInput {
  /** The copy this session is on: the new copy's parent. */
  readonly parent: BranchRef;
  readonly name: string;
  /** A revision of the parent's line (its head, or a saved version). */
  readonly baseRevision: number;
  readonly createdBy: string;
}

/** A registry that records a copy's parent copy (W11 implements it on its registries). */
export interface ChildLineageRegistry {
  createChild(input: ChildLineageInput): Promise<BranchRef>;
}

export function recordsChildLineages(registry: BranchRegistry): registry is BranchRegistry & ChildLineageRegistry {
  return typeof Reflect.get(registry, "createChild") === "function";
}

/** A copy of the session's copy; refused in words when the registry can't record its parent yet. */
export async function createChildLineage(registry: BranchRegistry, input: ChildLineageInput): Promise<BranchRef> {
  if (!recordsChildLineages(registry)) throw new BranchRefusal(COPY_OF_COPY_UNAVAILABLE);
  return registry.createChild(input);
}
