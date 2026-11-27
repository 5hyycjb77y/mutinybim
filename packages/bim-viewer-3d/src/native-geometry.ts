/**
 * Kernel model -> renderable solids. Pure and deterministic (no three.js), so
 * the shapes can be unit-tested and diffed by element id + version.
 *
 * Every element stands on its own level's elevation (`floorOf`). ElevationRules
 * give the heights the kernel doesn't carry (an older duct's centreline above
 * its floor), and a floor only for a model with no level records.
 */
import {
  colourNumber,
  columnVerticalSpan,
  fittingBody,
  fittingMesh,
  flexRings,
  insulationEnvelope,
  isBuildingStoryLevel,
  partGeometryReady,
  partMesh,
  mountedPositions,
  partToWorld,
  placedGeometry,
  placedIntakePrimitives,
  routeJoinFace,
  segmentRings,
  straightPiece,
  styleOfSystemId,
  drawnWidth,
  sizeHeight,
  sizeWidth,
  type BimElement,
  type ElementId,
  type FittingMesh,
  type ModelState,
  type PartCategory,
  type PartInstance,
  type PartTypeElement,
  type Partition,
  type Profile,
  type ResolvedPrimitive,
  type Ring,
  type RouteJoin,
  type RunFitting,
  type RunPoint,
  type RunSegment,
  elementEntries, elementTypeValue, elementsOfKind,
  levelOf as kernelLevelOf,
  KNOWN_COMPONENT_CATEGORIES,
  asCeiling,
  hostSolidBlocks,
  wallBaseAtMm,
  wallBodyProfile,
  hostVoidsOf,
  kindRowOf,
  activeClassRegistry,
  classSolidsOf,
  hasClassSolids,
  materialOf,
  resolveElementMaterial,
  type ClassSolidPart,
  type KindSolidShape,
  type Vec2,
} from "@permitzip/bim-kernel";
import { kernelToScene, MM, planAngleToSceneYaw, type Vec3Tuple } from "./coords";
import { prismsSolid, type PrismBlock } from "./prism-mesh";

export type SolidShape = "box" | "cylinder" | "mesh";

/** Render groups: one material per group, so the scene draws a handful of instanced batches. */
export type RenderGroup =
  | "duct"
  | "duct_fitting"
  | "terminal"
  | "equipment"
  | "pipe"
  | "electrical"
  | "sprinkler"
  | "wall"
  | "slab"
  | "structure"
  | "riser"
  | "furnishing"
  /** The outside face of wrapped duct, drawn see-through over the metal. */
  | "insulation"
  /** A mounting plane: see-through, and a surface parts are placed on. */
  | "mounting_plane"
  /** What fills a host's void by its class body (frames, leaves, sills, louvre blades). */
  | "filler"
  /** A class body's `glazing` parts: see-through. */
  | "glazing";

export interface Solid {
  readonly elementId: ElementId;
  readonly version: number;
  readonly group: RenderGroup;
  readonly shape: SolidShape;
  /** Scene metres. */
  readonly center: Vec3Tuple;
  /** Box: length along local X, height (scene Y), depth (local Z). Cylinder: length along local X, diameter. */
  readonly size: Vec3Tuple;
  /** Rotation about the scene up axis, radians. Cylinders along X when `vertical` is false. */
  readonly yaw: number;
  readonly vertical?: boolean;
  /** Boxes and lying cylinders: rise along local X, radians (a drain's fall is negative). */
  readonly pitch?: number;
  /** Shape "mesh": triangles in scene metres, relative to `center` (sheet-metal fittings). */
  readonly mesh?: { readonly positions: Float32Array; readonly indices: Uint32Array };
  /** 0xRRGGBB: the run's system colour, over the group's (pipe and duct runs on a system). */
  readonly tint?: number;
  /** Registered `kernel.material` id for PBR color, roughness, metalness and procedural texture. */
  readonly materialId?: string;
}

export interface ElevationRules {
  /** Elevation of a level's floor (mm), for an element whose model has no record of its level. */
  readonly levelElevationMm: (level: string) => number;
  /** Duct centreline above its level's floor (mm). */
  readonly ductCenterAboveFloorMm: number;
  /** Ceiling (diffuser face) above floor (mm). */
  readonly ceilingAboveFloorMm: number;
  /** Equipment body height (mm). */
  readonly equipmentHeightMm: number;
  /** Floor-to-floor height, for walls and risers (mm). */
  readonly floorToFloorMm: number;
}

const LEVEL_NUMBER = /(\d+)/;

export const DEFAULT_ELEVATIONS: ElevationRules = {
  levelElevationMm: (level) => {
    const n = Number(LEVEL_NUMBER.exec(level)?.[1] ?? "1");
    return Math.max(0, n - 1) * 4200;
  },
  ductCenterAboveFloorMm: 3200,
  ceilingAboveFloorMm: 2743,
  equipmentHeightMm: 1100,
  floorToFloorMm: 4200,
};

const TERMINAL_FACE_MM = 600;
const TERMINAL_DEPTH_MM = 60;

function levelOf(partition: Partition | undefined): string {
  return partition?.level ?? "L1";
}

/** The floor (mm) an element stands on: its level's real elevation (the kernel's `levelOf`); the rules' guess only when the model has no record of that level. */
function floorOf(el: BimElement, rules: ElevationRules, model: ModelState | undefined): number {
  const level = model ? kernelLevelOf(model.elements, el) : null;
  return level ? level.elevationMm : rules.levelElevationMm(levelOf(el.partition));
}

function profileSize(profile: Profile): { width: number; height: number; round: boolean } {
  return profile.shape === "rect"
    ? { width: profile.width, height: profile.height, round: false }
    : { width: profile.diameter, height: profile.diameter, round: true };
}

function networkGroup(el: { readonly service?: string }, fallback: RenderGroup): RenderGroup {
  switch (el.service) {
    case "water":
      return "pipe";
    case "power":
      return "electrical";
    case "sprinkler":
      return "sprinkler";
    default:
      return fallback;
  }
}

const PART_GROUP: Readonly<Record<PartCategory, RenderGroup>> = {
  mechanical_equipment: "equipment",
  air_terminal: "terminal",
  duct_accessory: "duct_fitting",
  pipe_accessory: "pipe",
  plumbing_fixture: "pipe",
  electrical_equipment: "electrical",
  electrical_device: "electrical",
  lighting_fixture: "electrical",
  generic: "furnishing",
};

/**
 * A placed part's solids from its type's primitives: boxes and cylinders as
 * they are, extrusions as their bounding box (the renderer draws boxes and
 * cylinders only). Heights are the level's elevation plus the part's offset.
 */
export function partSolids(part: PartInstance, type: PartTypeElement, levelElevationMm: number): Solid[] {
  const group = PART_GROUP[type.definition.category];
  // Check Schema-1/Schema-2 feature material names so scripted parts inherit real materials automatically.
  let featureMaterialId: string | undefined;
  const defModel = type.definition.model;
  if (defModel && "features" in defModel && Array.isArray(defModel.features)) {
    for (const f of defModel.features) {
      if (f && typeof f === "object" && "material" in f && typeof f.material === "string") {
        const resolved = materialOf(f.material);
        if (resolved) {
          featureMaterialId = resolved.id;
          break;
        }
      }
    }
  }
  const base = { elementId: part.id, version: part.version, group, ...(featureMaterialId ? { materialId: featureMaterialId } : {}) };
  // Until the geometry engine has loaded, a modeled part draws as its features' bounding boxes (below); the session says so and redraws once it is ready.
  if (type.definition.model && partGeometryReady()) {
    return [modeledPartSolid(part, type, levelElevationMm, base), ...primitiveSolids(part, placedIntakePrimitives(type, part), levelElevationMm, base)];
  }
  return primitiveSolids(part, placedGeometry(type, part), levelElevationMm, base);
}

/** Boxes and cylinders as they are, extrusions as their bounding box, placed with the part. */
function primitiveSolids(part: PartInstance, prims: readonly ResolvedPrimitive[], levelElevationMm: number, base: { elementId: ElementId; version: number; group: RenderGroup }): Solid[] {
  const yaw = (part.rotationDeg * Math.PI) / 180;
  const at = (lx: number, ly: number, lz: number) => {
    const w = partToWorld(part, { x: lx, y: ly });
    return kernelToScene(w.x, w.y, levelElevationMm + part.offsetMm + lz);
  };
  const out: Solid[] = [];
  for (const prim of prims) {
    if (prim.kind === "box") {
      const [sx, sy, sz] = prim.size;
      if (sx <= 0 || sy <= 0 || sz <= 0) continue;
      out.push({ ...base, shape: "box", center: at(prim.center[0], prim.center[1], prim.center[2]), size: [sx * MM, sz * MM, sy * MM], yaw });
    } else if (prim.kind === "cylinder") {
      if (prim.radius <= 0 || prim.height <= 0) continue;
      const d = prim.radius * 2 * MM;
      const center = at(prim.center[0], prim.center[1], prim.center[2]);
      if (prim.axis === "z") out.push({ ...base, shape: "cylinder", center, size: [prim.height * MM, d, d], yaw, vertical: true });
      else out.push({ ...base, shape: "cylinder", center, size: [prim.height * MM, d, d], yaw: prim.axis === "x" ? yaw : yaw + Math.PI / 2 });
    } else {
      const xs = prim.profile.map((q) => q.x);
      const ys = prim.profile.map((q) => q.y);
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      if (maxX <= minX || maxY <= minY || prim.height <= 0) continue;
      out.push({
        ...base,
        shape: "box",
        center: at((minX + maxX) / 2, (minY + maxY) / 2, prim.z + prim.height / 2),
        size: [(maxX - minX) * MM, prim.height * MM, (maxY - minY) * MM],
        yaw,
      });
    }
  }
  return out;
}

interface SceneMesh {
  positions: Float32Array;
  indices: Uint32Array;
  size: Vec3Tuple;
}

/** Scene-metre buffers per kernel mesh and mount: every placed copy of one size, mounted the same way, shares them. */
const sceneMeshes = new WeakMap<object, Map<string, SceneMesh>>();

/**
 * A modeled part as one mesh solid. Vertices stay in the part's own frame
 * (mounted, then rotated by `yaw` when drawn), so the buffers are shared by
 * every part of the same size and mount.
 */
function modeledPartSolid(part: PartInstance, type: PartTypeElement, levelElevationMm: number, base: { elementId: ElementId; version: number; group: RenderGroup }): Solid {
  const local = partMesh(type.definition, part.values, "fine");
  const key = part.mount ?? "as_drawn";
  let byMount = sceneMeshes.get(local);
  if (!byMount) {
    byMount = new Map();
    sceneMeshes.set(local, byMount);
  }
  let scene = byMount.get(key);
  if (!scene) {
    const mounted = mountedPositions(local.positions, part.mount);
    const positions = new Float32Array(mounted.length);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mounted.length; i += 3) {
      const x = mounted[i] ?? 0;
      const y = mounted[i + 1] ?? 0;
      const z = mounted[i + 2] ?? 0;
      positions[i] = x * MM;
      positions[i + 1] = z * MM;
      positions[i + 2] = -y * MM;
      [x, y, z].forEach((v, k) => {
        lo[k] = Math.min(lo[k] ?? v, v);
        hi[k] = Math.max(hi[k] ?? v, v);
      });
    }
    const span = (k: number) => (Number.isFinite(lo[k]) ? (hi[k] ?? 0) - (lo[k] ?? 0) : 0);
    scene = { positions, indices: local.indices, size: [span(0) * MM, span(2) * MM, span(1) * MM] };
    byMount.set(key, scene);
  }
  return {
    ...base,
    shape: "mesh",
    center: kernelToScene(part.position.x, part.position.y, levelElevationMm + part.offsetMm),
    size: scene.size,
    yaw: (part.rotationDeg * Math.PI) / 180,
    mesh: { positions: scene.positions, indices: scene.indices },
  };
}

/** A library fitting as sheet metal: its body triangulated, in scene metres around its insertion point. */
function fittingMeshSolid(el: RunFitting, elements: ModelState["elements"], levelElevationMm: number, group: RenderGroup): Solid | null {
  return meshSolid(el, fittingMesh(fittingBody(elements, el)), el.position, levelElevationMm, group);
}

/** Triangles in model millimetres as a solid in scene metres around `origin`. */
function meshSolid(el: RunSegment | RunFitting, mesh: FittingMesh, origin: RunPoint, levelElevationMm: number, group: RenderGroup): Solid | null {
  if (mesh.indices.length === 0) return null;
  const center = kernelToScene(origin.x, origin.y, levelElevationMm + origin.z);
  const positions = new Float32Array(mesh.positions.length);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = kernelToScene(mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, levelElevationMm + (mesh.positions[i + 2] ?? 0));
    for (let k = 0; k < 3; k++) {
      const v = (p[k] ?? 0) - (center[k] ?? 0);
      positions[i + k] = v;
      lo[k] = Math.min(lo[k] ?? v, v);
      hi[k] = Math.max(hi[k] ?? v, v);
    }
  }
  const size: Vec3Tuple = [(hi[0] ?? 0) - (lo[0] ?? 0), (hi[1] ?? 0) - (lo[1] ?? 0), (hi[2] ?? 0) - (lo[2] ?? 0)];
  return { elementId: el.id, version: el.version, group, shape: "mesh", center, size, yaw: 0, mesh: { positions, indices: Uint32Array.from(mesh.indices) } };
}

const JOIN_COLLAR_MM = 40;
const JOIN_GROW = 1.08;

/**
 * The face a route being drawn would join, as a short collar just proud of it
 * (an open end to continue, or where a branch tap would be cut). Drawn over
 * the model while routing; never picked.
 */
export function routeJoinSolids(model: ModelState, join: RouteJoin, levelElevationMm: number): Solid[] {
  const face = routeJoinFace(model.elements, join);
  if (!face) return [];
  const grown = (center: RunPoint): Ring => ({ ...face.ring, center, a: scaleBy(face.ring.a, JOIN_GROW), b: scaleBy(face.ring.b, JOIN_GROW) });
  const c = face.ring.center;
  const out = { x: c.x + face.normal.x * JOIN_COLLAR_MM, y: c.y + face.normal.y * JOIN_COLLAR_MM, z: c.z + face.normal.z * JOIN_COLLAR_MM };
  const mesh = fittingMesh({ family: null, tubes: [{ rings: [grown(c), grown(out)], faceted: true }], plates: [{ kind: "disc", ring: grown(out) }], faces: {}, takeoffs: {} });
  const id = join.kind === "run_end" ? join.elementId : join.segmentId;
  const el = model.elements[id];
  if (el?.kind !== "run_segment" && el?.kind !== "run_fitting") return [];
  const solid = meshSolid(el, mesh, c, levelElevationMm, el.domain === "duct" ? "duct_fitting" : "pipe");
  return solid ? [solid] : [];
}

function scaleBy(v: RunPoint, k: number): RunPoint {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

/**
 * A routed segment or fitting: real heights (level floor + its own z), any direction including straight up and down.
 * With the model, library fittings draw as sheet metal and segments draw only the straight duct between them.
 */
export function runSolids(el: RunSegment | RunFitting, levelElevationMm: number, model?: ModelState): Solid[] {
  const base = { elementId: el.id, version: el.version };
  const group: RenderGroup = el.domain === "duct" ? (el.kind === "run_segment" ? "duct" : "duct_fitting") : el.domain === "conduit" ? "electrical" : "pipe";
  // Library fittings (duct sheet metal, pipe fittings with their hubs) draw their own body.
  if (el.kind === "run_fitting" && model && el.domain !== "conduit" && el.family !== undefined) {
    const solid = fittingMeshSolid(el, model.elements, levelElevationMm, group);
    if (solid) return [solid];
  }
  if (el.kind === "run_segment" && el.flex) {
    const solid = meshSolid(el, fittingMesh({ family: null, tubes: [{ rings: flexRings(el), faceted: false }], plates: [], faces: {}, takeoffs: {} }), el.start, levelElevationMm, group);
    return solid ? [solid] : [];
  }
  if (el.kind === "run_segment") {
    const libraryEnds = model !== undefined && el.domain !== "conduit" && [el.links.start, el.links.end].some((l) => {
      const f = l ? model.elements[l.elementId] : undefined;
      return f?.kind === "run_fitting" && f.family !== undefined;
    });
    const piece = libraryEnds && model ? straightPiece(model.elements, el) : null;
    if (piece && piece.lengthMm <= 0) return [];
    const from = piece?.start ?? el.start;
    const to = piece?.end ?? el.end;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const planLen = Math.hypot(dx, dy);
    const len = Math.hypot(planLen, dz);
    if (len === 0) return [];
    const width = drawnWidth(el.size);
    const round = el.size.shape !== "rect";
    const height = round ? width : sizeHeight(el.size);
    const center = kernelToScene((from.x + to.x) / 2, (from.y + to.y) / 2, levelElevationMm + (from.z + to.z) / 2);
    // Rectangular risers and steep slopes: the straight piece between its fittings' faces, turned and tilted as they are.
    // Round runs are cylinders tilted to their own fall, so a drain at 1/8" per ft meets its fittings at both ends.
    const steep = Math.abs(dz) > 0.5 && Math.abs(dz) > 0.1 * planLen;
    if (model && steep && !round) {
      const rings = segmentRings(model.elements, el);
      const solid = meshSolid(el, fittingMesh({ family: null, tubes: [{ rings: [rings.start, rings.end], faceted: true }], plates: [], faces: {}, takeoffs: {} }), el.start, levelElevationMm, group);
      if (solid) return [solid];
    }
    if (planLen < 0.01) {
      return [round ? { ...base, group, shape: "cylinder", center, size: [len * MM, width * MM, width * MM], yaw: 0, vertical: true } : { ...base, group, shape: "box", center, size: [width * MM, len * MM, height * MM], yaw: 0 }];
    }
    const pitch = Math.abs(dz) > 1e-6 ? Math.atan2(dz, planLen) : 0;
    return [{ ...base, group, shape: round ? "cylinder" : "box", center, size: [len * MM, height * MM, width * MM], yaw: planAngleToSceneYaw(dx, dy), ...(pitch !== 0 ? { pitch } : {}) }];
  }
  const size = el.ports[0]?.size;
  if (!size) return [];
  const s = Math.max(sizeWidth(size), sizeHeight(size)) * (el.fittingType === "cap" ? 1.02 : 1.12);
  const round = size.shape !== "rect";
  return [{ ...base, group, shape: round ? "cylinder" : "box", center: kernelToScene(el.position.x, el.position.y, levelElevationMm + el.position.z), size: [s * MM, s * MM, s * MM], yaw: 0, ...(round ? { vertical: true } : {}) }];
}

/** Wrapped duct's outside face as one see-through mesh (a liner is inside the metal and doesn't show). */
export function insulationSolids(el: RunSegment | RunFitting, levelElevationMm: number, model: ModelState): Solid[] {
  if (el.insulation?.kind !== "wrap") return [];
  const tubes = insulationEnvelope(model, el);
  if (tubes.length === 0) return [];
  const solid = meshSolid(el, fittingMesh({ family: null, tubes, plates: [], faces: {}, takeoffs: {} }), el.kind === "run_segment" ? el.start : el.position, levelElevationMm, "insulation");
  return solid ? [solid] : [];
}

export function elementSolids(el: BimElement, rules: ElevationRules = DEFAULT_ELEVATIONS, model?: ModelState): Solid[] {
  const raw = rawElementSolids(el, rules, model);
  if (!model || raw.length === 0) return raw;
  const mat = resolveElementMaterial(model, el);
  if (!mat) return raw;
  return raw.map((s) => (s.group === "glazing" || s.materialId ? s : { ...s, materialId: mat.id }));
}

function rawElementSolids(el: BimElement, rules: ElevationRules = DEFAULT_ELEVATIONS, model?: ModelState): Solid[] {
  const floor = floorOf(el, rules, model);
  if (el.kind === "run_segment" || el.kind === "run_fitting") {
    const style = model && el.domain !== "conduit" ? styleOfSystemId(model.elements, el.systemId) : null;
    const tint = style ? colourNumber(style.colour) : undefined;
    const solids = tint === undefined ? runSolids(el, floor, model) : runSolids(el, floor, model).map((s) => ({ ...s, tint }));
    return model && el.insulation ? [...solids, ...insulationSolids(el, floor, model)] : solids;
  }
  if (el.kind === "part") {
    // Not placed yet: it exists (schedules, one-line) but has no location to draw at.
    if (el.planned !== undefined) return [];
    const type = model?.elements[el.typeId];
    if (type?.kind !== "part_type") return [];
    return partSolids(el, type, floor);
  }
  // A class with a body (an add-on's filler for the kernel's hosted void, a louvre) draws it, whatever the kind.
  const byClass = model && hasClassSolids() ? classSolidsOf(el, { elements: model.elements, floorMm: floor }, activeClassRegistry()) : null;
  if (byClass) return classBodySolids(el, byClass);
  const base = { elementId: el.id, version: el.version };
  switch (el.kind) {
    case "duct_segment": {
      const dx = el.end.x - el.start.x;
      const dy = el.end.y - el.start.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return [];
      const p = profileSize(el.profile);
      const elev = floor + rules.ductCenterAboveFloorMm;
      return [
        {
          ...base,
          group: networkGroup(el, "duct"),
          shape: p.round ? "cylinder" : "box",
          center: kernelToScene((el.start.x + el.end.x) / 2, (el.start.y + el.end.y) / 2, elev),
          size: [len * MM, p.height * MM, p.width * MM],
          yaw: planAngleToSceneYaw(dx, dy),
        },
      ];
    }
    case "elbow":
    case "tap": {
      const p = profileSize(el.profile);
      const s = Math.max(p.width, p.height) * 1.08;
      return [
        {
          ...base,
          group: networkGroup(el, "duct_fitting"),
          shape: p.round ? "cylinder" : "box",
          center: kernelToScene(el.position.x, el.position.y, floor + rules.ductCenterAboveFloorMm),
          size: [s * MM, p.height * 1.08 * MM, s * MM],
          yaw: 0,
        },
      ];
    }
    case "terminal": {
      const face = floor + rules.ceilingAboveFloorMm;
      const duct = floor + rules.ductCenterAboveFloorMm;
      const neck = Math.max(0, duct - face);
      const solids: Solid[] = [
        {
          ...base,
          group: networkGroup(el, "terminal"),
          shape: "box",
          center: kernelToScene(el.position.x, el.position.y, face + TERMINAL_DEPTH_MM / 2),
          size: [TERMINAL_FACE_MM * MM, TERMINAL_DEPTH_MM * MM, TERMINAL_FACE_MM * MM],
          yaw: 0,
        },
      ];
      if (neck > 0) {
        solids.push({
          ...base,
          group: networkGroup(el, "duct"),
          shape: "cylinder",
          center: kernelToScene(el.position.x, el.position.y, face + neck / 2),
          size: [neck * MM, 200 * MM, 200 * MM],
          yaw: 0,
          vertical: true,
        });
      }
      return solids;
    }
    case "equipment": {
      const h = rules.equipmentHeightMm;
      return [
        {
          ...base,
          group: "equipment",
          shape: "box",
          center: kernelToScene(el.position.x, el.position.y, floor + rules.ductCenterAboveFloorMm),
          size: [el.size.x * MM, h * MM, el.size.y * MM],
          yaw: 0,
        },
      ];
    }
    case "wall": {
      const dx = el.end.x - el.start.x;
      const dy = el.end.y - el.start.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return [];
      // Architectural storefront / curtain wall: 3D dark-bronze mullions, transoms & recessed sky-reflective glazing.
      const rawWallFn = model ? elementTypeValue(model.elements, el, "architecture.wall_function") : el.values?.["architecture.wall_function"];
      const wallFn = typeof rawWallFn === "string" ? rawWallFn : undefined;
      if (wallFn === "CURTAIN") {
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;
        const pt = (s: number, d: number): Vec2 => ({ x: el.start.x + ux * s + nx * d, y: el.start.y + uy * s + ny * d });
        const boxBlock = (s0: number, s1: number, d0: number, d1: number, z0: number, z1: number): PrismBlock => ({
          outline: [pt(s0, d0), pt(s1, d0), pt(s1, d1), pt(s0, d1)],
          z0,
          z1,
        });
        const halfD = Math.max(el.thickness / 2, 55);
        const mulW = 55;
        const h = el.height;
        const zBot = floor + wallBaseAtMm(el, len / 2);
        const zTop = zBot + h;
        const frameBlocks: PrismBlock[] = [
          // Bottom sill track & top head track
          boxBlock(0, len, -halfD, halfD, zBot, zBot + 70),
          boxBlock(0, len, -halfD, halfD, zTop - 70, zTop),
        ];
        // Horizontal transom rail at 2400 mm (8'-0") when wall is tall enough
        if (h > 2700) {
          frameBlocks.push(boxBlock(0, len, -halfD, halfD, zBot + 2400 - 30, zBot + 2400 + 30));
        }
        // Rhythmic vertical mullions every ~1200 mm (4'-0")
        const bays = Math.max(1, Math.round(len / 1200));
        for (let k = 0; k <= bays; k++) {
          const s = (len * k) / bays;
          const s0 = Math.max(0, s - mulW / 2);
          const s1 = Math.min(len, s + mulW / 2);
          frameBlocks.push(boxBlock(s0, s1, -halfD, halfD, zBot, zTop));
        }
        const out: Solid[] = [];
        const rawMulMat = model ? elementTypeValue(model.elements, el, "architecture.mullion_material") : el.values?.["architecture.mullion_material"];
        const mullionMat = typeof rawMulMat === "string" ? rawMulMat : "architecture.bronze_mullion";
        const frameSolid = prismsSolid(el.id, el.version, "filler", frameBlocks);
        if (frameSolid) out.push({ ...frameSolid, materialId: mullionMat });
        // Recessed continuous glazing pane inside the bronze mullion grid
        const glassSolid = prismsSolid(el.id, el.version, "glazing", [boxBlock(mulW / 2, len - mulW / 2, -9, 9, zBot + 70, zTop - 70)]);
        if (glassSolid) out.push(glassSolid);
        return out;
      }
      // A wall something joins or is hosted in is the kernel's body, the one sections draw: its ends joined
      // (clean corners, no overlap) and cut round its doors and windows. The viewer batches those per level.
      // A wall nothing joins or cuts stays an instanced box, so a large model draws in few batches.
      // Interior walls whose top meets an overhead level slab stop cleanly at the slab underside (so they never z-fight finished floors above).
      const profile = wallBodyProfile(el);
      let effectiveHeight = el.height;
      if (model && (!profile || profile.length < 2)) {
        const nextZ = nextLevelAboveMm(model, floor);
        if (nextZ !== null && Math.abs(floor + el.height - nextZ) <= 25) {
          const inset = Math.max(el.thickness / 2 + 5, 50);
          for (const slab of elementsOfKind(model.elements, "slab")) {
            if (Math.abs(floorOf(slab, rules, model) - nextZ) > 50 || slab.outline.length < 3) continue;
            const xs = slab.outline.map((q) => q.x);
            const ys = slab.outline.map((q) => q.y);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            // Strictly interior wall (both endpoints & midpoint inset inside slab footprint) stops at slab underside.
            const mx = (el.start.x + el.end.x) / 2;
            const my = (el.start.y + el.end.y) / 2;
            const strictlyInside =
              mx > minX + inset && mx < maxX - inset && my > minY + inset && my < maxY - inset;
            if (strictlyInside) {
              effectiveHeight = Math.max(300, el.height - slab.thickness);
              break;
            }
          }
        }
      }
      // A wall whose top or base follows a surface is drawn from its body profile (sloped under a pitched roof).
      const blocks = model ? hostSolidBlocks(model.elements, el, effectiveHeight, profile) : null;
      if (blocks) {
        const solid = prismsSolid(el.id, el.version, "wall", blocks.map((b) => ({ outline: b.outline, z0: floor + b.z0, z1: floor + b.z1, ...(b.tilt0 ? { tilt0: b.tilt0 } : {}), ...(b.tilt1 ? { tilt1: b.tilt1 } : {}) })));
        return solid ? [solid] : [];
      }
      return [
        {
          ...base,
          group: "wall",
          shape: "box",
          center: kernelToScene((el.start.x + el.end.x) / 2, (el.start.y + el.end.y) / 2, floor + effectiveHeight / 2),
          size: [len * MM, effectiveHeight * MM, el.thickness * MM],
          yaw: planAngleToSceneYaw(dx, dy),
        },
      ];
    }
    case "slab": {
      const xs = el.outline.map((p) => p.x);
      const ys = el.outline.map((p) => p.y);
      if (xs.length === 0) return [];
      const holes = el.placement?.kind === "area" && el.placement.holes ? el.placement.holes.filter((h) => h.length >= 3) : [];
      if (holes.length > 0) {
        const pieces = splitOutlineAroundHoles(el.outline, holes);
        const solid = prismsSolid(
          el.id,
          el.version,
          "slab",
          pieces.map((outline) => ({ outline, z0: floor - el.thickness, z1: floor })),
        );
        return solid ? [solid] : [];
      }
      // Any outline but a plain rectangle is drawn as drawn (an L, a skewed corner), not as its bounding box.
      if (!isAxisRectangle(el.outline)) {
        const solid = prismsSolid(el.id, el.version, "slab", [{ outline: el.outline, z0: floor - el.thickness, z1: floor }]);
        return solid ? [solid] : [];
      }
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return [
        {
          ...base,
          group: "slab",
          shape: "box",
          center: kernelToScene((minX + maxX) / 2, (minY + maxY) / 2, floor - el.thickness / 2),
          size: [(maxX - minX) * MM, el.thickness * MM, (maxY - minY) * MM],
          yaw: 0,
        },
      ];
    }
    case "column": {
      const span = model ? columnVerticalSpan(model.elements, el, floor, rules.floorToFloorMm) : null;
      const baseZ = span ? span.baseZMm : floor + (el.placement?.kind === "point" ? el.placement.offsetMm : 0);
      let colH = span ? span.heightMm : (typeof el.height === "number" && el.height > 0 ? el.height : rules.floorToFloorMm);
      const hasExplicitTopOffset = (el.placement?.kind === "point" || el.placement?.kind === "line") && el.placement.topOffsetMm !== undefined && el.placement.topOffsetMm !== 0;
      const isLevelTiedOrInferred = span !== null && span.topLevelId !== null;
      const topZ = baseZ + colH;
      // Stop cleanly at the underside of an overhead slab at the column's top level when level-tied/inferred and no explicit top offset already accounts for it.
      if (model && isLevelTiedOrInferred && !hasExplicitTopOffset) {
        for (const slab of elementsOfKind(model.elements, "slab")) {
          if (Math.abs(floorOf(slab, rules, model) - topZ) > 50) continue;
          const xs = slab.outline.map((q) => q.x);
          const ys = slab.outline.map((q) => q.y);
          if (xs.length >= 3 && el.position.x >= Math.min(...xs) && el.position.x <= Math.max(...xs) && el.position.y >= Math.min(...ys) && el.position.y <= Math.max(...ys)) {
            colH = Math.max(300, colH - slab.thickness);
            break;
          }
        }
      }
      const rotDeg = el.placement?.kind === "point" ? el.placement.rotationDeg : 0;
      return [
        {
          ...base,
          group: "structure",
          shape: "box",
          center: kernelToScene(el.position.x, el.position.y, baseZ + colH / 2),
          size: [el.size.x * MM, colH * MM, el.size.y * MM],
          yaw: (rotDeg * Math.PI) / 180,
        },
      ];
    }
    case "beam": {
      const dx = el.end.x - el.start.x;
      const dy = el.end.y - el.start.y;
      const planLen = Math.hypot(dx, dy);
      if (planLen === 0) return [];
      const depth = 400;
      const width = 200;
      const p = el.placement?.kind === "line" ? el.placement : null;
      const dz = p ? p.endOffsetMm - p.startOffsetMm : 0;
      const len3D = Math.hypot(planLen, dz);
      const pitch = Math.abs(dz) > 1e-6 ? Math.atan2(dz, planLen) : 0;
      const centerZ = p
        ? floor + (p.startOffsetMm + p.endOffsetMm) / 2 + (p.vertical === "bottom" ? depth / 2 : p.vertical === "center" ? 0 : -depth / 2)
        : floor + rules.floorToFloorMm - 300;
      const h = p ? depth : 600;
      const w = p ? width : 300;
      return [
        {
          ...base,
          group: "structure",
          shape: "box",
          center: kernelToScene((el.start.x + el.end.x) / 2, (el.start.y + el.end.y) / 2, centerZ),
          size: [len3D * MM, h * MM, w * MM],
          yaw: planAngleToSceneYaw(dx, dy),
          ...(pitch !== 0 ? { pitch } : {}),
        },
      ];
    }
    case "riser_segment": {
      const p = profileSize(el.profile);
      return [
        {
          ...base,
          group: "riser",
          shape: p.round ? "cylinder" : "box",
          center: kernelToScene(el.position.x, el.position.y, floor + rules.floorToFloorMm / 2),
          size: [rules.floorToFloorMm * MM, p.height * MM, p.width * MM],
          yaw: 0,
          vertical: true,
        },
      ];
    }
    case "component": {
      const height = componentHeightMm(el.category);
      if (height === null) return [];
      const z = el.category === "ceiling" ? rules.ceilingAboveFloorMm : el.category === "floor_finish" ? 0 : height / 2;
      return [
        {
          ...base,
          group: "furnishing",
          shape: "box",
          center: kernelToScene(el.position.x, el.position.y, floor + z),
          size: [el.size.x * MM, height * MM, el.size.y * MM],
          yaw: (-el.rotationDeg * Math.PI) / 180,
        },
      ];
    }
    case "mounting_plane": {
      const z = floor + el.heightMm - MOUNTING_PLANE_THICKNESS_MM / 2;
      return [
        {
          ...base,
          group: "mounting_plane",
          shape: "box",
          center: kernelToScene((el.min.x + el.max.x) / 2, (el.min.y + el.max.y) / 2, z),
          size: [(el.max.x - el.min.x) * MM, MOUNTING_PLANE_THICKNESS_MM * MM, (el.max.y - el.min.y) * MM],
          yaw: 0,
        },
      ];
    }
    case "ceiling": {
      const c = asCeiling(el);
      const level = c ? model?.elements[c.levelId] : undefined;
      if (!c) return [];
      const baseZ = level?.kind === "level" ? level.elevationMm : floor;
      const z = baseZ + c.heightMm;
      const pieces = c.holes && c.holes.length > 0 ? splitOutlineAroundHoles(c.outline, c.holes) : [c.outline];
      const blocks: PrismBlock[] = pieces.map((outline) => ({ outline, z0: z, z1: z + CEILING_THICKNESS_MM }));
      // Architectural soffit ceiling (`form: "soffit"`): close the drop edge vertically up to the underside of structure above.
      if (c.form === "soffit" && c.outline.length >= 3) {
        const nextLevelZ = nextLevelAboveMm(model, baseZ) ?? baseZ + rules.floorToFloorMm;
        const cx = c.outline.reduce((s, p) => s + p.x, 0) / c.outline.length;
        const cy = c.outline.reduce((s, p) => s + p.y, 0) / c.outline.length;
        const undersideZ = overheadSlabUndersideMm(model, rules, cx, cy, nextLevelZ);
        const skirtTop = Math.max(z + CEILING_THICKNESS_MM, undersideZ);
        const skirtThick = 75;
        for (let i = 0; i < c.outline.length; i++) {
          const a = c.outline[i]!;
          const b = c.outline[(i + 1) % c.outline.length]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 10) continue;
          const nx = (-dy / len) * (skirtThick / 2);
          const ny = (dx / len) * (skirtThick / 2);
          blocks.push({
            outline: [
              { x: a.x + nx, y: a.y + ny },
              { x: b.x + nx, y: b.y + ny },
              { x: b.x - nx, y: b.y - ny },
              { x: a.x - nx, y: a.y - ny },
            ],
            z0: z,
            z1: skirtTop,
          });
        }
      }
      const solid = prismsSolid(el.id, el.version, "slab", blocks);
      return solid ? [solid] : [];
    }
    default: {
      // An add-on kind with a body (a stair, a roof, another firm's kind) draws the body its row gives.
      const face = model ? kindRowOf(el.kind)?.solid : undefined;
      const shape = face && model ? face(el, { elements: model.elements, floorMm: floor }) : null;
      const solids = shape ? kindShapeSolids(el, shape) : [];
      // Add architectural 3D handrails & posts for stairs purely in the viewer (keeps kernel 1:1 step count for IFC round-trips).
      if (String(el.kind) === "architecture.stair" && model && solids.length > 0) {
        const rails = stairHandrailSolid(el, floor, model);
        if (rails) solids.push(rails);
      }
      return solids;
    }
  }
}

/** Find the elevation of the lowest building story strictly above `zMm` (skipping non-story datums like ceiling levels unless no story exists above), or null. */
function nextLevelAboveMm(model: ModelState | undefined, zMm: number): number | null {
  if (!model) return null;
  let bestStory: number | null = null;
  let bestAny: number | null = null;
  for (const lvl of elementsOfKind(model.elements, "level")) {
    if (lvl.elevationMm <= zMm) continue;
    if (bestAny === null || lvl.elevationMm < bestAny) bestAny = lvl.elevationMm;
    if (isBuildingStoryLevel(lvl) && (bestStory === null || lvl.elevationMm < bestStory)) bestStory = lvl.elevationMm;
  }
  return bestStory ?? bestAny;
}

/** Underside elevation of any overhead slab on `topLevelZ` covering `(x, y)` (so columns & soffits stop flush below finished floors). */
function overheadSlabUndersideMm(model: ModelState | undefined, rules: ElevationRules, x: number, y: number, topLevelZ: number): number {
  if (!model) return topLevelZ;
  let underside = topLevelZ;
  for (const slab of elementsOfKind(model.elements, "slab")) {
    if (Math.abs(floorOf(slab, rules, model) - topLevelZ) > 50) continue;
    const xs = slab.outline.map((q) => q.x);
    const ys = slab.outline.map((q) => q.y);
    if (xs.length >= 3 && x >= Math.min(...xs) && x <= Math.max(...xs) && y >= Math.min(...ys) && y <= Math.max(...ys)) {
      underside = Math.min(underside, topLevelZ - slab.thickness);
    }
  }
  return underside;
}

/** Clip a convex/simple polygon to `axis` between `lo` and `hi` (for 3D slab & ceiling stairwell cutouts). */
function clipAxis(poly: readonly Vec2[], axis: "x" | "y", lo: number, hi: number): Vec2[] {
  const half = (pts: readonly Vec2[], keep: (p: Vec2) => number): Vec2[] => {
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const da = keep(a);
      const db = keep(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0) && Math.abs(da - db) > 1e-9) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return out;
  };
  return half(half(poly, (p) => p[axis] - lo), (p) => hi - p[axis]);
}

function polyArea2(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Split an area polygon into non-overlapping blocks around interior rectangular/polygonal holes (stairwells, atriums). */
function splitOutlineAroundHoles(outline: readonly Vec2[], holes: readonly (readonly Vec2[])[]): Vec2[][] {
  if (holes.length === 0) return [[...outline]];
  const boxes = holes
    .map((h) => ({
      x0: Math.min(...h.map((p) => p.x)),
      x1: Math.max(...h.map((p) => p.x)),
      y0: Math.min(...h.map((p) => p.y)),
      y1: Math.max(...h.map((p) => p.y)),
    }))
    .sort((a, b) => a.x0 - b.x0);
  const cuts = [...new Set(boxes.flatMap((b) => [b.x0, b.x1]))].sort((a, b) => a - b);
  const xs = [-Infinity, ...cuts, Infinity];
  const out: Vec2[][] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = xs[i]!;
    const hi = xs[i + 1]!;
    const strip = clipAxis(outline, "x", lo, hi);
    if (polyArea2(strip) < 10) continue;
    const mid = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo + 1 : hi - 1;
    const inside = boxes.filter((b) => b.x0 < mid && b.x1 > mid).sort((a, b) => a.y0 - b.y0);
    let y = -Infinity;
    for (const b of inside) {
      const piece = clipAxis(strip, "y", y, b.y0);
      if (polyArea2(piece) > 10) out.push(piece);
      y = Math.max(y, b.y1);
    }
    const last = clipAxis(strip, "y", y, Infinity);
    if (polyArea2(last) > 10) out.push(last);
  }
  return out.length > 0 ? out : [[...outline]];
}

/** Architectural 3D guardrails & newel posts along all flights and open landing edges of straight, L-shape, and U-shape stairs. */
function stairHandrailSolid(el: BimElement, floor: number, model: ModelState): Solid | null {
  const r = el as unknown as {
    readonly start?: Vec2;
    readonly end?: Vec2;
    readonly widthMm?: number;
    readonly levelId?: string;
    readonly topLevelId?: string;
    readonly risers?: number;
    readonly form?: string;
    readonly turn?: string;
    readonly landingDepthMm?: number;
    readonly wellGapMm?: number;
    readonly values?: Readonly<Record<string, unknown>>;
  };
  if (!r.start || !r.end || typeof r.widthMm !== "number") return null;
  const dx = r.end.x - r.start.x;
  const dy = r.end.y - r.start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 100) return null;
  const baseLvl = typeof r.levelId === "string" ? model.elements[r.levelId] : undefined;
  const z0 = baseLvl?.kind === "level" ? baseLvl.elevationMm : floor;
  const topLvl = typeof r.topLevelId === "string" ? model.elements[r.topLevelId] : undefined;
  const zTop = topLvl?.kind === "level" ? topLvl.elevationMm : nextLevelAboveMm(model, z0);
  if (zTop === null || zTop <= z0) return null;

  const rise = zTop - z0;
  const w = r.widthMm;
  const halfW = w / 2;
  const u: Vec2 = { x: dx / dist, y: dy / dist };
  const nL: Vec2 = { x: -u.y, y: u.x };
  const rawForm = (typeof r.values?.["architecture.stair_form"] === "string" ? String(r.values["architecture.stair_form"]) : typeof r.form === "string" ? r.form : "straight").toLowerCase();
  const rawTurn = (typeof r.values?.["architecture.stair_turn"] === "string" ? String(r.values["architecture.stair_turn"]) : typeof r.turn === "string" ? r.turn : "right").toLowerCase();
  const landingDepthMm = typeof r.values?.["architecture.landing_depth_mm"] === "number" ? Number(r.values["architecture.landing_depth_mm"]) : typeof r.landingDepthMm === "number" ? r.landingDepthMm : undefined;
  const wellGapMm = typeof r.values?.["architecture.well_gap_mm"] === "number" ? Number(r.values["architecture.well_gap_mm"]) : typeof r.wellGapMm === "number" ? r.wellGapMm : 150;
  const turnSign = rawTurn === "left" ? 1 : -1;
  const nT: Vec2 = { x: nL.x * turnSign, y: nL.y * turnSign };
  const add = (p: Vec2, v: Vec2, k = 1): Vec2 => ({ x: p.x + v.x * k, y: p.y + v.y * k });

  const risers = typeof r.risers === "number" && r.risers >= 2 ? Math.round(r.risers) : Math.max(2, Math.ceil(rise / 178));
  const flights: Array<{ start: Vec2; u: Vec2; n: Vec2; run: number; z0: number; z1: number }> = [];
  const railEdges: Array<{ a: Vec2; b: Vec2; z: number }> = [];

  if (rawForm === "straight" && !(landingDepthMm && landingDepthMm > 0)) {
    flights.push({ start: r.start, u, n: nL, run: dist, z0, z1: zTop });
  } else {
    const r1 = Math.max(2, Math.ceil(risers / 2));
    const r2 = Math.max(2, risers - r1);
    const t1 = Math.max(1, r1 - 1);
    const t2 = Math.max(1, r2 - 1);
    const riserMm = rise / (r1 + r2);
    const zMid = z0 + r1 * riserMm;
    const landingD = Math.max(landingDepthMm ?? Math.max(w, 1120), w);
    if (rawForm === "straight") {
      const treadMm = Math.max(280, (Math.max(dist, (t1 + t2) * 280 + landingD) - landingD) / (t1 + t2));
      const run1 = t1 * treadMm;
      const run2 = t2 * treadMm;
      const f1End = add(r.start, u, run1);
      const f2Start = add(f1End, u, landingD);
      flights.push({ start: r.start, u, n: nL, run: run1, z0, z1: zMid });
      flights.push({ start: f2Start, u, n: nL, run: run2, z0: zMid, z1: zTop });
      railEdges.push({ a: add(f1End, nL, halfW), b: add(f2Start, nL, halfW), z: zMid });
      railEdges.push({ a: add(f1End, nL, -halfW), b: add(f2Start, nL, -halfW), z: zMid });
    } else if (rawForm === "l_shape") {
      const treadMm = Math.max(280, Math.min(330, dist / t1));
      const run1 = t1 * treadMm;
      const run2 = t2 * treadMm;
      const f1End = add(r.start, u, run1);
      const cA = add(f1End, nT, -halfW);
      const cB = add(f1End, nT, halfW);
      const cC = add(cB, u, landingD);
      const cD = add(cA, u, landingD);
      const u2 = nT;
      const n2: Vec2 = { x: -u2.y, y: u2.x };
      const f2Start = add(add(f1End, u, landingD / 2), nT, halfW);
      flights.push({ start: r.start, u, n: nL, run: run1, z0, z1: zMid });
      flights.push({ start: f2Start, u: u2, n: n2, run: run2, z0: zMid, z1: zTop });
      railEdges.push({ a: cC, b: cD, z: zMid }, { a: cD, b: cA, z: zMid });
    } else {
      // u_shape 180° switchback
      const treadMm = Math.max(280, Math.min(330, dist / t1));
      const run1 = t1 * treadMm;
      const run2 = t2 * treadMm;
      const f1End = add(r.start, u, run1);
      const wellGap = Math.max(0, wellGapMm);
      const cA = add(f1End, nT, -halfW);
      const cB = add(f1End, nT, halfW + wellGap + w);
      const cC = add(cB, u, landingD);
      const cD = add(cA, u, landingD);
      const u2: Vec2 = { x: -u.x, y: -u.y };
      const n2: Vec2 = { x: -u2.y, y: u2.x };
      const f2Start = add(f1End, nT, w + wellGap);
      flights.push({ start: r.start, u, n: nL, run: run1, z0, z1: zMid });
      flights.push({ start: f2Start, u: u2, n: n2, run: run2, z0: zMid, z1: zTop });
      railEdges.push({ a: cB, b: cC, z: zMid }, { a: cC, b: cD, z: zMid }, { a: cD, b: cA, z: zMid });
      if (wellGap > 20) railEdges.push({ a: add(f1End, nT, halfW), b: add(f1End, nT, halfW + wellGap), z: zMid });
    }
  }

  const railH = 915; // 36" code handrail height
  const barHalf = 18;
  const blocks: PrismBlock[] = [];

  for (const f of flights) {
    const fRise = f.z1 - f.z0;
    const pitch = fRise / Math.max(1, f.run);
    const tilt = { at: f.start, rise: { x: f.u.x * pitch, y: f.u.y * pitch } };
    const railW = Math.min(36 / Math.max(1, halfW), 0.09);
    const at = (d: number, side: number): Vec2 => ({
      x: f.start.x + f.u.x * d + f.n.x * halfW * side,
      y: f.start.y + f.u.y * d + f.n.y * halfW * side,
    });
    // Close the top riser solidly up to f.z1 in 3D (flush with the landing / upper floor slab)
    // without adding an extra block to the kernel/IFC body so IFC round-trip preserves exact step counts.
    const capMm = Math.min(60, f.run * 0.05);
    if (capMm > 1) {
      blocks.push({
        outline: [at(f.run - capMm, 1), at(f.run, 1), at(f.run, -1), at(f.run - capMm, -1)],
        z0: Math.max(f.z0, f.z1 - 215),
        z1: f.z1,
      });
    }
    for (const side of [-1, 1] as const) {
      const sOut = side;
      const sIn = side * (1 - railW * 2);
      blocks.push({ outline: [at(0, sOut), at(f.run, sOut), at(f.run, sIn), at(0, sIn)], z0: f.z0 + railH - 42, z1: f.z0 + railH, tilt0: tilt, tilt1: tilt });
      blocks.push({ outline: [at(0, sOut), at(f.run, sOut), at(f.run, sIn), at(0, sIn)], z0: f.z0 + railH * 0.52 - 16, z1: f.z0 + railH * 0.52 + 16, tilt0: tilt, tilt1: tilt });
      const posts = Math.max(3, Math.round(f.run / 1100) + 1);
      const stepDrop = Math.min(200, fRise / Math.max(2, Math.round(f.run / 280) + 1));
      for (let i = 0; i < posts; i++) {
        const frac = i / (posts - 1);
        const d0 = Math.max(0, frac * f.run - barHalf);
        const d1 = Math.min(f.run, d0 + barHalf * 2);
        const baseZ = f.z0 + frac * fRise;
        blocks.push({ outline: [at(d0, sOut), at(d1, sOut), at(d1, sIn), at(d0, sIn)], z0: Math.max(f.z0, baseZ - stepDrop - 20), z1: baseZ + railH - 36 });
      }
    }
  }

  for (const edge of railEdges) {
    const ex = edge.b.x - edge.a.x;
    const ey = edge.b.y - edge.a.y;
    const elen = Math.hypot(ex, ey);
    if (elen < 40) continue;
    const eux = ex / elen;
    const euy = ey / elen;
    const enx = -euy * barHalf;
    const eny = eux * barHalf;
    const rect = (d0: number, d1: number): Vec2[] => [
      { x: edge.a.x + eux * d0 + enx, y: edge.a.y + euy * d0 + eny },
      { x: edge.a.x + eux * d1 + enx, y: edge.a.y + euy * d1 + eny },
      { x: edge.a.x + eux * d1 - enx, y: edge.a.y + euy * d1 - eny },
      { x: edge.a.x + eux * d0 - enx, y: edge.a.y + euy * d0 - eny },
    ];
    blocks.push({ outline: rect(0, elen), z0: edge.z + railH - 42, z1: edge.z + railH });
    blocks.push({ outline: rect(0, elen), z0: edge.z + railH * 0.52 - 16, z1: edge.z + railH * 0.52 + 16 });
    const posts = Math.max(2, Math.round(elen / 1100) + 1);
    for (let i = 0; i < posts; i++) {
      const d = (i / (posts - 1)) * elen;
      const d0 = Math.max(0, d - barHalf);
      const d1 = Math.min(elen, d0 + barHalf * 2);
      blocks.push({ outline: rect(d0, d1), z0: edge.z - 20, z1: edge.z + railH - 36 });
    }
  }

  const solid = prismsSolid(el.id, el.version, "filler", blocks);
  return solid ? { ...solid, materialId: "architecture.bronze_mullion" } : null;
}

/** A ceiling's board, drawn up from its height. */
const CEILING_THICKNESS_MM = 20;

function isAxisRectangle(outline: readonly Vec2[]): boolean {
  if (outline.length !== 4) return false;
  const xs = new Set(outline.map((p) => p.x));
  const ys = new Set(outline.map((p) => p.y));
  return xs.size === 2 && ys.size === 2;
}

function groupOfKindShape(shape: KindSolidShape): RenderGroup {
  if (shape.category === "walls") return "wall";
  if (shape.role === "architecture") return "structure";
  return shape.role === "equipment" ? "equipment" : "pipe";
}

function groupOfClassPart(part: ClassSolidPart): RenderGroup {
  if (part.look === "glazing") return "glazing";
  if (part.shape.role === "architecture") return part.shape.category === "walls" ? "wall" : "filler";
  return part.shape.role === "equipment" ? "equipment" : "pipe";
}

/** A class body as solids: its prisms merged into one mesh per look and role (a frame, its leaf, its glass), runs as boxes. */
export function classBodySolids(el: BimElement, parts: readonly ClassSolidPart[]): Solid[] {
  const blocks = new Map<RenderGroup, PrismBlock[]>();
  const out: Solid[] = [];
  for (const part of parts) {
    const group = groupOfClassPart(part);
    const shape = part.shape;
    if (shape.form === "run") {
      out.push(...kindShapeSolids(el, shape, group));
      continue;
    }
    const list = blocks.get(group) ?? [];
    if (shape.form === "prism") list.push({ outline: shape.outline, z0: shape.z0, z1: shape.z1 });
    else list.push(...shape.blocks);
    blocks.set(group, list);
  }
  for (const [group, list] of blocks) {
    const solid = prismsSolid(el.id, el.version, group, list);
    if (solid) out.push(solid);
  }
  return out;
}

function kindShapeSolids(el: BimElement, shape: KindSolidShape, group: RenderGroup = groupOfKindShape(shape)): Solid[] {
  if (shape.form === "run") {
    const dx = shape.b.x - shape.a.x;
    const dy = shape.b.y - shape.a.y;
    const len = Math.hypot(dx, dy, shape.b.z - shape.a.z);
    if (len === 0) return [];
    return [{ elementId: el.id, version: el.version, group, shape: "box", center: kernelToScene((shape.a.x + shape.b.x) / 2, (shape.a.y + shape.b.y) / 2, (shape.a.z + shape.b.z) / 2), size: [len * MM, shape.sizeMm * MM, shape.sizeMm * MM], yaw: planAngleToSceneYaw(dx, dy) }];
  }
  const blocks = shape.form === "prism" ? [{ outline: shape.outline, z0: shape.z0, z1: shape.z1 }] : shape.blocks;
  const solid = prismsSolid(el.id, el.version, group, blocks);
  return solid ? [solid] : [];
}

/** Thin enough to read as a plane, thick enough to pick; its top is at the plane's height. */
const MOUNTING_PLANE_THICKNESS_MM = 10;

/** Box height per known component category; null is not drawn in 3D yet. */
const COMPONENT_HEIGHT_MM: Record<(typeof KNOWN_COMPONENT_CATEGORIES)[number], number | null> = {
  furniture: 760,
  casework: 900,
  ceiling: 20,
  floor_finish: 10,
  curtain_panel: null,
  mullion: null,
  footing: null,
};
const COMPONENT_HEIGHTS: ReadonlyMap<string, number | null> = new Map(Object.entries(COMPONENT_HEIGHT_MM));

/** A newer peer's category (`paving`, `curb`) is kept in the model but not drawn in 3D yet. */
function componentHeightMm(category: string): number | null {
  return COMPONENT_HEIGHTS.get(category) ?? null;
}

export interface SolidsDiff {
  readonly added: Solid[];
  readonly removed: ElementId[];
}

interface SolidMemo {
  readonly rules: ElevationRules;
  readonly floor: number;
  readonly matId: string | undefined;
  readonly classRegistry: unknown;
  readonly dep1: unknown;
  readonly dep2: unknown;
  readonly dep3: unknown;
  readonly solids: readonly Solid[];
}

/**
 * Element records are never mutated in place, so an unchanged element's solids
 * are reused across previews while every dependency it reads (rules, level
 * elevation, material id, part type + geometry readiness, system colour, and
 * connected fittings' memoised bodies) matches by identity.
 */
const elementSolidsMemo = new WeakMap<BimElement, SolidMemo>();

function fastFloorOf(
  el: BimElement,
  rules: ElevationRules,
  model: ModelState | undefined,
  levelElevByKey?: Map<string, number>,
  hasLevels?: boolean,
): number {
  if (!model) return rules.levelElevationMm(levelOf(el.partition));
  if (levelElevByKey) {
    if (el.kind === "level") return rules.levelElevationMm(levelOf(el.partition));
    if (el.kind === "part" && el.planned !== undefined) return floorOf(el, rules, model);
    const ownId =
      "levelId" in el && typeof el.levelId === "string"
        ? el.levelId
        : "placement" in el &&
            el.placement &&
            typeof el.placement === "object" &&
            "levelId" in el.placement &&
            typeof el.placement.levelId === "string" &&
            el.placement.levelId !== ""
          ? el.placement.levelId
          : null;
    if (ownId) {
      const hit = levelElevByKey.get(ownId);
      if (hit !== undefined) return hit;
    } else if (el.kind !== "load_point" && el.kind !== "opening") {
      const named = el.partition?.level ?? "L1";
      const hit = levelElevByKey.get(named);
      if (hit !== undefined) return hit;
      const computed = hasLevels ? floorOf(el, rules, model) : rules.levelElevationMm(named);
      levelElevByKey.set(named, computed);
      return computed;
    }
  }
  return floorOf(el, rules, model);
}

function fastMaterialId(model: ModelState, el: BimElement): string | undefined {
  // Fast skip for the common MEP / geometry records that carry neither direct
  // material values nor a type reference; avoids scanning the active pack set.
  const hasValues = "values" in el && el.values !== undefined;
  const hasType = "typeId" in el && el.typeId !== undefined;
  if (!hasValues && !hasType && el.kind !== "ceiling" && el.kind !== "column") {
    return undefined;
  }
  return resolveElementMaterial(model, el)?.id;
}

function cachedElementSolids(
  el: BimElement,
  rules: ElevationRules,
  model: ModelState,
  levelElevByKey: Map<string, number> | undefined,
  hasLevels: boolean,
  classRegistry: unknown,
): readonly Solid[] {
  const kind = el.kind;

  // 1. Routed segments & fittings (no wrap insulation)
  if ((kind === "run_segment" || kind === "run_fitting") && !el.insulation) {
    const floor = fastFloorOf(el, rules, model, levelElevByKey, hasLevels);
    const matId = fastMaterialId(model, el);
    const systemEl = el.domain !== "conduit" ? model.elements[el.systemId] : undefined;
    let dep2: unknown;
    let dep3: unknown;
    if (kind === "run_fitting") {
      dep2 = el.domain !== "conduit" && el.family !== undefined ? fittingBody(model.elements, el) : undefined;
    } else {
      const startF = el.links.start ? model.elements[el.links.start.elementId] : undefined;
      const endF = el.links.end ? model.elements[el.links.end.elementId] : undefined;
      dep2 = el.domain !== "conduit" && startF?.kind === "run_fitting" && startF.family !== undefined ? fittingBody(model.elements, startF) : startF;
      dep3 = el.domain !== "conduit" && endF?.kind === "run_fitting" && endF.family !== undefined ? fittingBody(model.elements, endF) : endF;
    }
    const hit = elementSolidsMemo.get(el);
    if (
      hit &&
      hit.rules === rules &&
      hit.floor === floor &&
      hit.matId === matId &&
      hit.dep1 === systemEl &&
      hit.dep2 === dep2 &&
      hit.dep3 === dep3
    ) {
      return hit.solids;
    }
    const solids = elementSolids(el, rules, model);
    elementSolidsMemo.set(el, {
      rules,
      floor,
      matId,
      classRegistry: null,
      dep1: systemEl,
      dep2,
      dep3,
      solids,
    });
    return solids;
  }

  // 2. Placed part instances
  if (kind === "part") {
    if (el.planned !== undefined) return [];
    const typeEl = model.elements[el.typeId];
    if (typeEl?.kind !== "part_type") return [];
    const floor = fastFloorOf(el, rules, model, levelElevByKey, hasLevels);
    const matId = fastMaterialId(model, el);
    const ready = partGeometryReady();
    const hit = elementSolidsMemo.get(el);
    if (
      hit &&
      hit.rules === rules &&
      hit.floor === floor &&
      hit.matId === matId &&
      hit.dep1 === typeEl &&
      hit.dep2 === ready
    ) {
      return hit.solids;
    }
    const solids = elementSolids(el, rules, model);
    elementSolidsMemo.set(el, {
      rules,
      floor,
      matId,
      classRegistry: null,
      dep1: typeEl,
      dep2: ready,
      dep3: undefined,
      solids,
    });
    return solids;
  }

  // 3. Self-contained geometry kinds (no neighbor-element dependencies unless an
  //    add-on registers a class body for them, which is checked before caching).
  if (
    kind === "duct_segment" ||
    kind === "elbow" ||
    kind === "tap" ||
    kind === "terminal" ||
    kind === "equipment" ||
    kind === "slab" ||
    kind === "beam" ||
    kind === "riser_segment" ||
    kind === "component" ||
    kind === "mounting_plane"
  ) {
    const floor = fastFloorOf(el, rules, model, levelElevByKey, hasLevels);
    const matId = fastMaterialId(model, el);
    const hit = elementSolidsMemo.get(el);
    if (
      hit &&
      hit.rules === rules &&
      hit.floor === floor &&
      hit.matId === matId &&
      hit.classRegistry === classRegistry
    ) {
      return hit.solids;
    }
    const hasClassBody =
      classRegistry !== null &&
      classSolidsOf(el, { elements: model.elements, floorMm: floor }, activeClassRegistry()) !== null;
    const solids = elementSolids(el, rules, model);
    if (!hasClassBody) {
      elementSolidsMemo.set(el, {
        rules,
        floor,
        matId,
        classRegistry,
        dep1: undefined,
        dep2: undefined,
        dep3: undefined,
        solids,
      });
    }
    return solids;
  }

  // 4. Non-geometric metadata & 2D annotation records skip elementSolids entirely.
  if (
    kind === "tag" ||
    kind === "dimension" ||
    kind === "viewport" ||
    kind === "drawing_item" ||
    kind === "level" ||
    kind === "part_type" ||
    kind === "mep_system" ||
    kind === "room" ||
    kind === "space" ||
    kind === "zone" ||
    kind === "grid" ||
    kind === "view" ||
    kind === "sheet" ||
    kind === "load_point" ||
    kind === "element_type" ||
    kind === "organization" ||
    kind === "site" ||
    kind === "service_link" ||
    kind === "reference_plane"
  ) {
    if (classRegistry === null && !kindRowOf(kind)?.solid) return [];
  }

  // 5. Host/neighbor-dependent kinds (wall, column, ceiling, opening, add-on kinds)
  return elementSolids(el, rules, model);
}

interface ModelSolidsSnapshot {
  readonly elements: ModelState["elements"];
  readonly elementCount: number;
  readonly rules: ElevationRules;
  readonly levels: ReadonlySet<string> | undefined;
  readonly classRegistry: unknown;
  readonly hasClass: boolean;
  readonly partReady: boolean;
  readonly byId: Map<string, readonly Solid[]>;
}

let lastModelSolids: ModelSolidsSnapshot | null = null;

const LOCAL_ONLY_KINDS = new Set<string>([
  "duct_segment",
  "elbow",
  "tap",
  "terminal",
  "equipment",
  "part",
  "run_segment",
  "run_fitting",
  "beam",
  "riser_segment",
  "component",
  "mounting_plane",
  "tag",
  "dimension",
  "viewport",
  "drawing_item",
  "room",
  "space",
  "zone",
  "grid",
  "view",
  "sheet",
  "load_point",
  "organization",
  "site",
  "service_link",
  "reference_plane",
]);

function sameLevelSet(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function collectRunLinkIds(el: BimElement, into: Set<string>): void {
  if (el.kind === "run_segment") {
    if (el.links.start) into.add(el.links.start.elementId);
    if (el.links.end) into.add(el.links.end.elementId);
  } else if (el.kind === "run_fitting") {
    for (const port of el.ports) {
      if (port.link) into.add(port.link.elementId);
    }
  }
}

/**
 * Solids for every element, optionally only for elements in `levels`.
 *
 * Element records are immutable, so when consecutive calls share rules, level
 * filter, active packs and geometry readiness and only local-dependency records
 * changed (typical interactive MEP/part preview edits), only the changed
 * records and their immediate routed-link neighbours are rebuilt.
 */
export function modelSolids(model: ModelState, rules: ElevationRules = DEFAULT_ELEVATIONS, levels?: ReadonlySet<string>): Solid[] {
  const hasClass = hasClassSolids();
  const classRegistry = activeClassRegistry();
  const partReady = partGeometryReady();
  const elements = model.elements;

  const snap = lastModelSolids;
  if (
    snap &&
    snap.rules === rules &&
    snap.classRegistry === classRegistry &&
    snap.hasClass === hasClass &&
    snap.partReady === partReady &&
    sameLevelSet(snap.levels, levels)
  ) {
    if (snap.elements === elements) {
      const out: Solid[] = [];
      for (const list of snap.byId.values()) {
        if (list.length === 1) out.push(list[0]!);
        else if (list.length > 1) out.push(...list);
      }
      return out;
    }

    const prevElements = snap.elements;
    const dirtyIds = new Set<string>();
    const removedIds: string[] = [];
    let existingInNow = 0;
    let totalNow = 0;
    let allLocal = true;

    for (const id in elements) {
      if (!Object.prototype.hasOwnProperty.call(elements, id)) continue;
      totalNow++;
      const el = elements[id]!;
      const prev = prevElements[id];
      if (prev !== undefined) existingInNow++;
      if (prev === el) continue;
      if (!LOCAL_ONLY_KINDS.has(el.kind) || (prev !== undefined && !LOCAL_ONLY_KINDS.has(prev.kind))) {
        allLocal = false;
        break;
      }
      dirtyIds.add(id);
    }

    if (allLocal && existingInNow < snap.elementCount) {
      for (const id in prevElements) {
        if (!Object.prototype.hasOwnProperty.call(prevElements, id)) continue;
        if (id in elements) continue;
        const prev = prevElements[id]!;
        if (!LOCAL_ONLY_KINDS.has(prev.kind)) {
          allLocal = false;
          break;
        }
        removedIds.push(id);
      }
    }

    // Only take the incremental path when a small fraction changed (saves copying the map on whole-model swaps).
    if (allLocal && dirtyIds.size + removedIds.length <= Math.max(64, totalNow >> 3)) {
      // Expand routed-link neighbours by 2 hops so fittingBody, segmentCutback
      // and insulationEnvelope always reflect neighbouring segment/fitting edits.
      const frontier = new Set<string>();
      for (const id of dirtyIds) {
        const el = elements[id];
        if (el) collectRunLinkIds(el, frontier);
        const prev = prevElements[id];
        if (prev) collectRunLinkIds(prev, frontier);
      }
      for (const id of removedIds) {
        const prev = prevElements[id];
        if (prev) collectRunLinkIds(prev, frontier);
      }
      const hop2 = new Set<string>();
      for (const id of frontier) {
        dirtyIds.add(id);
        const el = elements[id];
        if (el) collectRunLinkIds(el, hop2);
      }
      for (const id of hop2) {
        if (id in elements) dirtyIds.add(id);
      }

      const nextById = new Map(snap.byId);
      for (const id of removedIds) nextById.delete(id);
      for (const id of dirtyIds) {
        const el = elements[id];
        if (!el || (levels && !levels.has(levelOf(el.partition)))) {
          nextById.delete(id);
          continue;
        }
        const solids = elementSolids(el, rules, model);
        if (solids.length > 0) nextById.set(id, solids);
        else nextById.delete(id);
      }

      lastModelSolids = {
        elements,
        elementCount: totalNow,
        rules,
        levels,
        classRegistry,
        hasClass,
        partReady,
        byId: nextById,
      };
      const out: Solid[] = [];
      for (const list of nextById.values()) {
        if (list.length === 1) out.push(list[0]!);
        else if (list.length > 1) out.push(...list);
      }
      return out;
    }
  }

  // Full pass (cold model, level/wall/type/system edit, or whole-model swap).
  const out: Solid[] = [];
  const byId = new Map<string, readonly Solid[]>();
  const levelElevByKey = new Map<string, number>();
  let hasLevels = false;
  for (const lvl of elementsOfKind(elements, "level")) {
    hasLevels = true;
    levelElevByKey.set(lvl.id, lvl.elevationMm);
    levelElevByKey.set(lvl.name, lvl.elevationMm);
  }
  const fullClassReg = hasClass ? classRegistry : null;
  let elementCount = 0;
  for (const id in elements) {
    if (!Object.prototype.hasOwnProperty.call(elements, id)) continue;
    elementCount++;
    const el = elements[id]!;
    if (levels && !levels.has(levelOf(el.partition))) continue;
    const solids = cachedElementSolids(el, rules, model, levelElevByKey, hasLevels, fullClassReg);
    if (solids.length > 0) {
      byId.set(id, solids);
      if (solids.length === 1) out.push(solids[0]!);
      else out.push(...solids);
    }
  }
  lastModelSolids = {
    elements,
    elementCount,
    rules,
    levels,
    classRegistry,
    hasClass,
    partReady,
    byId,
  };
  return out;
}

/** Element ids whose shape must be rebuilt going from `before` to `after` (id + version identity). */
export function changedElements(before: ModelState | null, after: ModelState): { changed: ElementId[]; removed: ElementId[] } {
  const changed: ElementId[] = [];
  const removed: ElementId[] = [];
  // A type's values shape every part of that type.
  const changedTypes = new Set<string>();
  // A system's look colours every run on it.
  const changedSystems = new Set<string>();
  for (const [id, el] of elementEntries(after.elements)) {
    if (el.kind === "part_type" && before?.elements[id] !== el) changedTypes.add(id);
    if (el.kind === "mep_system" && before && before.elements[id] !== el) changedSystems.add(id);
  }
  for (const [id, el] of elementEntries(after.elements)) {
    const prev = before?.elements[id];
    if (!prev || prev.version !== el.version || prev !== el || (el.kind === "part" && changedTypes.has(el.typeId)) || ((el.kind === "run_segment" || el.kind === "run_fitting") && changedSystems.has(el.systemId))) changed.push(el.id);
  }
  // A hosted record's body is sized from its host (a frame as deep as its wall): a changed host rebuilds what it hosts.
  // Read through the kernel's carried hosted index, so an edit never scans the model.
  if (before) {
    const changedSet = new Set(changed);
    for (const id of [...changed]) {
      for (const v of hostVoidsOf(after.elements, id)) {
        if (changedSet.has(v.elementId)) continue;
        changed.push(v.elementId);
        changedSet.add(v.elementId);
      }
    }
  }
  if (before) for (const [id, el] of elementEntries(before.elements)) if (!(id in after.elements)) removed.push(el.id);
  return { changed, removed };
}
