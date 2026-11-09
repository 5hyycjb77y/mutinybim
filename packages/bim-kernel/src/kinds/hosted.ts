import { storedField } from "./index";
import type { HostedPlacement } from "./ends";
import { asElementId, type BimElement, type Vec2, type ElementId } from "../types";

/**
 * A placed hosted record as its row's `hostedBy.placement` reads it: which
 * host it hangs on, how far along that host, on which side, and where it was
 * last placed. Read by stored field name, so any add-on's hosted kind is
 * placed and spacing-checked the same way (the kernel names no such kind).
 */
export interface HostedAt {
  readonly hostId: ElementId;
  /** Distance along the host from its start. */
  readonly s: number;
  readonly side: 1 | -1;
  /** The derived position as stored. */
  readonly position: Vec2;
}

function isVec2(v: unknown): v is Vec2 {
  return typeof v === "object" && v !== null && typeof (v as { x?: unknown }).x === "number" && typeof (v as { y?: unknown }).y === "number";
}

/** `el`'s place along its host by `placement`'s fields, or null when a field isn't stored in that form (kept as stored, never placed). */
export function hostedAt(el: BimElement, placement: HostedPlacement): HostedAt | null {
  const hostId = storedField(el, placement.hostField);
  const s = storedField(el, placement.along);
  const side = storedField(el, placement.side);
  const position = storedField(el, placement.at);
  if (typeof hostId !== "string" || typeof s !== "number" || (side !== 1 && side !== -1) || !isVec2(position)) return null;
  return { hostId: asElementId(hostId), s, side, position };
}

/** `el` with its derived position kept in `placement.at`, every other field as it was (key order kept). */
export function withHostedPosition<T extends BimElement>(el: T, placement: HostedPlacement, position: Vec2): T {
  return Object.assign({}, el, { [placement.at]: position });
}
