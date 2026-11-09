import { registerRevisionCarry } from "../revision-carry";
import { recordsOfKinds } from "../store";
import { asElementId, type BimElement, type ElementId, type Vec2 } from "../types";
import { hostHalfWidth } from "./geometry";
import type { RunSegment } from "./types";

/**
 * Straight runs by level and plan cell, for "which runs are near
 * this point" without reading the model: connect-into's nearest run, the "+"
 * grip's candidates. Built once per element record from the run kind's own
 * list, then carried onto each next revision with only the changed runs
 * re-filed, so a read after an edit costs the few cells it looks at.
 */

type Elements = Readonly<Record<string, BimElement>>;

const CELL_MM = 4000;
const MAX_DEPTH = 64;
const NONE: readonly ElementId[] = Object.freeze([]);

interface Box {
  readonly levelId: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface Layer {
  readonly parent: Layer | null;
  readonly boxes: ReadonlyMap<string, Box | null>;
  readonly cells: ReadonlyMap<string, readonly ElementId[]>;
  readonly depth: number;
}

function boxOf(el: BimElement | undefined): Box | null {
  if (el?.kind !== "run_segment") return null;
  const pad = hostHalfWidth(el.size);
  return {
    levelId: el.levelId,
    x0: Math.min(el.start.x, el.end.x) - pad,
    y0: Math.min(el.start.y, el.end.y) - pad,
    x1: Math.max(el.start.x, el.end.x) + pad,
    y1: Math.max(el.start.y, el.end.y) + pad,
  };
}

const cellKey = (levelId: string, cx: number, cy: number) => `${levelId}|${cx}|${cy}`;

function keysOf(b: Box): string[] {
  const out: string[] = [];
  for (let x = Math.floor(b.x0 / CELL_MM); x <= Math.floor(b.x1 / CELL_MM); x++) {
    for (let y = Math.floor(b.y0 / CELL_MM); y <= Math.floor(b.y1 / CELL_MM); y++) out.push(cellKey(b.levelId, x, y));
  }
  return out;
}

const sameBox = (a: Box | null, b: Box | null) => a === b || (a !== null && b !== null && a.levelId === b.levelId && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1);

function lookupBox(layer: Layer, id: string): Box | null {
  for (let l: Layer | null = layer; l; l = l.parent) {
    const hit = l.boxes.get(id);
    if (hit !== undefined) return hit;
  }
  return null;
}

function lookupCell(layer: Layer, key: string): readonly ElementId[] {
  for (let l: Layer | null = layer; l; l = l.parent) {
    const hit = l.cells.get(key);
    if (hit) return hit;
  }
  return NONE;
}

function build(elements: Elements): Layer {
  const boxes = new Map<string, Box | null>();
  const cells = new Map<string, ElementId[]>();
  for (const el of recordsOfKinds(elements, ["run_segment"])) {
    const b = boxOf(el);
    if (!b) continue;
    boxes.set(el.id, b);
    for (const key of keysOf(b)) {
      const list = cells.get(key);
      if (list) list.push(el.id);
      else cells.set(key, [el.id]);
    }
  }
  return { parent: null, boxes, cells, depth: 0 };
}

function fold(layer: Layer): Layer {
  const chain: Layer[] = [];
  for (let l: Layer | null = layer; l; l = l.parent) chain.push(l);
  const boxes = new Map<string, Box | null>();
  const cells = new Map<string, readonly ElementId[]>();
  for (let i = chain.length - 1; i >= 0; i--) {
    for (const [k, v] of chain[i]?.boxes ?? []) boxes.set(k, v);
    for (const [k, v] of chain[i]?.cells ?? []) cells.set(k, v);
  }
  return { parent: null, boxes, cells, depth: 0 };
}

function derive(base: Layer, to: Elements, changedIds: readonly string[]): Layer {
  const boxes = new Map<string, Box | null>();
  const cells = new Map<string, ElementId[]>();
  const cellFor = (key: string): ElementId[] => {
    let list = cells.get(key);
    if (!list) {
      list = [...lookupCell(base, key)];
      cells.set(key, list);
    }
    return list;
  };
  for (const id of changedIds) {
    const was = lookupBox(base, id);
    const el = to[id];
    const now = boxOf(el);
    if (sameBox(was, now)) continue;
    if (was) {
      for (const key of keysOf(was)) {
        const list = cellFor(key);
        const at = list.indexOf(asElementId(id));
        if (at >= 0) list.splice(at, 1);
      }
    }
    if (now && el) for (const key of keysOf(now)) cellFor(key).push(el.id);
    boxes.set(id, now);
  }
  if (boxes.size === 0) return base;
  const next: Layer = { parent: base, boxes, cells, depth: base.depth + 1 };
  return next.depth > MAX_DEPTH ? fold(next) : next;
}

const cache = new WeakMap<Elements, Layer>();

function indexFor(elements: Elements): Layer {
  const hit = cache.get(elements);
  if (hit) return hit;
  const layer = build(elements);
  cache.set(elements, layer);
  return layer;
}

registerRevisionCarry("kernel.run_cells", (from, to, changedIds) => {
  const held = cache.get(from);
  if (!held || cache.has(to)) return;
  cache.set(to, derive(held, to, changedIds));
});

/** Plan distance from a point to a straight run's centreline, mm. */
export function planDistanceToRun(p: Vec2, seg: Pick<RunSegment, "start" | "end">): number {
  const ax = seg.end.x - seg.start.x;
  const ay = seg.end.y - seg.start.y;
  const len2 = ax * ax + ay * ay;
  const k = len2 < 1e-9 ? 0 : Math.min(1, Math.max(0, ((p.x - seg.start.x) * ax + (p.y - seg.start.y) * ay) / len2));
  return Math.hypot(seg.start.x + ax * k - p.x, seg.start.y + ay * k - p.y);
}

/**
 * Straight runs on `levelId` whose plan box comes within `radiusMm` of `p`,
 * nearest centreline first (ties by id), each listed once. Reads only the
 * cells the circle covers.
 */
export function runsNear(elements: Elements, levelId: string, p: Vec2, radiusMm: number, keep: (seg: RunSegment) => boolean = () => true): RunSegment[] {
  const layer = indexFor(elements);
  const seen = new Set<string>();
  const found: Array<{ seg: RunSegment; d: number }> = [];
  for (let x = Math.floor((p.x - radiusMm) / CELL_MM); x <= Math.floor((p.x + radiusMm) / CELL_MM); x++) {
    for (let y = Math.floor((p.y - radiusMm) / CELL_MM); y <= Math.floor((p.y + radiusMm) / CELL_MM); y++) {
      for (const id of lookupCell(layer, cellKey(levelId, x, y))) {
        if (seen.has(id)) continue;
        seen.add(id);
        const el = elements[id];
        if (el?.kind !== "run_segment" || !keep(el)) continue;
        const d = planDistanceToRun(p, el);
        if (d <= radiusMm) found.push({ seg: el, d });
      }
    }
  }
  found.sort((a, b) => a.d - b.d || (a.seg.id < b.seg.id ? -1 : a.seg.id > b.seg.id ? 1 : 0));
  return found.map((f) => f.seg);
}
