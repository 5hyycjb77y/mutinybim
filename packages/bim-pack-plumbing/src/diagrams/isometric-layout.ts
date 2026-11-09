import { diagramNodes, oneLineItemsExtent, oneLineTextHeight } from "@permitzip/bim-kernel";
import type { DiagramNode, DiagramPipe, ElementId, OneLineItem, OneLineTextLine, PipeLabel, Vec2 } from "@permitzip/bim-kernel";
import { defaultPipeLabels, pipeLook, type PipeRef, type PipingLayout } from "./piping-layout";

/**
 * The plumbing isometric: every pipe of the systems drawn, at its real place
 * in the model, projected at 30° (plan x to the lower right, plan y to the
 * upper right, height straight up), so stacks stand vertical and each floor's
 * branches lie on their own planes. Fixtures, devices and the source are
 * named where they are; each piece of pipe between them carries the same
 * size and load as the riser. The scale is the largest standard one that fits
 * the sheet area, chosen from the model's extent, so the same model draws the
 * same isometric.
 */

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;
/** Paper mm per model mm: 1/4" = 1'-0" down to 1/64" = 1'-0". */
const SMALLEST = 1 / 768;
const SCALES = [1 / 48, 1 / 96, 1 / 192, 1 / 384, SMALLEST] as const;
const MAX_W = 560;
const MAX_H = 400;
/** An isometric labels only pieces long enough to read beside (a fixture's short arm is named by the fixture). */
const MIN_LABEL_MM = 15;

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
const project = (p: { x: number; y: number; z: number }): Vec2 => ({ x: (p.x - p.y) * COS30, y: (p.x + p.y) * SIN30 + p.z });

export interface IsometricOptions {
  readonly labels?: readonly PipeLabel[];
}

export function layoutPipingIsometric(roots: readonly DiagramNode[], pipes: readonly DiagramPipe[], opts: IsometricOptions = {}): PipingLayout & { readonly scale: number } {
  const items: OneLineItem[] = [];
  const refs: Record<string, PipeRef> = {};
  const nodesOut: Array<{ id: string; kind: DiagramNode["kind"]; name: string; center: Vec2; depth: number }> = [];
  const all = diagramNodes({ roots });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (p: Vec2) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const p of pipes) {
    grow(project(p.a));
    grow(project(p.b));
  }
  for (const n of all) if (n.at) grow(project(n.at));
  if (!Number.isFinite(minX)) return { items, extent: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }, nodes: [], pipes: {}, scale: SMALLEST };
  const scale = SCALES.find((k) => (maxX - minX) * k <= MAX_W && (maxY - minY) * k <= MAX_H) ?? SMALLEST;
  const P = (p: { x: number; y: number; z: number }): Vec2 => {
    const q = project(p);
    return round({ x: (q.x - minX) * scale, y: (q.y - minY) * scale });
  };

  const byId = new Map(pipes.map((p) => [p.elementId as string, p]));
  for (const p of pipes) {
    const look = pipeLook(p.systemKind);
    const id = `pipe:${p.elementId}`;
    refs[id] = { elementId: p.elementId, elementIds: [p.elementId], name: "pipe" };
    items.push({ shape: "line", points: [P(p.a), P(p.b)], weight: look.weight, nodeId: id, ...(look.pattern === "dashed" ? { dashed: true } : {}) });
  }

  // Each piece of pipe between two stations: its labels at the middle of its longest drawn segment (each segment labelled once).
  const labelled = new Set<string>();
  for (const n of all) {
    const edge = n.feed;
    if (!edge?.elementIds) continue;
    const labels = opts.labels ?? defaultPipeLabels(n.service).filter((l) => l === "size" || l === "load");
    let best: { a: Vec2; b: Vec2; len: number; id: ElementId } | null = null;
    for (const id of edge.elementIds) {
      const p = byId.get(id);
      if (!p || labelled.has(id)) continue;
      const a = P(p.a);
      const b = P(p.b);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!best || len > best.len) best = { a, b, len, id };
    }
    if (!best || best.len < MIN_LABEL_MM) continue;
    const lines: OneLineTextLine[] = [];
    for (const l of labels) {
      if (l === "size" && edge.label) lines.push({ text: edge.label });
      if (l === "load" && edge.load && n.role !== "terminal") lines.push({ text: edge.load });
      if (l === "slope" && edge.slope) lines.push({ text: edge.slope });
      if (l === "invert" && edge.invert) lines.push({ text: edge.invert });
      if (l === "length" && edge.lengthFt) lines.push({ text: `${edge.lengthFt} LF` });
    }
    if (lines.length === 0) continue;
    labelled.add(best.id);
    const mid = { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 };
    const h = oneLineTextHeight(lines, 14);
    items.push({ shape: "text", at: round({ x: mid.x + 0.8, y: mid.y + h + 0.6 }), widthMm: 14, lines, nodeId: `pipe:${best.id}`, role: "device" });
  }

  // Fixtures, devices and the source, named where they are.
  for (const n of all) {
    if (!n.at || n.role === "branch" || n.elementId === null) continue;
    const c = P(n.at);
    const r = n.role === "device" ? 1.1 : 1.5;
    items.push({ shape: "polyline", points: [round({ x: c.x - r, y: c.y }), round({ x: c.x, y: c.y + r }), round({ x: c.x + r, y: c.y }), round({ x: c.x, y: c.y - r })], closed: true, weight: "medium", nodeId: n.id });
    const lines = n.lines.slice(0, 1);
    if (lines.length > 0 && n.role !== "device") {
      const w = n.role === "source" ? 40 : 16;
      items.push({ shape: "text", at: round({ x: c.x + r + 0.8, y: c.y + oneLineTextHeight(lines, w) / 2 }), widthMm: w, lines, nodeId: n.id, role: "equipment" });
    }
    nodesOut.push({ id: n.id, kind: n.kind, name: n.name, center: c, depth: 0 });
  }
  return { items, extent: oneLineItemsExtent(items), nodes: nodesOut, pipes: refs, scale };
}
