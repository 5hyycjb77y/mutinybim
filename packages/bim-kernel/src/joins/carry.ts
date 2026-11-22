import type { AuthoredWrite } from "../command-core";
import type { TrackedReader } from "../model";
import { networkOf } from "../network";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { elementKindTable } from "../registry/element-kind-point";
import { registerRevisionCarry } from "../revision-carry";
import { elementsOfKind, recordsOfKinds } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState, type Vec2 } from "../types";
import { LINE_JOIN_POINT, type LineJoinRow } from "./contract";
import { lineLevelId } from "./rows";
import { lineMeetingsOf } from "./solve";

/**
 * Joined ends follow a move (`kernel.line_join`, any line-placed kind whose
 * row has `withLine`). Moving a wall carries what is joined to it, as in
 * Revit, so a corner or a tee stays closed instead of opening a gap:
 *
 * - a corner (another's end at a moved end) goes where the moved end went;
 * - another's end stopped on a moved line's face stays on that face, along
 *   its own line (it stretches or shortens, its direction kept);
 * - a moved end stopped on a still line's face stays on that face, along the
 *   moved line (the moved line stretches or shortens to keep the tee).
 *
 * Joins are read on the record before the move, through the join index
 * (cells round each moved line), so the cost is the moved lines' neighbours,
 * never the level. Elements moved in the same command move rigidly together.
 */

type Elements = Readonly<Record<string, BimElement>>;
type End = "start" | "end";
interface Ends {
  readonly start: Vec2;
  readonly end: Vec2;
}

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** Where the infinite line through `a` (direction `u`) crosses the one through `b` (direction `v`); null when parallel. */
function meet(a: Vec2, u: Vec2, b: Vec2, v: Vec2): Vec2 | null {
  const den = cross(u, v);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(b, a), v) / den;
  return add(a, { x: u.x * t, y: u.y * t });
}

const dirOf = (l: Ends): Vec2 => sub(l.end, l.start);
const lengthOf = (l: Ends): number => Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y);

/** Signed distance of `p` to the left of `l`. */
function sideOffset(l: Ends, p: Vec2): number {
  const len = lengthOf(l);
  return len === 0 ? 0 : cross(dirOf(l), sub(p, l.start)) / len;
}

/** `l` shifted `by` to its left. */
function shifted(l: Ends, by: number): Ends {
  const len = lengthOf(l);
  if (len === 0 || by === 0) return l;
  const n = { x: (-(l.end.y - l.start.y) / len) * by, y: ((l.end.x - l.start.x) / len) * by };
  return { start: add(l.start, n), end: add(l.end, n) };
}

/** True when `p` lies along `l` between its ends (within `slackMm`). */
function within(l: Ends, p: Vec2, slackMm: number): boolean {
  const len = lengthOf(l);
  if (len === 0) return false;
  const t = dot(sub(p, l.start), dirOf(l)) / len;
  return t >= -slackMm && t <= len + slackMm;
}

const withEnd = (l: Ends, end: End, p: Vec2): Ends => (end === "start" ? { start: p, end: l.end } : { start: l.start, end: p });

const tableOf = (set: PackSet): ReadonlyMap<string, LineJoinRow> => new Map(set.items(LINE_JOIN_POINT).map((r) => [r.kind, r] as const));

/**
 * After `moved` (id → plan delta) was applied to `working`, move the joined
 * ends that follow it. `before` is the record the move started from. Returns
 * the ids it rewrote (other lines, and moved lines whose tee kept them on a
 * face); each is written through its row's `withLine`, so its stored copies
 * of the line agree.
 */
export function carryJoinedEnds(before: Elements, working: Record<string, BimElement>, moved: ReadonlyMap<string, Vec2>, set: PackSet = activePackSet()): ElementId[] {
  return carry(before, working, moved, null, set);
}

/**
 * After the lines in `reshaped` (id → its new line) were rewritten in
 * `working` by moving one or both of their ends, move the joined ends that
 * follow: a corner at a moved end goes where that end went, and another's end
 * stopped on a reshaped line's face stays on its new face. An end that did
 * not move carries nothing, and a dragged end goes exactly where it was
 * dragged (it is not pulled back onto a face it left). Same index reads as a
 * move: the reshaped lines' neighbours, never the level.
 */
export function carryJoinedEndsOfReshape(before: Elements, working: Record<string, BimElement>, reshaped: ReadonlyMap<string, Ends>, set: PackSet = activePackSet()): ElementId[] {
  return carry(before, working, null, reshaped, set);
}

function carry(before: Elements, working: Record<string, BimElement>, moved: ReadonlyMap<string, Vec2> | null, reshaped: ReadonlyMap<string, Ends> | null, set: PackSet): ElementId[] {
  const table = set.memo("kernel.line_join#table", tableOf);
  const ids: ReadonlyMap<string, unknown> = moved ?? reshaped ?? new Map();
  if (table.size === 0 || ids.size === 0) return [];
  const lineIn = (els: Elements, id: string): Ends | null => {
    const el = els[id];
    const row = el ? table.get(el.kind) : undefined;
    const l = el && row ? row.line(el, els) : null;
    return l ? { start: l.start, end: l.end } : null;
  };
  /** The lines being rewritten, from their current (working) line. */
  const pending = new Map<string, Ends>();
  const current = (id: string): Ends | null => pending.get(id) ?? lineIn(working, id);
  const setEnd = (id: string, end: End, p: Vec2): void => {
    const l = current(id);
    if (l) pending.set(id, withEnd(l, end, p));
  };
  const writable = (id: string): boolean => {
    const el = working[id];
    return el !== undefined && typeof table.get(el.kind)?.withLine === "function";
  };

  for (const id of ids.keys()) {
    const was = lineIn(before, id);
    const meetings = was ? lineMeetingsOf(before, id, set) : null;
    if (!was || !meetings) continue;
    const d = moved?.get(id);
    const now: Ends | undefined = d ? { start: add(was.start, d), end: add(was.end, d) } : reshaped?.get(id);
    if (!now) continue;
    for (const m of meetings.atEnds) {
      if (ids.has(m.otherId)) continue;
      const p0 = m.end === "start" ? was.start : was.end;
      const dEnd = d ?? sub(m.end === "start" ? now.start : now.end, p0);
      // Reshaping: an end that stayed put carries nothing.
      if (!d && dEnd.x === 0 && dEnd.y === 0) continue;
      if (m.otherEnd !== null) {
        // A corner: the other's end goes where this end went.
        if (writable(m.otherId)) setEnd(m.otherId, m.otherEnd, add(p0, dEnd));
        continue;
      }
      // A dragged end goes where it was dragged, even off a face it stopped on.
      if (!d) continue;
      // This end stopped on a still line's face: keep it there, along this line.
      const host = lineIn(before, m.otherId);
      if (!host || !writable(id)) continue;
      const face = shifted(host, sideOffset(host, p0));
      const mine = current(id) ?? now;
      const q = meet(mine.start, dirOf(mine), face.start, dirOf(face));
      if (q && within(host, q, 0)) setEnd(id, m.end, q);
    }
    for (const f of meetings.onFace) {
      if (ids.has(f.otherId) || !writable(f.otherId)) continue;
      const other = current(f.otherId);
      const otherWas = lineIn(before, f.otherId);
      if (!other || !otherWas) continue;
      const p0 = f.otherEnd === "start" ? otherWas.start : otherWas.end;
      // The other's end stays on this line's face, at the same offset from its centre, along its own line.
      const face = shifted(now, sideOffset(was, p0));
      const q = meet(other.start, dirOf(other), face.start, dirOf(face));
      if (q && within(now, q, 0)) setEnd(f.otherId, f.otherEnd, q);
    }
  }

  const out: ElementId[] = [];
  for (const [id, l] of pending) {
    const el = working[id];
    const row = el ? table.get(el.kind) : undefined;
    if (!el || !row?.withLine) continue;
    const was = lineIn(working, id);
    const next = row.withLine(el, l, working);
    const after = row.line(next, working);
    if (was && after && was.start.x === after.start.x && was.start.y === after.start.y && was.end.x === after.end.x && was.end.y === after.end.y) continue;
    working[id] = next;
    out.push(asElementId(id));
  }
  return out;
}

const isPoint = (v: unknown): v is Vec2 => typeof v === "object" && v !== null && "x" in v && "y" in v && typeof v.x === "number" && typeof v.y === "number";

/**
 * A move command's share: carry the joined ends, read each rewritten record
 * (and what is hosted on or tagged to it, so `finish` re-derives them) and
 * author its new line.
 */
export function carryJoinedEndsOfMove(model: ModelState, reader: TrackedReader, working: Record<string, BimElement>, touched: { add(id: ElementId): unknown }, authored: AuthoredWrite[], moved: ReadonlyMap<string, Vec2>): void {
  recordCarried(model, reader, working, touched, authored, carryJoinedEnds(model.elements, working, moved));
  recordCarried(model, reader, working, touched, authored, carryBoundaryOutlines(model.elements, working, moved));
}

/**
 * Incremental 2D cell grid over area-boundary elements (`slab`, `ceiling`, and
 * area-placed add-on kinds) so `carryBoundaryOutlines` checks only the handful
 * of boundaries whose bounding boxes meet a moved wall — never every ceiling or
 * slab on the model. Carried across revisions via `registerRevisionCarry`.
 */
const AREA_CELL_MM = 4000;
const AREA_MAX_CELLS = 256;
const AREA_MAX_DEPTH = 64;
const NO_IDS: readonly string[] = Object.freeze([]);

interface AreaEntry {
  readonly id: string;
  readonly levelId: ElementId | "";
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly cells: readonly string[] | null;
}

interface AreaLayer {
  readonly parent: AreaLayer | null;
  readonly entries: ReadonlyMap<string, AreaEntry | null>;
  readonly cells: ReadonlyMap<string, readonly string[]>;
  readonly wide: ReadonlySet<string>;
  readonly depth: number;
}

function areaKindsOf(set: PackSet): readonly string[] {
  const kindTable = elementKindTable(set);
  const out = new Set<string>(["slab", "ceiling"]);
  for (const k of kindTable.kinds) {
    if (kindTable.row(k)?.create?.placements.includes("area")) out.add(k);
  }
  return [...out];
}

function areaKindsIn(set: PackSet): readonly string[] {
  return set.memo("kernel.area_boundary#kinds", areaKindsOf);
}

function outlineOfArea(el: BimElement): readonly Vec2[] | undefined {
  const rec = el as BimElement & { readonly outline?: readonly Vec2[]; readonly placement?: { readonly kind: string; readonly outline?: readonly Vec2[] } };
  if (Array.isArray(rec.outline) && rec.outline.length >= 3) return rec.outline;
  if (rec.placement?.kind === "area" && Array.isArray(rec.placement.outline) && rec.placement.outline.length >= 3) return rec.placement.outline;
  return undefined;
}

function areaLevelId(el: BimElement, levelsByName: ReadonlyMap<string, ElementId> | null): ElementId | "" {
  const rec = el as BimElement & { readonly levelId?: string; readonly placement?: { readonly levelId?: string } };
  if (typeof rec.placement?.levelId === "string" && rec.placement.levelId.length > 0) return asElementId(rec.placement.levelId);
  if (typeof rec.levelId === "string" && rec.levelId.length > 0) return asElementId(rec.levelId);
  const name = el.partition?.level;
  return name && levelsByName ? (levelsByName.get(name) ?? "") : "";
}

function areaEntryOf(el: BimElement, kindSet: ReadonlySet<string>, levelsByName: ReadonlyMap<string, ElementId> | null): AreaEntry | null {
  if (!kindSet.has(el.kind)) return null;
  const outline = outlineOfArea(el);
  if (!outline) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of outline) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX + minY + maxX + maxY)) return null;
  const x0 = Math.floor(minX / AREA_CELL_MM);
  const x1 = Math.floor(maxX / AREA_CELL_MM);
  const y0 = Math.floor(minY / AREA_CELL_MM);
  const y1 = Math.floor(maxY / AREA_CELL_MM);
  let cells: string[] | null = null;
  if ((x1 - x0 + 1) * (y1 - y0 + 1) <= AREA_MAX_CELLS) {
    cells = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push(`${x}|${y}`);
  }
  return { id: el.id, levelId: areaLevelId(el, levelsByName), minX, minY, maxX, maxY, cells };
}

function sameAreaEntry(a: AreaEntry | null, b: AreaEntry | null): boolean {
  return a === b || (a !== null && b !== null && a.levelId === b.levelId && a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY);
}

function lookupAreaEntry(layer: AreaLayer, id: string): AreaEntry | null {
  for (let l: AreaLayer | null = layer; l; l = l.parent) {
    const hit = l.entries.get(id);
    if (hit !== undefined) return hit;
  }
  return null;
}

function lookupAreaCell(layer: AreaLayer, key: string): readonly string[] {
  for (let l: AreaLayer | null = layer; l; l = l.parent) {
    const hit = l.cells.get(key);
    if (hit) return hit;
  }
  return NO_IDS;
}

function buildAreaLayer(elements: Elements, kinds: readonly string[]): AreaLayer {
  const kindSet = new Set(kinds);
  const entries = new Map<string, AreaEntry | null>();
  const cells = new Map<string, string[]>();
  const wide = new Set<string>();
  const records = recordsOfKinds(elements, kinds);
  let levelsByName: Map<string, ElementId> | null = null;
  const resolveLevels = () => (levelsByName ??= new Map(elementsOfKind(elements, "level").map((l) => [l.name, l.id] as const)));
  for (const el of records) {
    const rec = el as BimElement & { readonly levelId?: string; readonly placement?: { readonly levelId?: string } };
    const needsLevels = !rec.placement?.levelId && !rec.levelId && Boolean(el.partition?.level);
    const entry = areaEntryOf(el, kindSet, needsLevels ? resolveLevels() : null);
    if (!entry) continue;
    entries.set(el.id, entry);
    if (entry.cells) {
      for (const k of entry.cells) {
        const list = cells.get(k);
        if (list) list.push(el.id);
        else cells.set(k, [el.id]);
      }
    } else {
      wide.add(el.id);
    }
  }
  return { parent: null, entries, cells, wide, depth: 0 };
}

function foldAreaLayer(layer: AreaLayer): AreaLayer {
  const chain: AreaLayer[] = [];
  for (let l: AreaLayer | null = layer; l; l = l.parent) chain.push(l);
  const entries = new Map<string, AreaEntry | null>();
  const cells = new Map<string, readonly string[]>();
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const [k, v] of chain[i]?.entries ?? []) entries.set(k, v);
    for (const [k, v] of chain[i]?.cells ?? []) cells.set(k, v);
  }
  return { parent: null, entries, cells, wide: new Set(layer.wide), depth: 0 };
}

function deriveAreaLayer(base: AreaLayer, to: Elements, changedIds: readonly string[], kinds: readonly string[]): AreaLayer {
  const kindSet = new Set(kinds);
  const entries = new Map<string, AreaEntry | null>();
  const cells = new Map<string, string[]>();
  let wide: Set<string> | null = null;
  let levelsByName: Map<string, ElementId> | null = null;
  const resolveLevels = () => (levelsByName ??= new Map(elementsOfKind(to, "level").map((l) => [l.name, l.id] as const)));
  const cellFor = (key: string): string[] => {
    let list = cells.get(key);
    if (!list) {
      list = [...lookupAreaCell(base, key)];
      cells.set(key, list);
    }
    return list;
  };
  for (const id of changedIds) {
    const was = lookupAreaEntry(base, id);
    const el = to[id];
    let now: AreaEntry | null = null;
    if (el && kindSet.has(el.kind)) {
      const rec = el as BimElement & { readonly levelId?: string; readonly placement?: { readonly levelId?: string } };
      const needsLevels = !rec.placement?.levelId && !rec.levelId && Boolean(el.partition?.level);
      now = areaEntryOf(el, kindSet, needsLevels ? resolveLevels() : null);
    }
    if (sameAreaEntry(was, now)) continue;
    if (was) {
      if (was.cells) {
        for (const k of was.cells) {
          const list = cellFor(k);
          const at = list.indexOf(id);
          if (at >= 0) list.splice(at, 1);
        }
      } else {
        (wide ??= new Set(base.wide)).delete(id);
      }
    }
    if (now) {
      if (now.cells) for (const k of now.cells) cellFor(k).push(id);
      else (wide ??= new Set(base.wide)).add(id);
    }
    entries.set(id, now);
  }
  if (entries.size === 0) return base;
  const next: AreaLayer = { parent: base, entries, cells, wide: wide ?? base.wide, depth: base.depth + 1 };
  return next.depth > AREA_MAX_DEPTH ? foldAreaLayer(next) : next;
}

const areaCache = new WeakMap<Elements, Map<PackSet, AreaLayer>>();

function areaLayerFor(elements: Elements, set: PackSet): AreaLayer {
  let held = areaCache.get(elements);
  const hit = held?.get(set);
  if (hit) return hit;
  const layer = buildAreaLayer(elements, areaKindsIn(set));
  if (!held) {
    held = new Map();
    areaCache.set(elements, held);
  }
  held.set(set, layer);
  return layer;
}

registerRevisionCarry("kernel.area_boundary", (from, to, changedIds) => {
  const held = areaCache.get(from);
  if (!held) return;
  let target = areaCache.get(to);
  for (const [set, layer] of held) {
    if (target?.has(set)) continue;
    if (!target) {
      target = new Map();
      areaCache.set(to, target);
    }
    target.set(set, deriveAreaLayer(layer, to, changedIds, areaKindsIn(set)));
  }
});

/**
 * When a wall translates perpendicular to its length, reshape any slab, ceiling,
 * or area-placed surface boundary edge that sat flush against the wall on the
 * same level (or on the wall's topLevelId for add-on surfaces) so boundaries
 * follow wall moves automatically instead of poking out or pulling back.
 */
function carryBoundaryOutlines(before: Elements, working: Record<string, BimElement>, moved: ReadonlyMap<string, Vec2>, set: PackSet = activePackSet()): readonly ElementId[] {
  const wallMoves: {
    readonly start: Vec2;
    readonly end: Vec2;
    readonly ux: number;
    readonly uy: number;
    readonly nx: number;
    readonly ny: number;
    readonly len: number;
    readonly halfT: number;
    readonly tol: number;
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
    readonly dn: number;
    readonly levelId: ElementId | "";
    readonly topLevelId: ElementId | "";
  }[] = [];
  for (const [id, d] of moved) {
    if (d.x === 0 && d.y === 0) continue;
    const el = before[id];
    if (el?.kind !== "wall") continue;
    const dx = el.end.x - el.start.x;
    const dy = el.end.y - el.start.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const dn = d.x * nx + d.y * ny;
    if (Math.abs(dn) < 0.5) continue;
    const levelId = lineLevelId(el, before);
    const topLevelId = el.placement && "topLevelId" in el.placement && el.placement.topLevelId ? el.placement.topLevelId : "";
    const halfT = el.thickness / 2;
    const tol = halfT + 30;
    wallMoves.push({
      start: el.start,
      end: el.end,
      ux,
      uy,
      nx,
      ny,
      len,
      halfT,
      tol,
      minX: Math.min(el.start.x, el.end.x) - tol,
      minY: Math.min(el.start.y, el.end.y) - tol,
      maxX: Math.max(el.start.x, el.end.x) + tol,
      maxY: Math.max(el.start.y, el.end.y) + tol,
      dn,
      levelId,
      topLevelId,
    });
  }
  if (wallMoves.length === 0) return [];

  const layer = areaLayerFor(before, set);
  const candidateIds = new Set<string>(layer.wide);
  for (const w of wallMoves) {
    const x0 = Math.floor(w.minX / AREA_CELL_MM);
    const x1 = Math.floor(w.maxX / AREA_CELL_MM);
    const y0 = Math.floor(w.minY / AREA_CELL_MM);
    const y1 = Math.floor(w.maxY / AREA_CELL_MM);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const id of lookupAreaCell(layer, `${x}|${y}`)) candidateIds.add(id);
      }
    }
  }
  if (candidateIds.size === 0) return [];

  const out: ElementId[] = [];
  for (const id of candidateIds) {
    if (moved.has(id)) continue;
    const entry = lookupAreaEntry(layer, id);
    if (!entry) continue;
    const rec = working[id] as (BimElement & { readonly outline?: readonly Vec2[]; readonly placement?: { readonly kind: string; readonly outline?: readonly Vec2[] } }) | undefined;
    if (!rec) continue;
    const rawOutline = outlineOfArea(rec);
    if (!rawOutline) continue;

    const candLevelId = entry.levelId;
    const isAddOnSurface = rec.kind !== "slab" && rec.kind !== "ceiling";
    const n = rawOutline.length;
    let pts: { x: number; y: number }[] | null = null;
    for (const w of wallMoves) {
      if (entry.maxX < w.minX || entry.minX > w.maxX || entry.maxY < w.minY || entry.minY > w.maxY) continue;
      // Only carry boundaries on the wall's own level (or, for add-on surfaces, on the wall's topLevelId).
      const sameLevel = candLevelId === w.levelId;
      const onWallTop = isAddOnSurface && w.topLevelId !== "" && candLevelId === w.topLevelId;
      if (!sameLevel && !onWallTop) continue;
      const tol = w.tol;
      for (let i = 0; i < n; i++) {
        const cur = pts ?? rawOutline;
        const a = cur[i]!;
        const b = cur[(i + 1) % n]!;
        const edx = b.x - a.x;
        const edy = b.y - a.y;
        const elen = Math.hypot(edx, edy);
        if (elen < 1e-3) continue;
        // Edge must be parallel to the moved wall (within ~2 degrees)
        const crossVal = Math.abs((edx / elen) * w.uy - (edy / elen) * w.ux);
        if (crossVal > 0.035) continue;
        // Both endpoints must sit on the wall's centerline or face band
        const da = (a.x - w.start.x) * w.nx + (a.y - w.start.y) * w.ny;
        const db = (b.x - w.start.x) * w.nx + (b.y - w.start.y) * w.ny;
        if (Math.abs(da) > tol || Math.abs(db) > tol || Math.abs(da - db) > 25) continue;
        // And the edge must share positive longitudinal overlap with the wall (not merely touch at one corner vertex)
        const ta = (a.x - w.start.x) * w.ux + (a.y - w.start.y) * w.uy;
        const tb = (b.x - w.start.x) * w.ux + (b.y - w.start.y) * w.uy;
        const overlap = Math.min(Math.max(ta, tb), w.len) - Math.max(Math.min(ta, tb), 0);
        if (overlap < Math.min(100, w.len * 0.25)) continue;
        // Lazy copy-on-write: only allocate mutable vertices when an edge actually shifts.
        pts ??= rawOutline.map((p) => ({ x: p.x, y: p.y }));
        const sx = w.nx * w.dn;
        const sy = w.ny * w.dn;
        pts[i] = { x: Math.round((a.x + sx) * 1000) / 1000, y: Math.round((a.y + sy) * 1000) / 1000 };
        pts[(i + 1) % n] = { x: Math.round((b.x + sx) * 1000) / 1000, y: Math.round((b.y + sy) * 1000) / 1000 };
      }
    }
    if (!pts) continue;
    const nextRec = {
      ...rec,
      ...(Array.isArray(rec.outline) ? { outline: pts } : {}),
      ...(rec.placement?.kind === "area" ? { placement: { ...rec.placement, outline: pts } } : {}),
    } as BimElement;
    working[id] = nextRec;
    out.push(asElementId(id));
  }
  return out;
}

/** `carryJoinedEndsOfMove` for lines whose ends were moved one at a time (`carryJoinedEndsOfReshape`). Returns the ids that followed. */
export function carryJoinedEndsOfReshapeCommand(model: ModelState, reader: TrackedReader, working: Record<string, BimElement>, touched: { add(id: ElementId): unknown }, authored: AuthoredWrite[], reshaped: ReadonlyMap<string, Ends>): readonly ElementId[] {
  const carried = carryJoinedEndsOfReshape(model.elements, working, reshaped);
  recordCarried(model, reader, working, touched, authored, carried);
  return carried;
}

/**
 * What follows when one end of a line is dragged: the lines at a corner with
 * that end, and those whose end stops on its face (they stay on it as it
 * turns). Read through the join index, for a tool's hint before the drag lands.
 */
export function joinedEndFollowers(elements: Elements, id: string, end: "start" | "end", set: PackSet = activePackSet()): readonly ElementId[] {
  const meetings = lineMeetingsOf(elements, id, set);
  if (!meetings) return [];
  const out = new Set<ElementId>();
  for (const m of meetings.atEnds) if (m.end === end && m.otherEnd !== null) out.add(m.otherId);
  for (const f of meetings.onFace) out.add(f.otherId);
  return [...out];
}

function recordCarried(model: ModelState, reader: TrackedReader, working: Record<string, BimElement>, touched: { add(id: ElementId): unknown }, authored: AuthoredWrite[], carried: readonly ElementId[]): void {
  for (const id of carried) {
    reader.get(id);
    touched.add(id);
    for (const dep of networkOf(model).dependents(id)) reader.get(dep);
    const el = working[id];
    if (el && "start" in el && "end" in el && isPoint(el.start) && isPoint(el.end)) authored.push({ elementId: id, field: "start", value: el.start }, { elementId: id, field: "end", value: el.end });
  }
}
