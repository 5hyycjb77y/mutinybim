/**
 * @jest-environment jsdom
 */
import * as THREE from "three";
import CameraControls from "camera-controls";
import { makeCameraControls, type PointZoomControls } from "../src/navigation";

function element(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

function settle(controls: PointZoomControls, camera: THREE.Camera, frames = 300) {
  for (let i = 0; i < frames; i++) controls.update(1 / 60);
  camera.updateMatrixWorld();
}

function rig() {
  const el = element();
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 5000);
  const controls = makeCameraControls(camera, el);
  void controls.setLookAt(40, 30, 40, 0, 0, 0, false);
  settle(controls, camera);
  return { el, camera, controls };
}

function wheel(el: HTMLElement, deltaY: number) {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, bubbles: true, cancelable: true }));
}

/** A mouse pointer event as camera-controls reads it (jsdom has no PointerEvent constructor). */
function pointer(target: EventTarget, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, buttons: number) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

function orbitDrag(el: HTMLElement, controls: PointZoomControls) {
  pointer(el, "pointerdown", 400, 300, 1);
  for (let i = 1; i <= 10; i++) {
    controls.update(1 / 60);
    pointer(document, "pointermove", 400 + i * 20, 300, 1);
  }
  pointer(document, "pointerup", 600, 300, 0);
}

/** Ten wheel notches; between them the route preview grows, which used to move the orbit point every time. */
function zoomWhileEditing(withEdits: boolean): number {
  const { el, camera, controls } = rig();
  const start = camera.position.clone();
  for (let i = 0; i < 10; i++) {
    wheel(el, -100);
    controls.update(1 / 60);
    if (withEdits) controls.requestFallbackPivot(new THREE.Vector3(0.3 * i, 0, 0.2 * i));
    controls.update(1 / 60);
  }
  settle(controls, camera);
  return camera.position.distanceTo(start);
}

function orbitWhileEditing(withEdits: boolean): THREE.Vector3 {
  const { camera, controls } = rig();
  for (let i = 0; i < 10; i++) {
    void controls.rotate(0.05, 0, true);
    controls.update(1 / 60);
    if (withEdits) controls.requestFallbackPivot(new THREE.Vector3(0.3 * i, 0, 0.2 * i));
    controls.update(1 / 60);
  }
  settle(controls, camera);
  return camera.position.clone();
}

describe("the middle-of-the-model orbit point never fights the camera", () => {
  it("a wheel zoom keeps its full travel while edits keep moving the model's middle", () => {
    // Moving the orbit point on every preview (the old path) kept 1.9 m of a 51 m zoom.
    const free = zoomWhileEditing(false);
    expect(Math.abs(zoomWhileEditing(true) - free)).toBeLessThan(free * 0.001);
  });

  it("an orbit ends where it would have with no edits (the pivot does not swim)", () => {
    // The old path ended 1.2 m off at 57 m; what is left is camera-controls' rest threshold.
    expect(orbitWhileEditing(true).distanceTo(orbitWhileEditing(false))).toBeLessThan(0.05);
  });

  it("the waiting point lands once the camera is still, without moving the camera", () => {
    const { el, camera, controls } = rig();
    wheel(el, -100);
    controls.update(1 / 60);
    controls.requestFallbackPivot(new THREE.Vector3(3, 1, -2));
    expect(controls.hasPendingPivot()).toBe(true);
    settle(controls, camera);
    expect(controls.hasPendingPivot()).toBe(false);
    expect(controls.getTarget(new THREE.Vector3()).distanceTo(new THREE.Vector3(3, 1, -2))).toBeLessThan(1e-6);
    const before = camera.position.clone();
    settle(controls, camera);
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-9);
  });

  it("while an edit owns the pointer the point waits, then lands on release", () => {
    const { camera, controls } = rig();
    controls.setPointerBlocked(true);
    controls.requestFallbackPivot(new THREE.Vector3(1, 0, 1));
    settle(controls, camera);
    expect(controls.hasPendingPivot()).toBe(true);
    controls.setPointerBlocked(false);
    settle(controls, camera);
    expect(controls.hasPendingPivot()).toBe(false);
  });

  it("a click's orbit point drops a waiting middle-of-the-model point", () => {
    const { el, controls } = rig();
    wheel(el, -100);
    controls.update(1 / 60);
    controls.requestFallbackPivot(new THREE.Vector3(1, 0, 1));
    controls.clearFallbackPivot();
    expect(controls.hasPendingPivot()).toBe(false);
  });

  it("a wheel zoom toward the pointer drops a waiting middle-of-the-model point (the pointer chose newer)", () => {
    const { el, camera, controls } = rig();
    controls.setPointerBlocked(true);
    controls.requestFallbackPivot(new THREE.Vector3(1, 0, 1));
    wheel(el, -100);
    controls.setPointerBlocked(false);
    settle(controls, camera);
    expect(controls.hasPendingPivot()).toBe(false);
    expect(controls.getTarget(new THREE.Vector3()).distanceTo(new THREE.Vector3(1, 0, 1))).toBeGreaterThan(1);
  });
});

describe("an edit that owns the pointer", () => {
  it("a press-and-drag does not orbit, even though the camera saw the press first", () => {
    const { el, camera, controls } = rig();
    const before = camera.quaternion.clone();
    // camera-controls listens on the canvas, so it starts an orbit before the surface decides the press is a grab.
    pointer(el, "pointerdown", 400, 300, 1);
    controls.setPointerBlocked(true);
    for (let i = 1; i <= 10; i++) {
      controls.update(1 / 60);
      pointer(document, "pointermove", 400 + i * 20, 300, 1);
    }
    pointer(document, "pointerup", 600, 300, 0);
    settle(controls, camera);
    expect(camera.quaternion.angleTo(before)).toBeLessThan(1e-9);
  });

  it("the wheel still zooms during the edit", () => {
    const { el, camera, controls } = rig();
    controls.setPointerBlocked(true);
    const d0 = camera.position.length();
    wheel(el, -200);
    settle(controls, camera);
    expect(camera.position.length()).toBeLessThan(d0 * 0.9);
  });

  it("mid-drag, the wheel zooms toward the still pointer and the point under it on the drag plane does not jump", () => {
    const { el, camera, controls } = rig();
    controls.zoomAnchor = ({ ray }) => ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    const at = { x: 610, y: 380 };
    const ndc = new THREE.Vector2((at.x / 800) * 2 - 1, -(at.y / 600) * 2 + 1);
    // A duct dragged at 3 m: the drag preview is where the pointer's ray meets that plane.
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -3);
    const dragPoint = () => {
      const r = new THREE.Raycaster();
      r.setFromCamera(ndc, camera);
      return r.ray.intersectPlane(dragPlane, new THREE.Vector3())!;
    };
    controls.setPointerBlocked(true);
    const before = dragPoint();
    const d0 = camera.position.distanceTo(before);
    for (let i = 0; i < 4; i++) {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, deltaMode: 0, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
      // The surface re-runs the preview on each camera frame; every frame's answer stays on the same spot.
      for (let f = 0; f < 6; f++) {
        controls.update(1 / 60);
        camera.updateMatrixWorld();
        expect(dragPoint().distanceTo(before)).toBeLessThan(0.02);
      }
    }
    settle(controls, camera);
    expect(camera.position.distanceTo(before)).toBeLessThan(d0 * 0.6);
    expect(dragPoint().distanceTo(before)).toBeLessThan(1e-3);
    expect(controls.pointerBlocked).toBe(true);
  });

  it("the camera orbits again after release, with the buttons it had (plan keeps truck on the left button)", () => {
    const { el, camera, controls } = rig();
    controls.mouseButtons.left = CameraControls.ACTION.TRUCK;
    controls.setPointerBlocked(true);
    expect(controls.mouseButtons.left).toBe(CameraControls.ACTION.NONE);
    controls.setPointerBlocked(false);
    expect(controls.mouseButtons.left).toBe(CameraControls.ACTION.TRUCK);
    controls.mouseButtons.left = CameraControls.ACTION.ROTATE;
    const before = camera.quaternion.clone();
    orbitDrag(el, controls);
    settle(controls, camera);
    expect(camera.quaternion.angleTo(before)).toBeGreaterThan(0.01);
  });
});
