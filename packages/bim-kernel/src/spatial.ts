import { z } from "zod";
import { round, roundVec } from "./geometry";
import { viewFloorMm } from "./levels";
import { localBounds, resolveDim, resolveGeometry, resolveSymbol, type PartTypeDefinition } from "./parts";
import { placeClearance, resolveClearances, resolvePositionEnvelopes, type PlacedClearance } from "./part-model/clearance";
import type { Dim } from "./part-dim";
import { pathLength, profileElevationAt } from "./placement/geometric-math";
import { registerRevisionCarry } from "./revision-carry";
import { elementsOfKind } from "./store";
import type { BimElement, ElementId, ModelState, PartInstance, Vec2, Wall } from "./types";

/**
 * Where equipment sits and the space it needs, read from the model: the
 * surface a placed part stands on (its host: one of our slabs, or a linked
 * slab or roof), its curb, and its clearance zones placed in the world.
 *
 * A host is the engineer's statement "this unit stands on that deck". The
 * kernel keeps it and checks it against heights; it never picks a host by
 * itself. Linked hosts carry the surface top the person or agent picked,
 * because the linked model lives outside the kernel; the lint engine
 * re-checks that against the current linked index.
 */

const idSchema = z.string().min(1).max(200);

export const HOST_SURFACES = ["slab", "roof"] as const;
export type HostSurface = (typeof HOST_SURFACES)[number];

export const partHostSchema = z.discriminatedUnion("kind", [
  /** One of our slabs; its top is its level's floor. */
  z.object({ kind: z.literal("slab"), elementId: idSchema }).strict(),
  /** A linked model's slab or roof. */
  z
    .object({
      kind: z.literal("linked"),
      /** The linked model (reference) id. */
      referenceId: idSchema,
      /** IFC GlobalId of the slab or roof, when known. */
      globalId: z.string().min(1).max(64).optional(),
      /** The viewer's item id, when the host was picked in 3D. */
      localId: z.number().int().min(0).optional(),
      name: z.string().trim().min(1).max(120),
      /** Slab or roof, when known (a pick in 3D may not know yet). */
      surface: z.enum(HOST_SURFACES).optional(),
      /** Top of the surface under the part, model elevation (mm), when it was chosen. */
      topMm: z.number().finite().min(-1_000_000).max(1_000_000),
    })
    .strict(),
  /**
   * One of our elements placed along a line or path (a beam, a wall, a
   * curb), at a station along it from its start. Written only to peers
   * advertising `parts:line_host` (part-model/unit-gate.ts).
   */
  z.object({ kind: z.literal("element"), elementId: idSchema, stationMm: z.number().finite().min(0).max(10_000_000) }).strict(),
  /**
   * Mounted flush on one vertical finish face of a wall at a station along its
   * start → end axis. `side: 1` is the left face (+normal) and `side: -1` is
   * the right face (-normal), matching `Opening.side`. Local +Y points out of
   * the finish face into the room. Written only to peers advertising
   * `parts:wall_face_host` (part-model/unit-gate.ts).
   */
  z
    .object({
      kind: z.literal("wall_face"),
      elementId: idSchema,
      stationMm: z.number().finite().min(0).max(10_000_000),
      side: z.union([z.literal(1), z.literal(-1)]),
      faceOffsetMm: z.number().finite().min(-1000).max(1000).optional(),
    })
    .strict(),
]);
export type PartHost = z.infer<typeof partHostSchema>;

/** The protocol feature for a part mounted on a wall's finish face (`PartHost` kind `wall_face`). */
export const PARTS_WALL_FACE_HOST_FEATURE = "parts:wall_face_host";

export interface WallFaceFrame {
  readonly position: Vec2;
  /** Counter-clockwise degrees from east so local +X runs along the wall and local +Y points out of the face into the room. */
  readonly rotationDeg: number;
  readonly normal: Vec2;
  readonly tangent: Vec2;
  readonly clampedStationMm: number;
  readonly wallLengthMm: number;
}

function normalizeAngleDeg(deg: number): number {
  const r = round(((deg % 360) + 360) % 360, 6);
  return r === 360 ? 0 : r;
}

/**
 * Exact plan insertion point and outward-facing rotation on one finish face of
 * `wall` at `stationMm` along `wall.start -> wall.end`. Local +Y points straight
 * out of the chosen finish face so a wall-mounted part's origin sits flush at
 * the finish face (`y = 0`) and its graphic extends outward into the room.
 */
export function wallFaceFrame(
  wall: Pick<Wall, "start" | "end" | "thickness">,
  stationMm: number,
  side: 1 | -1,
  faceOffsetMm = 0,
): WallFaceFrame {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  const ux = len > 1e-6 ? dx / len : 1;
  const uy = len > 1e-6 ? dy / len : 0;
  const nx = side === 1 ? -uy : uy;
  const ny = side === 1 ? ux : -ux;
  const clamped = len > 1e-6 ? Math.min(len, Math.max(0, stationMm)) : 0;
  const out = wall.thickness / 2 + faceOffsetMm;
  const position = roundVec({
    x: wall.start.x + ux * clamped + nx * out,
    y: wall.start.y + uy * clamped + ny * out,
  });
  const baseDeg = (Math.atan2(uy, ux) * 180) / Math.PI;
  const rotationDeg = normalizeAngleDeg(baseDeg + (side === 1 ? 0 : 180));
  return {
    position,
    rotationDeg,
    normal: { x: nx, y: ny },
    tangent: { x: ux, y: uy },
    clampedStationMm: round(clamped),
    wallLengthMm: round(len),
  };
}

/** Which face of `wall` (`1` = left/+normal, `-1` = right/-normal) faces toward `point`. */
export function wallFaceSideToward(wall: Pick<Wall, "start" | "end">, point: Vec2): 1 | -1 {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const cross = dx * (point.y - wall.start.y) - dy * (point.x - wall.start.x);
  return cross >= 0 ? 1 : -1;
}

/** Project `point` onto `wall`: clamped station from `wall.start`, facing side, and distance to that finish face. */
export function wallStationOf(
  wall: Pick<Wall, "start" | "end" | "thickness">,
  point: Vec2,
): { readonly stationMm: number; readonly side: 1 | -1; readonly distanceMm: number; readonly frame: WallFaceFrame } {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  const proj = len > 1e-6 ? ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / len : 0;
  const stationMm = len > 1e-6 ? Math.min(len, Math.max(0, proj)) : 0;
  const side = wallFaceSideToward(wall, point);
  const frame = wallFaceFrame(wall, stationMm, side);
  const distanceMm = Math.hypot(point.x - frame.position.x, point.y - frame.position.y);
  return { stationMm: round(stationMm), side, distanceMm, frame };
}

export interface NearestWallFace {
  readonly wallId: ElementId;
  readonly stationMm: number;
  readonly side: 1 | -1;
  readonly position: Vec2;
  readonly rotationDeg: number;
  readonly distanceMm: number;
  readonly label: string;
}

// ── Incremental indexes for wall-face hosting (carried across revisions) ────

type SpatialElements = Readonly<Record<string, BimElement>>;

const WALL_CELL_MM = 4000;

interface WallGridIndex {
  /** `${levelName}|${cx}|${cy}` -> wall ids whose bounding box + thickness overlaps that cell. */
  readonly cells: Map<string, Set<ElementId>>;
  /** wallId -> cell keys currently holding it (for O(1) incremental removal on update/delete). */
  readonly keysByWall: Map<ElementId, readonly string[]>;
}

const wallGridCache = new WeakMap<SpatialElements, WallGridIndex>();

function wallCellKeys(wall: Wall): string[] {
  const pad = wall.thickness / 2;
  const lvl = wall.partition?.level ?? "";
  const x0 = Math.floor((Math.min(wall.start.x, wall.end.x) - pad) / WALL_CELL_MM);
  const x1 = Math.floor((Math.max(wall.start.x, wall.end.x) + pad) / WALL_CELL_MM);
  const y0 = Math.floor((Math.min(wall.start.y, wall.end.y) - pad) / WALL_CELL_MM);
  const y1 = Math.floor((Math.max(wall.start.y, wall.end.y) + pad) / WALL_CELL_MM);
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${lvl}|${x}|${y}`);
  return out;
}

function addWallToGrid(grid: WallGridIndex, wall: Wall): void {
  const keys = wallCellKeys(wall);
  grid.keysByWall.set(wall.id, keys);
  for (const k of keys) {
    let bucket = grid.cells.get(k);
    if (!bucket) {
      bucket = new Set();
      grid.cells.set(k, bucket);
    }
    bucket.add(wall.id);
  }
}

function removeWallFromGrid(grid: WallGridIndex, id: ElementId): void {
  const prev = grid.keysByWall.get(id);
  if (!prev) return;
  for (const k of prev) {
    const bucket = grid.cells.get(k);
    if (!bucket) continue;
    bucket.delete(id);
    if (bucket.size === 0) grid.cells.delete(k);
  }
  grid.keysByWall.delete(id);
}

function wallGridFor(elements: SpatialElements): WallGridIndex {
  const cached = wallGridCache.get(elements);
  if (cached) return cached;
  const grid: WallGridIndex = { cells: new Map(), keysByWall: new Map() };
  for (const wall of elementsOfKind(elements, "wall")) addWallToGrid(grid, wall);
  wallGridCache.set(elements, grid);
  return grid;
}

function cloneWallGrid(from: WallGridIndex): WallGridIndex {
  const cells = new Map<string, Set<ElementId>>();
  for (const [k, s] of from.cells) cells.set(k, new Set(s));
  return { cells, keysByWall: new Map(from.keysByWall) };
}

registerRevisionCarry("spatial.walls-grid", (from, to, changedIds) => {
  const prev = wallGridCache.get(from);
  if (!prev) return;
  let anyWall = false;
  for (const id of changedIds) {
    if (from[id]?.kind === "wall" || to[id]?.kind === "wall") {
      anyWall = true;
      break;
    }
  }
  if (!anyWall) {
    wallGridCache.set(to, prev);
    return;
  }
  const next = cloneWallGrid(prev);
  for (const id of changedIds) {
    const a = from[id];
    const b = to[id];
    if (a?.kind !== "wall" && b?.kind !== "wall") continue;
    if (a?.kind === "wall") removeWallFromGrid(next, a.id);
    if (b?.kind === "wall") addWallToGrid(next, b);
  }
  wallGridCache.set(to, next);
});

interface WallHostIndex {
  /** wallId -> set of placed part ids with `host.kind === "wall_face"`. */
  readonly byWall: Map<string, Set<ElementId>>;
  /** partId -> host wallId. */
  readonly wallOfPart: Map<ElementId, string>;
}

const wallHostCache = new WeakMap<SpatialElements, WallHostIndex>();

function addPartHost(idx: WallHostIndex, part: PartInstance): void {
  if (part.planned !== undefined || part.host?.kind !== "wall_face") return;
  const wId = part.host.elementId;
  idx.wallOfPart.set(part.id, wId);
  let set = idx.byWall.get(wId);
  if (!set) {
    set = new Set();
    idx.byWall.set(wId, set);
  }
  set.add(part.id);
}

function removePartHost(idx: WallHostIndex, partId: ElementId): void {
  const wId = idx.wallOfPart.get(partId);
  if (wId === undefined) return;
  const set = idx.byWall.get(wId);
  if (set) {
    set.delete(partId);
    if (set.size === 0) idx.byWall.delete(wId);
  }
  idx.wallOfPart.delete(partId);
}

function wallHostIndexFor(elements: SpatialElements): WallHostIndex {
  const cached = wallHostCache.get(elements);
  if (cached) return cached;
  const idx: WallHostIndex = { byWall: new Map(), wallOfPart: new Map() };
  for (const part of elementsOfKind(elements, "part")) addPartHost(idx, part);
  wallHostCache.set(elements, idx);
  return idx;
}

registerRevisionCarry("spatial.wall-hosts", (from, to, changedIds) => {
  const prev = wallHostCache.get(from);
  if (!prev) return;
  let anyHostChange = false;
  for (const id of changedIds) {
    const a = from[id];
    const b = to[id];
    const aWall = a?.kind === "part" && a.planned === undefined && a.host?.kind === "wall_face" ? a.host.elementId : undefined;
    const bWall = b?.kind === "part" && b.planned === undefined && b.host?.kind === "wall_face" ? b.host.elementId : undefined;
    if (aWall !== bWall) {
      anyHostChange = true;
      break;
    }
  }
  if (!anyHostChange) {
    wallHostCache.set(to, prev);
    return;
  }
  const byWall = new Map<string, Set<ElementId>>();
  for (const [k, s] of prev.byWall) byWall.set(k, new Set(s));
  const next: WallHostIndex = { byWall, wallOfPart: new Map(prev.wallOfPart) };
  for (const id of changedIds) {
    const a = from[id];
    const b = to[id];
    if (a?.kind === "part") removePartHost(next, a.id);
    if (b?.kind === "part") addPartHost(next, b);
  }
  wallHostCache.set(to, next);
});

/**
 * Every placed part hosted via `wall_face` on any wall in `wallIds`, without
 * scanning the model's parts. Reads the incremental index on `baseElements`
 * and reconciles only `touchedIds` against `working`.
 */
export function partsHostedOnWalls(
  baseElements: SpatialElements,
  working: SpatialElements,
  wallIds: ReadonlySet<string>,
  touchedIds: readonly ElementId[] = [],
): PartInstance[] {
  if (wallIds.size === 0) return [];
  const idx = wallHostIndexFor(baseElements);
  const candidateIds = new Set<ElementId>();
  for (const wId of wallIds) {
    const hosted = idx.byWall.get(wId);
    if (hosted) for (const pid of hosted) candidateIds.add(pid);
  }
  for (const tid of touchedIds) {
    const el = working[tid];
    if (el?.kind === "part" && el.planned === undefined && el.host?.kind === "wall_face" && wallIds.has(el.host.elementId)) {
      candidateIds.add(el.id);
    }
  }
  const out: PartInstance[] = [];
  for (const pid of candidateIds) {
    const el = working[pid];
    if (el?.kind === "part" && el.planned === undefined && el.host?.kind === "wall_face" && wallIds.has(el.host.elementId)) {
      out.push(el);
    }
  }
  return out;
}

/**
 * Nearest wall finish face to `point` on `levelId`'s level within `maxDistanceMm`
 * (default 450 mm). Uses the incremental per-level spatial wall grid so lookups
 * visit only nearby cells rather than scanning every wall in the model.
 */
export function nearestWallFace(
  model: ModelState,
  levelId: string,
  point: Vec2,
  opts: {
    readonly maxDistanceMm?: number;
    readonly excludeIds?: ReadonlySet<string>;
    /** Optional committed base record whose spatial index can be queried when `model.elements` is a mutable draft overlay. */
    readonly baseElements?: SpatialElements;
    /** Wall ids added or moved in the draft overlay beyond `baseElements`. */
    readonly overlayWallIds?: ReadonlySet<string>;
  } = {},
): NearestWallFace | null {
  const maxDist = opts.maxDistanceMm ?? 450;
  const levelEl = model.elements[levelId];
  const levelName = levelEl?.kind === "level" ? levelEl.name : undefined;
  const grid = wallGridFor(opts.baseElements ?? model.elements);
  const x0 = Math.floor((point.x - maxDist) / WALL_CELL_MM);
  const x1 = Math.floor((point.x + maxDist) / WALL_CELL_MM);
  const y0 = Math.floor((point.y - maxDist) / WALL_CELL_MM);
  const y1 = Math.floor((point.y + maxDist) / WALL_CELL_MM);
  const levelsToQuery: string[] = levelName ? [levelName, ""] : [""];
  // If `levelId` did not resolve to a named level, include all levels present in the grid cells.
  const candidateIds = new Set<string>();
  if (levelName) {
    for (const lvl of levelsToQuery) {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const bucket = grid.cells.get(`${lvl}|${x}|${y}`);
          if (bucket) for (const id of bucket) candidateIds.add(id);
        }
      }
    }
  } else {
    for (const [key, bucket] of grid.cells) {
      const p1 = key.lastIndexOf("|");
      const p0 = key.lastIndexOf("|", p1 - 1);
      const cx = Number(key.slice(p0 + 1, p1));
      const cy = Number(key.slice(p1 + 1));
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
        for (const id of bucket) candidateIds.add(id);
      }
    }
  }
  if (opts.overlayWallIds) {
    for (const id of opts.overlayWallIds) candidateIds.add(id);
  }
  let best: NearestWallFace | null = null;
  for (const wallId of candidateIds) {
    if (opts.excludeIds?.has(wallId)) continue;
    const wall = model.elements[wallId];
    if (wall?.kind !== "wall") continue;
    if (levelName && wall.partition?.level && wall.partition.level !== levelName) continue;
    const hit = wallStationOf(wall, point);
    if (hit.distanceMm > maxDist) continue;
    if (!best || hit.distanceMm < best.distanceMm) {
      best = {
        wallId: wall.id,
        stationMm: hit.stationMm,
        side: hit.side,
        position: hit.frame.position,
        rotationDeg: hit.frame.rotationDeg,
        distanceMm: hit.distanceMm,
        label: `wall ${wall.id} ${hit.side === 1 ? "left" : "right"} face`,
      };
    }
  }
  return best;
}

/**
 * Resolve wall-face snapping/re-hosting for a part moved to `candidatePos`.
 * Shared by `move_elements` (before connected-run propagation) and the edit hook.
 */
export function resolveMovedWallFacePart(
  model: ModelState,
  prev: PartInstance,
  candidatePos: Vec2,
  opts: {
    readonly wallFaceAllowed: boolean;
    readonly baseElements?: SpatialElements;
    readonly overlayWallIds?: ReadonlySet<string>;
    readonly maxDistanceMm?: number;
  },
): { readonly position: Vec2; readonly rotationDeg: number; readonly host: PartHost | undefined; readonly changed: boolean } {
  const hasLinks = Boolean(prev.links && Object.keys(prev.links).length > 0);
  const maxDistanceMm = opts.maxDistanceMm ?? 450;
  if (prev.host?.kind === "wall_face") {
    const snap = nearestWallFace(model, prev.levelId, candidatePos, {
      maxDistanceMm,
      baseElements: opts.baseElements,
      overlayWallIds: opts.overlayWallIds,
    });
    if (snap) {
      const faceOffsetMm = prev.host.faceOffsetMm ?? 0;
      const wall = model.elements[snap.wallId];
      const frame = wall?.kind === "wall" ? wallFaceFrame(wall, snap.stationMm, snap.side, faceOffsetMm) : { position: snap.position, rotationDeg: snap.rotationDeg };
      // Connected runs cannot rotate with a part: if snapping would turn it onto a differently oriented wall, detach the host and keep its translated orientation.
      if (hasLinks && frame.rotationDeg !== prev.rotationDeg) {
        return { position: candidatePos, rotationDeg: prev.rotationDeg, host: undefined, changed: true };
      }
      return {
        position: frame.position,
        rotationDeg: frame.rotationDeg,
        host: {
          kind: "wall_face",
          elementId: snap.wallId,
          stationMm: snap.stationMm,
          side: snap.side,
          ...(faceOffsetMm !== 0 ? { faceOffsetMm } : {}),
        },
        changed: true,
      };
    }
    return { position: candidatePos, rotationDeg: prev.rotationDeg, host: undefined, changed: true };
  }
  if (opts.wallFaceAllowed && prev.host === undefined) {
    const typeEl = model.elements[prev.typeId];
    if (typeEl?.kind !== "part_type" || !isWallFaceMountable(typeEl.definition)) {
      return { position: candidatePos, rotationDeg: prev.rotationDeg, host: prev.host, changed: false };
    }
    const snap = nearestWallFace(model, prev.levelId, candidatePos, {
      maxDistanceMm,
      baseElements: opts.baseElements,
      overlayWallIds: opts.overlayWallIds,
    });
    if (!snap) return { position: candidatePos, rotationDeg: prev.rotationDeg, host: prev.host, changed: false };
    const wall = model.elements[snap.wallId];
    const frame = wall?.kind === "wall" ? wallFaceFrame(wall, snap.stationMm, snap.side, 0) : { position: snap.position, rotationDeg: snap.rotationDeg };
    if (hasLinks && frame.rotationDeg !== prev.rotationDeg) {
      return { position: candidatePos, rotationDeg: prev.rotationDeg, host: prev.host, changed: false };
    }
    return {
      position: frame.position,
      rotationDeg: frame.rotationDeg,
      host: { kind: "wall_face", elementId: snap.wallId, stationMm: snap.stationMm, side: snap.side },
      changed: true,
    };
  }
  return { position: candidatePos, rotationDeg: prev.rotationDeg, host: prev.host, changed: false };
}

/**
 * Discipline-neutral check for whether a part type mounts flush onto a wall
 * finish face (local +Y pointing into the room):
 * 1. Explicit `definition.hosting` (`"wall_face"` vs `"ceiling"`/`"floor"`/`"free"`).
 * 2. Explicit `typeValues.mounting` hint (`wall`/`counter` vs `ceiling`/`floor`).
 * 3. Geometric self-description: plan symbol anchored on `y = 0` extending strictly
 *    into `+Y`, or 3D box geometry whose back face sits flush/recessed at `y = 0`.
 */
export function isWallFaceMountable(definition: PartTypeDefinition | null | undefined): boolean {
  if (!definition) return false;
  if (definition.hosting !== undefined) return definition.hosting === "wall_face";
  const mounting = definition.typeValues?.mounting;
  if (typeof mounting === "string") {
    const m = mounting.toLowerCase();
    if (m.includes("floor") || m.includes("ceiling")) return false;
    if (m.includes("wall") || m.includes("counter")) return true;
  }
  const family = definition.familyName.toLowerCase();
  if (family.includes("ceiling") || family.includes("floor") || family.includes("pendant")) return false;
  // Geometric check on plan symbol: wall-anchored symbols start at y = 0 and extend outward into +Y.
  const syms = resolveSymbol(definition);
  if (syms.length > 0) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of syms) {
      if (s.kind === "line") {
        minY = Math.min(minY, s.from.y, s.to.y);
        maxY = Math.max(maxY, s.from.y, s.to.y);
      } else if (s.kind === "rect") {
        minY = Math.min(minY, s.center.y - s.size.y / 2);
        maxY = Math.max(maxY, s.center.y + s.size.y / 2);
      } else if (s.kind === "circle" || s.kind === "arc") {
        minY = Math.min(minY, s.center.y - s.radius);
        maxY = Math.max(maxY, s.center.y + s.radius);
      } else if (s.kind === "polyline") {
        for (const pt of s.points) {
          minY = Math.min(minY, pt.y);
          maxY = Math.max(maxY, pt.y);
        }
      }
    }
    if (Number.isFinite(minY) && Number.isFinite(maxY)) {
      // Strictly one-sided into +Y anchored near the wall face (y = 0).
      if (minY >= -0.25 && maxY > 0.5 && minY <= maxY * 0.25) return true;
      // Symmetric around y = 0 (free-standing / ceiling-centered) -> not wall-face mounted.
      if (minY < -0.5 && maxY > 0.5) return false;
    }
  }
  // Fallback geometric check on 3D body bounds: flush on y = 0 (+Y) or shallow recessed back-box (maxY <= 20 mm).
  const bounds = localBounds(resolveGeometry(definition));
  if (bounds) {
    const minY = bounds.min[1];
    const maxY = bounds.max[1];
    if (minY >= -5 && minY <= 5 && maxY > 25) return true;
    if (minY < 0 && maxY >= -5 && maxY <= 20) return true;
  }
  return false;
}

/** Curbs and rails taller than this are not curbs (a typo for millimetres or a raised platform). */
export const MAX_CURB_MM = 3048;
/** Base this close to the host top plus curb is seated. */
export const SEATED_TOLERANCE_MM = 13;

export type HostStatus = "seated" | "floating" | "buried" | "missing" | "none";

export interface HostState {
  readonly status: HostStatus;
  /** Plain words: "Stands on Roof deck (linked) on a 14" curb". */
  readonly label: string;
  /** Top of the host surface (model elevation, mm); null with no host or a missing one. */
  readonly topMm: number | null;
  readonly curbMm: number;
  /** Part base minus (host top + curb); positive floats, negative buries. Null without a usable host. */
  readonly gapMm: number | null;
}

/** Model elevation of a placed part's base (its insertion point). */
export function partBaseMm(model: ModelState, part: PartInstance): number {
  const level = model.elements[part.levelId];
  return (level?.kind === "level" ? level.elevationMm : 0) + part.offsetMm;
}

/** The protocol feature for a part standing on a line-placed element (`PartHost` kind `element`). */
export const PARTS_LINE_HOST_FEATURE = "parts:line_host";

/** Kinds a part may stand on as a line host: what has a line or path, its stored placement or its flat start and end. */
const LINE_HOST_KINDS: ReadonlySet<string> = new Set(["beam", "wall", "grid", "component"]);

function levelElevation(model: ModelState, levelId: string | undefined, levelName: string | undefined): number {
  const byId = levelId !== undefined ? model.elements[levelId] : undefined;
  if (byId?.kind === "level") return byId.elevationMm;
  return viewFloorMm(model, levelName) ?? 0;
}

/**
 * The top of a line host at a station, model elevation in mm, or null when
 * the element is gone or has no line. A stored line placement gives the top
 * between its end offsets (its vertical justification says which face the
 * line is; the placement's own line is taken as the top); a path its profile;
 * a wall without one its height; a beam or grid without one its level's floor.
 */
export function lineHostTopMm(model: ModelState, elementId: string, stationMm: number): number | null {
  const el: BimElement | undefined = model.elements[elementId];
  if (!el || !LINE_HOST_KINDS.has(el.kind)) return null;
  const placement = "placement" in el ? el.placement : undefined;
  const levelName = el.partition?.level;
  if (placement?.kind === "line") {
    const len = Math.hypot(placement.end.x - placement.start.x, placement.end.y - placement.start.y);
    const t = len === 0 ? 0 : Math.min(1, Math.max(0, stationMm / len));
    return levelElevation(model, placement.levelId, levelName) + placement.startOffsetMm + (placement.endOffsetMm - placement.startOffsetMm) * t;
  }
  if (placement?.kind === "path") {
    const s = Math.min(Math.max(0, stationMm), pathLength(placement)) + (placement.startStationMm ?? 0);
    return levelElevation(model, placement.levelId, levelName) + profileElevationAt(placement, s);
  }
  if (el.kind === "wall") return levelElevation(model, undefined, levelName) + el.height;
  if (el.kind === "beam" || el.kind === "grid") return levelElevation(model, undefined, levelName);
  return null;
}

/** Top of the surface a host names, or null when it is gone. */
export function hostTopMm(model: ModelState, host: PartHost): number | null {
  if (host.kind === "linked") return host.topMm;
  if (host.kind === "element") return lineHostTopMm(model, host.elementId, host.stationMm);
  if (host.kind === "wall_face") {
    const wall = model.elements[host.elementId];
    if (wall?.kind !== "wall") return null;
    const levelId = wall.placement?.kind === "line" ? wall.placement.levelId : undefined;
    return levelElevation(model, levelId, wall.partition?.level);
  }
  const slab = model.elements[host.elementId];
  if (slab?.kind !== "slab") return null;
  return viewFloorMm(model, slab.partition?.level) ?? 0;
}

export function hostName(model: ModelState, host: PartHost): string {
  if (host.kind === "linked") return `${host.name} (linked)`;
  if (host.kind === "wall_face") {
    const wall = model.elements[host.elementId];
    const station = `${Math.round((host.stationMm / 304.8) * 100) / 100} ft along`;
    const face = host.side === 1 ? "left face" : "right face";
    return wall?.kind === "wall" ? `wall ${wall.id} ${face}, ${station}` : `wall ${host.elementId} (deleted)`;
  }
  if (host.kind === "element") {
    const el = model.elements[host.elementId];
    const station = `${Math.round((host.stationMm / 304.8) * 100) / 100} ft along it`;
    return el ? `${el.kind.replace(/_/g, " ")} ${el.id}, ${station}` : `${host.elementId} (deleted)`;
  }
  const slab = model.elements[host.elementId];
  return slab?.kind === "slab" ? `slab ${slab.id}${slab.partition?.level ? ` on ${slab.partition.level}` : ""}` : `slab ${host.elementId} (deleted)`;
}

function inches(mm: number): string {
  return `${Math.round((mm / 25.4) * 10) / 10}"`;
}

/** What a placed part stands on, and whether it actually sits there. */
export function hostState(model: ModelState, part: PartInstance): HostState {
  const curbMm = part.curbMm ?? 0;
  if (part.planned !== undefined) return { status: "none", label: "Not placed yet", topMm: null, curbMm, gapMm: null };
  if (!part.host) return { status: "none", label: "No host", topMm: null, curbMm, gapMm: null };
  const name = hostName(model, part.host);
  if (part.host.kind === "wall_face") {
    const wall = model.elements[part.host.elementId];
    if (wall?.kind !== "wall") return { status: "missing", label: `Its host ${name} is gone`, topMm: null, curbMm, gapMm: null };
    const top = hostTopMm(model, part.host);
    const expected = wallFaceFrame(wall, part.host.stationMm, part.host.side, part.host.faceOffsetMm ?? 0);
    const gap = round(Math.hypot(part.position.x - expected.position.x, part.position.y - expected.position.y));
    if (gap > SEATED_TOLERANCE_MM) return { status: "floating", label: `${inches(gap)} off ${name}`, topMm: top, curbMm, gapMm: gap };
    return { status: "seated", label: `Mounted on ${name}`, topMm: top, curbMm, gapMm: gap };
  }
  const top = hostTopMm(model, part.host);
  if (top === null) return { status: "missing", label: `Its host ${name} is gone`, topMm: null, curbMm, gapMm: null };
  const gap = partBaseMm(model, part) - (top + curbMm);
  const on = `${name}${curbMm > 0 ? ` on a ${inches(curbMm)} curb` : ""}`;
  if (gap > SEATED_TOLERANCE_MM) return { status: "floating", label: `${inches(gap)} above ${on}`, topMm: top, curbMm, gapMm: gap };
  if (gap < -SEATED_TOLERANCE_MM) return { status: "buried", label: `${inches(-gap)} below the top of ${on}`, topMm: top, curbMm, gapMm: gap };
  return { status: "seated", label: `Stands on ${on}`, topMm: top, curbMm, gapMm: gap };
}

/**
 * The elevation a placed part's floor-measured clearances start from: its
 * host's top when it has one, else its level's floor.
 */
export function partFloorMm(model: ModelState, part: PartInstance): number {
  const top = part.host ? hostTopMm(model, part.host) : null;
  if (top !== null) return top;
  const level = model.elements[part.levelId];
  return level?.kind === "level" ? level.elevationMm : 0;
}

/** A placed part's clearance zones in the world (type zones with its overrides, then the envelopes of its current and travel positions). Empty when its type has none. */
export function partClearances(model: ModelState, part: PartInstance): PlacedClearance[] {
  if (part.planned !== undefined) return [];
  const type = model.elements[part.typeId];
  if (type?.kind !== "part_type") return [];
  const def = type.definition;
  if (!def.clearances?.length && !part.clearances && !def.positions?.length) return [];
  const box = localBounds(resolveGeometry(def, part.values));
  const dim = (d: Dim) => resolveDim(def, part.values, d);
  const zones = [...resolveClearances(def.clearances, part.clearances, box, dim), ...resolvePositionEnvelopes(def.positions, part.positionId, box, dim)];
  if (zones.length === 0) return [];
  const base = partBaseMm(model, part);
  const floor = partFloorMm(model, part);
  return zones.map((z) => placeClearance(z, part, base, floor));
}

/**
 * Parts standing on a slab being deleted. They keep their host link (it now
 * names a slab that is gone, which Properties and the coordination lint say);
 * undoing the delete puts the deck back under them. Scans parts only when a
 * slab is among the deleted.
 */
export function partsHostedOn(model: ModelState, removed: ReadonlySet<string>): ElementId[] {
  let hostGone = false;
  for (const id of removed) {
    const k = model.elements[id]?.kind;
    if (k === "slab" || (k !== undefined && LINE_HOST_KINDS.has(k))) hostGone = true;
  }
  if (!hostGone) return [];
  return elementsOfKind(model.elements, "part")
    .filter((el) => (el.host?.kind === "slab" || el.host?.kind === "element" || el.host?.kind === "wall_face") && removed.has(el.host.elementId) && !removed.has(el.id))
    .map((el) => el.id);
}

function insideOutline(p: { readonly x: number; readonly y: number }, poly: readonly { readonly x: number; readonly y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Our slabs whose outline holds a plan point, highest top first, with their tops: the decks a part there could stand on. */
export function slabsUnder(model: ModelState, point: { readonly x: number; readonly y: number }): Array<{ readonly id: ElementId; readonly name: string; readonly topMm: number }> {
  return elementsOfKind(model.elements, "slab")
    .filter((s) => s.outline.length >= 3 && insideOutline(point, s.outline))
    .map((s) => ({ id: s.id, name: hostName(model, { kind: "slab", elementId: s.id }), topMm: viewFloorMm(model, s.partition?.level) ?? 0 }))
    .sort((a, b) => b.topMm - a.topMm);
}
