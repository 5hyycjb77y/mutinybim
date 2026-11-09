import { add, scale, sub, unit } from "./geometry";
import { networkOf } from "./network";
import { connectorEndsTable, endsKeptAsStored } from "./kinds/ends";
import { kindAnchorOf } from "./kinds/anchor";
import { kernelKindRow } from "./registry/element-kind-point";
import "./kinds/rows";
import type {
  BimElement,
  Connection,
  ConnectorEnd,
  ConnectorRef,
  ElementId,
  ModelState,
  Vec2,
  Wall,
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

  connectionsOf(id: ElementId): readonly Connection[] {
    return networkOf(this.model).connectionsOf(id);
  }

  /** The records hosted on `id` through a kind row's `hostedBy` (in index order), as the model stood when the reader was made. Not recorded as reads. */
  hostedOn(id: ElementId): readonly ElementId[] {
    return networkOf(this.model).hostedTaps(id);
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
  | "invalid_value"
  | "already_exists"
  | "has_dependents"
  | "undo_refused"
  | "in_use"
  /** The element is in a locked group. */
  | "locked";

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
  return networkOf(model).connectionAt(ref.elementId, ref.end);
}

/** World position of an element's named connector end. */
export function connectorPoint(model: ModelState, ref: ConnectorRef): Vec2 {
  const el = model.elements[ref.elementId];
  if (!el) throw new KernelError("element_not_found", `Element ${ref.elementId} does not exist`, [ref.elementId]);
  return pointOf(el, ref.end, model);
}

/** `connectorPoint` for an element already looked up. */
export function connectorPointOf(model: ModelState, el: BimElement, end: ConnectorEnd): Vec2 {
  return pointOf(el, end, model);
}

/**
 * `connectorPointOf`, or null when `el`'s kind is kept as stored (not a
 * kernel kind, and no row in force places its ends: its add-on isn't
 * loaded). Throws for any other end it can't place.
 */
export function connectorPointUnlessKept(model: ModelState, el: BimElement, end: ConnectorEnd): Vec2 | null {
  const at = connectorEndsTable().point(el, end, model.elements);
  if (at !== undefined && at !== null) return at;
  if (at === undefined && endsKeptAsStored(el.kind)) return null;
  throw noConnectors(el);
}

function noConnectors(el: BimElement): KernelError {
  return new KernelError("unsupported_geometry", `${el.id} is a ${el.kind}; it has no network connectors`, [el.id]);
}

function pointOf(el: BimElement, end: ConnectorEnd, model: ModelState): Vec2 {
  const at = connectorEndsTable().point(el, end, model.elements);
  if (at === undefined || at === null) throw noConnectors(el);
  return at;
}

/**
 * The point annotations measure from, as the element's kind row says (an
 * element's position, the midpoint of a linear element, the centroid of an
 * outline); null when it sits nowhere (views, sheets, records, a kind no row
 * in force names).
 */
export function anchorOf(el: BimElement): Vec2 | null {
  const row = kernelRowOf(el.kind);
  if (row === undefined) return addOnAnchorOf(el);
  return row.anchor === undefined ? null : row.anchor(el);
}

// Bound once: a transpiled import is read through a getter on every call, and anchorOf runs once per element on whole-model passes.
const kernelRowOf = kernelKindRow;
const addOnAnchorOf = kindAnchorOf;

/** World position of an opening's centre given its host wall and offset. */
export function openingPosition(host: Wall, offset: number): Vec2 {
  return add(host.start, scale(unit(sub(host.end, host.start)), offset));
}

export function wallLength(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
}
