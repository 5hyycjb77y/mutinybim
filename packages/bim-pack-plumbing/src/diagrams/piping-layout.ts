import { drainSystemKinds, oneLineItemsExtent, oneLineTextHeight } from "@permitzip/bim-kernel";
import type { DiagramEdge, DiagramNode, ElementId, LinePattern, OneLineItem, OneLineLayout, OneLineTextLine, Pen, PipeLabel, RiserLevel, Vec2 } from "@permitzip/bim-kernel";

/**
 * The plumbing riser as plumbers draw it (the issued 7492 P2 / P3 / GR sheets):
 * each line of pipe a horizontal run, each branch dropping from it to its own
 * line, each fixture hanging off the end of its pipe on its floor, a stack or
 * riser drawn vertical where the pipe changes floor, its branches stepping off
 * it sideways. Supply mains run high in the floor with the fixtures below
 * them; a drain's main runs under the floor with the fixtures above it,
 * flowing right to the outfall. A pipe's size, what it carries and its slope
 * print where they change along a line (gas prints every piece's length).
 * Positions come only from the tree's order (no model coordinates), so the
 * same tree always draws the same riser.
 */

/** What a system's labels default to: drains their running DFU and slope, gas its length (the IFGC tables size by it). */
export function defaultPipeLabels(systemKind: string): readonly PipeLabel[] {
  if (drainSystemKinds().has(systemKind)) return ["size", "load", "slope"];
  if (systemKind === "natural_gas" || systemKind === "propane") return ["size", "load", "length"];
  if (systemKind === "vent") return ["size"];
  return ["size", "load"];
}

/** How a system's pipe prints on a diagram: vent dashed, grease heavier, the rest solid. */
export function pipeLook(systemKind: string): { readonly pattern: LinePattern; readonly weight: Pen } {
  if (systemKind === "vent") return { pattern: "dashed", weight: "medium" };
  if (systemKind === "grease_waste") return { pattern: "solid", weight: "heavy" };
  return { pattern: "solid", weight: "medium" };
}

export interface PipeRef {
  /** The element a click selects. */
  readonly elementId: ElementId;
  /** Everything the drawn piece stands for: selecting any of them in the model lights it here. */
  readonly elementIds: readonly ElementId[];
  readonly name: string;
}

export interface PipingLayout extends OneLineLayout {
  /** The pipe a drawn piece stands for, by the piece's node id (`pipe:...`). */
  readonly pipes: Readonly<Record<string, PipeRef>>;
}

export interface PipingLayoutOptions {
  readonly labels?: readonly PipeLabel[];
}

const COL = 16;
const DEVICE_W = 9;
const TIER = 7;
const ROW = 72;
const LEFT = 34;
const STUB = 5;
/** Room between a source and the first thing on its main. */
const ROOT_LEAD = 16;
/** A system leaving a fixture (hot water from the heater) starts beside it, clear of the fixture's own drop. */
const HEATER_LEAD = 12;
const HEATER_OFFSET = 2.5;
const SYMBOL_W = 7;
const SYMBOL_H = 4;
/** A pipe up to 4 ft under a floor (a drain below the slab) belongs to that floor. */
const TOLERANCE_MM = 1219;

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

/** The level band a height falls in: the highest level at or below it (a drain just under a floor is that floor's). */
function bandOf(levels: readonly RiserLevel[], z: number | undefined, levelId: string | null): number {
  if (z === undefined) {
    const i = levels.findIndex((l) => l.id === levelId);
    return i >= 0 ? i : levels.length;
  }
  for (let i = 0; i < levels.length; i++) if ((levels[i] as RiserLevel).elevationMm <= z + TOLERANCE_MM) return i;
  return Math.max(0, levels.length - 1);
}

function deviceCode(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("cleanout")) return "CO";
  if (n.includes("test tee")) return "TT";
  if (n.includes("trap")) return "TRAP";
  if (n.includes("drip") || n.includes("sediment")) return "DRIP";
  if (n.includes("regulator") || n === "prv" || n.includes("pressure reducing")) return "PRV";
  if (n.includes("valve") || n.includes("cock")) return "SOV";
  return name.toUpperCase().slice(0, 12);
}

/** What a line printed last, so the next piece prints only what changed. */
interface Printed {
  size?: string;
  load?: string;
  slope?: string;
}

export function layoutPipingRiser(roots: readonly DiagramNode[], levels: readonly RiserLevel[], opts: PipingLayoutOptions = {}): PipingLayout {
  const items: OneLineItem[] = [];
  const pipes: Record<string, PipeRef> = {};
  const ranges: Record<string, readonly [number, number]> = {};
  const entries: Record<string, Vec2> = {};
  const nodes: Array<{ id: string; kind: DiagramNode["kind"]; name: string; center: Vec2; depth: number }> = [];
  let usedUnknown = false;
  const band = (n: DiagramNode): number => {
    const b = bandOf(levels, n.at?.z, n.levelId);
    if (b >= levels.length) usedUnknown = true;
    return b;
  };
  const floorY = (b: number) => -(b + 1) * ROW;
  const topY = (b: number) => -b * ROW;

  // Measured the way lines are drawn: each station advances along its line, except one reached up or down a stack
  // (on another floor), which keeps the line's x and steps its own pipe off sideways.
  const widthOf = new Map<DiagramNode, number>();
  const upStack = new Map<DiagramNode, boolean>();
  /** Devices, then one fixture that feeds nothing, all on the branch's floor: drawn as one drop. */
  const isDrop = (kids: readonly DiagramNode[], b: number): boolean => {
    const last = kids[kids.length - 1];
    return kids.length > 1 && last?.role === "terminal" && last.children.length === 0 && kids.slice(0, -1).every((k) => k.role === "device") && kids.every((k) => band(k) === b);
  };
  const measure = (stations: readonly DiagramNode[], startBand: number, lead = 0): number => {
    let x = 0;
    let max = 0;
    let prev: DiagramNode | null = null;
    let prevBand = startBand;
    for (const s of stations) {
      const b = band(s);
      const stacked = b !== prevBand;
      if (!stacked) x += prev ? (widthOf.get(prev) ?? COL) : lead;
      // A fixture that feeds a system of its own (the water heater on the cold line) makes room for that system's line.
      const base =
        s.role === "branch" ? (isDrop(s.children, b) ? COL : Math.max(COL, measure(s.children, b))) : s.role === "device" ? DEVICE_W : s.children.length > 0 ? Math.max(COL, measure(s.children, b, HEATER_LEAD)) : COL;
      const w = base + (stacked && s.role !== "device" ? STUB : 0);
      widthOf.set(s, w);
      upStack.set(s, stacked);
      max = Math.max(max, x + w);
      prev = s;
      prevBand = b;
    }
    return max;
  };

  let originX = LEFT + 8;
  for (const root of roots) {
    const kind = root.service;
    const drain = drainSystemKinds().has(kind);
    const look = pipeLook(kind);
    const labels = opts.labels ?? defaultPipeLabels(kind);
    let maxDepth = 0;
    const markDepth = (stations: readonly DiagramNode[], d: number) => {
      maxDepth = Math.max(maxDepth, d);
      for (const s of stations) if (s.role === "branch") markDepth(s.children, d + 1);
    };
    markDepth(root.children, 0);
    const tierY = (b: number, depth: number): number =>
      drain ? floorY(b) - 5 - (Math.min(maxDepth, 4) - Math.min(depth, 4)) * TIER : Math.max(floorY(b) + 26, topY(b) - 8 - depth * TIER);
    const fixtureY = (b: number) => (drain ? floorY(b) + 4 : floorY(b) + 15);
    const rb = band(root);
    const width = Math.max(COL, measure(root.children, rb, ROOT_LEAD)) + COL;
    // Gas tags every piece with its size and length (the IFGC tables size by length); other systems print a size where it changes.
    const everySize = labels.includes("length");
    // Drains flow right to their outfall: their x runs from the right.
    const X = (x: number) => (drain ? originX + width - (x - originX) : x);
    const P = (p: Vec2): Vec2 => round({ x: X(p.x), y: p.y });
    let pieceNo = 0;

    const pipeLine = (owner: DiagramNode, edge: DiagramEdge | undefined, a: Vec2, b: Vec2): { pa: Vec2; pb: Vec2 } | null => {
      const pa = P(a);
      const pb = P(b);
      if (Math.abs(pa.x - pb.x) < 0.01 && Math.abs(pa.y - pb.y) < 0.01) return null;
      const id = `pipe:${owner.id}:${pieceNo++}`;
      const ids = edge?.elementIds ?? (edge?.linkId ? [edge.linkId] : []);
      if (ids[0]) pipes[id] = { elementId: ids[0], elementIds: ids, name: `${edge?.label ? `${edge.label} ` : ""}pipe${owner.role === "terminal" && owner.name !== "OPEN END" ? ` to ${owner.name}` : ""}` };
      items.push({ shape: "line", points: [pa, pb], weight: look.weight, nodeId: id, ...(look.pattern === "dashed" ? { dashed: true } : {}) });
      return { pa, pb };
    };

    /** The labels of a drawn piece beside it (above a supply line, under a drain, right of a riser): what changed since the line last printed. */
    const label = (owner: DiagramNode, edge: DiagramEdge | undefined, seg: { pa: Vec2; pb: Vec2 } | null, printed: Printed, terminal: boolean) => {
      if (!seg || !edge) return;
      const out: string[] = [];
      for (const l of labels) {
        if (l === "size" && edge.label && (everySize || edge.label !== printed.size)) out.push(edge.label);
        // A fixture's own text says its load; its drop prints only its size (and length for gas).
        if (l === "load" && edge.load && !terminal && edge.load !== printed.load) out.push(edge.load);
        if (l === "slope" && edge.slope && !terminal && edge.slope !== printed.slope) out.push(edge.slope);
        if (l === "invert" && edge.invert) out.push(edge.invert);
        if (l === "length" && edge.lengthFt) out.push(`${edge.lengthFt} LF`);
      }
      if (edge.label) printed.size = edge.label;
      if (edge.load && !terminal) printed.load = edge.load;
      if (edge.slope) printed.slope = edge.slope;
      if (out.length === 0) return;
      const lines: OneLineTextLine[] = out.map((text) => ({ text }));
      const id = `pipe:${owner.id}:label`;
      const vertical = Math.abs(seg.pa.x - seg.pb.x) < 0.01;
      const w = vertical ? COL - 3 : Math.max(COL - 1, Math.abs(seg.pb.x - seg.pa.x) - 1);
      const h = oneLineTextHeight(lines, w);
      if (vertical) {
        const midY = (seg.pa.y + seg.pb.y) / 2;
        items.push({ shape: "text", at: round({ x: seg.pa.x + 0.9, y: midY + h / 2 }), widthMm: w, lines, nodeId: id, role: "device" });
      } else {
        const left = Math.min(seg.pa.x, seg.pb.x);
        items.push({ shape: "text", at: round({ x: left + 0.5, y: drain ? seg.pa.y - 1 : seg.pa.y + 1 + h }), widthMm: w, lines, nodeId: id, role: "device" });
      }
    };

    /** A fixture at the end of its drop; `edge` is what the drop prints (null: it was labelled above, on the drop's first piece). */
    const fixture = (s: DiagramNode, from: Vec2, b: number, printed: Printed, depth: number, edge: DiagramEdge | null) => {
      const fy = fixtureY(b);
      const x = from.x;
      // The drop from the line to the fixture: down onto its top (supply), up into its bottom (drain).
      const seg = pipeLine(s, s.feed, from, { x, y: drain ? fy : fy + SYMBOL_H });
      if (edge) label(s, edge, seg, printed, true);
      const first = s.children[0];
      if (first) {
        // The system it feeds leaves its top beside the drop, rises to its own line and runs on.
        const out = { x: x + HEATER_OFFSET, y: tierY(b, depth + 1) };
        const rise: Printed = {};
        label(first, first.feed, pipeLine(first, first.feed, { x: out.x, y: fy + SYMBOL_H }, out), rise, false);
        drawLine(s.children, out, depth + 1, HEATER_LEAD - HEATER_OFFSET, rise);
      }
      const cx = X(x);
      items.push({ shape: "polyline", points: [round({ x: cx - SYMBOL_W / 2, y: fy }), round({ x: cx + SYMBOL_W / 2, y: fy }), round({ x: cx + SYMBOL_W / 2, y: fy + SYMBOL_H }), round({ x: cx - SYMBOL_W / 2, y: fy + SYMBOL_H })], closed: true, weight: "medium", nodeId: s.id });
      const lines = s.lines.slice(0, 3);
      const h = oneLineTextHeight(lines, COL - 1);
      items.push({ shape: "text", at: round({ x: cx - (COL - 1) / 2, y: drain ? fy + SYMBOL_H + 1 + h : fy - 1 }), widthMm: COL - 1, lines, nodeId: s.id, role: "equipment", align: "center" });
      nodes.push({ id: s.id, kind: s.kind, name: s.name, center: round({ x: cx, y: fy + SYMBOL_H / 2 }), depth: 0 });
    };

    const device = (s: DiagramNode, at: Vec2) => {
      const c = P(at);
      const r = 1.3;
      items.push({ shape: "polyline", points: [round({ x: c.x - r, y: c.y }), round({ x: c.x, y: c.y + r }), round({ x: c.x + r, y: c.y }), round({ x: c.x, y: c.y - r })], closed: true, weight: "medium", nodeId: s.id });
      if (s.lines.length > 0) {
        const lines = [{ text: deviceCode(s.name) }];
        const h = oneLineTextHeight(lines, DEVICE_W + 4);
        // Opposite the pipe's own labels: under a supply line, over a drain.
        items.push({ shape: "text", at: round({ x: c.x - (DEVICE_W + 4) / 2, y: drain ? c.y + r + 0.6 + h : c.y - r - 0.6 }), widthMm: DEVICE_W + 4, lines, nodeId: s.id, role: "note", align: "center" });
      }
      nodes.push({ id: s.id, kind: s.kind, name: s.name, center: c, depth: 0 });
    };

    /** One line from `start`; each station's subtree is its own item range (pins move it whole). */
    /** A drop: one pipe from the line down (or up) to a fixture with only devices on the way (the shut-off on an appliance's drop). */
    const drop = (kids: readonly DiagramNode[], from: Vec2, b: number) => {
      const end = kids[kids.length - 1] as DiagramNode;
      const fy = fixtureY(b);
      const bottom = drain ? fy : fy + SYMBOL_H;
      const devices = kids.slice(0, -1);
      const step = (bottom - from.y) / (devices.length + 1);
      let cur = from;
      const total = kids.reduce((sum, k) => sum + (k.feed?.lengthFt ?? 0), 0);
      const first = kids[0] as DiagramNode;
      // One label for the whole drop: its size, and its whole length for gas.
      const edge = first.feed ? { ...first.feed, lengthFt: total } : undefined;
      devices.forEach((d, i) => {
        const at = { x: from.x, y: from.y + step * (i + 1) };
        const t0 = items.length;
        const seg = pipeLine(d, d.feed, cur, at);
        if (i === 0) label(d, edge, seg, {}, true);
        device(d, at);
        ranges[d.id] = [t0, items.length];
        entries[d.id] = P(cur);
        cur = at;
      });
      const t0 = items.length;
      entries[end.id] = P(cur);
      fixture(end, cur, b, {}, 0, devices.length === 0 ? (edge ?? null) : null);
      ranges[end.id] = [t0, items.length];
    };

    const drawLine = (stations: readonly DiagramNode[], start: Vec2, depth: number, lead = 0, initial: Printed = {}) => {
      const printed: Printed = initial;
      let cur = start;
      let prev: DiagramNode | null = null;
      for (const s of stations) {
        const b = band(s);
        const stacked = upStack.get(s) === true;
        const at: Vec2 = stacked ? { x: cur.x, y: tierY(b, depth) } : { x: cur.x + (prev ? (widthOf.get(prev) ?? COL) : lead), y: cur.y };
        const t0 = items.length;
        entries[s.id] = P(cur);
        if (s.role === "terminal" && !stacked) {
          // A fixture on this line: along to it, then down (or up) to it.
          const seg = pipeLine(s, s.feed, cur, at);
          label(s, s.feed, seg, printed, false);
          fixture(s, at, b, printed, depth, s.feed ?? null);
        } else {
          label(s, s.feed, pipeLine(s, s.feed, cur, at), printed, false);
          // Off a stack, the pipe steps sideways before it drops to what it serves.
          const off = stacked ? { x: at.x + STUB, y: at.y } : at;
          if (s.role === "terminal") {
            pipeLine(s, s.feed, at, off);
            fixture(s, off, b, {}, depth, s.feed ?? null);
          } else if (s.role === "device") {
            device(s, at);
          } else {
            const c = P(at);
            items.push({ shape: "line", points: [round({ x: c.x - 0.8, y: c.y }), round({ x: c.x + 0.8, y: c.y })], weight: "thin", nodeId: s.id });
            nodes.push({ id: s.id, kind: s.kind, name: s.name, center: c, depth });
            const kids = s.children;
            const first = kids[0];
            if (stacked && first) pipeLine(first, first.feed, at, off);
            if (kids.length === 1 && first?.role === "terminal") drawLine(kids, off, depth + 1);
            else if (isDrop(kids, b)) drop(kids, off, b);
            else if (first) {
              // The branch's own line one tier further from the floor's main; the drop to it is its first pipe.
              const tier = { x: off.x, y: tierY(b, depth + 1) };
              const printedBranch: Printed = {};
              label(first, first.feed, pipeLine(first, first.feed, off, tier), printedBranch, false);
              drawLine(kids, tier, depth + 1, 0, printedBranch);
            }
          }
        }
        ranges[s.id] = [t0, items.length];
        cur = at;
        prev = s;
      }
    };

    const t0 = items.length;
    const start = { x: originX, y: tierY(rb, 0) };
    // The source: a box at the head of the main, named beside it (left of a supply main, right of a drain's outfall).
    // A gas source also prints its gas, pressure and total input (its third line).
    const lines = root.lines.slice(0, 3);
    const h = oneLineTextHeight(lines, COL * 2);
    const sx = X(start.x);
    items.push({ shape: "polyline", points: [round({ x: sx - 1.5, y: start.y - 1.5 }), round({ x: sx + 1.5, y: start.y - 1.5 }), round({ x: sx + 1.5, y: start.y + 1.5 }), round({ x: sx - 1.5, y: start.y + 1.5 })], closed: true, weight: "medium", nodeId: root.id });
    items.push({ shape: "text", at: round({ x: drain ? sx + 3 : sx - COL * 2 - 2.5, y: start.y + h / 2 }), widthMm: COL * 2, lines, nodeId: root.id, role: "equipment" });
    nodes.push({ id: root.id, kind: root.kind, name: root.name, center: round({ x: sx, y: start.y }), depth: 0 });
    drawLine(root.children, start, 0, ROOT_LEAD);
    ranges[root.id] = [t0, items.length];
    originX += width + COL * 3;
  }

  const extentX = originX;
  const rows = [...levels.map((l) => l.name), ...(usedUnknown ? ["No level"] : [])];
  rows.forEach((name, i) => {
    const y = floorY(i);
    items.push({ shape: "line", points: [round({ x: 0, y }), round({ x: extentX, y })], weight: "thin", nodeId: "levels" });
    items.push({ shape: "text", at: round({ x: 0, y: y + oneLineTextHeight([{ text: name }], LEFT - 4) + 1 }), widthMm: LEFT - 4, lines: [{ text: name.toUpperCase(), bold: true }], nodeId: "levels", role: "note" });
  });
  return { items, extent: oneLineItemsExtent(items), nodes, ranges, entries, pipes };
}
