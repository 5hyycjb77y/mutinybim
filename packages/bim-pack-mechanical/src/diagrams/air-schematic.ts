import { elementsOfKind, isSource, loadOf, oneLineItemsExtent, partLabelOf, runLabel, runNeighbours, sizeLabel } from "@permitzip/bim-kernel";
import type { BimElement, DiagramEdge, DiagramGraph, DiagramGraphDef, DiagramGraphLayoutInput, DiagramGraphLayoutResult, DiagramHints, DiagramLayoutNode, DiagramLayoutRow, DiagramNode, DiagramPieceRef, DiagramPipeRole, ElementId, MepSystem, OneLineItem, RunGraphNode, RunSegment, Vec2 } from "@permitzip/bim-kernel";
import type { PackRefusal } from "@permitzip/bim-kernel/packs";
import { AIR_SCHEMATIC_KIND } from "../ui";

/**
 * The air schematic: each duct system drawn from its unit through the mains
 * and branches to every diffuser and grille, each drawn run with its size and
 * airflow. Stations are the unit, every branch fitting and every part on the
 * duct; the duct between two stations is one drawn run (one click target,
 * standing for every segment and fitting in it). Read from the routed model
 * only: the same model and hints give the same drawing.
 */

type Elements = Readonly<Record<string, BimElement>>;

const LABEL = "Air schematic";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const elementOf = (elements: Elements, n: RunGraphNode): BimElement | undefined => elements[n.includes("#") ? n.slice(0, n.indexOf("#")) : n];
const cfmText = (cfm: number) => `${Math.round(cfm).toLocaleString("en-US")} CFM`;
/** A straight piece whose ends are within this of the same height runs level, mm. */
const LEVEL_MM = 1;

/** Duct systems in the model, by name, filtered to the kinds asked for. */
export function airSystems(elements: Elements, kinds?: readonly string[]): MepSystem[] {
  const want = kinds && kinds.length > 0 ? new Set(kinds) : null;
  return elementsOfKind(elements, "mep_system")
    .filter((s) => s.domain === "duct" && (!want || want.has(s.systemKind)))
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
}

/** A routed member of each system: its entry when it has one, else the first run found (one pass over runs, only for systems without an entry). */
function anchorsOf(elements: Elements, systems: readonly MepSystem[]): Map<ElementId, ElementId> {
  const out = new Map<ElementId, ElementId>();
  const isMember = (id: string | undefined, sys: ElementId) => {
    const el = id ? elements[id] : undefined;
    return (el?.kind === "run_segment" || el?.kind === "run_fitting") && el.systemId === sys;
  };
  const missing = new Set<ElementId>();
  for (const s of systems) {
    if (s.entryId && isMember(s.entryId, s.id)) out.set(s.id, s.entryId);
    else missing.add(s.id);
  }
  if (missing.size === 0) return out;
  for (const el of elementsOfKind(elements, "run_segment", "run_fitting")) {
    if (missing.has(el.systemId) && !out.has(el.systemId)) out.set(el.systemId, el.id);
  }
  return out;
}

interface Walk {
  readonly root: RunGraphNode;
  readonly children: ReadonlyMap<RunGraphNode, readonly RunGraphNode[]>;
  readonly load: ReadonlyMap<RunGraphNode, number>;
  readonly nodes: readonly RunGraphNode[];
}

function walk(elements: Elements, start: RunGraphNode): Walk {
  const seen = new Set<RunGraphNode>([start]);
  const stack = [start];
  const nodes: RunGraphNode[] = [];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    nodes.push(n);
    for (const m of runNeighbours(elements, n)) {
      if (seen.has(m) || (!m.includes("#") && !elements[m])) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  nodes.sort();
  const unit = nodes.find((n) => {
    const el = n.includes("#") ? elementOf(elements, n) : undefined;
    return el?.kind === "part" && isSource(elements, el);
  });
  const root = unit ?? nodes.find((n) => !n.includes("#")) ?? start;
  const parent = new Set<RunGraphNode>([root]);
  const children = new Map<RunGraphNode, RunGraphNode[]>();
  const order: RunGraphNode[] = [];
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i] as RunGraphNode;
    order.push(n);
    const kids: RunGraphNode[] = [];
    for (const m of runNeighbours(elements, n).sort()) {
      if (parent.has(m) || (!m.includes("#") && !elements[m])) continue;
      parent.add(m);
      kids.push(m);
      queue.push(m);
    }
    children.set(n, kids);
  }
  const load = new Map<RunGraphNode, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i] as RunGraphNode;
    const el = n !== root && n.includes("#") ? elementOf(elements, n) : undefined;
    let sum = el?.kind === "part" ? loadOf(elements, el, n.slice(n.indexOf("#") + 1)) : 0;
    for (const c of children.get(n) ?? []) sum += load.get(c) ?? 0;
    load.set(n, sum);
  }
  return { root, children, load, nodes };
}

/** A node is a station (drawn on its own) when it is the root, a part, or where the duct splits or ends. */
function isStation(w: Walk, n: RunGraphNode): boolean {
  return n === w.root || n.includes("#") || (w.children.get(n)?.length ?? 0) !== 1;
}

function stationNode(elements: Elements, system: MepSystem, w: Walk, n: RunGraphNode, feed: DiagramEdge | undefined, children: readonly DiagramNode[]): DiagramNode {
  const el = elementOf(elements, n);
  const cfm = w.load.get(n) ?? 0;
  const isPart = el?.kind === "part";
  const role: DiagramPipeRole = n === w.root ? "source" : isPart ? (children.length === 0 ? "terminal" : "device") : children.length === 0 ? "terminal" : "branch";
  const name = el?.kind === "part" ? partLabelOf(elements, el) : el?.kind === "run_segment" || el?.kind === "run_fitting" ? runLabel(elements, el) : n;
  const lines = isPart || n === w.root ? [{ text: name, bold: true }, { text: cfmText(cfm) }] : [];
  return {
    id: n,
    elementId: el ? el.id : null,
    kind: role === "source" ? "unit" : role,
    labelKind: "equipment",
    name,
    lines,
    levelId: el && "levelId" in el && typeof el.levelId === "string" ? el.levelId : null,
    service: system.systemKind,
    ...(feed ? { feed } : {}),
    children,
    role,
  };
}

/** The duct from `from` down to the next station: what it stands for, and the station it ends at. */
function runToStation(elements: Elements, w: Walk, from: RunGraphNode): { readonly ids: ElementId[]; readonly segments: RunSegment[]; readonly end: RunGraphNode } {
  const ids: ElementId[] = [];
  const segments: RunSegment[] = [];
  const take = (n: RunGraphNode) => {
    const el = n.includes("#") ? undefined : elements[n];
    if (!el) return;
    ids.push(el.id);
    if (el.kind === "run_segment") segments.push(el);
  };
  let n = from;
  // Not a station: a run piece with exactly one child.
  while (!isStation(w, n)) {
    take(n);
    n = w.children.get(n)?.[0] ?? n;
  }
  // An open end is drawn as the run it ends on.
  if (elements[n]?.kind === "run_segment") take(n);
  return { ids, segments, end: n };
}

function edgeFor(w: Walk, ids: readonly ElementId[], segments: readonly RunSegment[], end: RunGraphNode): DiagramEdge {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const size = first && last ? (sizeLabel(first.size) === sizeLabel(last.size) ? sizeLabel(first.size) : `${sizeLabel(first.size)} to ${sizeLabel(last.size)}`) : "";
  const selects = drawnRunSelects(segments);
  return { linkId: null, device: "duct", label: size, elementIds: ids, ...(selects ? { selects } : {}), load: cfmText(w.load.get(end) ?? 0) };
}

/**
 * What a click on a drawn duct selects. The label names the duct, so its first level straight piece (the run as
 * drawn), else its first straight piece: never a transition, elbow or drop before it.
 */
export function drawnRunSelects(segments: readonly Pick<RunSegment, "id" | "start" | "end">[]): ElementId | undefined {
  return (segments.find((s) => Math.abs(s.start.z - s.end.z) < LEVEL_MM) ?? segments[0])?.id;
}

function treeOf(elements: Elements, system: MepSystem, w: Walk, at: RunGraphNode, feed: DiagramEdge | undefined, hidden: ReadonlySet<string>): DiagramNode {
  const kids: DiagramNode[] = [];
  for (const c of w.children.get(at) ?? []) {
    const run = runToStation(elements, w, c);
    if (hidden.has(run.end)) continue;
    kids.push(treeOf(elements, system, w, run.end, edgeFor(w, run.ids, run.segments, run.end), hidden));
  }
  return stationNode(elements, system, w, at, feed, kids);
}

/** The air schematic's graph: one tree per duct system, rooted at its unit (or its first duct when none is connected yet). */
export function airSchematicGraph(elements: Elements, hints: DiagramHints = {}): DiagramGraph {
  const hidden = new Set(hints.hidden ?? []);
  const reads = new Set<ElementId>();
  const roots: DiagramNode[] = [];
  const warnings: DiagramGraph["warnings"][number][] = [];
  const systems = airSystems(elements, hints.systemKinds).filter((s) => !hidden.has(s.id));
  const anchors = anchorsOf(elements, systems);
  for (const system of systems) {
    reads.add(system.id);
    const anchor = anchors.get(system.id);
    if (!anchor) continue;
    const w = walk(elements, anchor);
    for (const n of w.nodes) {
      const el = elementOf(elements, n);
      if (el) reads.add(el.id);
    }
    const root = treeOf(elements, system, w, w.root, undefined, hidden);
    roots.push(root);
    if (!w.root.includes("#") && root.elementId) warnings.push({ kind: "not_fed", elementId: root.elementId, short: "NO UNIT", message: `No unit is connected to ${system.name}; its schematic starts at ${root.name}` });
  }
  return { roots, warnings, reads: [...reads].sort() };
}

// ------------------------------------------------------------------ layout

const DX = 46;
const DY = 14;
const JOG = 8;
const TEXT_W = DX - 8;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pt = (x: number, y: number): Vec2 => ({ x: r2(x), y: r2(y) });

function box(at: Vec2, w: number, h: number, nodeId: string): OneLineItem {
  const a = pt(at.x - w / 2, at.y - h / 2);
  const b = pt(at.x + w / 2, at.y + h / 2);
  return { shape: "polyline", points: [a, pt(b.x, a.y), b, pt(a.x, b.y)], closed: true, weight: "medium", nodeId };
}

const SYMBOL: Readonly<Record<string, { readonly w: number; readonly h: number }>> = { source: { w: 14, h: 8 }, device: { w: 5, h: 3 }, terminal: { w: 5, h: 5 }, branch: { w: 1.2, h: 1.2 } };

/** Lays the trees out left to right: the unit at the left, a main running on straight, each branch on a row of its own below. */
export function layoutAirSchematic(roots: readonly DiagramNode[]): DiagramGraphLayoutResult {
  const items: OneLineItem[] = [];
  const nodes: DiagramLayoutNode[] = [];
  const pieces: Record<string, DiagramPieceRef> = {};
  const ranges: Record<string, readonly [number, number]> = {};
  let row = 0;
  const place = (n: DiagramNode, depth: number, from: Vec2 | null) => {
    const start = items.length;
    const at = pt(depth * DX, -row * DY);
    const sym = SYMBOL[n.role ?? "branch"] ?? { w: 2, h: 2 };
    if (from && n.feed) {
      const pieceId = `piece:${n.id}`;
      const end = pt(at.x - sym.w / 2, at.y);
      items.push(from.y === at.y ? { shape: "line", points: [from, end], weight: "medium", nodeId: pieceId } : { shape: "polyline", points: [pt(from.x + JOG, from.y), pt(from.x + JOG, at.y), end], weight: "medium", nodeId: pieceId });
      const label = [n.feed.label, n.feed.load].filter((s): s is string => typeof s === "string" && s.length > 0).join("  ");
      if (label) items.push({ shape: "text", at: pt((from.y === at.y ? from.x : from.x + JOG) + 1.5, at.y + 4), widthMm: TEXT_W, lines: [{ text: label }], nodeId: pieceId, role: "conductor" });
      const ids = n.feed.elementIds ?? [];
      const first = n.feed.selects ?? ids[0];
      if (first) pieces[pieceId] = { elementId: first, elementIds: ids, name: label ? `Duct ${label}` : "Duct" };
    }
    items.push(box(at, sym.w, sym.h, n.id));
    if (n.lines.length > 0) items.push({ shape: "text", at: pt(at.x - sym.w / 2, at.y - sym.h / 2 - 1), widthMm: TEXT_W, lines: n.lines, nodeId: n.id, role: "equipment" });
    nodes.push({ id: n.id, name: n.name, center: at, depth, kind: String(n.kind) });
    const out = pt(at.x + sym.w / 2, at.y);
    if (n.children.length === 0) row += 1;
    for (const c of n.children) place(c, depth + 1, out);
    ranges[n.id] = [start, items.length];
  };
  for (const r of roots) {
    place(r, 0, null);
    row += 1;
  }
  return { items, extent: items.length > 0 ? oneLineItemsExtent(items) : { min: pt(0, 0), max: pt(0, 0) }, nodes, ranges, pieces };
}

const NO_STORED_SPEC: PackRefusal = { refused: "An air schematic is drawn from the model's ducts, not from a stored spec" };

export const AIR_SCHEMATIC_GRAPH_ROW: DiagramGraphDef = { kind: AIR_SCHEMATIC_KIND, build: (elements, hints) => airSchematicGraph(elements, hints) };

export const AIR_SCHEMATIC_LAYOUT_ROW: DiagramLayoutRow = {
  kind: AIR_SCHEMATIC_KIND,
  label: LABEL,
  check: () => null,
  layout: () => NO_STORED_SPEC,
  layoutGraph: (input: DiagramGraphLayoutInput) => layoutAirSchematic(input.roots),
};
