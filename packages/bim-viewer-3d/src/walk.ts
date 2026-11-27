import * as THREE from "three";
import type { WalkKey } from "./walk-keys";

/** Seconds to reach the orbit point (the point the last zoom or click chose) from any distance: the speed follows the distance. */
const WALK_SECONDS_TO_ORBIT_POINT = 2;
/** Metres a second, at the closest: a brisk walk, so a room can be crossed without care. */
const WALK_SLOWEST = 1.5;
/** Metres a second, from across a site: a stadium is crossed in seconds, not minutes. */
const WALK_FASTEST = 200;
/** Seconds the speed takes to ease in and out, so a step starts and stops without a jolt. */
const WALK_EASE_SECONDS = 0.1;
/** Below this speed (metres a second), with nothing held, the camera is still. */
const WALK_REST_SPEED = 0.01;

/**
 * Walking speed in metres a second for a view whose orbit point is `radius`
 * metres away. The point a zoom or a click chose is what the person is
 * looking at, so reaching it takes the same two seconds from across a site
 * or across a room.
 */
export function walkSpeedFor(radius: number): number {
  if (!Number.isFinite(radius) || radius <= 0) return WALK_SLOWEST;
  return THREE.MathUtils.clamp(radius / WALK_SECONDS_TO_ORBIT_POINT, WALK_SLOWEST, WALK_FASTEST);
}

/** The pace multiplier's lowest setting (a tenth of the distance-led speed). */
export const WALK_SPEED_SCALE_MIN = 0.1;
/** The pace multiplier's highest setting (ten times the distance-led speed). */
export const WALK_SPEED_SCALE_MAX = 10;
/** One scroll notch with the right button held multiplies the pace by 10 to this power (about 1.26). The slider steps half of it. */
export const WALK_SPEED_WHEEL_LOG_STEP = 0.1;

/**
 * Let the keys go whenever the window loses focus: a key held at that moment
 * never comes up, and nothing may keep walking. Returns the unsubscribe.
 */
export function releaseWalkOnBlur(walk: WalkMotion, target: Window): () => void {
  const release = () => walk.releaseAll();
  target.addEventListener("blur", release);
  return () => target.removeEventListener("blur", release);
}

/**
 * The keys held for a walk and the speed they have eased to (scene metres a
 * second, world axes). The host reports each key press and release; the frame
 * step turns what is held into how far the eye goes this frame.
 */
export class WalkMotion {
  private readonly held = new Set<WalkKey>();
  private readonly velocity = new THREE.Vector3();
  /** The person's pace as a multiple of the distance-led speed (`walkSpeedFor`), 1 by default. The right-button wheel and the host's slider set it. */
  speedScale = 1;

  hold(key: WalkKey): void {
    this.held.add(key);
  }

  release(key: WalkKey): void {
    this.held.delete(key);
  }

  /** Every key let go at once (the walk ended, the window lost focus): the camera eases to a stop. */
  releaseAll(): void {
    this.held.clear();
  }

  /** The camera is at rest: no speed left (keys may be held for a walk that is not on). */
  get resting(): boolean {
    return this.velocity.lengthSq() <= WALK_REST_SPEED * WALK_REST_SPEED;
  }

  /** Stops at once (the view changes under the walk): nothing eases anywhere. */
  stop(): void {
    this.held.clear();
    this.velocity.set(0, 0, 0);
  }

  /**
   * How far the eye moves in `delta` seconds, along the ground plane in the
   * camera's axes: `forward` is the way the view faces on that plane,
   * `right` its screen-right (both unit vectors, both horizontal). E and Q
   * add the world's up and down. Writes the displacement to `out` and returns it.
   */
  step(delta: number, forward: THREE.Vector3, right: THREE.Vector3, orbitRadius: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    if (this.held.has("forward")) out.add(forward);
    if (this.held.has("back")) out.sub(forward);
    if (this.held.has("left")) out.sub(right);
    if (this.held.has("right")) out.add(right);
    if (this.held.has("up")) out.y += 1;
    if (this.held.has("down")) out.y -= 1;
    // Forward and right together go the same speed as forward alone.
    if (out.lengthSq() > 0) out.normalize().multiplyScalar(walkSpeedFor(orbitRadius) * this.speedScale);
    this.velocity.lerp(out, 1 - Math.exp(-delta / WALK_EASE_SECONDS));
    if (this.held.size === 0 && this.resting) this.velocity.set(0, 0, 0);
    return out.copy(this.velocity).multiplyScalar(delta);
  }
}
