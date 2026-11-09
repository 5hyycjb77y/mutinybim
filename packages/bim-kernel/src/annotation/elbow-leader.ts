import type { Vec2 } from "../types";

/**
 * Elbow leaders for tags (U9). All geometry is paper millimetres, so a leader
 * is the same shape at every zoom and on print. Points are snapped to a
 * hundredth of a millimetre and the shoulder is exactly horizontal, so lines
 * stay crisp (no hairline wobble) however far the canvas is zoomed.
 *
 * Drafting convention: the leader leaves the tag at mid-height on the side
 * facing what it points to, runs a short horizontal shoulder, then bends once
 * and goes straight to the element. A hand-placed elbow always wins over the
 * automatic one.
 */

export interface PaperBox {
  readonly min: Vec2;
  readonly max: Vec2;
}

export interface ElbowLeader {
  /** From the tag's edge, through the elbow when there is one, to the target. Two or three points. */
  readonly points: readonly Vec2[];
  /** Which side of the tag the leader leaves from. */
  readonly side: "left" | "right";
  /** The bend, when the leader has one. */
  readonly elbow: Vec2 | null;
  readonly handElbow: boolean;
}

export const SHOULDER_MM = 3;
/** Closer than this (paper mm) the tag sits on its element and draws no leader. */
export const MIN_LEADER_MM = 1.5;
const SNAP = 100;

/** A paper point snapped to 0.01 mm. */
export function snapPaper(p: Vec2): Vec2 {
  return { x: Math.round(p.x * SNAP) / SNAP, y: Math.round(p.y * SNAP) / SNAP };
}

function centre(box: PaperBox): Vec2 {
  return { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 };
}

function inside(box: PaperBox, p: Vec2, pad: number): boolean {
  return p.x >= box.min.x - pad && p.x <= box.max.x + pad && p.y >= box.min.y - pad && p.y <= box.max.y + pad;
}

function assertFinite(label: string, p: Vec2 | undefined): void {
  if (p && (!Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error(`elbowLeaderPath: ${label} is not a finite paper point (${p.x}, ${p.y})`);
}

/**
 * The leader from a tag's head box to its target. `elbow` is a hand-placed
 * bend (paper mm); absent, the leader takes a horizontal shoulder of
 * `shoulderMm` and bends once, or runs straight when the target is level with
 * the tag or nearer than the shoulder. Null when the target is under the tag.
 */
export function elbowLeaderPath(head: PaperBox, target: Vec2, elbow?: Vec2, opts?: { readonly shoulderMm?: number }): ElbowLeader | null {
  assertFinite("target", target);
  assertFinite("elbow", elbow);
  if (inside(head, target, MIN_LEADER_MM)) return null;
  const c = centre(head);
  const toward = elbow ?? target;
  const side: "left" | "right" = toward.x < c.x ? "left" : "right";
  const start = snapPaper({ x: side === "left" ? head.min.x : head.max.x, y: c.y });
  const end = snapPaper(target);
  if (elbow) {
    // A hand elbow within half a millimetre of level with the tag snaps level, so the shoulder reads horizontal.
    const e = snapPaper({ x: elbow.x, y: Math.abs(elbow.y - c.y) < 0.5 ? c.y : elbow.y });
    return { points: [start, e, end], side, elbow: e, handElbow: true };
  }
  const shoulder = opts?.shoulderMm ?? SHOULDER_MM;
  const dir = side === "left" ? -1 : 1;
  const level = Math.abs(end.y - start.y) < 0.5;
  const nearer = (end.x - start.x) * dir <= shoulder;
  if (level || nearer || shoulder <= 0) return { points: [start, end], side, elbow: null, handElbow: false };
  const e = snapPaper({ x: start.x + dir * shoulder, y: start.y });
  return { points: [start, e, end], side, elbow: e, handElbow: false };
}

/** The leader as line pieces, for a drawing list. */
export function elbowLeaderSegments(leader: ElbowLeader): Array<readonly [Vec2, Vec2]> {
  const out: Array<readonly [Vec2, Vec2]> = [];
  for (let i = 1; i < leader.points.length; i++) {
    const a = leader.points[i - 1];
    const b = leader.points[i];
    if (a && b) out.push([a, b]);
  }
  return out;
}

// ── Placing tags clear of each other ─────────────────────────────────────────

export interface ElbowTagRequest {
  readonly id: string;
  /** What the tag points to, paper mm. */
  readonly target: Vec2;
  /** The tag's head size, paper mm. */
  readonly size: { readonly w: number; readonly h: number };
  /** Where a person put it. A hand head never moves; a hand elbow is kept with it. */
  readonly hand?: { readonly head?: Vec2; readonly elbow?: Vec2 };
}

export interface ElbowTagPlacement {
  readonly id: string;
  /** Head centre, paper mm. */
  readonly head: Vec2;
  readonly box: PaperBox;
  readonly leader: ElbowLeader | null;
  readonly source: "hand" | "auto";
  /** False when no candidate was clear and the first one was used (or a hand tag overlaps something). */
  readonly clear: boolean;
}

export interface PlaceTagsOptions {
  /** Paper mm kept between a tag and anything else (default 1). */
  readonly gapMm?: number;
  /** How far each ring of candidates steps out (default 4 mm). */
  readonly stepMm?: number;
  /** Rings of candidates tried before giving up (default 6). */
  readonly rings?: number;
  readonly shoulderMm?: number;
}

const OBSTACLE = "\u0000obstacle:";
/** Half-size of the keep-out square around each tagged element's point, paper mm. */
const TARGET_CLEAR_MM = 0.75;
const KEEP_OUT = "\u0000keep-out:";

type Seg = { readonly a: Vec2; readonly b: Vec2; readonly owner: string };
type Box = PaperBox & { readonly owner: string };

/** A grid over paper so each check reads only the cells it touches. */
class PaperGrid {
  private readonly cells = new Map<string, Array<Box | Seg>>();
  constructor(private readonly cell: number) {}
  private keys(min: Vec2, max: Vec2): string[] {
    const out: string[] = [];
    const x0 = Math.floor(min.x / this.cell);
    const x1 = Math.floor(max.x / this.cell);
    const y0 = Math.floor(min.y / this.cell);
    const y1 = Math.floor(max.y / this.cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  }
  private put(min: Vec2, max: Vec2, o: Box | Seg): void {
    for (const k of this.keys(min, max)) {
      const list = this.cells.get(k);
      if (list) list.push(o);
      else this.cells.set(k, [o]);
    }
  }
  addBox(b: Box): void {
    this.put(b.min, b.max, b);
  }
  addSeg(s: Seg): void {
    this.put({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y) }, { x: Math.max(s.a.x, s.b.x), y: Math.max(s.a.y, s.b.y) }, s);
  }
  /** Whether a box (grown by `gap`) touches any box or leader not owned by `owner`. */
  boxHits(b: PaperBox, gap: number, owner: string): boolean {
    const min = { x: b.min.x - gap, y: b.min.y - gap };
    const max = { x: b.max.x + gap, y: b.max.y + gap };
    for (const k of this.keys(min, max)) {
      for (const o of this.cells.get(k) ?? []) {
        if (o.owner === owner || o.owner === KEEP_OUT + owner) continue;
        if ("min" in o) {
          if (o.min.x < max.x && o.max.x > min.x && o.min.y < max.y && o.max.y > min.y) return true;
        } else if (segmentHitsBox(o.a, o.b, { min, max })) return true;
      }
    }
    return false;
  }
  /** Whether a leader piece crosses another tag's box or another leader. An obstacle or keep-out holding `target` (the tagged element's own outline, a neighbour touching it) does not count. */
  segHits(a: Vec2, b: Vec2, owner: string, target: Vec2): boolean {
    const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
    const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
    for (const k of this.keys(min, max)) {
      for (const o of this.cells.get(k) ?? []) {
        if (o.owner === owner || o.owner === KEEP_OUT + owner) continue;
        if ("min" in o) {
          if ((o.owner.startsWith(OBSTACLE) || o.owner.startsWith(KEEP_OUT)) && inside(o, target, 0)) continue;
          if (segmentHitsBox(a, b, o)) return true;
        } else if (segmentsCross(a, b, o.a, o.b)) return true;
      }
    }
    return false;
  }
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Proper crossing (shared end points and touching ends do not count: leaders to one element may meet there). */
export function segmentsCross(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function segmentHitsBox(a: Vec2, b: Vec2, box: PaperBox): boolean {
  if (inside(box, a, 0) || inside(box, b, 0)) return true;
  const c = [box.min, { x: box.max.x, y: box.min.y }, box.max, { x: box.min.x, y: box.max.y }] as const;
  for (let i = 0; i < 4; i++) {
    const p = c[i];
    const q = c[(i + 1) % 4];
    if (p && q && segmentsCross(a, b, p, q)) return true;
  }
  return false;
}

function boxAt(head: Vec2, size: { readonly w: number; readonly h: number }): PaperBox {
  return { min: { x: head.x - size.w / 2, y: head.y - size.h / 2 }, max: { x: head.x + size.w / 2, y: head.y + size.h / 2 } };
}

/** Candidate directions, in the order tried: above-right first (the drafting habit), then the other diagonals, square to the target, then the in-between slopes. */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, -1],
  [-1, -1],
  [1, 1],
  [-1, 1],
  [1, 0],
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, -0.5],
  [-1, -0.5],
  [1, 0.5],
  [-1, 0.5],
  [0.5, -1],
  [-0.5, -1],
  [0.5, 1],
  [-0.5, 1],
];

/**
 * Candidate heads on rings around the target. Directions pointing away from
 * `centre` (the middle of the tags being placed together) come first, so a
 * crowd of tags fans outward and leaves the middle open for the leaders.
 */
function candidateHeads(r: ElbowTagRequest, gap: number, step: number, rings: number, centre: Vec2): Vec2[] {
  const out: Vec2[] = [];
  const { w, h } = r.size;
  const away = { x: r.target.x - centre.x, y: r.target.y - centre.y };
  const awayLen = Math.hypot(away.x, away.y);
  const dirs =
    awayLen < 1e-6
      ? DIRECTIONS
      : DIRECTIONS.map((d, i) => ({ d, i, score: Math.round(((d[0] * away.x + d[1] * away.y) / (awayLen * Math.hypot(d[0], d[1]))) * 1000) }))
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .map((x) => x.d);
  for (let ring = 1; ring <= rings; ring++) {
    const d = gap + step * ring;
    for (const [dx, dy] of dirs) out.push(snapPaper({ x: r.target.x + dx * (d + w / 2), y: r.target.y + dy * (d + h / 2) }));
  }
  return out;
}

/**
 * Places tags so none overlaps another tag, an obstacle (linework, existing
 * annotation) or another tag's leader, and no leader crosses another tag or
 * leader. Deterministic: hand-placed tags first (they never move and become
 * obstacles), then the rest top to bottom, left to right, each at the first
 * clear candidate on rings around its target. A tag with no clear candidate
 * takes the first one and is reported `clear: false`, so the caller can say
 * which tags need a hand.
 */
export function placeTagsClear(requests: readonly ElbowTagRequest[], obstacles: readonly PaperBox[], opts?: PlaceTagsOptions): ElbowTagPlacement[] {
  const gap = opts?.gapMm ?? 1;
  const step = opts?.stepMm ?? 4;
  const rings = opts?.rings ?? 6;
  if (!(gap >= 0) || !(step > 0) || !Number.isInteger(rings) || rings < 1) throw new Error(`placeTagsClear: gap ${gap}, step ${step} and rings ${rings} must be a gap of at least 0, a positive step and a whole number of rings`);
  const ids = new Set<string>();
  for (const r of requests) {
    if (ids.has(r.id)) throw new Error(`placeTagsClear: tag id ${r.id} is listed twice`);
    ids.add(r.id);
  }
  const auto = requests.filter((r) => !r.hand?.head);
  const centre = auto.length === 0 ? { x: 0, y: 0 } : { x: auto.reduce((t, r) => t + r.target.x, 0) / auto.length, y: auto.reduce((t, r) => t + r.target.y, 0) / auto.length };
  const reach = (r: ElbowTagRequest) => Math.round(Math.hypot(r.target.x - centre.x, r.target.y - centre.y) * 100);
  const tie = (a: ElbowTagRequest, b: ElbowTagRequest) => a.target.y - b.target.y || a.target.x - b.target.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Two orders: the middle of a crowd first (it has the fewest ways out), and the edge first (so the middle's
  // leaders are not walled in). Whichever leaves fewer tags needing a hand wins; a tie keeps middle-first.
  const middleFirst = placePass(requests, [...auto].sort((a, b) => reach(a) - reach(b) || tie(a, b)), obstacles, centre, gap, step, rings, opts?.shoulderMm);
  const unclear = (m: ReadonlyMap<string, ElbowTagPlacement>) => [...m.values()].filter((p) => !p.clear).length;
  let best = middleFirst;
  if (unclear(middleFirst) > 0) {
    const edgeFirst = placePass(requests, [...auto].sort((a, b) => reach(b) - reach(a) || tie(a, b)), obstacles, centre, gap, step, rings, opts?.shoulderMm);
    if (unclear(edgeFirst) < unclear(middleFirst)) best = edgeFirst;
  }
  return requests.map((r) => best.get(r.id) as ElbowTagPlacement);
}

function placePass(requests: readonly ElbowTagRequest[], auto: readonly ElbowTagRequest[], obstacles: readonly PaperBox[], centre: Vec2, gap: number, step: number, rings: number, shoulderMm: number | undefined): Map<string, ElbowTagPlacement> {
  const largest = requests.reduce((m, r) => Math.max(m, r.size.w, r.size.h), 0);
  const grid = new PaperGrid(Math.max(4, largest + gap * 2));
  obstacles.forEach((o, i) => grid.addBox({ min: o.min, max: o.max, owner: `${OBSTACLE}${i}` }));
  // Every element being tagged is a small obstacle for the other tags: no tag sits on, and no leader runs through, another tag's element.
  for (const r of requests) grid.addBox({ min: { x: r.target.x - TARGET_CLEAR_MM, y: r.target.y - TARGET_CLEAR_MM }, max: { x: r.target.x + TARGET_CLEAR_MM, y: r.target.y + TARGET_CLEAR_MM }, owner: `${KEEP_OUT}${r.id}` });
  const placed = new Map<string, ElbowTagPlacement>();
  const commit = (p: ElbowTagPlacement): void => {
    placed.set(p.id, p);
    grid.addBox({ ...p.box, owner: p.id });
    if (p.leader) for (const [a, b] of elbowLeaderSegments(p.leader)) grid.addSeg({ a, b, owner: p.id });
  };
  const hand = requests.filter((r) => r.hand?.head).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of hand) {
    const head = snapPaper(r.hand?.head as Vec2);
    const box = boxAt(head, r.size);
    const leader = elbowLeaderPath(box, r.target, r.hand?.elbow, { shoulderMm });
    const clear = !grid.boxHits(box, 0, r.id) && !(leader && elbowLeaderSegments(leader).some(([a, b]) => grid.segHits(a, b, r.id, r.target)));
    commit({ id: r.id, head, box, leader, source: "hand", clear });
  }
  for (const r of auto) {
    let first: ElbowTagPlacement | null = null;
    let boxClear: ElbowTagPlacement | null = null;
    let chosen: ElbowTagPlacement | null = null;
    for (const head of candidateHeads(r, gap, step, rings, centre)) {
      const box = boxAt(head, r.size);
      const leader = elbowLeaderPath(box, r.target, undefined, { shoulderMm });
      const p: ElbowTagPlacement = { id: r.id, head, box, leader, source: "auto", clear: true };
      first ??= p;
      if (grid.boxHits(box, gap, r.id)) continue;
      boxClear ??= p;
      if (leader && elbowLeaderSegments(leader).some(([a, b]) => grid.segHits(a, b, r.id, r.target))) continue;
      chosen = p;
      break;
    }
    if (!first) throw new Error(`placeTagsClear: no candidate positions for tag ${r.id}`);
    // No fully clear spot: prefer one where only leaders cross over one where tags would sit on each other.
    commit(chosen ?? { ...(boxClear ?? first), clear: false });
  }
  return placed;
}
