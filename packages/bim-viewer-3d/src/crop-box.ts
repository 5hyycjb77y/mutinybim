/**
 * The 3D crop box in the viewer: its six clipping planes (rotated with the
 * box), its outline, where its six face grips sit on screen, and how far a
 * dragged grip moves its face. Kernel millimetres in (x east, y north, z up),
 * scene metres out (x east, y up, z south).
 *
 * Grips are flat 2D dots the canvas overlay draws from `gripsOnScreen`; the
 * scene only draws the outline (an internal design note,
 * section 6, explains why grips are flat and there is no rotate handle).
 */
import * as THREE from "three";
import { BOX_EDGES, CROP_FACES, boxCorners, boxKeepPlanes, faceCenter, type CropBox3d, type CropFace, type Point3 } from "@permitzip/bim-kernel";
import { MM } from "./coords";

const toScene = (q: Point3): THREE.Vector3 => new THREE.Vector3(q.x * MM, q.z * MM, -q.y * MM);
const dirToScene = (n: Point3): THREE.Vector3 => new THREE.Vector3(n.x, n.z, -n.y);

/** The six planes that keep the inside of the box, in scene space (three.js keeps where distance >= 0). */
export function cropBoxScenePlanes(box: CropBox3d): THREE.Plane[] {
  return boxKeepPlanes(box).map((pl) => new THREE.Plane(dirToScene(pl.normal), pl.constant * MM));
}

/** Is a scene point on the kept side of every clipping plane (what the renderer draws, and the only thing picking may hit)? */
export function keptByPlanes(planes: readonly THREE.Plane[], point: THREE.Vector3): boolean {
  return planes.every((p) => p.distanceToPoint(point) >= 0);
}

/** The nearest hit on geometry the planes keep: a clipped-away surface in front never blocks what is behind it. */
export function firstKeptHit<T extends THREE.Intersection>(hits: readonly T[], planes: readonly THREE.Plane[]): T | null {
  return hits.find((h) => keptByPlanes(planes, h.point)) ?? null;
}

/** The box's twelve edges as line-segment positions (scene metres). */
export function cropBoxOutlinePositions(box: CropBox3d): Float32Array {
  const corners = boxCorners(box).map(toScene);
  const out = new Float32Array(BOX_EDGES.length * 6);
  BOX_EDGES.forEach(([a, b], i) => {
    const ca = corners[a];
    const cb = corners[b];
    if (!ca || !cb) return;
    out.set([ca.x, ca.y, ca.z, cb.x, cb.y, cb.z], i * 6);
  });
  return out;
}

export interface GripOnScreen {
  readonly face: CropFace;
  /** Canvas pixels from its top-left. */
  readonly x: number;
  readonly y: number;
  /** The face looks toward the camera (a grip on the far side is drawn fainter). */
  readonly facing: boolean;
}

/** Where each face grip sits on the canvas; faces behind the camera are left out. */
export function gripsOnScreen(box: CropBox3d, camera: THREE.Camera, width: number, height: number): GripOnScreen[] {
  camera.updateMatrixWorld();
  const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const ortho = camera instanceof THREE.OrthographicCamera;
  const out: GripOnScreen[] = [];
  for (const face of CROP_FACES) {
    const { point, normal } = faceCenter(box, face);
    const at = toScene(point);
    const ndc = at.clone().project(camera);
    if (ndc.z < -1 || ndc.z > 1) continue;
    const toEye = ortho ? forward.clone().negate() : eye.clone().sub(at);
    out.push({ face, x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height, facing: dirToScene(normal).dot(toEye) > 0 });
  }
  return out;
}

/**
 * How far (mm, along the face's outward normal) the face moves so it passes
 * the point on its normal line nearest the pointer's ray. Null when the ray
 * runs along that line (looking straight at the face), where any distance fits.
 */
export function faceDragOffsetMm(box: CropBox3d, face: CropFace, ray: THREE.Ray): number | null {
  const { point, normal } = faceCenter(box, face);
  const p0 = toScene(point);
  const n = dirToScene(normal).normalize();
  // Closest points between the face's normal line p0 + t·n and the ray o + s·d.
  const w0 = p0.clone().sub(ray.origin);
  const b = n.dot(ray.direction);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  const t = (b * ray.direction.dot(w0) - n.dot(w0)) / denom;
  return t / MM;
}

/** The box outline, drawn over the model in its own pass so the clipping planes never eat it. */
export class CropBoxOutline {
  readonly object: THREE.LineSegments;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.LineBasicMaterial;

  constructor(color: THREE.ColorRepresentation) {
    // Near-opaque: at half opacity even a dark outline blends below 3:1 on a light background.
    this.material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.renderOrder = 20;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  set(box: CropBox3d | null) {
    if (!box) {
      this.object.visible = false;
      return;
    }
    this.geometry.setAttribute("position", new THREE.BufferAttribute(cropBoxOutlinePositions(box), 3));
    this.geometry.computeBoundingSphere();
    this.object.visible = true;
  }

  setColor(color: THREE.ColorRepresentation) {
    this.material.color.set(color);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
