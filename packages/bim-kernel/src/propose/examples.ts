import type { ArchitectureCommand } from "../commands/architecture";
import type { Vec2 } from "../types";

/**
 * Worked layouts for the proposers, as the commands that trace them: unit 001
 * of a multifamily building (V1: living room, kitchen with counters, a sink, a
 * range and an island, bedroom, bathroom, hall, laundry, closets) and a
 * restaurant dining room (V4). Tests, the perf gate and the browser drill
 * seed exactly these.
 */

const FT = 304.8;

interface RectRoom {
  readonly id: string;
  readonly number: string;
  readonly name: string;
  /** Feet, wall centrelines. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface Door {
  readonly id: string;
  readonly kind: "door" | "window";
  /** Centre, feet, on a room edge. */
  readonly at: readonly [number, number];
  readonly widthFt: number;
  readonly mark?: string;
}

interface Box {
  readonly id: string;
  readonly typeName: string;
  /** Feet. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const ft = (v: number) => Math.round(v * FT);

/** Walls from the room rectangles: every edge split at every corner on its line, each piece once; the outer boundary 12", inside 5". */
function wallsFor(prefix: string, rooms: readonly RectRoom[]): { walls: ArchitectureCommand["walls"]; wallAt: (p: Vec2) => { wallId: string; offsetMm: number } } {
  const xs = [...new Set(rooms.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(rooms.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const pieces: Array<{ id: string; start: Vec2; end: Vec2; readonly exterior: boolean }> = [];
  for (const y of ys) {
    const spans = rooms.flatMap((r) => (r.y0 === y || r.y1 === y ? [[r.x0, r.x1] as const] : []));
    for (let i = 0; i + 1 < xs.length; i++) {
      const a = xs[i] ?? 0;
      const b = xs[i + 1] ?? 0;
      if (!spans.some(([s, e]) => s <= a && e >= b)) continue;
      const last = pieces[pieces.length - 1];
      if (last && last.start.y === y && last.end.y === y && last.end.x === a) last.end = { x: b, y };
      else pieces.push({ id: `${prefix}-wh-${y}-${a}`, start: { x: a, y }, end: { x: b, y }, exterior: y === minY || y === maxY });
    }
  }
  for (const x of xs) {
    const spans = rooms.flatMap((r) => (r.x0 === x || r.x1 === x ? [[r.y0, r.y1] as const] : []));
    for (let i = 0; i + 1 < ys.length; i++) {
      const a = ys[i] ?? 0;
      const b = ys[i + 1] ?? 0;
      if (!spans.some(([s, e]) => s <= a && e >= b)) continue;
      const last = pieces[pieces.length - 1];
      if (last && last.start.x === x && last.end.x === x && last.end.y === a) last.end = { x, y: b };
      else pieces.push({ id: `${prefix}-wv-${x}-${a}`, start: { x, y: a }, end: { x, y: b }, exterior: x === minX || x === maxX });
    }
  }
  const walls = pieces.map((p) => ({ wallId: p.id, start: { x: ft(p.start.x), y: ft(p.start.y) }, end: { x: ft(p.end.x), y: ft(p.end.y) }, thicknessMm: p.exterior ? 12 * 25.4 : 5 * 25.4, wallType: p.exterior ? "Exterior wall" : "Interior partition" }));
  const wallAt = (p: Vec2) => {
    const hit = pieces.find((w) => (w.start.y === w.end.y ? w.start.y === p.y && p.x > w.start.x && p.x < w.end.x : w.start.x === p.x && p.y > w.start.y && p.y < w.end.y));
    if (!hit) throw new Error(`No wall at (${p.x}, ${p.y}) ft`);
    return { wallId: hit.id, offsetMm: ft(Math.abs(p.x - hit.start.x) + Math.abs(p.y - hit.start.y)) };
  };
  return { walls, wallAt };
}

function layout(prefix: string, levelId: string, rooms: readonly RectRoom[], doors: readonly Door[], casework: readonly Box[], originFt: Vec2 = { x: 0, y: 0 }): ArchitectureCommand {
  const plain = layoutAtOrigin(prefix, levelId, rooms, doors, casework);
  if (originFt.x === 0 && originFt.y === 0) return plain;
  const d = { x: ft(originFt.x), y: ft(originFt.y) };
  const move = (p: Vec2) => ({ x: p.x + d.x, y: p.y + d.y });
  return { ...plain, walls: plain.walls.map((w) => ({ ...w, start: move(w.start), end: move(w.end) })), rooms: plain.rooms.map((r) => ({ ...r, outline: r.outline.map(move) })), casework: plain.casework.map((c) => ({ ...c, position: move(c.position) })) };
}

function layoutAtOrigin(prefix: string, levelId: string, rooms: readonly RectRoom[], doors: readonly Door[], casework: readonly Box[]): ArchitectureCommand {
  const { walls, wallAt } = wallsFor(prefix, rooms);
  return {
    type: "add_architecture",
    levelId,
    walls,
    openings: doors.map((d) => {
      const w = wallAt({ x: d.at[0], y: d.at[1] });
      return { openingId: d.id, wallId: w.wallId, kind: d.kind, offsetMm: w.offsetMm, widthMm: ft(d.widthFt), ...(d.mark ? { mark: d.mark } : {}) };
    }),
    rooms: rooms.map((r) => ({ roomId: r.id, number: r.number, name: r.name, outline: [{ x: ft(r.x0), y: ft(r.y0) }, { x: ft(r.x1), y: ft(r.y0) }, { x: ft(r.x1), y: ft(r.y1) }, { x: ft(r.x0), y: ft(r.y1) }] })),
    casework: casework.map((c) => ({ componentId: c.id, typeName: c.typeName, position: { x: ft((c.x0 + c.x1) / 2), y: ft((c.y0 + c.y1) / 2) }, size: { x: ft(c.x1 - c.x0), y: ft(c.y1 - c.y0) } })),
  };
}

/** Unit 001, 28' x 28', walls on centrelines, its corner at `originFt`. Room ids are `${prefix}-<room>`. */
export function unit001Architecture(levelId: string, prefix = "u001", originFt: Vec2 = { x: 0, y: 0 }): ArchitectureCommand {
  const r = (id: string, number: string, name: string, x0: number, y0: number, x1: number, y1: number): RectRoom => ({ id: `${prefix}-${id}`, number, name, x0, y0, x1, y1 });
  const rooms = [
    r("living", "001-1", "Living room", 0, 0, 16, 14),
    r("kitchen", "001-2", "Kitchen", 16, 0, 28, 14),
    r("entry", "001-3", "Coat closet", 0, 14, 8, 18),
    r("hall", "001-4", "Hall", 8, 14, 28, 18),
    r("bed", "001-5", "Bedroom", 0, 18, 12, 28),
    r("bath", "001-6", "Bathroom", 12, 18, 20, 28),
    r("closet", "001-7", "Closet", 20, 18, 23, 28),
    r("laundry", "001-8", "Laundry", 23, 18, 28, 28),
  ];
  const d = (id: string, kind: "door" | "window", x: number, y: number, w: number): Door => ({ id: `${prefix}-${id}`, kind, at: [x, y], widthFt: w, mark: id.toUpperCase() });
  const doors = [
    d("d1", "door", 3, 0, 3),
    d("d2", "door", 16, 10, 3),
    d("d3", "door", 13.5, 14, 3),
    d("d4", "door", 9.5, 18, 2.67),
    d("d5", "door", 14, 18, 2.5),
    d("d6", "door", 21.5, 18, 2),
    d("d7", "door", 25.5, 18, 2.5),
    d("d8", "door", 4, 14, 2.5),
    d("w1", "window", 0, 7, 5),
    d("w2", "window", 0, 23, 4),
    d("w3", "window", 22, 0, 4),
  ];
  const c = (id: string, typeName: string, x0: number, y0: number, x1: number, y1: number): Box => ({ id: `${prefix}-${id}`, typeName, x0, y0, x1, y1 });
  // The kitchen's wall faces: exterior walls 6" thick each side, interior 2.5".
  const casework = [
    c("counter-1", "Base cabinet with countertop", 16.21, 0.5, 24, 2.5),
    c("range", "Range, 30 in", 24, 0.5, 26.5, 2.5),
    c("counter-2", "Base cabinet with countertop", 26.5, 0.5, 27.5, 2.5),
    c("sink", "Kitchen sink, double bowl", 21, 0.6, 23.5, 2.2),
    c("island", "Kitchen island countertop", 19, 6, 25, 9),
    c("lav", "Lavatory in vanity", 16.5, 26, 18.5, 27.5),
    c("vanity", "Vanity countertop", 16, 26, 19, 27.5),
    c("washer", "Washer", 24, 25.5, 26.5, 27.5),
  ];
  return layout(prefix, levelId, rooms, doors, casework, originFt);
}

/** A 40' x 30' restaurant dining room with a 6' double door in front and a 3' kitchen door behind. */
export function restaurantDiningArchitecture(levelId: string, prefix = "rest"): ArchitectureCommand {
  return layout(
    prefix,
    levelId,
    [{ id: `${prefix}-dining`, number: "101", name: "Dining", x0: 0, y0: 0, x1: 40, y1: 30 }],
    [
      { id: `${prefix}-d1`, kind: "door", at: [20, 0], widthFt: 6, mark: "101A" },
      { id: `${prefix}-d2`, kind: "door", at: [34, 30], widthFt: 3, mark: "101B" },
      { id: `${prefix}-w1`, kind: "window", at: [8, 0], widthFt: 8 },
      { id: `${prefix}-w2`, kind: "window", at: [32, 0], widthFt: 8 },
    ],
    [],
  );
}
