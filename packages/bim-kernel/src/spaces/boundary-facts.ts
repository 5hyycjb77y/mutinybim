import { hostLineOf } from "../hosting/rows";
import { hostVoidRow } from "../hosting/contract";
import { hostVoidsOf, voidAreaM2 } from "../hosting/voids";
import type { PackRefusal } from "../packs/points";
import { activePackSet } from "../packs/scope";
import { RATING_KIND_POINT, ratingOf } from "../registry/rating-kind-point";
import type { BimElement, ElementId, ModelState, Vec2 } from "../types";
import { ancestorsOf } from "./nesting";
import { spaceAt } from "./space-index";
import type { Space } from "./types";

/**
 * Space boundary facts (contract 1.11.0). Each bounded space publishes its
 * edges as facts any load section, requirement input or space-type table
 * reads like any other quantity. Envelope load calculation stays outside the
 * kernel; this only says what is there.
 */

export const SPACES_BOUNDED_FEATURE = "spaces:bounded";

/** What is on the other side of one edge. */
export type BoundarySide = { readonly kind: "space"; readonly spaceId: ElementId } | { readonly kind: "outside" } | { readonly kind: "unknown" };

/** An opening hosted in a bounding element along one edge (a door, a window, a cased opening). */
export interface BoundaryOpening {
  readonly elementId: ElementId;
  /** The opening's kind row label or class label ("Door", "Window"). */
  readonly label: string;
  readonly typeId?: ElementId;
  /** m². */
  readonly areaM2: number;
  /** The hosted kind's void role: `fill` (door / window) or `open` (cased opening, shaft). */
  readonly role: "fill" | "open";
}

/** One edge of a space. */
export interface BoundaryFact {
  readonly elementId: ElementId;
  /** The bounding element's kind (`wall`, `space_separator`, an add-on's kind). */
  readonly elementKind: string;
  readonly typeId?: ElementId;
  /** mm. */
  readonly lengthMm: number;
  /** mm, level to ceiling (ceiling record, else the space's ceiling height). */
  readonly heightMm: number;
  readonly otherSide: BoundarySide;
  readonly openings: readonly BoundaryOpening[];
  /** A separation line: bounds, never built, carries no wall area. */
  readonly virtual: boolean;
  /** The bounding element's ratings by rating kind id (`fire_resistance` → 1). */
  readonly ratings: Readonly<Record<string, number>>;
}

/** Quantity keys published on a bounded space's quantity bag. */
export const BOUNDARY_QUANTITY_KEYS = {
  exteriorLength: "qto.boundary.exterior_length",
  exteriorWallArea: "qto.boundary.exterior_wall_area",
  interiorWallArea: "qto.boundary.interior_wall_area",
  windowArea: "qto.boundary.window_area",
  doorCount: "qto.boundary.door_count",
  ratedLength: "qto.boundary.rated_length",
} as const;
export type BoundaryQuantityKey = (typeof BOUNDARY_QUANTITY_KEYS)[keyof typeof BOUNDARY_QUANTITY_KEYS];

type Elements = Readonly<Record<string, BimElement>>;

/** How far past an edge to look for the room on its other side (mm): through the wall's thickness, at a few depths. */
const PROBES_MM = [60, 160, 320, 640] as const;

function numberField(el: BimElement | undefined, key: string): number | null {
  const v = el ? (el as unknown as Readonly<Record<string, unknown>>)[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function typeIdOf(el: BimElement): ElementId | undefined {
  return "typeId" in el && typeof el.typeId === "string" ? (el.typeId as ElementId) : undefined;
}

/** What is beyond one edge: the room a probe just past it lands in (not this space or one it sits inside), outside when none is, unknown off a level. */
function otherSideOf(elements: Elements, space: Space, levelId: ElementId, a: Vec2, b: Vec2): BoundarySide {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return { kind: "unknown" };
  // The outline runs counter-clockwise, so outside is to the right of each edge.
  const nx = (b.y - a.y) / len;
  const ny = -(b.x - a.x) / len;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const own = new Set<string>([space.id, ...ancestorsOf(elements, space).map((p) => p.id)]);
  for (const d of PROBES_MM) {
    const hit = spaceAt(elements, levelId, { x: mid.x + nx * d, y: mid.y + ny * d });
    if (hit && !own.has(hit.id)) return { kind: "space", spaceId: hit.id };
  }
  return { kind: "outside" };
}

/** The voids hosted in `host` whose centre lies along this edge's stretch of it. */
function openingsAlong(elements: Elements, host: BimElement, a: Vec2, b: Vec2): BoundaryOpening[] {
  const line = hostLineOf(host, elements);
  if (!line) return [];
  const len = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
  if (len === 0) return [];
  const ux = (line.end.x - line.start.x) / len;
  const uy = (line.end.y - line.start.y) / len;
  const along = (p: Vec2): number => (p.x - line.start.x) * ux + (p.y - line.start.y) * uy;
  const lo = Math.min(along(a), along(b));
  const hi = Math.max(along(a), along(b));
  return hostVoidsOf(elements, host.id).flatMap((v) => {
    const xs = v.profile.map((p) => p.x);
    const centre = (Math.min(...xs) + Math.max(...xs)) / 2;
    if (centre < lo || centre > hi) return [];
    const el = elements[v.elementId];
    if (!el) return [];
    const type = "openingType" in el && typeof el.openingType === "string" ? el.openingType : null;
    const label = type ? `${type.charAt(0).toUpperCase()}${type.slice(1)}` : (hostVoidRow(el.kind)?.label ?? el.kind.replace(/_/g, " "));
    const typeId = typeIdOf(el);
    return [{ elementId: el.id, label, ...(typeId ? { typeId } : {}), areaM2: voidAreaM2(v), role: v.role }];
  });
}

function ratingsOf(elements: Elements, el: BimElement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of activePackSet().items(RATING_KIND_POINT)) {
    const r = ratingOf(elements, el, row.id);
    if (r !== null) out[row.id] = r;
  }
  return out;
}

/** A bounded space's edges in `elements`, in outline order; empty for any other space. */
export function boundaryFactsIn(elements: Elements, space: Space): BoundaryFact[] {
  if (space.bounds.kind !== "bounded") return [];
  const { levelId, boundary } = space.bounds;
  return boundary.flatMap((ref) => {
    const el = elements[ref.elementId];
    if (!el) return [];
    const typeId = typeIdOf(el);
    const virtual = el.kind === "space_separator";
    return [
      {
        elementId: el.id,
        elementKind: el.kind,
        ...(typeId ? { typeId } : {}),
        lengthMm: Math.hypot(ref.end.x - ref.start.x, ref.end.y - ref.start.y),
        heightMm: space.ceilingHeightMm ?? numberField(el, "height") ?? 0,
        otherSide: otherSideOf(elements, space, levelId, ref.start, ref.end),
        openings: virtual ? [] : openingsAlong(elements, el, ref.start, ref.end),
        virtual,
        ratings: virtual ? {} : ratingsOf(elements, el),
      },
    ];
  });
}

/** Every record the facts read: the bounding elements and what they host. A change to any re-reads them. */
export function boundaryFactReads(elements: Elements, space: Space): string[] {
  if (space.bounds.kind !== "bounded") return [];
  const ids = new Set<string>();
  for (const ref of space.bounds.boundary) {
    ids.add(ref.elementId);
    for (const v of hostVoidsOf(elements, ref.elementId)) ids.add(v.elementId);
  }
  return [...ids];
}

/** One space's edges: what bounds it, how long and high, what is beyond, the doors and windows in it, its ratings. */
export function spaceBoundaryFacts(model: ModelState, spaceId: ElementId): readonly BoundaryFact[] | PackRefusal {
  const s = model.elements[spaceId];
  if (s?.kind !== "space") return { refused: `There is no space ${spaceId}` };
  if (s.bounds.kind !== "bounded") return { refused: `${[s.name, s.number].filter((t) => t.trim() !== "").join(" ") || spaceId} isn't bounded by walls, so it has no wall-by-wall facts. Make it from its walls (Room from walls) to get them` };
  return boundaryFactsIn(model.elements, s);
}
