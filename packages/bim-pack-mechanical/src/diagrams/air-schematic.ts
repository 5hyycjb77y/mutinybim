import { elementsOfKind, isSource, loadOf, oneLineItemsExtent, partLabelOf, runLabel, runNeighbours, sizeLabel } from "@permitzip/bim-kernel";
import type { BimElement, DiagramEdge, DiagramGraph, DiagramGraphDef, DiagramGraphLayoutInput, DiagramGraphLayoutResult, DiagramHints, DiagramLayoutNode, DiagramLayoutRow, DiagramNode, DiagramPieceRef, DiagramPipeRole, ElementId, MepSystem, OneLineItem, RunGraphNode, RunSegment, Vec2 } from "@permitzip/bim-kernel";
import type { PackRefusal } from "@permitzip/bim-kernel/packs";
import { AIR_SCHEMATIC_KIND } from "../ui";

/**
 * The air schematic: each duct system drawn from its unit through the mains
 * and branches to every diffuser, grille, and discharge hood, each drawn run
 * with its size, airflow, and directional arrows. Stations are the unit, every
 * branch fitting and every part on the duct; the duct between two stations is
 * one drawn run (one click target, standing for every segment and fitting in
 * it). Read from the routed model only: the same model and hints give the same
 * drawing.
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

/** All disconnected routed components of a system (e.g., an exhaust fan's intake leg AND its roof discharge leg). */
function systemComponents(elements: Elements, system: MepSystem): Walk[] {
  const members: ElementId[] = [];
  if (system.entryId) {
    const entry = elements[system.entryId];
    if ((entry?.kind === "run_segment" || entry?.kind === "run_fitting") && entry.systemId === system.id) {
      members.push(entry.id);
    }
  }
  for (const el of elementsOfKind(elements, "run_segment", "run_fitting")) {
    if (el.systemId === system.id && el.id !== system.entryId) members.push(el.id);
  }
  const seen = new Set<RunGraphNode>();
  const walks: Walk[] = [];
  for (const m of members) {
    if (seen.has(m)) continue;
    const w = walk(elements, m);
    for (const n of w.nodes) seen.add(n);
    walks.push(w);
  }
  // Put the primary (higher-load or larger) leg first so intake comes before atmospheric discharge.
  walks.sort((a, b) => (b.load.get(b.root) ?? 0) - (a.load.get(a.root) ?? 0) || b.nodes.length - a.nodes.length || cmp(a.root, b.root));
  return walks;
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

function isDischargeConnector(node: RunGraphNode): boolean {
  const hash = node.indexOf("#");
  if (hash < 0) return false;
  const conn = node.slice(hash + 1).toLowerCase();
  return conn.includes("discharge") || conn.includes("exhaust_out") || conn.includes("outlet");
}

function stationNode(
  elements: Elements,
  system: MepSystem,
  w: Walk,
  n: RunGraphNode,
  feed: DiagramEdge | undefined,
  children: readonly DiagramNode[],
  dischargeBranch = false,
): DiagramNode {
  const el = elementOf(elements, n);
  const cfm = w.load.get(n) ?? 0;
  const isPart = el?.kind === "part";
  const role: DiagramPipeRole = n === w.root ? "source" : isPart ? (children.length === 0 ? "terminal" : "device") : children.length === 0 ? "terminal" : "branch";
  const name = el?.kind === "part" ? partLabelOf(elements, el) : el?.kind === "run_segment" || el?.kind === "run_fitting" ? runLabel(elements, el) : n;
  const lines = isPart || n === w.root
    ? dischargeBranch && cfm === 0
      ? [{ text: name, bold: true }, { text: "ROOF DISCHARGE" }]
      : [{ text: name, bold: true }, { text: cfmText(cfm) }]
    : [];
  return {
    id: n,
    elementId: el ? el.id : null,
    kind: role === "source" ? "unit" : dischargeBranch && role === "terminal" ? "discharge" : role,
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

function edgeFor(w: Walk, ids: readonly ElementId[], segments: readonly RunSegment[], end: RunGraphNode, fallbackCfm = 0): DiagramEdge {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const size = first && last ? (sizeLabel(first.size) === sizeLabel(last.size) ? sizeLabel(first.size) : `${sizeLabel(first.size)} to ${sizeLabel(last.size)}`) : "";
  const selects = drawnRunSelects(segments);
  const cfm = w.load.get(end) ?? 0;
  return { linkId: null, device: "duct", label: size, elementIds: ids, ...(selects ? { selects } : {}), load: cfmText(cfm > 0 ? cfm : fallbackCfm) };
}

/**
 * What a click on a drawn duct selects. The label names the duct, so its first level straight piece (the run as
 * drawn), else its first straight piece: never a transition, elbow or drop before it.
 */
export function drawnRunSelects(segments: readonly Pick<RunSegment, "id" | "start" | "end">[]): ElementId | undefined {
  return (segments.find((s) => Math.abs(s.start.z - s.end.z) < LEVEL_MM) ?? segments[0])?.id;
}

function treeOf(
  elements: Elements,
  system: MepSystem,
  w: Walk,
  at: RunGraphNode,
  feed: DiagramEdge | undefined,
  hidden: ReadonlySet<string>,
  dischargeBranch = false,
  fallbackCfm = 0,
): DiagramNode {
  const kids: DiagramNode[] = [];
  for (const c of w.children.get(at) ?? []) {
    const run = runToStation(elements, w, c);
    if (hidden.has(run.end)) continue;
    kids.push(treeOf(elements, system, w, run.end, edgeFor(w, run.ids, run.segments, run.end, fallbackCfm), hidden, dischargeBranch, fallbackCfm));
  }
  // Sort terminal leaves cleanly by mark (SD-1, SD-2, SD-3, SD-4; RG-1, RG-2; EG-1, EG-2)
  kids.sort((a, b) => a.name.localeCompare(b.name, "en-US", { numeric: true }));
  return stationNode(elements, system, w, at, feed, kids, dischargeBranch);
}

const AIR_SYSTEM_TAG: Readonly<Record<string, string>> = {
  supply_air: "SA",
  return_air: "RA",
  exhaust_air: "EA",
  outside_air: "OA",
  relief_air: "RLA",
  transfer_air: "TA",
};

function airServiceTag(kind: string): string {
  return AIR_SYSTEM_TAG[kind] ?? kind.replace(/_air$/i, "").toUpperCase();
}

/** The air schematic's graph: one tree per unit (combining Supply + Return trunks or Exhaust Intake + Roof Discharge off the same unit), or per duct system when no unit is attached yet. */
export function airSchematicGraph(elements: Elements, hints: DiagramHints = {}): DiagramGraph {
  const hidden = new Set<string>(hints.hidden ?? []);
  const reads = new Set<ElementId>();
  const roots: DiagramNode[] = [];
  const bySourceUnit = new Map<ElementId, { readonly idx: number; readonly summaries: string[]; primaryCfm: number }>();
  const warnings: DiagramGraph["warnings"][number][] = [];
  const systems = airSystems(elements, hints.systemKinds).filter((s) => !hidden.has(s.id));

  for (const system of systems) {
    reads.add(system.id);
    const comps = systemComponents(elements, system);
    for (const w of comps) {
      for (const n of w.nodes) {
        const el = elementOf(elements, n);
        if (el) reads.add(el.id);
      }
      const unitId = w.root.includes("#") ? elementOf(elements, w.root)?.id ?? null : null;
      const existing = unitId ? bySourceUnit.get(unitId) : undefined;
      const isDischargeLeg = isDischargeConnector(w.root) && system.systemKind === "exhaust_air";
      const fallbackCfm = isDischargeLeg && existing ? existing.primaryCfm : 0;
      const root = treeOf(elements, system, w, w.root, undefined, hidden, isDischargeLeg, fallbackCfm);
      const tag = isDischargeLeg ? "DISCH" : airServiceTag(system.systemKind);
      const rootLoad = w.load.get(w.root) ?? 0;
      const cfm = cfmText(rootLoad > 0 ? rootLoad : fallbackCfm);
      const taggedChildren = root.children.map((c) =>
        c.feed
          ? {
              ...c,
              feed: { ...c.feed, label: c.feed.label ? `${tag} ${c.feed.label}` : tag },
            }
          : c,
      );

      if (unitId && existing) {
        if (!isDischargeLeg) {
          existing.summaries.push(`${tag} ${cfm}`);
          existing.primaryCfm = Math.max(existing.primaryCfm, rootLoad);
        }
        const prev = roots[existing.idx]!;
        roots[existing.idx] = {
          ...prev,
          lines: [{ text: prev.name, bold: true }, { text: existing.summaries.join(" · ") }],
          children: [...prev.children, ...taggedChildren],
        };
      } else {
        const summary = `${tag} ${cfm}`;
        const mergedRoot: DiagramNode = {
          ...root,
          lines: [{ text: root.name, bold: true }, { text: summary }],
          children: taggedChildren,
        };
        if (unitId) bySourceUnit.set(unitId, { idx: roots.length, summaries: [summary], primaryCfm: rootLoad });
        roots.push(mergedRoot);
      }
      if (!w.root.includes("#") && root.elementId) {
        warnings.push({ kind: "not_fed", elementId: root.elementId, short: "NO UNIT", message: `No unit is connected to ${system.name}; its schematic starts at ${root.name}` });
      }
    }
  }
  return { roots, warnings, reads: [...reads].sort() };
}

// ------------------------------------------------------------------ layout

const UNIT_W = 32;
const UNIT_H_MIN = 16;
const DX_TRUNK = 62;
const DX_BRANCH = 64;
const DY = 16;
const TERM_SIZE = 7;
const HOOD_W = 11;
const HOOD_H = 7;
const r2 = (v: number) => Math.round(v * 100) / 100;
const pt = (x: number, y: number): Vec2 => ({ x: r2(x), y: r2(y) });

function rectItem(at: Vec2, w: number, h: number, nodeId: string, weight: "thin" | "medium" | "heavy" = "medium"): OneLineItem {
  const a = pt(at.x - w / 2, at.y - h / 2);
  const b = pt(at.x + w / 2, at.y + h / 2);
  return { shape: "polyline", points: [a, pt(b.x, a.y), b, pt(a.x, b.y)], closed: true, weight, nodeId };
}

/** Crisp solid-looking junction dot at a branch tee / header connection. */
function junctionDot(at: Vec2, nodeId: string): OneLineItem[] {
  const r = 0.75;
  const r2s = 0.35;
  return [
    rectItem(at, r * 2, r * 2, nodeId, "heavy"),
    rectItem(at, r2s * 2, r2s * 2, nodeId, "heavy"),
  ];
}

/** Crisp ASHRAE directional airflow chevron at `tip` pointing along `dir` (+1 right = supply/discharge, -1 left = return/exhaust intake). */
function flowArrow(tip: Vec2, dir: 1 | -1, nodeId: string): OneLineItem {
  const len = 3.0;
  const half = 1.35;
  return {
    shape: "polyline",
    points: [pt(tip.x - dir * len, tip.y + half), tip, pt(tip.x - dir * len, tip.y - half)],
    weight: "medium",
    nodeId,
  };
}

/** ASHRAE air-terminal / roof-hood symbol centered at `at`. */
function terminalSymbol(n: DiagramNode, at: Vec2): { readonly items: OneLineItem[]; readonly w: number; readonly h: number } {
  if (n.kind === "discharge") {
    // Roof exhaust discharge hood / louver silhouette (sloped cap + throat)
    const hw = HOOD_W / 2;
    const hh = HOOD_H / 2;
    return {
      w: HOOD_W,
      h: HOOD_H,
      items: [
        // Sloped hood cap outline
        {
          shape: "polyline",
          points: [pt(at.x - hw, at.y - hh), pt(at.x - hw, at.y + hh), pt(at.x + hw * 0.6, at.y + hh), pt(at.x + hw, at.y - hh)],
          closed: true,
          weight: "medium",
          nodeId: n.id,
        },
        // Louver slats on the discharge face
        { shape: "line", points: [pt(at.x + hw * 0.1, at.y + hh * 0.35), pt(at.x + hw * 0.72, at.y + hh * 0.35)], weight: "thin", nodeId: n.id },
        { shape: "line", points: [pt(at.x + hw * 0.1, at.y - hh * 0.25), pt(at.x + hw * 0.85, at.y - hh * 0.25)], weight: "thin", nodeId: n.id },
      ],
    };
  }
  const h = TERM_SIZE / 2;
  const out: OneLineItem[] = [rectItem(at, TERM_SIZE, TERM_SIZE, n.id, "medium")];
  if (n.service === "supply_air") {
    // ASHRAE Supply Diffuser: square with diagonal X
    out.push(
      { shape: "line", points: [pt(at.x - h, at.y - h), pt(at.x + h, at.y + h)], weight: "thin", nodeId: n.id },
      { shape: "line", points: [pt(at.x - h, at.y + h), pt(at.x + h, at.y - h)], weight: "thin", nodeId: n.id },
    );
  } else if (n.service === "return_air") {
    // ASHRAE Return Grille: square with single diagonal /
    out.push({ shape: "line", points: [pt(at.x - h, at.y - h), pt(at.x + h, at.y + h)], weight: "thin", nodeId: n.id });
  } else if (n.service === "exhaust_air") {
    // ASHRAE Exhaust Grille: square with diagonal \ and inner frame
    out.push(
      { shape: "line", points: [pt(at.x - h, at.y + h), pt(at.x + h, at.y - h)], weight: "thin", nodeId: n.id },
      rectItem(at, TERM_SIZE * 0.5, TERM_SIZE * 0.5, n.id, "thin"),
    );
  }
  return { items: out, w: TERM_SIZE, h: TERM_SIZE };
}

function isReturnFlow(n: DiagramNode): boolean {
  if (n.kind === "discharge") return false;
  return n.service === "return_air" || n.service === "exhaust_air" || n.service === "relief_air";
}

function isDashedFlow(n: DiagramNode): boolean {
  if (n.kind === "discharge") return false;
  return isReturnFlow(n) || n.service === "outside_air";
}

function portLabelOf(c: DiagramNode): string {
  if (c.kind === "discharge" || c.feed?.label?.startsWith("DISCH")) return "OUT";
  return airServiceTag(c.service);
}

/**
 * Publication-grade ASHRAE HVAC air schematic layout:
 * - Source units (RTU, AHU, EF) on the left with crisp unwrapped SA / RA / EA / DISCH port stubs aligned horizontally to each trunk.
 * - Single clean vertical branch header bus with solid junction dots (zero floating mystery squares, zero overlapping vertical lines).
 * - Crisp ASHRAE terminal symbols (X = supply diffuser, / = return grille, \+box = exhaust grille, sloped hood = roof discharge) with mark + CFM cleanly to the right.
 * - Duct size & CFM labels floating cleanly ABOVE each horizontal line with directional airflow arrowheads (zero white masks erasing lines).
 */
export function layoutAirSchematic(roots: readonly DiagramNode[]): DiagramGraphLayoutResult {
  const items: OneLineItem[] = [];
  const nodes: DiagramLayoutNode[] = [];
  const pieces: Record<string, DiagramPieceRef> = {};
  const ranges: Record<string, readonly [number, number]> = {};
  const entries: Record<string, Vec2> = {};

  // Step 1: Assign clean top-to-bottom Y coordinates to every node (leaves stack at DY; branch headers center vertically across their children).
  const yOf = new Map<string, number>();
  let cursorY = 0;

  const assignY = (n: DiagramNode, depth: number): number => {
    if (n.children.length === 0) {
      const y = r2(cursorY);
      cursorY -= DY;
      yOf.set(n.id, y);
      return y;
    }
    const childYs: number[] = [];
    n.children.forEach((c, idx) => {
      if (depth === 0 && idx > 0) cursorY -= 8; // crisp visual break between RA, SA, and DISCH trunks off one unit
      childYs.push(assignY(c, depth + 1));
    });
    const y = r2((childYs[0]! + childYs[childYs.length - 1]!) / 2);
    yOf.set(n.id, y);
    return y;
  };

  roots.forEach((r, idx) => {
    if (idx > 0) cursorY -= 16; // crisp separation between independent equipment units (e.g. EF-1 vs RTU-1)
    assignY(r, 0);
  });

  // Compute column X for a depth (depth 0 = unit center, depth 1 = main header/direct terminal, depth 2+ = branch terminals)
  const xForDepth = (depth: number, isBranch: boolean): number => {
    if (depth === 0) return 0;
    if (depth === 1) return UNIT_W / 2 + DX_TRUNK + (isBranch ? 0 : TERM_SIZE / 2);
    return UNIT_W / 2 + DX_TRUNK + (depth - 1) * DX_BRANCH + (isBranch ? 0 : TERM_SIZE / 2);
  };

  /** Draw a clean horizontal duct segment from `from` to `to` (same Y) with centered directional arrowhead and label cleanly ABOVE the line. */
  const drawHorizontalRun = (n: DiagramNode, from: Vec2, to: Vec2, pieceId: string) => {
    const dashed = isDashedFlow(n);
    const dir: 1 | -1 = isReturnFlow(n) ? -1 : 1;
    items.push({
      shape: "line",
      points: [from, to],
      weight: "medium",
      nodeId: pieceId,
      ...(dashed ? { dashed: true } : {}),
    });
    // Place airflow chevron cleanly in the open right zone of the horizontal run (clear of labels on the left)
    const span = to.x - from.x;
    if (span >= 8) {
      const arrowX = dir === 1 ? r2(to.x - Math.min(7, span * 0.18)) : r2(to.x - Math.min(10, span * 0.24));
      items.push(flowArrow(pt(arrowX, to.y), dir, pieceId));
    }
    const label = [n.feed?.label, n.feed?.load].filter((s): s is string => typeof s === "string" && s.length > 0).join(" · ");
    if (label) {
      const labelW = Math.max(24, span - 6);
      // Text flows downward from `at.y` (1 line ≈ 2.4 mm), so `to.y + 4.8` keeps a crisp clear gap above the line & arrow wings.
      items.push({
        shape: "text",
        at: pt(from.x + 2.4, to.y + 4.8),
        widthMm: labelW,
        lines: [{ text: label }],
        nodeId: pieceId,
        role: "conductor",
      });
    }
    const ids = n.feed?.elementIds ?? [];
    const first = n.feed?.selects ?? ids[0];
    if (first) pieces[pieceId] = { elementId: first, elementIds: ids, name: label ? `Duct ${label}` : "Duct" };
  };

  const emit = (n: DiagramNode, depth: number, from: Vec2 | null) => {
    const start = items.length;
    const isSourceNode = n.role === "source";
    const isBranchNode = n.role === "branch" && n.children.length > 0;
    const y = yOf.get(n.id) ?? 0;
    const x = xForDepth(depth, isBranchNode);
    const at = pt(x, y);

    if (isSourceNode) {
      const childYs = n.children.map((c) => yOf.get(c.id) ?? y);
      const topY = childYs.length > 0 ? Math.max(...childYs) : y;
      const botY = childYs.length > 0 ? Math.min(...childYs) : y;
      const unitH = Math.max(UNIT_H_MIN, r2(topY - botY + 12));
      const unitCenter = pt(x, r2((topY + botY) / 2));

      // Bold equipment enclosure
      items.push(rectItem(unitCenter, UNIT_W, unitH, n.id, "medium"));
      // Equipment mark cleanly inside the left side of the unit box, summary cleanly below the box
      const markLine = n.lines[0] ?? { text: n.name, bold: true };
      const summaryLines = n.lines.slice(1);
      items.push({
        shape: "text",
        at: pt(unitCenter.x - UNIT_W / 2 + 2.5, unitCenter.y + 1.6),
        widthMm: UNIT_W - 12,
        lines: [markLine],
        nodeId: n.id,
        role: "equipment",
      });
      if (summaryLines.length > 0) {
        items.push({
          shape: "text",
          at: pt(unitCenter.x - UNIT_W / 2, unitCenter.y - unitH / 2 - 1.5),
          widthMm: Math.max(UNIT_W + 24, 48),
          lines: summaryLines,
          nodeId: n.id,
          role: "equipment",
        });
      }
      nodes.push({ id: n.id, name: n.name, center: unitCenter, depth, kind: String(n.kind) });

      // Connect each trunk straight horizontally out of the right face of the equipment box!
      const rightX = r2(unitCenter.x + UNIT_W / 2);
      for (const c of n.children) {
        const cy = yOf.get(c.id) ?? unitCenter.y;
        const pTag = portLabelOf(c);
        // Unwrapped crisp port tag inside right edge of unit box (`widthMm: 12` so RA/SA/EA/DISCH never wraps!)
        items.push({
          shape: "text",
          at: pt(rightX - 11.5, cy + 1.4),
          widthMm: 10.5,
          lines: [{ text: pTag }],
          nodeId: n.id,
          role: "conductor",
          align: "center",
        });
        emit(c, depth + 1, pt(rightX, cy));
      }
    } else if (isBranchNode) {
      // Single clean vertical header bus spanning first child to last child — ZERO floating empty squares, ZERO overlapping vertical drops!
      const pieceId = `piece:${n.id}`;
      const childYs = n.children.map((c) => yOf.get(c.id) ?? y);
      const topY = Math.max(...childYs);
      const botY = Math.min(...childYs);
      const dashed = isDashedFlow(n);

      if (from && n.feed) {
        entries[n.id] = from;
        drawHorizontalRun(n, from, pt(x, y), pieceId);
      }
      // Vertical header spine & junction dots use `n.id` so the branch header is itself directly draggable via DiagramLayer!
      if (Math.abs(topY - botY) > 0.05) {
        items.push({
          shape: "line",
          points: [pt(x, topY), pt(x, botY)],
          weight: "medium",
          nodeId: n.id,
          ...(dashed ? { dashed: true } : {}),
        });
      }
      // Solid junction dot where main trunk hits header bus
      items.push(...junctionDot(pt(x, y), n.id));
      nodes.push({ id: n.id, name: n.name, center: at, depth, kind: String(n.kind) });

      for (const c of n.children) {
        const cy = yOf.get(c.id) ?? y;
        // Solid tee junction dot for intermediate branch takeoffs along the vertical spine
        if (Math.abs(cy - topY) > 0.5 && Math.abs(cy - botY) > 0.5 && Math.abs(cy - y) > 0.5) {
          items.push(...junctionDot(pt(x, cy), n.id));
        }
        emit(c, depth + 1, pt(x, cy));
      }
    } else {
      // Terminal (diffuser / return grille / exhaust grille / discharge hood) or inline device
      const sym = terminalSymbol(n, at);
      const pieceId = `piece:${n.id}`;
      const end = pt(at.x - sym.w / 2, at.y);
      if (from && n.feed) {
        entries[n.id] = from;
        if (Math.abs(from.y - end.y) < 0.05) {
          drawHorizontalRun(n, from, end, pieceId);
        } else {
          // Clean orthogonal elbow when a terminal sits at a different Y than its parent stub
          const midX = r2(from.x + 8);
          const dashed = isDashedFlow(n);
          items.push({
            shape: "polyline",
            points: [from, pt(midX, from.y), pt(midX, end.y), end],
            weight: "medium",
            nodeId: pieceId,
            ...(dashed ? { dashed: true } : {}),
          });
          drawHorizontalRun(n, pt(midX, end.y), end, pieceId);
        }
      }
      items.push(...sym.items);
      if (n.lines.length > 0) {
        // Place terminal mark + CFM cleanly to the RIGHT of the symbol (never colliding with adjacent stacked rows!)
        items.push({
          shape: "text",
          at: pt(at.x + sym.w / 2 + 2.8, at.y + 2.6),
          widthMm: 34,
          lines: n.lines,
          nodeId: n.id,
          role: "equipment",
        });
      }
      nodes.push({ id: n.id, name: n.name, center: at, depth, kind: String(n.kind) });
      for (const c of n.children) {
        emit(c, depth + 1, pt(at.x + sym.w / 2, at.y));
      }
    }

    ranges[n.id] = [start, items.length];
  };

  for (const r of roots) emit(r, 0, null);
  return {
    items,
    extent: items.length > 0 ? oneLineItemsExtent(items) : { min: pt(0, 0), max: pt(0, 0) },
    nodes,
    ranges,
    entries,
    pieces,
  };
}

const NO_STORED_SPEC: PackRefusal = { refused: "An air schematic is drawn from the model's ducts, not from a stored spec" };

export const AIR_SCHEMATIC_GRAPH_ROW: DiagramGraphDef = { kind: AIR_SCHEMATIC_KIND, build: (elements, hints) => airSchematicGraph(elements, hints) };

export const AIR_SCHEMATIC_LAYOUT_ROW: DiagramLayoutRow = {
  kind: AIR_SCHEMATIC_KIND,
  label: LABEL,
  serviceSections: false,
  check: () => null,
  layout: () => NO_STORED_SPEC,
  layoutGraph: (input: DiagramGraphLayoutInput) => layoutAirSchematic(input.roots),
};
