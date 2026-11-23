import { diagramNodes, drainSystemKinds, oneLineItemsExtent, oneLineTextHeight } from "@permitzip/bim-kernel";
import type { DiagramNode, DiagramPipe, ElementId, OneLineItem, OneLineTextLine, PipeLabel, Vec2 } from "@permitzip/bim-kernel";
import { defaultPipeLabels, pipeLook, type PipeRef, type PipingLayout } from "./piping-layout";

/**
 * The plumbing isometric: every pipe of the systems drawn, at its real place
 * in the model, projected at 30° (plan x to the lower right, plan y to the
 * upper right, height straight up), so stacks stand vertical and each floor's
 * branches lie on their own planes. Includes 3D over/under crossing break gaps,
 * isometric elbow/tee/wye fitting ticks, and non-overlapping equipment/pipe
 * callouts.
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
/** Half-width of the break gap opened in a farther pipe where a nearer pipe crosses over it (paper mm). */
const CROSS_GAP_MM = 1.4;
/** Half-length of isometric fitting socket ticks at pipe junctions (paper mm). */
const TICK_HALF_MM = 0.85;
/** Offset along each leg from a junction vertex to its fitting tick (paper mm). */
const TICK_OFFSET_MM = 1.1;

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
const project = (p: { x: number; y: number; z: number }): Vec2 => ({ x: (p.x - p.y) * COS30, y: (p.x + p.y) * SIN30 + p.z });
/** Isometric camera depth (larger is closer to the viewer looking from south-west, above). */
const isoDepth = (p: { x: number; y: number; z: number }): number => -p.x - p.y + p.z;

interface Seg2D {
  readonly pipe: DiagramPipe;
  readonly a: Vec2;
  readonly b: Vec2;
  readonly da: number;
  readonly db: number;
  readonly len: number;
  readonly id: string;
}

interface LabelBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/** Parameter (t, u) where segment p0->p1 strictly crosses q0->q1 away from endpoints, or null. */
function interiorCross(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): { t: number; u: number } | null {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const ex = q1.x - q0.x;
  const ey = q1.y - q0.y;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-6) return null;
  const wx = q0.x - p0.x;
  const wy = q0.y - p0.y;
  const t = (wx * ey - wy * ex) / den;
  const u = (wx * dy - wy * dx) / den;
  if (t <= 0.02 || t >= 0.98 || u <= 0.02 || u >= 0.98) return null;
  return { t, u };
}

/** Merge overlapping [lo, hi] cut intervals along a segment of length `len` and return visible sub-segments. */
function splitByGaps(a: Vec2, b: Vec2, len: number, cuts: ReadonlyArray<readonly [number, number]>): Array<readonly [Vec2, Vec2]> {
  if (cuts.length === 0 || len < 1e-6) return [[a, b]];
  const sorted = [...cuts].sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const cLo = Math.max(0, lo);
    const cHi = Math.min(len, hi);
    if (cHi <= cLo) continue;
    const last = merged[merged.length - 1];
    if (last && cLo <= last[1] + 0.05) last[1] = Math.max(last[1], cHi);
    else merged.push([cLo, cHi]);
  }
  const out: Array<readonly [Vec2, Vec2]> = [];
  let cursor = 0;
  const lerpPt = (s: number): Vec2 => round({ x: a.x + ((b.x - a.x) * s) / len, y: a.y + ((b.y - a.y) * s) / len });
  for (const [lo, hi] of merged) {
    if (lo - cursor > 0.2) out.push([lerpPt(cursor), lerpPt(lo)]);
    cursor = hi;
  }
  if (len - cursor > 0.2) out.push([lerpPt(cursor), b]);
  return out;
}

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

  // Build projected 2D segments with camera depth for over/under crossing break gaps.
  const segs: Seg2D[] = [];
  const byId = new Map<string, DiagramPipe>();
  for (const p of pipes) {
    byId.set(p.elementId, p);
    const a = P(p.a);
    const b = P(p.b);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const id = `pipe:${p.elementId}`;
    refs[id] = { elementId: p.elementId, elementIds: [p.elementId], name: "pipe" };
    segs.push({ pipe: p, a, b, da: isoDepth(p.a), db: isoDepth(p.b), len, id });
  }

  // Compute over/under crossing break gaps: the farther pipe breaks cleanly behind a nearer pipe.
  const gaps: Array<Array<readonly [number, number]>> = segs.map(() => []);
  const samePoint3 = (u: { x: number; y: number; z: number }, v: { x: number; y: number; z: number }) =>
    Math.abs(u.x - v.x) < 10 && Math.abs(u.y - v.y) < 10 && Math.abs(u.z - v.z) < 10;
  for (let i = 0; i < segs.length; i++) {
    const si = segs[i]!;
    if (si.len < CROSS_GAP_MM * 2.5) continue;
    for (let j = i + 1; j < segs.length; j++) {
      const sj = segs[j]!;
      if (sj.len < CROSS_GAP_MM * 2.5) continue;
      // Skip segments that share a 3D junction endpoint (they meet at a fitting, not an over/under crossing).
      if (samePoint3(si.pipe.a, sj.pipe.a) || samePoint3(si.pipe.a, sj.pipe.b) || samePoint3(si.pipe.b, sj.pipe.a) || samePoint3(si.pipe.b, sj.pipe.b)) continue;
      const hit = interiorCross(si.a, si.b, sj.a, sj.b);
      if (!hit) continue;
      const depthI = si.da + (si.db - si.da) * hit.t;
      const depthJ = sj.da + (sj.db - sj.da) * hit.u;
      if (Math.abs(depthI - depthJ) < 15) continue;
      if (depthI < depthJ) {
        const s = hit.t * si.len;
        gaps[i]!.push([s - CROSS_GAP_MM, s + CROSS_GAP_MM]);
      } else {
        const s = hit.u * sj.len;
        gaps[j]!.push([s - CROSS_GAP_MM, s + CROSS_GAP_MM]);
      }
    }
  }

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const look = pipeLook(s.pipe.systemKind);
    for (const [pa, pb] of splitByGaps(s.a, s.b, s.len, gaps[i]!)) {
      items.push({ shape: "line", points: [pa, pb], weight: look.weight, nodeId: s.id, ...(look.pattern === "dashed" ? { dashed: true } : {}) });
    }
  }

  // Isometric fitting socket ticks & 45° gravity wye indicators at every 3D pipe junction (elbows, tees, wyes).
  const key3 = (p: { x: number; y: number; z: number }) => `${Math.round(p.x / 10)},${Math.round(p.y / 10)},${Math.round(p.z / 10)}`;
  const junctions = new Map<string, { at2: Vec2; legs: Array<{ dir: Vec2; len: number; drain: boolean; nodeId: string }> }>();
  const addLeg = (pt3: { x: number; y: number; z: number }, other2: Vec2, at2: Vec2, len: number, drain: boolean, nodeId: string) => {
    if (len < TICK_OFFSET_MM * 2.2) return;
    const k = key3(pt3);
    const dir = { x: (other2.x - at2.x) / len, y: (other2.y - at2.y) / len };
    let entry = junctions.get(k);
    if (!entry) {
      entry = { at2, legs: [] };
      junctions.set(k, entry);
    }
    entry.legs.push({ dir, len, drain, nodeId });
  };
  for (const s of segs) {
    const isDrain = drainSystemKinds().has(s.pipe.systemKind);
    addLeg(s.pipe.a, s.b, s.a, s.len, isDrain, s.id);
    addLeg(s.pipe.b, s.a, s.b, s.len, isDrain, s.id);
  }
  for (const j of junctions.values()) {
    if (j.legs.length < 2) continue;
    // Skip straight collinear couplings (two opposite legs along the same axis).
    if (j.legs.length === 2) {
      const dot = j.legs[0]!.dir.x * j.legs[1]!.dir.x + j.legs[0]!.dir.y * j.legs[1]!.dir.y;
      if (dot < -0.98) continue;
    }
    for (const leg of j.legs) {
      const c = { x: j.at2.x + leg.dir.x * TICK_OFFSET_MM, y: j.at2.y + leg.dir.y * TICK_OFFSET_MM };
      const nx = -leg.dir.y;
      const ny = leg.dir.x;
      items.push({
        shape: "line",
        points: [round({ x: c.x - nx * TICK_HALF_MM, y: c.y - ny * TICK_HALF_MM }), round({ x: c.x + nx * TICK_HALF_MM, y: c.y + ny * TICK_HALF_MM })],
        weight: "thin",
        nodeId: leg.nodeId,
      });
    }
    // At a 3-way gravity sanitary branch (wye), draw a crisp 45° diagonal sweep brace between the branch leg and main leg.
    if (j.legs.length >= 3 && j.legs.some((l) => l.drain)) {
      const branch = j.legs.find((li, i) => !j.legs.some((lj, k) => k !== i && li.dir.x * lj.dir.x + li.dir.y * lj.dir.y < -0.9));
      const main = j.legs.find((l) => l !== branch);
      if (branch && main) {
        const sweep = TICK_OFFSET_MM * 2.1;
        const pB = round({ x: j.at2.x + branch.dir.x * sweep, y: j.at2.y + branch.dir.y * sweep });
        const pM = round({ x: j.at2.x + main.dir.x * sweep, y: j.at2.y + main.dir.y * sweep });
        items.push({ shape: "line", points: [pB, pM], weight: "medium", nodeId: branch.nodeId });
      }
    }
  }

  // Non-overlapping label placement tracker (paper mm).
  const placedBoxes: LabelBox[] = [];
  const placeLabel = (base: Vec2, w: number, h: number): Vec2 => {
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0, h + 1.4],
      [0, -(h + 1.4)],
      [w * 0.75, h * 0.5],
      [-(w * 0.85), h * 0.5],
      [0, (h + 1.4) * 2],
      [0, -(h + 1.4) * 2],
      [w * 0.9, -(h + 1.4)],
      [-(w * 0.9), h + 1.4],
    ];
    for (const [ox, oy] of offsets) {
      const cand = { x: base.x + ox, y: base.y + oy };
      const box: LabelBox = { x0: cand.x - 0.6, y0: cand.y - h - 0.6, x1: cand.x + w + 0.6, y1: cand.y + 0.6 };
      if (!placedBoxes.some((b) => boxesOverlap(box, b))) {
        placedBoxes.push(box);
        return round(cand);
      }
    }
    const fallback = round({ x: base.x, y: base.y + (h + 1.4) * 2 });
    placedBoxes.push({ x0: fallback.x, y0: fallback.y - h, x1: fallback.x + w, y1: fallback.y });
    return fallback;
  };

  // Fixtures, devices and the source placed first so pipe size/load labels route cleanly around fixture names.
  // Deduplicate shared physical fixtures (`elementId`) across systems (e.g. sanitary + vent, or CW + HW) so each fixture is labeled ONCE on the isometric.
  const seenIsoElements = new Set<string>();
  for (const n of all) {
    if (!n.at || n.role === "branch" || n.elementId === null) continue;
    // Suppress generic "OPEN END" and "CAP" noise on connected stubs/vents when other named terminals exist.
    const upperName = n.name.toUpperCase();
    if (upperName === "OPEN END" || upperName === "CAP") continue;
    if (n.role === "terminal") {
      if (seenIsoElements.has(n.elementId)) continue;
      seenIsoElements.add(n.elementId);
    }
    const c = P(n.at);
    const r = n.role === "device" ? 1.1 : 1.5;
    items.push({ shape: "polyline", points: [round({ x: c.x - r, y: c.y }), round({ x: c.x, y: c.y + r }), round({ x: c.x + r, y: c.y }), round({ x: c.x, y: c.y - r })], closed: true, weight: "medium", nodeId: n.id });
    const lines = n.lines.slice(0, 1);
    if (lines.length > 0 && n.role !== "device") {
      const w = n.role === "source" ? 36 : 14;
      const h = oneLineTextHeight(lines, w);
      const base = { x: c.x + r + 1.0, y: c.y + h / 2 };
      const at = placeLabel(base, w, h);
      if (Math.hypot(at.x - base.x, at.y - base.y) > 3.0) {
        items.push({ shape: "line", points: [round({ x: c.x + r, y: c.y }), round({ x: at.x - 0.5, y: at.y - h / 2 })], weight: "thin", nodeId: n.id });
      }
      items.push({ shape: "text", at, widthMm: w, lines, nodeId: n.id, role: "equipment", mask: true });
    }
    nodesOut.push({ id: n.id, kind: n.kind, name: n.name, center: c, depth: 0 });
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
    const w = 13;
    const h = oneLineTextHeight(lines, w);
    const at = placeLabel({ x: mid.x + 1.0, y: mid.y + h + 0.6 }, w, h);
    items.push({ shape: "text", at, widthMm: w, lines, nodeId: `pipe:${best.id}`, role: "device", mask: true });
  }

  return { items, extent: oneLineItemsExtent(items), nodes: nodesOut, pipes: refs, scale };
}
