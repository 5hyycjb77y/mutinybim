// Frozen copy of the kernel before the network index (as of commit b91b54f24). Equivalence reference for
// __tests__/scale-equivalence.test.ts and scripts/bench-heavy.ts only; never imported by src.
import { add, perp, scale, sub, unit } from "../../src/geometry";
import type {
  BimElement,
  Connection,
  ConnectorEnd,
  ConnectorRef,
  DuctSegment,
  ElementId,
  ModelState,
  TapFitting,
  Vec2,
} from "./types";

/**
 * Read access to a model that records every element it touches, with the
 * version seen. The trusted command registry uses this to derive the read set
 * the commit must re-verify; callers never supply it.
 */
export class TrackedReader {
  private readonly reads = new Map<ElementId, number>();

  constructor(readonly model: ModelState) {}

  get(id: ElementId): BimElement {
    const el = this.model.elements[id];
    if (!el) throw new KernelError("element_not_found", `Element ${id} does not exist`, [id]);
    this.reads.set(id, el.version);
    return el;
  }

  find(id: ElementId): BimElement | undefined {
    const el = this.model.elements[id];
    if (el) this.reads.set(id, el.version);
    return el;
  }

  connectionsOf(id: ElementId): Connection[] {
    return this.model.connections.filter((c) => c.a.elementId === id || c.b.elementId === id);
  }

  readSet(): Record<string, number> {
    return Object.fromEntries(this.reads);
  }
}

export type KernelErrorCode =
  | "element_not_found"
  | "wrong_kind"
  | "outside_host"
  | "tap_spacing"
  | "min_straight_length"
  | "anchored_would_move"
  | "unsupported_geometry"
  | "profile_incompatible"
  | "disconnected"
  | "invalid_value";

export class KernelError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    message: string,
    readonly elementIds: readonly ElementId[] = [],
  ) {
    super(message);
    this.name = "KernelError";
  }
}

export function isKind<K extends BimElement["kind"]>(
  el: BimElement,
  kind: K,
): el is Extract<BimElement, { kind: K }> {
  return el.kind === kind;
}

export function requireKind<K extends BimElement["kind"]>(
  el: BimElement,
  kind: K,
): Extract<BimElement, { kind: K }> {
  if (isKind(el, kind)) return el;
  throw new KernelError("wrong_kind", `${el.id} is a ${el.kind}, expected ${kind}`, [el.id]);
}

export function otherEnd(connection: Connection, ref: ConnectorRef): ConnectorRef {
  const isA = connection.a.elementId === ref.elementId && connection.a.end === ref.end;
  return isA ? connection.b : connection.a;
}

export function connectionAt(model: ModelState, ref: ConnectorRef): Connection | undefined {
  return model.connections.find(
    (c) =>
      (c.a.elementId === ref.elementId && c.a.end === ref.end) ||
      (c.b.elementId === ref.elementId && c.b.end === ref.end),
  );
}

/** World position of a tap's branch connector given its host and `s`. */
export function tapPosition(host: DuctSegment, tap: Pick<TapFitting, "s" | "side">): Vec2 {
  const axis = unit(sub(host.end, host.start));
  const onCentre = add(host.start, scale(axis, tap.s));
  const halfWidth = hostHalfWidth(host);
  return add(onCentre, scale(perp(axis), halfWidth * tap.side));
}

function hostHalfWidth(host: DuctSegment): number {
  return host.profile.shape === "rect" ? host.profile.width / 2 : host.profile.diameter / 2;
}

export function segmentLength(seg: DuctSegment): number {
  return Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
}

/** World position of an element's named connector end. */
export function connectorPoint(model: ModelState, ref: ConnectorRef): Vec2 {
  const el = model.elements[ref.elementId];
  if (!el) throw new KernelError("element_not_found", `Element ${ref.elementId} does not exist`, [ref.elementId]);
  return pointOf(el, ref.end, model);
}

function pointOf(el: BimElement, end: ConnectorEnd, model: ModelState): Vec2 {
  switch (el.kind) {
    case "duct_segment":
      return end === "start" ? el.start : el.end;
    case "equipment":
      return add(el.position, el.portOffset);
    case "elbow":
    case "terminal":
      return el.position;
    case "tap": {
      if (end === "branch") return el.position;
      const host = model.elements[el.hostId];
      if (!host || host.kind !== "duct_segment") return el.position;
      const axis = unit(sub(host.end, host.start));
      return add(host.start, scale(axis, el.s));
    }
  }
}
