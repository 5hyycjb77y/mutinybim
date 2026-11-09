/**
 * @jest-environment jsdom
 */
import * as THREE from "three";
import CameraControls from "camera-controls";
import { makeCameraControls } from "../src/navigation";
import { chooseOrbitPivot } from "../src/origin-gizmo";

function element(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

const perspective = () => new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 5000);
const ortho = () => new THREE.OrthographicCamera(-50, 50, 50, -50, -5000, 5000);

function settle(controls: CameraControls) {
  for (let i = 0; i < 200; i++) controls.update(1 / 30);
}

/** A wheel notch with the pointer far from the centre of the view. */
function wheelAtCorner(el: HTMLElement, deltaY = -100) {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, clientX: 760, clientY: 40, bubbles: true, cancelable: true }));
}

const target = (c: CameraControls) => c.getTarget(new THREE.Vector3());

describe.each([
  ["3D perspective", perspective, [40, 30, 40]],
  ["3D orthographic", ortho, [40, 30, 40]],
  // Plan looks straight down (a hair off vertical so the up vector stays defined).
  ["plan", ortho, [5, 200, -2.999]],
] as const)("%s camera controls", (_name, camera, eye) => {
  it("our handler owns the wheel; camera-controls' own wheel and target-depth cursor dolly stay off", () => {
    const controls = makeCameraControls(camera(), element());
    expect(controls.mouseButtons.wheel).toBe(CameraControls.ACTION.NONE);
    expect(controls.dollyToCursor).toBe(false);
    expect(controls.infinityDolly).toBe(false);
  });

  it("setting the orbit point moves only the target; the next wheel zooms toward what is under the pointer", () => {
    const el = element();
    const cam = camera();
    const controls = makeCameraControls(cam, el);
    void controls.setLookAt(eye[0], eye[1], eye[2], 0, 0, 0, false);
    settle(controls);
    const before = cam.position.clone();
    const beforeQuat = cam.quaternion.clone();
    const pivot = new THREE.Vector3(5, 1, -3);
    controls.setOrbitPoint(pivot.x, pivot.y, pivot.z);
    settle(controls);
    expect(cam.position.distanceTo(before)).toBeLessThan(1e-6);
    expect(cam.quaternion.angleTo(beforeQuat)).toBeLessThan(1e-6);
    expect(target(controls).distanceTo(pivot)).toBeLessThan(1e-6);
    wheelAtCorner(el);
    settle(controls);
    // The orbit point moved to the pointer's corner (on the plane through the old one, facing the camera).
    expect(target(controls).distanceTo(pivot)).toBeGreaterThan(1);
    const offset = target(controls).sub(pivot);
    expect(Math.abs(offset.dot(cam.getWorldDirection(new THREE.Vector3())))).toBeLessThan(1e-6);
  });

  it("with the pointer over the middle of the model, the wheel zooms about it", () => {
    const el = element();
    const cam = camera();
    const controls = makeCameraControls(cam, el);
    void controls.setLookAt(eye[0], eye[1], eye[2], 0, 0, 0, false);
    settle(controls);
    const model = new THREE.Box3(new THREE.Vector3(10, 0, -40), new THREE.Vector3(30, 12, -20));
    const middle = chooseOrbitPivot(null, model, new THREE.Vector3());
    controls.setOrbitPoint(middle.x, middle.y, middle.z);
    settle(controls);
    cam.updateMatrixWorld();
    const p = middle.clone().project(cam);
    const at = { x: ((p.x + 1) / 2) * 800, y: ((1 - p.y) / 2) * 600 };
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
    settle(controls);
    expect(target(controls).distanceTo(middle)).toBeLessThan(1e-4);
  });
});
