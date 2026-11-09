import { localBounds, resolveConnectors, resolveGeometry, resolveSymbol, type ResolvedConnector, type ResolvedPrimitive, type ResolvedSymbol } from "./parts";
import { mountedConnectors, mountedGeometry, mountedSymbol } from "./part-mount";
import { intakePrimitives, intakeSymbols } from "./part-model/intake-hood";
import type { PartInstance, PartTypeElement } from "./types";

/**
 * A placed part's connectors, solids and plan symbol in its own plan frame
 * (before plan rotation): the type's, with the part's mount and its hoods,
 * louvers and screens. Everything that draws or connects a placed part reads
 * these, so the live 3D, the printed drawing and routing agree.
 */

type Placed = Pick<PartInstance, "values" | "mount" | "intakes"> & Partial<Pick<PartInstance, "planned">>;

/**
 * A planned part (placement/types.ts) is not in the drawing yet: it has no
 * connectors to route to, no solids and no plan symbol until it is placed.
 */
export function placedConnectors(type: PartTypeElement, part: Placed): ResolvedConnector[] {
  if (part.planned !== undefined) return [];
  return mountedConnectors(resolveConnectors(type.definition, part.values), part.mount);
}

/** Just the hoods, louvers and screens: drawn beside a modeled part's mesh. */
export function placedIntakePrimitives(type: PartTypeElement, part: Placed): ResolvedPrimitive[] {
  return intakePrimitives(placedConnectors(type, part), part.intakes);
}

/** The part's primitives (a modeled part's feature bounds) plus its hoods, louvers and screens. */
export function placedGeometry(type: PartTypeElement, part: Placed): ResolvedPrimitive[] {
  if (part.planned !== undefined) return [];
  return [...mountedGeometry(resolveGeometry(type.definition, part.values), part.mount), ...placedIntakePrimitives(type, part)];
}

export function placedSymbol(type: PartTypeElement, part: Placed): ResolvedSymbol[] {
  if (part.planned !== undefined) return [];
  const own = resolveSymbol(type.definition, part.values);
  const bounds = part.mount === "on_side" ? localBounds(mountedGeometry(resolveGeometry(type.definition, part.values), part.mount)) : null;
  return [...mountedSymbol(own, part.mount, bounds), ...intakeSymbols(placedConnectors(type, part), part.intakes)];
}
