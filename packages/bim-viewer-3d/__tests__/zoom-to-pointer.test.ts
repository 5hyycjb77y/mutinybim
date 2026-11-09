/**
 * @jest-environment jsdom
 */
import * as THREE from "three";
import { makeCameraControls, pinOrbitPoint, wheelScale, zoomFloorFor, type PointZoomControls, type ZoomAnchorSource } from "../src/navigation";

const W = 800;
const H = 600;

function element(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: W, height: H, right: W, bottom: H, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

type Make = () => THREE.PerspectiveCamera | THREE.OrthographicCamera;
const perspective: Make = () => new THREE.PerspectiveCamera(45, W / H, 0.1, 5000);
const ortho: Make = () => new THREE.OrthographicCamera(-50 * (W / H), 50 * (W / H), 50, -50, -5000, 5000);

function settle(controls: PointZoomControls, camera: THREE.Camera) {
  for (let i = 0; i < 300; i++) controls.update(1 / 30);
  camera.updateMatrixWorld();
}

function wheel(el: HTMLElement, deltaY: number, at: { x: number; y: number }) {
  el.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
}

const target = (c: PointZoomControls) => c.getTarget(new THREE.Vector3());

/** Where a scene point is on the canvas, px. */
function pixelOf(point: THREE.Vector3, camera: THREE.Camera): { x: number; y: number } {
  const p = point.clone().project(camera);
  return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H };
}

function rayAt(camera: THREE.Camera, at: { x: number; y: number }): THREE.Ray {
  const r = new THREE.Raycaster();
  r.setFromCamera(new THREE.Vector2((at.x / W) * 2 - 1, -(at.y / H) * 2 + 1), camera);
  return r.ray.clone();
}

/** The model is a floor slab at y = 0: the pointer's hit is where its ray meets it. */
const floorHit: ZoomAnchorSource = ({ ray }) => ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());

const CAMERAS = [
  ["perspective", perspective, [40, 30, 40]],
  ["orthographic", ortho, [40, 30, 40]],
  // Plan looks straight down (a hair off vertical so the up vector stays defined).
  ["plan", ortho, [5, 200, -2.999]],
] as const;

function rig(make: Make, eye: readonly [number, number, number], anchor: ZoomAnchorSource | null = floorHit) {
  const el = element();
  const camera = make();
  const controls = makeCameraControls(camera, el);
  controls.zoomAnchor = anchor;
  void controls.setLookAt(eye[0], eye[1], eye[2], 0, 0, 0, false);
  settle(controls, camera);
  return { el, camera, controls };
}

const CORNER = { x: 640, y: 150 };

describe.each(CAMERAS)("wheel zoom toward the pointer (%s)", (_name, make, eye) => {
  it("where the pointer is decides where the wheel zooms", () => {
    const ends = [
      { x: 120, y: 480 },
      { x: 700, y: 120 },
    ].map((at) => {
      const { el, camera, controls } = rig(make, eye);
      for (let i = 0; i < 4; i++) wheel(el, -120, at);
      settle(controls, camera);
      return { position: camera.position.clone(), target: target(controls) };
    });
    // On main the wheel ignored the pointer, so both of these landed in the same place.
    expect(ends[0]!.position.distanceTo(ends[1]!.position)).toBeGreaterThan(1);
    expect(ends[0]!.target.distanceTo(ends[1]!.target)).toBeGreaterThan(1);
  });

  it("the model point under the pointer stays on its pixel, zooming in and back out", () => {
    const { el, camera, controls } = rig(make, eye);
    const point = floorHit({ ray: rayAt(camera, CORNER), camera, clientX: CORNER.x, clientY: CORNER.y })!;
    const before = pixelOf(point, camera);
    expect(Math.hypot(before.x - CORNER.x, before.y - CORNER.y)).toBeLessThan(1e-3);
    const scaleBefore = camera instanceof THREE.PerspectiveCamera ? camera.position.distanceTo(point) : 1 / camera.zoom;
    for (let i = 0; i < 5; i++) wheel(el, -120, CORNER);
    settle(controls, camera);
    const inward = pixelOf(point, camera);
    expect(Math.hypot(inward.x - CORNER.x, inward.y - CORNER.y)).toBeLessThan(0.05);
    const scaleIn = camera instanceof THREE.PerspectiveCamera ? camera.position.distanceTo(point) : 1 / camera.zoom;
    expect(scaleIn).toBeLessThan(scaleBefore * 0.7);
    for (let i = 0; i < 5; i++) wheel(el, 120, CORNER);
    settle(controls, camera);
    const outward = pixelOf(point, camera);
    expect(Math.hypot(outward.x - CORNER.x, outward.y - CORNER.y)).toBeLessThan(0.05);
  });

  it("the point zoomed toward becomes the orbit point; the view does not turn", () => {
    const { el, camera, controls } = rig(make, eye);
    const aim = camera.quaternion.clone();
    const point = floorHit({ ray: rayAt(camera, CORNER), camera, clientX: CORNER.x, clientY: CORNER.y })!;
    let told: THREE.Vector3 | null = null;
    controls.onZoomAnchor = (p) => (told = p);
    wheel(el, -120, CORNER);
    settle(controls, camera);
    expect(target(controls).distanceTo(point)).toBeLessThan(1e-6);
    expect(told).not.toBeNull();
    expect(told!.distanceTo(point)).toBeLessThan(1e-6);
    expect(camera.quaternion.angleTo(aim)).toBeLessThan(1e-6);
  });

  it("the pointer's own ray does not move, so a drag on a plane under a still pointer stays put", () => {
    const { el, camera, controls } = rig(make, eye);
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -2.4);
    const before = rayAt(camera, CORNER).intersectPlane(dragPlane, new THREE.Vector3())!;
    for (let i = 0; i < 6; i++) {
      wheel(el, i < 4 ? -120 : 80, CORNER);
      controls.update(1 / 60);
    }
    settle(controls, camera);
    const after = rayAt(camera, CORNER).intersectPlane(dragPlane, new THREE.Vector3())!;
    expect(after.distanceTo(before)).toBeLessThan(1e-3);
  });

  it("a run of wheel events while the view is still gliding ends with the point on its pixel", () => {
    const { el, camera, controls } = rig(make, eye);
    const point = floorHit({ ray: rayAt(camera, CORNER), camera, clientX: CORNER.x, clientY: CORNER.y })!;
    for (let i = 0; i < 12; i++) {
      wheel(el, -40, CORNER);
      controls.update(1 / 60);
      controls.update(1 / 60);
    }
    settle(controls, camera);
    const at = pixelOf(point, camera);
    expect(Math.hypot(at.x - CORNER.x, at.y - CORNER.y)).toBeLessThan(0.05);
  });

  it("over empty space, zooms toward the plane through the orbit point facing the camera", () => {
    const { el, camera, controls } = rig(make, eye, () => null);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(forward, new THREE.Vector3(0, 0, 0));
    const point = rayAt(camera, CORNER).intersectPlane(plane, new THREE.Vector3())!;
    for (let i = 0; i < 3; i++) wheel(el, -120, CORNER);
    settle(controls, camera);
    expect(target(controls).distanceTo(point)).toBeLessThan(1e-6);
    const at = pixelOf(point, camera);
    expect(Math.hypot(at.x - CORNER.x, at.y - CORNER.y)).toBeLessThan(0.05);
  });
});

describe("perspective pass-through", () => {
  it("near the point, zooming in carries on along the pointer's ray instead of stalling", () => {
    const { el, camera, controls } = rig(perspective, [40, 30, 40]);
    controls.zoomFloor = 1;
    const ray = rayAt(camera, CORNER);
    const point = floorHit({ ray, camera, clientX: CORNER.x, clientY: CORNER.y })!;
    const start = camera.position.clone();
    // Empty space beyond the floor once through it.
    controls.zoomAnchor = (q) => {
      const hit = floorHit(q);
      return hit && hit.clone().sub(q.camera.position).dot(q.camera.getWorldDirection(new THREE.Vector3())) > 0.1 ? hit : null;
    };
    for (let i = 0; i < 120; i++) wheel(el, -120, CORNER);
    settle(controls, camera);
    // Through the floor: the camera is below it now.
    expect(camera.position.y).toBeLessThan(0);
    expect(camera.position.distanceTo(start)).toBeGreaterThan(start.distanceTo(point));
    // It travelled down the pointer's ray, not toward the middle of the view.
    expect(camera.position.clone().sub(start).normalize().angleTo(ray.direction)).toBeLessThan(1e-3);
  });

  it("remembers where the eye was before it went through the surface, and steps back out only when asked", () => {
    const { el, camera, controls } = rig(perspective, [40, 30, 40]);
    controls.zoomFloor = 1;
    controls.zoomAnchor = (q) => {
      const hit = floorHit(q);
      return hit && hit.clone().sub(q.camera.position).dot(q.camera.getWorldDirection(new THREE.Vector3())) > 0.1 ? hit : null;
    };
    const told = jest.fn();
    controls.onPassThrough = told;
    for (let i = 0; i < 120; i++) wheel(el, -120, CORNER);
    settle(controls, camera);
    // It still passes through (it never stops at the surface) ...
    expect(camera.position.y).toBeLessThan(0);
    // ... and says so once, not on every notch after.
    expect(told).toHaveBeenCalledTimes(1);
    expect(controls.passedThrough()).toBe(true);
    // Nothing moved the eye back on its own.
    expect(camera.position.y).toBeLessThan(0);
    expect(controls.stepBackOut()).toBe(true);
    settle(controls, camera);
    expect(camera.position.y).toBeGreaterThan(0);
    expect(controls.passedThrough()).toBe(false);
    expect(controls.stepBackOut()).toBe(false);
  });

  it("zooming toward empty space never counts as going through a surface", () => {
    const { el, camera, controls } = rig(perspective, [40, 30, 40], () => null);
    controls.zoomFloor = 1;
    const told = jest.fn();
    controls.onPassThrough = told;
    for (let i = 0; i < 80; i++) wheel(el, -120, CORNER);
    settle(controls, camera);
    expect(told).not.toHaveBeenCalled();
  });

  it("each pass-through step is a steady stride, not a shrinking one", () => {
    const { el, camera, controls } = rig(perspective, [40, 30, 40], () => null);
    controls.zoomFloor = 1;
    for (let i = 0; i < 40; i++) wheel(el, -120, CORNER);
    settle(controls, camera);
    const a = camera.position.clone();
    wheel(el, -120, CORNER);
    settle(controls, camera);
    const b = camera.position.clone();
    wheel(el, -120, CORNER);
    settle(controls, camera);
    const c = camera.position.clone();
    expect(a.distanceTo(b)).toBeGreaterThan(0.1);
    expect(Math.abs(b.distanceTo(c) - a.distanceTo(b))).toBeLessThan(1e-3);
  });

  it("ignores a hit behind the camera and uses the plane instead", () => {
    const { el, camera, controls } = rig(perspective, [40, 30, 40], () => new THREE.Vector3(80, 60, 80));
    wheel(el, -120, CORNER);
    settle(controls, camera);
    expect(target(controls).distanceTo(new THREE.Vector3(80, 60, 80))).toBeGreaterThan(10);
  });
});

describe("setting the orbit point", () => {
  it.each([
    ["perspective", perspective],
    ["orthographic", ortho],
  ] as const)("only moves the orbit target; the camera does not move, turn or zoom (%s)", (_name, make) => {
    const { camera, controls } = rig(make, [40, 30, 40]);
    const position = camera.position.clone();
    const aim = camera.quaternion.clone();
    const zoom = camera.zoom;
    const point = new THREE.Vector3(-7, 4, 9);
    pinOrbitPoint(controls, point);
    settle(controls, camera);
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-6);
    expect(camera.quaternion.angleTo(aim)).toBeLessThan(1e-6);
    expect(camera.zoom).toBeCloseTo(zoom, 9);
    expect(target(controls).distanceTo(point)).toBeLessThan(1e-6);
  });
});

describe("wheelScale", () => {
  it("is exponential: in then out by the same notch lands back where it started", () => {
    expect(wheelScale({ deltaY: -100, deltaMode: 0, ctrlKey: false }) * wheelScale({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeCloseTo(1, 12);
    expect(wheelScale({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeLessThan(1);
  });

  it("gives a trackpad pinch's small deltas a usable step and caps a huge event", () => {
    const pinch = wheelScale({ deltaY: -4, deltaMode: 0, ctrlKey: true });
    expect(pinch).toBeLessThan(0.97);
    expect(pinch).toBeGreaterThan(0.9);
    expect(wheelScale({ deltaY: -10000, deltaMode: 0, ctrlKey: false })).toBeCloseTo(Math.exp(-0.2), 12);
    expect(wheelScale({ deltaY: -3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(wheelScale({ deltaY: -48, deltaMode: 0, ctrlKey: false }), 12);
  });
});

describe("zoomFloorFor", () => {
  it("scales with the model, within 0.3 to 3 m", () => {
    expect(zoomFloorFor(new THREE.Box3())).toBe(1);
    expect(zoomFloorFor(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1)))).toBe(0.3);
    expect(zoomFloorFor(new THREE.Box3(new THREE.Vector3(-60, 0, -60), new THREE.Vector3(60, 10, 60)))).toBeCloseTo(0.85, 1);
    expect(zoomFloorFor(new THREE.Box3(new THREE.Vector3(-1000, 0, -1000), new THREE.Vector3(1000, 10, 1000)))).toBe(3);
  });
});
