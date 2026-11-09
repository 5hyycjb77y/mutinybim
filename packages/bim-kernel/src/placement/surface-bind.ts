import { lineJoinRow } from "../joins/contract";
import { surfaceFaceRow } from "../surfaces/faces";
import { surfacesAt, type SurfaceAt, type SurfaceOrigin } from "../surfaces/surfaces-at";
import type { BimElement, ElementId, ModelState, Vec2, WallBodyPoint } from "../types";
import type { LinePlacement, SurfaceBinding } from "./geometric";
import { topTieRow } from "./top-tie";

/**
 * A line-placed body bound to surfaces: its top runs to the structure, a
 * ceiling or a roof over it, its base stands on the slab under it (or one
 * element's face). The heights are derived here, from the surface faces in
 * force (`kernel.surface_face`, through `surfacesAt`), sampled along the
 * line: where the same face runs over both ends of a stretch the body is
 * linear between them (faces are planes); where it changes, the stretch is
 * halved until the change is found to within `STEP_MM`. A body that is the
 * same height all along is flat (no profile); otherwise its stations are
 * kept as the wall's derived `bodyProfile`.
 *
 * `placement/surface-follow.ts` re-derives every bound body a change reaches.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** A surface change along a line is found to within this, mm. */
export const SURFACE_STEP_MM = 25;
/** Heights this close are the same (no profile for rounding), mm. */
const SAME_MM = 0.5;
/** Lowest body a binding may give, mm. */
export const MIN_BOUND_HEIGHT_MM = 1;
/** How far inside a wall's end or face a probe sits when the line itself lies on a surface's edge, mm. */
const EDGE_NUDGE_MM = 1;

export interface BoundBodyOk {
  readonly ok: true;
  /** The tallest stretch, mm. */
  readonly heightMm: number;
  /** The base above the level at each end, mm (what `startOffsetMm` / `endOffsetMm` become when the base is bound). */
  readonly startOffsetMm: number;
  readonly endOffsetMm: number;
  /** Null when flat. */
  readonly profile: readonly WallBodyPoint[] | null;
  /** The elements whose faces it follows (slabs, ceilings, roofs, spaces), sorted. */
  readonly sourceIds: readonly ElementId[];
}

export type BoundBody = BoundBodyOk | { readonly ok: false; readonly reason: string };

/** The element's line placement when its top or base is bound to a surface, else null. */
export function surfaceBoundPlacement(el: BimElement | undefined): LinePlacement | null {
  const p = el && "placement" in el ? el.placement : undefined;
  if (!p || typeof p !== "object" || p.kind !== "line") return null;
  return p.topSurface !== undefined || p.baseSurface !== undefined ? p : null;
}

/** The binding written as a stable key (to tell whether a command changed it). */
export function surfaceBindingKey(el: BimElement | undefined): string {
  const p = surfaceBoundPlacement(el);
  if (!p) return "";
  const k = (b: SurfaceBinding | undefined) => (b ? `${b.to}|${b.elementId ?? ""}|${b.face ?? ""}|${b.offsetMm ?? 0}` : "-");
  return `${k(p.topSurface)}/${k(p.baseSurface)}/${p.topLevelId ?? ""}|${p.topOffsetMm ?? 0}`;
}

/** What a binding is, in words, for a refusal ("the structure above"). */
export function surfaceBindingWords(b: SurfaceBinding): string {
  switch (b.to) {
    case "structure":
      return "the underside of the structure above";
    case "ceiling":
      return "a ceiling";
    case "roof":
      return "the underside of a roof";
    case "floor":
      return "the top of the floor under it";
  }
}

interface Hit {
  readonly z: number;
  /** What it read, as a stable key: an element id, `level:<id>`, or `` for a fixed height. */
  readonly source: string;
  readonly id: ElementId | null;
}

function originId(o: SurfaceOrigin): ElementId | null {
  return o.kind === "slab" || o.kind === "ceiling" || o.kind === "space" || o.kind === "element" || o.kind === "level" ? o.id : null;
}

function originKey(o: SurfaceOrigin): string {
  const id = originId(o);
  if (id !== null) return `${o.kind}:${id}`;
  return o.kind === "linked" ? `linked:${o.modelId}:${o.globalId}` : o.kind;
}

/** One binding's face at a plan point, or null when there is none there. `probeMm`: the height it is looked for from (the base, for a top). */
function faceHit(model: ModelState, levelId: ElementId, b: SurfaceBinding, p: Vec2, probeMm: number): Hit | null {
  const offset = b.offsetMm ?? 0;
  if (b.elementId !== undefined) {
    const el = model.elements[b.elementId];
    const row = el ? surfaceFaceRow(el.kind) : null;
    const pair = el && row ? row.faceAt(el, model.elements, p) : null;
    if (!pair) return null;
    const face = b.face ?? (b.to === "floor" ? "top" : "underside");
    return { z: pair[face] + offset, source: `face:${b.elementId}:${face}`, id: b.elementId };
  }
  const at = surfacesAt(model, { point: p, levelId, elevationMm: probeMm });
  if (!at.ok) return null;
  let found: SurfaceAt | null;
  switch (b.to) {
    case "structure":
      found = at.structureAbove;
      break;
    case "ceiling":
      found = at.ceiling && at.ceiling.elevationMm > probeMm + MIN_BOUND_HEIGHT_MM ? at.ceiling : null;
      break;
    case "roof":
      // A roof it stands on isn't one over it.
      found = at.roof && at.roof.elevationMm > probeMm + MIN_BOUND_HEIGHT_MM ? at.roof : null;
      break;
    case "floor":
      found = at.floor;
      break;
  }
  return found ? { z: found.elevationMm + offset, source: originKey(found.source), id: originId(found.source) } : null;
}

interface Sample {
  readonly at: number;
  readonly base: Hit;
  readonly top: Hit;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The bound body of `el` in `model` (its record as it stands there), or null
 * when it isn't a bound line element. Not ok, in words, when a surface it is
 * bound to isn't found over (or under) it, or the top would be at or under
 * the base.
 */
export function resolveBoundBody(model: ModelState, el: BimElement): BoundBody | null {
  const p = surfaceBoundPlacement(el);
  const row = topTieRow(el.kind);
  if (!p || !row) return null;
  const elements: Elements = model.elements;
  const level = elements[p.levelId];
  const name = `${el.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} ${el.id}`;
  if (level?.kind !== "level") return { ok: false, reason: `${name} isn't on a level in this model, so there is nothing to measure its top and base from` };
  const line = lineJoinRow(el.kind)?.line(el, elements) ?? { start: p.start, end: p.end };
  const length = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
  if (length < 1e-6) return { ok: false, reason: `${name} has no length` };
  const z0 = level.elevationMm;
  const fixedHeight = row.height(el) ?? 0;
  const topLevel = p.topLevelId !== undefined ? elements[p.topLevelId] : undefined;
  if (p.topLevelId !== undefined && topLevel?.kind !== "level") return { ok: false, reason: `${name}'s top level ${p.topLevelId} isn't a level in this model` };
  const pointAt = (s: number): Vec2 => ({ x: lerp(line.start.x, line.end.x, s / length), y: lerp(line.start.y, line.end.y, s / length) });
  const where = (s: number) => (s <= 0 ? "its start" : s >= length ? "its end" : `${(s / 304.8).toFixed(1)} ft along it`);
  // A wall on a slab's edge (its centreline or its end on the outline) is under that slab: the centreline first, then
  // just inside its end, then across its thickness, so a surface over any part of the wall's body counts.
  const u = { x: (line.end.x - line.start.x) / length, y: (line.end.y - line.start.y) / length };
  const half = Math.max(0, ("widthMm" in line ? line.widthMm : 0) / 2 - EDGE_NUDGE_MM);
  const probesAt = (s: number): Vec2[] => {
    const c = pointAt(s);
    const inward = s <= 0 ? EDGE_NUDGE_MM : s >= length ? -EDGE_NUDGE_MM : 0;
    const a = { x: c.x + u.x * inward, y: c.y + u.y * inward };
    const out = [c, a];
    for (const side of [1, -1]) out.push({ x: a.x - u.y * half * side, y: a.y + u.x * half * side });
    return out;
  };
  const firstHit = (b: SurfaceBinding, s: number, probeMm: number): Hit | null => {
    for (const pt of probesAt(s)) {
      const hit = faceHit(model, p.levelId, b, pt, probeMm);
      if (hit) return hit;
    }
    return null;
  };

  const sample = (s: number): Sample | string => {
    let base: Hit;
    if (p.baseSurface) {
      const hit = firstHit(p.baseSurface, s, z0);
      if (!hit) return `There is nothing for ${name} to stand on at ${where(s)}: ${surfaceBindingWords(p.baseSurface)} wasn't found there. Draw the floor first, or stand it on its level`;
      base = hit;
    } else base = { z: z0 + p.startOffsetMm, source: "", id: null };
    let top: Hit;
    if (p.topSurface) {
      const hit = firstHit(p.topSurface, s, base.z);
      if (!hit) return `There is no ${p.topSurface.to === "structure" ? "slab, deck or roof" : p.topSurface.to === "ceiling" ? "ceiling" : p.topSurface.to === "roof" ? "roof" : "floor"} over ${name} at ${where(s)}, so its top can't run to ${surfaceBindingWords(p.topSurface)}. Draw it first, or run the wall up to a level`;
      top = hit;
    } else if (topLevel?.kind === "level") top = { z: topLevel.elevationMm + (p.topOffsetMm ?? 0), source: `level:${topLevel.id}`, id: null };
    else top = { z: base.z + fixedHeight, source: "", id: null };
    if (top.z - base.z < MIN_BOUND_HEIGHT_MM) return `${name}'s top would be at or under its base at ${where(s)}; pick a surface or level above it`;
    return { at: s, base, top };
  };

  const first = sample(0);
  if (typeof first === "string") return { ok: false, reason: first };
  const last = sample(length);
  if (typeof last === "string") return { ok: false, reason: last };
  const samples: Sample[] = [first];
  // Halve a stretch whose two ends read different faces until the change is pinned down.
  const refine = (a: Sample, b: Sample, depth: number): string | null => {
    const same = a.base.source === b.base.source && a.top.source === b.top.source;
    if (same || b.at - a.at <= SURFACE_STEP_MM || depth > 24) {
      samples.push(b);
      return null;
    }
    const mid = sample((a.at + b.at) / 2);
    if (typeof mid === "string") return mid;
    return refine(a, mid, depth + 1) ?? refine(mid, b, depth + 1);
  };
  const middle = sample(length / 2);
  if (typeof middle === "string") return { ok: false, reason: middle };
  const failed = refine(first, middle, 0) ?? refine(middle, last, 0);
  if (failed) return { ok: false, reason: failed };

  const stepped: WallBodyPoint[] = [];
  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i] as Sample;
    const prev = samples[i - 1];
    const point = { atMm: Math.round(cur.at), baseMm: Math.round(cur.base.z - z0), topMm: Math.round(cur.top.z - z0) };
    const before = stepped[stepped.length - 1];
    // Where the face changes between two close samples the body steps at the later one: the earlier face carried up to it.
    if (prev && before && (prev.base.source !== cur.base.source || prev.top.source !== cur.top.source) && cur.at - prev.at <= SURFACE_STEP_MM) {
      const carried = { atMm: point.atMm, baseMm: before.baseMm, topMm: before.topMm };
      if (carried.baseMm !== point.baseMm || carried.topMm !== point.topMm) stepped.push(carried);
    }
    const last = stepped[stepped.length - 1];
    if (last && last.atMm === point.atMm && last.baseMm === point.baseMm && last.topMm === point.topMm) continue;
    stepped.push(point);
  }
  const flat = stepped.every((q) => Math.abs(q.baseMm - (stepped[0]?.baseMm ?? 0)) < SAME_MM && Math.abs(q.topMm - (stepped[0]?.topMm ?? 0)) < SAME_MM);
  const heightMm = Math.max(...stepped.map((q) => q.topMm - q.baseMm));
  const ids = new Set<ElementId>();
  for (const s of samples) for (const h of [s.base, s.top]) if (h.id !== null) ids.add(h.id);
  return {
    ok: true,
    heightMm,
    startOffsetMm: stepped[0]?.baseMm ?? 0,
    endOffsetMm: stepped[stepped.length - 1]?.baseMm ?? 0,
    profile: flat ? null : collinearDropped(stepped),
    sourceIds: [...ids].sort(),
  };
}

/** Profile points that sit on the straight line between their neighbours are dropped (a long run under one sloped roof is two points). */
function collinearDropped(points: readonly WallBodyPoint[]): WallBodyPoint[] {
  const out: WallBodyPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const q = points[i] as WallBodyPoint;
    const a = out[out.length - 1];
    const b = points[i + 1];
    if (a && b && b.atMm > a.atMm && q.atMm > a.atMm && q.atMm < b.atMm) {
      const t = (q.atMm - a.atMm) / (b.atMm - a.atMm);
      if (Math.abs(lerp(a.baseMm, b.baseMm, t) - q.baseMm) <= 1 && Math.abs(lerp(a.topMm, b.topMm, t) - q.topMm) <= 1) continue;
    }
    out.push(q);
  }
  return out;
}

const sameProfile = (a: readonly WallBodyPoint[] | undefined, b: readonly WallBodyPoint[] | null): boolean =>
  (a === undefined || a.length === 0) && b === null ? true : a !== undefined && b !== null && a.length === b.length && a.every((p, i) => p.atMm === b[i]?.atMm && p.baseMm === b[i]?.baseMm && p.topMm === b[i]?.topMm);

/** The element with a resolved body written (height, the base offsets when its base is bound, the profile), or null when nothing changes. */
export function withBoundBody(el: BimElement, body: BoundBodyOk): BimElement | null {
  const p = surfaceBoundPlacement(el);
  const row = topTieRow(el.kind);
  if (!p || !row || el.kind !== "wall") return null;
  const offsetsChange = p.baseSurface !== undefined && (p.startOffsetMm !== body.startOffsetMm || p.endOffsetMm !== body.endOffsetMm);
  if (row.height(el) === body.heightMm && !offsetsChange && sameProfile(el.bodyProfile, body.profile)) return null;
  const { bodyProfile: _old, ...rest } = row.withHeight(el, body.heightMm) as typeof el;
  const placement = offsetsChange ? { ...p, startOffsetMm: body.startOffsetMm, endOffsetMm: body.endOffsetMm } : p;
  return { ...rest, placement, ...(body.profile ? { bodyProfile: body.profile } : {}) };
}

/**
 * A wall's body profile for drawing: the derived one, else a flat body
 * raised by its base offset (start to end), else null (it stands on its
 * level, `height` tall: drawn as it always was).
 */
export function wallBodyProfile(el: BimElement): readonly WallBodyPoint[] | null {
  if (el.kind !== "wall") return null;
  if (el.bodyProfile && el.bodyProfile.length >= 2) return el.bodyProfile;
  const p = el.placement?.kind === "line" ? el.placement : null;
  const a = p?.startOffsetMm ?? 0;
  const b = p?.endOffsetMm ?? a;
  if (a === 0 && b === 0) return null;
  const length = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y);
  return [
    { atMm: 0, baseMm: a, topMm: a + el.height },
    { atMm: Math.round(length), baseMm: b, topMm: b + el.height },
  ];
}
