/**
 * @jest-environment jsdom
 */
import * as THREE from "three";
import { makeCameraControls } from "../src/navigation";
import { ModelViewer3D } from "../src/viewer";

function element(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

const perspective = () => new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 5000);

function settle(controls: ReturnType<typeof makeCameraControls>) {
  for (let i = 0; i < 200; i++) controls.update(1 / 30);
}

/** How far a world point lands from the centre of the view, in NDC (0 = dead centre). */
function aimOffset(camera: THREE.PerspectiveCamera, point: THREE.Vector3): number {
  camera.updateMatrixWorld();
  const v = point.clone().project(camera);
  return Math.hypot(v.x, v.y);
}

describe("restoring a camera over a pinned orbit point", () => {
  it("setLookAt alone does not clear the focal offset a pin left behind: the restored view aims off its target", () => {
    const cam = perspective();
    const controls = makeCameraControls(cam, element());
    void controls.setLookAt(40, 30, 40, 0, 0, 0, false);
    settle(controls);
    // A click pinned an orbit point off the centre of the view: camera-controls keeps its
    // screen place with a focal offset (dolly + offset + move, recomputed from the current pose).
    controls.setOrbitPoint(5, 1, -3);
    settle(controls);
    // The restore: the saved camera's eye and target.
    void controls.setLookAt(25, 18, 31, 0, 0, 0, false);
    settle(controls);
    expect(aimOffset(cam, new THREE.Vector3(0, 0, 0))).toBeGreaterThan(0.01);
  });

  it("clearing the offset and re-pinning to the restored target aims the view back at what it looks at", () => {
    const cam = perspective();
    const controls = makeCameraControls(cam, element());
    void controls.setLookAt(40, 30, 40, 0, 0, 0, false);
    settle(controls);
    controls.setOrbitPoint(5, 1, -3);
    settle(controls);
    void controls.setLookAt(25, 18, 31, 0, 0, 0, false);
    settle(controls);
    // What setCamera3d does after its setLookAt: clear the offset and let it apply before
    // re-pinning (setOrbitPoint keeps the point where it sits on screen, so order matters),
    // and the pin follows the restored target.
    controls.setFocalOffset(0, 0, 0, false);
    controls.update(0);
    controls.setOrbitPoint(0, 0, 0);
    controls.update(0);
    settle(controls);
    expect(aimOffset(cam, new THREE.Vector3(0, 0, 0))).toBeLessThan(1e-6);
  });

  it("ModelViewer3D camera3dState -> setCamera3d preserves exact viewing direction after an off-centre pin on the first round trip", async () => {
    const cam = perspective();
    const orthoView = new THREE.OrthographicCamera(-50, 50, 50, -50, -5000, 5000);
    const controls = makeCameraControls(cam, element());
    void controls.setLookAt(40, 30, 40, 0, 0, 0, false);
    settle(controls);
    cam.updateMatrixWorld();
    const beforePos = cam.position.clone();
    const beforeDir = cam.getWorldDirection(new THREE.Vector3());

    // Pin an off-centre orbit point: camera-controls moves controls.target to the pivot and
    // holds the picture still with a focal offset.
    controls.setOrbitPoint(5, 1, -3);
    settle(controls);

    const viewer = Object.create(ModelViewer3D.prototype) as ModelViewer3D;
    Object.assign(viewer, {
      mode: "3d",
      projection: "perspective",
      perspective: cam,
      orthoView,
      controls,
      orbitPointPinned: true,
      fovDirty: false,
      cameraListeners: new Set<() => void>(),
      cameraSettledListeners: new Set<() => void>(),
      fragments: { update: jest.fn(async () => undefined) },
    });

    // Snapshot while the off-centre pin is active, then restore via production setCamera3d.
    const saved = viewer.camera3dState();
    expect(saved).not.toBeNull();
    await viewer.setCamera3d(saved!, false);
    settle(controls);
    cam.updateMatrixWorld();

    expect(cam.position.distanceTo(beforePos)).toBeLessThan(1e-4);
    expect(cam.getWorldDirection(new THREE.Vector3()).angleTo(beforeDir)).toBeLessThan(1e-6);
    expect(aimOffset(cam, new THREE.Vector3(0, 0, 0))).toBeLessThan(1e-6);
  });
});
