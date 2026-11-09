import type { ArchitectureCommand } from "../commands/architecture";
import { distance, dot, sub, unit } from "../geometry";
import type { Vec2 } from "../types";

/**
 * Rooms as a person (or the agent reading the architect's plan) describes
 * them, turned into the one `add_architecture` edit: a wall on every room
 * edge (an edge two rooms share is one wall), each door or window on the
 * wall it sits on, counters and fixtures as rectangles.
 */

export interface TracedRoom {
  readonly number: string;
  readonly name: string;
  /** Corners in order, mm (wall centrelines or faces). */
  readonly outline: readonly Vec2[];
}

export interface TracedOpening {
  readonly kind: "door" | "window";
  /** Centre, mm, on a room edge. */
  readonly at: Vec2;
  readonly widthMm: number;
  readonly mark?: string;
}

export interface TracedBox {
  readonly typeName: string;
  readonly at: Vec2;
  readonly size: Vec2;
  readonly rotationDeg?: number;
}

const NEAR_WALL_MM = 300;

const key = (a: Vec2, b: Vec2) => {
  const p = `${Math.round(a.x)},${Math.round(a.y)}`;
  const q = `${Math.round(b.x)},${Math.round(b.y)}`;
  return p < q ? `${p}|${q}` : `${q}|${p}`;
};

/** The edit that traces these rooms, or why not. Ids start with `prefix` so a second trace never collides with the first. */
export function traceRoomsCommand(levelId: string, prefix: string, rooms: readonly TracedRoom[], openings: readonly TracedOpening[], boxes: readonly TracedBox[], wallThicknessMm = 127): ArchitectureCommand | string {
  if (rooms.length === 0) return "Give at least one room.";
  const walls: Array<{ wallId: string; start: Vec2; end: Vec2; thicknessMm: number }> = [];
  const seen = new Set<string>();
  rooms.forEach((r, i) => {
    r.outline.forEach((a, j) => {
      const b = r.outline[(j + 1) % r.outline.length];
      if (!b || distance(a, b) < 1) return;
      const k = key(a, b);
      if (seen.has(k)) return;
      seen.add(k);
      walls.push({ wallId: `${prefix}-w${i + 1}-${j + 1}`, start: a, end: b, thicknessMm: wallThicknessMm });
    });
  });
  const placed: ArchitectureCommand["openings"] = [];
  for (const [i, o] of openings.entries()) {
    let best: { wallId: string; offset: number; d: number; len: number } | null = null;
    for (const w of walls) {
      const len = distance(w.start, w.end);
      const u = unit(sub(w.end, w.start));
      const t = dot(sub(o.at, w.start), u);
      if (t < 0 || t > len) continue;
      const d = Math.abs((o.at.x - w.start.x) * u.y - (o.at.y - w.start.y) * u.x);
      if (d <= NEAR_WALL_MM && (!best || d < best.d)) best = { wallId: w.wallId, offset: t, d, len };
    }
    if (!best) return `The ${o.kind} at (${Math.round(o.at.x)}, ${Math.round(o.at.y)}) mm isn't on any room edge; put it on the wall it is in.`;
    const offset = Math.min(Math.max(best.offset, o.widthMm / 2), best.len - o.widthMm / 2);
    placed.push({ openingId: `${prefix}-o${i + 1}`, wallId: best.wallId, kind: o.kind, offsetMm: Math.round(offset), widthMm: o.widthMm, ...(o.mark ? { mark: o.mark } : {}) });
  }
  return {
    type: "add_architecture",
    levelId,
    walls,
    openings: placed,
    rooms: rooms.map((r, i) => ({ roomId: `${prefix}-r${i + 1}`, number: r.number, name: r.name, outline: [...r.outline] })),
    casework: boxes.map((b, i) => ({ componentId: `${prefix}-c${i + 1}`, typeName: b.typeName, position: b.at, size: b.size, ...(b.rotationDeg !== undefined ? { rotationDeg: b.rotationDeg } : {}) })),
  };
}
