import type { Vec2 } from "../../types";
import { selfIntersects } from "../space-geometry";

/**
 * Room outlines proposed from a drawing's vector linework (F3 remainder,
 * KERNEL-FOUNDATION §3.4 "Boundary"): pure geometry, no vision model. The
 * host supplies the linework in model millimetres (a calibrated PDF
 * underlay's lines); nothing is written here. The engineer accepts or rejects
 * each proposal.
 *
 * How: the lines are drawn onto a grid; gaps up to `maxOpeningMm` (doors,
 * cased openings) are closed by growing the lines by half that width; every
 * enclosed region that doesn't reach the page edge is a room. Each region is
 * then grown back to the drawn lines (rooms meet inside a door gap), traced
 * as an outline and simplified. Where the outline runs with no drawn line
 * along it, that stretch is an opening, so a proposal keeps its doors.
 *
 * A region whose holes cover a large share of it (the sheet border around a
 * building, the space around a plan) is not a room and is left out.
 */

export const ROOM_DETECTOR_ID = "linework-rooms@1";

export interface LineworkSegment {
  readonly a: Vec2;
  readonly b: Vec2;
}

export interface DetectRoomsOptions {
  /**
   * Gaps in the walls up to this wide are openings, not breaks. Default 1,100 mm (a 3'-0" door with
   * its frame). Rooms narrower than this close up too, so it stays below a corridor's width.
   */
  readonly maxOpeningMm?: number;
  /** Smaller enclosed regions are left out (closets under this, door swings, hatching). Default 2 m². */
  readonly minRoomAreaM2?: number;
  /** A stretch of outline with no drawn line along it at least this long is an opening. Default 400 mm. */
  readonly minOpeningMm?: number;
  /** Grid size cap (memory and time). Default 4,000,000 cells. */
  readonly maxCells?: number;
}

export interface DetectedOpening {
  readonly a: Vec2;
  readonly b: Vec2;
  /** About how wide the gap is, mm. */
  readonly widthMm: number;
}

export interface DetectedRoomOutline {
  /** Stable while the drawing doesn't change: the rounded centre. */
  readonly key: string;
  /** Model mm, counter-clockwise. */
  readonly outline: readonly Vec2[];
  readonly areaM2: number;
  readonly centre: Vec2;
  readonly openings: readonly DetectedOpening[];
  /** 0–1: the share of the outline that runs along a drawn line. */
  readonly confidence: number;
}

export type DetectRoomsResult =
  | { readonly ok: true; readonly rooms: readonly DetectedRoomOutline[]; readonly cellMm: number }
  | { readonly ok: false; readonly reason: string };

const MIN_CELL_MM = 50;
/** A floor plan wider than this is not at the scale it says. */
const MAX_SPAN_MM = 2_000_000;
const MIN_SPAN_MM = 1_000;
/** Holes covering more than this share of a region mean it surrounds other things (a sheet border), not a room. */
const MAX_HOLE_SHARE = 0.2;
const BUCKET_MM = 1000;

const WALL = 1;

/** Room outlines proposed from linework (model mm). Pure; nothing is stored. */
export function detectRoomOutlines(segments: readonly LineworkSegment[], options: DetectRoomsOptions = {}): DetectRoomsResult {
  const maxOpening = options.maxOpeningMm ?? 1100;
  const minArea = (options.minRoomAreaM2 ?? 2) * 1e6;
  const minOpening = options.minOpeningMm ?? 400;
  const maxCells = options.maxCells ?? 4_000_000;
  const drawn = segments.filter((s) => Number.isFinite(s.a.x) && Number.isFinite(s.a.y) && Number.isFinite(s.b.x) && Number.isFinite(s.b.y) && (s.a.x !== s.b.x || s.a.y !== s.b.y));
  // Door swings are arcs (a PDF exports them as short pieces); they would wall off the doorway they show.
  const lines = withoutArcs(drawn);
  if (lines.length === 0) return { ok: false, reason: "This page has no drawn lines to find rooms in (it may be a scanned picture). Draw the spaces by hand with Draw space" };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of lines) {
    minX = Math.min(minX, s.a.x, s.b.x);
    minY = Math.min(minY, s.a.y, s.b.y);
    maxX = Math.max(maxX, s.a.x, s.b.x);
    maxY = Math.max(maxY, s.a.y, s.b.y);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  if (span > MAX_SPAN_MM) return { ok: false, reason: `The drawing comes out ${Math.round(span / 304.8).toLocaleString("en-US")} ft across, so its scale is probably wrong. Check the scale, then try again` };
  if (span < MIN_SPAN_MM) return { ok: false, reason: `The drawing comes out only ${Math.round((span / 304.8) * 10) / 10} ft across, so its scale is probably wrong. Check the scale, then try again` };

  // Cell size: fine enough to see a wall, coarse enough to stay inside the cap.
  const pad = maxOpening + 4 * MIN_CELL_MM;
  const areaWithPad = (maxX - minX + 2 * pad) * (maxY - minY + 2 * pad);
  const cell = Math.max(MIN_CELL_MM, Math.sqrt(areaWithPad / maxCells));
  const growCells = Math.ceil(maxOpening / 2 / cell);
  const margin = growCells + 2;
  const ox = minX - margin * cell;
  const oy = minY - margin * cell;
  const W = Math.ceil((maxX - minX) / cell) + 2 * margin + 1;
  const H = Math.ceil((maxY - minY) / cell) + 2 * margin + 1;
  const N = W * H;

  // 1. Lines onto the grid.
  const wall = new Uint8Array(N);
  const step = cell / 2;
  for (const s of lines) {
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const i = Math.floor((s.a.x + (s.b.x - s.a.x) * t - ox) / cell);
      const j = Math.floor((s.a.y + (s.b.y - s.a.y) * t - oy) / cell);
      if (i >= 0 && i < W && j >= 0 && j < H) wall[j * W + i] = WALL;
    }
  }

  // 2. Distance from the lines (chamfer 2-3: about twice the distance in cells), so gaps up to maxOpening close.
  const dist = chamfer(wall, W, H);
  // A gap closes when its middle is within half its width of a line on each side.
  const closeAt = maxOpening / (2 * cell) + 0.5;
  const blocked = (k: number) => (dist[k] as number) <= closeAt;

  // 3. Enclosed regions: 4-connected free cells; any region reaching the grid edge is outside.
  const label = new Int32Array(N);
  const OUTSIDE = -1;
  let next = 0;
  const stack = new Int32Array(N);
  const members = new Int32Array(N);
  const sizes: number[] = [0];
  for (let start = 0; start < N; start++) {
    if (label[start] !== 0 || blocked(start)) continue;
    next += 1;
    let top = 0;
    let count = 0;
    let edge = false;
    label[start] = next;
    stack[top++] = start;
    while (top > 0) {
      const k = stack[--top] as number;
      members[count++] = k;
      const i = k % W;
      if (i === 0 || i === W - 1 || k < W || k >= N - W) edge = true;
      if (i > 0 && label[k - 1] === 0 && !blocked(k - 1)) {
        label[k - 1] = next;
        stack[top++] = k - 1;
      }
      if (i < W - 1 && label[k + 1] === 0 && !blocked(k + 1)) {
        label[k + 1] = next;
        stack[top++] = k + 1;
      }
      if (k >= W && label[k - W] === 0 && !blocked(k - W)) {
        label[k - W] = next;
        stack[top++] = k - W;
      }
      if (k < N - W && label[k + W] === 0 && !blocked(k + W)) {
        label[k + W] = next;
        stack[top++] = k + W;
      }
    }
    if (edge) for (let m = 0; m < count; m++) label[members[m] as number] = OUTSIDE;
    sizes.push(edge ? 0 : count);
  }

  // 4. Grow every region (outside too, so a room can't leak through a door to the outside) out to the drawn lines:
  //    breadth first, so rooms on both sides of a door meet in its middle.
  let front = new Int32Array(N);
  let frontLen = 0;
  for (let k = 0; k < N; k++) if (label[k] !== 0) front[frontLen++] = k;
  let grown = new Int32Array(N);
  while (frontLen > 0) {
    let grownLen = 0;
    for (let f = 0; f < frontLen; f++) {
      const k = front[f] as number;
      const l = label[k] as number;
      const i = k % W;
      if (i > 0 && label[k - 1] === 0 && wall[k - 1] !== WALL) {
        label[k - 1] = l;
        grown[grownLen++] = k - 1;
      }
      if (i < W - 1 && label[k + 1] === 0 && wall[k + 1] !== WALL) {
        label[k + 1] = l;
        grown[grownLen++] = k + 1;
      }
      if (k >= W && label[k - W] === 0 && wall[k - W] !== WALL) {
        label[k - W] = l;
        grown[grownLen++] = k - W;
      }
      if (k < N - W && label[k + W] === 0 && wall[k + W] !== WALL) {
        label[k + W] = l;
        grown[grownLen++] = k + W;
      }
    }
    const swap = front;
    front = grown;
    grown = swap;
    frontLen = grownLen;
  }

  // 5. Outline each room, find its openings, simplify.
  const buckets = bucketSegments(lines);
  const backTol = 1.5 * cell + 30;
  // Cells by room (counting sort): one pass to count, one to place.
  const counts = new Int32Array(next + 2);
  for (let k = 0; k < N; k++) {
    const l = label[k] as number;
    if (l > 0 && (sizes[l] ?? 0) > 0) counts[l + 1] = (counts[l + 1] as number) + 1;
  }
  for (let l = 1; l < counts.length; l++) counts[l] = (counts[l] as number) + (counts[l - 1] as number);
  const order = new Int32Array(counts[counts.length - 1] as number);
  const fill = counts.slice();
  for (let k = 0; k < N; k++) {
    const l = label[k] as number;
    if (l <= 0 || (sizes[l] ?? 0) === 0) continue;
    const slot = fill[l] as number;
    order[slot] = k;
    fill[l] = slot + 1;
  }
  const cellsOf = new Map<number, Int32Array>();
  for (let l = 1; l <= next; l++) {
    const from = counts[l] as number;
    const to = counts[l + 1] as number;
    if (to > from) cellsOf.set(l, order.subarray(from, to));
  }
  const rooms: DetectedRoomOutline[] = [];
  const toModel = (v: GridPoint): Vec2 => ({ x: ox + v.i * cell, y: oy + v.j * cell });
  for (const [l, cells] of cellsOf) {
    const area = cells.length * cell * cell;
    if (area < minArea) continue;
    const loops = boundaryLoops(cells, label, l, W, H);
    let outer: GridPoint[] | null = null;
    let outerArea = 0;
    let holes = 0;
    for (const loop of loops) {
      const a = gridArea(loop);
      if (a > outerArea) {
        if (outer) holes += outerArea;
        outer = loop;
        outerArea = a;
      } else holes += Math.abs(a);
    }
    if (!outer || holes > MAX_HOLE_SHARE * outerArea) continue;
    const raw = outer.map(toModel);
    const { openings, backed, perimeter } = openingsAlong(raw, buckets, backTol, minOpening);
    const outline = simplifyRing(raw, Math.max(1.5 * cell, 120));
    let sx = 0;
    let sy = 0;
    for (const p of outline) {
      sx += p.x;
      sy += p.y;
    }
    const centre = { x: Math.round(sx / outline.length), y: Math.round(sy / outline.length) };
    rooms.push({
      key: `room:${Math.round(centre.x / 100)}:${Math.round(centre.y / 100)}`,
      outline,
      areaM2: Math.round(ringArea(outline) / 1e4) / 100,
      centre,
      openings,
      confidence: perimeter > 0 ? Math.round((backed / perimeter) * 100) / 100 : 0,
    });
  }
  rooms.sort((a, b) => b.centre.y - a.centre.y || a.centre.x - b.centre.x);
  return { ok: true, rooms, cellMm: Math.round(cell * 10) / 10 };
}

interface GridPoint {
  readonly i: number;
  readonly j: number;
}

/** Two-pass chamfer distance (orthogonal 2, diagonal 3) from the wall cells. */
function chamfer(wall: Uint8Array, W: number, H: number): Uint32Array {
  const BIG = 0x3fffffff;
  const d = new Uint32Array(W * H);
  for (let k = 0; k < d.length; k++) d[k] = wall[k] === WALL ? 0 : BIG;
  const at = (i: number, j: number) => d[j * W + i] as number;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      let v = d[k] as number;
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, at(i - 1, j) + 2);
      if (j > 0) {
        v = Math.min(v, at(i, j - 1) + 2);
        if (i > 0) v = Math.min(v, at(i - 1, j - 1) + 3);
        if (i < W - 1) v = Math.min(v, at(i + 1, j - 1) + 3);
      }
      d[k] = v;
    }
  }
  for (let j = H - 1; j >= 0; j--) {
    for (let i = W - 1; i >= 0; i--) {
      const k = j * W + i;
      let v = d[k] as number;
      if (v === 0) continue;
      if (i < W - 1) v = Math.min(v, at(i + 1, j) + 2);
      if (j < H - 1) {
        v = Math.min(v, at(i, j + 1) + 2);
        if (i < W - 1) v = Math.min(v, at(i + 1, j + 1) + 3);
        if (i > 0) v = Math.min(v, at(i - 1, j + 1) + 3);
      }
      d[k] = v;
    }
  }
  // Chamfer units are half-cells: halve so `closeAt` compares in cells.
  for (let k = 0; k < d.length; k++) d[k] = (d[k] as number) / 2;
  return d;
}

/** The region's boundary as closed loops on the cell corners, region on the left (outer counter-clockwise, holes clockwise). */
function boundaryLoops(cells: Int32Array, label: Int32Array, l: number, W: number, H: number): GridPoint[][] {
  const inRegion = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && label[j * W + i] === l;
  const from: number[] = [];
  const to: number[] = [];
  const V = W + 1;
  const vkey = (i: number, j: number) => j * V + i;
  for (const k of cells) {
    const i = k % W;
    const j = (k - i) / W;
    if (!inRegion(i, j - 1)) {
      from.push(vkey(i, j));
      to.push(vkey(i + 1, j));
    }
    if (!inRegion(i + 1, j)) {
      from.push(vkey(i + 1, j));
      to.push(vkey(i + 1, j + 1));
    }
    if (!inRegion(i, j + 1)) {
      from.push(vkey(i + 1, j + 1));
      to.push(vkey(i, j + 1));
    }
    if (!inRegion(i - 1, j)) {
      from.push(vkey(i, j + 1));
      to.push(vkey(i, j));
    }
  }
  const starts = new Map<number, number[]>();
  for (let e = 0; e < from.length; e++) {
    const key = from[e] as number;
    const list = starts.get(key);
    if (list) list.push(e);
    else starts.set(key, [e]);
  }
  const used = new Uint8Array(from.length);
  const pt = (key: number): GridPoint => ({ i: key % V, j: Math.floor(key / V) });
  const loops: GridPoint[][] = [];
  for (let e0 = 0; e0 < from.length; e0++) {
    if (used[e0]) continue;
    const loop: GridPoint[] = [];
    let e = e0;
    for (;;) {
      used[e] = 1;
      const a = pt(from[e] as number);
      const b = pt(to[e] as number);
      loop.push(a);
      const dx = b.i - a.i;
      const dy = b.j - a.j;
      const options = (starts.get(to[e] as number) ?? []).filter((c) => !used[c]);
      if (options.length === 0) break;
      // Prefer a left turn, then straight on, then right: loops stay simple where two cells touch at a corner.
      const turn = (c: number) => {
        const p = pt(from[c] as number);
        const q = pt(to[c] as number);
        const ex = q.i - p.i;
        const ey = q.j - p.j;
        if (ex === -dy && ey === dx) return 0;
        if (ex === dx && ey === dy) return 1;
        return 2;
      };
      options.sort((x, y) => turn(x) - turn(y));
      e = options[0] as number;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

function gridArea(loop: readonly GridPoint[]): number {
  let twice = 0;
  for (let k = 0; k < loop.length; k++) {
    const a = loop[k] as GridPoint;
    const b = loop[(k + 1) % loop.length] as GridPoint;
    twice += a.i * b.j - b.i * a.j;
  }
  return twice / 2;
}

function ringArea(ring: readonly Vec2[]): number {
  let twice = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k] as Vec2;
    const b = ring[(k + 1) % ring.length] as Vec2;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice / 2);
}

type Buckets = Map<number, LineworkSegment[]>;

const bucketKey = (i: number, j: number) => i * 1_000_003 + j;

function bucketSegments(lines: readonly LineworkSegment[]): Buckets {
  const out: Buckets = new Map();
  for (const s of lines) {
    const i0 = Math.floor(Math.min(s.a.x, s.b.x) / BUCKET_MM);
    const i1 = Math.floor(Math.max(s.a.x, s.b.x) / BUCKET_MM);
    const j0 = Math.floor(Math.min(s.a.y, s.b.y) / BUCKET_MM);
    const j1 = Math.floor(Math.max(s.a.y, s.b.y) / BUCKET_MM);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = bucketKey(i, j);
        const list = out.get(key);
        if (list) list.push(s);
        else out.set(key, [s]);
      }
    }
  }
  return out;
}

function distToSegment(p: Vec2, s: LineworkSegment): number {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2));
  return Math.hypot(p.x - (s.a.x + t * dx), p.y - (s.a.y + t * dy));
}

function nearLine(p: Vec2, buckets: Buckets, tol: number): boolean {
  const i = Math.floor(p.x / BUCKET_MM);
  const j = Math.floor(p.y / BUCKET_MM);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const list = buckets.get(bucketKey(i + di, j + dj));
      if (list) for (const s of list) if (distToSegment(p, s) <= tol) return true;
    }
  }
  return false;
}

/** Stretches of the raw outline with no drawn line along them (openings), and how much of it has one. */
function openingsAlong(raw: readonly Vec2[], buckets: Buckets, tol: number, minOpening: number): { openings: DetectedOpening[]; backed: number; perimeter: number } {
  const n = raw.length;
  const lens: number[] = [];
  const isBacked: boolean[] = [];
  let perimeter = 0;
  let backed = 0;
  for (let k = 0; k < n; k++) {
    const a = raw[k] as Vec2;
    const b = raw[(k + 1) % n] as Vec2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ok = nearLine({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, buckets, tol);
    lens.push(len);
    isBacked.push(ok);
    perimeter += len;
    if (ok) backed += len;
  }
  const openings: DetectedOpening[] = [];
  const startAt = isBacked.findIndex((b) => b);
  if (startAt < 0) return { openings, backed, perimeter };
  let runStart = -1;
  let runLen = 0;
  for (let step = 1; step <= n; step++) {
    const k = (startAt + step) % n;
    if (!isBacked[k]) {
      if (runStart < 0) runStart = k;
      runLen += lens[k] as number;
      continue;
    }
    if (runStart >= 0 && runLen >= minOpening) {
      const a = raw[runStart] as Vec2;
      const b = raw[k] as Vec2;
      openings.push({ a, b, widthMm: Math.round(Math.hypot(b.x - a.x, b.y - a.y) + 2 * tol) });
    }
    runStart = -1;
    runLen = 0;
  }
  return { openings, backed, perimeter };
}

/** Drop collinear corners, then Douglas-Peucker on the ring; keeps the less simplified ring if simplifying would cross itself. */
function simplifyRing(ring: readonly Vec2[], tol: number): Vec2[] {
  const straight = dropCollinear(ring);
  if (straight.length <= 4) return straight;
  let far = 0;
  let farD = -1;
  const p0 = straight[0] as Vec2;
  for (let k = 1; k < straight.length; k++) {
    const p = straight[k] as Vec2;
    const d = Math.hypot(p.x - p0.x, p.y - p0.y);
    if (d > farD) {
      farD = d;
      far = k;
    }
  }
  const first = douglasPeucker(straight.slice(0, far + 1), tol);
  const second = douglasPeucker([...straight.slice(far), p0], tol);
  const out = [...first.slice(0, -1), ...second.slice(0, -1)];
  return out.length >= 3 && !selfIntersects(out) ? out : straight;
}

function dropCollinear(ring: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const prev = ring[(k - 1 + n) % n] as Vec2;
    const p = ring[k] as Vec2;
    const nextP = ring[(k + 1) % n] as Vec2;
    const cross = (p.x - prev.x) * (nextP.y - p.y) - (p.y - prev.y) * (nextP.x - p.x);
    if (Math.abs(cross) > 1e-6) out.push(p);
  }
  return out;
}

function douglasPeucker(points: readonly Vec2[], tol: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const a = points[0] as Vec2;
  const b = points[points.length - 1] as Vec2;
  let idx = 0;
  let maxD = -1;
  for (let k = 1; k < points.length - 1; k++) {
    const d = distToSegment(points[k] as Vec2, { a, b });
    if (d > maxD) {
      maxD = d;
      idx = k;
    }
  }
  if (maxD <= tol) return [a, b];
  const left = douglasPeucker(points.slice(0, idx + 1), tol);
  const right = douglasPeucker(points.slice(idx), tol);
  return [...left.slice(0, -1), ...right];
}

/** Arc pieces are short and meet end to end at a gentle, steady turn. */
const ARC_PIECE_MAX_MM = 400;
const ARC_TURN_MIN_DEG = 2;
const ARC_TURN_MAX_DEG = 40;
/** A chain of at least this many pieces turning at least this far is an arc (a door swing), not a wall. */
const ARC_MIN_PIECES = 4;
const ARC_MIN_TOTAL_DEG = 45;

/** The linework without arcs (door swings): chains of short pieces that turn steadily. Walls and jambs stay. */
function withoutArcs(lines: readonly LineworkSegment[]): LineworkSegment[] {
  const at = new Map<string, number[]>();
  const key = (p: Vec2) => `${Math.round(p.x)}:${Math.round(p.y)}`;
  lines.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = key(p);
      const list = at.get(k);
      if (list) list.push(i);
      else at.set(k, [i]);
    }
  });
  const short = (s: LineworkSegment) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) <= ARC_PIECE_MAX_MM;
  const links: Array<Array<{ readonly to: number; readonly turn: number }>> = lines.map(() => []);
  for (const [k, ids] of at) {
    if (ids.length !== 2) continue;
    const i = ids[0] as number;
    const j = ids[1] as number;
    const si = lines[i] as LineworkSegment;
    const sj = lines[j] as LineworkSegment;
    if (!short(si) || !short(sj)) continue;
    // Directions: along i into the shared point, then along j out of it.
    const shared = key(si.a) === k ? si.a : si.b;
    const iFar = shared === si.a ? si.b : si.a;
    const jFar = key(sj.a) === k ? sj.b : sj.a;
    const ax = shared.x - iFar.x;
    const ay = shared.y - iFar.y;
    const bx = jFar.x - shared.x;
    const by = jFar.y - shared.y;
    const turn = (Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) * 180) / Math.PI;
    if (turn < ARC_TURN_MIN_DEG || turn > ARC_TURN_MAX_DEG) continue;
    links[i]?.push({ to: j, turn });
    links[j]?.push({ to: i, turn });
  }
  const drop = new Uint8Array(lines.length);
  const seen = new Uint8Array(lines.length);
  for (let start = 0; start < lines.length; start++) {
    if (seen[start] || (links[start]?.length ?? 0) === 0) continue;
    const comp: number[] = [];
    let total = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      comp.push(i);
      for (const l of links[i] ?? []) {
        if (i < l.to) total += l.turn;
        if (!seen[l.to]) {
          seen[l.to] = 1;
          stack.push(l.to);
        }
      }
    }
    if (comp.length >= ARC_MIN_PIECES && total >= ARC_MIN_TOTAL_DEG) for (const i of comp) drop[i] = 1;
  }
  return lines.filter((_, i) => !drop[i]);
}
