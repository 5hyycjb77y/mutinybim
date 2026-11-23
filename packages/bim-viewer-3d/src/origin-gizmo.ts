import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ScreenPoint } from "./plan-snap";

/**
 * The origin marker: X (east, red), Y (plan north, green) and Z (up, blue)
 * arrows at the active origin point, and its three axes drawn as lines that
 * run to the edges of the view. The arrows are scene objects kept at a fixed
 * size on screen; the axis lines are computed in screen space so their dashes
 * stay the same size at any zoom and, in perspective, run to their vanishing
 * points. Everything here is pure math on a camera, so it is tested without a
 * GPU.
 */

export type GizmoAxis = "x" | "y" | "z";
export type GizmoHandle = GizmoAxis | "point";

export type { ScreenPoint } from "./plan-snap";

export interface ScreenSegment {
  readonly a: ScreenPoint;
  readonly b: ScreenPoint;
}

/** Model axes in scene axes (scene: X east, Y up, Z south). */
export const AXIS_SCENE: Readonly<Record<GizmoAxis, THREE.Vector3>> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 0, -1),
  z: new THREE.Vector3(0, 1, 0),
};

export const AXIS_COLOR: Readonly<Record<GizmoAxis, number>> = { x: 0xd83a3a, y: 0x2e9e4f, z: 0x3366e6 };

/** Arrow length on screen, px. */
export const ARROW_PX = 64;
/** How close (px) the pointer must be to grab the point or an arrow. */
const GRAB_POINT_PX = 11;
const GRAB_ARROW_PX = 7;

/** Half-length of the "infinite" line before projection, metres (far past any building). */
const REACH_M = 100_000;
/** An axis within this cosine of the view direction is seen end-on: draw no line for it (only the marker). */
const END_ON_COS = 0.985;

/** Liang–Barsky: the part of a→b inside [0, w] × [0, h], or null. */
export function clipToRect(a: ScreenPoint, b: ScreenPoint, w: number, h: number): ScreenSegment | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: Array<[number, number]> = [
    [-dx, a.x],
    [dx, w - a.x],
    [-dy, a.y],
    [dy, h - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return { a: { x: a.x + t0 * dx, y: a.y + t0 * dy }, b: { x: a.x + t1 * dx, y: a.y + t1 * dy } };
}

function nearDistance(camera: THREE.Camera): number {
  return camera instanceof THREE.PerspectiveCamera ? camera.near : -Infinity;
}

function toScreen(camera: THREE.Camera, view: THREE.Vector3, w: number, h: number): ScreenPoint {
  const ndc = view.clone().applyMatrix4(camera.projectionMatrix);
  return { x: ((ndc.x + 1) / 2) * w, y: ((1 - ndc.y) / 2) * h };
}

/**
 * The visible part of the infinite line through `origin` along `dir` (scene
 * metres), in canvas pixels: clipped to the camera's near plane, projected,
 * then clipped to the view. Null when none of it is on screen, or when it
 * points straight at the camera (it is then just a dot under the origin).
 */
export function infiniteLineOnScreen(camera: THREE.Camera, origin: THREE.Vector3, dir: THREE.Vector3, w: number, h: number): ScreenSegment | null {
  camera.updateMatrixWorld();
  const inv = camera.matrixWorldInverse;
  const d = dir.clone().normalize();
  let p0 = origin.clone().addScaledVector(d, -REACH_M).applyMatrix4(inv);
  let p1 = origin.clone().addScaledVector(d, REACH_M).applyMatrix4(inv);
  // In view space the camera looks down -Z; keep z <= -near.
  const limit = -nearDistance(camera) - 1e-6;
  if (Number.isFinite(limit)) {
    const in0 = p0.z <= limit;
    const in1 = p1.z <= limit;
    if (!in0 && !in1) return null;
    if (!in0 || !in1) {
      const t = (limit - p0.z) / (p1.z - p0.z);
      const cut = p0.clone().lerp(p1, t);
      if (in0) p1 = cut;
      else p0 = cut;
    }
  }
  const a = toScreen(camera, p0, w, h);
  const b = toScreen(camera, p1, w, h);
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1) return null;
  return clipToRect(a, b, w, h);
}

/** Canvas pixel of a scene point, or null when it is behind the camera. */
export function pointOnScreen(camera: THREE.Camera, p: THREE.Vector3, w: number, h: number): ScreenPoint | null {
  camera.updateMatrixWorld();
  const view = p.clone().applyMatrix4(camera.matrixWorldInverse);
  if (camera instanceof THREE.PerspectiveCamera && view.z > -camera.near) return null;
  return toScreen(camera, view, w, h);
}

/** Scene metres per screen pixel at a point (for keeping the arrows a fixed size). */
export function metresPerPixel(camera: THREE.Camera, p: THREE.Vector3, heightPx: number): number {
  if (camera instanceof THREE.OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / Math.max(1, heightPx);
  if (camera instanceof THREE.PerspectiveCamera) {
    const distance = camera.position.distanceTo(p);
    return (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / camera.zoom / Math.max(1, heightPx);
  }
  return 0.01;
}

function distanceToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface GizmoScreen {
  readonly origin: ScreenPoint | null;
  /** Arrow tips on screen (null when an axis points at the camera or the origin is behind it). */
  readonly tips: Readonly<Record<GizmoAxis, ScreenPoint | null>>;
  readonly lines: Readonly<Record<GizmoAxis, ScreenSegment | null>>;
}

export function gizmoScreen(camera: THREE.Camera, origin: THREE.Vector3, w: number, h: number): GizmoScreen {
  const o = pointOnScreen(camera, origin, w, h);
  const look = camera.getWorldDirection(new THREE.Vector3());
  const line = (axis: GizmoAxis): ScreenSegment | null => (Math.abs(look.dot(AXIS_SCENE[axis])) > END_ON_COS ? null : infiniteLineOnScreen(camera, origin, AXIS_SCENE[axis], w, h));
  const mpp = metresPerPixel(camera, origin, h);
  const tip = (axis: GizmoAxis): ScreenPoint | null => {
    if (!o) return null;
    const t = pointOnScreen(camera, origin.clone().addScaledVector(AXIS_SCENE[axis], ARROW_PX * mpp), w, h);
    return t && Math.hypot(t.x - o.x, t.y - o.y) > 4 ? t : null;
  };
  return {
    origin: o,
    tips: { x: tip("x"), y: tip("y"), z: tip("z") },
    lines: { x: line("x"), y: line("y"), z: line("z") },
  };
}

/** What the pointer would grab: the point itself (move in plan), one arrow (move along it), or nothing. */
export function gizmoHandleAt(screen: GizmoScreen, p: ScreenPoint): GizmoHandle | null {
  if (!screen.origin) return null;
  if (Math.hypot(p.x - screen.origin.x, p.y - screen.origin.y) <= GRAB_POINT_PX) return "point";
  let best: { axis: GizmoAxis; d: number } | null = null;
  for (const axis of ["x", "y", "z"] as const) {
    const tip = screen.tips[axis];
    if (!tip) continue;
    const d = distanceToSegment(p, screen.origin, tip);
    if (d <= GRAB_ARROW_PX && (!best || d < best.d)) best = { axis, d };
  }
  return best?.axis ?? null;
}

/**
 * Orbit about the selection when there is one, otherwise about the middle of
 * the model (`modelBox`, the bounds Home frames); the project origin only
 * while nothing is loaded or drawn. (The wheel zooms toward the pointer.)
 */
export function chooseOrbitPivot(selection: THREE.Vector3 | null, modelBox: THREE.Box3, projectOrigin: THREE.Vector3): THREE.Vector3 {
  if (selection) return selection.clone();
  return modelBox.isEmpty() ? projectOrigin.clone() : modelBox.getCenter(new THREE.Vector3());
}

export { SNAP_PX, snapPlanPoint, type SnapCandidate } from "./plan-snap";

/**
 * Screen-up direction of a top-down plan camera, in scene axes, for a plan
 * turned so that `upDeg` (degrees clockwise from plan north) points up. 0 is
 * plan north up; the true north angle puts true north up.
 */
export function planUpVector(upDeg: number): THREE.Vector3 {
  const a = THREE.MathUtils.degToRad(upDeg);
  // Plan direction (sin a, cos a) in scene axes is (sin a, 0, −cos a).
  return new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
}

/** Geometry with one colour on every vertex, so differently coloured parts merge into one draw. */
function coloured(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.deleteAttribute("uv");
  return geometry;
}

/**
 * The arrows and the hub as ONE mesh (one draw call, a few hundred triangles),
 * drawn over the model and never picked. One unit long; the viewer scales it
 * each frame to a fixed size on screen. `axes` are the theme's X, Y and Z
 * colors; missing ones use `AXIS_COLOR`.
 */
export function buildArrows(axes?: readonly [THREE.ColorRepresentation, THREE.ColorRepresentation, THREE.ColorRepresentation]): THREE.Group {
  const parts: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  (["x", "y", "z"] as const).forEach((axis, i) => {
    const color = axes?.[i] ?? AXIS_COLOR[axis];
    const turn = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up, AXIS_SCENE[axis]));
    const shaft = new THREE.CylinderGeometry(0.012, 0.012, 0.78, 8).translate(0, 0.39, 0).applyMatrix4(turn);
    const head = new THREE.ConeGeometry(0.055, 0.22, 16).translate(0, 0.89, 0).applyMatrix4(turn);
    parts.push(coloured(shaft, color), coloured(head, color));
  });
  parts.push(coloured(new THREE.SphereGeometry(0.06, 16, 12), 0x1f2937));
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error("The origin marker's arrows could not be built.");
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
  mesh.name = "origin-arrows";
  mesh.renderOrder = 20;
  const group = new THREE.Group();
  group.name = "origin-gizmo";
  group.add(mesh);
  return group;
}

const AXIS_LINE_HALF_LEN_M = 800;

/**
 * Depth-aware 3D dashed infinite axis lines (X red, Y green, Z blue) rendered in
 * two passes so portions in front of the building stay crisp (`opacity: 0.65`)
 * while portions occluded behind walls, slabs, or roofs dim softly (`opacity: 0.14`).
 */
export function buildDepthAwareAxisLines(axes?: readonly [THREE.ColorRepresentation, THREE.ColorRepresentation, THREE.ColorRepresentation]): THREE.Group {
  const group = new THREE.Group();
  group.name = "origin-axis-lines";

  (["x", "y", "z"] as const).forEach((axis, i) => {
    const color = axes?.[i] ?? AXIS_COLOR[axis];
    const dir = AXIS_SCENE[axis];
    const geo = new THREE.BufferGeometry().setFromPoints([
      dir.clone().multiplyScalar(-AXIS_LINE_HALF_LEN_M),
      dir.clone().multiplyScalar(AXIS_LINE_HALF_LEN_M),
    ]);

    const frontMat = new THREE.LineDashedMaterial({
      color,
      dashSize: 0.35,
      gapSize: 0.25,
      transparent: true,
      opacity: 0.65,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      depthWrite: false,
      toneMapped: false,
    });
    const front = new THREE.Line(geo, frontMat);
    front.computeLineDistances();
    front.frustumCulled = false;
    front.renderOrder = 18;
    front.userData.axis = axis;
    front.userData.nonPickable = true;

    const behindMat = new THREE.LineDashedMaterial({
      color,
      dashSize: 0.35,
      gapSize: 0.25,
      transparent: true,
      opacity: 0.14,
      depthTest: true,
      depthFunc: THREE.GreaterDepth,
      depthWrite: false,
      toneMapped: false,
    });
    const behind = new THREE.Line(geo, behindMat);
    behind.computeLineDistances();
    behind.frustumCulled = false;
    behind.renderOrder = 19;
    behind.userData.axis = axis;
    behind.userData.nonPickable = true;

    group.add(front, behind);
  });

  return group;
}

const _axisLook = new THREE.Vector3();

/** Keep 3D axis line dashes at a steady screen-pixel pitch and hide axes seen end-on. */
export function updateDepthAwareAxisLines(group: THREE.Group, camera: THREE.Camera, origin: THREE.Vector3, heightPx: number): void {
  const mpp = Math.max(1e-4, metresPerPixel(camera, origin, heightPx));
  const dashSize = 6.5 * mpp;
  const gapSize = 5.0 * mpp;
  camera.getWorldDirection(_axisLook);

  for (const child of group.children) {
    if (!(child instanceof THREE.Line)) continue;
    const axis = child.userData.axis as GizmoAxis | undefined;
    if (!axis) continue;
    child.visible = Math.abs(_axisLook.dot(AXIS_SCENE[axis])) <= END_ON_COS;
    if (child.material instanceof THREE.LineDashedMaterial) {
      child.material.dashSize = dashSize;
      child.material.gapSize = gapSize;
    }
  }
}
