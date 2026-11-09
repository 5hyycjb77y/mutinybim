/** Screen-space plan snapping. Pure (no three.js), so the light entry can carry it. */

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface SnapCandidate {
  /** Kernel plan millimetres. */
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

/** Snap radius on screen, px. */
export const SNAP_PX = 12;
/** Without a snap, dragged points round to the nearest inch. */
const ROUND_MM = 25.4;

/**
 * A dragged plan point: the nearest candidate within SNAP_PX on screen,
 * otherwise the point rounded to the nearest inch.
 */
export function snapPlanPoint(
  raw: { readonly x: number; readonly y: number },
  candidates: readonly SnapCandidate[],
  toScreen: (x: number, y: number) => ScreenPoint | null,
  pointer: ScreenPoint,
): { x: number; y: number; snappedTo: string | null } {
  let best: { c: SnapCandidate; d: number } | null = null;
  for (const c of candidates) {
    const s = toScreen(c.x, c.y);
    if (!s) continue;
    const d = Math.hypot(s.x - pointer.x, s.y - pointer.y);
    if (d <= SNAP_PX && (!best || d < best.d)) best = { c, d };
  }
  if (best) return { x: best.c.x, y: best.c.y, snappedTo: best.c.label };
  return { x: Math.round(raw.x / ROUND_MM) * ROUND_MM, y: Math.round(raw.y / ROUND_MM) * ROUND_MM, snappedTo: null };
}
