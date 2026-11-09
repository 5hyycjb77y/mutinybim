import * as THREE from "three";
import CameraControls from "camera-controls";
import { panButtonOf } from "./pan-buttons";
import { wheelZoomLog, type WheelDelta } from "./wheel-zoom";

CameraControls.install({ THREE });

type ViewCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;


/** An orthographic eye closer than this to the point it zooms toward steps back along the view (invisible in a parallel view), metres. */
const ORTHO_MIN_DEPTH = 1;
/** Two middle-button presses within this long, and this close, are a double-click (zoom extents), ms / px. */
export const MIDDLE_DOUBLE_CLICK_MS = 400;
export const MIDDLE_DOUBLE_CLICK_PX = 6;

/**
 * Distance scale for one wheel event: below 1 zooms in, above 1 zooms out.
 * Exponential, so each notch covers the same fraction of the distance at any
 * range. The same step as every flat view (`wheel-zoom.ts`).
 */
export function wheelScale(delta: WheelDelta): number {
  return Math.exp(-wheelZoomLog(delta));
}

/** What the wheel asks the viewer: the model point under the pointer, seen from the camera as it will rest. */
export interface ZoomAnchorQuery {
  /** Through the pointer, from the camera where it will rest once the current motion settles. */
  readonly ray: THREE.Ray;
  /** That resting camera (a copy; not the one being drawn). */
  readonly camera: ViewCamera;
  readonly clientX: number;
  readonly clientY: number;
}

/** The nearest visible, unclipped model point along the query's ray (linked models included), or null for empty space. */
export type ZoomAnchorSource = (query: ZoomAnchorQuery) => THREE.Vector3 | null;

/** Where the eye was (its orbit frame, resting) just before a zoom carried it through a surface. */
interface PassThroughFrame extends OrbitFrame {
  readonly position: THREE.Vector3;
}

interface OrbitFrame {
  readonly target: THREE.Vector3;
  readonly spherical: THREE.Spherical;
  readonly focalOffset: THREE.Vector3;
}

/**
 * Camera controls for every view camera (3D perspective, 3D orthographic and
 * plan). The wheel and trackpad pinch zoom toward the model point under the
 * pointer (`zoomAnchor`, else the point on the plane through the orbit point
 * facing the camera), and that point stays on its pixel: the camera moves
 * along the pointer's ray, or in a parallel view the zoom scales about it.
 * The point becomes the orbit point without moving the camera, so the next
 * orbit turns around what was zoomed into. camera-controls' own wheel
 * handling (and its `dollyToCursor`, which aims at the target's depth rather
 * than the surface) stays off; `onWheel` below takes over.
 *
 * Within `zoomFloor` of the point, zooming in carries on forward along the
 * pointer's ray instead of slowing to a crawl.
 */
export class PointZoomControls extends CameraControls {
  /** Metres: closer than this, zooming in moves forward along the pointer's ray instead of approaching the point. */
  zoomFloor = 1;
  /** Finds the model point under the pointer; null (or unset) zooms toward the plane through the orbit point. */
  zoomAnchor: ZoomAnchorSource | null = null;
  /** Told the point each pointer zoom went toward (it is the orbit point from then on). */
  onZoomAnchor: ((point: THREE.Vector3) => void) | null = null;
  /** Told the first time a wheel zoom carries the eye through the surface it zoomed toward. */
  onPassThrough: (() => void) | null = null;
  /** A middle-button double-click: zoom extents, as in every flat view. */
  onZoomExtents: (() => void) | null = null;
  private lastMiddle: { time: number; x: number; y: number } | null = null;
  private beforePassThrough: PassThroughFrame | null = null;
  /** The last surface point a wheel zoom went toward (scene metres). */
  private lastSurface: THREE.Vector3 | null = null;
  private readonly wheelElement: HTMLElement;
  private freeButtons: FreeButtons | null = null;
  private pendingPivot: THREE.Vector3 | null = null;
  private readonly pointerRay = new THREE.Raycaster();

  constructor(camera: ViewCamera, element: HTMLElement) {
    super(camera, element);
    this.wheelElement = element;
    this.dollyToCursor = false;
    this.infinityDolly = false;
    this.smoothTime = 0.15;
    this.mouseButtons.wheel = CameraControls.ACTION.NONE;
    // The middle button pans, as it does in sheets, drawings and the part editor.
    this.mouseButtons.middle = CameraControls.ACTION.TRUCK;
    element.addEventListener("wheel", this.onWheel, { passive: false });
    element.addEventListener("pointerdown", this.onMiddleDown);
    // Before camera-controls reads the buttons (it listens on the document): a left + right chord pans, as in every flat view.
    element.addEventListener("pointerdown", this.onChordCheck, { capture: true });
    element.addEventListener("pointermove", this.onChordCheck, { capture: true });
  }

  /** The left button's action before a chord made it pan; restored when the buttons come up. */
  private chordLeft: CameraControls["mouseButtons"]["left"] | null = null;

  /**
   * camera-controls adds up every held button's action, so left + right would
   * orbit and pan at once. For the rest of a chord press, left pans too: the
   * chord is a pure pan, the same as the middle button.
   */
  private readonly onChordCheck = (event: PointerEvent) => {
    if (this.chordLeft !== null || panButtonOf(event) !== "chord") return;
    const free = this.freeButtons;
    // An edit owns the pointer: the surface cancels it on the chord; the buttons it froze come back panning.
    if (free) {
      this.chordLeft = free.left;
      this.freeButtons = { ...free, left: CameraControls.ACTION.TRUCK };
    } else {
      this.chordLeft = this.mouseButtons.left;
      this.mouseButtons.left = CameraControls.ACTION.TRUCK;
    }
    this.wheelElement.ownerDocument.addEventListener("pointerup", this.onChordEnd, { capture: true });
  };

  private readonly onChordEnd = (event: PointerEvent) => {
    if (event.buttons !== 0 || this.chordLeft === null) return;
    const left = this.chordLeft;
    this.chordLeft = null;
    this.wheelElement.ownerDocument.removeEventListener("pointerup", this.onChordEnd, { capture: true });
    if (this.freeButtons) this.freeButtons = { ...this.freeButtons, left };
    else this.mouseButtons.left = left;
  };

  /** A chord is held: the left button pans until the buttons come up. */
  get chordPanning(): boolean {
    return this.chordLeft !== null;
  }

  private readonly onMiddleDown = (event: PointerEvent) => {
    if (event.button !== 1) return;
    const last = this.lastMiddle;
    const now = event.timeStamp;
    if (last && now - last.time < MIDDLE_DOUBLE_CLICK_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) < MIDDLE_DOUBLE_CLICK_PX) {
      this.lastMiddle = null;
      if (this.enabled) this.onZoomExtents?.();
      return;
    }
    this.lastMiddle = { time: now, x: event.clientX, y: event.clientY };
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (!this.enabled) return;
    event.preventDefault();
    this.zoomAtPointer(event.clientX, event.clientY, wheelScale({ deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey }));
  };

  /**
   * Zoom by a distance scale (below 1 is closer) toward the model point under
   * the pointer at client (x, y), which keeps its pixel and becomes the orbit point.
   */
  zoomAtPointer(clientX: number, clientY: number, scale: number) {
    if (!(scale > 0) || scale === 1) return;
    const rect = this.wheelElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const camera = this.restingCamera();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.pointerRay.setFromCamera(ndc, camera);
    const ray = this.pointerRay.ray.clone();
    const hit = this.zoomAnchor?.({ ray, camera, clientX, clientY }) ?? null;
    const surface = hit && this.seesPoint(camera, hit) ? hit : null;
    const point = surface ?? this.pointOnOrbitPlane(ray, camera);
    if (!point) return;
    // The point the pointer chose is newer than a middle-of-the-model point still waiting to land.
    this.pendingPivot = null;
    const before: PassThroughFrame = { position: camera.position.clone(), target: this._targetEnd.clone(), spherical: this._sphericalEnd.clone(), focalOffset: this._focalOffsetEnd.clone() };
    if (!this.pivotAt(point)) {
      this.zoomBy(scale);
      return;
    }
    this.zoomBy(scale, ray.direction);
    if (surface) this.lastSurface = surface.clone();
    if (scale < 1) this.notePassThrough(before);
    this.onZoomAnchor?.(point.clone());
  }

  /**
   * Did this notch carry the eye through the last surface zoomed toward? The
   * close-in notch that crosses usually can't see it any more (it is inside
   * the near plane), so the check is on the eye's own path: it went from in
   * front of that point to behind it, passing within the zoom floor of it.
   */
  private notePassThrough(before: PassThroughFrame) {
    const surface = this.lastSurface;
    if (!surface || this.beforePassThrough) return;
    const after = this.restingCamera().position;
    const step = after.clone().sub(before.position);
    const length = step.length();
    if (length < 1e-9) return;
    const dir = step.divideScalar(length);
    const ahead = surface.clone().sub(before.position).dot(dir);
    if (ahead <= 0 || ahead > length) return;
    const miss = before.position.clone().addScaledVector(dir, ahead).distanceTo(surface);
    if (miss > Math.max(this.zoomFloor, 0.05)) return;
    this.lastSurface = null;
    this.beforePassThrough = before;
    this.onPassThrough?.();
  }

  /**
   * The wheel carried the eye through the surface it was zooming toward (into
   * a wall, under a roof). It keeps going (it never stops at a surface); this
   * only remembers where the eye was just before, so the person can step back.
   */
  passedThrough(): boolean {
    return this.beforePassThrough !== null;
  }

  /** Back to where the eye was just before it went through a surface. False when it hasn't. Nothing searches for a free spot. */
  stepBackOut(): boolean {
    const before = this.beforePassThrough;
    if (!before) return false;
    this.beforePassThrough = null;
    const { target: t, focalOffset: f } = before;
    const eye = new THREE.Vector3().setFromSpherical(before.spherical).applyQuaternion(this._yAxisUpSpaceInverse).add(t);
    void this.setLookAt(eye.x, eye.y, eye.z, t.x, t.y, t.z, true);
    void this.setFocalOffset(f.x, f.y, f.z, true);
    return true;
  }

  /** Forget the pass-through (the view was reframed or the person dismissed the notice). */
  clearPassThrough() {
    this.beforePassThrough = null;
    this.lastSurface = null;
  }

  /**
   * Zoom about the orbit point by a distance scale (below 1 is closer),
   * smoothly; the orbit point keeps its place on screen. Close in, the rest of
   * the step goes forward along `along` (default: the view direction).
   */
  zoomBy(scale: number, along?: THREE.Vector3) {
    if (!(scale > 0) || scale === 1) return;
    const offset = this._focalOffsetEnd.clone();
    if (this._camera instanceof THREE.OrthographicCamera) {
      const zoom = THREE.MathUtils.clamp(this._zoomEnd / scale, this.minZoom, this.maxZoom);
      const applied = this._zoomEnd / zoom;
      void this.zoomTo(zoom, true);
      void this.setFocalOffset(offset.x * applied, offset.y * applied, offset.z * applied, true);
      return;
    }
    const radius = this._sphericalEnd.radius;
    const floor = this.zoomFloor;
    if (scale < 1 && radius * scale < floor) {
      // Approach the floor, then carry on through: the rest of the step pushes camera and point forward together.
      const kept = Math.min(radius, floor);
      const push = Math.max(radius, floor) * (1 - scale) - (radius - kept);
      const applied = kept / radius;
      void this.dollyTo(kept, true);
      void this.setFocalOffset(offset.x * applied, offset.y * applied, offset.z * applied, true);
      if (along) {
        const next = this._targetEnd.clone().addScaledVector(along.clone().normalize(), push);
        void this.moveTo(next.x, next.y, next.z, true);
      } else {
        void this.dollyInFixed(push, true);
      }
      return;
    }
    const next = THREE.MathUtils.clamp(radius * scale, this.minDistance, this.maxDistance);
    const applied = next / radius;
    void this.dollyTo(next, true);
    void this.setFocalOffset(offset.x * applied, offset.y * applied, offset.z * applied, true);
  }

  /**
   * The camera as it will rest once the current motion settles (a copy).
   * Asking where the pointer points from there keeps a run of wheel events
   * consistent while the view is still gliding from the last one.
   */
  private restingCamera(): ViewCamera {
    const camera = this._camera.clone();
    const end = this.frameAxes({ target: this._targetEnd, spherical: this._sphericalEnd, focalOffset: this._focalOffsetEnd });
    camera.position.copy(end.position);
    camera.quaternion.setFromRotationMatrix(end.basis);
    camera.zoom = this._zoomEnd;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return camera;
  }

  /** The camera position and axes (right, up, back) camera-controls' update draws for an orbit frame. */
  private frameAxes(frame: OrbitFrame): { position: THREE.Vector3; basis: THREE.Matrix4; x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
    const eye = new THREE.Vector3().setFromSpherical(frame.spherical).applyQuaternion(this._yAxisUpSpaceInverse).add(frame.target);
    const basis = new THREE.Matrix4().lookAt(eye, frame.target, this._camera.up);
    const x = new THREE.Vector3().setFromMatrixColumn(basis, 0);
    const y = new THREE.Vector3().setFromMatrixColumn(basis, 1);
    const z = new THREE.Vector3().setFromMatrixColumn(basis, 2);
    const { focalOffset: f } = frame;
    const position = eye.clone().addScaledVector(x, f.x).addScaledVector(y, -f.y).addScaledVector(z, f.z);
    return { position, basis, x, y, z };
  }

  /** Visible from the resting camera: in front of the near plane (a parallel view draws behind its eye too). */
  private seesPoint(camera: ViewCamera, point: THREE.Vector3): boolean {
    if (camera instanceof THREE.OrthographicCamera) return true;
    const forward = camera.getWorldDirection(new THREE.Vector3());
    return point.clone().sub(camera.position).dot(forward) > camera.near;
  }

  /** Empty space under the pointer: where its ray meets the plane through the orbit point facing the camera. */
  private pointOnOrbitPlane(ray: THREE.Ray, camera: ViewCamera): THREE.Vector3 | null {
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(forward, this._targetEnd);
    const point = ray.intersectPlane(plane, new THREE.Vector3());
    return point && this.seesPoint(camera, point) ? point : null;
  }

  /**
   * Make `point` the orbit point without moving the camera, now and where it
   * is heading: the target moves onto it and the distance and screen-parallel
   * offset take up the difference. The camera's current velocity carries over,
   * so a zoom already gliding keeps gliding.
   */
  private pivotAt(point: THREE.Vector3): boolean {
    if (point.distanceToSquared(this._targetEnd) < 1e-12 && point.distanceToSquared(this._target) < 1e-12) return true;
    const ortho = this._camera instanceof THREE.OrthographicCamera;
    const end = this.frameAxes({ target: this._targetEnd, spherical: this._sphericalEnd, focalOffset: this._focalOffsetEnd });
    const endD = end.position.clone().sub(point);
    const now = this.frameAxes({ target: this._target, spherical: this._spherical, focalOffset: this._focalOffset });
    const nowD = now.position.clone().sub(point);
    let endDepth = endD.dot(end.z);
    let nowDepth = nowD.dot(now.z);
    if (ortho) {
      endDepth = Math.max(endDepth, ORTHO_MIN_DEPTH);
      nowDepth = Math.max(nowDepth, ORTHO_MIN_DEPTH);
    } else if (!(endDepth > 0)) {
      return false;
    }
    // World velocity of the camera before the change: the target's own plus the offset's, in the camera's axes.
    const velocity = this._targetVelocity
      .clone()
      .addScaledVector(now.z, this._radiusVelocity.value)
      .addScaledVector(now.x, this._focalOffsetVelocity.x)
      .addScaledVector(now.y, -this._focalOffsetVelocity.y)
      .addScaledVector(now.z, this._focalOffsetVelocity.z);

    this._targetEnd.copy(point);
    this._sphericalEnd.radius = endDepth;
    this._focalOffsetEnd.set(endD.dot(end.x), -endD.dot(end.y), 0);
    if (nowDepth > 0) {
      this._target.copy(point);
      this._spherical.radius = nowDepth;
      this._focalOffset.set(nowD.dot(now.x), -nowD.dot(now.y), 0);
      this._targetVelocity.set(0, 0, 0);
      this._radiusVelocity.value = velocity.dot(now.z);
      this._focalOffsetVelocity.set(velocity.dot(now.x), -velocity.dot(now.y), 0);
    }
    this._needsUpdate = true;
    return true;
  }

  /**
   * While an edit owns the pointer (a duct drag, a route stroke, a box), the
   * mouse buttons and touches do not move the camera; any orbit the press
   * already started is cancelled. The wheel keeps zooming toward the pointer.
   */
  setPointerBlocked(blocked: boolean) {
    if (blocked === (this.freeButtons !== null)) return;
    if (blocked) {
      this.freeButtons = {
        left: this.mouseButtons.left,
        middle: this.mouseButtons.middle,
        right: this.mouseButtons.right,
        one: this.touches.one,
        two: this.touches.two,
        three: this.touches.three,
      };
      this.mouseButtons.left = CameraControls.ACTION.NONE;
      this.mouseButtons.middle = CameraControls.ACTION.NONE;
      this.mouseButtons.right = CameraControls.ACTION.NONE;
      this.touches.one = CameraControls.ACTION.NONE;
      this.touches.two = CameraControls.ACTION.NONE;
      this.touches.three = CameraControls.ACTION.NONE;
      this.cancel();
      return;
    }
    const free = this.freeButtons;
    this.freeButtons = null;
    if (!free) return;
    this.mouseButtons.left = free.left;
    this.mouseButtons.middle = free.middle;
    this.mouseButtons.right = free.right;
    this.touches.one = free.one;
    this.touches.two = free.two;
    this.touches.three = free.three;
  }

  get pointerBlocked(): boolean {
    return this.freeButtons !== null;
  }

  /** A mouse or touch orbit is turning the view right now. */
  get orbiting(): boolean {
    return (this.currentAction & (CameraControls.ACTION.ROTATE | CameraControls.ACTION.TOUCH_ROTATE)) !== 0;
  }

  /**
   * Ask for the middle-of-the-model orbit point. It is applied only once the
   * camera is still and nothing owns the pointer: moving the orbit point
   * mid-zoom cancels the zoom, and mid-orbit makes the view swim.
   */
  requestFallbackPivot(point: THREE.Vector3) {
    this.pendingPivot = point.clone();
    this.applyPendingPivot();
  }

  /** Drop a waiting middle-of-the-model point (a click or a zoom chose the orbit point instead). */
  clearFallbackPivot() {
    this.pendingPivot = null;
  }

  hasPendingPivot(): boolean {
    return this.pendingPivot !== null;
  }

  override update(delta: number): boolean {
    const changed = super.update(delta);
    this.applyPendingPivot();
    return changed;
  }

  private applyPendingPivot() {
    const p = this.pendingPivot;
    if (!p || this.pointerBlocked || this.active || this.currentAction !== CameraControls.ACTION.NONE) return;
    this.pendingPivot = null;
    this.setOrbitPoint(p.x, p.y, p.z);
  }

  override dispose() {
    this.wheelElement.removeEventListener("wheel", this.onWheel);
    this.wheelElement.removeEventListener("pointerdown", this.onMiddleDown);
    this.wheelElement.removeEventListener("pointerdown", this.onChordCheck, { capture: true });
    this.wheelElement.removeEventListener("pointermove", this.onChordCheck, { capture: true });
    this.wheelElement.ownerDocument.removeEventListener("pointerup", this.onChordEnd, { capture: true });
    super.dispose();
  }
}

interface FreeButtons {
  readonly left: CameraControls["mouseButtons"]["left"];
  readonly middle: CameraControls["mouseButtons"]["middle"];
  readonly right: CameraControls["mouseButtons"]["right"];
  readonly one: CameraControls["touches"]["one"];
  readonly two: CameraControls["touches"]["two"];
  readonly three: CameraControls["touches"]["three"];
}

/** How close to the zoomed-toward point the wheel can bring the camera before it moves forward instead (metres): 1% of the model's size, within 0.3 to 3 m. */
export function zoomFloorFor(sceneBox: THREE.Box3): number {
  if (sceneBox.isEmpty()) return 1;
  return THREE.MathUtils.clamp(sceneBox.getBoundingSphere(new THREE.Sphere()).radius * 0.01, 0.3, 3);
}

/**
 * Make `point` the orbit point. Only the orbit target changes: the camera's
 * position and aim stay exactly where they are (nothing glides the point to
 * the centre of the view).
 */
export function pinOrbitPoint(controls: CameraControls, point: THREE.Vector3) {
  controls.setOrbitPoint(point.x, point.y, point.z);
}

export function makeCameraControls(camera: ViewCamera, element: HTMLElement): PointZoomControls {
  return new PointZoomControls(camera, element);
}
