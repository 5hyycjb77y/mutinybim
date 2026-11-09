import * as THREE from "three";
import { matchCamera, orthoZoomFor, visibleHalfHeight } from "../src/projection";
import { orientationFor } from "../src/orientation";

const ASPECT = 1.5;

function perspectiveAt(position: THREE.Vector3, lookAt: THREE.Vector3): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, ASPECT, 0.1, 5000);
  camera.position.copy(position);
  camera.lookAt(lookAt);
  camera.updateMatrixWorld();
  return camera;
}

const ortho = () => new THREE.OrthographicCamera(-50, 50, 50, -50, -5000, 5000);

function screen(camera: THREE.Camera, p: THREE.Vector3): THREE.Vector2 {
  camera.updateMatrixWorld();
  const v = p.clone().project(camera);
  return new THREE.Vector2(v.x, v.y);
}

/** Points on the plane through `pivot` square to the camera: they must land in the same place in both projections. */
function planePoints(camera: THREE.Camera, pivot: THREE.Vector3): THREE.Vector3[] {
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  return [pivot.clone(), pivot.clone().addScaledVector(right, 3), pivot.clone().addScaledVector(up, -2), pivot.clone().addScaledVector(right, -4).addScaledVector(up, 1.5)];
}

describe("switching projection keeps the view", () => {
  it("perspective → orthographic: the orbit point and the plane through it stay where they were on screen", () => {
    const pivot = new THREE.Vector3(2, 1, -3);
    const persp = perspectiveAt(new THREE.Vector3(40, 30, 40), pivot);
    const cam = ortho();
    const centre = matchCamera(persp, cam, pivot, ASPECT);
    expect(centre.distanceTo(pivot)).toBeLessThan(1e-9);
    expect(cam.position.distanceTo(persp.position)).toBeLessThan(1e-9);
    for (const p of planePoints(persp, pivot)) {
      expect(screen(cam, p).distanceTo(screen(persp, p))).toBeLessThan(1e-9);
    }
    expect(visibleHalfHeight(cam, 0)).toBeCloseTo(visibleHalfHeight(persp, persp.position.distanceTo(pivot)), 9);
  });

  it("keeps an off-centre orbit point (a selection away from the screen centre) in place", () => {
    const pivot = new THREE.Vector3(-6, 0, 4);
    const persp = perspectiveAt(new THREE.Vector3(30, 20, 30), new THREE.Vector3(0, 0, 0));
    const cam = ortho();
    matchCamera(persp, cam, pivot, ASPECT);
    for (const p of planePoints(persp, pivot)) {
      expect(screen(cam, p).distanceTo(screen(persp, p))).toBeLessThan(1e-9);
    }
  });

  it("orthographic → perspective after zooming: same framing, and the camera backs off to the matching distance", () => {
    const pivot = new THREE.Vector3(0, 0, 0);
    const start = perspectiveAt(new THREE.Vector3(40, 30, 40), pivot);
    const cam = ortho();
    matchCamera(start, cam, pivot, ASPECT);
    cam.zoom = 2;
    cam.updateProjectionMatrix();
    const back = new THREE.PerspectiveCamera(45, ASPECT, 0.1, 5000);
    matchCamera(cam, back, pivot, ASPECT);
    for (const p of planePoints(cam, pivot)) {
      expect(screen(back, p).distanceTo(screen(cam, p))).toBeLessThan(1e-9);
    }
    // Twice the zoom is half the distance.
    expect(back.position.distanceTo(pivot)).toBeCloseTo(start.position.distanceTo(pivot) / 2, 9);
  });

  it("round trip without zooming puts the perspective camera back where it was", () => {
    const pivot = new THREE.Vector3(1, 2, 3);
    const persp = perspectiveAt(new THREE.Vector3(-25, 18, 31), pivot);
    const before = persp.position.clone();
    const cam = ortho();
    matchCamera(persp, cam, pivot, ASPECT);
    matchCamera(cam, persp, pivot, ASPECT);
    expect(persp.position.distanceTo(before)).toBeLessThan(1e-9);
  });

  it("orthoZoomFor frames what a perspective eye at that distance sees", () => {
    const cam = ortho();
    const zoom = orthoZoomFor(cam, 20, 45);
    expect((cam.top - cam.bottom) / 2 / zoom).toBeCloseTo(20 * Math.tan(THREE.MathUtils.degToRad(22.5)), 9);
  });
});

describe("picking with the orthographic camera", () => {
  it("a ray through a box's screen position hits it, near or far, because orthographic rays are parallel", () => {
    const pivot = new THREE.Vector3(0, 0, 0);
    const persp = perspectiveAt(new THREE.Vector3(40, 30, 40), pivot);
    const cam = ortho();
    matchCamera(persp, cam, pivot, ASPECT);
    const raycaster = new THREE.Raycaster();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const forward = cam.getWorldDirection(new THREE.Vector3());
    // Same sideways offset; one at the orbit point's depth, one 60 m beyond it.
    for (const depth of [0, 60]) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
      box.position.copy(pivot).addScaledVector(right, 8).addScaledVector(forward, depth);
      box.updateMatrixWorld();
      const ndc = screen(cam, box.position);
      raycaster.setFromCamera(ndc, cam);
      const hit = raycaster.intersectObject(box)[0];
      expect(hit).toBeDefined();
      expect(hit?.point.distanceTo(box.position)).toBeLessThan(1);
      // Both boxes are on the same screen spot in orthographic: depth doesn't shift them.
      expect(ndc.x).toBeCloseTo(screen(cam, pivot.clone().addScaledVector(right, 8)).x, 9);
    }
  });
});

describe("preset views in orthographic", () => {
  const scene = (o: { azimuth: number; polar: number }, r = 50) =>
    new THREE.Vector3(r * Math.sin(o.polar) * Math.sin(o.azimuth), r * Math.cos(o.polar), r * Math.sin(o.polar) * Math.cos(o.azimuth));

  function orthoLookingFrom(o: { azimuth: number; polar: number }): THREE.OrthographicCamera {
    const cam = ortho();
    cam.position.copy(scene(o));
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    return cam;
  }

  const screenLength = (cam: THREE.Camera, axis: THREE.Vector3) => screen(cam, axis).distanceTo(screen(cam, new THREE.Vector3()));

  it("a three-quarter view is a true isometric: east, north and up are drawn the same length", () => {
    const cam = orthoLookingFrom(orientationFor({ x: 1, y: -1, z: 1 }));
    // Scene axes: x east, y up, z south.
    const lengths = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)].map((a) => screenLength(cam, a));
    expect(lengths[1]).toBeCloseTo(lengths[0] ?? 0, 9);
    expect(lengths[2]).toBeCloseTo(lengths[0] ?? 0, 9);
  });

  it("a side is a true elevation: a wall 10 m away and one 40 m away draw the same height", () => {
    const cam = orthoLookingFrom(orientationFor("south"));
    const height = (z: number) => screen(cam, new THREE.Vector3(0, 3, z)).y - screen(cam, new THREE.Vector3(0, 0, z)).y;
    expect(height(-40)).toBeCloseTo(height(10), 9);
    // Depth (north–south) collapses: nothing on screen moves sideways with distance.
    expect(screen(cam, new THREE.Vector3(4, 0, -40)).x).toBeCloseTo(screen(cam, new THREE.Vector3(4, 0, 10)).x, 9);
  });
});
