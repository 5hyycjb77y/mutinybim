import { z } from "zod";
import {
  detailComponent,
  ONE_LINE_TEXT_MM,
  oneLineItemsExtent,
  oneLineTextHeight,
  oneLineTextWidth,
  type DiagramLayoutResult,
  type DiagramLayoutRow,
  type OneLineItem,
  type OneLineLayoutOptions,
  type OneLineTextLine,
  type OneLineTextRole,
  type Pen,
  type Vec2,
} from "@permitzip/bim-kernel";

/**
 * A radial power one-line (single-line) diagram laid out from a structured
 * description (moved from the kernel in round 12; same description, same
 * bytes): sources at the top, power flowing down through meters, cabinets,
 * switchboards, transformers, panels and loads. Bus equipment draws a heavy
 * bus with each feeder dropping from it through its overcurrent device; each
 * conductor carries its tag (sets, conductors, conduit, length) beside it;
 * each piece of equipment its name and ratings to the right of its symbol. An
 * automatic transfer switch takes a second (emergency) source in the column
 * beside it.
 *
 * It draws into the kernel's generic diagram items (`OneLineItem`) through
 * `DIAGRAM_LAYOUT_POINT` (kind `one_line`). Positions depend only on the
 * description. Coordinates are drawing mm, y up, for a drafting view at
 * SCALE: NONE (1 drawing mm prints as 1 paper mm).
 */

export const ONE_LINE_KINDS = [
  "utility",
  "meter",
  "ct_cabinet",
  "switchboard",
  "panelboard",
  "mcc",
  "transformer",
  "generator",
  "ats",
  "disconnect",
  "fused_disconnect",
  "vfd",
  "ups",
  "motor",
  "equipment",
] as const;
export type OneLineEquipmentKind = (typeof ONE_LINE_KINDS)[number];

export const ONE_LINE_DEVICES = ["breaker", "drawout_breaker", "fuse", "fused_switch", "switch", "none"] as const;
export type OneLineProtectiveDevice = (typeof ONE_LINE_DEVICES)[number];

const BUS_KINDS: ReadonlySet<string> = new Set<OneLineEquipmentKind>(["switchboard", "panelboard", "mcc"]);
const SOURCE_KINDS: ReadonlySet<string> = new Set<OneLineEquipmentKind>(["utility", "generator"]);
const LOAD_KINDS: ReadonlySet<string> = new Set<OneLineEquipmentKind>(["motor", "equipment"]);

const KIND_SYMBOL: Readonly<Record<OneLineEquipmentKind, string>> = {
  utility: "elec_utility_source",
  meter: "elec_meter",
  ct_cabinet: "elec_ct_cabinet",
  switchboard: "elec_bus",
  panelboard: "elec_bus",
  mcc: "elec_bus",
  transformer: "elec_transformer",
  generator: "elec_generator",
  ats: "elec_ats",
  disconnect: "elec_disconnect",
  fused_disconnect: "elec_disconnect_fused",
  vfd: "elec_vfd",
  ups: "elec_ups",
  motor: "elec_motor",
  equipment: "elec_equipment",
};

const DEVICE_SYMBOL: Readonly<Record<Exclude<OneLineProtectiveDevice, "none">, string>> = {
  breaker: "elec_breaker",
  drawout_breaker: "elec_breaker_drawout",
  fuse: "elec_fuse",
  fused_switch: "elec_disconnect_fused",
  switch: "elec_disconnect",
};

const text = z.string().trim().min(1).max(120);

export const oneLineFeederSchema = z
  .object({
    device: z.enum(ONE_LINE_DEVICES).optional().describe("Overcurrent device ahead of this equipment (default: breaker when fed from a bus, none otherwise)."),
    device_label: text.optional().describe("As it prints beside the device, e.g. 400AF/400AT 3P."),
    sets: z.number().int().min(1).max(20).optional().describe("Parallel sets of conductors."),
    conductors: text.optional().describe("e.g. 4#500 KCMIL CU, 1#3/0 CU G."),
    conduit: text.optional().describe('e.g. 3" C.'),
    length_ft: z.number().positive().max(10000).optional(),
    type_mark: z.string().trim().min(1).max(12).optional().describe("Feeder type mark drawn in an oval on the conductor, e.g. F225."),
  })
  .strict();
export type OneLineFeeder = z.infer<typeof oneLineFeederSchema>;

const mainSchema = z.object({ device: z.enum(ONE_LINE_DEVICES), label: text.optional() }).strict();

export interface ElectricalOneLineNode {
  readonly id: string;
  readonly kind: OneLineEquipmentKind;
  readonly name: string;
  readonly ratings?: readonly string[];
  readonly main?: z.infer<typeof mainSchema>;
  readonly feeder?: OneLineFeeder;
  readonly spd?: boolean;
  readonly ground?: boolean;
  readonly emergency?: ElectricalOneLineNode;
  readonly children?: readonly ElectricalOneLineNode[];
  /** A space for future equipment: drawn dashed. */
  readonly placeholder?: boolean;
}

export const oneLineNodeSchema: z.ZodType<ElectricalOneLineNode> = z.lazy(() =>
  z
    .object({
      id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, _ . - only"),
      kind: z.enum(ONE_LINE_KINDS),
      name: text,
      ratings: z.array(text).max(6).optional(),
      main: mainSchema.optional(),
      feeder: oneLineFeederSchema.optional(),
      spd: z.boolean().optional(),
      ground: z.boolean().optional(),
      placeholder: z.boolean().optional(),
      emergency: oneLineNodeSchema.optional(),
      children: z.array(oneLineNodeSchema).max(40).optional(),
    })
    .strict(),
);

export const oneLineSpecSchema = z
  .object({
    title: text.optional(),
    roots: z.array(oneLineNodeSchema).min(1).max(8),
    notes: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  })
  .strict();
export type ElectricalOneLineSpec = z.infer<typeof oneLineSpecSchema>;

/** Conservative average glyph advance, so a label's height covers its wrapping (the kernel's text metric). */
const CHAR_MM = ONE_LINE_TEXT_MM * 0.8;
/** The kernel's default label width (`oneLineTextHeight`). */
const LABEL_WIDTH = 52;
const COLUMN = 76;
const ACCESSORY = 18;
const GAP = 3;
const MIN_CONDUCTOR = 10;
/** add_drawing_item refuses a line shorter than this ("too small to see"), which would refuse the whole diagram. */
const MIN_LINE_MM = 0.5;

const textHeight = oneLineTextHeight;

function sym(id: string): { w: number; h: number; terminals: Readonly<Record<string, readonly [number, number]>> } {
  const s = detailComponent(id);
  if (!s) throw new Error(`One-line symbol ${id} is missing from the component library`);
  return { w: s.widthMm, h: s.heightMm, terminals: s.terminals ?? {} };
}

function feederDevice(node: ElectricalOneLineNode, parentIsBus: boolean): OneLineProtectiveDevice {
  return node.feeder?.device ?? (parentIsBus ? "breaker" : "none");
}

function feederTag(f: OneLineFeeder | undefined): OneLineTextLine[] {
  if (!f) return [];
  const cond = [f.sets && f.sets > 1 ? `(${f.sets}) SETS` : "", f.conductors ?? ""].filter((s) => s.length > 0).join(" ");
  return [cond, f.conduit ?? "", f.length_ft !== undefined ? `L = ${Math.round(f.length_ft)}'` : ""].filter((l) => l.length > 0).map((l) => ({ text: l.toUpperCase() }));
}

/** A rating line starting "! " is a warning about the equipment: it prints bold. */
function labelLines(node: ElectricalOneLineNode): OneLineTextLine[] {
  return [{ text: node.name.toUpperCase(), bold: true }, ...(node.ratings ?? []).map((r) => ({ text: r.toUpperCase(), ...(r.startsWith("! ") ? { bold: true } : {}) }))];
}

/** Sibling column in a horizontal layout: a label's height beside its line, plus the symbol on the other side. */
const COLUMN_HORIZONTAL = 40;

/**
 * Layout metrics for the drawing in progress. A horizontal one-line is laid out
 * top-down and turned a quarter turn, so along the flow a label takes its
 * width, not its height; set for the duration of one `layoutRadialOneLine` call.
 */
let horizontal = false;

/** How much room a label takes along the flow of power. */
function along(lines: readonly OneLineTextLine[], width = LABEL_WIDTH): number {
  if (!horizontal) return textHeight(lines, width);
  return lines.length === 0 ? 0 : oneLineTextWidth(lines, width) + 2;
}

function columnWidth(): number {
  return horizontal ? COLUMN_HORIZONTAL : COLUMN;
}

/** Every node, depth-first. */
function allNodes(spec: ElectricalOneLineSpec): ElectricalOneLineNode[] {
  const out: ElectricalOneLineNode[] = [];
  const walk = (n: ElectricalOneLineNode, depth: number) => {
    if (depth > 14) throw new Error(`The one-line is more than 14 levels deep at ${n.name}`);
    out.push(n);
    if (n.emergency) walk(n.emergency, depth + 1);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const r of spec.roots) walk(r, 0);
  return out;
}

/** A plain-words problem with the description, or null when it can be drawn. */
export function checkOneLineSpec(spec: ElectricalOneLineSpec): string | null {
  let nodes: ElectricalOneLineNode[];
  try {
    nodes = allNodes(spec);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (nodes.length > 200) return `The one-line has ${nodes.length} pieces of equipment; 200 is the most one drawing takes. Split it.`;
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) return `Two pieces of equipment have the id "${n.id}"; every id must be different.`;
    seen.add(n.id);
    if (n.emergency && n.kind !== "ats") return `${n.name} has an emergency source, but only an automatic transfer switch (kind "ats") takes one.`;
    if (n.emergency && !SOURCE_KINDS.has(n.emergency.kind)) return `The emergency source of ${n.name} must be a generator or a utility source, not ${n.emergency.kind}.`;
    if (n.emergency?.children?.length) return `${n.emergency.name} is the emergency source of ${n.name}; draw its loads under the transfer switch, not under the source.`;
    if (n.main && !BUS_KINDS.has(n.kind)) return `${n.name} has a main device, but only a switchboard, panelboard or MCC does; put the device in the next feeder instead.`;
    if (LOAD_KINDS.has(n.kind) && (n.children ?? []).length > 0) return `${n.name} is a load (${n.kind}); it can't feed anything.`;
  }
  return null;
}

interface Measured {
  readonly node: ElectricalOneLineNode;
  /** Whole width, accessories and emergency column included. */
  readonly width: number;
  readonly children: readonly Measured[];
  readonly emergency: Measured | null;
  readonly accessories: number;
}

function measure(node: ElectricalOneLineNode): Measured {
  const children = (node.children ?? []).map(measure);
  const emergency = node.emergency ? measure(node.emergency) : null;
  const accessories = (node.spd ? 1 : 0) + (node.ground ? 1 : 0);
  const kids = children.reduce((s, c) => s + c.width, 0);
  return { node, width: Math.max(columnWidth(), kids) + accessories * ACCESSORY + (emergency ? emergency.width : 0), children, emergency, accessories };
}

/** The node's own column (between its accessories and its emergency column) and its centre. */
function span(m: Measured, left: number): { left: number; width: number; center: number } {
  const l = left + m.accessories * ACCESSORY;
  const w = m.width - m.accessories * ACCESSORY - (m.emergency?.width ?? 0);
  return { left: l, width: w, center: l + w / 2 };
}

/** Where a node's vertical line runs: a chain of single loads stays on one line, so it sits over its only child. */
function anchorX(m: Measured, left: number): number {
  const s = span(m, left);
  const only = m.children.length === 1 ? m.children[0] : undefined;
  if (BUS_KINDS.has(m.node.kind) || !only) return s.center;
  return anchorX(only, s.left + (s.width - only.width) / 2);
}

function deviceZone(node: ElectricalOneLineNode, parentIsBus: boolean): number {
  const dev = feederDevice(node, parentIsBus);
  if (dev === "none") return 0;
  const label = node.feeder?.device_label ? along([{ text: node.feeder.device_label }]) : 0;
  return Math.max(sym(DEVICE_SYMBOL[dev]).h, label) + GAP * 2;
}

const OVAL_H = 5;

function ovalWidth(mark: string): number {
  return Math.max(12, mark.length * CHAR_MM + 5);
}

function conductorZone(node: ElectricalOneLineNode): number {
  const oval = node.feeder?.type_mark ? (horizontal ? ovalWidth(node.feeder.type_mark) : OVAL_H) + GAP * 2 : 0;
  return Math.max(MIN_CONDUCTOR, along(feederTag(node.feeder)) + GAP * 2, oval);
}

/** Height of a node's own zone (symbol or main + bus) below its feed. */
function bodyHeight(node: ElectricalOneLineNode): number {
  const label = along(labelLines(node));
  if (BUS_KINDS.has(node.kind)) {
    const main = node.main && node.main.device !== "none" ? sym(DEVICE_SYMBOL[node.main.device]).h + GAP : 0;
    return Math.max(main, label) + GAP * 2;
  }
  return Math.max(sym(KIND_SYMBOL[node.kind]).h, label) + GAP;
}

/** A source block's height: symbol, its own device and conductor. */
function sourceHeight(node: ElectricalOneLineNode): number {
  return bodyHeight(node) + deviceZone(node, false) + conductorZone(node);
}

class Builder {
  readonly items: OneLineItem[] = [];
  readonly nodes: Array<{ id: string; kind: OneLineEquipmentKind; name: string; center: Vec2; depth: number }> = [];
  readonly ranges: Record<string, readonly [number, number]> = {};
  readonly entries: Record<string, Vec2> = {};
  constructor(private readonly dashed: ReadonlySet<string>) {}
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  private grow(p: Vec2): void {
    this.minX = Math.min(this.minX, p.x);
    this.minY = Math.min(this.minY, p.y);
    this.maxX = Math.max(this.maxX, p.x);
    this.maxY = Math.max(this.maxY, p.y);
  }

  line(a: Vec2, b: Vec2, nodeId: string, weight: Pen = "medium"): void {
    const ra = round(a);
    const rb = round(b);
    if (Math.hypot(rb.x - ra.x, rb.y - ra.y) < MIN_LINE_MM) return;
    this.items.push({ shape: "line", points: [ra, rb], weight, nodeId, ...(this.dashed.has(nodeId) ? { dashed: true } : {}) });
    this.grow(a);
    this.grow(b);
  }

  polyline(points: Vec2[], nodeId: string, weight: Pen = "medium"): void {
    this.items.push({ shape: "polyline", points: points.map(round), weight, nodeId, ...(this.dashed.has(nodeId) ? { dashed: true } : {}) });
    for (const p of points) this.grow(p);
  }

  oval(center: Vec2, mark: string, nodeId: string): void {
    const w = ovalWidth(mark);
    const c = round(center);
    this.items.push({ shape: "oval", center: c, text: mark.toUpperCase(), widthMm: w, heightMm: OVAL_H, nodeId });
    this.grow({ x: c.x - w / 2, y: c.y - OVAL_H / 2 });
    this.grow({ x: c.x + w / 2, y: c.y + OVAL_H / 2 });
  }

  /** A symbol placed so its `terminal` (unit box) lands on `at`; returns where its terminals landed. */
  component(symbolId: string, terminal: string, at: Vec2, nodeId: string): Record<string, Vec2> {
    const s = sym(symbolId);
    const t = terminal === "top" ? ([0.5, 1] as const) : (s.terminals[terminal] ?? ([0.5, 1] as const));
    const origin = round({ x: at.x - t[0] * s.w, y: at.y - t[1] * s.h });
    this.items.push({ shape: "component", symbolId, at: origin, widthMm: s.w, heightMm: s.h, nodeId });
    this.grow(origin);
    this.grow({ x: origin.x + s.w, y: origin.y + s.h });
    const out: Record<string, Vec2> = {
      top: round({ x: origin.x + 0.5 * s.w, y: origin.y + s.h }),
      bottom: round({ x: origin.x + 0.5 * s.w, y: origin.y }),
      left: round({ x: origin.x, y: origin.y + s.h / 2 }),
    };
    for (const [k, [u, v]] of Object.entries(s.terminals)) out[k] = round({ x: origin.x + u * s.w, y: origin.y + v * s.h });
    return out;
  }

  label(at: Vec2, lines: readonly OneLineTextLine[], nodeId: string, width = LABEL_WIDTH, role: OneLineTextRole = "note", ref?: number): void {
    if (lines.length === 0) return;
    this.items.push({ shape: "text", at: round(at), widthMm: width, lines, nodeId, role, ...(ref !== undefined ? { ref: Math.round(ref * 100) / 100 } : {}) });
    this.grow(at);
    this.grow({ x: at.x + width, y: at.y - textHeight(lines, width) });
  }

  extent() {
    return { min: round({ x: this.minX, y: this.minY }), max: round({ x: this.maxX, y: this.maxY }) };
  }
}

function round(p: Vec2): Vec2 {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

/** Surge device and ground hung from `from`: from a bus's left end stepping right, or beside an inline symbol stepping left. */
function accessories(b: Builder, node: ElectricalOneLineNode, from: Vec2, start: number, step: number): void {
  let x = start;
  for (const kind of ["spd", "ground"] as const) {
    if (!node[kind]) continue;
    b.polyline([from, { x, y: from.y }, { x, y: from.y - 6 }], node.id, "thin");
    b.component(kind === "spd" ? "elec_surge_protector" : "elec_ground", "line", { x, y: from.y - 6 }, node.id);
    x += step;
  }
}

/** The feed ahead of a node: device with its label, conductor with its tag. Returns the y where its body starts. */
function drawFeed(b: Builder, node: ElectricalOneLineNode, x: number, y: number, parentIsBus: boolean, devZone: number, condZone: number): number {
  const dev = feederDevice(node, parentIsBus);
  if (dev !== "none") {
    b.line({ x, y }, { x, y: y - GAP }, node.id);
    const t = b.component(DEVICE_SYMBOL[dev], "line", { x, y: y - GAP }, node.id);
    if (node.feeder?.device_label) b.label({ x: x + 4, y: y - GAP }, [{ text: node.feeder.device_label.toUpperCase() }], node.id, LABEL_WIDTH, "device", x);
    const load = t.load ?? t.bottom;
    if (load) b.line(load, { x, y: y - devZone }, node.id);
  } else if (devZone > 0) {
    b.line({ x, y }, { x, y: y - devZone }, node.id);
  }
  const top = y - devZone;
  b.line({ x, y: top }, { x, y: top - condZone }, node.id);
  const tag = feederTag(node.feeder);
  if (tag.length > 0) b.label({ x: x + 2.5, y: top - GAP }, tag, node.id, LABEL_WIDTH, "conductor", x);
  const mark = node.feeder?.type_mark;
  if (mark) {
    // On the conductor, on the side away from its tag; horizontal layouts turn, so it sits mid-conductor below the line.
    const w = ovalWidth(mark);
    b.oval(horizontal ? { x: x - OVAL_H / 2 - 2, y: top - condZone / 2 } : { x: x - w / 2 - 2, y: top - condZone / 2 }, mark, node.id);
  }
  return top - condZone;
}

/** Children under a point: from a bus (each through its own device) or a tap off an inline piece. */
function drawChildren(b: Builder, kids: readonly Measured[], parent: Measured, left: number, from: Vec2, fromBus: boolean, depth: number): void {
  if (kids.length === 0) return;
  const s = span(parent, left);
  let cursor = s.left + (s.width - kids.reduce((sum, k) => sum + k.width, 0)) / 2;
  const sibDevice = fromBus ? Math.max(0, ...kids.map((k) => deviceZone(k.node, true))) : 0;
  let y = from.y;
  if (!fromBus && kids.length > 1) {
    const centers = kids.map((k, i) => anchorX(k, cursor + kids.slice(0, i).reduce((sum, kk) => sum + kk.width, 0)));
    y = from.y - GAP * 2;
    b.line(from, { x: from.x, y }, parent.node.id);
    b.line({ x: Math.min(...centers, from.x), y }, { x: Math.max(...centers, from.x), y }, parent.node.id, "wide");
  }
  for (const k of kids) {
    place(b, k, cursor, { x: kids.length === 1 && !fromBus ? from.x : anchorX(k, cursor), y }, fromBus, depth, sibDevice);
    cursor += k.width;
  }
}

/** One node whose feed starts at `entry` (on the parent's bus, or under its load terminal). */
function place(b: Builder, m: Measured, left: number, entry: Vec2, parentIsBus: boolean, depth: number, siblingDeviceZone: number): void {
  const start = b.items.length;
  b.entries[m.node.id] = round(entry);
  placeBody(b, m, left, entry, parentIsBus, depth, siblingDeviceZone);
  b.ranges[m.node.id] = [start, b.items.length];
}

function placeBody(b: Builder, m: Measured, left: number, entry: Vec2, parentIsBus: boolean, depth: number, siblingDeviceZone: number): void {
  const node = m.node;
  const s = span(m, left);
  const x = anchorX(m, left);
  if (Math.abs(entry.x - x) > 0.01) b.line(entry, { x, y: entry.y }, node.id);
  const devZone = Math.max(deviceZone(node, parentIsBus), siblingDeviceZone);
  // A transfer switch's emergency source sits beside it, below the parent's bus: the feed is long enough for it.
  const condZone = m.emergency ? Math.max(conductorZone(node), GAP * 2 + sourceHeight(m.emergency.node) + 4 - devZone) : conductorZone(node);
  const y = drawFeed(b, node, x, entry.y, parentIsBus, devZone, condZone);
  const body = bodyHeight(node);
  const label = labelLines(node);

  if (BUS_KINDS.has(node.kind)) {
    let yy = y;
    if (node.main && node.main.device !== "none") {
      b.line({ x, y }, { x, y: y - GAP }, node.id);
      const t = b.component(DEVICE_SYMBOL[node.main.device], "line", { x, y: y - GAP }, node.id);
      if (node.main.label) b.label({ x: x - 4 - 30, y: y - GAP }, [{ text: node.main.label.toUpperCase() }], node.id, 30, "device", x);
      yy = (t.load ?? t.bottom ?? { x, y: y - GAP }).y;
    }
    const busY = y - body;
    b.line({ x, y: yy }, { x, y: busY }, node.id);
    const centers = (() => {
      let c = s.left + (s.width - m.children.reduce((sum, k) => sum + k.width, 0)) / 2;
      return m.children.map((k) => {
        const cx = anchorX(k, c);
        c += k.width;
        return cx;
      });
    })();
    const busLeft = Math.min(x - 18, ...centers.map((c) => c - 8)) - m.accessories * ACCESSORY;
    const busRight = Math.max(x + 18, ...centers.map((c) => c + 8));
    b.line({ x: busLeft, y: busY }, { x: busRight, y: busY }, node.id, "heavy");
    b.label({ x: x + 7, y }, label, node.id, LABEL_WIDTH, "equipment", x);
    b.nodes.push({ id: node.id, kind: node.kind, name: node.name, center: { x, y: busY }, depth });
    if (m.accessories > 0) accessories(b, node, { x: busLeft, y: busY }, busLeft + ACCESSORY / 2, ACCESSORY);
    drawChildren(b, m.children, m, left, { x, y: busY }, true, depth + 1);
    return;
  }

  // Inline equipment on the line, label to its right.
  const symbolId = KIND_SYMBOL[node.kind];
  const shape = sym(symbolId);
  let terms: Record<string, Vec2>;
  if (node.kind === "ats") {
    const lineX = x + ((shape.terminals.line ?? [0.5, 1])[0] - 0.5) * shape.w;
    b.polyline([{ x, y }, { x, y: y - GAP }, { x: lineX, y: y - GAP }, { x: lineX, y: y - GAP * 2 }], node.id);
    terms = b.component(symbolId, "line", { x: lineX, y: y - GAP * 2 }, node.id);
  } else {
    terms = b.component(symbolId, shape.terminals.line ? "line" : "top", { x, y }, node.id);
  }
  const symBottom = (terms.bottom ?? { x, y: y - shape.h }).y;
  b.label({ x: x + shape.w / 2 + 3, y }, label, node.id, LABEL_WIDTH, "equipment", x);
  b.nodes.push({ id: node.id, kind: node.kind, name: node.name, center: { x, y: (y + symBottom) / 2 }, depth });
  if (m.accessories > 0 && terms.left) accessories(b, node, terms.left, terms.left.x - 8, -ACCESSORY);

  if (m.emergency && node.kind === "ats") {
    const emT = terms.emergency;
    if (!emT) throw new Error("The transfer switch symbol has no emergency terminal");
    const emX = s.left + s.width + m.emergency.width / 2;
    // Run across just under the feeder tag, above this switch's label.
    const runY = y + GAP / 2;
    const emTop = runY + GAP + sourceHeight(m.emergency.node);
    const emBottom = placeSource(b, m.emergency, emX, emTop, depth);
    b.polyline([{ x: emX, y: emBottom }, { x: emX, y: runY }, { x: emT.x, y: runY }, { x: emT.x, y: emT.y }], m.emergency.node.id);
  }

  const kids = m.children;
  if (kids.length === 0) return;
  const exit = terms.load ?? terms.bottom;
  if (!exit) return;
  const bottom = y - body;
  if (exit.y > bottom) b.line(exit, { x: exit.x, y: bottom }, node.id);
  drawChildren(b, kids, m, left, { x: exit.x, y: bottom }, false, depth + 1);
}

/** A source drawn from `topY` down: symbol, its own device and conductor. Returns the y its conductor ends at. */
function placeSource(b: Builder, m: Measured, x: number, topY: number, depth: number): number {
  const node = m.node;
  const shape = sym(KIND_SYMBOL[node.kind]);
  const terms = b.component(KIND_SYMBOL[node.kind], "top", { x, y: topY }, node.id);
  b.label({ x: x + shape.w / 2 + 3, y: topY }, labelLines(node), node.id, LABEL_WIDTH, "equipment", x);
  b.nodes.push({ id: node.id, kind: node.kind, name: node.name, center: { x, y: topY - shape.h / 2 }, depth });
  if (m.accessories > 0 && terms.left) accessories(b, node, terms.left, terms.left.x - 8, -ACCESSORY);
  const bodyBottom = topY - bodyHeight(node);
  const out = terms.load ?? terms.bottom;
  if (out && out.y > bodyBottom) b.line(out, { x, y: bodyBottom }, node.id);
  return drawFeed(b, node, x, bodyBottom, false, deviceZone(node, false), conductorZone(node));
}

/** Children in reverse, all the way down: a horizontal layout turns a quarter turn, so the first child ends up on top. */
function reversed(n: ElectricalOneLineNode): ElectricalOneLineNode {
  return { ...n, ...(n.children ? { children: [...n.children].reverse().map(reversed) } : {}) };
}

/** A quarter turn counter-clockwise: power flowing down the sheet flows left to right. */
function turn(p: Vec2): Vec2 {
  return round({ x: -p.y, y: p.x });
}

/** A vertical layout's items turned to flow left to right; text stays upright beside the line it labels. */
function turnItems(items: readonly OneLineItem[]): OneLineItem[] {
  return items.map((item): OneLineItem => {
    switch (item.shape) {
      case "component":
        return { ...item, at: turn(item.at), rotationDeg: 90 };
      case "line":
        return { ...item, points: [turn(item.points[0]), turn(item.points[1])] };
      case "polyline":
        return { ...item, points: item.points.map(turn) };
      case "oval":
        return { ...item, center: turn(item.center) };
      case "text": {
        if (item.ref === undefined) return { ...item, at: turn(item.at) };
        // Along the flow from where the label started; beside the line on the side it was on.
        // Keep the label's gap from the line (it clears the symbol), now above or below it.
        const h = textHeight(item.lines, item.widthMm);
        const right = item.at.x >= item.ref;
        const gap = right ? item.at.x - item.ref : item.ref - (item.at.x + item.widthMm);
        return { ...item, at: round({ x: -item.at.y, y: right ? item.ref + gap + h : item.ref - Math.max(2, gap) }) };
      }
    }
  });
}

function placeholders(spec: ElectricalOneLineSpec): Set<string> {
  const out = new Set<string>();
  const walk = (n: ElectricalOneLineNode) => {
    if (n.placeholder) out.add(n.id);
    if (n.emergency) walk(n.emergency);
    for (const c of n.children ?? []) walk(c);
  };
  for (const r of spec.roots) walk(r);
  return out;
}

/** The radial layout as the kernel's diagram result (with where each node's feed leaves its parent). */
export interface RadialOneLineLayout extends DiagramLayoutResult {
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly kind: OneLineEquipmentKind; readonly name: string; readonly center: Vec2; readonly depth: number }>;
}

/** Lay out the whole diagram; throws the plain reason when the description can't be drawn. */
export function layoutRadialOneLine(spec: ElectricalOneLineSpec, options: Pick<OneLineLayoutOptions, "orientation"> = {}): RadialOneLineLayout {
  const problem = checkOneLineSpec(spec);
  if (problem) throw new Error(problem);
  const turned = options.orientation === "horizontal";
  horizontal = turned;
  try {
    const b = new Builder(placeholders(spec));
    let left = 0;
    for (const root of (turned ? [...spec.roots].reverse().map(reversed) : spec.roots).map(measure)) {
      const x = anchorX(root, left);
      if (SOURCE_KINDS.has(root.node.kind)) {
        // A source's own feeder (if any) is its service conductor to what it feeds.
        const start = b.items.length;
        b.entries[root.node.id] = round({ x, y: 0 });
        const bottom = placeSource(b, root, x, 0, 0);
        drawChildren(b, root.children, root, left, { x, y: bottom }, false, 1);
        b.ranges[root.node.id] = [start, b.items.length];
      } else {
        place(b, root, left, { x, y: 0 }, false, 0, 0);
      }
      left += root.width;
    }
    const items: OneLineItem[] = turned ? turnItems(b.items) : [...b.items];
    const nodes = turned ? b.nodes.map((n) => ({ ...n, center: turn(n.center) })) : b.nodes;
    const entries = turned ? Object.fromEntries(Object.entries(b.entries).map(([k, v]) => [k, turn(v)])) : b.entries;
    const ext = oneLineItemsExtent(items);
    if (spec.title) items.push({ shape: "text", at: { x: ext.min.x, y: round({ x: 0, y: ext.max.y + 10 }).y }, widthMm: Math.max(100, ext.max.x - ext.min.x), lines: [{ text: spec.title.toUpperCase(), bold: true }], nodeId: "title", role: "note" });
    if (spec.notes && spec.notes.length > 0) {
      items.push({
        shape: "text",
        at: { x: ext.min.x, y: round({ x: 0, y: ext.min.y - 8 }).y },
        widthMm: Math.max(120, ext.max.x - ext.min.x),
        lines: [{ text: "NOTES:", bold: true }, ...spec.notes.map((n, i) => ({ text: `${i + 1}. ${n.toUpperCase()}` }))],
        nodeId: "notes",
        role: "note",
      });
    }
    return { items, extent: oneLineItemsExtent(items), nodes, ranges: b.ranges, entries };
  } finally {
    horizontal = false;
  }
}

/** A stored one-line spec this row can read: an object with a list of roots (the strict schema runs where a person writes one). */
function isOneLineSpec(stored: unknown): stored is ElectricalOneLineSpec {
  return typeof stored === "object" && stored !== null && "roots" in stored && Array.isArray(stored.roots);
}

const NO_ROOTS = "This one-line has no equipment to draw";

/** The radial one-line through the kernel's diagram layout point (kind `one_line`, frozen). */
export const ONE_LINE_LAYOUT_ROW: DiagramLayoutRow = {
  kind: "one_line",
  label: "One-line diagram",
  check: (stored) => (isOneLineSpec(stored) ? checkOneLineSpec(stored) : NO_ROOTS),
  layout: (stored, ctx) => {
    if (!isOneLineSpec(stored)) return { refused: NO_ROOTS };
    const problem = checkOneLineSpec(stored);
    if (problem) return { refused: problem };
    return layoutRadialOneLine(stored, ctx.orientation ? { orientation: ctx.orientation } : {});
  },
};