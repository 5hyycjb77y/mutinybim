import {
  elementsOfKind,
  findLevelByName,
  normalizeLevelName,
  outlineAreaMm2,
  type Level,
  type ModelState,
  type Opening,
  type PartInstance,
  type Room,
  type Space,
  type Vec2,
} from "@permitzip/bim-kernel";
import { DEG, sampleCandelaDirection, sampleTiltFactor } from "./ies-parser";
import {
  deriveSpaceReflectances,
  extractPartPhotometrics,
  type DerivedRoomReflectances,
  type ExtractedTaskSurface,
  type TaskSurfaceKind,
} from "./materials";
import { occlusionIndexOf, type OcclusionIndex, type RayQueryOptions } from "./occlusion";
import { buildSkyDome, evaluateDaylightAtPoint, type DaylightOptions, type DaylightSkyModel, type ResolvedSkyDome } from "./daylight";
import { solveRoomPatchRadiosity, type RadiosityLuminaireSource, type RoomRadiosityField } from "./radiosity";
import { extractStairs3D, type ResolvedStair3D } from "./stairs";
import {
  DEFAULT_BATTERY_90MIN_DERATE,
  findEmergencyCircuitParts,
  indexPhotometricCatalog,
  resolveLuminairePhotometrics,
  type ResolvedLuminairePhotometrics,
} from "./parameters";
import {
  DEFAULT_ROOM_REFLECTANCES,
  NFPA101_IBC_EGRESS_THRESHOLDS,
  isEgressSpace,
  resolveNormalLightingTarget,
  type NormalLightingTarget,
  type RoomReflectances,
} from "./standards";

/**
 * Point-by-point + wall-occlusion + zonal-cavity / 1-bounce diffuse
 * inter-reflectance photometric calculation engine for Normal Illuminance and
 * Emergency / Egress Path Compliance (NFPA 101 §7.9.2.1 / IBC §1008.3.5).
 */

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;
const SQMM_PER_SQFT = MM_PER_FT * MM_PER_FT;

/** Maximum lateral luminaire reach radius considered per point (mm) — 60 ft keeps distant rooms O(1). */
const MAX_LUMINAIRE_RADIUS_MM = 60 * MM_PER_FT;

export type PhotometricsCalculationMode = "simplified" | "detailed" | "surfaces";
export type RadiosityMethod = "patch_radiosity" | "cavity";

export interface PhotometricGridPoint {
  /** Point centre in kernel plan mm. */
  readonly xMm: number;
  readonly yMm: number;
  /** Evaluation plane elevation in kernel world Z mm (rises along stair treads; sits at top of countertops in surfaces mode). */
  readonly zMm: number;
  /** Grid column/row indices inside its space/zone bounding box (used for iso-contour marching squares). */
  readonly col: number;
  readonly row: number;
  /** Illuminance in footcandles (fc): initial in egress mode, maintained normal in normal mode. */
  readonly fc: number;
  /** Direct-only footcandles before diffuse inter-reflectance. */
  readonly directFc: number;
  /** Indirect multi-bounce diffuse inter-reflection footcandles at this point. */
  readonly indirectFc?: number;
  /** Direct sky + solar daylight footcandles at this point (when daylight mode is enabled). */
  readonly daylightFc?: number;
  /** End-of-90-minute footcandles (populated in egress mode). */
  readonly fc90Min?: number;
  /** True when this point breaches the minimum illuminance threshold. */
  readonly fail: boolean;
  /** Optional cell plan rotation in degrees (used for rotated stair flights & task surfaces). */
  readonly rotationDeg?: number;
  /** Optional custom cell footprint size in mm (when finer than room grid, e.g. 1 ft on kitchen countertops). */
  readonly cellSizeMm?: number;
  /** Evaluation surface role. */
  readonly surfaceKind?: "workplane" | "stair" | "task_surface";
}

export interface CustomPhotometricZone {
  readonly id: string;
  readonly name: string;
  readonly levelId?: string;
  readonly levelName?: string;
  readonly outline: readonly Vec2[];
  readonly occupancyType?: string;
  readonly workplaneHeightIn?: number;
  readonly ceilingHeightMm?: number;
  readonly reflectances?: Partial<RoomReflectances>;
}

export interface ExplicitEgressPath {
  readonly id: string;
  readonly name: string;
  readonly levelId?: string;
  readonly levelName?: string;
  /** Either an explicit closed polygon (`outline`) or an open centreline polyline (`polyline` + `widthFt`). */
  readonly outline?: readonly Vec2[];
  readonly polyline?: readonly Vec2[];
  /** Path corridor width when `polyline` is supplied (default 4 ft per IBC §1005). */
  readonly widthFt?: number;
}

export interface NormalPhotometricsOptions {
  /** Optional level ID or level name filter. */
  readonly level?: string;
  /** Optional subset of space/room IDs to evaluate. */
  readonly spaceIds?: readonly string[];
  /** Calculation grid spacing in feet (default 2.0 ft). */
  readonly gridSpacingFt?: number;
  /** Workplane elevation above finished floor in inches (default 30"). */
  readonly workplaneHeightIn?: number;
  /**
   * Calculation fidelity mode:
   * - `"simplified"`: clean architectural space plane at `workplaneHeightIn` with standard reflectances and shell-only occlusion (ignores furniture).
   * - `"detailed"` (default): derives per-room ceiling/wall/floor reflectances from the Materials Library, applies glazing transmittance, and includes furniture/casework/stair 3D occlusion.
   * - `"surfaces"`: full `"detailed"` physics plus fine-grid evaluation on actual horizontal task surfaces (kitchen countertops, islands, worktables, vanities) and multi-flight 3D stair treads.
   */
  readonly calculationMode?: PhotometricsCalculationMode;
  /** Override whether room reflectances are derived from the Materials Library (default `true` in detailed/surfaces, `false` in simplified). */
  readonly useMaterialReflectances?: boolean;
  /** Override whether furniture/casework/equipment occlude light rays (default `true` in detailed/surfaces, `false` in simplified). */
  readonly includeFurnitureOcclusion?: boolean;
  /** Override whether horizontal task surfaces (kitchen counters, islands, desks, vanities) and 3D stair treads are evaluated (default `true` in surfaces mode). */
  readonly includeTaskSurfaces?: boolean;
  /** Enable diffuse inter-reflectance (default true). */
  readonly interReflectance?: boolean;
  /** Inter-reflectance solver: `"patch_radiosity"` (4-bounce spatially-resolved patch radiosity, default in detailed/surfaces) or `"cavity"` (fast uniform room-average cavity method, default in simplified). */
  readonly radiosityMethod?: RadiosityMethod;
  /** Optional CIE sky dome + direct solar daylight contribution through windows, glazed curtain walls, and skylights. */
  readonly daylight?: DaylightOptions;
  /** Override ceiling/wall/floor reflectances (overrides Materials Library & defaults when supplied). */
  readonly reflectances?: Partial<RoomReflectances>;
  /** Optional custom calculation zones evaluated in addition to (or instead of) model spaces. */
  readonly zones?: readonly CustomPhotometricZone[];
  /** When true and `zones` is provided, skip auto-discovered spaces/rooms. */
  readonly zonesOnly?: boolean;
}

export interface EgressPhotometricsOptions {
  /** Optional level ID or level name filter. */
  readonly level?: string;
  /** Calculation grid spacing in feet (default 2.0 ft). */
  readonly gridSpacingFt?: number;
  /** Floor plane elevation above finished floor in inches (default 0"). */
  readonly workplaneHeightIn?: number;
  /** Calculation fidelity mode (`"simplified"` ignores furniture occlusion; `"detailed"` includes furniture & 3D stair flights). Default `"detailed"`. */
  readonly calculationMode?: PhotometricsCalculationMode;
  /** Override whether furniture/casework occlude egress rays (default `false` in simplified, `true` in detailed/surfaces). */
  readonly includeFurnitureOcclusion?: boolean;
  /** Enable inter-reflectance in egress mode (default false — conservative NFPA 101 direct-only). */
  readonly interReflectance?: boolean;
  /** Override ceiling/wall/floor reflectances if interReflectance is enabled. */
  readonly reflectances?: Partial<RoomReflectances>;
  /** 90-minute battery end-of-discharge factor (default 0.60). */
  readonly battery90MinDerate?: number;
  /** Optional explicit egress path polygons or polylines. */
  readonly egressPaths?: readonly ExplicitEgressPath[];
  /** When true and `egressPaths` is provided, skip auto-derived corridor/stair/exit-discharge zones. */
  readonly explicitOnly?: boolean;
}

export interface SurfacePhotometricSummary {
  readonly partId: string;
  readonly name: string;
  readonly surfaceKind: TaskSurfaceKind;
  readonly levelId: string;
  readonly levelName: string;
  readonly levelElevationMm: number;
  /** World elevation of the evaluated top surface (mm). */
  readonly zMm: number;
  readonly heightAffIn: number;
  readonly areaSqFt: number;
  readonly reflectance: number;
  readonly materialName?: string;
  readonly avgFc: number;
  readonly minFc: number;
  readonly maxFc: number;
  readonly targetAvgFc: number;
  readonly targetMinFc: number;
  readonly pass: boolean;
  readonly failReasons: readonly string[];
  readonly gridPoints: readonly PhotometricGridPoint[];
}

export interface StairPhotometricSummary {
  readonly stairId: string;
  readonly name: string;
  readonly form: "straight" | "l_shape" | "u_shape";
  readonly levelId: string;
  readonly levelName: string;
  readonly levelElevationMm: number;
  readonly topLevelElevationMm: number;
  readonly flightCount: number;
  readonly landingCount: number;
  readonly areaSqFt: number;
  readonly avgFc: number;
  readonly minFc: number;
  readonly maxFc: number;
  readonly targetAvgFc: number;
  readonly targetMinFc: number;
  readonly pass: boolean;
  readonly failReasons: readonly string[];
  readonly gridPoints: readonly PhotometricGridPoint[];
}

export interface SpacePhotometricSummary {
  readonly spaceId: string;
  readonly name: string;
  readonly number: string;
  readonly levelId: string;
  readonly levelName: string;
  readonly levelElevationMm: number;
  readonly occupancyKey: string;
  readonly occupancyLabel: string;
  readonly areaSqFt: number;
  readonly workplaneHeightIn: number;
  readonly gridSpacingFt: number;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly gridOriginXMm: number;
  readonly gridOriginYMm: number;
  readonly fixtureCount: number;
  readonly totalWatts: number;
  readonly avgFc: number;
  readonly minFc: number;
  readonly maxFc: number;
  readonly avgMinRatio: number;
  readonly maxMinRatio: number;
  readonly reflectedFc: number;
  /** Mean direct daylight illuminance across this space (fc), present when daylight is enabled. */
  readonly daylightAvgFc?: number;
  /** Mean Daylight Factor (`avgFc / outdoorHorizontalFc * 100%`) when daylight is enabled. */
  readonly daylightFactorPct?: number;
  readonly reflectancesUsed?: DerivedRoomReflectances;
  readonly lpdWPerSqFt: number;
  readonly target: NormalLightingTarget;
  readonly passAvg: boolean;
  readonly passMin: boolean;
  readonly passUniformity: boolean;
  readonly passLpd: boolean;
  readonly pass: boolean;
  readonly failingPoints: number;
  readonly failReasons: readonly string[];
  readonly gridPoints: readonly PhotometricGridPoint[];
}

export interface PhotometricsNormalResult {
  readonly mode: "normal";
  readonly calculationMode: PhotometricsCalculationMode;
  readonly useMaterialReflectances: boolean;
  readonly includeFurnitureOcclusion: boolean;
  readonly gridSpacingFt: number;
  readonly workplaneHeightIn: number;
  readonly interReflectance: boolean;
  /** Active inter-reflectance method (`"patch_radiosity"` = 4-bounce spatially-resolved patch radiosity; `"cavity"` = uniform zonal-cavity). */
  readonly radiosityMethod: RadiosityMethod;
  /** Summary of daylighting inputs & overall Daylight Factor when `daylight.enabled` is true. */
  readonly daylight?: {
    readonly enabled: true;
    readonly skyModel: DaylightSkyModel;
    readonly outdoorHorizontalFc: number;
    readonly includeElectric: boolean;
    readonly overallDaylightFactorPct: number;
  };
  readonly reflectances: RoomReflectances;
  readonly totalFixtures: number;
  readonly totalWatts: number;
  readonly totalAreaSqFt: number;
  readonly overallAvgFc: number;
  readonly overallMinFc: number;
  readonly overallMaxFc: number;
  readonly overallLpdWPerSqFt: number;
  readonly passingSpaces: number;
  readonly failingSpaces: number;
  readonly pass: boolean;
  readonly spaces: readonly SpacePhotometricSummary[];
  /** Horizontal task surfaces (kitchen countertops, islands, worktables, vanities) evaluated at their exact top Z. */
  readonly surfaceSummaries: readonly SurfacePhotometricSummary[];
  /** Multi-flight 3D stair tread & landing evaluations at true step elevations. */
  readonly stairSummaries: readonly StairPhotometricSummary[];
  readonly gridPoints: readonly PhotometricGridPoint[];
  readonly elapsedMs: number;
}

export interface EgressPathSummary {
  readonly pathId: string;
  readonly name: string;
  readonly kind: "corridor_space" | "stair" | "exit_discharge" | "door_path" | "explicit_path";
  readonly levelId: string;
  readonly levelName: string;
  readonly levelElevationMm: number;
  readonly areaSqFt: number;
  readonly workplaneHeightIn: number;
  readonly gridSpacingFt: number;
  readonly gridCols: number;
  readonly gridRows: number;
  readonly gridOriginXMm: number;
  readonly gridOriginYMm: number;
  readonly emergencyFixtureCount: number;
  /** Initial (t = 0) metrics. */
  readonly avgFc: number;
  readonly minFc: number;
  readonly maxFc: number;
  readonly avgMinRatio: number;
  readonly maxMinRatio: number;
  /** End-of-90-minute discharge metrics. */
  readonly avgFc90Min: number;
  readonly minFc90Min: number;
  readonly maxFc90Min: number;
  readonly maxMinRatio90Min: number;
  readonly passInitial: boolean;
  readonly pass90Min: boolean;
  readonly pass: boolean;
  readonly failingPoints: number;
  readonly failReasons: readonly string[];
  readonly gridPoints: readonly PhotometricGridPoint[];
}

export interface PhotometricsEgressResult {
  readonly mode: "egress";
  readonly gridSpacingFt: number;
  readonly workplaneHeightIn: number;
  readonly interReflectance: boolean;
  readonly battery90MinDerate: number;
  readonly thresholds: typeof NFPA101_IBC_EGRESS_THRESHOLDS;
  readonly emergencyFixtureCount: number;
  readonly totalAreaSqFt: number;
  readonly overallAvgFc: number;
  readonly overallMinFc: number;
  readonly overallMaxFc: number;
  readonly overallMaxMinRatio: number;
  readonly overallAvgFc90Min: number;
  readonly overallMinFc90Min: number;
  readonly overallMaxMinRatio90Min: number;
  readonly passingPaths: number;
  readonly failingPaths: number;
  readonly passInitial: boolean;
  readonly pass90Min: boolean;
  readonly pass: boolean;
  readonly paths: readonly EgressPathSummary[];
  readonly gridPoints: readonly PhotometricGridPoint[];
  readonly elapsedMs: number;
}

export interface PlacedLuminaire {
  readonly id: string;
  readonly mark: string;
  readonly levelId: string;
  readonly levelElevationMm: number;
  readonly xMm: number;
  readonly yMm: number;
  readonly zMm: number;
  readonly rotationDeg: number;
  readonly mountKind: "ceiling" | "wall" | "pendant";
  readonly cosRot: number;
  readonly sinRot: number;
  readonly cosTilt: number;
  readonly sinTilt: number;
  readonly tiltFactor: number;
  readonly photo: ResolvedLuminairePhotometrics;
}

interface EvaluationPolygon {
  readonly id: string;
  readonly name: string;
  readonly number: string;
  readonly levelId: string;
  readonly levelName: string;
  readonly levelElevationMm: number;
  readonly outline: readonly Vec2[];
  readonly areaSqFt: number;
  readonly perimeterFt: number;
  readonly ceilingHeightMm: number;
  readonly occupancyHint?: string;
  readonly workplaneHeightIn?: number;
  readonly reflectances?: Partial<RoomReflectances>;
  readonly egressKind?: EgressPathSummary["kind"];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function pointInPolygon(px: number, py: number, outline: readonly Vec2[]): boolean {
  const n = outline.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = outline[i]!.x;
    const yi = outline[i]!.y;
    const xj = outline[j]!.x;
    const yj = outline[j]!.y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonPerimeterMm(outline: readonly Vec2[]): number {
  let p = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

function boundingBoxOf(outline: readonly Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of outline) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Distance from point (px, py) to segment (ax, ay)-(bx, by). */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToPolygonEdges(px: number, py: number, outline: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const d = distToSegment(px, py, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

/** Convert an open polyline + width (mm) into a closed corridor ribbon polygon. */
function bufferPolyline(polyline: readonly Vec2[], widthMm: number): Vec2[] {
  if (polyline.length < 2) return [];
  const half = Math.max(150, widthMm * 0.5);
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < polyline.length; i++) {
    const prev = polyline[Math.max(0, i - 1)]!;
    const curr = polyline[i]!;
    const next = polyline[Math.min(polyline.length - 1, i + 1)]!;
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }
    const nx = -dy * half;
    const ny = dx * half;
    left.push({ x: curr.x + nx, y: curr.y + ny });
    right.push({ x: curr.x - nx, y: curr.y - ny });
  }
  return [...left, ...right.reverse()];
}

function resolveLevels(model: ModelState): {
  readonly byId: ReadonlyMap<string, Level>;
  readonly all: readonly Level[];
} {
  const byId = new Map<string, Level>();
  const all: Level[] = [];
  for (const level of elementsOfKind(model.elements, "level")) {
    byId.set(level.id, level);
    all.push(level);
  }
  all.sort((a, b) => a.elevationMm - b.elevationMm);
  return { byId, all };
}

function matchesLevelFilter(level: Level | undefined, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!level) return false;
  return level.id === filter || normalizeLevelName(level.name) === normalizeLevelName(filter);
}

/** Collect all placed luminaires (`category === "lighting_fixture"`) with resolved IES webs & 3D coordinates. */
export function collectPlacedLuminaires(model: ModelState, battery90MinDerate = DEFAULT_BATTERY_90MIN_DERATE): PlacedLuminaire[] {
  return collectLuminaires(model, battery90MinDerate);
}

export function collectLuminaires(model: ModelState, battery90MinDerate: number): PlacedLuminaire[] {
  const levels = resolveLevels(model).byId;
  const catalog = indexPhotometricCatalog(model);
  const emParts = findEmergencyCircuitParts(model);
  const out: PlacedLuminaire[] = [];

  for (const part of elementsOfKind(model.elements, "part") as Iterable<PartInstance>) {
    const pt = model.elements[part.typeId];
    if (pt?.kind !== "part_type" || pt.definition.category !== "lighting_fixture") continue;
    const level = levels.get(part.levelId);
    const levelElevationMm = level?.elevationMm ?? 0;
    const photo = resolveLuminairePhotometrics(model, part, pt.definition, catalog, emParts, battery90MinDerate);
    const rotationDeg = part.rotationDeg ?? 0;
    const rotRad = rotationDeg * DEG;
    const tiltRad = photo.tiltDeg * DEG;
    const label = `${pt.definition.familyName} ${pt.definition.typeName}`.toLowerCase();
    const mountKind: "ceiling" | "wall" | "pendant" =
      pt.definition.hosting === "wall_face" || /\b(wall|sconce|pack|exit)\b/.test(label)
        ? "wall"
        : /\b(pendant|suspended|linear)\b/.test(label)
          ? "pendant"
          : "ceiling";
    out.push({
      id: part.id,
      mark: part.mark || part.id,
      levelId: part.levelId,
      levelElevationMm,
      xMm: part.position.x,
      yMm: part.position.y,
      zMm: levelElevationMm + (part.offsetMm ?? 2700),
      rotationDeg,
      mountKind,
      cosRot: Math.cos(rotRad),
      sinRot: Math.sin(rotRad),
      cosTilt: Math.cos(tiltRad),
      sinTilt: Math.sin(tiltRad),
      tiltFactor: sampleTiltFactor(photo.web, photo.tiltDeg),
      photo,
    });
  }
  return out;
}

/** Resolve a Space's outline polygon (supports `outline`, `bounded`, and `rooms` bounds). */
function spaceOutline(model: ModelState, space: Space): readonly Vec2[] | null {
  if (space.bounds.kind === "outline" || space.bounds.kind === "bounded") {
    return space.bounds.outline.length >= 3 ? space.bounds.outline : null;
  }
  if (space.bounds.kind === "rooms" && space.bounds.roomIds.length > 0) {
    const first = model.elements[space.bounds.roomIds[0]!];
    if (first?.kind === "room" && first.outline.length >= 3) return first.outline;
  }
  return null;
}

function levelOfRoom(room: Room, levels: { readonly byId: ReadonlyMap<string, Level>; readonly all: readonly Level[] }): Level | undefined {
  if (room.placement && "levelId" in room.placement) {
    const byPlacement = levels.byId.get(room.placement.levelId);
    if (byPlacement) return byPlacement;
  }
  const partLvl = room.partition?.level;
  if (partLvl) {
    const byName = findLevelByName(levels.all, partLvl);
    if (byName) return byName;
  }
  return levels.all[0];
}

/** Discover active Spaces (and fallback Rooms not already wrapped by a Space). */
export function collectModelSpaces(
  model: ModelState,
  levelFilter?: string,
  spaceIdFilter?: readonly string[],
): EvaluationPolygon[] {
  const levels = resolveLevels(model);
  const idSet = spaceIdFilter && spaceIdFilter.length > 0 ? new Set(spaceIdFilter) : null;
  const coveredRoomIds = new Set<string>();
  const out: EvaluationPolygon[] = [];

  for (const space of elementsOfKind(model.elements, "space") as Iterable<Space>) {
    if (space.bounds.kind === "rooms") {
      for (const rid of space.bounds.roomIds) coveredRoomIds.add(rid);
    }
    if (space.origin.kind === "from_room") coveredRoomIds.add(space.origin.roomId);
    if (idSet && !idSet.has(space.id)) continue;
    const outline = spaceOutline(model, space);
    if (!outline) continue;
    const level = (space.levelId ? levels.byId.get(space.levelId) : undefined) ?? (space.partition?.level ? findLevelByName(levels.all, space.partition.level) : undefined) ?? levels.all[0];
    if (!matchesLevelFilter(level, levelFilter)) continue;
    const areaMm2 = outlineAreaMm2(outline);
    if (areaMm2 < 10_000) continue;
    const occHint = space.use?.useId ?? space.use?.name ?? (typeof space.values?.occupancy === "string" ? space.values.occupancy : undefined);
    out.push({
      id: space.id,
      name: space.name || space.number || space.id,
      number: space.number || "",
      levelId: level?.id ?? "",
      levelName: level?.name ?? space.partition?.level ?? "Level 1",
      levelElevationMm: level?.elevationMm ?? 0,
      outline,
      areaSqFt: areaMm2 / SQMM_PER_SQFT,
      perimeterFt: polygonPerimeterMm(outline) / MM_PER_FT,
      ceilingHeightMm: space.ceilingHeightMm ?? 2743,
      ...(occHint ? { occupancyHint: occHint } : {}),
    });
  }

  for (const room of elementsOfKind(model.elements, "room") as Iterable<Room>) {
    if (coveredRoomIds.has(room.id)) continue;
    if (idSet && !idSet.has(room.id)) continue;
    if (room.outline.length < 3) continue;
    const level = levelOfRoom(room, levels);
    if (!matchesLevelFilter(level, levelFilter)) continue;
    const areaMm2 = outlineAreaMm2(room.outline);
    if (areaMm2 < 10_000) continue;
    out.push({
      id: room.id,
      name: room.name || room.number || room.id,
      number: room.number || "",
      levelId: level?.id ?? "",
      levelName: level?.name ?? room.partition?.level ?? "Level 1",
      levelElevationMm: level?.elevationMm ?? 0,
      outline: room.outline,
      areaSqFt: areaMm2 / SQMM_PER_SQFT,
      perimeterFt: polygonPerimeterMm(room.outline) / MM_PER_FT,
      ceilingHeightMm: 2743,
    });
  }

  out.sort((a, b) => a.levelElevationMm - b.levelElevationMm || a.number.localeCompare(b.number) || a.name.localeCompare(b.name));
  return out;
}

/** Auto-derive egress polygons: egress spaces (corridors, lobbies, stairs) + exterior exit discharge pads at exterior doors. */
function collectAutoEgressZones(model: ModelState, levelFilter?: string): EvaluationPolygon[] {
  const levels = resolveLevels(model);
  const allSpaces = collectModelSpaces(model, levelFilter);
  const out: EvaluationPolygon[] = [];

  for (const sp of allSpaces) {
    if (isEgressSpace(sp.occupancyHint, sp.name)) {
      const isStair = /\b(stair|stairwell)\b/i.test(`${sp.occupancyHint ?? ""} ${sp.name}`);
      out.push({
        ...sp,
        egressKind: isStair ? "stair" : "corridor_space",
      });
    }
  }

  // Stair egress zones are evaluated in true 3D multi-flight geometry via `extractStairs3D(model)`
  // inside `evaluateEgressPhotometrics` (Flight 1 rising treads, Mid-Landing, Flight 2 rising treads).

  // Detect exterior exit doors (doors hosted on walls where one side is outside all spaces on that level)
  // and create a 6 ft wide × 6 ft deep exit discharge pad immediately outside the exterior exit door.
  const spacesByLevel = new Map<string, readonly EvaluationPolygon[]>();
  for (const sp of allSpaces) {
    const arr = spacesByLevel.get(sp.levelId);
    if (arr) (arr as EvaluationPolygon[]).push(sp);
    else spacesByLevel.set(sp.levelId, [sp]);
  }

  // Also include slab footprints to distinguish building interior vs exterior reliably
  const slabsByLevel = new Map<string, readonly (readonly Vec2[])[]>();
  for (const slab of elementsOfKind(model.elements, "slab")) {
    if (slab.outline.length < 3) continue;
    const lvl =
      (slab.placement && "levelId" in slab.placement ? levels.byId.get(slab.placement.levelId) : undefined) ??
      (slab.partition?.level ? findLevelByName(levels.all, slab.partition.level) : undefined) ??
      levels.all[0];
    if (!lvl) continue;
    const arr = slabsByLevel.get(lvl.id);
    if (arr) (arr as (readonly Vec2[])[]).push(slab.outline);
    else slabsByLevel.set(lvl.id, [slab.outline]);
  }

  // Only add exterior exit discharge pads on ground level (lowest elevation level) where exterior exit doors exist
  const groundLevel = levels.all[0];
  if (groundLevel && matchesLevelFilter(groundLevel, levelFilter)) {
    const groundSpaces = spacesByLevel.get(groundLevel.id) ?? [];
    const groundSlabs = slabsByLevel.get(groundLevel.id) ?? [];
    const isInsideBuilding = (x: number, y: number): boolean => {
      for (const sp of groundSpaces) if (pointInPolygon(x, y, sp.outline)) return true;
      for (const sl of groundSlabs) if (pointInPolygon(x, y, sl)) return true;
      return false;
    };

    for (const op of elementsOfKind(model.elements, "opening") as Iterable<Opening>) {
      if (op.openingType !== "door") continue;
      const host = model.elements[op.hostId];
      if (!host || host.kind !== "wall") continue;
      const wallLevel =
        (host.placement && "levelId" in host.placement ? levels.byId.get(host.placement.levelId) : undefined) ??
        (host.partition?.level ? findLevelByName(levels.all, host.partition.level) : undefined) ??
        groundLevel;
      if (wallLevel.id !== groundLevel.id) continue;

      const wx = host.end.x - host.start.x;
      const wy = host.end.y - host.start.y;
      const wLen = Math.hypot(wx, wy);
      if (wLen < 1) continue;
      const tx = wx / wLen;
      const ty = wy / wLen;
      const nx = -ty;
      const ny = tx;

      // Probe 600 mm on both sides of the door to identify exterior side
      const probeMm = 600;
      const sideAIn = isInsideBuilding(op.position.x + nx * probeMm, op.position.y + ny * probeMm);
      const sideBIn = isInsideBuilding(op.position.x - nx * probeMm, op.position.y - ny * probeMm);
      if (sideAIn === sideBIn) continue; // Interior door (both inside) or isolated wall (both outside)

      const outX = sideAIn ? -nx : nx;
      const outY = sideAIn ? -ny : ny;

      // Exterior exit discharge pad: 6 ft wide centered on door × 6 ft outward from exterior wall face (offset 200mm past wall)
      const halfWidthMm = 3 * MM_PER_FT;
      const startOffMm = Math.max(180, host.thickness * 0.5 + 80);
      const depthMm = 6 * MM_PER_FT;
      const c0x = op.position.x + outX * startOffMm;
      const c0y = op.position.y + outY * startOffMm;
      const c1x = c0x + outX * depthMm;
      const c1y = c0y + outY * depthMm;

      const padOutline: Vec2[] = [
        { x: c0x - tx * halfWidthMm, y: c0y - ty * halfWidthMm },
        { x: c0x + tx * halfWidthMm, y: c0y + ty * halfWidthMm },
        { x: c1x + tx * halfWidthMm, y: c1y + ty * halfWidthMm },
        { x: c1x - tx * halfWidthMm, y: c1y - ty * halfWidthMm },
      ];
      const padArea = outlineAreaMm2(padOutline) / SQMM_PER_SQFT;

      out.push({
        id: `egress_discharge:${op.id}`,
        name: `Exit Discharge (${op.mark || op.id})`,
        number: op.mark || "",
        levelId: groundLevel.id,
        levelName: groundLevel.name,
        levelElevationMm: groundLevel.elevationMm,
        outline: padOutline,
        areaSqFt: padArea,
        perimeterFt: polygonPerimeterMm(padOutline) / MM_PER_FT,
        ceilingHeightMm: 3000,
        occupancyHint: "exterior",
        workplaneHeightIn: 0,
        egressKind: "exit_discharge",
      });
    }
  }

  return out;
}

/**
 * Evaluate direct horizontal footcandles at point `(px, py, pz)` from a single
 * luminaire using `E = (I(theta, phi) * LLF * cos(theta)) / d²` (= `I * LLF * cos³(theta) / h²`)
 * with 3D wall/slab/column occlusion ray-casting.
 */
function directIlluminanceFromLuminaire(
  lum: PlacedLuminaire,
  px: number,
  py: number,
  pz: number,
  scaleMultiplier: number,
  occlusion: OcclusionIndex,
  rayOpts?: RayQueryOptions,
): number {
  const dzMm = pz - lum.zMm; // negative when point is below luminaire
  const hMm = -dzMm;
  if (hMm <= 25) return 0; // luminaire is at or below calculation plane

  const dxMm = px - lum.xMm;
  const dyMm = py - lum.yMm;
  const horizSq = dxMm * dxMm + dyMm * dyMm;
  if (horizSq > MAX_LUMINAIRE_RADIUS_MM * MAX_LUMINAIRE_RADIUS_MM) return 0;

  const distSqMm = horizSq + hMm * hMm;
  const distMm = Math.sqrt(distSqMm);
  const cosTheta = hMm / distMm;
  if (cosTheta <= 1e-4) return 0;

  // Transform ray vector (dx, dy, dz) into luminaire local frame (undo plan Z rotation, then optional Y tilt)
  let lx = dxMm * lum.cosRot + dyMm * lum.sinRot;
  const ly = -dxMm * lum.sinRot + dyMm * lum.cosRot;
  let lz = dzMm;
  if (lum.sinTilt !== 0) {
    const tx = lx * lum.cosTilt - lz * lum.sinTilt;
    const tz = lx * lum.sinTilt + lz * lum.cosTilt;
    lx = tx;
    lz = tz;
  }

  const candela = sampleCandelaDirection(lum.photo.web, lx, ly, lz) * lum.photo.lumenScale * lum.tiltFactor * scaleMultiplier;
  if (candela <= 1e-6) return 0;

  // Check wall/slab/column/glazing/stair/furniture transmission ONLY when candela > 0
  const transmittance = occlusion.rayTransmittance(px, py, pz, lum.xMm, lum.yMm, lum.zMm, rayOpts);
  if (transmittance <= 0.01) return 0;

  // E = (I * LLF * T_vis * cos(theta)) / d_ft^2  (algebraically identical to I * LLF * T_vis * cos^3(theta) / h_ft^2)
  const distSqFt = distSqMm / SQMM_PER_SQFT;
  return (candela * lum.photo.llf * transmittance * cosTheta) / distSqFt;
}

/**
 * Direct IES illuminance (fc) on an arbitrarily oriented diffuse surface patch
 * `(px, py, pz)` with unit normal `(nx, ny, nz)` — supports horizontal floors (`+Z`),
 * vertical walls, and ceiling patches lit by upward pendant flux (`-Z`).
 */
function directIlluminanceOnOrientedSurface(
  lum: PlacedLuminaire,
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  scaleMultiplier: number,
  occlusion: OcclusionIndex,
  rayOpts?: RayQueryOptions,
): number {
  const dxMm = px - lum.xMm;
  const dyMm = py - lum.yMm;
  const dzMm = pz - lum.zMm;
  const distSqMm = dxMm * dxMm + dyMm * dyMm + dzMm * dzMm;
  if (distSqMm < 625 || distSqMm > MAX_LUMINAIRE_RADIUS_MM * MAX_LUMINAIRE_RADIUS_MM) return 0;

  const distMm = Math.sqrt(distSqMm);
  // Vector from patch toward luminaire is (-dx, -dy, -dz) / dist
  const cosInc = -(dxMm * nx + dyMm * ny + dzMm * nz) / distMm;
  if (cosInc <= 1e-4) return 0;

  let lx = dxMm * lum.cosRot + dyMm * lum.sinRot;
  const ly = -dxMm * lum.sinRot + dyMm * lum.cosRot;
  let lz = dzMm;
  if (lum.sinTilt !== 0) {
    const tx = lx * lum.cosTilt - lz * lum.sinTilt;
    const tz = lx * lum.sinTilt + lz * lum.cosTilt;
    lx = tx;
    lz = tz;
  }

  const candela = sampleCandelaDirection(lum.photo.web, lx, ly, lz) * lum.photo.lumenScale * lum.tiltFactor * scaleMultiplier;
  if (candela <= 1e-6) return 0;

  const transmittance = occlusion.rayTransmittance(px, py, pz, lum.xMm, lum.yMm, lum.zMm, rayOpts);
  if (transmittance <= 0.01) return 0;

  const distSqFt = distSqMm / SQMM_PER_SQFT;
  return (candela * lum.photo.llf * transmittance * cosInc) / distSqFt;
}

/**
 * Zonal-cavity / steady-state diffuse 1-bounce inter-reflectance boost (fc) for an
 * interior room given its fixtures, average direct floor illuminance, geometry, and
 * surface reflectances (ceiling/wall/floor).
 *
 * Uses flux conservation:
 * - Total fixture flux inside the room splits into downward flux (hitting floor directly
 *   or walls directly) and upward flux (hitting ceiling directly, e.g. linear pendants).
 * - Steady-state Sumpner diffuse inter-reflection adds:
 *   `E_reflected = (rho_c * Phi_ceil + rho_w * Phi_wall + rho_f * rho_c * Phi_floor) / (A_total * (1 - rho_avg))`
 */
function computeInterReflectanceFc(
  roomLuminaires: readonly PlacedLuminaire[],
  areaSqFt: number,
  perimeterFt: number,
  cavityHeightFt: number,
  directAvgFc: number,
  reflectances: RoomReflectances,
  scaleOf: (lum: PlacedLuminaire) => number,
): number {
  if (roomLuminaires.length === 0 || areaSqFt <= 0.1 || cavityHeightFt <= 0.5) return 0;
  const rhoC = Math.max(0, Math.min(0.95, reflectances.ceiling));
  const rhoW = Math.max(0, Math.min(0.95, reflectances.wall));
  const rhoF = Math.max(0, Math.min(0.95, reflectances.floor));
  if (rhoC + rhoW + rhoF < 1e-4) return 0;

  let totalDownLm = 0;
  let totalUpLm = 0;
  for (const lum of roomLuminaires) {
    const scale = lum.photo.lumenScale * lum.photo.llf * lum.tiltFactor * scaleOf(lum);
    totalDownLm += lum.photo.web.downwardLumens * scale;
    totalUpLm += lum.photo.web.upwardLumens * scale;
  }

  const floorDirectLm = Math.min(totalDownLm, Math.max(0, directAvgFc * areaSqFt));
  const wallDirectLm = Math.max(0, totalDownLm - floorDirectLm);
  const ceilDirectLm = Math.max(0, totalUpLm);

  const wallAreaSqFt = Math.max(0, perimeterFt * cavityHeightFt);
  const totalSurfaceArea = 2 * areaSqFt + wallAreaSqFt;
  if (totalSurfaceArea <= 1e-6) return 0;

  const avgReflectance = Math.min(0.92, (areaSqFt * rhoC + wallAreaSqFt * rhoW + areaSqFt * rhoF) / totalSurfaceArea);
  // First-bounce reflected flux leaving ceiling, walls, and floor redistributed over the room cavity
  const reflectedFlux =
    ceilDirectLm * rhoC * (0.55 + 0.45 * avgReflectance) +
    wallDirectLm * rhoW * 0.5 +
    floorDirectLm * rhoF * rhoC * 0.65;

  const eReflected = reflectedFlux / (totalSurfaceArea * (1 - avgReflectance));
  return Math.max(0, eReflected);
}

interface SampledGrid {
  readonly gridCols: number;
  readonly gridRows: number;
  readonly originXMm: number;
  readonly originYMm: number;
  readonly points: readonly { readonly xMm: number; readonly yMm: number; readonly col: number; readonly row: number }[];
}

/** Generate an evenly spaced interior grid of points inside `outline` (with small edge inset so points never sit inside wall thickness). */
function buildPolygonGrid(outline: readonly Vec2[], spacingMm: number): SampledGrid {
  const box = boundingBoxOf(outline);
  const widthMm = box.maxX - box.minX;
  const heightMm = box.maxY - box.minY;
  const wallInsetMm = Math.min(150, spacingMm * 0.25);

  const originXMm = box.minX + spacingMm * 0.5;
  const originYMm = box.minY + spacingMm * 0.5;
  const gridCols = Math.max(1, Math.ceil(widthMm / spacingMm));
  const gridRows = Math.max(1, Math.ceil(heightMm / spacingMm));

  const points: { xMm: number; yMm: number; col: number; row: number }[] = [];
  for (let row = 0; row < gridRows; row++) {
    const y = originYMm + row * spacingMm;
    for (let col = 0; col < gridCols; col++) {
      const x = originXMm + col * spacingMm;
      if (!pointInPolygon(x, y, outline)) continue;
      if (distToPolygonEdges(x, y, outline) < wallInsetMm && widthMm > 600 && heightMm > 600) continue;
      points.push({ xMm: x, yMm: y, col, row });
    }
  }

  // Fallback for very narrow spaces (< 2 ft wide): include polygon centroid so every valid space gets >= 1 point
  if (points.length === 0) {
    let sx = 0;
    let sy = 0;
    for (const p of outline) {
      sx += p.x;
      sy += p.y;
    }
    const cx = sx / outline.length;
    const cy = sy / outline.length;
    points.push({ xMm: cx, yMm: cy, col: 0, row: 0 });
  }

  return { gridCols, gridRows, originXMm, originYMm, points };
}

interface SampledPoint3D {
  readonly xMm: number;
  readonly yMm: number;
  readonly zMm: number;
  readonly col: number;
  readonly row: number;
  readonly rotationDeg?: number;
  readonly cellSizeMm: number;
}

/**
 * Sample every flight tread (at true rising world Z) and mid-landing (at `zTop`)
 * of a straight, L-shape, or U-shape 3D stair.
 */
function buildStairGrid3D(stair: ResolvedStair3D, spacingMm: number): {
  readonly points: readonly SampledPoint3D[];
  readonly gridCols: number;
  readonly gridRows: number;
  readonly originXMm: number;
  readonly originYMm: number;
} {
  const stepMm = Math.max(280, Math.min(spacingMm, 450)); // <= 18" along stair treads for crisp riser resolution
  const pts: SampledPoint3D[] = [];
  let rowIdx = 0;

  for (const fl of stair.flights) {
    const nAlong = Math.max(2, Math.ceil(fl.runMm / stepMm));
    const nAcross = Math.max(2, Math.ceil(fl.widthMm / stepMm));
    const ds = fl.runMm / nAlong;
    const dw = fl.widthMm / nAcross;
    for (let i = 0; i < nAlong; i++) {
      const frac = (i + 0.5) / nAlong;
      const s = frac * fl.runMm;
      // Exact rising tread top elevation (+15 mm clear above tread finish)
      const zMm = fl.z0 + frac * (fl.z1 - fl.z0) + 15;
      for (let j = 0; j < nAcross; j++) {
        const wOff = -fl.widthMm * 0.5 + (j + 0.5) * dw;
        pts.push({
          xMm: fl.start.x + fl.u.x * s + fl.n.x * wOff,
          yMm: fl.start.y + fl.u.y * s + fl.n.y * wOff,
          zMm,
          col: j,
          row: rowIdx,
          rotationDeg: fl.rotationDeg,
          cellSizeMm: Math.min(ds, dw) * 0.96,
        });
      }
      rowIdx++;
    }
  }

  for (const lnd of stair.landings) {
    const grid = buildPolygonGrid(lnd.outline, stepMm);
    for (const gp of grid.points) {
      pts.push({
        xMm: gp.xMm,
        yMm: gp.yMm,
        zMm: lnd.zTop + 15,
        col: gp.col,
        row: rowIdx + gp.row,
        cellSizeMm: stepMm * 0.96,
      });
    }
    rowIdx += grid.gridRows;
  }

  let minX = Infinity;
  let minY = Infinity;
  for (const p of pts) {
    if (p.xMm < minX) minX = p.xMm;
    if (p.yMm < minY) minY = p.yMm;
  }
  return {
    points: pts,
    gridCols: Math.max(1, pts.reduce((m, p) => Math.max(m, p.col + 1), 1)),
    gridRows: Math.max(1, rowIdx),
    originXMm: Number.isFinite(minX) ? minX : 0,
    originYMm: Number.isFinite(minY) ? minY : 0,
  };
}

/** Sample a fine 1'-0" (305 mm) grid directly on top of an oriented horizontal task surface (countertop, island, desk, vanity). */
function buildTaskSurfaceGrid(surface: ExtractedTaskSurface): readonly SampledPoint3D[] {
  const stepMm = 304.8; // 1 ft resolution on counters & worktables
  const nX = Math.max(1, Math.round(surface.widthMm / stepMm));
  const nY = Math.max(1, Math.round(surface.depthMm / stepMm));
  const dx = surface.widthMm / nX;
  const dy = surface.depthMm / nY;
  const cellSizeMm = Math.min(dx, dy) * 0.94;

  // Reconstruct center & axes from surface outline corners [c0(minX,minY), c1(maxX,minY), c2(maxX,maxY), c3(minX,maxY)]
  const c0 = surface.outline[0]!;
  const c1 = surface.outline[1]!;
  const c3 = surface.outline[3]!;
  const ux = (c1.x - c0.x) / Math.max(1, surface.widthMm);
  const uy = (c1.y - c0.y) / Math.max(1, surface.widthMm);
  const vx = (c3.x - c0.x) / Math.max(1, surface.depthMm);
  const vy = (c3.y - c0.y) / Math.max(1, surface.depthMm);

  const pts: SampledPoint3D[] = [];
  for (let row = 0; row < nY; row++) {
    const vDist = (row + 0.5) * dy;
    for (let col = 0; col < nX; col++) {
      const uDist = (col + 0.5) * dx;
      pts.push({
        xMm: c0.x + ux * uDist + vx * vDist,
        yMm: c0.y + uy * uDist + vy * vDist,
        zMm: surface.zMm + 12, // 12 mm above counter finish
        col,
        row,
        rotationDeg: surface.rotationDeg,
        cellSizeMm,
      });
    }
  }
  return pts;
}

/** Candidate luminaires for a 3D bounding volume spanning `[minZ, maxZ]` (e.g., multi-storey stairwell). */
function candidateLuminairesForVolume(
  luminaires: readonly PlacedLuminaire[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): PlacedLuminaire[] {
  const x0 = minX - MAX_LUMINAIRE_RADIUS_MM;
  const x1 = maxX + MAX_LUMINAIRE_RADIUS_MM;
  const y0 = minY - MAX_LUMINAIRE_RADIUS_MM;
  const y1 = maxY + MAX_LUMINAIRE_RADIUS_MM;
  const zHi = maxZ + 6000;
  const out: PlacedLuminaire[] = [];
  for (const lum of luminaires) {
    if (lum.zMm <= minZ + 25 || lum.zMm > zHi) continue;
    if (lum.xMm < x0 || lum.xMm > x1 || lum.yMm < y0 || lum.yMm > y1) continue;
    out.push(lum);
  }
  return out;
}

/** Filter luminaires that could plausibly illuminate a polygon (bounding box + vertical floor-to-ceiling band). */
function candidateLuminairesForPolygon(
  luminaires: readonly PlacedLuminaire[],
  poly: EvaluationPolygon,
  evalZMm: number,
): PlacedLuminaire[] {
  const box = boundingBoxOf(poly.outline);
  const minX = box.minX - MAX_LUMINAIRE_RADIUS_MM;
  const maxX = box.maxX + MAX_LUMINAIRE_RADIUS_MM;
  const minY = box.minY - MAX_LUMINAIRE_RADIUS_MM;
  const maxY = box.maxY + MAX_LUMINAIRE_RADIUS_MM;
  // Luminaires on the same storey (or up to 9 m above workplane for double-height atriums/stairs)
  const maxZ = evalZMm + 9000;
  const out: PlacedLuminaire[] = [];
  for (const lum of luminaires) {
    if (lum.zMm <= evalZMm + 25 || lum.zMm > maxZ) continue;
    if (lum.xMm < minX || lum.xMm > maxX || lum.yMm < minY || lum.yMm > maxY) continue;
    out.push(lum);
  }
  return out;
}

const NORMAL_CACHE = new WeakMap<ModelState["elements"], Map<string, PhotometricsNormalResult>>();
const EGRESS_CACHE = new WeakMap<ModelState["elements"], Map<string, PhotometricsEgressResult>>();

/**
 * Evaluate normal maintained illuminance across model spaces / rooms (or custom
 * calculation zones) using IES LM-63 photometric webs, wall/slab/column ray-cast
 * occlusion, and optional zonal-cavity diffuse inter-reflectance.
 */
export function evaluateNormalPhotometrics(
  model: ModelState,
  options: NormalPhotometricsOptions = {},
): PhotometricsNormalResult {
  const calculationMode: PhotometricsCalculationMode = options.calculationMode ?? "detailed";
  const useMaterialReflectances =
    options.useMaterialReflectances ?? (calculationMode !== "simplified" && !options.reflectances);
  const includeFurnitureOcclusion =
    options.includeFurnitureOcclusion ?? calculationMode !== "simplified";
  const includeTaskSurfaces =
    options.includeTaskSurfaces ?? calculationMode === "surfaces";
  const radiosityMethod: RadiosityMethod =
    options.radiosityMethod ?? (calculationMode === "simplified" ? "cavity" : "patch_radiosity");
  const daylightEnabled = options.daylight?.enabled === true;
  const includeElectric = daylightEnabled ? (options.daylight?.includeElectric ?? true) : true;
  const skyDome: ResolvedSkyDome | null = daylightEnabled ? buildSkyDome(options.daylight) : null;

  const canCache = !options.zones || options.zones.length === 0;
  const cacheKey = canCache
    ? JSON.stringify({
        l: options.level ?? "",
        s: options.spaceIds ?? null,
        g: options.gridSpacingFt ?? 2,
        w: options.workplaneHeightIn ?? 30,
        cm: calculationMode,
        mr: useMaterialReflectances,
        fo: includeFurnitureOcclusion,
        ts: includeTaskSurfaces,
        ir: options.interReflectance ?? true,
        rm: radiosityMethod,
        dl: daylightEnabled ? options.daylight : null,
        r: options.reflectances ?? null,
      })
    : "";
  if (canCache) {
    const hit = NORMAL_CACHE.get(model.elements)?.get(cacheKey);
    if (hit) return hit;
  }

  const t0 = performance.now();
  const gridSpacingFt = Math.max(0.5, Math.min(20, options.gridSpacingFt ?? 2));
  const defaultWorkplaneIn = Math.max(0, Math.min(120, options.workplaneHeightIn ?? 30));
  const interReflectance = options.interReflectance ?? true;
  const baseReflectances: RoomReflectances = {
    ceiling: options.reflectances?.ceiling ?? DEFAULT_ROOM_REFLECTANCES.ceiling,
    wall: options.reflectances?.wall ?? DEFAULT_ROOM_REFLECTANCES.wall,
    floor: options.reflectances?.floor ?? DEFAULT_ROOM_REFLECTANCES.floor,
  };
  const rayOpts: RayQueryOptions = {
    includeFurniture: includeFurnitureOcclusion,
    includeStairs: true,
  };

  const levels = resolveLevels(model);
  const polygons: EvaluationPolygon[] = [];
  if (!options.zonesOnly) {
    polygons.push(...collectModelSpaces(model, options.level, options.spaceIds));
  }
  if (options.zones) {
    for (const z of options.zones) {
      if (z.outline.length < 3) continue;
      const lvl =
        (z.levelId ? levels.byId.get(z.levelId) : undefined) ??
        (z.levelName ? findLevelByName(levels.all, z.levelName) : undefined) ??
        levels.all[0];
      if (!matchesLevelFilter(lvl, options.level)) continue;
      const areaSqFt = outlineAreaMm2(z.outline) / SQMM_PER_SQFT;
      if (areaSqFt <= 0.1) continue;
      polygons.push({
        id: z.id,
        name: z.name,
        number: "",
        levelId: lvl?.id ?? "",
        levelName: lvl?.name ?? z.levelName ?? "Level 1",
        levelElevationMm: lvl?.elevationMm ?? 0,
        outline: z.outline,
        areaSqFt,
        perimeterFt: polygonPerimeterMm(z.outline) / MM_PER_FT,
        ceilingHeightMm: z.ceilingHeightMm ?? 2743,
        ...(z.occupancyType ? { occupancyHint: z.occupancyType } : {}),
        ...(z.workplaneHeightIn !== undefined ? { workplaneHeightIn: z.workplaneHeightIn } : {}),
        ...(z.reflectances ? { reflectances: z.reflectances } : {}),
      });
    }
  }

  // Normal-mode illumination excludes pure exit signage and emergency-only flood units (which stay OFF during normal operation)
  const allLuminaires = includeElectric
    ? collectLuminaires(model, DEFAULT_BATTERY_90MIN_DERATE).filter(
        (lum) => !lum.photo.isEmergencyOnly && !lum.photo.isExitSignOnly,
      )
    : [];
  const occlusion = occlusionIndexOf(model);
  const spacingMm = gridSpacingFt * MM_PER_FT;

  const spaces: SpacePhotometricSummary[] = [];
  const spaceRadiosityLookup: {
    readonly levelId: string;
    readonly reflectedFc: number;
    readonly radiosityField: RoomRadiosityField | null;
    readonly outline: readonly Vec2[];
  }[] = [];
  const allGridPoints: PhotometricGridPoint[] = [];

  let sumWeightedAvg = 0;
  let sumWeightedDaylightDf = 0;
  let totalAreaSqFt = 0;
  let totalWatts = 0;
  let totalFixtures = 0;
  let overallMinFc = Infinity;
  let overallMaxFc = 0;
  let passingSpaces = 0;
  let failingSpaces = 0;

  for (const poly of polygons) {
    const target = resolveNormalLightingTarget(poly.occupancyHint, poly.name);
    const workplaneIn = poly.workplaneHeightIn ?? (options.workplaneHeightIn !== undefined ? defaultWorkplaneIn : target.defaultWorkplaneIn);
    const evalZMm = poly.levelElevationMm + workplaneIn * MM_PER_IN;
    const grid = buildPolygonGrid(poly.outline, spacingMm);
    const candidates = includeElectric ? candidateLuminairesForPolygon(allLuminaires, poly, evalZMm) : [];

    // Fixtures physically inside this space on this level (for LPD & inter-reflectance)
    const insideFixtures = candidates.filter(
      (lum) => lum.levelId === poly.levelId && pointInPolygon(lum.xMm, lum.yMm, poly.outline),
    );
    let spaceWatts = 0;
    for (const lum of insideFixtures) spaceWatts += lum.photo.watts;

    // 1. Direct illuminance (electric + optional CIE sky/solar daylight) at every walkable/unoccupied grid point
    const activePts = grid.points.filter((pt) => !occlusion.isPointInsideSolid(pt.xMm, pt.yMm, evalZMm, rayOpts));
    const evalPts = activePts.length > 0 ? activePts : grid.points;
    const directElectricValues = new Float64Array(evalPts.length);
    const directDaylightValues = skyDome ? new Float64Array(evalPts.length) : null;
    let directSum = 0;
    let daylightSum = 0;
    for (let i = 0; i < evalPts.length; i++) {
      const pt = evalPts[i]!;
      let elecFc = 0;
      for (let li = 0; li < candidates.length; li++) {
        elecFc += directIlluminanceFromLuminaire(candidates[li]!, pt.xMm, pt.yMm, evalZMm, 1, occlusion, rayOpts);
      }
      directElectricValues[i] = elecFc;
      let dlFc = 0;
      if (skyDome && directDaylightValues) {
        dlFc = evaluateDaylightAtPoint(skyDome, pt.xMm, pt.yMm, evalZMm, 0, 0, 1, occlusion, rayOpts);
        directDaylightValues[i] = dlFc;
        daylightSum += dlFc;
      }
      directSum += elecFc + dlFc;
    }
    const directAvg = evalPts.length > 0 ? directSum / evalPts.length : 0;

    // 2. Multi-bounce diffuse patch radiosity (or fast zonal-cavity fallback)
    let reflectancesUsed: DerivedRoomReflectances;
    if (poly.reflectances || options.reflectances) {
      reflectancesUsed = {
        ceiling: poly.reflectances?.ceiling ?? baseReflectances.ceiling,
        wall: poly.reflectances?.wall ?? baseReflectances.wall,
        floor: poly.reflectances?.floor ?? baseReflectances.floor,
        source: "explicit",
      };
    } else if (useMaterialReflectances) {
      reflectancesUsed = deriveSpaceReflectances(
        model,
        poly.outline,
        poly.levelId,
        poly.levelElevationMm,
        poly.ceilingHeightMm,
        baseReflectances,
      );
    } else {
      reflectancesUsed = { ...baseReflectances, source: "default" };
    }
    const cavityHeightFt = Math.max(1, (poly.ceilingHeightMm - workplaneIn * MM_PER_IN) / MM_PER_FT);
    let radiosityField: RoomRadiosityField | null = null;
    let uniformReflectedFc = 0;

    const isOutdoorArea = /\b(balcony|terrace|patio|exterior|outdoor|porch|plaza|courtyard|rooftop)\b/i.test(
      `${poly.name} ${poly.occupancyHint ?? ""}`,
    );

    if (interReflectance) {
      if (radiosityMethod === "patch_radiosity" && !isOutdoorArea && (candidates.length > 0 || skyDome !== null)) {
        const radSources: RadiosityLuminaireSource[] = candidates.map((lum) => ({
          xMm: lum.xMm,
          yMm: lum.yMm,
          zMm: lum.zMm,
          directIlluminanceOnSurface: (px, py, pz, nx, ny, nz) =>
            directIlluminanceOnOrientedSurface(lum, px, py, pz, nx, ny, nz, 1, occlusion, rayOpts),
        }));
        radiosityField = solveRoomPatchRadiosity({
          outline: poly.outline,
          workplaneZMm: evalZMm,
          ceilingZMm: poly.levelElevationMm + poly.ceilingHeightMm,
          reflectances: reflectancesUsed,
          sources: radSources,
          ...(skyDome
            ? {
                extraDirectOnPatch: (patch) =>
                  evaluateDaylightAtPoint(skyDome, patch.xMm, patch.yMm, patch.zMm, patch.nx, patch.ny, patch.nz, occlusion, rayOpts),
              }
            : {}),
          occlusion,
          rayOpts,
          bounces: 4,
        });
        uniformReflectedFc = radiosityField.meanIndirectFc;
      } else {
        uniformReflectedFc = computeInterReflectanceFc(
          insideFixtures,
          poly.areaSqFt,
          poly.perimeterFt,
          cavityHeightFt,
          directAvg,
          reflectancesUsed,
          () => 1,
        );
      }
    }

    // 3. Final stats and threshold checks
    let sumFc = 0;
    let sumIndirectFc = 0;
    let minFc = Infinity;
    let maxFc = 0;
    let failingPoints = 0;
    const spaceGridPoints: PhotometricGridPoint[] = [];

    for (let i = 0; i < evalPts.length; i++) {
      const pt = evalPts[i]!;
      const elecFc = directElectricValues[i]!;
      const dlFc = directDaylightValues ? directDaylightValues[i]! : 0;
      const directFc = elecFc + dlFc;
      const pointIndirectFc = radiosityField
        ? radiosityField.gatherIndirectFc(pt.xMm, pt.yMm, evalZMm, 0, 0, 1, occlusion, rayOpts)
        : uniformReflectedFc;
      const fc = directFc + pointIndirectFc;
      sumFc += fc;
      sumIndirectFc += pointIndirectFc;
      if (fc < minFc) minFc = fc;
      if (fc > maxFc) maxFc = fc;
      const pointFail = fc < target.targetMinFc;
      if (pointFail) failingPoints++;
      const gp: PhotometricGridPoint = {
        xMm: pt.xMm,
        yMm: pt.yMm,
        zMm: evalZMm,
        col: pt.col,
        row: pt.row,
        fc: round2(fc),
        directFc: round2(directFc),
        ...(interReflectance ? { indirectFc: round2(pointIndirectFc) } : {}),
        ...(skyDome ? { daylightFc: round2(dlFc) } : {}),
        fail: pointFail,
        surfaceKind: "workplane",
      };
      spaceGridPoints.push(gp);
      allGridPoints.push(gp);
    }

    const n = evalPts.length;
    const avgFc = n > 0 ? sumFc / n : 0;
    const reflectedFc = n > 0 ? sumIndirectFc / n : uniformReflectedFc;
    const daylightAvgFc = skyDome && n > 0 ? daylightSum / n : undefined;
    const daylightFactorPct =
      skyDome && skyDome.outdoorHorizontalFc > 0 ? round2((avgFc / skyDome.outdoorHorizontalFc) * 100) : undefined;
    if (n === 0) minFc = 0;
    const avgMinRatio = minFc > 1e-4 ? avgFc / minFc : maxFc > 0 ? 999 : 0;
    const maxMinRatio = minFc > 1e-4 ? maxFc / minFc : maxFc > 0 ? 999 : 0;
    const lpdWPerSqFt = poly.areaSqFt > 0 ? spaceWatts / poly.areaSqFt : 0;

    const passAvg = avgFc >= target.targetAvgFc - 1e-4;
    const passMin = minFc >= target.targetMinFc - 1e-4;
    const passUniformity = maxMinRatio <= target.maxToMinRatio + 1e-4;
    const passLpd = lpdWPerSqFt <= target.maxLpdWPerSqFt + 1e-4;
    const pass = passAvg && passMin && passUniformity && passLpd;

    const failReasons: string[] = [];
    if (!passAvg) failReasons.push(`Average ${round2(avgFc)} fc < target ${target.targetAvgFc} fc`);
    if (!passMin) failReasons.push(`Minimum ${round2(minFc)} fc < target ${target.targetMinFc} fc`);
    if (!passUniformity) failReasons.push(`Max:Min ${round2(maxMinRatio)}:1 > limit ${target.maxToMinRatio}:1`);
    if (!passLpd) failReasons.push(`LPD ${round3(lpdWPerSqFt)} W/ft² > ASHRAE 90.1 limit ${target.maxLpdWPerSqFt} W/ft²`);

    if (pass) passingSpaces++;
    else failingSpaces++;

    sumWeightedAvg += avgFc * poly.areaSqFt;
    if (daylightFactorPct !== undefined) sumWeightedDaylightDf += daylightFactorPct * poly.areaSqFt;
    totalAreaSqFt += poly.areaSqFt;
    totalWatts += spaceWatts;
    totalFixtures += insideFixtures.length;
    if (minFc < overallMinFc) overallMinFc = minFc;
    if (maxFc > overallMaxFc) overallMaxFc = maxFc;

    spaceRadiosityLookup.push({
      levelId: poly.levelId,
      reflectedFc,
      radiosityField,
      outline: poly.outline,
    });

    spaces.push({
      spaceId: poly.id,
      name: poly.name,
      number: poly.number,
      levelId: poly.levelId,
      levelName: poly.levelName,
      levelElevationMm: poly.levelElevationMm,
      occupancyKey: target.occupancyKey,
      occupancyLabel: target.label,
      areaSqFt: round2(poly.areaSqFt),
      workplaneHeightIn: workplaneIn,
      gridSpacingFt,
      gridCols: grid.gridCols,
      gridRows: grid.gridRows,
      gridOriginXMm: grid.originXMm,
      gridOriginYMm: grid.originYMm,
      fixtureCount: insideFixtures.length,
      totalWatts: round2(spaceWatts),
      avgFc: round2(avgFc),
      minFc: round2(minFc),
      maxFc: round2(maxFc),
      avgMinRatio: round2(avgMinRatio),
      maxMinRatio: round2(maxMinRatio),
      reflectedFc: round2(reflectedFc),
      ...(daylightAvgFc !== undefined ? { daylightAvgFc: round2(daylightAvgFc) } : {}),
      ...(daylightFactorPct !== undefined ? { daylightFactorPct } : {}),
      reflectancesUsed,
      lpdWPerSqFt: round3(lpdWPerSqFt),
      target,
      passAvg,
      passMin,
      passUniformity,
      passLpd,
      pass,
      failingPoints,
      failReasons,
      gridPoints: spaceGridPoints,
    });
  }

  // Optional fine-grid horizontal task surfaces (kitchen countertops, islands, worktables, vanities)
  // and true 3D multi-flight stair tread & mid-landing evaluations
  const surfaceSummaries: SurfacePhotometricSummary[] = [];
  const stairSummaries: StairPhotometricSummary[] = [];

  if (includeTaskSurfaces && !options.zonesOnly) {
    const { taskSurfaces } = extractPartPhotometrics(model);
    for (const surf of taskSurfaces) {
      const lvl = levels.byId.get(surf.levelId);
      if (options.level && !matchesLevelFilter(lvl, options.level)) continue;
      const samplePts = buildTaskSurfaceGrid(surf);
      const box = boundingBoxOf(surf.outline);
      const candidates = includeElectric
        ? candidateLuminairesForVolume(allLuminaires, box.minX, box.maxX, box.minY, box.maxY, surf.zMm, surf.zMm + 100)
        : [];
      const cx = (box.minX + box.maxX) * 0.5;
      const cy = (box.minY + box.maxY) * 0.5;
      const hostSpace = interReflectance
        ? spaceRadiosityLookup.find((sp) => sp.levelId === surf.levelId && pointInPolygon(cx, cy, sp.outline))
        : undefined;

      const surfRayOpts: RayQueryOptions = {
        includeFurniture: includeFurnitureOcclusion,
        includeStairs: true,
        ignorePartId: surf.partId, // Counter/desk never self-occludes its own top face
      };

      let sumFc = 0;
      let minFc = Infinity;
      let maxFc = 0;
      const pts: PhotometricGridPoint[] = [];
      for (const pt of samplePts) {
        let directFc = 0;
        for (let li = 0; li < candidates.length; li++) {
          directFc += directIlluminanceFromLuminaire(candidates[li]!, pt.xMm, pt.yMm, pt.zMm, 1, occlusion, surfRayOpts);
        }
        const dlFc = skyDome ? evaluateDaylightAtPoint(skyDome, pt.xMm, pt.yMm, pt.zMm, 0, 0, 1, occlusion, surfRayOpts) : 0;
        const surfReflectedFc = hostSpace
          ? hostSpace.radiosityField
            ? hostSpace.radiosityField.gatherIndirectFc(pt.xMm, pt.yMm, pt.zMm, 0, 0, 1, occlusion, surfRayOpts)
            : hostSpace.reflectedFc
          : 0;
        const fc = directFc + dlFc + surfReflectedFc;
        sumFc += fc;
        if (fc < minFc) minFc = fc;
        if (fc > maxFc) maxFc = fc;
        pts.push({
          xMm: pt.xMm,
          yMm: pt.yMm,
          zMm: pt.zMm,
          col: pt.col,
          row: pt.row,
          fc: round2(fc),
          directFc: round2(directFc + dlFc),
          ...(interReflectance ? { indirectFc: round2(surfReflectedFc) } : {}),
          ...(skyDome ? { daylightFc: round2(dlFc) } : {}),
          fail: fc < surf.targetMinFc,
          rotationDeg: pt.rotationDeg,
          cellSizeMm: pt.cellSizeMm,
          surfaceKind: "task_surface",
        });
      }
      const n = pts.length;
      const avgFc = n > 0 ? sumFc / n : 0;
      if (n === 0) minFc = 0;
      const passAvg = avgFc >= surf.targetAvgFc - 1e-4;
      const passMin = minFc >= surf.targetMinFc - 1e-4;
      const failReasons: string[] = [];
      if (!passAvg) failReasons.push(`Surface avg ${round2(avgFc)} fc < target ${surf.targetAvgFc} fc`);
      if (!passMin) failReasons.push(`Surface min ${round2(minFc)} fc < target ${surf.targetMinFc} fc`);

      surfaceSummaries.push({
        partId: surf.partId,
        name: surf.name,
        surfaceKind: surf.surfaceKind,
        levelId: surf.levelId,
        levelName: surf.levelName,
        levelElevationMm: surf.levelElevationMm,
        zMm: surf.zMm,
        heightAffIn: surf.heightAffIn,
        areaSqFt: surf.areaSqFt,
        reflectance: surf.reflectance,
        ...(surf.materialName ? { materialName: surf.materialName } : {}),
        avgFc: round2(avgFc),
        minFc: round2(minFc),
        maxFc: round2(maxFc),
        targetAvgFc: surf.targetAvgFc,
        targetMinFc: surf.targetMinFc,
        pass: passAvg && passMin,
        failReasons,
        gridPoints: pts,
      });
    }

    // 3D Multi-flight stair treads & mid-landings (normal lighting check: IES stair target 10 fc avg, 3 fc min)
    for (const stair of extractStairs3D(model)) {
      const lvl = levels.byId.get(stair.levelId);
      if (options.level && !matchesLevelFilter(lvl, options.level)) continue;
      const stairGrid = buildStairGrid3D(stair, spacingMm);
      if (stairGrid.points.length === 0) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of stairGrid.points) {
        if (p.xMm < minX) minX = p.xMm;
        if (p.xMm > maxX) maxX = p.xMm;
        if (p.yMm < minY) minY = p.yMm;
        if (p.yMm > maxY) maxY = p.yMm;
      }
      const candidates = candidateLuminairesForVolume(
        allLuminaires,
        minX,
        maxX,
        minY,
        maxY,
        stair.levelElevationMm,
        stair.topLevelElevationMm,
      );
      const stairTarget = resolveNormalLightingTarget("stair", stair.name);
      let sumFc = 0;
      let minFc = Infinity;
      let maxFc = 0;
      const pts: PhotometricGridPoint[] = [];
      for (const pt of stairGrid.points) {
        let directFc = 0;
        for (let li = 0; li < candidates.length; li++) {
          directFc += directIlluminanceFromLuminaire(candidates[li]!, pt.xMm, pt.yMm, pt.zMm, 1, occlusion, rayOpts);
        }
        sumFc += directFc;
        if (directFc < minFc) minFc = directFc;
        if (directFc > maxFc) maxFc = directFc;
        pts.push({
          xMm: pt.xMm,
          yMm: pt.yMm,
          zMm: pt.zMm,
          col: pt.col,
          row: pt.row,
          fc: round2(directFc),
          directFc: round2(directFc),
          fail: directFc < stairTarget.targetMinFc,
          ...(pt.rotationDeg !== undefined ? { rotationDeg: pt.rotationDeg } : {}),
          cellSizeMm: pt.cellSizeMm,
          surfaceKind: "stair",
        });
      }
      const avgFc = sumFc / pts.length;
      const passAvg = avgFc >= stairTarget.targetAvgFc - 1e-4;
      const passMin = minFc >= stairTarget.targetMinFc - 1e-4;
      const failReasons: string[] = [];
      if (!passAvg) failReasons.push(`Stair avg ${round2(avgFc)} fc < target ${stairTarget.targetAvgFc} fc`);
      if (!passMin) failReasons.push(`Stair min ${round2(minFc)} fc < target ${stairTarget.targetMinFc} fc`);
      stairSummaries.push({
        stairId: stair.stairId,
        name: stair.name,
        form: stair.form,
        levelId: stair.levelId,
        levelName: stair.levelName,
        levelElevationMm: stair.levelElevationMm,
        topLevelElevationMm: stair.topLevelElevationMm,
        flightCount: stair.flights.length,
        landingCount: stair.landings.length,
        areaSqFt: stair.totalAreaSqFt,
        avgFc: round2(avgFc),
        minFc: round2(minFc),
        maxFc: round2(maxFc),
        targetAvgFc: stairTarget.targetAvgFc,
        targetMinFc: stairTarget.targetMinFc,
        pass: passAvg && passMin,
        failReasons,
        gridPoints: pts,
      });
    }
  }

  const elapsedMs = round2(performance.now() - t0);
  const result: PhotometricsNormalResult = {
    mode: "normal",
    calculationMode,
    useMaterialReflectances,
    includeFurnitureOcclusion,
    gridSpacingFt,
    workplaneHeightIn: defaultWorkplaneIn,
    interReflectance,
    radiosityMethod,
    ...(skyDome
      ? {
          daylight: {
            enabled: true as const,
            skyModel: skyDome.skyModel,
            outdoorHorizontalFc: skyDome.outdoorHorizontalFc,
            includeElectric,
            overallDaylightFactorPct: totalAreaSqFt > 0 ? round2(sumWeightedDaylightDf / totalAreaSqFt) : 0,
          },
        }
      : {}),
    reflectances: baseReflectances,
    totalFixtures,
    totalWatts: round2(totalWatts),
    totalAreaSqFt: round2(totalAreaSqFt),
    overallAvgFc: totalAreaSqFt > 0 ? round2(sumWeightedAvg / totalAreaSqFt) : 0,
    overallMinFc: Number.isFinite(overallMinFc) ? round2(overallMinFc) : 0,
    overallMaxFc: round2(overallMaxFc),
    overallLpdWPerSqFt: totalAreaSqFt > 0 ? round3(totalWatts / totalAreaSqFt) : 0,
    passingSpaces,
    failingSpaces,
    pass: spaces.length > 0 && failingSpaces === 0,
    spaces,
    surfaceSummaries,
    stairSummaries,
    gridPoints: allGridPoints,
    elapsedMs,
  };

  if (canCache) {
    let map = NORMAL_CACHE.get(model.elements);
    if (!map) {
      map = new Map();
      NORMAL_CACHE.set(model.elements, map);
    }
    if (map.size > 16) map.clear();
    map.set(cacheKey, result);
  }
  return result;
}

/**
 * Evaluate NFPA 101 §7.9.2.1 / IBC §1008.3.5 Emergency / Egress Path Illuminance
 * using ONLY emergency fixtures (`emergency_mode !== "none"` or on an emergency
 * circuit), evaluating floor-plane (`Z = 0"` AFF) illuminance for both initial
 * (`avg >= 1.0 fc, min >= 0.1 fc, max:min <= 40:1`) and 90-minute end-of-discharge
 * (`avg >= 0.6 fc, min >= 0.06 fc, max:min <= 40:1`) states.
 */
export function evaluateEgressPhotometrics(
  model: ModelState,
  options: EgressPhotometricsOptions = {},
): PhotometricsEgressResult {
  const calculationMode: PhotometricsCalculationMode = options.calculationMode ?? "detailed";
  const includeFurnitureOcclusion = options.includeFurnitureOcclusion ?? calculationMode !== "simplified";
  const rayOpts: RayQueryOptions = {
    includeFurniture: includeFurnitureOcclusion,
    includeStairs: true,
  };

  const canCache = !options.egressPaths || options.egressPaths.length === 0;
  const cacheKey = canCache
    ? JSON.stringify({
        l: options.level ?? "",
        g: options.gridSpacingFt ?? 2,
        w: options.workplaneHeightIn ?? 0,
        cm: calculationMode,
        fo: includeFurnitureOcclusion,
        ir: options.interReflectance ?? false,
        d: options.battery90MinDerate ?? DEFAULT_BATTERY_90MIN_DERATE,
      })
    : "";
  if (canCache) {
    const hit = EGRESS_CACHE.get(model.elements)?.get(cacheKey);
    if (hit) return hit;
  }

  const t0 = performance.now();
  const gridSpacingFt = Math.max(0.5, Math.min(20, options.gridSpacingFt ?? 2));
  const workplaneHeightIn = Math.max(0, Math.min(120, options.workplaneHeightIn ?? 0));
  const interReflectance = options.interReflectance ?? false;
  const battery90MinDerate = Math.max(0.1, Math.min(1, options.battery90MinDerate ?? DEFAULT_BATTERY_90MIN_DERATE));
  const reflectances: RoomReflectances = {
    ceiling: options.reflectances?.ceiling ?? DEFAULT_ROOM_REFLECTANCES.ceiling,
    wall: options.reflectances?.wall ?? DEFAULT_ROOM_REFLECTANCES.wall,
    floor: options.reflectances?.floor ?? DEFAULT_ROOM_REFLECTANCES.floor,
  };

  const levels = resolveLevels(model);
  const zones: EvaluationPolygon[] = [];
  if (!options.explicitOnly) {
    zones.push(...collectAutoEgressZones(model, options.level));
  }
  if (options.egressPaths) {
    for (const ep of options.egressPaths) {
      const outline = ep.outline && ep.outline.length >= 3
        ? ep.outline
        : ep.polyline && ep.polyline.length >= 2
          ? bufferPolyline(ep.polyline, (ep.widthFt ?? 4) * MM_PER_FT)
          : null;
      if (!outline || outline.length < 3) continue;
      const lvl =
        (ep.levelId ? levels.byId.get(ep.levelId) : undefined) ??
        (ep.levelName ? findLevelByName(levels.all, ep.levelName) : undefined) ??
        levels.all[0];
      if (!matchesLevelFilter(lvl, options.level)) continue;
      const areaSqFt = outlineAreaMm2(outline) / SQMM_PER_SQFT;
      if (areaSqFt <= 0.1) continue;
      zones.push({
        id: ep.id,
        name: ep.name,
        number: "",
        levelId: lvl?.id ?? "",
        levelName: lvl?.name ?? ep.levelName ?? "Level 1",
        levelElevationMm: lvl?.elevationMm ?? 0,
        outline,
        areaSqFt,
        perimeterFt: polygonPerimeterMm(outline) / MM_PER_FT,
        ceilingHeightMm: 2743,
        workplaneHeightIn,
        egressKind: "explicit_path",
      });
    }
  }

  // Strictly filter to emergency luminaires only
  const emergencyLuminaires = collectLuminaires(model, battery90MinDerate).filter((l) => l.photo.isEmergency && l.photo.emergencyScale > 0);
  const occlusion = occlusionIndexOf(model);
  const spacingMm = gridSpacingFt * MM_PER_FT;
  const T = NFPA101_IBC_EGRESS_THRESHOLDS;

  const paths: EgressPathSummary[] = [];
  const allGridPoints: PhotometricGridPoint[] = [];

  let totalAreaSqFt = 0;
  let sumWeightedInit = 0;
  let sumWeighted90 = 0;
  let overallMinInit = Infinity;
  let overallMaxInit = 0;
  let overallMin90 = Infinity;
  let overallMax90 = 0;
  let passingPaths = 0;
  let failingPaths = 0;

  for (const poly of zones) {
    const wpIn = poly.workplaneHeightIn ?? workplaneHeightIn;
    const evalZMm = poly.levelElevationMm + wpIn * MM_PER_IN;
    const grid = buildPolygonGrid(poly.outline, spacingMm);
    const candidates = candidateLuminairesForPolygon(emergencyLuminaires, poly, evalZMm);

    const insideFixtures = candidates.filter((lum) => {
      if (lum.levelId !== poly.levelId) return false;
      if (pointInPolygon(lum.xMm, lum.yMm, poly.outline)) return true;
      // Exterior wall packs sit on the exterior wall face right beside the exit discharge pad
      return poly.egressKind === "exit_discharge" && distToPolygonEdges(lum.xMm, lum.yMm, poly.outline) < 1200;
    });

    // Filter out floor points strictly inside solid floor-standing cabinets/islands/columns (not walkable egress floor)
    // and points directly underneath a low stair flight waist (< 1800 mm headroom — non-walkable enclosed under-stair zone)
    const activePts = grid.points.filter((pt) => !occlusion.isPointInsideSolid(pt.xMm, pt.yMm, evalZMm, rayOpts));
    const evalPts = activePts.length > 0 ? activePts : grid.points;

    const directInit = new Float64Array(evalPts.length);
    const direct90 = new Float64Array(evalPts.length);
    let sumDirectInit = 0;
    let sumDirect90 = 0;

    for (let i = 0; i < evalPts.length; i++) {
      const pt = evalPts[i]!;
      let fcInit = 0;
      let fc90 = 0;
      for (let li = 0; li < candidates.length; li++) {
        const lum = candidates[li]!;
        const eInit = directIlluminanceFromLuminaire(lum, pt.xMm, pt.yMm, evalZMm, lum.photo.emergencyScale, occlusion, rayOpts);
        if (eInit > 0) {
          fcInit += eInit;
          fc90 += eInit * lum.photo.endOfDischargeFactor;
        }
      }
      directInit[i] = fcInit;
      direct90[i] = fc90;
      sumDirectInit += fcInit;
      sumDirect90 += fc90;
    }

    const avgDirectInit = evalPts.length > 0 ? sumDirectInit / evalPts.length : 0;
    const avgDirect90 = evalPts.length > 0 ? sumDirect90 / evalPts.length : 0;
    const cavityHeightFt = Math.max(1, (poly.ceilingHeightMm - wpIn * MM_PER_IN) / MM_PER_FT);
    const reflInit =
      interReflectance && poly.egressKind !== "exit_discharge"
        ? computeInterReflectanceFc(insideFixtures, poly.areaSqFt, poly.perimeterFt, cavityHeightFt, avgDirectInit, reflectances, (l) => l.photo.emergencyScale)
        : 0;
    const refl90 =
      interReflectance && poly.egressKind !== "exit_discharge"
        ? computeInterReflectanceFc(insideFixtures, poly.areaSqFt, poly.perimeterFt, cavityHeightFt, avgDirect90, reflectances, (l) => l.photo.emergencyScale * l.photo.endOfDischargeFactor)
        : 0;

    let sumInit = 0;
    let minInit = Infinity;
    let maxInit = 0;
    let sum90 = 0;
    let min90 = Infinity;
    let max90 = 0;
    let failingPoints = 0;
    const pathGridPoints: PhotometricGridPoint[] = [];

    for (let i = 0; i < evalPts.length; i++) {
      const pt = evalPts[i]!;
      const fcInit = directInit[i]! + reflInit;
      const fc90 = direct90[i]! + refl90;
      sumInit += fcInit;
      sum90 += fc90;
      if (fcInit < minInit) minInit = fcInit;
      if (fcInit > maxInit) maxInit = fcInit;
      if (fc90 < min90) min90 = fc90;
      if (fc90 > max90) max90 = fc90;
      const pointFail = fcInit < T.initialMinFc || fc90 < T.end90MinMinFc;
      if (pointFail) failingPoints++;
      const gp: PhotometricGridPoint = {
        xMm: pt.xMm,
        yMm: pt.yMm,
        zMm: evalZMm,
        col: pt.col,
        row: pt.row,
        fc: round2(fcInit),
        directFc: round2(directInit[i]!),
        fc90Min: round2(fc90),
        fail: pointFail,
        surfaceKind: "workplane",
      };
      pathGridPoints.push(gp);
      allGridPoints.push(gp);
    }

    const n = evalPts.length;
    const avgInit = n > 0 ? sumInit / n : 0;
    const avg90 = n > 0 ? sum90 / n : 0;
    if (n === 0) {
      minInit = 0;
      min90 = 0;
    }
    const avgMinRatio = minInit > 1e-4 ? avgInit / minInit : maxInit > 0 ? 999 : 0;
    const maxMinRatio = minInit > 1e-4 ? maxInit / minInit : maxInit > 0 ? 999 : 0;
    const maxMinRatio90 = min90 > 1e-4 ? max90 / min90 : max90 > 0 ? 999 : 0;

    const passInitial =
      avgInit >= T.initialAvgFc - 1e-4 &&
      minInit >= T.initialMinFc - 1e-4 &&
      maxMinRatio <= T.maxToMinRatio + 1e-4;
    const pass90Min =
      avg90 >= T.end90MinAvgFc - 1e-4 &&
      min90 >= T.end90MinMinFc - 1e-4 &&
      maxMinRatio90 <= T.maxToMinRatio + 1e-4;
    const pass = passInitial && pass90Min;

    const failReasons: string[] = [];
    if (avgInit < T.initialAvgFc - 1e-4) failReasons.push(`Initial avg ${round2(avgInit)} fc < ${T.initialAvgFc} fc (NFPA 101 §7.9.2.1)`);
    if (minInit < T.initialMinFc - 1e-4) failReasons.push(`Initial min ${round2(minInit)} fc < ${T.initialMinFc} fc (NFPA 101 §7.9.2.1)`);
    if (maxMinRatio > T.maxToMinRatio + 1e-4) failReasons.push(`Initial max:min ${round2(maxMinRatio)}:1 > ${T.maxToMinRatio}:1`);
    if (avg90 < T.end90MinAvgFc - 1e-4) failReasons.push(`90-min avg ${round2(avg90)} fc < ${T.end90MinAvgFc} fc (NFPA 101 §7.9.2.1)`);
    if (min90 < T.end90MinMinFc - 1e-4) failReasons.push(`90-min min ${round2(min90)} fc < ${T.end90MinMinFc} fc (NFPA 101 §7.9.2.1)`);
    if (maxMinRatio90 > T.maxToMinRatio + 1e-4) failReasons.push(`90-min max:min ${round2(maxMinRatio90)}:1 > ${T.maxToMinRatio}:1`);

    if (pass) passingPaths++;
    else failingPaths++;

    totalAreaSqFt += poly.areaSqFt;
    sumWeightedInit += avgInit * poly.areaSqFt;
    sumWeighted90 += avg90 * poly.areaSqFt;
    if (minInit < overallMinInit) overallMinInit = minInit;
    if (maxInit > overallMaxInit) overallMaxInit = maxInit;
    if (min90 < overallMin90) overallMin90 = min90;
    if (max90 > overallMax90) overallMax90 = max90;

    paths.push({
      pathId: poly.id,
      name: poly.name,
      kind: poly.egressKind ?? "corridor_space",
      levelId: poly.levelId,
      levelName: poly.levelName,
      levelElevationMm: poly.levelElevationMm,
      areaSqFt: round2(poly.areaSqFt),
      workplaneHeightIn: wpIn,
      gridSpacingFt,
      gridCols: grid.gridCols,
      gridRows: grid.gridRows,
      gridOriginXMm: grid.originXMm,
      gridOriginYMm: grid.originYMm,
      emergencyFixtureCount: insideFixtures.length,
      avgFc: round2(avgInit),
      minFc: round2(minInit),
      maxFc: round2(maxInit),
      avgMinRatio: round2(avgMinRatio),
      maxMinRatio: round2(maxMinRatio),
      avgFc90Min: round2(avg90),
      minFc90Min: round2(min90),
      maxFc90Min: round2(max90),
      maxMinRatio90Min: round2(maxMinRatio90),
      passInitial,
      pass90Min,
      pass,
      failingPoints,
      failReasons,
      gridPoints: pathGridPoints,
    });
  }

  // Evaluate true 3D multi-flight stairs (Flight 1 rising treads + Mid-Landing + Flight 2 rising treads)
  // when not restricted to explicitOnly paths and not already represented by a dedicated stair room.
  if (!options.explicitOnly) {
    const existingStairRoomIds = new Set(paths.filter((p) => p.kind === "stair").map((p) => p.pathId));
    for (const stair of extractStairs3D(model)) {
      if (existingStairRoomIds.has(stair.stairId)) continue;
      const lvl = levels.byId.get(stair.levelId);
      if (options.level && !matchesLevelFilter(lvl, options.level)) continue;
      const stairGrid = buildStairGrid3D(stair, spacingMm);
      if (stairGrid.points.length === 0) continue;

      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of stairGrid.points) {
        if (p.xMm < minX) minX = p.xMm;
        if (p.xMm > maxX) maxX = p.xMm;
        if (p.yMm < minY) minY = p.yMm;
        if (p.yMm > maxY) maxY = p.yMm;
      }

      const candidates = candidateLuminairesForVolume(
        emergencyLuminaires,
        minX,
        maxX,
        minY,
        maxY,
        stair.levelElevationMm,
        stair.topLevelElevationMm,
      );

      let sumInit = 0;
      let minInit = Infinity;
      let maxInit = 0;
      let sum90 = 0;
      let min90 = Infinity;
      let max90 = 0;
      let failingPoints = 0;
      const stairPoints: PhotometricGridPoint[] = [];

      for (const pt of stairGrid.points) {
        let fcInit = 0;
        let fc90 = 0;
        for (let li = 0; li < candidates.length; li++) {
          const lum = candidates[li]!;
          const eInit = directIlluminanceFromLuminaire(lum, pt.xMm, pt.yMm, pt.zMm, lum.photo.emergencyScale, occlusion, rayOpts);
          if (eInit > 0) {
            fcInit += eInit;
            fc90 += eInit * lum.photo.endOfDischargeFactor;
          }
        }
        sumInit += fcInit;
        sum90 += fc90;
        if (fcInit < minInit) minInit = fcInit;
        if (fcInit > maxInit) maxInit = fcInit;
        if (fc90 < min90) min90 = fc90;
        if (fc90 > max90) max90 = fc90;
        const pointFail = fcInit < T.initialMinFc || fc90 < T.end90MinMinFc;
        if (pointFail) failingPoints++;
        const gp: PhotometricGridPoint = {
          xMm: pt.xMm,
          yMm: pt.yMm,
          zMm: pt.zMm,
          col: pt.col,
          row: pt.row,
          fc: round2(fcInit),
          directFc: round2(fcInit),
          fc90Min: round2(fc90),
          fail: pointFail,
          ...(pt.rotationDeg !== undefined ? { rotationDeg: pt.rotationDeg } : {}),
          cellSizeMm: pt.cellSizeMm,
          surfaceKind: "stair",
        };
        stairPoints.push(gp);
        allGridPoints.push(gp);
      }

      const n = stairPoints.length;
      const avgInit = sumInit / n;
      const avg90 = sum90 / n;
      const avgMinRatio = minInit > 1e-4 ? avgInit / minInit : maxInit > 0 ? 999 : 0;
      const maxMinRatio = minInit > 1e-4 ? maxInit / minInit : maxInit > 0 ? 999 : 0;
      const maxMinRatio90 = min90 > 1e-4 ? max90 / min90 : max90 > 0 ? 999 : 0;

      const passInitial =
        avgInit >= T.initialAvgFc - 1e-4 &&
        minInit >= T.initialMinFc - 1e-4 &&
        maxMinRatio <= T.maxToMinRatio + 1e-4;
      const pass90Min =
        avg90 >= T.end90MinAvgFc - 1e-4 &&
        min90 >= T.end90MinMinFc - 1e-4 &&
        maxMinRatio90 <= T.maxToMinRatio + 1e-4;
      const pass = passInitial && pass90Min;

      const failReasons: string[] = [];
      if (avgInit < T.initialAvgFc - 1e-4) failReasons.push(`Initial avg ${round2(avgInit)} fc < ${T.initialAvgFc} fc (NFPA 101 §7.9.2.1)`);
      if (minInit < T.initialMinFc - 1e-4) failReasons.push(`Initial min ${round2(minInit)} fc < ${T.initialMinFc} fc (NFPA 101 §7.9.2.1)`);
      if (maxMinRatio > T.maxToMinRatio + 1e-4) failReasons.push(`Initial max:min ${round2(maxMinRatio)}:1 > ${T.maxToMinRatio}:1`);
      if (avg90 < T.end90MinAvgFc - 1e-4) failReasons.push(`90-min avg ${round2(avg90)} fc < ${T.end90MinAvgFc} fc (NFPA 101 §7.9.2.1)`);
      if (min90 < T.end90MinMinFc - 1e-4) failReasons.push(`90-min min ${round2(min90)} fc < ${T.end90MinMinFc} fc (NFPA 101 §7.9.2.1)`);
      if (maxMinRatio90 > T.maxToMinRatio + 1e-4) failReasons.push(`90-min max:min ${round2(maxMinRatio90)}:1 > ${T.maxToMinRatio}:1`);

      if (pass) passingPaths++;
      else failingPaths++;

      const nearbyCount = candidates.filter((lum) => lum.xMm >= minX - 1800 && lum.xMm <= maxX + 1800 && lum.yMm >= minY - 1800 && lum.yMm <= maxY + 1800).length;

      totalAreaSqFt += stair.totalAreaSqFt;
      sumWeightedInit += avgInit * stair.totalAreaSqFt;
      sumWeighted90 += avg90 * stair.totalAreaSqFt;
      if (minInit < overallMinInit) overallMinInit = minInit;
      if (maxInit > overallMaxInit) overallMaxInit = maxInit;
      if (min90 < overallMin90) overallMin90 = min90;
      if (max90 > overallMax90) overallMax90 = max90;

      paths.push({
        pathId: `egress_stair:${stair.stairId}`,
        name: `${stair.name} (${stair.flights.length}F/${stair.landings.length}L 3D treads)`,
        kind: "stair",
        levelId: stair.levelId,
        levelName: stair.levelName,
        levelElevationMm: stair.levelElevationMm,
        areaSqFt: stair.totalAreaSqFt,
        workplaneHeightIn: 0,
        gridSpacingFt,
        gridCols: stairGrid.gridCols,
        gridRows: stairGrid.gridRows,
        gridOriginXMm: stairGrid.originXMm,
        gridOriginYMm: stairGrid.originYMm,
        emergencyFixtureCount: nearbyCount,
        avgFc: round2(avgInit),
        minFc: round2(minInit),
        maxFc: round2(maxInit),
        avgMinRatio: round2(avgMinRatio),
        maxMinRatio: round2(maxMinRatio),
        avgFc90Min: round2(avg90),
        minFc90Min: round2(min90),
        maxFc90Min: round2(max90),
        maxMinRatio90Min: round2(maxMinRatio90),
        passInitial,
        pass90Min,
        pass,
        failingPoints,
        failReasons,
        gridPoints: stairPoints,
      });
    }
  }

  const overallMinInitFinal = Number.isFinite(overallMinInit) ? overallMinInit : 0;
  const overallMin90Final = Number.isFinite(overallMin90) ? overallMin90 : 0;
  const overallMaxMin = overallMinInitFinal > 1e-4 ? overallMaxInit / overallMinInitFinal : overallMaxInit > 0 ? 999 : 0;
  const overallMaxMin90 = overallMin90Final > 1e-4 ? overallMax90 / overallMin90Final : overallMax90 > 0 ? 999 : 0;
  const passInitial = paths.length > 0 && paths.every((p) => p.passInitial);
  const pass90Min = paths.length > 0 && paths.every((p) => p.pass90Min);
  const elapsedMs = round2(performance.now() - t0);

  const result: PhotometricsEgressResult = {
    mode: "egress",
    gridSpacingFt,
    workplaneHeightIn,
    interReflectance,
    battery90MinDerate,
    thresholds: T,
    emergencyFixtureCount: emergencyLuminaires.length,
    totalAreaSqFt: round2(totalAreaSqFt),
    overallAvgFc: totalAreaSqFt > 0 ? round2(sumWeightedInit / totalAreaSqFt) : 0,
    overallMinFc: round2(overallMinInitFinal),
    overallMaxFc: round2(overallMaxInit),
    overallMaxMinRatio: round2(overallMaxMin),
    overallAvgFc90Min: totalAreaSqFt > 0 ? round2(sumWeighted90 / totalAreaSqFt) : 0,
    overallMinFc90Min: round2(overallMin90Final),
    overallMaxMinRatio90Min: round2(overallMaxMin90),
    passingPaths,
    failingPaths,
    passInitial,
    pass90Min,
    pass: passInitial && pass90Min,
    paths,
    gridPoints: allGridPoints,
    elapsedMs,
  };

  if (canCache) {
    let map = EGRESS_CACHE.get(model.elements);
    if (!map) {
      map = new Map();
      EGRESS_CACHE.set(model.elements, map);
    }
    if (map.size > 16) map.clear();
    map.set(cacheKey, result);
  }
  return result;
}
