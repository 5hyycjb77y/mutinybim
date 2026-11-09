import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { registerRevisionCarry } from "../revision-carry";
import { recordsOfKinds } from "../store";
import { asElementId, type BimElement, type ElementId, type Vec2 } from "../types";
import { DISALLOW_JOIN_KEYS, LINE_JOIN_POINT, type EndCleanup, type LineJoinRow } from "./contract";

/**
 * The join solve (`kernel.line_join`): where line-placed elements meet and
 * how each end is cleaned up. Derived, never stored.
 *
 * An endpoint index per level (a spatial hash of each joinable line's box)
 * is built once per element record and carried to the next revision by
 * moving only the lines that changed, so an edit re-joins only the elements
 * near the edited ends: a query reads one cell.
 *
 * Each end of a line is one of:
 * - `free`: nothing meets it (or its "Disallow join" value is on);
 * - `butt`: one other end meets it; the higher priority runs to the outer
 *   corner, the lower stops at its inner face (straight continuations stay
 *   as drawn);
 * - `miter`: as butt, both faces cut on the bisector, when both rows allow
 *   it and the higher's default is miter;
 * - `tee`: it stops against another's face, that one running through;
 * - `cross`: three or more meet; the highest priority (and anything in line
 *   with it) runs through, the rest stop at its faces.
 */

type Elements = Readonly<Record<string, BimElement>>;

/** Ends always meet this close (and up to the thinner one's half width); an end this close to another's face tees into it. */
export const JOIN_TOLERANCE_MM = 5;
const CELL_MM = 4000;
/** A join that would stretch an end further than this many widths is drawn as a butt instead (a very sharp angle). */
const MAX_REACH_WIDTHS = 4;
const MAX_DEPTH = 64;

interface JoinLine {
  readonly id: string;
  readonly kind: string;
  readonly start: Vec2;
  readonly end: Vec2;
  readonly widthMm: number;
  readonly levelId: string;
}

interface Layer {
  readonly parent: Layer | null;
  readonly lines: ReadonlyMap<string, JoinLine | null>;
  readonly cells: ReadonlyMap<string, readonly string[]>;
  readonly depth: number;
}

type Table = ReadonlyMap<string, LineJoinRow>;
const NONE: readonly string[] = Object.freeze([]);

const tableOf = (set: PackSet): Table => new Map(set.items(LINE_JOIN_POINT).map((r) => [r.kind, r] as const));
const tableIn = (set: PackSet): Table => set.memo("kernel.line_join#table", tableOf);

function lineOf(row: LineJoinRow, el: BimElement, elements: Elements): JoinLine | null {
  const l = row.line(el, elements);
  if (!l || !Number.isFinite(l.start.x + l.start.y + l.end.x + l.end.y + l.widthMm)) return null;
  if (Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y) < 1e-6) return null;
  return { id: el.id, kind: el.kind, start: l.start, end: l.end, widthMm: Math.max(0, l.widthMm), levelId: l.levelId };
}

function cellKeys(line: JoinLine): string[] {
  const pad = line.widthMm / 2 + JOIN_TOLERANCE_MM;
  const x0 = Math.floor((Math.min(line.start.x, line.end.x) - pad) / CELL_MM);
  const x1 = Math.floor((Math.max(line.start.x, line.end.x) + pad) / CELL_MM);
  const y0 = Math.floor((Math.min(line.start.y, line.end.y) - pad) / CELL_MM);
  const y1 = Math.floor((Math.max(line.start.y, line.end.y) + pad) / CELL_MM);
  const out: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${line.levelId}|${x}|${y}`);
  return out;
}

function pointKey(levelId: string, p: Vec2): string {
  return `${levelId}|${Math.floor(p.x / CELL_MM)}|${Math.floor(p.y / CELL_MM)}`;
}

function lookupLine(layer: Layer, id: string): JoinLine | null {
  for (let l: Layer | null = layer; l; l = l.parent) {
    const hit = l.lines.get(id);
    if (hit !== undefined) return hit;
  }
  return null;
}

function lookupCell(layer: Layer, key: string): readonly string[] {
  for (let l: Layer | null = layer; l; l = l.parent) {
    const hit = l.cells.get(key);
    if (hit) return hit;
  }
  return NONE;
}

function build(elements: Elements, table: Table): Layer {
  const lines = new Map<string, JoinLine | null>();
  const cells = new Map<string, string[]>();
  if (table.size > 0) {
    for (const el of recordsOfKinds(elements, [...table.keys()])) {
      const row = table.get(el.kind);
      const line = row ? lineOf(row, el, elements) : null;
      if (!line) continue;
      lines.set(el.id, line);
      for (const key of cellKeys(line)) {
        const list = cells.get(key);
        if (list) list.push(el.id);
        else cells.set(key, [el.id]);
      }
    }
  }
  return { parent: null, lines, cells, depth: 0 };
}

function fold(layer: Layer): Layer {
  const chain: Layer[] = [];
  for (let l: Layer | null = layer; l; l = l.parent) chain.push(l);
  const lines = new Map<string, JoinLine | null>();
  const cells = new Map<string, readonly string[]>();
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const [k, v] of chain[i]?.lines ?? []) lines.set(k, v);
    for (const [k, v] of chain[i]?.cells ?? []) cells.set(k, v);
  }
  return { parent: null, lines, cells, depth: 0 };
}

const sameLine = (a: JoinLine | null, b: JoinLine | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.levelId === b.levelId && a.widthMm === b.widthMm && a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y);

function derive(base: Layer, to: Elements, changedIds: readonly string[], table: Table): Layer {
  const lines = new Map<string, JoinLine | null>();
  const cells = new Map<string, string[]>();
  const cellFor = (key: string): string[] => {
    let list = cells.get(key);
    if (!list) {
      list = [...lookupCell(base, key)];
      cells.set(key, list);
    }
    return list;
  };
  for (const id of changedIds) {
    const was = lookupLine(base, id);
    const el = to[id];
    const row = el ? table.get(el.kind) : undefined;
    const now = el && row ? lineOf(row, el, to) : null;
    if (sameLine(was, now)) continue;
    if (was) {
      for (const key of cellKeys(was)) {
        const list = cellFor(key);
        const at = list.indexOf(id);
        if (at >= 0) list.splice(at, 1);
      }
    }
    if (now) for (const key of cellKeys(now)) cellFor(key).push(id);
    lines.set(id, now);
  }
  if (lines.size === 0) return base;
  const next: Layer = { parent: base, lines, cells, depth: base.depth + 1 };
  return next.depth > MAX_DEPTH ? fold(next) : next;
}

const cache = new WeakMap<Elements, Map<PackSet, Layer>>();

function indexFor(elements: Elements, set: PackSet): Layer {
  let held = cache.get(elements);
  const hit = held?.get(set);
  if (hit) return hit;
  const layer = build(elements, tableIn(set));
  if (!held) {
    held = new Map();
    cache.set(elements, held);
  }
  held.set(set, layer);
  return layer;
}

registerRevisionCarry("kernel.line_join", (from, to, changedIds) => {
  const held = cache.get(from);
  if (!held) return;
  let target = cache.get(to);
  for (const [set, layer] of held) {
    if (target?.has(set)) continue;
    if (!target) {
      target = new Map();
      cache.set(to, target);
    }
    target.set(set, derive(layer, to, changedIds, tableIn(set)));
  }
});

// ── geometry ────────────────────────────────────────────────────────────────

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

interface Frame {
  readonly line: JoinLine;
  readonly u: Vec2;
  /** Left of travel. */
  readonly n: Vec2;
  readonly half: number;
  readonly length: number;
}

function frameOf(line: JoinLine): Frame {
  const d = sub(line.end, line.start);
  const length = Math.hypot(d.x, d.y);
  const u = mul(d, 1 / length);
  return { line, u, n: { x: -u.y, y: u.x }, half: line.widthMm / 2, length };
}

/** Distance along `a` (from its start) where its face `side` (1 left, -1 right) crosses `b`'s face `bSide`; null when parallel. */
function faceMeet(a: Frame, side: 1 | -1, b: Frame, bSide: 1 | -1): number | null {
  const f0 = add(a.line.start, mul(a.n, side * a.half));
  const q0 = add(b.line.start, mul(b.n, bSide * b.half));
  const denom = cross(a.u, b.u);
  if (Math.abs(denom) < 1e-9) return null;
  return cross(sub(q0, f0), b.u) / denom;
}

/** The face of `b` that faces a body running from the join in direction `d`. */
const faceToward = (b: Frame, d: Vec2): 1 | -1 => (dot(b.n, d) >= 0 ? 1 : -1);

type End = "start" | "end";
interface EndSolve {
  readonly style: EndCleanup["style"];
  readonly with: readonly string[];
  /** Distance along the line where its left / right face ends. */
  readonly left: number;
  readonly right: number;
}

interface Meeting {
  readonly frame: Frame;
  /** The other's end at the join, or null when the join sits along its face (it runs through). */
  readonly end: End | null;
}

function instanceTrue(el: BimElement | undefined, key: string): boolean {
  if (!el || !("values" in el)) return false;
  const values: unknown = el.values;
  return typeof values === "object" && values !== null && (values as Readonly<Record<string, unknown>>)[key] === true;
}

interface Ctx {
  readonly elements: Elements;
  readonly table: Table;
  readonly layer: Layer;
}

function priorityOf(ctx: Ctx, f: Frame): number {
  const el = ctx.elements[f.line.id];
  const row = ctx.table.get(f.line.kind);
  const p = el && row ? row.priority(el, ctx.elements) : 0;
  return Number.isFinite(p) ? p : 0;
}

/** True when `a` outranks `b`: higher priority, then the lower id. */
function outranks(ctx: Ctx, a: Frame, b: Frame): boolean {
  const pa = priorityOf(ctx, a);
  const pb = priorityOf(ctx, b);
  return pa !== pb ? pa > pb : a.line.id < b.line.id;
}

function canJoin(table: Table, a: string, b: string): boolean {
  return a === b || (table.get(a)?.joinsWith?.includes(b) ?? false) || (table.get(b)?.joinsWith?.includes(a) ?? false);
}

function meetingsAt(ctx: Ctx, me: Frame, p: Vec2): Meeting[] {
  const out: Meeting[] = [];
  for (const id of lookupCell(ctx.layer, pointKey(me.line.levelId, p))) {
    if (id === me.line.id) continue;
    const other = lookupLine(ctx.layer, id);
    if (!other || other.levelId !== me.line.levelId || !canJoin(ctx.table, me.line.kind, other.kind)) continue;
    const f = frameOf(other);
    const el = ctx.elements[id];
    // Ends a little apart still meet (a wall nudged 10 mm off its corner): up to the thinner one's half width.
    const reach = Math.max(JOIN_TOLERANCE_MM, Math.min(me.half, f.half));
    const toStart = dist(other.start, p);
    const toEnd = dist(other.end, p);
    if (toStart <= reach && toStart <= toEnd) {
      if (!instanceTrue(el, DISALLOW_JOIN_KEYS.start)) out.push({ frame: f, end: "start" });
      continue;
    }
    if (toEnd <= reach) {
      if (!instanceTrue(el, DISALLOW_JOIN_KEYS.end)) out.push({ frame: f, end: "end" });
      continue;
    }
    const t = dot(sub(p, other.start), f.u);
    const off = Math.abs(cross(f.u, sub(p, other.start)));
    if (t > JOIN_TOLERANCE_MM && t < f.length - JOIN_TOLERANCE_MM && off <= f.half + JOIN_TOLERANCE_MM) out.push({ frame: f, end: null });
  }
  return out.sort((a, b) => (a.frame.line.id < b.frame.line.id ? -1 : 1));
}

const bodyDir = (f: Frame, end: End): Vec2 => (end === "start" ? f.u : mul(f.u, -1));
const inLine = (a: Frame, b: Frame): boolean => Math.abs(cross(a.u, b.u)) < 0.02;

function solveEnd(ctx: Ctx, me: Frame, end: End): EndSolve {
  const at = end === "start" ? 0 : me.length;
  const free: EndSolve = { style: "free", with: [], left: at, right: at };
  if (instanceTrue(ctx.elements[me.line.id], DISALLOW_JOIN_KEYS[end])) return free;
  const p = end === "start" ? me.line.start : me.line.end;
  const meets = meetingsAt(ctx, me, p);
  if (meets.length === 0) return free;
  const d = bodyDir(me, end);
  const reach = MAX_REACH_WIDTHS * Math.max(me.line.widthMm, ...meets.map((m) => m.frame.line.widthMm)) + JOIN_TOLERANCE_MM;
  const sane = (s: number | null): number | null => (s !== null && Math.abs(s - at) <= reach ? s : null);
  /** Both faces stop on `other`'s face `side`. */
  const stopAt = (other: Frame, side: 1 | -1): { left: number; right: number } | null => {
    const l = sane(faceMeet(me, 1, other, side));
    const r = sane(faceMeet(me, -1, other, side));
    return l !== null && r !== null ? { left: l, right: r } : null;
  };
  const ids = meets.map((m) => m.frame.line.id);
  const result = (style: EndCleanup["style"], faces: { left: number; right: number } | null): EndSolve => (faces ? { style, with: ids, ...faces } : { style: "butt", with: ids, left: at, right: at });

  const through = meets.filter((m) => m.end === null);
  if (meets.length === 1) {
    const only = meets[0] as Meeting;
    const o = only.frame;
    // Against a face: stop on the face toward this body.
    if (only.end === null) return result("tee", stopAt(o, faceToward(o, d)));
    if (inLine(me, o)) return { style: "butt", with: ids, left: at, right: at };
    const od = bodyDir(o, only.end);
    const meRow = ctx.table.get(me.line.kind);
    const oRow = ctx.table.get(o.line.kind);
    const high = outranks(ctx, me, o) ? meRow : oRow;
    const low = high === meRow ? oRow : meRow;
    if (high?.styles[0] === "miter" && (low?.styles.includes("miter") ?? false)) {
      // Inner face to inner face, outer to outer.
      const inner: 1 | -1 = dot(me.n, od) > 0 ? 1 : -1;
      const oInner = faceToward(o, d);
      const l = sane(faceMeet(me, 1, o, inner === 1 ? oInner : (-oInner as 1 | -1)));
      const r = sane(faceMeet(me, -1, o, inner === -1 ? oInner : (-oInner as 1 | -1)));
      return result("miter", l !== null && r !== null ? { left: l, right: r } : null);
    }
    // The higher runs to the other's outer face; the lower stops at the higher's inner face.
    if (outranks(ctx, me, o)) return result("butt", stopAt(o, (-faceToward(o, d)) as 1 | -1));
    return result("butt", stopAt(o, faceToward(o, d)));
  }

  // Three or more: the highest runs through, with anything in line with it.
  const all: Frame[] = [me, ...meets.map((m) => m.frame)];
  let top = all[0] as Frame;
  for (const f of all) if (outranks(ctx, f, top)) top = f;
  const runsThrough = top === me || (inLine(me, top) && through.length === 0);
  if (!runsThrough) return result("cross", stopAt(top, faceToward(top, d)));
  // Run to the outer face of the one most across it.
  let across: Frame | null = null;
  for (const m of meets) if (!inLine(me, m.frame) && (!across || Math.abs(cross(me.u, m.frame.u)) > Math.abs(cross(me.u, across.u)))) across = m.frame;
  return across ? result("cross", stopAt(across, (-faceToward(across, d)) as 1 | -1)) : { style: "cross", with: ids, left: at, right: at };
}

/** One joined line: its frame, how each end is cleaned up and where each face starts and ends. */
export interface LineJoins {
  readonly elementId: ElementId;
  readonly levelId: string;
  readonly start: Vec2;
  readonly end: Vec2;
  readonly widthMm: number;
  readonly length: number;
  /** Unit direction start → end, and its left normal. */
  readonly u: Vec2;
  readonly n: Vec2;
  /** Along the line from its start: where its left / right face begins (start) and ends (end). */
  readonly faces: { readonly startLeft: number; readonly startRight: number; readonly endLeft: number; readonly endRight: number };
  readonly cleanups: readonly [EndCleanup, EndCleanup];
  /** The plan outline after joins: left face start → end, right face end → start. */
  readonly outline: readonly Vec2[];
}

/** True when no end moved: both ends free or left as drawn. */
export function joinsChangeNothing(j: LineJoins): boolean {
  return j.faces.startLeft === 0 && j.faces.startRight === 0 && j.faces.endLeft === j.length && j.faces.endRight === j.length && j.cleanups.every((c) => c.style === "free");
}

/** The joins of one line-placed element in this record under the set in force, or null when it has no join row (or no line). */
export function lineJoinsOf(elements: Elements, id: string, set: PackSet = activePackSet()): LineJoins | null {
  const table = tableIn(set);
  if (table.size === 0) return null;
  const layer = indexFor(elements, set);
  const line = lookupLine(layer, id);
  if (!line) return null;
  const ctx: Ctx = { elements, table, layer };
  const me = frameOf(line);
  const s = solveEnd(ctx, me, "start");
  const e = solveEnd(ctx, me, "end");
  const at = (dAlong: number, side: 1 | -1): Vec2 => add(add(line.start, mul(me.u, dAlong)), mul(me.n, side * me.half));
  const outline = [at(s.left, 1), at(e.left, 1), at(e.right, -1), at(s.right, -1)];
  const eid = asElementId(id);
  const cleanup = (which: End, r: EndSolve): EndCleanup => ({ elementId: eid, end: which, style: r.style, with: r.with.map(asElementId), outline });
  return {
    elementId: eid,
    levelId: line.levelId,
    start: line.start,
    end: line.end,
    widthMm: line.widthMm,
    length: me.length,
    u: me.u,
    n: me.n,
    faces: { startLeft: s.left, startRight: s.right, endLeft: e.left, endRight: e.right },
    cleanups: [cleanup("start", s), cleanup("end", e)],
    outline,
  };
}

/** Another line met at one of this line's ends: at the other's end (a corner) or along its face (`otherEnd` null: this one tees into it). */
export interface EndMeeting {
  readonly end: "start" | "end";
  readonly otherId: ElementId;
  readonly otherEnd: "start" | "end" | null;
}

/** Another line whose end stops on this line's face (it tees into this one). */
export interface FaceMeeting {
  readonly otherId: ElementId;
  readonly otherEnd: "start" | "end";
}

/**
 * Everywhere another joinable line meets this one, as the solve sees it:
 * at each of its ends, and the other lines whose ends stop on its face.
 * Reads the join index's cells round the line, never every element.
 */
export function lineMeetingsOf(elements: Elements, id: string, set: PackSet = activePackSet()): { readonly atEnds: readonly EndMeeting[]; readonly onFace: readonly FaceMeeting[] } | null {
  const table = tableIn(set);
  if (table.size === 0) return null;
  const layer = indexFor(elements, set);
  const line = lookupLine(layer, id);
  if (!line) return null;
  const ctx: Ctx = { elements, table, layer };
  const me = frameOf(line);
  const atEnds: EndMeeting[] = [];
  for (const end of ["start", "end"] as const) {
    if (instanceTrue(elements[id], DISALLOW_JOIN_KEYS[end])) continue;
    for (const m of meetingsAt(ctx, me, end === "start" ? line.start : line.end)) atEnds.push({ end, otherId: asElementId(m.frame.line.id), otherEnd: m.end });
  }
  const seen = new Set<string>();
  const onFace: FaceMeeting[] = [];
  for (const key of cellKeys(line)) {
    for (const otherId of lookupCell(layer, key)) {
      if (otherId === id || seen.has(otherId)) continue;
      seen.add(otherId);
      const other = lookupLine(layer, otherId);
      if (!other || other.levelId !== line.levelId || !canJoin(table, line.kind, other.kind)) continue;
      const f = frameOf(other);
      const reach = Math.max(JOIN_TOLERANCE_MM, Math.min(me.half, f.half));
      for (const end of ["start", "end"] as const) {
        if (instanceTrue(elements[otherId], DISALLOW_JOIN_KEYS[end])) continue;
        const p = end === "start" ? other.start : other.end;
        // At one of this line's ends it is a corner, already in `atEnds`.
        if (dist(p, line.start) <= reach || dist(p, line.end) <= reach) continue;
        const t = dot(sub(p, line.start), me.u);
        const off = Math.abs(cross(me.u, sub(p, line.start)));
        if (t > JOIN_TOLERANCE_MM && t < me.length - JOIN_TOLERANCE_MM && off <= me.half + JOIN_TOLERANCE_MM) onFace.push({ otherId: asElementId(otherId), otherEnd: end });
      }
    }
  }
  onFace.sort((a, b) => (a.otherId < b.otherId ? -1 : a.otherId > b.otherId ? 1 : a.otherEnd < b.otherEnd ? -1 : 1));
  return { atEnds, onFace };
}

/** The joinable lines whose box covers a point on a level (for tools and tests). */
export function joinLinesNear(elements: Elements, levelId: string, p: Vec2, set: PackSet = activePackSet()): readonly string[] {
  return lookupCell(indexFor(elements, set), pointKey(levelId, p));
}

/** The joinable lines on a level whose cells meet a plan box, each once (what a changed floor or ceiling above can reach). Reads only the box's cells. */
export function joinLinesInBox(elements: Elements, levelId: string, box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }, set: PackSet = activePackSet()): readonly string[] {
  const layer = indexFor(elements, set);
  const out = new Set<string>();
  const x0 = Math.floor(box.minX / CELL_MM);
  const x1 = Math.floor(box.maxX / CELL_MM);
  const y0 = Math.floor(box.minY / CELL_MM);
  const y1 = Math.floor(box.maxY / CELL_MM);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const id of lookupCell(layer, `${levelId}|${x}|${y}`)) out.add(id);
  return [...out];
}
