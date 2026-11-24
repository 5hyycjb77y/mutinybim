import {
  elementsOfKind,
  findLevelByName,
  resolveElementMaterial,
  type BimElement,
  type Ceiling,
  type Column,
  type Level,
  type ModelState,
  type Opening,
  type Slab,
  type Vec2,
  type Wall,
} from "@permitzip/bim-kernel";
import {
  extractPartPhotometrics,
  isGlazingMaterial,
  materialTransmittance,
  type OrientedPartBox,
} from "./materials";
import { extractStairs3D, type ResolvedStairFlight, type ResolvedStairLanding } from "./stairs";

/**
 * Fast 3D ray-casting occlusion & glazing-transmittance index for photometrics.
 *
 * Indexes:
 * - Walls (with door/window openings punched out & glazed curtain walls transmitting
 *   light by material visible transmittance `T_vis` rather than binary block/pass)
 * - Floor/ceiling slabs (respecting stairwell cutouts)
 * - Structural columns
 * - Solid stair flights & mid-landings (sloped waist slabs)
 * - Optional furniture / casework / equipment oriented 3D bounding boxes
 *
 * Cached per `model.elements` snapshot via WeakMap.
 */

interface WallOpeningCutout {
  readonly s0: number;
  readonly s1: number;
  readonly z0: number;
  readonly z1: number;
  /** Visible light transmittance across the opening (1.0 = open cased doorway, ~0.78 = window glass). */
  readonly transmittance: number;
}

interface WallOccluder {
  readonly idx: number;
  readonly id: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly dx: number;
  readonly dy: number;
  readonly lengthMm: number;
  readonly zMin: number;
  readonly zMax: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  /** Visible light transmittance (`0` = opaque partition/exterior wall, `>0` = glazed curtain wall). */
  readonly transmittance: number;
  readonly openings: readonly WallOpeningCutout[];
}

interface ColumnOccluder {
  readonly idx: number;
  readonly id: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly zMin: number;
  readonly zMax: number;
}

interface SlabOccluder {
  readonly id: string;
  readonly zBottom: number;
  readonly zTop: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly outline: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
  /** True for ceiling assemblies (checked when `includeCeilings` is true, e.g. sky/daylight rays). */
  readonly isCeiling?: boolean;
}

interface StairFlightOccluder {
  readonly key: string;
  readonly flight: ResolvedStairFlight;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly zMin: number;
  readonly zMax: number;
}

interface StairLandingOccluder {
  readonly key: string;
  readonly landing: ResolvedStairLanding;
}

export interface RayQueryOptions {
  /** Include furniture, casework, kitchen counters & equipment in occlusion (default false for fast empty-space checks; true in detailed/surfaces modes). */
  readonly includeFurniture?: boolean;
  /** Include solid stair flights & mid-landings in occlusion (default true). */
  readonly includeStairs?: boolean;
  /** Include ceiling planes in occlusion (default false for electric ceiling fixtures; true for upward sky/daylight rays). */
  readonly includeCeilings?: boolean;
  /** Ignore self-occlusion by this specific partId (used when sampling top surface of a counter/desk). */
  readonly ignorePartId?: string;
}

export interface OcclusionIndex {
  readonly walls: readonly WallOccluder[];
  readonly columns: readonly ColumnOccluder[];
  readonly slabs: readonly SlabOccluder[];
  readonly furniture: readonly OrientedPartBox[];
  readonly stairFlights: readonly StairFlightOccluder[];
  readonly stairLandings: readonly StairLandingOccluder[];
  /**
   * Returns total visible light transmittance in `[0, 1]` along the 3D segment from A to B.
   * `0` = blocked by opaque wall/slab/column/stair/furniture; `(0, 1)` = attenuated through glazing;
   * `1` = clear unobstructed sightline.
   */
  rayTransmittance(ax: number, ay: number, az: number, bx: number, by: number, bz: number, options?: RayQueryOptions): number;
  /** Backward-compatible boolean helper (`true` when ray is fully blocked, transmittance <= 0.01). */
  isOccluded(ax: number, ay: number, az: number, bx: number, by: number, bz: number, options?: RayQueryOptions): boolean;
  /** True when the 3D point `(x, y, z)` lies strictly inside an opaque column, floor-standing furniture/casework box, or stair waist. */
  isPointInsideSolid(x: number, y: number, z: number, options?: RayQueryOptions): boolean;
}

const CELL_MM = 3000;
const EPS = 1e-4;
const WAIST_MM = 215;
const INDEX_CACHE = new WeakMap<ModelState["elements"], OcclusionIndex>();

function cellCoord(mm: number): number {
  return Math.floor(mm / CELL_MM);
}

function cellKey(cx: number, cy: number): number {
  return (cx + 10_000) * 20_001 + (cy + 10_000);
}

function pointInPolygon2D(px: number, py: number, poly: readonly Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function levelElevationMap(model: ModelState): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const level of elementsOfKind(model.elements, "level")) {
    map.set(level.id, level.elevationMm);
  }
  return map;
}

function resolveElementBaseZ(el: BimElement, levels: ReadonlyMap<string, number>, sortedLevels: readonly Level[]): number {
  if ("placement" in el && el.placement && "levelId" in el.placement) {
    const base = levels.get(el.placement.levelId) ?? 0;
    const offset = "startOffsetMm" in el.placement ? el.placement.startOffsetMm : "offsetMm" in el.placement ? el.placement.offsetMm : 0;
    return base + offset;
  }
  const levelName = el.partition?.level;
  if (levelName) {
    const lvl = findLevelByName(sortedLevels, levelName);
    if (lvl) return lvl.elevationMm;
  }
  return 0;
}

function wallVisibleTransmittance(model: ModelState, wall: Wall): number {
  const mat = resolveElementMaterial(model, wall);
  if (mat) {
    const t = materialTransmittance(mat);
    if (t > 0) return t;
    if (isGlazingMaterial(mat)) return 0.68;
  }
  const wt = wall.wallType.toLowerCase();
  if (/\b(curtain|storefront)\b/.test(wt)) return 0.68;
  if (/\b(glass|glazed|window\s*wall)\b/.test(wt)) return 0.78;
  const wallFn = wall.values?.["architecture.wall_function"];
  if (typeof wallFn === "string" && wallFn.toUpperCase() === "CURTAIN") return 0.68;
  return 0;
}

function openingVisibleTransmittance(model: ModelState, opening: Opening): number {
  const t = String(opening.openingType).toLowerCase();
  if (t === "cased_opening" || t === "opening") return 1.0;
  if (t === "window" || t === "skylight") {
    const mat = resolveElementMaterial(model, opening);
    const mt = materialTransmittance(mat);
    return mt > 0 ? mt : 0.78;
  }
  // Glass doors transmit light; opaque flush doors block light between closed rooms
  const mat = resolveElementMaterial(model, opening);
  if (mat && isGlazingMaterial(mat)) return materialTransmittance(mat) || 0.72;
  return 0;
}

function buildOcclusionIndex(model: ModelState): OcclusionIndex {
  const levels = levelElevationMap(model);
  const sortedLevels: Level[] = [...elementsOfKind(model.elements, "level")].sort((a, b) => a.elevationMm - b.elevationMm);

  // 1. Group transparent/glazed openings by host wall ID
  const openingsByWall = new Map<string, WallOpeningCutout[]>();
  for (const op of elementsOfKind(model.elements, "opening")) {
    const transmittance = openingVisibleTransmittance(model, op);
    if (transmittance <= 0) continue;
    const host = model.elements[op.hostId];
    if (!host || host.kind !== "wall") continue;
    const baseZ = resolveElementBaseZ(host, levels, sortedLevels);
    const sillVal = op.values?.["opening.sill_mm"] ?? op.values?.["arch.sill_height"] ?? op.values?.sill_height;
    const sillMm = typeof sillVal === "number" && Number.isFinite(sillVal) ? sillVal : op.openingType === "window" ? 900 : 0;
    const halfW = op.width * 0.5;
    const cutout: WallOpeningCutout = {
      s0: op.offset - halfW,
      s1: op.offset + halfW,
      z0: baseZ + sillMm,
      z1: baseZ + sillMm + op.height,
      transmittance,
    };
    const list = openingsByWall.get(host.id);
    if (list) list.push(cutout);
    else openingsByWall.set(host.id, [cutout]);
  }

  // 2. Walls (including glazed curtain walls with realistic T_vis!)
  const walls: WallOccluder[] = [];
  const wallGrid = new Map<number, WallOccluder[]>();

  for (const wall of elementsOfKind(model.elements, "wall")) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const lengthMm = Math.hypot(dx, dy);
    if (lengthMm < 1) continue;
    const zMin = resolveElementBaseZ(wall, levels, sortedLevels);
    const zMax = zMin + Math.max(100, wall.height);
    const transmittance = wallVisibleTransmittance(model, wall);
    const occ: WallOccluder = {
      idx: walls.length,
      id: wall.id,
      x0: wall.start.x,
      y0: wall.start.y,
      x1: wall.end.x,
      y1: wall.end.y,
      dx,
      dy,
      lengthMm,
      zMin,
      zMax,
      minX: Math.min(wall.start.x, wall.end.x),
      maxX: Math.max(wall.start.x, wall.end.x),
      minY: Math.min(wall.start.y, wall.end.y),
      maxY: Math.max(wall.start.y, wall.end.y),
      transmittance,
      openings: openingsByWall.get(wall.id) ?? [],
    };
    walls.push(occ);
    for (let cx = cellCoord(occ.minX); cx <= cellCoord(occ.maxX); cx++) {
      for (let cy = cellCoord(occ.minY); cy <= cellCoord(occ.maxY); cy++) {
        const key = cellKey(cx, cy);
        const bucket = wallGrid.get(key);
        if (bucket) bucket.push(occ);
        else wallGrid.set(key, [occ]);
      }
    }
  }

  // 3. Structural columns
  const columns: ColumnOccluder[] = [];
  const colGrid = new Map<number, ColumnOccluder[]>();
  for (const col of elementsOfKind(model.elements, "column") as Iterable<Column>) {
    const zMin = resolveElementBaseZ(col, levels, sortedLevels);
    let zMax = zMin + 4000;
    if (col.placement && col.placement.kind === "line" && col.placement.topLevelId) {
      const topBase = levels.get(col.placement.topLevelId);
      if (topBase !== undefined) zMax = topBase + (col.placement.topOffsetMm ?? 0);
    } else {
      const nextLvl = sortedLevels.find((l) => l.elevationMm > zMin + 500);
      if (nextLvl) zMax = nextLvl.elevationMm;
    }
    const hw = Math.max(50, col.size.x * 0.5);
    const hd = Math.max(50, col.size.y * 0.5);
    const occ: ColumnOccluder = {
      idx: columns.length,
      id: col.id,
      minX: col.position.x - hw,
      maxX: col.position.x + hw,
      minY: col.position.y - hd,
      maxY: col.position.y + hd,
      zMin,
      zMax,
    };
    columns.push(occ);
    for (let cx = cellCoord(occ.minX); cx <= cellCoord(occ.maxX); cx++) {
      for (let cy = cellCoord(occ.minY); cy <= cellCoord(occ.maxY); cy++) {
        const key = cellKey(cx, cy);
        const bucket = colGrid.get(key);
        if (bucket) bucket.push(occ);
        else colGrid.set(key, [occ]);
      }
    }
  }

  // 4. Floor/roof slabs
  const slabs: SlabOccluder[] = [];
  for (const slab of elementsOfKind(model.elements, "slab") as Iterable<Slab>) {
    if (slab.outline.length < 3) continue;
    const zTop = resolveElementBaseZ(slab, levels, sortedLevels);
    const zBottom = zTop - Math.max(50, slab.thickness);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of slab.outline) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const holes: readonly (readonly Vec2[])[] =
      slab.placement && slab.placement.kind === "area" && slab.placement.holes ? slab.placement.holes : [];
    slabs.push({ id: slab.id, zBottom, zTop, minX, maxX, minY, maxY, outline: slab.outline, holes });
  }
  for (const ceil of elementsOfKind(model.elements, "ceiling") as Iterable<Ceiling>) {
    if (ceil.outline.length < 3 || ceil.role === "open_to_structure" || ceil.form === "open_to_structure") continue;
    const baseZ = levels.get(ceil.levelId) ?? 0;
    const zBottom = baseZ + ceil.heightMm;
    const zTop = zBottom + 40;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of ceil.outline) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    slabs.push({
      id: ceil.id,
      zBottom,
      zTop,
      minX,
      maxX,
      minY,
      maxY,
      outline: ceil.outline,
      holes: ceil.holes ?? [],
      isCeiling: true,
    });
  }
  // 4b. Architectural roofs (add-on element kind `architecture.roof`, flat or sloped)
  for (const el of Object.values(model.elements)) {
    const raw = el as unknown as {
      kind?: string;
      id?: string;
      levelId?: string;
      outline?: readonly Vec2[];
      thicknessMm?: number;
      baseOffsetMm?: number;
      slope?: { directionDeg: number; rise: number };
    };
    if (raw.kind !== "architecture.roof" || !Array.isArray(raw.outline) || raw.outline.length < 3) continue;
    const baseZ = (raw.levelId ? levels.get(raw.levelId) : undefined) ?? resolveElementBaseZ(el, levels, sortedLevels);
    const zBase = baseZ + (typeof raw.baseOffsetMm === "number" ? raw.baseOffsetMm : 0);
    const thick = typeof raw.thicknessMm === "number" && raw.thicknessMm > 10 ? raw.thicknessMm : 200;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of raw.outline) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    // For sloped shed/gable roofs, compute mean plane elevation above base so upward sky rays intersect accurately
    const spanMm = Math.max(maxX - minX, maxY - minY);
    const riseExtra = raw.slope && Number.isFinite(raw.slope.rise) ? Math.abs(raw.slope.rise) * spanMm * 0.35 : 0;
    slabs.push({
      id: raw.id ?? el.id,
      zBottom: zBase - thick,
      zTop: zBase + riseExtra + thick,
      minX,
      maxX,
      minY,
      maxY,
      outline: raw.outline,
      holes: [],
    });
  }

  // 5. Furniture, casework, kitchen counters & equipment oriented bounding boxes
  const { occluders: furniture } = extractPartPhotometrics(model);
  const furnGrid = new Map<number, { readonly idx: number; readonly box: OrientedPartBox }[]>();
  for (let fi = 0; fi < furniture.length; fi++) {
    const box = furniture[fi]!;
    const entry = { idx: fi, box };
    for (let cx = cellCoord(box.wMinX); cx <= cellCoord(box.wMaxX); cx++) {
      for (let cy = cellCoord(box.wMinY); cy <= cellCoord(box.wMaxY); cy++) {
        const key = cellKey(cx, cy);
        const bucket = furnGrid.get(key);
        if (bucket) bucket.push(entry);
        else furnGrid.set(key, [entry]);
      }
    }
  }

  // 6. Solid stair flights & mid-landings
  const stairs = extractStairs3D(model);
  const stairFlights: StairFlightOccluder[] = [];
  const stairLandings: StairLandingOccluder[] = [];
  for (const st of stairs) {
    for (const fl of st.flights) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of fl.outline) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      stairFlights.push({
        key: `${st.stairId}:f${fl.index}`,
        flight: fl,
        minX,
        maxX,
        minY,
        maxY,
        zMin: Math.min(fl.z0, fl.z1) - WAIST_MM,
        zMax: Math.max(fl.z0, fl.z1),
      });
    }
    for (const lnd of st.landings) {
      stairLandings.push({
        key: `${st.stairId}:l${lnd.index}`,
        landing: lnd,
      });
    }
  }

  // Zero-allocation integer generation stamps per ray query (replaces Set hashing/clearing)
  const wallStamp = new Uint32Array(walls.length);
  const colStamp = new Uint32Array(columns.length);
  const furnStamp = new Uint32Array(furniture.length);
  let queryStamp = 0;

  /** Returns transmittance multiplier in [0, 1] for this wall (`1` = missed, `0` = opaque hit, `(0,1)` = glass hit). */
  function wallRayTransmission(w: WallOccluder, ax: number, ay: number, az: number, rx: number, ry: number, rz: number): number {
    const denom = rx * w.dy - ry * w.dx;
    if (Math.abs(denom) < 1e-9) return 1;
    const qx = w.x0 - ax;
    const qy = w.y0 - ay;
    const t = (qx * w.dy - qy * w.dx) / denom;
    if (t <= EPS || t >= 1 - EPS) return 1;
    const u = (qx * ry - qy * rx) / denom;
    if (u < -EPS || u > 1 + EPS) return 1;

    const hitZ = az + t * rz;
    if (hitZ < w.zMin || hitZ > w.zMax) return 1;

    // Check openings cut into this wall first (window glass or open cased opening)
    if (w.openings.length > 0) {
      const s = u * w.lengthMm;
      for (const op of w.openings) {
        if (s >= op.s0 && s <= op.s1 && hitZ >= op.z0 && hitZ <= op.z1) {
          return op.transmittance;
        }
      }
    }
    return w.transmittance;
  }

  function rayHitsAabb(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
    ax: number,
    ay: number,
    az: number,
    rx: number,
    ry: number,
    rz: number,
  ): boolean {
    let tMin = EPS;
    let tMax = 1 - EPS;

    if (Math.abs(rx) < 1e-9) {
      if (ax < minX || ax > maxX) return false;
    } else {
      let tx1 = (minX - ax) / rx;
      let tx2 = (maxX - ax) / rx;
      if (tx1 > tx2) {
        const tmp = tx1;
        tx1 = tx2;
        tx2 = tmp;
      }
      if (tx1 > tMin) tMin = tx1;
      if (tx2 < tMax) tMax = tx2;
      if (tMin > tMax) return false;
    }

    if (Math.abs(ry) < 1e-9) {
      if (ay < minY || ay > maxY) return false;
    } else {
      let ty1 = (minY - ay) / ry;
      let ty2 = (maxY - ay) / ry;
      if (ty1 > ty2) {
        const tmp = ty1;
        ty1 = ty2;
        ty2 = tmp;
      }
      if (ty1 > tMin) tMin = ty1;
      if (ty2 < tMax) tMax = ty2;
      if (tMin > tMax) return false;
    }

    if (Math.abs(rz) < 1e-9) {
      if (az < minZ || az > maxZ) return false;
    } else {
      let tz1 = (minZ - az) / rz;
      let tz2 = (maxZ - az) / rz;
      if (tz1 > tz2) {
        const tmp = tz1;
        tz1 = tz2;
        tz2 = tmp;
      }
      if (tz1 > tMin) tMin = tz1;
      if (tz2 < tMax) tMax = tz2;
      if (tMin > tMax) return false;
    }

    return tMax >= tMin;
  }

  function rayHitsOrientedPart(b: OrientedPartBox, ax: number, ay: number, az: number, rx: number, ry: number, rz: number): boolean {
    // Transform segment endpoints into part-local frame
    const dax = ax - b.originX;
    const day = ay - b.originY;
    const lax = dax * b.cosNeg - day * b.sinNeg;
    const lay = dax * b.sinNeg + day * b.cosNeg;
    const laz = az - b.originZ;
    const lrx = rx * b.cosNeg - ry * b.sinNeg;
    const lry = rx * b.sinNeg + ry * b.cosNeg;
    // Shrink top Z slightly (15 mm) so points sitting directly on top of a surface don't graze-hit neighboring primitives
    return rayHitsAabb(b.lMinX, b.lMaxX, b.lMinY, b.lMaxY, b.lMinZ, b.lMaxZ - 15, lax, lay, laz, lrx, lry, rz);
  }

  /**
   * Intersect ray segment A -> B against a sloped stair flight waist slab:
   * Flight runs from `start` (`z0`) to `end` (`z1`) along unit `u` with width `widthMm`
   * and solid underside thickness `WAIST_MM` below the sloped tread surface.
   */
  function rayHitsStairFlight(occ: StairFlightOccluder, ax: number, ay: number, az: number, rx: number, ry: number, rz: number): boolean {
    const fl = occ.flight;
    // Plane of the sloped mid-waist: z(p) = z0 + ((p - start) · u) * slope - WAIST_MM * 0.5
    const slope = (fl.z1 - fl.z0) / Math.max(1, fl.runMm);
    const sA = (ax - fl.start.x) * fl.u.x + (ay - fl.start.y) * fl.u.y;
    const sR = rx * fl.u.x + ry * fl.u.y;
    // Check intersection with the plane 50 mm below the top tread nosing line (prevents tread self-occlusion!)
    const zPlaneA = fl.z0 + sA * slope - 50;
    const dzPlaneR = sR * slope;
    const denom = rz - dzPlaneR;
    if (Math.abs(denom) < 1e-6) return false;
    const t = (zPlaneA - az) / denom;
    if (t <= EPS || t >= 1 - EPS) return false;
    const hx = ax + t * rx;
    const hy = ay + t * ry;
    const sHit = (hx - fl.start.x) * fl.u.x + (hy - fl.start.y) * fl.u.y;
    if (sHit < 20 || sHit > fl.runMm - 20) return false;
    const wHit = (hx - fl.start.x) * fl.n.x + (hy - fl.start.y) * fl.n.y;
    return Math.abs(wHit) <= fl.widthMm * 0.5;
  }

  function rayTransmittance(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    options?: RayQueryOptions,
  ): number {
    const rx = bx - ax;
    const ry = by - ay;
    const rz = bz - az;
    let transmission = 1;

    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minY = Math.min(ay, by);
    const maxY = Math.max(ay, by);
    const zLo = Math.min(az, bz);
    const zHi = Math.max(az, bz);

    // 1. Intervening floor/roof slabs (and ceilings when `includeCeilings` is true, e.g. sky rays)
    const includeCeilings = options?.includeCeilings ?? false;
    if (slabs.length > 0 && Math.abs(rz) > 1) {
      for (let si = 0; si < slabs.length; si++) {
        const s = slabs[si]!;
        if (s.isCeiling && !includeCeilings) continue;
        if (s.zTop <= zLo + 20 || s.zBottom >= zHi - 20) continue;
        const zMid = (s.zBottom + s.zTop) * 0.5;
        const t = (zMid - az) / rz;
        if (t <= EPS || t >= 1 - EPS) continue;
        const hx = ax + t * rx;
        const hy = ay + t * ry;
        if (hx < s.minX || hx > s.maxX || hy < s.minY || hy > s.maxY) continue;
        if (!pointInPolygon2D(hx, hy, s.outline)) continue;
        let inHole = false;
        for (let hi = 0; hi < s.holes.length; hi++) {
          if (pointInPolygon2D(hx, hy, s.holes[hi]!)) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return 0;
      }
    }

    // 2. Solid stair flights & mid-landings (upper flights shadow lower flights & under-stair space)
    const includeStairs = options?.includeStairs ?? true;
    if (includeStairs && (stairFlights.length > 0 || stairLandings.length > 0)) {
      for (const lnd of stairLandings) {
        const l = lnd.landing;
        if (l.zTop <= zLo + 25 || l.zBot >= zHi - 25) continue;
        if (l.maxX < minX || l.minX > maxX || l.maxY < minY || l.minY > maxY) continue;
        if (Math.abs(rz) < 1) continue;
        const zMid = l.zTop - 60;
        const t = (zMid - az) / rz;
        if (t <= EPS || t >= 1 - EPS) continue;
        const hx = ax + t * rx;
        const hy = ay + t * ry;
        if (hx < l.minX || hx > l.maxX || hy < l.minY || hy > l.maxY) continue;
        if (pointInPolygon2D(hx, hy, l.outline)) return 0;
      }
      for (const fl of stairFlights) {
        if (fl.maxX < minX || fl.minX > maxX || fl.maxY < minY || fl.minY > maxY) continue;
        if (fl.zMax < zLo + 25 || fl.zMin > zHi - 25) continue;
        if (rayHitsStairFlight(fl, ax, ay, az, rx, ry, rz)) return 0;
      }
    }

    // 3. Walls, columns, and optional furniture/casework boxes via 2D spatial hash + zero-alloc stamp
    const includeFurniture = options?.includeFurniture ?? false;
    const ignorePartId = options?.ignorePartId;

    queryStamp = (queryStamp + 1) >>> 0;
    if (queryStamp === 0) {
      wallStamp.fill(0);
      colStamp.fill(0);
      furnStamp.fill(0);
      queryStamp = 1;
    }
    const stamp = queryStamp;

    const visitCell = (cx: number, cy: number): boolean => {
      const key = cellKey(cx, cy);
      const wBucket = wallGrid.get(key);
      if (wBucket) {
        for (let i = 0; i < wBucket.length; i++) {
          const w = wBucket[i]!;
          if (wallStamp[w.idx] === stamp) continue;
          wallStamp[w.idx] = stamp;
          if (w.maxX < minX || w.minX > maxX || w.maxY < minY || w.minY > maxY) continue;
          if (w.zMax < zLo || w.zMin > zHi) continue;
          const wt = wallRayTransmission(w, ax, ay, az, rx, ry, rz);
          if (wt <= 0.01) {
            transmission = 0;
            return false;
          }
          if (wt < 1) {
            transmission *= wt;
            if (transmission <= 0.01) {
              transmission = 0;
              return false;
            }
          }
        }
      }
      const cBucket = colGrid.get(key);
      if (cBucket) {
        for (let i = 0; i < cBucket.length; i++) {
          const c = cBucket[i]!;
          if (colStamp[c.idx] === stamp) continue;
          colStamp[c.idx] = stamp;
          if (c.maxX < minX || c.minX > maxX || c.maxY < minY || c.minY > maxY) continue;
          if (c.zMax < zLo || c.zMin > zHi) continue;
          if (rayHitsAabb(c.minX, c.maxX, c.minY, c.maxY, c.zMin, c.zMax, ax, ay, az, rx, ry, rz)) {
            transmission = 0;
            return false;
          }
        }
      }
      if (includeFurniture) {
        const fBucket = furnGrid.get(key);
        if (fBucket) {
          for (let i = 0; i < fBucket.length; i++) {
            const entry = fBucket[i]!;
            if (furnStamp[entry.idx] === stamp) continue;
            furnStamp[entry.idx] = stamp;
            const f = entry.box;
            if (ignorePartId && f.partId === ignorePartId) continue;
            if (f.wMaxX < minX || f.wMinX > maxX || f.wMaxY < minY || f.wMinY > maxY) continue;
            if (f.wMaxZ < zLo || f.wMinZ > zHi) continue;
            if (rayHitsOrientedPart(f, ax, ay, az, rx, ry, rz)) {
              if (f.transmittance <= 0.01) {
                transmission = 0;
                return false;
              }
              transmission *= f.transmittance;
              if (transmission <= 0.01) {
                transmission = 0;
                return false;
              }
            }
          }
        }
      }
      return true;
    };

    const startCx = cellCoord(ax);
    const startCy = cellCoord(ay);
    const endCx = cellCoord(bx);
    const endCy = cellCoord(by);
    const spanX = Math.abs(endCx - startCx);
    const spanY = Math.abs(endCy - startCy);

    if (spanX <= 1 && spanY <= 1) {
      const cx0 = Math.min(startCx, endCx);
      const cx1 = Math.max(startCx, endCx);
      const cy0 = Math.min(startCy, endCy);
      const cy1 = Math.max(startCy, endCy);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          if (!visitCell(cx, cy)) return 0;
        }
      }
    } else {
      // 2D Amanatides-Woo DDA grid traversal — visits only cells pierced by the ray (O(L) instead of O(L²))
      let cx = startCx;
      let cy = startCy;
      const stepX = rx >= 0 ? 1 : -1;
      const stepY = ry >= 0 ? 1 : -1;
      const tDeltaX = Math.abs(rx) > 1e-6 ? CELL_MM / Math.abs(rx) : Infinity;
      const tDeltaY = Math.abs(ry) > 1e-6 ? CELL_MM / Math.abs(ry) : Infinity;
      let tMaxX =
        Math.abs(rx) > 1e-6
          ? ((rx > 0 ? (cx + 1) * CELL_MM : cx * CELL_MM) - ax) / rx
          : Infinity;
      let tMaxY =
        Math.abs(ry) > 1e-6
          ? ((ry > 0 ? (cy + 1) * CELL_MM : cy * CELL_MM) - ay) / ry
          : Infinity;
      const maxSteps = spanX + spanY + 3;
      for (let step = 0; step < maxSteps; step++) {
        if (!visitCell(cx, cy)) return 0;
        if (cx === endCx && cy === endCy) break;
        if (tMaxX < tMaxY) {
          if (tMaxX > 1 + EPS) break;
          tMaxX += tDeltaX;
          cx += stepX;
        } else {
          if (tMaxY > 1 + EPS) break;
          tMaxY += tDeltaY;
          cy += stepY;
        }
      }
    }

    return transmission;
  }

  function isOccluded(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    options?: RayQueryOptions,
  ): boolean {
    return rayTransmittance(ax, ay, az, bx, by, bz, options) <= 0.01;
  }

  function isPointInsideSolid(x: number, y: number, z: number, options?: RayQueryOptions): boolean {
    const key = cellKey(cellCoord(x), cellCoord(y));
    const cBucket = colGrid.get(key);
    if (cBucket) {
      for (const c of cBucket) {
        if (x >= c.minX && x <= c.maxX && y >= c.minY && y <= c.maxY && z >= c.zMin && z <= c.zMax) return true;
      }
    }
    if (options?.includeFurniture) {
      const fBucket = furnGrid.get(key);
      if (fBucket) {
        for (const entry of fBucket) {
          const f = entry.box;
          if (options.ignorePartId && f.partId === options.ignorePartId) continue;
          if (f.transmittance > 0.01) continue;
          if (x < f.wMinX || x > f.wMaxX || y < f.wMinY || y > f.wMaxY) continue;
          // Exclude floor-plane egress points occupied by solid floor-resting cabinets/islands/equipment
          // (where the cabinet carcass reaches down to within 150 mm of the floor AND spans above `z`),
          // OR points strictly inside any solid box `[zMin..zMax]`.
          const dx = x - f.originX;
          const dy = y - f.originY;
          const lx = dx * f.cosNeg - dy * f.sinNeg;
          const ly = dx * f.sinNeg + dy * f.cosNeg;
          if (lx < f.lMinX || lx > f.lMaxX || ly < f.lMinY || ly > f.lMaxY) continue;
          const lz = z - f.originZ;
          const insideZ = lz >= f.lMinZ - 10 && lz <= f.lMaxZ - 15;
          const solidFloorCarcass = lz <= 100 && f.lMinZ <= 200 && f.lMaxZ >= 400;
          if (insideZ || solidFloorCarcass) return true;
        }
      }
    }
    if (options?.includeStairs !== false) {
      // Exclude room floor/workplane points falling within a stair's 2D footprint on the stair's base storey
      // so the surrounding room grid never double-prints flat numbers on top of the true 3D stair tread evaluation.
      for (const fl of stairFlights) {
        if (x < fl.minX || x > fl.maxX || y < fl.minY || y > fl.maxY) continue;
        const f = fl.flight;
        const s = (x - f.start.x) * f.u.x + (y - f.start.y) * f.u.y;
        if (s < -150 || s > f.runMm + 150) continue;
        const w = (x - f.start.x) * f.n.x + (y - f.start.y) * f.n.y;
        if (Math.abs(w) > f.widthMm * 0.5 + 100) continue;
        if (z <= Math.max(f.z0, f.z1) + 50 && z >= Math.min(f.z0, f.z1) - 1200) return true;
      }
      for (const lnd of stairLandings) {
        const l = lnd.landing;
        if (x < l.minX - 100 || x > l.maxX + 100 || y < l.minY - 100 || y > l.maxY + 100) continue;
        if (!pointInPolygon2D(x, y, l.outline)) continue;
        if (z <= l.zTop + 50 && z >= l.zTop - 3200) return true;
      }
    }
    return false;
  }

  return { walls, columns, slabs, furniture, stairFlights, stairLandings, rayTransmittance, isOccluded, isPointInsideSolid };
}

/** Return the memoized occlusion & glazing-transmittance index for `model`. */
export function occlusionIndexOf(model: ModelState): OcclusionIndex {
  let hit = INDEX_CACHE.get(model.elements);
  if (!hit) {
    hit = buildOcclusionIndex(model);
    INDEX_CACHE.set(model.elements, hit);
  }
  return hit;
}
