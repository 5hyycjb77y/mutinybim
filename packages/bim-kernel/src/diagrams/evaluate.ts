import type { NoteParagraph } from "../annotation/rich-text";
import type { DrawingItem } from "../documents";
import { asElementId, type BimElement, type ElementId, type Vec2, type ViewElement } from "../types";
import {
  layoutOneLine,
  ONE_LINE_TEXT_MM,
  oneLineItemsExtent,
  oneLineTextHeight,
  oneLineTextWidth,
  ovalOutline,
  type OneLineItem,
  type OneLineLayout,
  type OneLineNode,
  type OneLineSpec,
} from "../layout/one-line";
import type { DiagramDefinition, DiagramHints, DiagramSection } from "./definition";
import { DIAGRAM_GRAPH_POINT, diagramNodes, type DiagramGraph, type DiagramGraphDef, type DiagramNode, type DiagramWarning } from "./graph";
import { activePackSet } from "../packs/scope";
import { firstPartyStoredOwner } from "../packs/first-party/manifests";
import { packNotLoadedMessage } from "../packs/set";
import { layoutRiser, riserLevels } from "./riser-layout";
import { diagramLayoutRow, type DiagramGraphLayoutResult, type DiagramLayoutResult, type DiagramLayoutRow, type DiagramPieceRef } from "../layout/diagram-layout-point";
import { isPackRefusal, type PackRefusal } from "../packs/points";

/**
 * Evaluate a live diagram: read the graph from the model, lay it out with the
 * engineer's hints, and return the drawing as drawing items that exist only
 * for this evaluation (never stored, never edited). The whole diagram is
 * derived again from the model graph every time (patent rule, US 11,423,495:
 * no per-equipment patching), and the same model and hints give the same
 * items in the same order, so the printed bytes are the same.
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface DiagramNodeBox {
  /** The model element the box stands for. */
  readonly elementId: ElementId;
  readonly name: string;
  /** Drawing mm (y up), what clicking selects. */
  readonly min: Vec2;
  readonly max: Vec2;
  /** A drawn piece of pipe: every element it stands for (selecting any of them in the model lights it). Absent: equipment. */
  readonly pipe?: { readonly elementIds: readonly ElementId[] };
}

/** A block of diagram text a person can drag (and an agent can move by its key), with where it is drawn now. */
export interface DiagramTextBox {
  /** Stable across evaluations of the same model and hints: the hint key (`textOffsets`). */
  readonly key: string;
  /** The model element the text describes; null for titles, level names and section labels. */
  readonly elementId: ElementId | null;
  /** Its first line, as printed. */
  readonly text: string;
  /** Drawing mm (y up). */
  readonly min: Vec2;
  readonly max: Vec2;
  /** Moved off where the layout put it. */
  readonly moved: boolean;
}

export interface DiagramEvaluation {
  readonly kind: DiagramDefinition["kind"];
  readonly items: readonly DrawingItem[];
  readonly boxes: readonly DiagramNodeBox[];
  /** Every movable block of text, in drawing order. */
  readonly texts: readonly DiagramTextBox[];
  readonly warnings: readonly DiagramWarning[];
  readonly extent: { readonly min: Vec2; readonly max: Vec2 };
  /** Equipment drawn (model elements), in drawing order. */
  readonly equipment: readonly ElementId[];
  /** Model elements the drawing read: an edit to none of them leaves it as it is. */
  readonly reads: readonly ElementId[];
}

const SECTION_PAD = 5;
const DEPTH = 2.5;

/** The graph builder for a diagram kind in the set in force, or null when no pack in it draws that kind. */
function graphDefFor(kind: string): DiagramGraphDef | null {
  const set = activePackSet();
  return set.memo("kernel.diagram_graph#table", () => new Map(set.items(DIAGRAM_GRAPH_POINT).map((d) => [d.kind, d] as const))).get(kind) ?? null;
}

const EMPTY_GRAPH: DiagramGraph = { roots: [], warnings: [], reads: [] };

/** Why a diagram kind can't be drawn here, in words. */
function missingGraphMessage(kind: string): string {
  const owner = firstPartyStoredOwner("diagram", kind);
  return owner ? packNotLoadedMessage(owner) : `No add-on in this model draws ${kind} diagrams`;
}

/** A drawn piece of pipe is easy to hit: its box is at least this far from the line on every side (drawing mm). */
const PIPE_HIT_MM = 1.2;

function toSpecNode(n: DiagramNode): OneLineNode {
  const [first, ...rest] = n.lines;
  return {
    id: n.id,
    kind: n.kind,
    name: first?.text ?? n.name.toUpperCase(),
    ...(rest.length > 0 ? { ratings: rest.map((l) => l.text) } : {}),
    ...(n.mainBreaker ? { main: { device: "breaker" as const } } : {}),
    ...(n.feed
      ? {
          feeder: {
            device: n.feed.device,
            ...(n.feed.deviceLabel ? { device_label: n.feed.deviceLabel } : {}),
            ...(n.feed.conductors ? { conductors: n.feed.conductors } : {}),
            ...(n.feed.lengthFt !== undefined ? { length_ft: n.feed.lengthFt } : {}),
            ...(n.feed.typeMark ? { type_mark: n.feed.typeMark } : {}),
          },
        }
      : {}),
    ...(n.emergency ? { emergency: toSpecNode(n.emergency) } : {}),
    ...(n.children.length > 0 ? { children: n.children.map(toSpecNode) } : {}),
    ...(n.placeholder || n.planned ? { placeholder: true } : {}),
  };
}

const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
const shift = (p: Vec2, d: Vec2): Vec2 => round({ x: p.x + d.x, y: p.y + d.y });

function moveItem(item: OneLineItem, d: Vec2): OneLineItem {
  switch (item.shape) {
    case "component":
      return { ...item, at: shift(item.at, d) };
    case "line":
      return { ...item, points: [shift(item.points[0], d), shift(item.points[1], d)] };
    case "polyline":
      return { ...item, points: item.points.map((p) => shift(p, d)) };
    case "oval":
      return { ...item, center: shift(item.center, d) };
    case "text":
      return { ...item, at: shift(item.at, d) };
  }
}

/** Pinned equipment (and everything it feeds) moved by its pin; a jog joins it back to where its feed left the parent. */
function applyPins(layout: DiagramLayoutResult, roots: readonly DiagramNode[], pins: DiagramHints["pins"]): OneLineItem[] {
  const items = [...layout.items];
  if (!pins || !layout.ranges) return items;
  const entries = new Map(Object.entries(layout.entries ?? {}));
  for (const n of diagramNodes({ roots })) {
    const pin = pins[n.id];
    const range = layout.ranges[n.id];
    if (!pin || !range || (pin.dx === 0 && pin.dy === 0)) continue;
    const d = { x: pin.dx, y: pin.dy };
    for (let i = range[0]; i < range[1]; i++) {
      const it = items[i];
      if (it) items[i] = moveItem(it, d);
    }
    const below = new Set(diagramNodes({ roots: [n] }).map((x) => x.id));
    const entry = entries.get(n.id);
    for (const id of below) {
      const e = entries.get(id);
      if (e) entries.set(id, shift(e, d));
    }
    if (entry) {
      const midY = entry.y + d.y / 2;
      items.push({ shape: "polyline", points: [round(entry), round({ x: entry.x, y: midY }), round({ x: entry.x + d.x, y: midY }), shift(entry, d)], weight: "medium", nodeId: n.id });
    }
  }
  return items;
}

/** Bounds of the items in [start, end) whose node is in `ids` (all of them when `ids` is null), leaving out `skip`. */
function boundsOf(items: readonly OneLineItem[], start: number, end: number, ids: ReadonlySet<string> | null, skip?: ReadonlySet<number>): { min: Vec2; max: Vec2 } | null {
  const picked: OneLineItem[] = [];
  for (let i = start; i < end; i++) {
    const it = items[i];
    if (it && !skip?.has(i) && (!ids || ids.has(it.nodeId))) picked.push(it);
  }
  if (picked.length === 0) return null;
  return oneLineItemsExtent(picked);
}

/** Dashed boxes around groups: one per service that differs from what feeds it (a fire pump service), and the engineer's own. */
function sectionsFor(roots: readonly DiagramNode[], hints: DiagramHints): DiagramSection[] {
  const out: DiagramSection[] = [];
  const all = diagramNodes({ roots });
  const services = new Set(all.filter((n) => n.elementId !== null).map((n) => n.service));
  if (services.size > 1) {
    const walk = (n: DiagramNode, parentService: string | null) => {
      if (parentService !== null && n.service !== parentService && n.service !== "emergency") {
        out.push({ id: `service:${n.id}`, label: `${n.service.toUpperCase()} SERVICE`, elementIds: diagramNodes({ roots: [n] }).map((x) => x.id) });
        return;
      }
      for (const c of n.children) walk(c, n.service);
    };
    for (const r of roots) walk(r, r.elementId === null ? r.service : null);
  }
  for (const s of hints.sections ?? []) out.push(s);
  return out;
}

/** Where a service box may start: below the bus (or right of it, horizontally) its feed leaves, so it never takes the parent's text. */
interface SectionCap {
  readonly entries: OneLineLayout["entries"];
  readonly orientation: "vertical" | "horizontal" | null;
}

function drawSections(items: OneLineItem[], sections: readonly DiagramSection[], layoutItems: number, ranges: OneLineLayout["ranges"], cap: SectionCap): void {
  for (const s of sections) {
    const ids = new Set(s.elementIds);
    // A service box takes each listed node's own items; the engineer's sections the same.
    const own = boundsOf(items, 0, layoutItems, ids);
    let box = own;
    for (const id of s.elementIds) {
      const r = ranges?.[id];
      const b = r ? boundsOf(items, r[0], r[1], ids) : null;
      if (b && box) box = { min: { x: Math.min(box.min.x, b.min.x), y: Math.min(box.min.y, b.min.y) }, max: { x: Math.max(box.max.x, b.max.x), y: Math.max(box.max.y, b.max.y) } };
    }
    if (!box) continue;
    let min = round({ x: box.min.x - SECTION_PAD, y: box.min.y - SECTION_PAD });
    let max = round({ x: box.max.x + SECTION_PAD, y: box.max.y + SECTION_PAD });
    const entry = s.id.startsWith("service:") ? cap.entries?.[s.id.slice("service:".length)] : undefined;
    if (entry && cap.orientation === "vertical") max = { x: max.x, y: Math.min(max.y, round({ x: 0, y: entry.y - 1.5 }).y) };
    if (entry && cap.orientation === "horizontal") min = { x: Math.max(min.x, round({ x: entry.x + 1.5, y: 0 }).x), y: min.y };
    items.push({ shape: "polyline", points: [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }, min], weight: "thin", dashed: true, nodeId: s.id });
    // The label sits in the box's bottom margin, clear of the equipment and its feeder labels.
    items.push({ shape: "text", at: round({ x: min.x + 2, y: min.y + SECTION_PAD - 0.6 }), widthMm: Math.max(30, max.x - min.x - 4), lines: [{ text: s.label.toUpperCase(), bold: true }], nodeId: s.id, role: "note" });
  }
}

/** Moved this far (drawing mm) or more, a block of text draws a leader back to where it belongs unless told not to. */
const TEXT_LEADER_MM = 6;

/** Where a line from a box's centre towards `to` leaves the box. */
function boxEdge(b: { min: Vec2; max: Vec2 }, to: Vec2): Vec2 {
  const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
  const d = { x: to.x - c.x, y: to.y - c.y };
  const hx = (b.max.x - b.min.x) / 2;
  const hy = (b.max.y - b.min.y) / 2;
  const t = Math.min(Math.abs(d.x) > 1e-9 ? hx / Math.abs(d.x) : Infinity, Math.abs(d.y) > 1e-9 ? hy / Math.abs(d.y) : Infinity, 1);
  return round({ x: c.x + d.x * t, y: c.y + d.y * t });
}

/**
 * The key a block of text is moved by: what it describes, its role, and its
 * place among that node's blocks of the same role. The layout emits text in a
 * fixed order, so the same model and hints always give the same keys.
 */
export function diagramTextKey(nodeId: string, role: string, ordinal: number): string {
  return `${nodeId}#${role}#${ordinal}`;
}

/**
 * Text the engineer dragged: each keyed block moves by its offset (nothing
 * else does), with a thin leader back to where the layout put it when it went
 * well away (clear of where it was). Returns the indices of moved items (they no longer count toward
 * their equipment's hit box) and every text block for picking.
 */
function applyTextOffsets(items: OneLineItem[], offsets: DiagramHints["textOffsets"], elementOf: (nodeId: string) => ElementId | null): { moved: Set<number>; texts: Array<{ key: string; index: number; elementId: ElementId | null; text: string; moved: boolean }> } {
  const seen = new Map<string, number>();
  const moved = new Set<number>();
  const texts: Array<{ key: string; index: number; elementId: ElementId | null; text: string; moved: boolean }> = [];
  const count = items.length;
  for (let i = 0; i < count; i++) {
    const it = items[i];
    if (!it || (it.shape !== "text" && it.shape !== "oval")) continue;
    const role = it.shape === "oval" ? "mark" : (it.role ?? "note");
    const base = `${it.nodeId}#${role}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    const key = diagramTextKey(it.nodeId, role, ordinal);
    const text = it.shape === "oval" ? it.text : (it.lines[0]?.text ?? "");
    const off = offsets?.[key];
    const isMoved = off !== undefined && (off.dx !== 0 || off.dy !== 0);
    texts.push({ key, index: i, elementId: elementOf(it.nodeId), text, moved: isMoved });
    if (!off || !isMoved) continue;
    const home = oneLineItemsExtent([it]);
    const next = moveItem(it, { x: off.dx, y: off.dy });
    items[i] = next;
    moved.add(i);
    if (off.leader === false || (off.leader === undefined && Math.hypot(off.dx, off.dy) < TEXT_LEADER_MM)) continue;
    const there = oneLineItemsExtent([next]);
    // Still overlapping where it was: a leader would only run through its own words.
    if (there.min.x < home.max.x && home.min.x < there.max.x && there.min.y < home.max.y && home.min.y < there.max.y) continue;
    const homeCentre = { x: (home.min.x + home.max.x) / 2, y: (home.min.y + home.max.y) / 2 };
    const from = boxEdge(there, homeCentre);
    const to = boxEdge(home, { x: (there.min.x + there.max.x) / 2, y: (there.min.y + there.max.y) / 2 });
    if (Math.hypot(to.x - from.x, to.y - from.y) > 1) items.push({ shape: "line", points: [from, to], weight: "thin", nodeId: `text-leader:${key}` });
  }
  return { moved, texts };
}

/** The "3D box" look: each equipment text block in a box with depth lines to its top and right. */
function drawBoxes(items: OneLineItem[]): void {
  const labels = items.filter((i): i is Extract<OneLineItem, { shape: "text" }> => i.shape === "text" && i.role === "equipment");
  for (const t of labels) {
    const w = oneLineTextWidth(t.lines, t.widthMm) + 3;
    const h = oneLineTextHeight(t.lines, t.widthMm) + 1;
    const min = round({ x: t.at.x - 1.5, y: t.at.y - h });
    const max = round({ x: t.at.x - 1.5 + w, y: t.at.y + 1 });
    const d = { x: DEPTH, y: DEPTH };
    items.push({ shape: "polyline", points: [min, { x: max.x, y: min.y }, max, { x: min.x, y: max.y }, min], weight: "medium", nodeId: t.nodeId });
    items.push({ shape: "polyline", points: [{ x: min.x, y: max.y }, shift({ x: min.x, y: max.y }, d), shift(max, d), shift({ x: max.x, y: min.y }, d), { x: max.x, y: min.y }].map(round), weight: "thin", nodeId: t.nodeId });
    items.push({ shape: "line", points: [max, shift(max, d)], weight: "thin", nodeId: t.nodeId });
  }
}

/** A warning triangle and its words under the equipment's text block. */
function drawWarnings(items: OneLineItem[], warnings: readonly DiagramWarning[]): void {
  const blockOf = new Map<string, Extract<OneLineItem, { shape: "text" }>>();
  for (const i of items) if (i.shape === "text" && i.role === "equipment" && !blockOf.has(i.nodeId)) blockOf.set(i.nodeId, i);
  const count = new Map<string, number>();
  for (const w of warnings) {
    const t = blockOf.get(w.elementId);
    if (!t) continue;
    const k = count.get(w.elementId) ?? 0;
    count.set(w.elementId, k + 1);
    const top = t.at.y - oneLineTextHeight(t.lines, t.widthMm) - 2 - k * 5;
    const a = round({ x: t.at.x, y: top - 3.2 });
    items.push({ shape: "polyline", points: [a, { x: a.x + 3.6, y: a.y }, { x: a.x + 1.8, y: a.y + 3.2 }, a].map(round), weight: "medium", nodeId: `warning:${w.elementId}` });
    // Inside the width the layout gave the text block, so it wraps instead of running over the next line.
    items.push({ shape: "text", at: round({ x: t.at.x + 4.5, y: top }), widthMm: Math.max(20, t.widthMm - 6), lines: [{ text: `! ${w.short}`, bold: true }], nodeId: `warning:${w.elementId}`, role: "note" });
  }
}

function itemId(viewId: string, i: number): ElementId {
  return asElementId(`${viewId}~dg~${i}`);
}

function toDrawingItems(viewId: string, items: readonly OneLineItem[]): DrawingItem[] {
  const base = (i: number) => ({ id: itemId(viewId, i), version: 0, authoredRev: {}, kind: "drawing_item" as const, ownerId: asElementId(viewId) });
  const note = (i: number, at: Vec2, width: number, size: number, paragraphs: readonly NoteParagraph[]): DrawingItem => ({
    ...base(i),
    shape: "text",
    points: [at],
    textSize: size,
    note: { space: "model", box: { width, height: null, rotation: 0 }, paragraphs, lineSpacing: 1 },
  });
  const out: DrawingItem[] = [];
  let n = 0;
  for (const item of items) {
    switch (item.shape) {
      case "component":
        out.push({ ...base(n++), shape: "component", points: [item.at], component: { symbolId: item.symbolId, widthMm: item.widthMm, heightMm: item.heightMm, ...(item.rotationDeg ? { rotationDeg: item.rotationDeg } : {}) } });
        break;
      case "line":
        out.push({ ...base(n++), shape: "line", points: [...item.points], lineStyle: { weight: item.weight, ...(item.dashed ? { pattern: "dashed" as const } : {}) } });
        break;
      case "polyline":
        out.push({ ...base(n++), shape: "polyline", points: [...item.points], lineStyle: { weight: item.weight, ...(item.dashed ? { pattern: "dashed" as const } : {}) }, ...(item.closed ? { closed: true } : {}) });
        break;
      case "oval":
        out.push({ ...base(n++), shape: "polyline", points: ovalOutline(item.center, item.widthMm, item.heightMm), closed: true, lineStyle: { weight: "thin" } });
        out.push(note(n++, round({ x: item.center.x - item.widthMm / 2, y: item.center.y + ONE_LINE_TEXT_MM * 0.75 }), item.widthMm, ONE_LINE_TEXT_MM * 0.85, [{ runs: [{ text: item.text }], align: "center" }]));
        break;
      case "text":
        out.push(note(n++, item.at, item.widthMm, ONE_LINE_TEXT_MM, item.lines.map((l) => ({ runs: [{ text: l.text, ...(l.bold ? { bold: true } : {}) }], ...(item.align === "center" ? { align: "center" as const } : {}) }))));
        break;
    }
  }
  return out;
}

/**
 * The add-on row that lays out a diagram kind (contract 1.12.0,
 * `kernel.diagram_layout`), read before the kernel's own layouts so an add-on
 * draws its diagrams. Without the add-on, the refusal names it.
 */
export function layoutRowFor(kind: string): DiagramLayoutRow | PackRefusal {
  const row = diagramLayoutRow(kind);
  if (row) return row;
  const owner = firstPartyStoredOwner("diagram", kind);
  return { refused: owner ? packNotLoadedMessage(owner) : `No add-on in this model lays out ${kind} diagrams` };
}

interface Laid {
  readonly layout: DiagramLayoutResult;
  readonly pieces: Readonly<Record<string, DiagramPieceRef>>;
  /** False: only the engineer's own section boxes (the row draws one line across services). */
  readonly serviceSections: boolean;
}

function laidFrom(result: DiagramGraphLayoutResult, row: DiagramLayoutRow): Laid {
  return { layout: result, pieces: result.pieces ?? {}, serviceSections: row.serviceSections !== false };
}

function layoutFor(elements: Elements, def: DiagramDefinition, graph: DiagramGraph, roots: readonly DiagramNode[], viewId: string): Laid | null {
  if (roots.length === 0) return null;
  const hints = def.hints ?? {};
  const row = layoutRowFor(def.kind);
  if (!isPackRefusal(row) && row.layoutGraph) {
    const result = row.layoutGraph({ elements, graph, roots, hints });
    if (isPackRefusal(result)) {
      console.error("[bim-kernel/diagrams] the add-on that lays out this diagram kind refused; drawing it empty", { viewId, kind: def.kind, why: result.refused });
      return null;
    }
    return laidFrom(result, row);
  }
  if (def.kind === "one_line") {
    const spec: OneLineSpec = { roots: roots.map(toSpecNode), ...(hints.title ? { title: hints.title } : {}), ...(hints.notes?.length ? { notes: [...hints.notes] } : {}) };
    return { layout: layoutOneLine(spec, { orientation: hints.orientation ?? "vertical" }), pieces: {}, serviceSections: true };
  }
  return { layout: layoutRiser(roots, riserLevels(elements)), pieces: {}, serviceSections: true };
}

/** One box per drawn piece (each line and its label on its own), padded so a thin line is easy to click. */
function pipeBoxes(items: readonly OneLineItem[], pipes: Readonly<Record<string, DiagramPieceRef>>): DiagramNodeBox[] {
  const out: DiagramNodeBox[] = [];
  if (Object.keys(pipes).length === 0) return out;
  for (const it of items) {
    const ref = pipes[it.nodeId];
    if (!ref) continue;
    const b = oneLineItemsExtent([it]);
    out.push({
      elementId: ref.elementId,
      name: ref.name,
      min: round({ x: b.min.x - PIPE_HIT_MM, y: b.min.y - PIPE_HIT_MM }),
      max: round({ x: b.max.x + PIPE_HIT_MM, y: b.max.y + PIPE_HIT_MM }),
      pipe: { elementIds: ref.elementIds },
    });
  }
  return out;
}

/** The diagram as drawn now: items, clickable boxes, warnings. Null when the view is not a live diagram. */
export function evaluateDiagram(elements: Elements, view: Pick<ViewElement, "id" | "props">): DiagramEvaluation | null {
  const def = view.props?.diagram;
  if (!def) return null;
  const set = activePackSet();
  const cache = set.memo("kernel.diagram_graph#evaluations", () => new WeakMap<Elements, Map<string, DiagramEvaluation>>());
  const byView = cache.get(elements);
  const key = `${view.id}|${JSON.stringify(def)}`;
  const known = byView?.get(key);
  if (known) return known;
  const result = evaluateUncached(elements, view.id, def);
  if (byView) byView.set(key, result);
  else cache.set(elements, new Map([[key, result]]));
  return result;
}

function evaluateUncached(elements: Elements, viewId: string, def: DiagramDefinition): DiagramEvaluation {
  const hints = def.hints ?? {};
  const graphDef = graphDefFor(def.kind);
  if (!graphDef) console.error("[bim-kernel/diagrams] no pack in this model's set draws this diagram kind; drawing it empty", { viewId, kind: def.kind, why: missingGraphMessage(def.kind) });
  const graph = graphDef ? graphDef.build(elements, hints) : EMPTY_GRAPH;
  const roots = graphDef?.roots ? graphDef.roots(elements, graph, hints) : graph.roots;
  const laid = layoutFor(elements, def, graph, roots, viewId);
  if (!laid) {
    return { kind: def.kind, items: [], boxes: [], texts: [], warnings: graph.warnings, extent: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } }, equipment: [], reads: graph.reads };
  }
  const { layout, pieces: pipeRefs } = laid;
  const items = applyPins(layout, roots, hints.pins);
  const laidOut = items.length;
  // A row that draws one line across services (hot water off the heater on the cold line): only the engineer's own boxes.
  drawSections(items, laid.serviceSections ? sectionsFor(roots, hints) : (hints.sections ?? []), laidOut, layout.ranges, { entries: layout.entries, orientation: def.kind === "one_line" ? (hints.orientation ?? "vertical") : null });
  const all = diagramNodes({ roots });
  const nodeElement = new Map(all.flatMap((n) => (n.elementId ? [[n.id, n.elementId] as const] : [])));
  // After the sections (a moved label doesn't stretch its service box), before the 3D boxes and warnings (they follow the text).
  const { moved, texts } = applyTextOffsets(items, hints.textOffsets, (nodeId) => nodeElement.get(nodeId) ?? pipeRefs[nodeId]?.elementId ?? null);
  if (hints.style === "box3d") drawBoxes(items);
  if (hints.showWarnings !== false) drawWarnings(items, graph.warnings);
  const boxes: DiagramNodeBox[] = [];
  for (const n of all) {
    if (!n.elementId) continue;
    const b = boundsOf(items, 0, items.length, new Set([n.id]), moved);
    if (b) boxes.push({ elementId: n.elementId, name: n.name, min: b.min, max: b.max });
  }
  boxes.push(...pipeBoxes(items, pipeRefs));
  return {
    kind: def.kind,
    items: toDrawingItems(viewId, items),
    boxes,
    texts: texts.map((t) => {
      const it = items[t.index];
      const b = it ? oneLineItemsExtent([it]) : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };
      return { key: t.key, elementId: t.elementId, text: t.text, min: b.min, max: b.max, moved: t.moved };
    }),
    warnings: graph.warnings,
    extent: oneLineItemsExtent(items),
    equipment: all.flatMap((n) => (n.elementId ? [n.elementId] : [])),
    reads: graph.reads,
  };
}

/** The drawing items a view shows that come from its live diagram ([] for any other view). */
export function diagramItemsOf(elements: Elements, view: Pick<ViewElement, "id" | "props">): readonly DrawingItem[] {
  return evaluateDiagram(elements, view)?.items ?? [];
}

/** The model element at a point in a diagram view (drawing mm), smallest box first; null when none. */
export function diagramElementAt(evaluation: DiagramEvaluation, p: Vec2): ElementId | null {
  let best: DiagramNodeBox | null = null;
  for (const b of evaluation.boxes) {
    if (p.x < b.min.x || p.x > b.max.x || p.y < b.min.y || p.y > b.max.y) continue;
    const area = (b.max.x - b.min.x) * (b.max.y - b.min.y);
    if (!best || area < (best.max.x - best.min.x) * (best.max.y - best.min.y)) best = b;
  }
  return best?.elementId ?? null;
}

/** Does a box stand for any of `ids` (what the model has selected)? A piece of pipe answers for every element it was drawn from. */
export function diagramBoxSelected(box: DiagramNodeBox, ids: ReadonlySet<string>): boolean {
  return ids.has(box.elementId) || (box.pipe?.elementIds.some((id) => ids.has(id)) ?? false);
}

/** The boxes that light up for a model selection, in drawing order: a selected pipe lights every drawn piece it is part of. */
export function diagramBoxesFor(evaluation: DiagramEvaluation, ids: Iterable<string>): DiagramNodeBox[] {
  const want = new Set(ids);
  return evaluation.boxes.filter((b) => diagramBoxSelected(b, want));
}
