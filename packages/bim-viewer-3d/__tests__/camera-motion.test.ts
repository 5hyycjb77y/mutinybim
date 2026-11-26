import * as THREE from "three";
import { makeCameraControls } from "../src/navigation";
import { ModelViewer3D } from "../src/viewer";

/** Use the production controls and two cameras without allocating a WebGL context in jsdom. */
function viewerRig() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const perspective = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 5000);
  const ortho = new THREE.OrthographicCamera(-8, 8, 6, -6, -5000, 5000);
  const controls = makeCameraControls(ortho, canvas);
  void controls.setLookAt(12, 8, 5, 0, 0, 0, false);
  controls.update(0);
  const viewer = Object.create(ModelViewer3D.prototype) as ModelViewer3D;
  const scene = new THREE.Scene();
  const fragments = { update: jest.fn(async () => {}) };
  Object.assign(viewer, { mode: "3d", projection: "orthographic", controls, perspective, orthoView: ortho, container: canvas, renderer: { domElement: canvas },
    pointerClaims: new Set(), passThroughListeners: new Set(), cameraListeners: new Set(), cameraSettledListeners: new Set(), zoomFloor: 1,
    fragments, scene, references: new Map(), palette: { css: () => "orange" } });
  return { viewer, fragments, scene };
}

it("temporarily uses perspective, keeps a stationary walker at rest, and releases the route and previous projection exactly once", () => {
  const { viewer, fragments, scene } = viewerRig();
  const pose = { eye: { x: 1200, y: -4000, z: 1600 }, target: { x: 1200, y: -2000, z: 1600 } };
  const session = viewer.beginCameraMotion([pose.eye, pose.target])!;
  expect(viewer.getProjection()).toBe("perspective");
  expect(viewer.pointerClaimed()).toBe(true);
  expect(scene.children).toHaveLength(2);
  const settled = jest.fn();
  viewer.onCameraSettled(settled);
  expect(session.look(pose)).toBe(true);
  const snapshot = viewer.camera3dState()!;
  expect(snapshot.eye.x).toBeCloseTo(pose.eye.x);
  expect(snapshot.eye.y).toBeCloseTo(pose.eye.y);
  expect(snapshot.eye.z).toBeCloseTo(pose.eye.z);
  expect(snapshot.target.y).toBeCloseTo(pose.target.y);
  expect(settled).not.toHaveBeenCalled();
  fragments.update.mockClear();
  session.look(pose);
  expect(fragments.update).not.toHaveBeenCalled();
  session.release();
  expect(viewer.pointerClaimed()).toBe(false);
  expect(scene.children).toHaveLength(0);
  expect(viewer.getProjection()).toBe("orthographic");
  const settles = settled.mock.calls.length;
  expect(settles).toBeGreaterThan(0);
  session.release();
  expect(settled).toHaveBeenCalledTimes(settles);
  expect(session.look(pose)).toBe(false);
});

it("leaves an existing editor pointer claim alone and invalidates the previous camera handle on an outside projection change", () => {
  const { viewer } = viewerRig();
  const releaseEdit = viewer.claimPointer("Route stroke");
  expect(viewer.beginCameraMotion()).toBeNull();
  expect(viewer.getProjection()).toBe("orthographic");
  releaseEdit();
  const session = viewer.beginCameraMotion()!;
  viewer.setProjection("orthographic");
  expect(viewer.pointerClaimed()).toBe(false);
  expect(session.look({ eye: { x: 0, y: -1000, z: 0 }, target: { x: 0, y: 0, z: 0 } })).toBe(false);
  expect(viewer.getProjection()).toBe("orthographic");
});
