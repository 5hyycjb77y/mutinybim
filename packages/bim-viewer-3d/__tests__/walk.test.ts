/**
 * @jest-environment jsdom
 */
import * as THREE from "three";
import { makeCameraControls, type PointZoomControls } from "../src/navigation";
import { releaseWalkOnBlur, WalkMotion, walkSpeedFor } from "../src/walk";
import { walkKeyOf, WALK_START_CODE } from "../src/walk-keys";
import { ModelViewer3D } from "../src/viewer";

function element(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

const DEG = THREE.MathUtils.degToRad;
const EYE = new THREE.Vector3(6, 4, 8);
const target = (c: PointZoomControls) => c.getTarget(new THREE.Vector3());
const aim = (camera: THREE.PerspectiveCamera) => camera.getWorldDirection(new THREE.Vector3());

function settle(controls: PointZoomControls) {
  for (let i = 0; i < 200; i++) controls.update(1 / 30);
}

/** The eye 10.8 m from the origin, above it and to the south-east, looking at it. */
function rig() {
  const el = element();
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 5000);
  const controls = makeCameraControls(camera, el);
  void controls.setLookAt(EYE.x, EYE.y, EYE.z, 0, 0, 0, false);
  controls.update(0);
  return { el, camera, controls };
}

/** A mouse pointer event as camera-controls reads it (jsdom has no PointerEvent constructor). */
function pointer(target: EventTarget, type: "pointerdown" | "pointermove" | "pointerup", x: number, y: number, buttons: number) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

/** Press, ten moves 20 px apart (a frame between each), release. The controls' own easing is left to settle. */
function dragSteps(el: HTMLElement, controls: PointZoomControls, each: () => void) {
  pointer(el, "pointerdown", 400, 300, 1);
  for (let i = 1; i <= 10; i++) {
    controls.update(1 / 60);
    each();
    pointer(document, "pointermove", 400 + i * 20, 300, 1);
  }
  pointer(document, "pointerup", 600, 300, 0);
  for (let i = 0; i < 200; i++) {
    controls.update(1 / 60);
    each();
  }
}

/** The farthest the eye got from `eye` over a drag and its settling, measured once each frame has landed. */
function eyeTravel(el: HTMLElement, controls: PointZoomControls, eye: THREE.Vector3): number {
  let far = 0;
  dragSteps(el, controls, () => void (far = Math.max(far, controls.camera.position.distanceTo(eye))));
  return far;
}

describe("the walk keys", () => {
  it("are W A S D, E and Q by physical key, and W is the one that starts a walk", () => {
    expect(walkKeyOf("KeyW")).toBe("forward");
    expect(walkKeyOf("KeyS")).toBe("back");
    expect(walkKeyOf("KeyA")).toBe("left");
    expect(walkKeyOf("KeyD")).toBe("right");
    expect(walkKeyOf("KeyE")).toBe("up");
    expect(walkKeyOf("KeyQ")).toBe("down");
    expect(walkKeyOf("KeyR")).toBeNull();
    expect(walkKeyOf("ShiftLeft")).toBeNull();
    expect(walkKeyOf(WALK_START_CODE)).toBe("forward");
  });

  it("reach the orbit point in two seconds from any distance, between a stroll and a site-crossing pace", () => {
    expect(walkSpeedFor(1)).toBe(1.5);
    expect(walkSpeedFor(3)).toBe(1.5);
    expect(walkSpeedFor(20)).toBe(10);
    expect(walkSpeedFor(2000)).toBe(200);
  });
});

describe("walking moves the eye and the orbit point together", () => {
  it("a step carries both by the same distance; the aim does not change", () => {
    const { camera, controls } = rig();
    const before = aim(camera);
    const step = new THREE.Vector3(0.5, 0, 2);
    controls.walkBy(step);
    controls.update(1 / 30);
    expect(camera.position.distanceTo(EYE.clone().add(step))).toBeLessThan(1e-9);
    expect(target(controls).distanceTo(step)).toBeLessThan(1e-9);
    expect(aim(camera).angleTo(before)).toBeLessThan(1e-9);
  });

  it("a step wakes the controls, and the view is awake until the step's last frame (overlays follow it)", () => {
    const { controls } = rig();
    // The framing goes to sleep first.
    controls.update(1 / 30);
    const events: string[] = [];
    for (const type of ["wake", "update", "rest", "sleep"] as const) controls.addEventListener(type, () => events.push(type));
    controls.walkBy(new THREE.Vector3(0, 0, 1));
    controls.update(1 / 30);
    controls.update(1 / 30);
    expect(events).toEqual(["wake", "update", "sleep"]);
  });

  it("an empty step is nothing", () => {
    const { controls } = rig();
    controls.walkBy(new THREE.Vector3());
    expect(controls.update(1 / 30)).toBe(false);
  });
});

describe("while walking, a turn keeps the eye where it is", () => {
  it("a drag turns the view on the spot: the eye never travels, and the orbit point stays as far ahead", () => {
    const { el, camera, controls } = rig();
    const before = aim(camera);
    const radius = camera.position.distanceTo(target(controls));
    controls.walking = true;
    controls.update(0);
    expect(eyeTravel(el, controls, EYE)).toBeLessThan(1e-9);
    expect(aim(camera).angleTo(before)).toBeGreaterThan(DEG(20));
    expect(camera.position.distanceTo(target(controls))).toBeCloseTo(radius, 9);
  });

  it("the orientation ball and the preset views (rotate, rotateTo) turn on the spot too, through their easing", () => {
    const { camera, controls } = rig();
    controls.walking = true;
    controls.update(0);
    const before = aim(camera);
    void controls.rotate(DEG(35), DEG(-10), true);
    void controls.rotateTo(DEG(120), DEG(60), true);
    let far = 0;
    for (let i = 0; i < 120; i++) {
      controls.update(1 / 60);
      far = Math.max(far, camera.position.distanceTo(EYE));
    }
    expect(far).toBeLessThan(1e-9);
    expect(aim(camera).angleTo(before)).toBeGreaterThan(DEG(60));
  });

  it("a step taken in the same frame as a turn moves the eye, by the step and nothing more", () => {
    const { camera, controls } = rig();
    controls.walking = true;
    controls.update(0);
    const step = new THREE.Vector3(0, 0, 1.5);
    void controls.rotate(DEG(30), 0, true);
    controls.walkBy(step);
    controls.update(1 / 30);
    expect(camera.position.distanceTo(EYE.clone().add(step))).toBeLessThan(1e-9);
  });

  it("steps taken during a drag each move the eye exactly one step; the drag adds no travel of its own", () => {
    const { el, camera, controls } = rig();
    controls.walking = true;
    controls.update(0);
    const step = aim(camera).setY(0).normalize().multiplyScalar(0.1);
    let steps = 0;
    dragSteps(el, controls, () => {
      if (steps < 20) {
        controls.walkBy(step);
        steps += 1;
      }
    });
    expect(aim(camera).angleTo(step)).toBeGreaterThan(DEG(20));
    expect(camera.position.distanceTo(EYE.clone().addScaledVector(step, steps))).toBeLessThan(1e-9);
  });
});

describe("while walking, everything that is not a turn still moves the eye", () => {
  it("the eye told where to go (Home, a saved view) goes there", () => {
    const { camera, controls } = rig();
    controls.walking = true;
    controls.update(0);
    void controls.setLookAt(40, 30, 40, 0, 0, 0, false);
    controls.update(1 / 30);
    expect(camera.position.distanceTo(new THREE.Vector3(40, 30, 40))).toBeLessThan(1e-6);
  });

  it("it eases there too: a requested pose is not held back frame by frame", () => {
    const { camera, controls } = rig();
    controls.walking = true;
    controls.update(0);
    void controls.setLookAt(40, 30, 40, 0, 0, 0, true);
    settle(controls);
    expect(camera.position.distanceTo(new THREE.Vector3(40, 30, 40))).toBeLessThan(1e-6);
  });

  it("a new orbit point (a click, the middle of the model) does not drag the eye", () => {
    const { camera, controls } = rig();
    controls.walking = true;
    controls.update(0);
    const before = aim(camera);
    controls.setOrbitPoint(5, 1, -3);
    controls.update(1 / 30);
    expect(camera.position.distanceTo(EYE)).toBeLessThan(1e-9);
    expect(aim(camera).angleTo(before)).toBeLessThan(1e-9);
    expect(target(controls).distanceTo(new THREE.Vector3(5, 1, -3))).toBeLessThan(1e-9);
  });

  it("a zoom still dollies toward the point under the pointer", () => {
    const { el, camera, controls } = rig();
    controls.walking = true;
    controls.update(0);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
    settle(controls);
    expect(camera.position.distanceTo(target(controls))).toBeLessThan(EYE.length() - 1);
  });
});

describe("once the walk is off", () => {
  it("a drag swings the eye round the orbit point, as before", () => {
    const { el, controls } = rig();
    controls.walking = true;
    controls.update(0);
    controls.walking = false;
    expect(eyeTravel(el, controls, EYE)).toBeGreaterThan(1);
  });

  it("the orbit point is as far ahead of the eye as when the walk began", () => {
    const { el, camera, controls } = rig();
    const radius = camera.position.distanceTo(target(controls));
    controls.walking = true;
    controls.update(0);
    eyeTravel(el, controls, EYE);
    controls.walkBy(new THREE.Vector3(3, 0, 3));
    controls.update(1 / 30);
    controls.walking = false;
    expect(camera.position.distanceTo(target(controls))).toBeCloseTo(radius, 9);
  });
});

describe("WalkMotion", () => {
  const forward = new THREE.Vector3(0, 0, -1);
  const right = new THREE.Vector3(1, 0, 0);
  const out = new THREE.Vector3();
  // Orbit point 4 m away: 4 m in 2 seconds.
  const RADIUS = 4;
  const SPEED = 2;

  function run(motion: WalkMotion, seconds: number): THREE.Vector3 {
    const total = new THREE.Vector3();
    for (let t = 0; t < seconds; t += 1 / 60) total.add(motion.step(1 / 60, forward, right, RADIUS, out));
    return total;
  }

  it("W goes the way the view faces, S back, A and D sideways, E up and Q down", () => {
    const cases: [string, THREE.Vector3][] = [
      ["KeyW", forward],
      ["KeyS", forward.clone().negate()],
      ["KeyA", right.clone().negate()],
      ["KeyD", right],
      ["KeyE", new THREE.Vector3(0, 1, 0)],
      ["KeyQ", new THREE.Vector3(0, -1, 0)],
    ];
    for (const [code, way] of cases) {
      const motion = new WalkMotion();
      const key = walkKeyOf(code);
      if (!key) throw new Error(`${code} is not a walk key`);
      motion.hold(key);
      const went = run(motion, 10);
      expect(went.clone().normalize().distanceTo(way)).toBeLessThan(1e-9);
      expect(went.length()).toBeGreaterThan(SPEED * 9);
    }
  });

  it("forward and right together go the same speed as forward alone", () => {
    const straight = new WalkMotion();
    straight.hold("forward");
    const diagonal = new WalkMotion();
    diagonal.hold("forward");
    diagonal.hold("right");
    for (let i = 0; i < 60; i++) {
      const a = straight.step(1 / 60, forward, right, RADIUS, out).length();
      const b = diagonal.step(1 / 60, forward, right, RADIUS, out).length();
      expect(b).toBeCloseTo(a, 12);
    }
  });

  it("eases in, and eases to a stop once the keys come up; then it rests", () => {
    const motion = new WalkMotion();
    motion.hold("forward");
    const first = motion.step(1 / 60, forward, right, RADIUS, out).length();
    const sixth = motion.step(1 / 60, forward, right, RADIUS, out).length();
    expect(first).toBeGreaterThan(0);
    expect(sixth).toBeGreaterThan(first);
    expect(sixth).toBeLessThan(SPEED / 60);
    motion.releaseAll();
    const after = run(motion, 1);
    expect(after.length()).toBeGreaterThan(0);
    expect(after.length()).toBeLessThan(SPEED * 0.3);
    expect(motion.resting).toBe(true);
    expect(motion.step(1 / 60, forward, right, RADIUS, out).length()).toBe(0);
  });

  it("stops at once when told, with a key held or not", () => {
    const motion = new WalkMotion();
    motion.hold("forward");
    run(motion, 1);
    motion.stop();
    expect(motion.resting).toBe(true);
    expect(motion.step(1 / 60, forward, right, RADIUS, out).length()).toBe(0);
  });

  it("the pace multiplier scales every step", () => {
    const one = new WalkMotion();
    one.hold("forward");
    const two = new WalkMotion();
    two.speedScale = 2;
    two.hold("forward");
    let a = 0;
    let b = 0;
    for (let t = 0; t < 10; t += 1 / 60) {
      a += one.step(1 / 60, forward, right, RADIUS, out).length();
      b += two.step(1 / 60, forward, right, RADIUS, out).length();
    }
    expect(b).toBeCloseTo(a * 2, 6);
  });
});

describe("the walk's pace", () => {
  it("setWalkSpeed clamps to a tenth to ten times, reads back, and tells its listeners; the same value is not news", () => {
    const { viewer: w } = viewer();
    const heard: number[] = [];
    w.onWalkSpeedChange((scale) => heard.push(scale));
    w.setWalkSpeed(50);
    expect(w.walkSpeed()).toBe(10);
    w.setWalkSpeed(0.001);
    expect(w.walkSpeed()).toBe(0.1);
    w.setWalkSpeed(2.5);
    expect(w.walkSpeed()).toBe(2.5);
    expect(heard).toEqual([10, 0.1, 2.5]);
    w.setWalkSpeed(2.5);
    expect(heard).toEqual([10, 0.1, 2.5]);
  });

  it("the pace outlasts the walk itself", () => {
    const { viewer: w } = viewer();
    w.setWalk(true);
    w.setWalkSpeed(3);
    w.setWalk(false);
    w.setWalk(true);
    expect(w.walkSpeed()).toBe(3);
  });

  it("a quarter pace covers a quarter of the ground in the same frames", () => {
    const slow = viewer();
    slow.viewer.setWalk(true);
    slow.viewer.setWalkSpeed(0.25);
    slow.viewer.walkKey("KeyW", true);
    const brisk = viewer();
    brisk.viewer.setWalk(true);
    brisk.viewer.walkKey("KeyW", true);
    frames(slow.viewer, slow.controls, 1);
    frames(brisk.viewer, brisk.controls, 1);
    const dSlow = slow.camera.position.distanceTo(EYE);
    const dBrisk = brisk.camera.position.distanceTo(EYE);
    expect(dSlow).toBeGreaterThan(0.5);
    expect(dSlow).toBeCloseTo(dBrisk / 4, 2);
  });
});

describe("the pace wheel (right-button + scroll) while walking", () => {
  function notch(el: HTMLElement, deltaY: number, buttons: number) {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, buttons, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
  }

  function paceRig() {
    const { el, camera, controls } = rig();
    const heard: (1 | -1)[] = [];
    controls.onWalkSpeed = (direction) => heard.push(direction);
    controls.walking = true;
    controls.update(0);
    return { el, camera, controls, heard };
  }

  it("a notch with the right button held turns the pace, and does not zoom", () => {
    const { el, camera, heard } = paceRig();
    notch(el, -100, 2);
    notch(el, -100, 2);
    expect(heard).toEqual([1, 1]);
    expect(camera.position.distanceTo(EYE)).toBeLessThan(1e-9);
    notch(el, 100, 2);
    expect(heard).toEqual([1, 1, -1]);
  });

  it("the wheel alone still zooms toward the pointer, and the pace stands", () => {
    const { el, camera, controls, heard } = paceRig();
    const radius = camera.position.distanceTo(target(controls));
    notch(el, -100, 0);
    settle(controls);
    expect(heard).toEqual([]);
    expect(camera.position.distanceTo(target(controls))).toBeLessThan(radius - 1);
  });

  it("not walking, the right-button wheel zooms as always and nobody hears a pace", () => {
    const { el, camera, controls } = rig();
    const heard: (1 | -1)[] = [];
    controls.onWalkSpeed = (direction) => heard.push(direction);
    const radius = camera.position.distanceTo(target(controls));
    notch(el, -100, 2);
    settle(controls);
    expect(heard).toEqual([]);
    expect(camera.position.distanceTo(target(controls))).toBeLessThan(radius - 1);
  });

  it("walking switched off, the right-button wheel zooms again", () => {
    const { el, camera, controls, heard } = paceRig();
    controls.walking = false;
    const radius = camera.position.distanceTo(target(controls));
    notch(el, -100, 2);
    settle(controls);
    expect(heard).toEqual([]);
    expect(camera.position.distanceTo(target(controls))).toBeLessThan(radius - 1);
  });
});

/** The viewer's walk methods over real controls (no WebGL renderer is needed to walk). */
interface Walker {
  setWalk(on: boolean): void;
  walking(): boolean;
  walkKey(code: string, down: boolean): boolean;
  onWalkChange(listener: (walking: boolean) => void): () => void;
  setWalkSpeed(scale: number): void;
  walkSpeed(): number;
  onWalkSpeedChange(listener: (scale: number) => void): () => void;
  claimCameraMode(id: string, onStop: () => void): () => void;
  cameraMode(): string | null;
  releaseCameraMode(): void;
  onCameraModeChange(listener: (mode: string | null) => void): () => void;
  setPaused(paused: boolean): void;
  releaseWalkKeys(): void;
  stepWalk(delta: number): void;
}

function viewer(opts: { mode?: "3d" | "plan"; projection?: "perspective" | "orthographic" } = {}): { viewer: Walker; camera: THREE.PerspectiveCamera; controls: PointZoomControls } {
  const { camera, controls } = rig();
  // The constructor's own fields, for the real methods to run on.
  const shell: Record<string, unknown> = Object.create(ModelViewer3D.prototype);
  Object.assign(shell, {
    mode: opts.mode ?? "3d",
    projection: opts.projection ?? "perspective",
    paused: false,
    disposed: false,
    contextLost: false,
    perspective: camera,
    controls,
    clock: new THREE.Clock(),
    renderer: { setAnimationLoop: () => {} },
    walkOn: false,
    walk: new WalkMotion(),
    walkListeners: new Set<(walking: boolean) => void>(),
    walkSpeedListeners: new Set<(scale: number) => void>(),
    activeCameraMode: null,
    cameraModeListeners: new Set<(mode: string | null) => void>(),
    releaseWalkMode: null,
    walkStep: new THREE.Vector3(),
    walkForward: new THREE.Vector3(),
    walkRight: new THREE.Vector3(),
  });
  return { viewer: shell as unknown as Walker, camera, controls };
}

function frames(w: Walker, controls: PointZoomControls, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    w.stepWalk(1 / 60);
    controls.update(1 / 60);
  }
}

describe("ModelViewer3D walking", () => {
  it("off: a walk key is recognised but not held, and nothing moves", () => {
    const { viewer: w, camera, controls } = viewer();
    expect(w.walking()).toBe(false);
    expect(w.walkKey("KeyW", true)).toBe(true);
    frames(w, controls, 1);
    expect(camera.position.distanceTo(EYE)).toBe(0);
  });

  it("on: W walks forward along the ground, the way the view faces", () => {
    const { viewer: w, camera, controls } = viewer();
    const facing = aim(camera).setY(0).normalize();
    w.setWalk(true);
    expect(w.walking()).toBe(true);
    expect(controls.walking).toBe(true);
    w.walkKey("KeyW", true);
    frames(w, controls, 1);
    const went = camera.position.clone().sub(EYE);
    expect(Math.abs(went.y)).toBeLessThan(1e-9);
    expect(went.clone().normalize().distanceTo(facing)).toBeLessThan(1e-6);
    // The orbit point is 10.8 m away: 5.4 m/s, a touch under for the ease-in.
    expect(went.length()).toBeGreaterThan(4);
    expect(went.length()).toBeLessThan(5.4);
  });

  it("E rises and Q sinks; the eye goes straight up and down", () => {
    const { viewer: w, camera, controls } = viewer();
    w.setWalk(true);
    const before = aim(camera);
    w.walkKey("KeyE", true);
    frames(w, controls, 1);
    expect(camera.position.y - EYE.y).toBeGreaterThan(4);
    w.walkKey("KeyE", false);
    w.walkKey("KeyQ", true);
    frames(w, controls, 2);
    expect(camera.position.y - EYE.y).toBeLessThan(-4);
    expect(camera.position.x).toBeCloseTo(EYE.x, 9);
    expect(camera.position.z).toBeCloseTo(EYE.z, 9);
    expect(aim(camera).angleTo(before)).toBeLessThan(1e-9);
  });

  it("a key that is not a walk key is refused and changes nothing", () => {
    const { viewer: w, camera, controls } = viewer();
    w.setWalk(true);
    expect(w.walkKey("KeyR", true)).toBe(false);
    expect(w.walkKey("ShiftLeft", true)).toBe(false);
    frames(w, controls, 1);
    expect(camera.position.distanceTo(EYE)).toBe(0);
  });

  it("ending the walk lets the keys go and tells the listeners; the camera eases to a stop and then holds", () => {
    const { viewer: w, camera, controls } = viewer();
    const heard: boolean[] = [];
    const off = w.onWalkChange((on) => heard.push(on));
    w.setWalk(true);
    w.walkKey("KeyW", true);
    frames(w, controls, 1);
    w.setWalk(false);
    expect(w.walking()).toBe(false);
    expect(controls.walking).toBe(false);
    frames(w, controls, 1);
    const rested = camera.position.clone();
    frames(w, controls, 2);
    expect(camera.position.distanceTo(rested)).toBe(0);
    off();
    w.setWalk(true);
    expect(heard).toEqual([true, false]);
  });

  it("the same request twice is not news", () => {
    const { viewer: w } = viewer();
    const heard: boolean[] = [];
    w.onWalkChange((on) => heard.push(on));
    w.setWalk(true);
    w.setWalk(true);
    w.setWalk(false);
    w.setWalk(false);
    expect(heard).toEqual([true, false]);
  });

  it("there is nothing to walk in plan: it stays off and nothing moves", () => {
    const { viewer: w, camera, controls } = viewer({ mode: "plan" });
    const heard: boolean[] = [];
    w.onWalkChange((on) => heard.push(on));
    w.setWalk(true);
    w.walkKey("KeyW", true);
    frames(w, controls, 1);
    expect(w.walking()).toBe(false);
    expect(heard).toEqual([]);
    expect(camera.position.distanceTo(EYE)).toBe(0);
  });

  it("losing the window's focus lets the keys go, so a key that never came up cannot keep the camera walking", () => {
    const { viewer: w, camera, controls } = viewer();
    const off = releaseWalkOnBlur((w as unknown as { walk: WalkMotion }).walk, window);
    w.setWalk(true);
    w.walkKey("KeyW", true);
    frames(w, controls, 1);
    window.dispatchEvent(new Event("blur"));
    frames(w, controls, 1);
    const rested = camera.position.clone();
    frames(w, controls, 2);
    expect(camera.position.distanceTo(rested)).toBe(0);
    expect(w.walking()).toBe(true);
    // Unsubscribed (the viewer is gone), a blur is nobody's business: a key held stays held.
    off();
    const before = camera.position.clone();
    w.walkKey("KeyW", true);
    frames(w, controls, 1);
    window.dispatchEvent(new Event("blur"));
    frames(w, controls, 0.5);
    expect(camera.position.distanceTo(before)).toBeGreaterThan(4);
  });

  it("navigation switched off (an overlay dragging a grip) holds the eye, keys held or not", () => {
    const { viewer: w, camera, controls } = viewer();
    w.setWalk(true);
    w.walkKey("KeyW", true);
    frames(w, controls, 0.5);
    const held = camera.position.clone();
    controls.enabled = false;
    frames(w, controls, 1);
    expect(camera.position.distanceTo(held)).toBe(0);
  });

  it("a long frame is one short step, not a leap", () => {
    const { viewer: w, camera, controls } = viewer();
    w.setWalk(true);
    w.walkKey("KeyW", true);
    frames(w, controls, 1);
    const eye = camera.position.clone();
    w.stepWalk(5);
    controls.update(5);
    // 5.4 m/s, for at most 0.1 s.
    expect(camera.position.distanceTo(eye)).toBeLessThan(0.55);
  });

  it("the speed follows the distance to the orbit point: close in is a stroll, far away crosses the site", () => {
    const { viewer: w, camera, controls } = viewer();
    const close = new THREE.Vector3(1, 0.5, 1);
    void controls.setLookAt(close.x, close.y, close.z, 0, 0, 0, false);
    controls.update(0);
    w.setWalk(true);
    w.walkKey("KeyW", true);
    frames(w, controls, 1);
    // 1.5 m/s, a touch under for the ease-in.
    expect(camera.position.distanceTo(close)).toBeGreaterThan(1.2);
    expect(camera.position.distanceTo(close)).toBeLessThan(1.5);
    void controls.setLookAt(200, 100, 200, 0, 0, 0, false);
    controls.update(0);
    const eye = camera.position.clone();
    frames(w, controls, 1);
    // 300 m away: 150 m/s.
    expect(camera.position.distanceTo(eye)).toBeGreaterThan(120);
  });

  it("ignores non-finite walk speeds and radii instead of poisoning camera state with NaN", () => {
    expect(walkSpeedFor(Number.NaN)).toBe(1.5);
    expect(walkSpeedFor(Number.POSITIVE_INFINITY)).toBe(1.5);
    expect(walkSpeedFor(-10)).toBe(1.5);
    const { viewer: w } = viewer();
    const heard: number[] = [];
    w.onWalkSpeedChange((scale) => heard.push(scale));
    w.setWalkSpeed(2);
    w.setWalkSpeed(Number.NaN);
    w.setWalkSpeed(Number.POSITIVE_INFINITY);
    expect(w.walkSpeed()).toBe(2);
    expect(heard).toEqual([2]);
  });

  it("stays off in orthographic 3D projection", () => {
    const { viewer: w, camera, controls } = viewer({ projection: "orthographic" });
    const heard: boolean[] = [];
    w.onWalkChange((on) => heard.push(on));
    w.setWalk(true);
    w.walkKey("KeyW", true);
    frames(w, controls, 1);
    expect(w.walking()).toBe(false);
    expect(heard).toEqual([]);
    expect(camera.position.distanceTo(EYE)).toBe(0);
  });

  it("simultaneous turn and wheel zoom while walking keeps the zoom instead of cancelling it", () => {
    const { camera, controls } = rig();
    const initDist = camera.position.distanceTo(target(controls));
    controls.walking = true;
    controls.update(0);
    const beforeAim = aim(camera);
    void controls.rotate(DEG(40), 0, true);
    void controls.dollyTo(initDist * 0.5, true);
    settle(controls);
    expect(aim(camera).angleTo(beforeAim)).toBeGreaterThan(DEG(30));
    expect(camera.position.distanceTo(EYE)).toBeGreaterThan(initDist * 0.35);
    expect(camera.position.distanceTo(target(controls))).toBeCloseTo(initDist * 0.5, 2);
  });

  it("emits update and sleep events after holdTheEye so listeners never observe pre-correction orbited eye drift", () => {
    const { camera, controls } = rig();
    controls.walking = true;
    controls.update(0);
    let maxUpdateDrift = 0;
    let maxMatrixDrift = 0;
    let sleepDrift = -1;
    const worldPos = new THREE.Vector3();
    controls.addEventListener("update", () => {
      maxUpdateDrift = Math.max(maxUpdateDrift, camera.position.distanceTo(EYE));
      worldPos.setFromMatrixPosition(camera.matrixWorld);
      maxMatrixDrift = Math.max(maxMatrixDrift, worldPos.distanceTo(EYE));
    });
    controls.addEventListener("sleep", () => {
      sleepDrift = camera.position.distanceTo(EYE);
    });
    void controls.rotate(DEG(35), DEG(-10), true);
    settle(controls);
    expect(maxUpdateDrift).toBeLessThan(1e-9);
    expect(maxMatrixDrift).toBeLessThan(1e-9);
    expect(sleepDrift).toBeGreaterThanOrEqual(0);
    expect(sleepDrift).toBeLessThan(1e-9);
  });

  it("exclusive camera modes: another navigation mode stops walking cleanly, and starting walk stops the previous mode", () => {
    const { viewer: w, controls } = viewer();
    const modes: Array<string | null> = [];
    const walks: boolean[] = [];
    w.onCameraModeChange((m) => modes.push(m));
    w.onWalkChange((on) => walks.push(on));

    w.setWalk(true);
    expect(w.cameraMode()).toBe("walk");
    expect(w.walking()).toBe(true);

    let otherStopped = 0;
    const releaseOther = w.claimCameraMode("floor-walk", () => {
      otherStopped += 1;
    });
    expect(w.walking()).toBe(false);
    expect(controls.walking).toBe(false);
    expect(w.cameraMode()).toBe("floor-walk");
    expect(otherStopped).toBe(0);

    w.setWalk(true);
    expect(otherStopped).toBe(1);
    expect(w.cameraMode()).toBe("walk");
    expect(w.walking()).toBe(true);

    // Calling stale release from the superseded mode is a no-op.
    releaseOther();
    expect(w.cameraMode()).toBe("walk");

    // Pausing the viewer (switching to a drawing, sheet, or schedule) ends the active mode at once.
    w.setPaused(true);
    expect(w.walking()).toBe(false);
    expect(w.cameraMode()).toBeNull();
    expect(walks).toEqual([true, false, true, false]);
    expect(modes).toEqual(["walk", null, "floor-walk", null, "walk", null]);
  });
});
