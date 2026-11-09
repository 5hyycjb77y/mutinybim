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
  fittingBody,
  fittingMesh,
  flexRings,
  insulationEnvelope,
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
  elementEntries, elementValues,
  levelOf as kernelLevelOf,
  KNOWN_COMPONENT_CATEGORIES,
  asCeiling,
  hostSolidBlocks,
  wallBodyProfile,
  hostVoidsOf,
  kindRowOf,
  activeClassRegistry,
  classSolidsOf,
  hasClassSolids,
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
  const base = { elementId: part.id, version: part.version, group };
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
      // A wall something joins or is hosted in is the kernel's body, the one sections draw: its ends joined
      // (clean corners, no overlap) and cut round its doors and windows. The viewer batches those per level.
      // A wall nothing joins or cuts stays an instanced box, so a large model draws in few batches.
      // A wall whose top or base follows a surface is drawn from its body profile (sloped under a pitched roof).
      const blocks = model ? hostSolidBlocks(model.elements, el, el.height, wallBodyProfile(el)) : null;
      if (blocks) {
        const solid = prismsSolid(el.id, el.version, "wall", blocks.map((b) => ({ outline: b.outline, z0: floor + b.z0, z1: floor + b.z1, ...(b.tilt0 ? { tilt0: b.tilt0 } : {}), ...(b.tilt1 ? { tilt1: b.tilt1 } : {}) })));
        return solid ? [solid] : [];
      }
      return [
        {
          ...base,
          group: "wall",
          shape: "box",
          center: kernelToScene((el.start.x + el.end.x) / 2, (el.start.y + el.end.y) / 2, floor + el.height / 2),
          size: [len * MM, el.height * MM, el.thickness * MM],
          yaw: planAngleToSceneYaw(dx, dy),
        },
      ];
    }
    case "slab": {
      const xs = el.outline.map((p) => p.x);
      const ys = el.outline.map((p) => p.y);
      if (xs.length === 0) return [];
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
    case "column":
      return [
        {
          ...base,
          group: "structure",
          shape: "box",
          center: kernelToScene(el.position.x, el.position.y, floor + rules.floorToFloorMm / 2),
          size: [el.size.x * MM, rules.floorToFloorMm * MM, el.size.y * MM],
          yaw: 0,
        },
      ];
    case "beam": {
      const dx = el.end.x - el.start.x;
      const dy = el.end.y - el.start.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return [];
      return [
        {
          ...base,
          group: "structure",
          shape: "box",
          center: kernelToScene((el.start.x + el.end.x) / 2, (el.start.y + el.end.y) / 2, floor + rules.floorToFloorMm - 300),
          size: [len * MM, 600 * MM, 300 * MM],
          yaw: planAngleToSceneYaw(dx, dy),
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
      const z = (level?.kind === "level" ? level.elevationMm : floor) + c.heightMm;
      const solid = prismsSolid(el.id, el.version, "slab", [{ outline: c.outline, z0: z, z1: z + CEILING_THICKNESS_MM }]);
      return solid ? [solid] : [];
    }
    default: {
      // An add-on kind with a body (a stair, a roof, another firm's kind) draws the body its row gives.
      const face = model ? kindRowOf(el.kind)?.solid : undefined;
      const shape = face && model ? face(el, { elements: model.elements, floorMm: floor }) : null;
      return shape ? kindShapeSolids(el, shape) : [];
    }
  }
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

/** Solids for every element, optionally only for elements in `levels`. */
export function modelSolids(model: ModelState, rules: ElevationRules = DEFAULT_ELEVATIONS, levels?: ReadonlySet<string>): Solid[] {
  const out: Solid[] = [];
  for (const el of elementValues(model.elements)) {
    if (levels && !levels.has(levelOf(el.partition))) continue;
    out.push(...elementSolids(el, rules, model));
  }
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
