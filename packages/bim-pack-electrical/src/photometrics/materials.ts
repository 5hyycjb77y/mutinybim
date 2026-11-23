import {
  elementsOfKind,
  findLevelByName,
  parseHexColor,
  resolveElementMaterial,
  type BimElement,
  type Ceiling,
  type Level,
  type MaterialDef,
  type ModelState,
  type PartInstance,
  type PartTypeElement,
  type Slab,
  type Vec2,
  type Wall,
} from "@permitzip/bim-kernel";
import type { RoomReflectances } from "./standards";
import { DEFAULT_ROOM_REFLECTANCES } from "./standards";

/**
 * Material-library reflectance (LRV), glazing visible transmittance, oriented
 * furniture/casework occlusion bounds, and horizontal task-surface extraction
 * (kitchen counters, islands, worktables, conference tables, vanities) for
 * physically realistic photometric analysis.
 */

const FT_MM = 304.8;
const IN_MM = 25.4;
const SQMM_PER_SQFT = FT_MM * FT_MM;

function srgbChannelToLinear(c8: number): number {
  const c = Math.max(0, Math.min(1, c8 / 255));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Convert a `#rrggbb` sRGB hex color to physical Light Reflectance Value (LRV)
 * in linear luminance space (`0.2126 R + 0.7152 G + 0.0722 B`), clamped to
 * realistic architectural reflectance bounds `[0.04, 0.92]`.
 */
export function hexColorToLrv(hex: string | undefined | null, fallback = 0.5): number {
  if (!hex || typeof hex !== "string") return fallback;
  const rgb = parseHexColor(hex);
  if (rgb === null) return fallback;
  const r = srgbChannelToLinear((rgb >> 16) & 0xff);
  const g = srgbChannelToLinear((rgb >> 8) & 0xff);
  const b = srgbChannelToLinear(rgb & 0xff);
  const lrv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return Math.max(0.04, Math.min(0.92, Number(lrv.toFixed(4))));
}

/** True when a MaterialDef represents transparent or translucent glazing. */
export function isGlazingMaterial(mat: MaterialDef | null | undefined): boolean {
  if (!mat) return false;
  if (mat.category === "glazing" || mat.pattern === "glass") return true;
  if (typeof mat.opacity === "number" && mat.opacity < 0.88) return true;
  return /\b(glass|glazing|storefront|curtain)\b/i.test(`${mat.id} ${mat.name}`);
}

/**
 * Visible light transmittance `T_vis` in `[0, 1]` for a material.
 * Prefers explicit `kernel.material` `visibleTransmittance`, falling back to
 * glazing category/opacity heuristics (`0` for opaque materials).
 */
export function materialTransmittance(mat: MaterialDef | null | undefined): number {
  if (!mat) return 0;
  if (typeof mat.visibleTransmittance === "number" && Number.isFinite(mat.visibleTransmittance)) {
    return Math.max(0, Math.min(1, Number(mat.visibleTransmittance.toFixed(3))));
  }
  if (!isGlazingMaterial(mat)) return 0;
  const idLower = `${mat.id} ${mat.name}`.toLowerCase();
  if (/low[-_\s]?e|curtain/.test(idLower)) return 0.68;
  if (/frost|translucent|etched|spandrel/.test(idLower)) return 0.42;
  if (/clear/.test(idLower)) return 0.82;
  if (typeof mat.opacity === "number" && Number.isFinite(mat.opacity)) {
    return Math.max(0.25, Math.min(0.85, Number((1 - mat.opacity * 0.72).toFixed(3))));
  }
  return 0.72;
}

/**
 * Diffuse interior surface reflectance (`0.04 .. 0.92`) derived from a material's
 * explicit `kernel.material` `reflectance` (LRV) when authored, otherwise from its
 * library color, roughness, metalness, and glazing transmittance.
 *
 * At night/interior lighting conditions, transparent glazing has low interior
 * diffuse reflectance (~0.08-0.10) because light transmits outward rather than bouncing back.
 */
export function materialReflectance(mat: MaterialDef | null | undefined, fallback: number): number {
  if (!mat) return fallback;
  if (typeof mat.reflectance === "number" && Number.isFinite(mat.reflectance)) {
    return Math.max(0.04, Math.min(0.92, Number(mat.reflectance.toFixed(3))));
  }
  if (isGlazingMaterial(mat)) return 0.1;
  const base = hexColorToLrv(mat.color, fallback);
  // High-metalness bare metals reflect specularly rather than diffusely in a cavity model
  const metalFactor = typeof mat.metalness === "number" ? 1 - 0.25 * Math.max(0, Math.min(1, mat.metalness)) : 1;
  return Math.max(0.04, Math.min(0.92, Number((base * metalFactor).toFixed(3))));
}

export interface DerivedRoomReflectances extends RoomReflectances {
  readonly source: "explicit" | "materials" | "default";
  readonly ceilingMaterial?: string;
  readonly wallMaterials?: readonly string[];
  readonly floorMaterial?: string;
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

function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  if (poly.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of poly) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / poly.length, y: sy / poly.length };
}

function distPointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function resolveLevelZ(el: BimElement, levels: ReadonlyMap<string, number>, sortedLevels: readonly Level[]): number {
  if ("placement" in el && el.placement && "levelId" in el.placement) {
    const base = levels.get(el.placement.levelId) ?? 0;
    const off = "startOffsetMm" in el.placement ? el.placement.startOffsetMm : "offsetMm" in el.placement ? el.placement.offsetMm : 0;
    return base + off;
  }
  const levelName = el.partition?.level;
  if (levelName) {
    const lvl = findLevelByName(sortedLevels, levelName);
    if (lvl) return lvl.elevationMm;
  }
  return 0;
}

/**
 * Derive physical ceiling/wall/floor reflectances for a room polygon from the
 * actual Materials Library assignments on its bounding walls, ceiling, and slab.
 */
export function deriveSpaceReflectances(
  model: ModelState,
  outline: readonly Vec2[],
  levelId: string,
  levelElevationMm: number,
  ceilingHeightMm: number,
  fallback: RoomReflectances = DEFAULT_ROOM_REFLECTANCES,
): DerivedRoomReflectances {
  const levels = new Map<string, number>();
  const sortedLevels: Level[] = [];
  for (const l of elementsOfKind(model.elements, "level")) {
    levels.set(l.id, l.elevationMm);
    sortedLevels.push(l);
  }
  sortedLevels.sort((a, b) => a.elevationMm - b.elevationMm);

  const centroid = polygonCentroid(outline);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  let matchedAny = false;

  // 1. Floor reflectance from slab covering centroid at this level elevation
  let rhoFloor = fallback.floor;
  let floorMaterial: string | undefined;
  for (const slab of elementsOfKind(model.elements, "slab") as Iterable<Slab>) {
    const zTop = resolveLevelZ(slab, levels, sortedLevels);
    if (Math.abs(zTop - levelElevationMm) > 450) continue;
    if (slab.outline.length < 3 || !pointInPolygon2D(centroid.x, centroid.y, slab.outline)) continue;
    const mat = resolveElementMaterial(model, slab);
    if (mat) {
      rhoFloor = materialReflectance(mat, fallback.floor);
      floorMaterial = mat.name;
      matchedAny = true;
      break;
    }
  }

  // 2. Ceiling reflectance from overlapping ceiling element (or slab above)
  let rhoCeiling = fallback.ceiling;
  let ceilingMaterial: string | undefined;
  for (const clg of elementsOfKind(model.elements, "ceiling") as Iterable<Ceiling>) {
    const sameLevel = clg.placement?.levelId === levelId;
    const z = resolveLevelZ(clg, levels, sortedLevels);
    if (!sameLevel && Math.abs(z - levelElevationMm) > 450) continue;
    if (clg.outline.length < 3 || !pointInPolygon2D(centroid.x, centroid.y, clg.outline)) continue;
    const mat = resolveElementMaterial(model, clg);
    if (mat) {
      rhoCeiling = materialReflectance(mat, fallback.ceiling);
      ceilingMaterial = mat.name;
      matchedAny = true;
      break;
    }
  }
  if (!ceilingMaterial) {
    // Check slab directly overhead (exposed concrete/oak underside)
    const ceilingZ = levelElevationMm + ceilingHeightMm;
    for (const slab of elementsOfKind(model.elements, "slab") as Iterable<Slab>) {
      const zTop = resolveLevelZ(slab, levels, sortedLevels);
      if (Math.abs(zTop - ceilingZ) > 900) continue;
      if (slab.outline.length < 3 || !pointInPolygon2D(centroid.x, centroid.y, slab.outline)) continue;
      const mat = resolveElementMaterial(model, slab);
      if (mat) {
        rhoCeiling = materialReflectance(mat, fallback.ceiling);
        ceilingMaterial = mat.name;
        matchedAny = true;
        break;
      }
    }
  }

  // 3. Wall reflectance: length-weighted average over walls bounding or bordering this room
  let wallWeightSum = 0;
  let wallReflSum = 0;
  const wallNames = new Set<string>();
  const margin = 450; // mm tolerance from room polygon boundary
  for (const wall of elementsOfKind(model.elements, "wall") as Iterable<Wall>) {
    const zMin = resolveLevelZ(wall, levels, sortedLevels);
    const zMax = zMin + Math.max(100, wall.height);
    if (zMax < levelElevationMm + 300 || zMin > levelElevationMm + ceilingHeightMm) continue;
    const wMinX = Math.min(wall.start.x, wall.end.x);
    const wMaxX = Math.max(wall.start.x, wall.end.x);
    const wMinY = Math.min(wall.start.y, wall.end.y);
    const wMaxY = Math.max(wall.start.y, wall.end.y);
    if (wMaxX < minX - margin || wMinX > maxX + margin || wMaxY < minY - margin || wMinY > maxY + margin) continue;

    // Sample 3 points along the wall to measure overlap with the room perimeter
    let touching = 0;
    for (const t of [0.2, 0.5, 0.8]) {
      const wx = wall.start.x + (wall.end.x - wall.start.x) * t;
      const wy = wall.start.y + (wall.end.y - wall.start.y) * t;
      let nearEdge = false;
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i]!;
        const b = outline[(i + 1) % outline.length]!;
        if (distPointToSegment(wx, wy, a.x, a.y, b.x, b.y) <= margin) {
          nearEdge = true;
          break;
        }
      }
      if (nearEdge || pointInPolygon2D(wx, wy, outline)) touching++;
    }
    if (touching === 0) continue;

    const segLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y) * (touching / 3);
    const mat = resolveElementMaterial(model, wall);
    const isGlazed =
      isGlazingMaterial(mat) || /\b(glass|glazed|curtain|storefront|window\s*wall)\b/i.test(wall.wallType);
    const r = isGlazed ? 0.1 : mat ? materialReflectance(mat, fallback.wall) : fallback.wall;
    wallReflSum += r * segLen;
    wallWeightSum += segLen;
    if (mat) {
      wallNames.add(mat.name);
      matchedAny = true;
    } else if (isGlazed) {
      wallNames.add("Glazing");
      matchedAny = true;
    }
  }

  const rhoWall = wallWeightSum > 100 ? Number((wallReflSum / wallWeightSum).toFixed(3)) : fallback.wall;

  return {
    ceiling: rhoCeiling,
    wall: rhoWall,
    floor: rhoFloor,
    source: matchedAny ? "materials" : "default",
    ...(ceilingMaterial ? { ceilingMaterial } : {}),
    ...(wallNames.size > 0 ? { wallMaterials: [...wallNames].sort() } : {}),
    ...(floorMaterial ? { floorMaterial } : {}),
  };
}

// ---------------------------------------------------------------------------
// 3D Part Bounding Boxes (Furniture / Casework / Equipment Occluders) &
// Horizontal Task Surfaces (Kitchen Counters, Islands, Worktables, Vanities)
// ---------------------------------------------------------------------------

export interface OrientedPartBox {
  readonly partId: string;
  readonly name: string;
  readonly category: string;
  /** World origin of the part's local frame (mm). */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  /** Precomputed cos/sin of `-rotationRad` for fast world->local transform. */
  readonly cosNeg: number;
  readonly sinNeg: number;
  /** Local AABB extents in mm. */
  readonly lMinX: number;
  readonly lMaxX: number;
  readonly lMinY: number;
  readonly lMaxY: number;
  readonly lMinZ: number;
  readonly lMaxZ: number;
  /** World AABB extents in mm (for broadphase spatial hash). */
  readonly wMinX: number;
  readonly wMaxX: number;
  readonly wMinY: number;
  readonly wMaxY: number;
  readonly wMinZ: number;
  readonly wMaxZ: number;
  /** Material visible transmittance (`0` = opaque, `>0` = glass table/divider). */
  readonly transmittance: number;
  /** Surface diffuse reflectance from Materials Library. */
  readonly reflectance: number;
}

export type TaskSurfaceKind = "kitchen_counter" | "island" | "worktable" | "conference_table" | "vanity" | "casework";

export interface ExtractedTaskSurface {
  readonly partId: string;
  readonly name: string;
  readonly surfaceKind: TaskSurfaceKind;
  readonly levelId: string;
  readonly levelName: string;
  readonly levelElevationMm: number;
  /** World top surface elevation in mm (e.g. levelZ + 36" for kitchen counter). */
  readonly zMm: number;
  /** Height of the top surface above the finished floor in inches. */
  readonly heightAffIn: number;
  /** World 2D footprint polygon of the horizontal work surface (4 corners, CCW). */
  readonly outline: readonly Vec2[];
  readonly rotationDeg: number;
  readonly widthMm: number;
  readonly depthMm: number;
  readonly areaSqFt: number;
  /** Recommended IES / FDA task illuminance target (fc). */
  readonly targetAvgFc: number;
  readonly targetMinFc: number;
  readonly reflectance: number;
  readonly materialName?: string;
}

const EXCLUDED_OCCLUDER_CATEGORIES = new Set([
  "lighting_fixture",
  "electrical_device",
  "fire_alarm",
  "air_terminal",
  "sprinkler",
  "plumbing_accessory",
  "sensor",
]);

interface LocalPrimitiveBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function resolveDim(
  v: unknown,
  vals: Readonly<Record<string, unknown>>,
): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object" && "param" in v) {
    const p = v as { readonly param: string; readonly scale?: number; readonly add?: number };
    const raw = vals[p.param];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw * (p.scale ?? 1) + (p.add ?? 0);
    }
  }
  return null;
}

function localBoxesFromPartType(pt: PartTypeElement, instanceValues?: Readonly<Record<string, unknown>>): LocalPrimitiveBox[] {
  const boxes: LocalPrimitiveBox[] = [];
  const geom = pt.definition.geometry;
  const vals: Record<string, unknown> = { ...(pt.definition.typeValues ?? {}), ...(instanceValues ?? {}) };
  if (Array.isArray(geom)) {
    for (const p of geom) {
      if (p.kind === "box") {
        const cx = resolveDim(p.center[0], vals);
        const cy = resolveDim(p.center[1], vals);
        const cz = resolveDim(p.center[2], vals);
        const sx = resolveDim(p.size[0], vals);
        const sy = resolveDim(p.size[1], vals);
        const sz = resolveDim(p.size[2], vals);
        if (cx === null || cy === null || cz === null || sx === null || sy === null || sz === null) continue;
        boxes.push({
          minX: cx - sx * 0.5,
          maxX: cx + sx * 0.5,
          minY: cy - sy * 0.5,
          maxY: cy + sy * 0.5,
          minZ: cz - sz * 0.5,
          maxZ: cz + sz * 0.5,
        });
      } else if (p.kind === "cylinder") {
        const cx = resolveDim(p.center[0], vals);
        const cy = resolveDim(p.center[1], vals);
        const cz = resolveDim(p.center[2], vals);
        const r = resolveDim(p.radius, vals);
        const hFull = resolveDim(p.height, vals);
        if (cx === null || cy === null || cz === null || r === null || hFull === null) continue;
        const h = hFull * 0.5;
        if (p.axis === "x") {
          boxes.push({ minX: cx - h, maxX: cx + h, minY: cy - r, maxY: cy + r, minZ: cz - r, maxZ: cz + r });
        } else if (p.axis === "y") {
          boxes.push({ minX: cx - r, maxX: cx + r, minY: cy - h, maxY: cy + h, minZ: cz - r, maxZ: cz + r });
        } else {
          boxes.push({ minX: cx - r, maxX: cx + r, minY: cy - r, maxY: cy + r, minZ: cz - h, maxZ: cz + h });
        }
      }
    }
  }
  return boxes;
}

function unionBoxes(boxes: readonly LocalPrimitiveBox[]): LocalPrimitiveBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const b of boxes) {
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxY > maxY) maxY = b.maxY;
    if (b.minZ < minZ) minZ = b.minZ;
    if (b.maxZ > maxZ) maxZ = b.maxZ;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function classifyTaskSurface(label: string, heightAffIn: number): { kind: TaskSurfaceKind; targetAvgFc: number; targetMinFc: number } | null {
  const s = label.toLowerCase();
  // Exclude pure MEP/plumbing equipment and sinks (countertops themselves carry the task surface)
  if (/\b(panel|transformer|rtu|ahu|vav|fan|water\s*heater|toilet|urinal|sink|lavatory|faucet|manhole|pump|compressor|switchgear)\b/.test(s)) {
    return null;
  }
  if (/\b(kitchen|kitchenette|prep\s*table|food\s*prep|cook|galley)\b/.test(s)) {
    // FDA Food Code §6-303.11 & IES Handbook: 50 fc on food prep countertops
    return { kind: "kitchen_counter", targetAvgFc: 50, targetMinFc: 20 };
  }
  if (/\b(island|cafe|café|bar\s*counter|breakfast\s*bar|countertop|counter)\b/.test(s)) {
    return { kind: "island", targetAvgFc: 30, targetMinFc: 10 };
  }
  if (/\b(vanity)\b/.test(s)) {
    return { kind: "vanity", targetAvgFc: 20, targetMinFc: 6 };
  }
  if (/\b(conference|boardroom|meeting\s*table)\b/.test(s)) {
    return { kind: "conference_table", targetAvgFc: 30, targetMinFc: 10 };
  }
  if (/\b(desk|worktable|drafting|workstation|bench|table|plotter|reception\s*desk)\b/.test(s)) {
    return { kind: "worktable", targetAvgFc: 30, targetMinFc: 10 };
  }
  if (/\b(casework|cabinet|credenza)\b/.test(s) && heightAffIn >= 26 && heightAffIn <= 44) {
    return { kind: "casework", targetAvgFc: 30, targetMinFc: 10 };
  }
  return null;
}

function rotatePoint2D(lx: number, ly: number, ox: number, oy: number, cosR: number, sinR: number): Vec2 {
  return {
    x: ox + lx * cosR - ly * sinR,
    y: oy + lx * sinR + ly * cosR,
  };
}

export interface PartPhotometricExtraction {
  readonly occluders: readonly OrientedPartBox[];
  readonly taskSurfaces: readonly ExtractedTaskSurface[];
}

const PART_EXTRACT_CACHE = new WeakMap<ModelState["elements"], PartPhotometricExtraction>();

/**
 * Extract oriented 3D occluder boxes (furniture, casework, kitchen counters,
 * upper cabinets, tables, equipment) AND horizontal task surfaces from all
 * placed `part` elements in `model`.
 */
export function extractPartPhotometrics(model: ModelState): PartPhotometricExtraction {
  const cached = PART_EXTRACT_CACHE.get(model.elements);
  if (cached) return cached;

  const levelsById = new Map<string, Level>();
  const sortedLevels: Level[] = [];
  for (const lvl of elementsOfKind(model.elements, "level")) {
    levelsById.set(lvl.id, lvl);
    sortedLevels.push(lvl);
  }
  sortedLevels.sort((a, b) => a.elevationMm - b.elevationMm);

  const occluders: OrientedPartBox[] = [];
  const taskSurfaces: ExtractedTaskSurface[] = [];

  for (const part of elementsOfKind(model.elements, "part") as Iterable<PartInstance>) {
    const pt = model.elements[part.typeId];
    if (!pt || pt.kind !== "part_type") continue;
    const category = pt.definition.category ?? "generic";
    if (EXCLUDED_OCCLUDER_CATEGORIES.has(category)) continue;

    // Skip anything that looks like a luminaire or switch/receptacle even if categorized generic
    const fullName = `${pt.definition.familyName} ${pt.definition.typeName} ${part.mark ?? ""}`;
    if (/\b(troffer|downlight|luminaire|sconce|pendant|exit\s*sign|receptacle|switch|thermostat|diffuser|grille)\b/i.test(fullName)) {
      continue;
    }

    const primBoxes = localBoxesFromPartType(pt, part.values);
    const union = unionBoxes(primBoxes);
    if (!union) continue;

    const sx = union.maxX - union.minX;
    const sy = union.maxY - union.minY;
    const sz = union.maxZ - union.minZ;
    // Ignore tiny accessories (< 200 mm in both plan axes or < 40 mm tall)
    if ((sx < 200 && sy < 200) || sz < 40) continue;

    const lvl =
      (part.levelId ? levelsById.get(part.levelId) : undefined) ??
      (part.partition?.level ? findLevelByName(sortedLevels, part.partition.level) : undefined) ??
      sortedLevels[0];
    const levelElevationMm = lvl?.elevationMm ?? 0;
    const partOffsetMm = part.offsetMm ?? 0;
    const originX = part.position.x;
    const originY = part.position.y;
    const originZ = levelElevationMm + partOffsetMm;

    const rotDeg = part.rotationDeg ?? 0;
    const rotRad = (rotDeg * Math.PI) / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    const cosNeg = cosR;
    const sinNeg = -sinR;

    const mat = resolveElementMaterial(model, part);
    const transmittance = materialTransmittance(mat);
    const reflectance = materialReflectance(mat, 0.35);

    // Emit individual solid boxes for detailed furniture (e.g. table top vs open leg space,
    // vanity deck vs ADA open knee space, cabinet carcass vs counter) when <= 8 primitives;
    // otherwise use the union box so ray queries stay fast.
    const solidBoxes = primBoxes.length <= 8 ? primBoxes : [union];
    for (const b of solidBoxes) {
      if (b.maxX - b.minX < 80 && b.maxY - b.minY < 80) continue;
      if (b.maxZ - b.minZ < 20) continue;
      const c0 = rotatePoint2D(b.minX, b.minY, originX, originY, cosR, sinR);
      const c1 = rotatePoint2D(b.maxX, b.minY, originX, originY, cosR, sinR);
      const c2 = rotatePoint2D(b.maxX, b.maxY, originX, originY, cosR, sinR);
      const c3 = rotatePoint2D(b.minX, b.maxY, originX, originY, cosR, sinR);
      const wMinX = Math.min(c0.x, c1.x, c2.x, c3.x);
      const wMaxX = Math.max(c0.x, c1.x, c2.x, c3.x);
      const wMinY = Math.min(c0.y, c1.y, c2.y, c3.y);
      const wMaxY = Math.max(c0.y, c1.y, c2.y, c3.y);
      occluders.push({
        partId: part.id,
        name: pt.definition.typeName || pt.definition.familyName,
        category,
        originX,
        originY,
        originZ,
        cosNeg,
        sinNeg,
        lMinX: b.minX,
        lMaxX: b.maxX,
        lMinY: b.minY,
        lMaxY: b.maxY,
        lMinZ: b.minZ,
        lMaxZ: b.maxZ,
        wMinX,
        wMaxX,
        wMinY,
        wMaxY,
        wMinZ: originZ + b.minZ,
        wMaxZ: originZ + b.maxZ,
        transmittance,
        reflectance,
      });
    }

    // Detect horizontal task work surface (countertop, island, desk, vanity, conference table)
    // Pick the dominant broad horizontal deck box (ignoring thin backsplashes!) so e.g.
    // a vanity with a 4" backsplash reports the deck height (34" AFF), not the backsplash lip (38").
    const deckCandidates = primBoxes.filter((b) => {
      const bw = b.maxX - b.minX;
      const bd = b.maxY - b.minY;
      const bh = b.maxZ - b.minZ;
      const zAffIn = (partOffsetMm + b.maxZ) / IN_MM;
      return bw >= 250 && bd >= 250 && bh <= 1050 && zAffIn >= 24 && zAffIn <= 45;
    });
    const deckTopLocalZ =
      deckCandidates.length > 0
        ? deckCandidates.reduce((best, b) => {
            const area = (b.maxX - b.minX) * (b.maxY - b.minY);
            const bestArea = (best.maxX - best.minX) * (best.maxY - best.minY);
            return area > bestArea ? b : best;
          }).maxZ
        : union.maxZ;
    const heightAffIn = (partOffsetMm + deckTopLocalZ) / IN_MM;
    const areaSqFt = (sx * sy) / SQMM_PER_SQFT;

    if (areaSqFt >= 4 && heightAffIn >= 24 && heightAffIn <= 45) {
      const cls = classifyTaskSurface(fullName, heightAffIn);
      if (cls) {
        const outline: Vec2[] = [
          rotatePoint2D(union.minX, union.minY, originX, originY, cosR, sinR),
          rotatePoint2D(union.maxX, union.minY, originX, originY, cosR, sinR),
          rotatePoint2D(union.maxX, union.maxY, originX, originY, cosR, sinR),
          rotatePoint2D(union.minX, union.maxY, originX, originY, cosR, sinR),
        ];
        taskSurfaces.push({
          partId: part.id,
          name: part.mark ? `${pt.definition.familyName} (${part.mark})` : pt.definition.typeName || pt.definition.familyName,
          surfaceKind: cls.kind,
          levelId: lvl?.id ?? "",
          levelName: lvl?.name ?? "Level 1",
          levelElevationMm,
          zMm: originZ + deckTopLocalZ,
          heightAffIn: Number(heightAffIn.toFixed(1)),
          outline,
          rotationDeg: rotDeg,
          widthMm: sx,
          depthMm: sy,
          areaSqFt: Number(areaSqFt.toFixed(1)),
          targetAvgFc: cls.targetAvgFc,
          targetMinFc: cls.targetMinFc,
          reflectance,
          ...(mat ? { materialName: mat.name } : {}),
        });
      }
    }
  }

  const out: PartPhotometricExtraction = { occluders, taskSurfaces };
  PART_EXTRACT_CACHE.set(model.elements, out);
  return out;
}
