/**
 * Surface picking: what the pointer is over, for tools that put things where
 * the person points (Place part on a roof, Route under a soffit, a level from
 * a floor). Not for the camera: the wheel has its own anchor (`zoomAnchorAt`).
 *
 * Authored solids answer at once. Linked models ray cast asynchronously, so a
 * pick answers from the last linked cast made along the same ray and starts a
 * new one when there is none; when it lands, `onLanded` fires so the caller
 * re-runs its preview at the pointer it last saw. Only the latest pointer is
 * kept while a cast is in flight.
 */
import * as THREE from "three";
import { MM } from "./coords";

/** A hit in scene metres (Y up). `normal` faces the ray's origin; null when the source can't tell. */
export interface SceneSurfaceHit {
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3 | null;
  readonly distance: number;
  readonly elementId: string | null;
  readonly linked: { readonly referenceId: string; readonly localId: number } | null;
}

/** What `pickSurface` returns: kernel millimetres, X east, Y north, Z up. */
export interface SurfaceHit {
  readonly point: { readonly x: number; readonly y: number; readonly z: number };
  /** Unit normal facing the camera (kernel axes); null when a linked model didn't report one. */
  readonly normal: { readonly x: number; readonly y: number; readonly z: number } | null;
  /** The authored element hit; null for a linked model. */
  readonly elementId: string | null;
  /** The linked model and its item hit; null for authored work. */
  readonly linked: { readonly referenceId: string; readonly localId: number } | null;
}

export interface SurfaceQuery {
  readonly ray: THREE.Ray;
  readonly clientX: number;
  readonly clientY: number;
}

export type NativeSurfaceCast = (ray: THREE.Ray, accept?: (elementId: string) => boolean) => SceneSurfaceHit | null;
export type LinkedSurfaceCast = (query: SurfaceQuery) => Promise<SceneSurfaceHit | null>;

export class SurfacePicker {
  private cached: { readonly ray: THREE.Ray; readonly hit: SceneSurfaceHit | null } | null = null;
  private inFlight: Promise<SceneSurfaceHit | null> | null = null;
  private queued: SurfaceQuery | null = null;
  private disposed = false;

  constructor(
    private readonly native: NativeSurfaceCast,
    private readonly linked: LinkedSurfaceCast | null,
    private readonly onLanded: () => void,
    /** False while no linked model is shown: picks answer from authored work alone, at once. */
    private readonly linkedShown: () => boolean = () => true,
  ) {}

  /** The answer for this ray is final now (no linked model to wait for, or its cast on this ray has landed). */
  settled(query: SurfaceQuery): boolean {
    return !this.linked || !this.linkedShown() || (this.cached !== null && sameRay(this.cached.ray, query.ray));
  }

  /** The nearest surface along the ray now: authored at once, linked from the last cast on this ray (a new one starts when there is none). */
  pick(query: SurfaceQuery, accept?: (elementId: string) => boolean): SceneSurfaceHit | null {
    const native = this.native(query.ray, accept);
    if (!this.linked || !this.linkedShown()) return native;
    const cached = this.cached && sameRay(this.cached.ray, query.ray) ? this.cached : null;
    if (!cached) this.request(query);
    return nearer(native, cached?.hit ?? null);
  }

  /** The same answer, waiting for the linked models (a click whose hover cast hasn't landed yet). */
  async pickAsync(query: SurfaceQuery, accept?: (elementId: string) => boolean): Promise<SceneSurfaceHit | null> {
    const native = this.native(query.ray, accept);
    if (!this.linked || !this.linkedShown()) return native;
    const cached = this.cached && sameRay(this.cached.ray, query.ray) ? this.cached : null;
    if (cached) return nearer(native, cached.hit);
    // A cast never rejects (its failure is logged and answers null).
    if (this.inFlight) await this.inFlight;
    const again = this.cached && sameRay(this.cached.ray, query.ray) ? this.cached : null;
    if (again) return nearer(native, again.hit);
    return nearer(native, await this.cast(query));
  }

  dispose() {
    this.disposed = true;
    this.queued = null;
  }

  private request(query: SurfaceQuery) {
    if (this.inFlight) {
      this.queued = query;
      return;
    }
    void this.cast(query).then(() => {
      if (!this.disposed) this.onLanded();
    });
  }

  private cast(query: SurfaceQuery): Promise<SceneSurfaceHit | null> {
    const linked = this.linked;
    if (!linked) return Promise.resolve(null);
    const ray = query.ray.clone();
    const run = linked({ ...query, ray })
      .catch((err: unknown) => {
        console.error("[SurfacePicker] linked model ray cast failed; picking authored work only", err);
        return null;
      })
      .then((hit) => {
        if (!this.disposed) this.cached = { ray, hit };
        return hit;
      })
      .finally(() => {
        this.inFlight = null;
        const next = this.queued;
        this.queued = null;
        if (next && !this.disposed) this.request(next);
      });
    this.inFlight = run;
    return run;
  }
}

function nearer(a: SceneSurfaceHit | null, b: SceneSurfaceHit | null): SceneSurfaceHit | null {
  if (!a || !b) return a ?? b;
  return a.distance <= b.distance ? a : b;
}

/** Two pointer rays along the same line, from about the same eye. */
export function sameRay(a: THREE.Ray, b: THREE.Ray): boolean {
  return a.direction.angleTo(b.direction) < 1e-4 && a.origin.distanceTo(b.origin) < 1e-3;
}

/** A normal turned to face back along the ray (a hit on a face's far side reports the far-side normal). */
export function facingRay(normal: THREE.Vector3, ray: THREE.Ray): THREE.Vector3 {
  const n = normal.clone().normalize();
  return n.dot(ray.direction) > 0 ? n.negate() : n;
}

/** Scene metres (Y up, Z south) to kernel millimetres (Z up, Y north). */
export function toSurfaceHit(hit: SceneSurfaceHit): SurfaceHit {
  const p = hit.point;
  const n = hit.normal;
  return {
    point: { x: p.x / MM, y: -p.z / MM, z: p.y / MM },
    normal: n ? { x: n.x, y: -n.z, z: n.y } : null,
    elementId: hit.elementId,
    linked: hit.linked,
  };
}
