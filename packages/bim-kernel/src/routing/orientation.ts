import { dot3, len3, p3, scale3, unit3, add3 } from "./geometry";
import type { RunPoint, RunSize } from "./types";

/**
 * How a rectangular (or flat oval) duct lies along a route.
 *
 * Level and sloped legs carry the width level; a riser takes the width of the
 * leg it rises from. An elbow turns the duct about its width axis (the height
 * bends) or about its height axis (the width bends). A turn about any other
 * axis twists the duct, and no single elbow makes it. A turn out of a riser
 * onto a leg square to the one it rose from bends the width, which leaves the
 * duct on its side: the route then needs a transition back to its size.
 */

const cross3 = (a: RunPoint, b: RunPoint): RunPoint => p3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const Z = p3(0, 0, 1);
const PARALLEL = 0.999;

const plumb = (d: RunPoint): boolean => Math.abs(unit3(d).z) >= PARALLEL;

/** The width axis of a level or sloped leg. */
export function levelWidthAxis(d: RunPoint): RunPoint {
  return unit3(cross3(Z, unit3(d)));
}

function rotate(v: RunPoint, k: RunPoint, angle: number): RunPoint {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add3(add3(scale3(v, c), scale3(cross3(k, v), s)), scale3(k, dot3(k, v) * (1 - c)));
}

/** True when the duct has two different sides (so which way it lies matters). */
export function hasSides(size: RunSize): boolean {
  return (size.shape === "rect" || size.shape === "oval") && Math.abs(size.width - size.height) > 0.5;
}

/** The size that a duct of `size` reads as when it lies on its side. */
export function onItsSide(size: RunSize): RunSize {
  return size.shape === "rect" ? { shape: "rect", width: size.height, height: size.width } : size;
}

export type FramePlan =
  /** `onSide`: turn indices (0 = the turn at the second point) after which the duct lies on its side until a transition. */
  | { readonly ok: true; readonly onSide: readonly number[]; readonly widthAtEnd: RunPoint }
  | { readonly ok: false; readonly turn: number; readonly reason: string };

/**
 * Walk a route's legs and check every turn is one an elbow can make for this
 * duct. `startWidth`: the width axis of the first leg when it is a riser (from
 * the run it continues, or the leg it turns onto); ignored otherwise.
 */
export function planDuctFrames(legs: readonly RunPoint[], size: RunSize, startWidth: RunPoint | null): FramePlan {
  const first = legs[0];
  if (!first) return { ok: true, onSide: [], widthAtEnd: p3(0, 1, 0) };
  const sided = hasSides(size);
  let w = plumb(first) ? unit3(startWidth ?? (legs[1] && !plumb(legs[1]) ? levelWidthAxis(legs[1]) : p3(0, 1, 0))) : levelWidthAxis(first);
  const onSide: number[] = [];
  for (let i = 0; i + 1 < legs.length; i++) {
    const a = unit3(legs[i] ?? first);
    const c = unit3(legs[i + 1] ?? first);
    const n0 = cross3(a, c);
    if (len3(n0) < 1e-9) continue;
    const n = unit3(n0);
    const h = unit3(cross3(a, w));
    const angle = Math.acos(Math.max(-1, Math.min(1, dot3(a, c))));
    if (Math.abs(dot3(n, w)) >= PARALLEL) {
      // The height bends; the width stays put.
    } else if (Math.abs(dot3(n, h)) >= PARALLEL) {
      w = unit3(rotate(w, n, angle));
    } else if (size.shape === "rect" || size.shape === "oval") {
      return { ok: false, turn: i, reason: `The turn at point ${i + 2} turns sideways and up or down at once, which twists rectangular duct; no single elbow makes it. Turn level first, then rise or drop at a separate point` };
    }
    if (plumb(c)) continue;
    const level = levelWidthAxis(c);
    const along = Math.abs(dot3(w, level));
    if (along >= PARALLEL) {
      w = level;
      continue;
    }
    if (along > 1 - PARALLEL && (size.shape === "rect" || size.shape === "oval")) {
      return { ok: false, turn: i, reason: `The turn at point ${i + 2} would leave the duct tilted on the leg after it; slopes turn only up or down, never sideways` };
    }
    if (sided) {
      if (size.shape === "oval") return { ok: false, turn: i, reason: `Out of the riser at point ${i + 2}, flat oval duct would lie on its side; rise from a leg running the same way as the one it turns onto, or use round duct` };
      onSide.push(i);
    }
    w = level;
  }
  return { ok: true, onSide, widthAtEnd: w };
}
