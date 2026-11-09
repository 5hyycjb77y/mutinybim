import { lineJoinsOf, type LineJoins } from "../joins/solve";
import { hostedIds } from "../qto/hosted";
import { tiltedZ, type Tilt } from "../geometry";
import type { BimElement, Vec2, WallBodyPoint } from "../types";
import { hostVoidRow, type HostVoid } from "./contract";

/**
 * Host voids read from the hosted index (`qto/hosted.ts`, carried per
 * revision): the voids the elements hosted on one host cut, and what a
 * line-placed host's body and plan look like with them cut out and its ends
 * joined.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Plans cut through hosts at this height above their base: a void that spans it is a gap in plan. */
export const PLAN_CUT_HEIGHT_MM = 1219;

/** The voids cut in `hostId` by the elements hosted on it, in id order. */
export function hostVoidsOf(elements: Elements, hostId: string): HostVoid[] {
  const host = elements[hostId];
  if (!host) return [];
  const out: HostVoid[] = [];
  for (const id of [...hostedIds(elements, hostId)].sort()) {
    const el = elements[id];
    const row = el ? hostVoidRow(el.kind) : null;
    const v = el && row ? row.voidOf(el, host, elements) : null;
    if (v) out.push(v);
  }
  return out;
}

/** A void's area in its host's face, m². */
export function voidAreaM2(v: HostVoid): number {
  let s = 0;
  for (let i = 0; i < v.profile.length; i++) {
    const a = v.profile[i] as Vec2;
    const b = v.profile[(i + 1) % v.profile.length] as Vec2;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2) / 1e6;
}

interface Span {
  /** Along the host from its start, mm. */
  readonly a: number;
  readonly b: number;
  /** Up from the host's base, mm. */
  readonly lo: number;
  readonly hi: number;
}

function spanOf(v: HostVoid): Span {
  let a = Infinity;
  let b = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of v.profile) {
    a = Math.min(a, p.x);
    b = Math.max(b, p.x);
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  return { a, b, lo, hi };
}

/** The host's outline between `s0` and `s1` along it (open ends keep the joined faces). */
function outlineBetween(j: LineJoins, s0: number, s1: number): Vec2[] | null {
  const l0 = Math.max(j.faces.startLeft, s0);
  const l1 = Math.min(j.faces.endLeft, s1);
  const r0 = Math.max(j.faces.startRight, s0);
  const r1 = Math.min(j.faces.endRight, s1);
  if (l1 - l0 < 1e-6 && r1 - r0 < 1e-6) return null;
  const at = (d: number, side: 1 | -1): Vec2 => ({ x: j.start.x + j.u.x * d + j.n.x * side * (j.widthMm / 2), y: j.start.y + j.u.y * d + j.n.y * side * (j.widthMm / 2) });
  return [at(l0, 1), at(l1, 1), at(r1, -1), at(r0, -1)];
}

/**
 * One upright block of a host's body: a plan outline from `z0` to `z1` above
 * its base (above its level, when built from a body profile). A tilted end is
 * a sloped plane through that height (`Tilt`).
 */
export interface HostBlock {
  readonly outline: readonly Vec2[];
  readonly z0: number;
  readonly z1: number;
  readonly tilt0?: Tilt;
  readonly tilt1?: Tilt;
}

/**
 * A line-placed host's body with its ends joined and its voids cut out, as
 * blocks: full height between voids, under each sill and over each head.
 * Null when nothing joins it and nothing cuts it (draw it as it always was).
 *
 * With `profile` (a wall whose top or base follows a surface that isn't
 * level along it, `Wall.bodyProfile`) the blocks are measured from the host's
 * level and always returned: one run of blocks per stretch of the profile,
 * each with its base and top tilted along the host. A void's sill and head
 * stay measured from the base where the void is.
 */
export function hostSolidBlocks(elements: Elements, host: BimElement, heightMm: number, profile?: readonly WallBodyPoint[] | null): HostBlock[] | null {
  const j = lineJoinsOf(elements, host.id);
  if (!j) return null;
  const voids = hostVoidsOf(elements, host.id);
  if (profile && profile.length >= 2) return profiledBlocks(j, voids.map(spanOf).filter((s) => s.b > s.a && s.hi > s.lo).sort((x, y) => x.a - y.a), profile);
  if (voids.length === 0 && j.cleanups.every((c) => c.style === "free")) return null;
  const spans = voids.map(spanOf).filter((s) => s.b > s.a && s.hi > s.lo).sort((x, y) => x.a - y.a);
  const out: HostBlock[] = [];
  const block = (s0: number, s1: number, z0: number, z1: number): void => {
    if (z1 - z0 < 1e-6) return;
    const outline = outlineBetween(j, s0, s1);
    if (outline) out.push({ outline, z0, z1 });
  };
  let from = -Infinity;
  for (const s of spans) {
    block(from, s.a, 0, heightMm);
    block(s.a, s.b, 0, Math.min(heightMm, Math.max(0, s.lo)));
    block(s.a, s.b, Math.max(0, Math.min(heightMm, s.hi)), heightMm);
    from = Math.max(from, s.b);
  }
  block(from, Infinity, 0, heightMm);
  return out;
}

/** A straight stretch of a body profile, from `a` to `b` along the host: base and top at `ref`, rising linearly. */
interface Stretch {
  readonly a: number;
  readonly b: number;
  readonly ref: number;
  readonly base: number;
  readonly top: number;
  readonly baseRise: number;
  readonly topRise: number;
}

/** The profile's stretches, start to end; the first and last run on past the host's ends (a joined corner reaches beyond them). */
function stretchesOf(profile: readonly WallBodyPoint[]): Stretch[] {
  const out: Stretch[] = [];
  for (let i = 0; i + 1 < profile.length; i++) {
    const p = profile[i] as WallBodyPoint;
    const q = profile[i + 1] as WallBodyPoint;
    const run = q.atMm - p.atMm;
    if (run < 1e-6) continue;
    out.push({ a: p.atMm, b: q.atMm, ref: p.atMm, base: p.baseMm, top: p.topMm, baseRise: (q.baseMm - p.baseMm) / run, topRise: (q.topMm - p.topMm) / run });
  }
  const n = out.length;
  if (n === 0) return out;
  out[0] = { ...(out[0] as Stretch), a: -Infinity };
  out[n - 1] = { ...(out[n - 1] as Stretch), b: Infinity };
  return out;
}

function profiledBlocks(j: LineJoins, spans: readonly Span[], profile: readonly WallBodyPoint[]): HostBlock[] {
  const out: HostBlock[] = [];
  const point = (s: number): Vec2 => ({ x: j.start.x + j.u.x * s, y: j.start.y + j.u.y * s });
  for (const st of stretchesOf(profile)) {
    const at = point(st.ref);
    const tilt = (rise: number): Tilt | undefined => (Math.abs(rise) < 1e-9 ? undefined : { at, rise: { x: j.u.x * rise, y: j.u.y * rise } });
    const baseTilt = tilt(st.baseRise);
    const topTilt = tilt(st.topRise);
    const baseAt = (s: number) => st.base + st.baseRise * (s - st.ref);
    const block = (s0: number, s1: number, z0: number, t0: Tilt | undefined, z1: number, t1: Tilt | undefined): void => {
      const a = Math.max(s0, st.a);
      const b = Math.min(s1, st.b);
      if (b - a < 1e-6) return;
      const outline = outlineBetween(j, a, b);
      if (!outline) return;
      // A block with no height at either end (a head at or over the top) is left out.
      const ends = [Number.isFinite(a) ? a : b - 1, Number.isFinite(b) ? b : a + 1];
      if (ends.every((s) => tiltedZ(z1, t1, point(s)) - tiltedZ(z0, t0, point(s)) < 1e-6)) return;
      out.push({ outline, z0, z1, ...(t0 ? { tilt0: t0 } : {}), ...(t1 ? { tilt1: t1 } : {}) });
    };
    let from = -Infinity;
    for (const s of spans) {
      if (s.b <= st.a || s.a >= st.b) continue;
      block(from, s.a, st.base, baseTilt, st.top, topTilt);
      // A sill follows the base; a head is level, from the base under the void's middle.
      if (s.lo > 0) block(s.a, s.b, st.base, baseTilt, st.base + s.lo, baseTilt);
      block(s.a, s.b, baseAt((s.a + s.b) / 2) + s.hi, undefined, st.top, topTilt);
      from = Math.max(from, s.b);
    }
    block(from, Infinity, st.base, baseTilt, st.top, topTilt);
  }
  return out;
}

/** Along-the-host ranges a plan shows as gaps: voids that span the cut height. */
export function planGapsOf(elements: Elements, hostId: string, cutMm: number = PLAN_CUT_HEIGHT_MM): Array<{ readonly a: number; readonly b: number }> {
  return hostVoidsOf(elements, hostId)
    .map(spanOf)
    .filter((s) => s.lo <= cutMm && s.hi >= cutMm && s.b > s.a)
    .sort((x, y) => x.a - y.a)
    .map((s) => ({ a: s.a, b: s.b }));
}
