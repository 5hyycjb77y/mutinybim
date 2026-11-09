import {
  ductOuterSize,
  mountedPositions,
  partConvexPieces,
  partGeometryReady,
  partLabelOf,
  partToWorld,
  placedIntakePrimitives,
  resolveGeometry,
  runLabel,
  sizeHeight,
  sizeWidth,
  widthAxisFor,
  type BimElement,
  type ModelState,
  type PartInstance,
  type PartTypeElement,
  type ResolvedPrimitive,
  type RunPoint,
  type RunSize,
} from "@permitzip/bim-kernel";
import { aabbOfPoints, boxConvex, hullConvex, loftConvex, p3, prismConvex, type Aabb, type Convex, type P3 } from "./geometry/convex";

type Elements = ModelState["elements"];

/**
 * Our elements as bodies for the clash rules: an axis-aligned box for the
 * broad phase (cheap, built for every element) and convex pieces for the
 * narrow phase (built only for candidate pairs).
 *
 * Runs use their outside envelope: the sheet-metal size plus an external
 * wrap (`ductOuterSize`), the face other work has to clear. A modeled part is
 * tested by its real solid: the convex pieces of the same mesh the screen and
 * sheets draw (`partConvexPieces`), so a pipe through an air handler's hollow
 * is clear. Its feature boxes are only the broad-phase box. Simple parts, and
 * modeled ones before the geometry engine has loaded, use their primitives.
 */

const ROUND_SIDES = 12;
/** Legacy duct and equipment with no elevation of their own sit this far above their level (as `drawing/solids.ts` draws them). */
const LEGACY_ELEVATION_MM = 9 * 304.8;
const DEFAULT_WALL_HEIGHT_MM = 10 * 304.8;
/** A run or part whose level is missing is read at project zero (validation reports the missing level). */
const ASSUMED_FLOOR_FALLBACK = 0;

export type BodyRole = "mep" | "equipment" | "architecture" | "structure";

export interface ElementShape {
  readonly role: BodyRole;
  /** Set when the element's height is assumed (a level name with no level element): it is only compared with others on that level name. */
  readonly layer?: string;
  readonly box: Aabb;
  /** Built lazily; may throw for a part whose geometry doesn't resolve (callers report it). */
  readonly pieces: () => readonly Convex[];
}

const sub3 = (a: RunPoint, b: RunPoint): RunPoint => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add3 = (a: RunPoint, b: RunPoint): RunPoint => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale3 = (a: RunPoint, k: number): RunPoint => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const len3 = (a: RunPoint): number => Math.hypot(a.x, a.y, a.z);
const cross3 = (a: RunPoint, b: RunPoint): RunPoint => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

export function levelElevation(elements: Elements, levelId: string): number {
  const level = elements[levelId];
  return level?.kind === "level" ? level.elevationMm : ASSUMED_FLOOR_FALLBACK;
}

/** A ring of a run's cross-section at `center`, facing along `along`. */
function ring(center: RunPoint, along: RunPoint, size: RunSize): P3[] {
  const t = scale3(along, 1 / Math.max(len3(along), 1e-9));
  const w = widthAxisFor(t, { x: 1, y: 0, z: 0 });
  let h = cross3(t, w);
  const hl = len3(h);
  h = scale3(h, 1 / Math.max(hl, 1e-9));
  if (h.z < 0 || (Math.abs(h.z) < 1e-9 && h.y < 0)) h = scale3(h, -1);
  const hw = sizeWidth(size) / 2;
  const hh = sizeHeight(size) / 2;
  if (size.shape === "rect") {
    return [
      add3(center, add3(scale3(w, -hw), scale3(h, -hh))),
      add3(center, add3(scale3(w, hw), scale3(h, -hh))),
      add3(center, add3(scale3(w, hw), scale3(h, hh))),
      add3(center, add3(scale3(w, -hw), scale3(h, hh))),
    ];
  }
  const out: P3[] = [];
  for (let i = 0; i < ROUND_SIDES; i++) {
    const a = (2 * Math.PI * i) / ROUND_SIDES;
    out.push(add3(center, add3(scale3(w, Math.cos(a) * hw), scale3(h, Math.sin(a) * hh))));
  }
  return out;
}

/** Half the widest extent of a cross-section: grows a centreline box to a safe broad-phase box. */
function halfExtent(size: RunSize): number {
  return Math.max(sizeWidth(size), sizeHeight(size)) / 2;
}

function lineBox(a: RunPoint, b: RunPoint, half: number): Aabb {
  return {
    min: p3(Math.min(a.x, b.x) - half, Math.min(a.y, b.y) - half, Math.min(a.z, b.z) - half),
    max: p3(Math.max(a.x, b.x) + half, Math.max(a.y, b.y) + half, Math.max(a.z, b.z) + half),
  };
}

function partPieces(el: PartInstance, prims: readonly ResolvedPrimitive[], z: number): Convex[] {
  const world = (x: number, y: number) => partToWorld(el, { x, y });
  const pieces: Convex[] = [];
  for (const prim of prims) {
    if (prim.kind === "box") {
      const [cx, cy, cz] = prim.center;
      const [sx, sy, sz] = prim.size;
      if (!(sx > 0 && sy > 0 && sz > 0)) continue;
      const outline = [world(cx - sx / 2, cy - sy / 2), world(cx + sx / 2, cy - sy / 2), world(cx + sx / 2, cy + sy / 2), world(cx - sx / 2, cy + sy / 2)];
      pieces.push(prismConvex(outline, z + cz - sz / 2, z + cz + sz / 2));
    } else if (prim.kind === "cylinder") {
      const [cx, cy, cz] = prim.center;
      const h = prim.height / 2;
      if (!(prim.radius > 0 && h > 0)) continue;
      const axis = prim.axis === "z" ? { x: 0, y: 0, z: 1 } : prim.axis === "x" ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      const at = (lx: number, ly: number, lz: number): RunPoint => {
        const q = world(lx, ly);
        return { x: q.x, y: q.y, z: z + lz };
      };
      const c0 = at(cx - axis.x * h, cy - axis.y * h, cz - axis.z * h);
      const c1 = at(cx + axis.x * h, cy + axis.y * h, cz + axis.z * h);
      const along = sub3(c1, c0);
      const round: RunSize = { shape: "round", diameter: prim.radius * 2 };
      pieces.push(loftConvex(ring(c0, along, round), ring(c1, along, round)));
    } else {
      if (prim.profile.length < 3 || !(prim.height > 0)) continue;
      pieces.push(prismConvex(convexHull2(prim.profile.map((q) => world(q.x, q.y))), z + prim.z, z + prim.z + prim.height));
    }
  }
  return pieces;
}

/** A modeled part's solid as placed convex pieces, plus its hoods, louvers and screens. Throws when the part doesn't resolve (callers report it). */
function modeledPartPieces(type: PartTypeElement, el: PartInstance, z: number): Convex[] {
  const out: Convex[] = [];
  // Medium detail: the body sheets draw, without fine-only grooves and louvres (which only take material away).
  for (const piece of partConvexPieces(type.definition, el.values, "medium").pieces) {
    const mounted = mountedPositions(piece.positions, el.mount);
    const pts: P3[] = [];
    for (let i = 0; i + 2 < mounted.length; i += 3) {
      const w = partToWorld(el, { x: mounted[i] ?? 0, y: mounted[i + 1] ?? 0 });
      pts.push(p3(w.x, w.y, z + (mounted[i + 2] ?? 0)));
    }
    out.push(hullConvex(pts, piece.indices));
  }
  out.push(...partPieces(el, placedIntakePrimitives(type, el), z));
  return out;
}

/** Convex hull of plan points (counter-clockwise). */
export function convexHull2(points: ReadonlyArray<{ readonly x: number; readonly y: number }>): Array<{ x: number; y: number }> {
  const pts = [...points].map((q) => ({ x: q.x, y: q.y })).sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** A part's resolved feature primitives, or the reason they don't resolve. */
export function partPrimitives(type: PartTypeElement, part: PartInstance): { prims: ResolvedPrimitive[] } | { error: string } {
  try {
    return { prims: resolveGeometry(type.definition, part.values) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function primsBox(el: PartInstance, prims: readonly ResolvedPrimitive[], z: number): Aabb | null {
  const pieces = partPieces(el, prims, z);
  if (pieces.length === 0) return null;
  return aabbOfPoints(pieces.flatMap((p) => p.points));
}

/** The element as a body, or null when it has no body the lint tests (annotations, documents, systems). */
export function elementShape(elements: Elements, el: BimElement, levelElevationByName: (name: string) => number | null): ElementShape | null {
  switch (el.kind) {
    case "run_segment": {
      const z = levelElevation(elements, el.levelId);
      const a = { x: el.start.x, y: el.start.y, z: el.start.z + z };
      const b = { x: el.end.x, y: el.end.y, z: el.end.z + z };
      const along = sub3(b, a);
      if (len3(along) < 1e-6) return null;
      const outer = el.domain === "duct" ? ductOuterSize(el.size, el.insulation) : el.size;
      return {
        role: "mep",
        box: lineBox(a, b, halfExtent(outer)),
        pieces: () => [loftConvex(ring(a, along, outer), ring(b, along, outer))],
      };
    }
    case "run_fitting": {
      const z = levelElevation(elements, el.levelId);
      const center = { x: el.position.x, y: el.position.y, z: el.position.z + z };
      const ports = el.ports.map((port) => ({ at: { x: port.position.x, y: port.position.y, z: port.position.z + z }, size: el.domain === "duct" ? ductOuterSize(port.size, el.insulation) : port.size }));
      if (ports.length === 0) return null;
      let box: Aabb | null = null;
      for (const port of ports) {
        const pb = lineBox(port.at, center, halfExtent(port.size));
        box = box ? { min: p3(Math.min(box.min.x, pb.min.x), Math.min(box.min.y, pb.min.y), Math.min(box.min.z, pb.min.z)), max: p3(Math.max(box.max.x, pb.max.x), Math.max(box.max.y, pb.max.y), Math.max(box.max.z, pb.max.z)) } : pb;
      }
      return {
        role: "mep",
        box: box as Aabb,
        pieces: () =>
          ports.flatMap((port) => {
            const along = sub3(center, port.at);
            if (len3(along) < 1) return [];
            return [loftConvex(ring(port.at, along, port.size), ring(center, along, port.size))];
          }),
      };
    }
    case "part": {
      // Not placed yet: no body, so no clash, surface or clearance check (coordination's planned-not-checked says so).
      if (el.planned !== undefined) return null;
      const type = elements[el.typeId];
      if (type?.kind !== "part_type") return null;
      const z = levelElevation(elements, el.levelId) + el.offsetMm;
      const resolved = partPrimitives(type, el);
      if ("error" in resolved) return null;
      const box = primsBox(el, resolved.prims, z);
      if (!box) return null;
      const category = type.definition.category;
      const role: BodyRole = category === "mechanical_equipment" || category === "electrical_equipment" || category === "plumbing_fixture" ? "equipment" : "mep";
      if (type.definition.model && partGeometryReady()) return { role, box, pieces: () => modeledPartPieces(type, el, z) };
      return { role, box, pieces: () => partPieces(el, resolved.prims, z) };
    }
    case "duct_segment": {
      const named = levelElevationByName(el.partition?.level ?? "");
      const layer = named === null ? { layer: el.partition?.level ?? "" } : {};
      const z = (named ?? 0) + LEGACY_ELEVATION_MM;
      const a = { x: el.start.x, y: el.start.y, z };
      const b = { x: el.end.x, y: el.end.y, z };
      const size: RunSize = el.profile.shape === "rect" ? { shape: "rect", width: el.profile.width, height: el.profile.height } : { shape: "round", diameter: el.profile.diameter };
      const along = sub3(b, a);
      if (len3(along) < 1e-6) return null;
      return { role: "mep", ...layer, box: lineBox(a, b, halfExtent(size)), pieces: () => [loftConvex(ring(a, along, size), ring(b, along, size))] };
    }
    case "equipment": {
      const named = levelElevationByName(el.partition?.level ?? "");
      const layer = named === null ? { layer: el.partition?.level ?? "" } : {};
      const floor = named ?? 0;
      const top = floor + LEGACY_ELEVATION_MM + 2 * 304.8;
      const box: Aabb = { min: p3(el.position.x - el.size.x / 2, el.position.y - el.size.y / 2, top - 3 * 304.8), max: p3(el.position.x + el.size.x / 2, el.position.y + el.size.y / 2, top) };
      return { role: "equipment", ...layer, box, pieces: () => [boxConvex(box)] };
    }
    case "wall": {
      const dx = el.end.x - el.start.x;
      const dy = el.end.y - el.start.y;
      const l = Math.hypot(dx, dy);
      if (l < 1e-6) return null;
      const nx = (-dy / l) * (el.thickness / 2);
      const ny = (dx / l) * (el.thickness / 2);
      const named = levelElevationByName(el.partition?.level ?? "");
      const floor = named ?? 0;
      const height = el.height > 0 ? el.height : DEFAULT_WALL_HEIGHT_MM;
      const outline = [
        { x: el.start.x + nx, y: el.start.y + ny },
        { x: el.end.x + nx, y: el.end.y + ny },
        { x: el.end.x - nx, y: el.end.y - ny },
        { x: el.start.x - nx, y: el.start.y - ny },
      ];
      const piece = prismConvex(outline, floor, floor + height);
      return { role: "architecture", ...(named === null ? { layer: el.partition?.level ?? "" } : {}), box: aabbOfPoints(piece.points), pieces: () => [piece] };
    }
    case "column": {
      const named = levelElevationByName(el.partition?.level ?? "");
      const floor = named ?? 0;
      const box: Aabb = { min: p3(el.position.x - el.size.x / 2, el.position.y - el.size.y / 2, floor), max: p3(el.position.x + el.size.x / 2, el.position.y + el.size.y / 2, floor + DEFAULT_WALL_HEIGHT_MM) };
      return { role: "structure", ...(named === null ? { layer: el.partition?.level ?? "" } : {}), box, pieces: () => [boxConvex(box)] };
    }
    case "slab": {
      if (el.outline.length < 3) return null;
      const named = levelElevationByName(el.partition?.level ?? "");
      const top = named ?? 0;
      const hull = convexHull2(el.outline);
      const piece = prismConvex(hull, top - el.thickness, top);
      return { role: "structure", ...(named === null ? { layer: el.partition?.level ?? "" } : {}), box: aabbOfPoints(piece.points), pieces: () => [piece] };
    }
    default:
      return null;
  }
}

/** What people call an element, short. */
export function elementName(elements: Elements, el: BimElement): string {
  switch (el.kind) {
    case "part":
      return partLabelOf(elements, el);
    case "run_segment":
    case "run_fitting": {
      const system = elements[el.systemId];
      const sys = system?.kind === "mep_system" ? `${system.name} ` : "";
      return `${sys}${runLabel(elements, el)}`.trim();
    }
    case "equipment":
    case "terminal":
      return el.mark || el.typeName;
    case "wall":
      return `wall ${el.wallType}`.trim();
    case "slab":
      return "slab";
    case "column":
      return `${el.material} column`;
    case "view":
      return el.name;
    case "sheet":
      return `${el.number} ${el.title}`.trim();
    case "level":
      return el.name;
    case "mep_system":
      return el.name;
    default:
      return el.id;
  }
}

export function isPart(el: BimElement | undefined): el is PartInstance {
  return el?.kind === "part";
}
