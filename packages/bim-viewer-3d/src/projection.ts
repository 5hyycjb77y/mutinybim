/**
 * Perspective and orthographic (parallel) projection for the 3D view, and
 * switching between them without the picture jumping: what sits at the orbit
 * point's depth keeps its size and place on screen.
 */
import * as THREE from "three";

export { PROJECTIONS, type Projection } from "./projection-kinds";

export type ViewCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/** Nearest depth a switch frames at, metres (an orbit point at or behind the eye would frame nothing). */
const MIN_DEPTH_M = 0.5;

/** Half the view's height in metres at `depth` in front of the camera. */
export function visibleHalfHeight(camera: ViewCamera, depth: number): number {
  if (camera instanceof THREE.PerspectiveCamera) return (depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / camera.zoom;
  return (camera.top - camera.bottom) / 2 / camera.zoom;
}

/** The orthographic zoom that frames what a perspective eye `distance` away would (with `fovDeg`). */
export function orthoZoomFor(camera: THREE.OrthographicCamera, distance: number, fovDeg: number): number {
  const half = Math.max(MIN_DEPTH_M, distance) * Math.tan(THREE.MathUtils.degToRad(fovDeg / 2));
  return (camera.top - camera.bottom) / 2 / half;
}

/**
 * Put `to` where it shows what `from` shows: same direction and up, and the
 * plane through `pivot` square to the view the same size on screen. Returns
 * the point at the centre of the screen on that plane (the new look-at point).
 */
export function matchCamera(from: ViewCamera, to: ViewCamera, pivot: THREE.Vector3, aspect: number): THREE.Vector3 {
  from.updateMatrixWorld();
  const dir = from.getWorldDirection(new THREE.Vector3());
  const depth = Math.max(MIN_DEPTH_M, pivot.clone().sub(from.position).dot(dir));
  const half = visibleHalfHeight(from, depth);
  const centre = from.position.clone().addScaledVector(dir, depth);
  to.up.copy(from.up);
  to.zoom = 1;
  if (to instanceof THREE.OrthographicCamera) {
    to.top = half;
    to.bottom = -half;
    to.left = -half * aspect;
    to.right = half * aspect;
    // Same eye distance, so orbiting (and switching back) turns about the same point.
    to.position.copy(centre).addScaledVector(dir, -depth);
  } else {
    to.aspect = aspect;
    to.position.copy(centre).addScaledVector(dir, -half / Math.tan(THREE.MathUtils.degToRad(to.fov / 2)));
  }
  to.quaternion.copy(from.quaternion);
  to.updateProjectionMatrix();
  to.updateMatrixWorld();
  return centre;
}
