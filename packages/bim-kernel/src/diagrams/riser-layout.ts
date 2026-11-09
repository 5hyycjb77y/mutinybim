import { ONE_LINE_TEXT_MM, oneLineItemsExtent, oneLineTextHeight, type OneLineItem, type OneLineLayout, type OneLineTextLine } from "../layout/one-line";
import type { BimElement, Vec2 } from "../types";
import type { DiagramNode } from "./graph";

/**
 * A riser diagram from any diagram graph: the building's levels as
 * horizontal bands, top floor at the top; each node a box on its own level in
 * its own column (columns in tree order, so a source sits left of what it
 * feeds); each link an orthogonal line from the source's box down (or up) to
 * what it serves, with the link's label beside the rise. Trade-neutral: the
 * electrical riser and the plumbing riser both draw through it.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface RiserLevel {
  readonly id: string;
  readonly name: string;
  readonly elevationMm: number;
}

const COLUMN = 46;
const ROW = 52;
const BOX_W = 34;
const BOX_H = 11;
const LEFT = 34;

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

/** The model's levels, highest first, plus a row for equipment on no known level. */
export function riserLevels(elements: Elements): RiserLevel[] {
  const out: RiserLevel[] = [];
  for (const el of Object.values(elements)) if (el.kind === "level") out.push({ id: el.id, name: el.name, elevationMm: el.elevationMm });
  return out.sort((a, b) => b.elevationMm - a.elevationMm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Lay out a riser; the same graph and levels give the same items. */
export function layoutRiser(roots: readonly DiagramNode[], levels: readonly RiserLevel[]): OneLineLayout {
  const items: OneLineItem[] = [];
  const nodes: Array<{ id: string; kind: DiagramNode["kind"]; name: string; center: Vec2; depth: number }> = [];
  const ranges: Record<string, readonly [number, number]> = {};
  const entries: Record<string, Vec2> = {};
  const rowOf = new Map(levels.map((l, i) => [l.id, i]));
  const unknownRow = levels.length;
  const usedUnknown = { value: false };
  const order: Array<{ node: DiagramNode; depth: number; parent: DiagramNode | null }> = [];
  const walk = (n: DiagramNode, depth: number, parent: DiagramNode | null) => {
    order.push({ node: n, depth, parent });
    if (n.emergency) walk(n.emergency, depth + 1, n);
    for (const c of n.children) walk(c, depth + 1, n);
  };
  for (const r of roots) walk(r, 0, null);
  const col = new Map(order.map((o, i) => [o.node.id, i]));
  const row = (n: DiagramNode): number => {
    const r = n.levelId !== null ? rowOf.get(n.levelId) : undefined;
    if (r === undefined) {
      usedUnknown.value = true;
      return unknownRow;
    }
    return r;
  };
  const boxAt = (n: DiagramNode): { min: Vec2; max: Vec2 } => {
    const x = LEFT + (col.get(n.id) ?? 0) * COLUMN;
    const floorY = -(row(n) + 1) * ROW;
    return { min: { x, y: floorY + 12 }, max: { x: x + BOX_W, y: floorY + 12 + BOX_H } };
  };
  const width = LEFT + Math.max(1, order.length) * COLUMN;

  const ranged = (id: string, draw: () => void) => {
    const start = items.length;
    draw();
    ranges[id] = [start, items.length];
  };

  // Each node's own box (name inside, ratings above it) and the line from its source (under the boxes).
  const drawNode = (n: DiagramNode, depth: number, parent: DiagramNode | null) => {
    const b = boxAt(n);
    const dashed = n.placeholder ? { dashed: true } : {};
    items.push({ shape: "polyline", points: [b.min, { x: b.max.x, y: b.min.y }, b.max, { x: b.min.x, y: b.max.y }, b.min].map(round), weight: "medium", nodeId: n.id, ...dashed });
    const name: OneLineTextLine[] = n.lines.length > 0 ? n.lines.slice(0, 1) : [{ text: n.name.toUpperCase(), bold: true }];
    items.push({ shape: "text", at: round({ x: b.min.x, y: b.max.y - 3 }), widthMm: BOX_W, lines: name, nodeId: n.id, role: "equipment", align: "center" });
    const more = n.lines.slice(1, 4);
    if (more.length > 0) items.push({ shape: "text", at: round({ x: b.min.x, y: b.max.y + 1 + oneLineTextHeight(more, COLUMN - 4) }), widthMm: COLUMN - 4, lines: more, nodeId: n.id, role: "note" });
    nodes.push({ id: n.id, kind: n.kind, name: n.name, center: round({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 }), depth });
    if (!parent) return;
    const p = boxAt(parent);
    const px = (p.min.x + p.max.x) / 2;
    const cx = b.min.x + 6;
    // Down from the source, along under the boxes, then up or down into what it serves at its own column.
    const step = Math.min(3, Math.max(0, (col.get(n.id) ?? 0) - (col.get(parent.id) ?? 0) - 1));
    const runY = p.min.y - 4 - step * 0.8;
    const childUp = b.min.y > runY;
    const endY = childUp ? b.min.y : b.max.y;
    const start = { x: px, y: p.min.y };
    entries[n.id] = round(start);
    const feedId = `${n.id}#feed`;
    items.push({ shape: "polyline", points: [start, { x: px, y: runY }, { x: cx, y: runY }, { x: cx, y: endY }].map(round), weight: "medium", nodeId: feedId, ...dashed });
    const label = [n.feed?.deviceLabel, n.feed?.label].filter((s): s is string => !!s);
    if (label.length > 0) items.push({ shape: "text", at: round({ x: cx + 1.2, y: runY - 0.8 }), widthMm: COLUMN - 10, lines: label.map((t) => ({ text: t.toUpperCase() })), nodeId: feedId, role: "device" });
    if (n.feed?.typeMark) {
      const w = Math.max(12, n.feed.typeMark.length * ONE_LINE_TEXT_MM * 0.8 + 5);
      items.push({ shape: "oval", center: round({ x: cx - w / 2 - 2, y: runY }), text: n.feed.typeMark.toUpperCase(), widthMm: w, heightMm: 5, nodeId: feedId });
    }
  };

  const drawTree = (n: DiagramNode, depth: number, parent: DiagramNode | null) => {
    ranged(n.id, () => {
      drawNode(n, depth, parent);
      if (n.emergency) drawTree(n.emergency, depth + 1, n);
      for (const c of n.children) drawTree(c, depth + 1, n);
    });
  };
  for (const r of roots) drawTree(r, 0, null);

  // Levels last so they never hide a box: a floor line and the level's name at the left.
  const rows = [...levels.map((l) => l.name), ...(usedUnknown.value ? ["No level"] : [])];
  rows.forEach((name, i) => {
    const y = -(i + 1) * ROW;
    items.push({ shape: "line", points: [round({ x: 0, y }), round({ x: width, y })], weight: "thin", nodeId: "levels" });
    items.push({ shape: "text", at: round({ x: 0, y: y + oneLineTextHeight([{ text: name }], LEFT - 4) + 1 }), widthMm: LEFT - 4, lines: [{ text: name.toUpperCase(), bold: true }], nodeId: "levels", role: "note" });
  });
  return { items, extent: oneLineItemsExtent(items), nodes, ranges, entries };
}

