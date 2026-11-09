import type { DrawingItem } from "../documents";
import type { BatchCommand } from "../commands/batch";
import type { ViewCommand } from "../commands/views";
import type { Vec2 } from "../types";
import { crossingsWith, curveLength, curveOf, dist, endsOf, intersect, paramOf, piecePoints, withEndMoved, type Curve } from "./detail-curves";
import { EndIndex, type EndName } from "./detail-lines";
import { upgradeForEdit, type MigrationStep } from "./drafting-migrations";

/**
 * Modify tools for drafting, following BIM drafting-view conventions: pure
 * planners that turn one operation on drawing items into the views/sheets
 * commands that do it. People's tools and agents' tools call the same planner,
 * so both get the same result, and the commands save, undo and conflict like
 * any edit. Coordinates are the owner's (model mm in a view, paper mm on a
 * sheet).
 *
 * Detail lines and arcs are separate elements joined where their ends meet
 * (`detail-lines`). Moving, turning, trimming or dragging an end brings the
 * joined end of a line that wasn't picked along, so a rectangle stays closed.
 * Pinned items refuse to change shape or place.
 */

export type ModifyOp =
  /** `disjoin`: lines joined to what moves stay put instead of stretching to follow. */
  | { readonly op: "move"; readonly delta: Vec2; readonly disjoin?: boolean }
  | { readonly op: "copy"; readonly delta: Vec2 }
  | { readonly op: "rotate"; readonly center: Vec2; readonly angleDeg: number; readonly copy?: boolean }
  | { readonly op: "scale"; readonly center: Vec2; readonly factor: number }
  | { readonly op: "mirror"; readonly a: Vec2; readonly b: Vec2; readonly copy?: boolean }
  /** `group`: each copy becomes its own detail group (Group and Associate). */
  | { readonly op: "array"; readonly count: number; readonly delta: Vec2; readonly group?: boolean }
  | { readonly op: "polar_array"; readonly count: number; readonly center: Vec2; readonly angleDeg: number; readonly group?: boolean }
  /** Move the items so `from` lands on the line a→b (square to it). */
  | { readonly op: "align"; readonly from: Vec2; readonly a: Vec2; readonly b: Vec2 }
  /** Parallel copies of lines, arcs and circles `distance` toward `side`; a joined chain stays joined. `copy: false` moves the originals instead. */
  | { readonly op: "offset"; readonly distance: number; readonly side: Vec2; readonly copy?: boolean }
  /** Two lines or arcs meet at their (extended) crossing; each keeps the part on its `keep` side. */
  | { readonly op: "trim_extend_corner"; readonly keep1: Vec2; readonly keep2: Vec2 }
  /** One line or arc cut or lengthened to the boundary item, keeping the part on the `keep` side. */
  | { readonly op: "trim_extend_single"; readonly boundaryId: string; readonly keep: Vec2 }
  /** Each picked line or arc cut or lengthened to one boundary; `keeps[i]` is the side to keep of item i. */
  | { readonly op: "trim_extend_multiple"; readonly boundaryId: string; readonly keeps: readonly Vec2[] }
  /** Cut one line or arc in two at `at`; with `to`, cut there too and delete the piece between (Delete Inner Segment). */
  | { readonly op: "split"; readonly at: Vec2; readonly to?: Vec2 }
  /** Cut one line or arc at `at`, leaving a gap of `gap` centred there. */
  | { readonly op: "split_gap"; readonly at: Vec2; readonly gap: number }
  /** An arc of `radius` tangent to two lines, the lines trimmed to it. `near1` / `near2`: a point on the part of each line to keep (default: their far ends). */
  | { readonly op: "fillet_arc"; readonly radius: number; readonly near1?: Vec2; readonly near2?: Vec2 }
  /** Cut the corner of two lines with a straight line, `d1` back along the first and `d2` (default `d1`) along the second. */
  | { readonly op: "chamfer"; readonly d1: number; readonly d2?: number; readonly near1?: Vec2; readonly near2?: Vec2 }
  /** Drag one end of a line or arc; joined ends follow unless `disjoin`. */
  | { readonly op: "move_end"; readonly end: EndName; readonly to: Vec2; readonly disjoin?: boolean }
  | { readonly op: "pin" }
  | { readonly op: "unpin" }
  | { readonly op: "delete" }
  /** Give the items the source item's line style and category (and its fill or component, when they share a shape). */
  | { readonly op: "match_type"; readonly sourceId: string }
  /** Earlier names, kept so stored macros and older agents keep working. */
  | { readonly op: "trim"; readonly boundaryId: string; readonly keep: Vec2 }
  | { readonly op: "extend"; readonly boundaryId: string; readonly near: Vec2 }
  | { readonly op: "fillet"; readonly radius: number };

export type ModifyOpName = ModifyOp["op"];

const OP_NAMES: Record<ModifyOpName, true> = {
  move: true,
  copy: true,
  rotate: true,
  scale: true,
  mirror: true,
  array: true,
  polar_array: true,
  align: true,
  offset: true,
  trim_extend_corner: true,
  trim_extend_single: true,
  trim_extend_multiple: true,
  split: true,
  split_gap: true,
  fillet_arc: true,
  chamfer: true,
  move_end: true,
  pin: true,
  unpin: true,
  delete: true,
  match_type: true,
  trim: true,
  extend: true,
  fillet: true,
};
/** Every modify operation the planner takes (agents' tool schemas are tested against this). */
export const MODIFY_OP_NAMES = Object.keys(OP_NAMES) as ModifyOpName[];

type DetailUpdate = Pick<DrawingItem, "lineStyle" | "category" | "ccw" | "fill" | "component" | "pinned">;

/** One step of the plan, in the shape of a views/sheets command (the caller adds the owner and wraps them in a batch). */
export type ModifyStep =
  | ({ readonly type: "update_drawing_item"; readonly itemId: string; readonly points?: Vec2[]; readonly detailGroup?: string | null; readonly dim?: NonNullable<DrawingItem["dim"]> } & { readonly [K in keyof DetailUpdate]?: NonNullable<DetailUpdate[K]> })
  | { readonly type: "copy_drawing_items"; readonly itemIds: string[]; readonly offset: Vec2; readonly idPrefix: string }
  | { readonly type: "add_drawing_item"; readonly itemId: string; readonly shape: DrawingItem["shape"]; readonly points: Vec2[]; readonly lineStyle?: DrawingItem["lineStyle"]; readonly ccw?: boolean; readonly closed?: boolean; readonly component?: NonNullable<DrawingItem["component"]>; readonly fill?: DrawingItem["fill"]; readonly batt?: DrawingItem["batt"]; readonly category?: DrawingItem["category"]; readonly detailGroup?: string }
  | { readonly type: "delete_drawing_item"; readonly itemId: string };

export type ModifyPlan = { readonly ok: true; readonly steps: ModifyStep[]; readonly summary: string } | { readonly ok: false; readonly reason: string };

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const r3 = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 });
const T_EPS = 1e-6;

function rotateAbout(p: Vec2, c: Vec2, deg: number): Vec2 {
  const a = (deg * Math.PI) / 180;
  const d = sub(p, c);
  return add(c, { x: d.x * Math.cos(a) - d.y * Math.sin(a), y: d.x * Math.sin(a) + d.y * Math.cos(a) });
}

function mirrorAbout(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const u = sub(b, a);
  const l2 = dot(u, u) || 1;
  const t = dot(sub(p, a), u) / l2;
  const foot = add(a, mul(u, t));
  return sub(mul(foot, 2), p);
}

/** Where two infinite lines cross (null when parallel). */
export function lineIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const r = sub(a2, a1);
  const s = sub(b2, b1);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(b1, a1), s) / den;
  return add(a1, mul(r, t));
}

/** The transformed copy of an item's points (and a component's rotation / mirror). */
function transformItem(item: DrawingItem, f: (p: Vec2) => Vec2, turnDeg: number, flips: boolean): { points: Vec2[]; component?: NonNullable<DrawingItem["component"]> } {
  const points = item.points.map((p) => r3(f(p)));
  if (!item.component) return { points };
  const rotation = ((item.component.rotationDeg ?? 0) + turnDeg) * (flips ? -1 : 1);
  return { points, component: { ...item.component, rotationDeg: Math.round(rotation * 1000) / 1000, ...(flips ? { mirror: !item.component.mirror } : {}) } };
}

/** Operations that change the exact items picked; every other one brings each picked item's detail group along. */
export const EXACT_MODIFY_OPS: ReadonlySet<ModifyOpName> = new Set<ModifyOpName>([
  "trim",
  "extend",
  "offset",
  "fillet",
  "trim_extend_corner",
  "trim_extend_single",
  "trim_extend_multiple",
  "split",
  "split_gap",
  "fillet_arc",
  "chamfer",
  "move_end",
  "match_type",
  "delete",
]);

/** Operations a pinned item refuses (copies, arrays, offsets and style changes leave it where it is). */
const MOVES_OR_RESHAPES: ReadonlySet<ModifyOpName> = new Set<ModifyOpName>(["move", "rotate", "scale", "mirror", "align", "trim", "extend", "fillet", "trim_extend_corner", "trim_extend_single", "trim_extend_multiple", "split", "split_gap", "fillet_arc", "chamfer", "move_end", "delete"]);

/** The picked items plus every other live item in their detail groups (picked order first). Unknown ids are reported, not skipped. */
export function expandDetailGroups(items: readonly DrawingItem[], ids: readonly string[]): { readonly items: DrawingItem[]; readonly missing: string[] } {
  const live = items.filter((i) => !i.deleted);
  const byId = new Map(live.map((i) => [i.id as string, i]));
  const picked: DrawingItem[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (it) picked.push(it);
    else missing.push(id);
  }
  const groups = new Set(picked.flatMap((i) => (i.detailGroup ? [i.detailGroup] : [])));
  const out = [...picked];
  for (const it of live) if (it.detailGroup && groups.has(it.detailGroup) && !out.includes(it)) out.push(it);
  return { items: out, missing };
}

const styleOf = (it: DrawingItem) => ({ ...(it.lineStyle ? { lineStyle: it.lineStyle } : {}), ...(it.category ? { category: it.category } : {}) });

/** The stored points (and direction) of the piece of a line or arc from t0 to t1. */
function piece(it: DrawingItem, c: Curve, t0: number, t1: number): { points: Vec2[]; ccw?: boolean } {
  return { points: piecePoints(c, t0, t1), ...(it.shape === "arc" ? { ccw: it.ccw !== false } : {}) };
}

function lineOrArc(it: DrawingItem | undefined, verb: string): { it: DrawingItem; c: Curve } | string {
  if (!it) return "Nothing selected.";
  const c = it.shape === "line" || it.shape === "arc" ? curveOf(it) : null;
  if (!c) return it.shape === "polyline" ? `${verb} works on detail lines and arcs. This polyline is from an earlier drawing; redraw it with Line and Chain on.` : `${verb} works on detail lines and arcs.`;
  return { it, c };
}

/**
 * Cut or lengthen one curve to a boundary, keeping the part on `keep`'s side.
 * `mode`: auto (trim when the boundary crosses it, else extend), or only one.
 */
function trimExtendTo(it: DrawingItem, c: Curve, boundary: DrawingItem, keep: Vec2, mode: "auto" | "trim" | "extend"): { points: Vec2[]; ccw?: boolean; did: "trim" | "extend" } | string {
  if (boundary.id === it.id) return "Pick a different element as the boundary.";
  const hits = crossingsWith(c, boundary, true);
  const tk = paramOf(c, keep);
  const insideHits = hits.filter((h) => h.t > T_EPS && h.t < 1 - T_EPS);
  if (mode !== "extend" && insideHits.length > 0) {
    const before = insideHits.filter((h) => h.t < tk).sort((p, q) => q.t - p.t)[0];
    const after = insideHits.filter((h) => h.t > tk).sort((p, q) => p.t - q.t)[0];
    // Keep only one side of the boundary, as drafting views do: the cut nearest the kept part ends it.
    const t0 = before ? before.t : 0;
    const t1 = after ? after.t : 1;
    if (t1 - t0 < T_EPS) return "Nothing would be left of it on that side.";
    return { ...piece(it, c, t0, t1), did: "trim" };
  }
  if (mode === "trim") return "It doesn't cross that boundary.";
  const beyondEnd = hits.filter((h) => h.t >= 1 - T_EPS).sort((p, q) => p.t - q.t)[0];
  const beforeStart = hits.filter((h) => h.t <= T_EPS).sort((p, q) => q.t - p.t)[0];
  const atEnd = mode === "extend" ? tk >= 0.5 : tk >= 0.5;
  const pick = atEnd ? (beyondEnd ?? beforeStart) : (beforeStart ?? beyondEnd);
  if (!pick) return "Extended, it never meets that boundary.";
  const isEnd = pick === beyondEnd;
  if (c.k === "arc" && (isEnd ? pick.t : 1 - pick.t) * Math.abs(c.sweep) >= 2 * Math.PI - 1e-6) return "Extended, the arc would close on itself before it meets that boundary.";
  return { ...piece(it, c, isEnd ? 0 : pick.t, isEnd ? pick.t : 1), did: "extend" };
}

/** The crossing of two extended curves nearest both keep points, and the piece of each that keeps its side. */
function corner(a: { it: DrawingItem; c: Curve }, b: { it: DrawingItem; c: Curve }, keep1: Vec2, keep2: Vec2): { first: { points: Vec2[]; ccw?: boolean }; second: { points: Vec2[]; ccw?: boolean }; at: Vec2 } | string {
  const hits = intersect(a.c, b.c, true, true);
  if (hits.length === 0) return a.c.k === "line" && b.c.k === "line" ? "Those lines are parallel; they never meet." : "Those never meet, even extended.";
  const hit = [...hits].sort((p, q) => dist(p.at, keep1) + dist(p.at, keep2) - (dist(q.at, keep1) + dist(q.at, keep2)))[0];
  if (!hit) return "Those never meet.";
  const side = (x: { it: DrawingItem; c: Curve }, tc: number, keep: Vec2) => {
    const tk = paramOf(x.c, keep);
    const [t0, t1] = tk < tc ? [0, tc] : [tc, 1];
    return t1 - t0 < T_EPS ? null : piece(x.it, x.c, t0, t1);
  };
  const first = side(a, hit.t1, keep1);
  const second = side(b, hit.t2, keep2);
  if (!first || !second) return "Nothing would be left of one of them on the side you picked.";
  return { first, second, at: hit.at };
}

interface Change {
  readonly before: DrawingItem;
  readonly points: Vec2[];
}

/**
 * Joined ends follow: for every changed line or arc whose end moved, a live
 * item not in `changed` with an end on the old spot follows. A line stretches
 * (its other end stays). An arc rides along whole, keeping its radius and so
 * staying tangent like a fillet, and the item joined to its far end follows in
 * turn; when that far end is joined to something already being changed, the
 * arc stretches instead (its bulge kept). Returns the extra update steps, or
 * why it can't (a pinned item is joined there).
 */
function followJoins(all: readonly DrawingItem[], changed: readonly Change[], excluded: ReadonlySet<string>): ModifyStep[] | string {
  const moved = new Map<string, DrawingItem>();
  const skip = new Set([...changed.map((c) => c.before.id as string), ...excluded]);
  const index = new EndIndex(all);
  const queue: Array<{ from: Vec2; to: Vec2 }> = [];
  for (const ch of changed) {
    const old = endsOf(ch.before);
    const now = endsOf({ ...ch.before, points: ch.points });
    if (!old || !now) continue;
    for (const end of ["start", "end"] as const) if (dist(old[end], now[end]) >= 1e-6) queue.push({ from: old[end], to: now[end] });
  }
  for (let k = 0; k < queue.length && k < 10_000; k++) {
    const step = queue[k];
    if (!step) continue;
    for (const j of index.at(step.from, skip)) {
      if (j.item.pinned) return "A pinned line is joined there. Unpin it, or move with Disjoin on.";
      const cur = moved.get(j.item.id);
      // An arc that already rode along is done; a line may still need its other end moved.
      if (cur && cur.shape === "arc") continue;
      const far = endsOf(j.item);
      const farEnd = j.end === "start" ? "end" : "start";
      const farJoinedToChange = far ? index.at(far[farEnd], new Set([j.item.id])).some((o) => skip.has(o.item.id)) : false;
      if (!cur && j.item.shape === "arc" && far && !farJoinedToChange) {
        const d = sub(step.to, step.from);
        moved.set(j.item.id, { ...j.item, points: j.item.points.map((p) => r3(add(p, d))) });
        queue.push({ from: far[farEnd], to: add(far[farEnd], d) });
        continue;
      }
      const base = cur ?? j.item;
      const next = withEndMoved(base, j.end, step.to);
      if (!next) continue;
      moved.set(j.item.id, { ...base, points: next.points, ...(next.ccw !== undefined ? { ccw: next.ccw } : {}) });
    }
  }
  const steps: ModifyStep[] = [];
  for (const [itemId, it] of moved) steps.push({ type: "update_drawing_item", itemId, points: [...it.points], ...(it.shape === "arc" && it.ccw !== undefined ? { ccw: it.ccw } : {}) });
  return steps;
}

/** Update steps for changed items plus the joined ends that follow them. */
function withFollow(all: readonly DrawingItem[], changes: Array<Change & { ccw?: boolean; component?: NonNullable<DrawingItem["component"]> }>, follow: boolean, excluded: ReadonlySet<string> = new Set()): ModifyStep[] | string {
  const own: ModifyStep[] = changes.map((c) => ({ type: "update_drawing_item", itemId: c.before.id, points: c.points, ...(c.ccw !== undefined ? { ccw: c.ccw } : {}), ...(c.component ? { component: c.component } : {}) }));
  if (!follow) return own;
  const more = followJoins(all, changes, excluded);
  return typeof more === "string" ? more : [...own, ...more];
}

/** Offset a curve `d` to the left of its stored direction of travel (`leftSign` +1) or to the right (-1). */
function offsetCurve(c: Curve, d: number, leftSign: number): Curve | string {
  if (c.k === "line") {
    const u = sub(c.b, c.a);
    const l = len(u) || 1;
    const n = mul({ x: -u.y / l, y: u.x / l }, d * leftSign);
    return { k: "line", a: add(c.a, n), b: add(c.b, n) };
  }
  // Left of a counter-clockwise arc is toward its centre.
  const inward = leftSign > 0 === c.sweep > 0;
  const r = inward ? c.r - d : c.r + d;
  if (r <= 0) return `Offsetting inward by more than the radius (${Math.round(c.r)}) leaves nothing.`;
  return { ...c, r };
}

/** Which side of its stored direction `side` is on, for one curve alone. */
function ownLeftSign(c: Curve, side: Vec2): number {
  if (c.k === "line") return Math.sign(cross(sub(c.b, c.a), sub(side, c.a))) || 1;
  const inward = dist(side, c.c) < c.r;
  return inward === c.sweep > 0 ? 1 : -1;
}

/**
 * The side each curve offsets to. Curves joined into a chain are walked in
 * travel order so the whole chain goes one way (a fillet arc in a rectangle
 * offsets inward with the sides, though the side point is outside its circle);
 * the side point is judged against the chain's first straight piece.
 */
function chainLeftSigns(curves: ReadonlyArray<{ it: DrawingItem; c: Curve }>, side: Vec2): number[] {
  const ends = curves.map(({ it }) => endsOf(it));
  const index = new EndIndex(curves.map((c) => c.it));
  const slot = new Map(curves.map(({ it }, i) => [it.id as string, i]));
  const orient: Array<number | undefined> = curves.map(() => undefined);
  const signs: number[] = curves.map(({ c }) => ownLeftSign(c, side));
  for (let root = 0; root < curves.length; root++) {
    if (orient[root] !== undefined) continue;
    orient[root] = 1;
    const component = [root];
    for (let k = 0; k < component.length; k++) {
      const i = component[k] ?? 0;
      const ei = ends[i];
      const oi = orient[i] ?? 1;
      if (!ei) continue;
      const outEnd = oi > 0 ? ei.end : ei.start;
      const inEnd = oi > 0 ? ei.start : ei.end;
      for (const [at, startFollows] of [[outEnd, true], [inEnd, false]] as const) {
        for (const hit of index.at(at)) {
          const j = slot.get(hit.item.id);
          if (j === undefined || orient[j] !== undefined) continue;
          // Leaving i's far end, a neighbour that starts there runs the same way; at i's near end, one that ends there does.
          orient[j] = (hit.end === "start") === startFollows ? 1 : -1;
          component.push(j);
        }
      }
    }
    if (component.length < 2) continue;
    const ref = component.find((i) => curves[i]?.c.k === "line") ?? root;
    const refCurve = curves[ref]?.c;
    // Left of travel, for the whole chain.
    const travelLeft = refCurve ? ownLeftSign(refCurve, side) * (orient[ref] ?? 1) : 1;
    for (const i of component) signs[i] = travelLeft * (orient[i] ?? 1);
  }
  return signs;
}

function curvePoints(it: DrawingItem, c: Curve): Vec2[] {
  if (c.k === "line") return [r3(c.a), r3(c.b)];
  if (it.shape === "circle") return [r3(c.c), r3({ x: c.c.x + c.r * Math.cos(c.a0), y: c.c.y + c.r * Math.sin(c.a0) })];
  return piecePoints(c, 0, 1);
}

/** Offset of a legacy polyline: each segment moved, neighbours re-met. */
function offsetPolyline(it: DrawingItem, d: number, sidePt: Vec2): Vec2[] | string {
  const pts = it.points;
  const first = pts[0];
  const second = pts[1];
  if (!first || !second) return "That line has no length.";
  const side = Math.sign(cross(sub(second, first), sub(sidePt, first))) || 1;
  const segs: Array<[Vec2, Vec2]> = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    const u = sub(b, a);
    const l = len(u) || 1;
    const nrm = mul({ x: -u.y / l, y: u.x / l }, d * side);
    segs.push([add(a, nrm), add(b, nrm)]);
  }
  const out: Vec2[] = [];
  segs.forEach((s, i) => {
    if (i === 0) out.push(s[0]);
    const next = segs[i + 1];
    if (next) out.push(lineIntersection(s[0], s[1], next[0], next[1]) ?? s[1]);
    else out.push(s[1]);
  });
  return out.map(r3);
}

function planOffset(items: readonly DrawingItem[], op: Extract<ModifyOp, { op: "offset" }>, idPrefix: string): ModifyPlan {
  const d = op.distance;
  if (!(d > 0)) return { ok: false, reason: "Offset by a distance above zero." };
  const copy = op.copy !== false;
  const legacy = items.filter((i) => i.shape === "polyline");
  if (legacy.length > 0) {
    if (items.length !== 1 || !legacy[0]) return { ok: false, reason: "Offset an earlier-drawing polyline on its own." };
    const it = legacy[0];
    const out = offsetPolyline(it, d, op.side);
    if (typeof out === "string") return { ok: false, reason: out };
    const step: ModifyStep = copy ? { type: "add_drawing_item", itemId: `${idPrefix}-${it.id}`.slice(0, 200), shape: "polyline", points: out, ...styleOf(it), ...(it.closed !== undefined ? { closed: it.closed } : {}) } : { type: "update_drawing_item", itemId: it.id, points: out };
    return { ok: true, steps: [step], summary: `Offset the polyline by ${Math.round(d)}` };
  }
  const curves: Array<{ it: DrawingItem; c: Curve }> = [];
  for (const it of items) {
    const c = it.shape === "line" || it.shape === "arc" || it.shape === "circle" ? curveOf(it) : null;
    if (!c) return { ok: false, reason: "Offset works on detail lines, arcs and circles." };
    curves.push({ it, c });
  }
  const moved: Curve[] = [];
  const signs = chainLeftSigns(curves, op.side);
  for (const [i, { c }] of curves.entries()) {
    const o = offsetCurve(c, d, signs[i] ?? 1);
    if (typeof o === "string") return { ok: false, reason: o };
    moved.push(o);
  }
  // Pieces of one chain that met before meet again: each pair of joined originals re-meets at its offsets' crossing.
  const ts = moved.map(() => ({ t0: 0, t1: 1 }));
  const index = new EndIndex(curves.map((c) => c.it));
  const slot = new Map(curves.map(({ it }, i) => [it.id as string, i]));
  for (let i = 0; i < curves.length; i++) {
    const ei = endsOf(curves[i]?.it ?? { shape: "text", points: [] });
    const ci = moved[i];
    if (!ei || !ci) continue;
    for (const endI of ["start", "end"] as const) {
      for (const hit of index.at(ei[endI])) {
        const j = slot.get(hit.item.id);
        const cj = j === undefined ? undefined : moved[j];
        if (j === undefined || j <= i || !cj) continue;
        const shared = ei[endI];
        const cross = intersect(ci, cj, true, true).sort((p, q) => dist(p.at, shared) - dist(q.at, shared))[0];
        const ti = ts[i];
        const tj = ts[j];
        if (!cross || !ti || !tj) continue;
        if (endI === "start") ti.t0 = cross.t1;
        else ti.t1 = cross.t1;
        if (hit.end === "start") tj.t0 = cross.t2;
        else tj.t1 = cross.t2;
      }
    }
  }
  const steps: ModifyStep[] = [];
  curves.forEach(({ it }, i) => {
    const c = moved[i];
    const t = ts[i];
    if (!c || !t) return;
    const points = it.shape === "circle" ? curvePoints(it, c) : t.t1 - t.t0 < T_EPS ? null : piecePoints(c, t.t0, t.t1);
    if (!points) return;
    const ccw = it.shape === "arc" ? { ccw: it.ccw !== false } : {};
    steps.push(copy ? { type: "add_drawing_item", itemId: `${idPrefix}-${it.id}`.slice(0, 200), shape: it.shape, points, ...styleOf(it), ...ccw } : { type: "update_drawing_item", itemId: it.id, points, ...ccw });
  });
  if (steps.length === 0) return { ok: false, reason: "At that distance the offset pieces vanish. Use a smaller distance." };
  const what = items.length === 1 ? `the ${items[0]?.shape ?? "line"}` : `${items.length} joined elements`;
  return { ok: true, steps, summary: `${copy ? "Offset" : "Move"} ${what} by ${Math.round(d)}` };
}

function twoLines(items: readonly DrawingItem[], verb: string): [DrawingItem, DrawingItem, Vec2, Vec2, Vec2, Vec2, Vec2] | string {
  if (items.length !== 2 || items.some((i) => i.shape !== "line")) return `${verb} two detail lines.`;
  const [l1, l2] = items;
  const [a1, b1] = l1?.points ?? [];
  const [a2, b2] = l2?.points ?? [];
  if (!l1 || !l2 || !a1 || !b1 || !a2 || !b2) return "Those lines have no length.";
  const at = lineIntersection(a1, b1, a2, b2);
  if (!at) return "The lines are parallel; they never meet.";
  return [l1, l2, a1, b1, a2, b2, at];
}

/** The end of a line to keep given the corner and a point on the part to keep (default: the end farther from the corner). */
function keptEnd(a: Vec2, b: Vec2, at: Vec2, near: Vec2 | undefined): Vec2 {
  if (near) {
    const u = sub(b, a);
    const tc = dot(sub(at, a), u) / (dot(u, u) || 1);
    const tn = dot(sub(near, a), u) / (dot(u, u) || 1);
    return tn < tc ? a : b;
  }
  return dist(a, at) > dist(b, at) ? a : b;
}

function planFilletArc(items: readonly DrawingItem[], radius: number, idPrefix: string, near1?: Vec2, near2?: Vec2): ModifyPlan {
  const got = twoLines(items, "Fillet Arc rounds the corner of");
  if (typeof got === "string") return { ok: false, reason: got };
  const [l1, l2, a1, b1, a2, b2, at] = got;
  if (!(radius > 0)) return { ok: false, reason: "Set a radius above zero (use Trim/Extend to Corner for a sharp corner)." };
  const far1 = keptEnd(a1, b1, at, near1);
  const far2 = keptEnd(a2, b2, at, near2);
  const u1 = mul(sub(far1, at), 1 / (len(sub(far1, at)) || 1));
  const u2 = mul(sub(far2, at), 1 / (len(sub(far2, at)) || 1));
  const half = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2)))) / 2;
  if (half < 1e-3 || half > Math.PI / 2 - 1e-3) return { ok: false, reason: "The lines are nearly in line; there's no corner to round." };
  const tangent = radius / Math.tan(half);
  if (tangent > len(sub(far1, at)) + 1e-6 || tangent > len(sub(far2, at)) + 1e-6) return { ok: false, reason: `A ${Math.round(radius)} radius needs ${Math.round(tangent)} of each line; they're shorter. Use a smaller radius.` };
  const t1 = r3(add(at, mul(u1, tangent)));
  const t2 = r3(add(at, mul(u2, tangent)));
  const bis = mul(add(u1, u2), 1 / (len(add(u1, u2)) || 1));
  const center = r3(add(at, mul(bis, radius / Math.sin(half))));
  const ccw = cross(sub(t1, center), sub(t2, center)) > 0;
  const keepOrder = (l: DrawingItem, far: Vec2, t: Vec2): Vec2[] => (l.points[0] && dist(l.points[0], far) < 1e-9 ? [far, t] : [t, far]);
  return {
    ok: true,
    steps: [
      { type: "update_drawing_item", itemId: l1.id, points: keepOrder(l1, far1, t1) },
      { type: "update_drawing_item", itemId: l2.id, points: keepOrder(l2, far2, t2) },
      { type: "add_drawing_item", itemId: `${idPrefix}-fillet`.slice(0, 200), shape: "arc", points: [center, t1, t2], ccw, ...styleOf(l1) },
    ],
    summary: `Fillet the corner with a ${Math.round(radius)} radius arc`,
  };
}

function planChamfer(items: readonly DrawingItem[], op: Extract<ModifyOp, { op: "chamfer" }>, idPrefix: string): ModifyPlan {
  const got = twoLines(items, "Chamfer cuts the corner of");
  if (typeof got === "string") return { ok: false, reason: got };
  const [l1, l2, a1, b1, a2, b2, at] = got;
  const d1 = op.d1;
  const d2 = op.d2 ?? op.d1;
  if (!(d1 > 0) || !(d2 > 0)) return { ok: false, reason: "Chamfer by distances above zero." };
  const far1 = keptEnd(a1, b1, at, op.near1);
  const far2 = keptEnd(a2, b2, at, op.near2);
  if (d1 > dist(far1, at) + 1e-6 || d2 > dist(far2, at) + 1e-6) return { ok: false, reason: "The chamfer is longer than the lines. Use a smaller distance." };
  const p1 = r3(add(at, mul(sub(far1, at), d1 / (dist(far1, at) || 1))));
  const p2 = r3(add(at, mul(sub(far2, at), d2 / (dist(far2, at) || 1))));
  const keepOrder = (l: DrawingItem, far: Vec2, t: Vec2): Vec2[] => (l.points[0] && dist(l.points[0], far) < 1e-9 ? [far, t] : [t, far]);
  return {
    ok: true,
    steps: [
      { type: "update_drawing_item", itemId: l1.id, points: keepOrder(l1, far1, p1) },
      { type: "update_drawing_item", itemId: l2.id, points: keepOrder(l2, far2, p2) },
      { type: "add_drawing_item", itemId: `${idPrefix}-chamfer`.slice(0, 200), shape: "line", points: [p1, p2], ...styleOf(l1) },
    ],
    summary: `Chamfer the corner ${Math.round(d1)}${d2 !== d1 ? ` by ${Math.round(d2)}` : ""}`,
  };
}

function planSplit(it: DrawingItem, c: Curve, op: Extract<ModifyOp, { op: "split" | "split_gap" }>, idPrefix: string): ModifyPlan {
  if (it.shape === "circle") return { ok: false, reason: "A circle has no ends to split between. Draw it as two arcs." };
  const ta = paramOf(c, op.at);
  let cuts: [number, number];
  if (op.op === "split_gap") {
    if (!(op.gap > 0)) return { ok: false, reason: "Set a gap above zero." };
    const half = op.gap / 2 / (curveLength(c) || 1);
    cuts = [ta - half, ta + half];
  } else if (op.to) {
    const tb = paramOf(c, op.to);
    cuts = ta < tb ? [ta, tb] : [tb, ta];
  } else cuts = [ta, ta];
  const [lo, hi] = cuts;
  if (lo <= T_EPS || hi >= 1 - T_EPS) return { ok: false, reason: op.op === "split_gap" ? "The gap runs past an end. Click nearer the middle or use a smaller gap." : "Click a point between the ends to split there." };
  const first = piece(it, c, 0, lo);
  const second = piece(it, c, hi, 1);
  const summary = op.op === "split_gap" ? `Split the ${it.shape} with a ${Math.round(op.gap)} gap` : op.to ? `Split the ${it.shape} and delete the piece between` : `Split the ${it.shape}`;
  return {
    ok: true,
    steps: [
      { type: "update_drawing_item", itemId: it.id, points: first.points },
      { type: "add_drawing_item", itemId: `${idPrefix}-${it.id}`.slice(0, 200), shape: it.shape, points: second.points, ...styleOf(it), ...(it.detailGroup ? { detailGroup: it.detailGroup } : {}), ...(second.ccw !== undefined ? { ccw: second.ccw } : {}) },
    ],
    summary,
  };
}

/**
 * Plan one modify operation. `items` are the ones it acts on; `all` is every
 * live item in the owner (joined ends that follow, boundaries, the match
 * source). Coordinates are stored ones.
 */
export function planModify(items: readonly DrawingItem[], operation: ModifyOp, idPrefix: string, lookup: (id: string) => DrawingItem | undefined, all: readonly DrawingItem[] = items): ModifyPlan {
  if (items.length === 0) return { ok: false, reason: "Select something to change first." };
  if (MOVES_OR_RESHAPES.has(operation.op)) {
    const pinned = items.find((i) => i.pinned);
    if (pinned) return { ok: false, reason: `${items.length === 1 ? "It's" : "One of them is"} pinned. Unpin it first (Modify > Unpin).` };
  }
  const n = items.length;
  const what = `${n} item${n === 1 ? "" : "s"}`;
  const notes = items.filter((i) => i.shape === "text");
  const picked = new Set(items.map((i) => i.id as string));
  const done = (steps: ModifyStep[] | string, summary: string): ModifyPlan => (typeof steps === "string" ? { ok: false, reason: steps } : { ok: true, steps, summary });
  switch (operation.op) {
    case "move": {
      const changes = items.map((it) => ({ before: it, points: it.points.map((p) => r3(add(p, operation.delta))) }));
      return done(withFollow(all, changes, operation.disjoin !== true), `Move ${what}`);
    }
    case "copy":
      return { ok: true, steps: [{ type: "copy_drawing_items", itemIds: items.map((i) => i.id), offset: operation.delta, idPrefix }], summary: `Copy ${what}` };
    case "array": {
      if (operation.count < 2 || operation.count > 100) return { ok: false, reason: "An array has 2 to 100 copies, counting the original." };
      const steps: ModifyStep[] = [];
      for (let k = 1; k < operation.count; k++) {
        const prefix = `${idPrefix}-${k}`;
        steps.push({ type: "copy_drawing_items", itemIds: items.map((i) => i.id), offset: mul(operation.delta, k), idPrefix: prefix });
        if (operation.group) for (const it of items) steps.push({ type: "update_drawing_item", itemId: `${prefix}-${it.id}`.slice(0, 200), detailGroup: `${idPrefix}-g${k}`.slice(0, 120) });
      }
      return { ok: true, steps, summary: `Array ${what} ${operation.count} times${operation.group ? ", each copy a group" : ""}` };
    }
    case "rotate":
    case "mirror":
    case "scale":
    case "polar_array": {
      if (notes.length > 0 && operation.op !== "polar_array" && operation.op !== "rotate") return { ok: false, reason: "Notes don't scale or mirror; move them instead (their text stays upright and paper-sized)." };
      if (operation.op === "scale" && (operation.factor <= 0 || operation.factor > 100)) return { ok: false, reason: "Scale by a factor above 0 and up to 100." };
      const transforms: Array<{ f: (p: Vec2) => Vec2; turn: number; flips: boolean }> = [];
      if (operation.op === "rotate") transforms.push({ f: (p) => rotateAbout(p, operation.center, operation.angleDeg), turn: operation.angleDeg, flips: false });
      if (operation.op === "mirror") transforms.push({ f: (p) => mirrorAbout(p, operation.a, operation.b), turn: 0, flips: true });
      if (operation.op === "scale") transforms.push({ f: (p) => add(operation.center, mul(sub(p, operation.center), operation.factor)), turn: 0, flips: false });
      if (operation.op === "polar_array") {
        if (operation.count < 2 || operation.count > 100) return { ok: false, reason: "A polar array has 2 to 100 copies, counting the original." };
        const stepDeg = operation.angleDeg / (Math.abs(operation.angleDeg) >= 360 ? operation.count : operation.count - 1);
        for (let k = 1; k < operation.count; k++) transforms.push({ f: (p) => rotateAbout(p, operation.center, stepDeg * k), turn: stepDeg * k, flips: false });
      }
      const makesCopies = operation.op === "polar_array" || ("copy" in operation && operation.copy === true);
      const grouped = operation.op === "polar_array" && operation.group === true;
      const steps: ModifyStep[] = [];
      const changes: Array<Change & { ccw?: boolean; component?: NonNullable<DrawingItem["component"]> }> = [];
      transforms.forEach((t, k) => {
        for (const it of items) {
          if (it.shape === "text") {
            // A note travels with the rest but keeps its own orientation.
            const at = it.points[0];
            if (!at) continue;
            const moved = r3(t.f(at));
            if (makesCopies) steps.push({ type: "copy_drawing_items", itemIds: [it.id], offset: sub(moved, at), idPrefix: `${idPrefix}-${k}` });
            else steps.push({ type: "update_drawing_item", itemId: it.id, points: [moved] });
            continue;
          }
          const next = transformItem(it, t.f, t.turn, t.flips);
          const ccw = it.shape === "arc" && t.flips ? it.ccw === false : it.ccw;
          if (makesCopies) {
            steps.push({ type: "add_drawing_item", itemId: `${idPrefix}-${k}-${it.id}`.slice(0, 200), shape: it.shape, points: next.points, ...(it.lineStyle ? { lineStyle: it.lineStyle } : {}), ...(ccw !== undefined ? { ccw } : {}), ...(it.closed !== undefined ? { closed: it.closed } : {}), ...(next.component ? { component: next.component } : {}), ...(it.fill ? { fill: it.fill } : {}), ...(it.batt ? { batt: it.batt } : {}), ...(it.category ? { category: it.category } : {}), ...(grouped ? { detailGroup: `${idPrefix}-g${k}`.slice(0, 120) } : it.detailGroup ? { detailGroup: it.detailGroup } : {}) });
          } else {
            changes.push({ before: it, points: next.points, ...(it.shape === "arc" && ccw !== undefined ? { ccw } : {}), ...(next.component ? { component: next.component } : {}) });
          }
        }
      });
      if (!makesCopies) {
        const own = withFollow(all, changes, true);
        if (typeof own === "string") return { ok: false, reason: own };
        steps.push(...own);
      }
      const verb = operation.op === "rotate" ? `Rotate ${what} ${operation.angleDeg}°` : operation.op === "mirror" ? `Mirror ${what}` : operation.op === "scale" ? `Scale ${what} by ${operation.factor}` : `Polar array ${what} ${operation.count} times`;
      return { ok: true, steps, summary: makesCopies && operation.op !== "polar_array" ? `${verb} as a copy` : verb };
    }
    case "align": {
      const u = sub(operation.b, operation.a);
      const l2 = dot(u, u);
      if (l2 < 1e-9) return { ok: false, reason: "Pick a line to align to." };
      const foot = add(operation.a, mul(u, dot(sub(operation.from, operation.a), u) / l2));
      const delta = sub(foot, operation.from);
      return done(withFollow(all, items.map((it) => ({ before: it, points: it.points.map((p) => r3(add(p, delta))) })), true), `Align ${what}`);
    }
    case "offset":
      return planOffset(items, operation, idPrefix);
    case "trim":
    case "extend":
    case "trim_extend_single": {
      const name = operation.op === "trim" ? "Trim" : operation.op === "extend" ? "Extend" : "Trim/Extend";
      if (n !== 1) return { ok: false, reason: `${name} one element at a time (Trim/Extend Multiple does several to one boundary).` };
      const got = lineOrArc(items[0], name);
      if (typeof got === "string") return { ok: false, reason: got };
      const boundary = lookup(operation.boundaryId);
      if (!boundary) return { ok: false, reason: "Pick the boundary to trim or extend to." };
      const keep = operation.op === "extend" ? operation.near : operation.keep;
      const res = trimExtendTo(got.it, got.c, boundary, keep, operation.op === "trim" ? "trim" : operation.op === "extend" ? "extend" : "auto");
      if (typeof res === "string") return { ok: false, reason: res };
      return done(withFollow(all, [{ before: got.it, points: res.points, ...(res.ccw !== undefined ? { ccw: res.ccw } : {}) }], true, new Set([boundary.id])), `${res.did === "trim" ? "Trim" : "Extend"} the ${got.it.shape} to the boundary`);
    }
    case "trim_extend_multiple": {
      if (operation.keeps.length !== n) return { ok: false, reason: "Click each element on the side to keep." };
      const boundary = lookup(operation.boundaryId);
      if (!boundary) return { ok: false, reason: "Pick the boundary first." };
      if (picked.has(boundary.id)) return { ok: false, reason: "The boundary can't be one of the elements to trim." };
      const changes: Array<Change & { ccw?: boolean }> = [];
      for (let i = 0; i < n; i++) {
        const got = lineOrArc(items[i], "Trim/Extend");
        if (typeof got === "string") return { ok: false, reason: got };
        const keep = operation.keeps[i];
        if (!keep) return { ok: false, reason: "Click each element on the side to keep." };
        const res = trimExtendTo(got.it, got.c, boundary, keep, "auto");
        if (typeof res === "string") return { ok: false, reason: `${res} (element ${i + 1} of ${n})` };
        changes.push({ before: got.it, points: res.points, ...(res.ccw !== undefined ? { ccw: res.ccw } : {}) });
      }
      return done(withFollow(all, changes, true, new Set([boundary.id])), `Trim/extend ${what} to the boundary`);
    }
    case "trim_extend_corner": {
      if (n !== 2) return { ok: false, reason: "Trim/Extend to Corner takes two elements: click the part of each to keep." };
      const a = lineOrArc(items[0], "Trim/Extend to Corner");
      const b = lineOrArc(items[1], "Trim/Extend to Corner");
      if (typeof a === "string") return { ok: false, reason: a };
      if (typeof b === "string") return { ok: false, reason: b };
      const res = corner(a, b, operation.keep1, operation.keep2);
      if (typeof res === "string") return { ok: false, reason: res };
      return done(
        withFollow(all, [
          { before: a.it, points: res.first.points, ...(res.first.ccw !== undefined ? { ccw: res.first.ccw } : {}) },
          { before: b.it, points: res.second.points, ...(res.second.ccw !== undefined ? { ccw: res.second.ccw } : {}) },
        ], true),
        "Trim/extend to a corner",
      );
    }
    case "fillet":
      if (operation.radius <= 0) {
        const got = twoLines(items, "Fillet");
        if (typeof got === "string") return { ok: false, reason: got };
        const [l1, l2, a1, b1, a2, b2] = got;
        const far1 = keptEnd(a1, b1, got[6], undefined);
        const far2 = keptEnd(a2, b2, got[6], undefined);
        return planModify([l1, l2], { op: "trim_extend_corner", keep1: far1, keep2: far2 }, idPrefix, lookup, all);
      }
      return planFilletArc(items, operation.radius, idPrefix);
    case "fillet_arc":
      return planFilletArc(items, operation.radius, idPrefix, operation.near1, operation.near2);
    case "chamfer":
      return planChamfer(items, operation, idPrefix);
    case "split":
    case "split_gap": {
      if (n !== 1) return { ok: false, reason: "Split one element at a time." };
      const got = lineOrArc(items[0], "Split");
      if (typeof got === "string") return { ok: false, reason: got };
      return planSplit(got.it, got.c, operation, idPrefix);
    }
    case "move_end": {
      if (n !== 1) return { ok: false, reason: "Drag one end at a time." };
      const it = items[0];
      const next = it ? withEndMoved(it, operation.end, operation.to) : null;
      if (!it || !next) return { ok: false, reason: "Only lines, arcs and open polylines have ends to drag." };
      const ends = endsOf({ ...it, points: next.points });
      if (ends && dist(ends.start, ends.end) < 0.5) return { ok: false, reason: "Both ends would land on one spot." };
      return done(withFollow(all, [{ before: it, points: next.points, ...(next.ccw !== undefined ? { ccw: next.ccw } : {}) }], operation.disjoin !== true), `Drag the ${operation.end} of the ${it.shape}`);
    }
    case "pin":
    case "unpin":
      return { ok: true, steps: items.map((it) => ({ type: "update_drawing_item", itemId: it.id, pinned: operation.op === "pin" })), summary: `${operation.op === "pin" ? "Pin" : "Unpin"} ${what}` };
    case "delete":
      return { ok: true, steps: items.map((it) => ({ type: "delete_drawing_item", itemId: it.id })), summary: `Delete ${what}` };
    case "match_type": {
      const source = lookup(operation.sourceId);
      if (!source) return { ok: false, reason: "Pick the element to match first." };
      const steps: ModifyStep[] = [];
      for (const it of items) {
        if (it.id === source.id) continue;
        steps.push({
          type: "update_drawing_item",
          itemId: it.id,
          ...(source.lineStyle ? { lineStyle: source.lineStyle } : {}),
          ...(source.category ? { category: source.category } : {}),
          ...(source.fill && it.shape === "region" && source.shape === "region" ? { fill: source.fill } : {}),
          ...(source.component && it.component && source.shape === it.shape ? { component: { ...it.component, symbolId: source.component.symbolId } } : {}),
        });
      }
      if (steps.length === 0) return { ok: false, reason: "Pick other elements to match to it." };
      return { ok: true, steps, summary: `Match ${steps.length} item${steps.length === 1 ? "" : "s"} to the picked one` };
    }
  }
}

/** The upgraded rectangle side nearest a point. */
function nearestSide(items: readonly DrawingItem[], sideIds: readonly string[], p: Vec2 | undefined): string | undefined {
  if (!p) return sideIds[0];
  let best: string | undefined;
  let bestD = Infinity;
  for (const id of sideIds) {
    const it = items.find((i) => i.id === id);
    const c = it ? curveOf(it) : null;
    if (!c) continue;
    const t = Math.max(0, Math.min(1, paramOf(c, p)));
    const q = c.k === "line" ? add(c.a, mul(sub(c.b, c.a), t)) : p;
    const d = dist(q, p);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** The point an operation names for picking one side of a rectangle (per picked position). */
function pickPoints(op: ModifyOp): readonly (Vec2 | undefined)[] | null {
  switch (op.op) {
    case "trim_extend_corner":
      return [op.keep1, op.keep2];
    case "fillet_arc":
    case "chamfer":
      return [op.near1, op.near2];
    case "trim_extend_single":
    case "trim":
      return [op.keep];
    case "extend":
      return [op.near];
    case "trim_extend_multiple":
      return op.keeps;
    case "split":
    case "split_gap":
      return [op.at];
    case "move_end":
      return [op.to];
    default:
      return null;
  }
}

/**
 * One modify operation on picked items in one owner, as the command to send:
 * rectangles from earlier drawings upgraded to joined lines first (inside the
 * same batch), groups expanded (except for the ops on exact items), planned,
 * the owner filled in, several steps wrapped in one batch so it saves and
 * undoes as one edit. People's Modify tools and agents' bim_modify_detail both
 * call this.
 *
 * A picked rectangle stands for all four sides, or, for an operation that
 * picks one element per point (trim, split, fillet arc on one corner), for
 * the side nearest each point.
 */
export function modifyCommand(
  ownerItems: readonly DrawingItem[],
  ids: readonly string[],
  operation: ModifyOp,
  ownerId: string,
  idPrefix: string,
): { readonly ok: true; readonly command: ViewCommand | BatchCommand; readonly summary: string } | { readonly ok: false; readonly reason: string } {
  const live0 = ownerItems.filter((i) => !i.deleted);
  const known = new Set(live0.map((i) => i.id as string));
  if (ids.some((id) => !known.has(id))) return { ok: false, reason: "Some of those items aren't there any more." };
  const exact = EXACT_MODIFY_OPS.has(operation.op);
  const pickedIds = exact ? [...new Set(ids)] : expandDetailGroups(live0, ids).items.map((i) => i.id as string);
  const upgrade = upgradeForEdit(live0, new Set(pickedIds));
  if (typeof upgrade === "string") return { ok: false, reason: upgrade };
  const live = upgrade.items;
  const points = pickPoints(operation);
  let finalIds: string[];
  if (points && pickedIds.length === 1 && points.length === 2 && upgrade.replaced.has(pickedIds[0] ?? "")) {
    // One rectangle, two picks: the two sides at the corner picked.
    const sides = upgrade.replaced.get(pickedIds[0] ?? "") ?? [];
    finalIds = [nearestSide(live, sides, points[0]), nearestSide(live, sides.filter((s) => s !== nearestSide(live, sides, points[0])), points[1])].filter((s): s is string => s !== undefined);
  } else if (points) {
    finalIds = pickedIds.map((id, i) => {
      const sides = upgrade.replaced.get(id);
      return sides ? (nearestSide(live, sides, points[i]) ?? id) : id;
    });
  } else {
    finalIds = pickedIds.flatMap((id) => upgrade.replaced.get(id) ?? [id]);
  }
  const byId = new Map(live.map((i) => [i.id as string, i]));
  const picked = finalIds.flatMap((id) => {
    const it = byId.get(id);
    return it ? [it] : [];
  });
  const plan = planModify(picked, operation, idPrefix, (id) => byId.get(id), live);
  if (!plan.ok) return plan;
  const owned = (s: ModifyStep | MigrationStep): ViewCommand => (s.type === "copy_drawing_items" ? { ...s, toOwnerId: ownerId } : s.type === "add_drawing_item" ? { ...s, ownerId } : s);
  const commands: ViewCommand[] = [...upgrade.steps.map(owned), ...plan.steps.map(owned)];
  const command = commands.length === 1 && commands[0] ? commands[0] : { type: "batch_documents" as const, label: plan.summary, commands };
  return { ok: true, command, summary: plan.summary };
}
