import {
  clipSegment,
  copyPoint,
  copyText,
  organizationOf,
  partToWorld,
  pushTo,
  resolveConnectors,
  resolveSymbol,
  serviceLinkName,
  type GroupEntry,
  type ModelState,
  type PartInstance,
  type Primitive,
  type ServiceLink,
  type TypicalCopy,
  type TypicalSpec,
  type Vec2,
  type ViewElement,
  type ViewGraphicsRow,
} from "@permitzip/bim-kernel";
import { categoryLook } from "@permitzip/bim-kernel/categories";
import { DEFAULT_TYP_LABEL_TEMPLATE, typLabelFrom, typLabelTemplateOf } from "../catalog/drafting-standard";
import { HASH_MARK_STYLES, circuitGraphicsRefusal, circuitGraphicsSchema, type CircuitGraphicHint, type CircuitGraphicStyle, type CircuitGraphicsProps, type HashMarkStyle } from "./circuit-graphics-settings";

export * from "./circuit-graphics-settings";

/**
 * Circuit lines on plans (moved from the kernel's `annotation/connection-graphics.ts`
 * in round 12; same model, same primitives), drawn through the kernel's view
 * graphics point (`CIRCUIT_GRAPHICS_ROW`, hints under `ViewProps.circuitGraphics`).
 *
 * Connection graphics (G8): how served-from links draw on a plan. Nothing
 * here is stored line work. Every draw derives the lines from the model, so
 * moving a device moves its circuit line and home run with it, and a person's
 * adjustments (pinned bends, which line breaks at a crossing) are small hints
 * on the view (`ViewProps.circuitGraphics`).
 *
 * - Lines end exactly where they leave the device's plan symbol, measured
 *   from its connection point (the connector's plan position), so nothing
 *   overhangs into or past the symbol.
 * - The home run is an arrow on the member nearest the source, tagged with
 *   the link's name ("L1-1,3"). Members are joined nearest-neighbour from
 *   there. Both are display only: who is on the circuit is the engineer's
 *   choice (WS-C), never computed (internal design note, US 8,738,332).
 * - Where two lines cross, the lower-priority one gets a gap.
 * - Switch legs: dashed from each switch to the fixtures sharing its switch
 *   leg letter.
 * - Typicals: copies draw their circuiting when the view asks, else the
 *   original's home run reads "TYP.".
 *
 * General across trades: any link with members draws the same way.
 */

/**
 * Wire hash marks on a home run (round 12): off; hots long and the neutral
 * short; or the same plus the ground (a long mark with a foot). Kept in the
 * view's `circuitGraphics.hashMarks`.
 */
export const CIRCUIT_HASH_MARK_STYLES = HASH_MARK_STYLES;
export type CircuitHashMarkStyle = HashMarkStyle;

export interface ResolvedCircuitGraphics {
  readonly style: CircuitGraphicStyle;
  readonly homeRuns: boolean;
  readonly switchLegs: boolean;
  readonly allCopies: boolean;
  readonly hashMarks: CircuitHashMarkStyle;
  readonly hints: Readonly<Record<string, CircuitGraphicHint>>;
  /** With copies drawn: a repeated home run is labelled once, "(3) TYP.", on the original. */
  readonly typLabelsOnce: boolean;
}

const isHashMarkStyle = (v: unknown): v is CircuitHashMarkStyle => typeof v === "string" && (CIRCUIT_HASH_MARK_STYLES as readonly string[]).includes(v);

/** The view's settings with defaults: arcs on electrical plans, nothing on other plans and views; no hash marks. */
export function resolveCircuitGraphics(view: ViewElement): ResolvedCircuitGraphics {
  const p: CircuitGraphicsProps = view.props?.circuitGraphics ?? {};
  const plan = view.viewType === "floor_plan" || view.viewType === "ceiling_plan";
  const style: CircuitGraphicStyle = !plan ? "off" : (p.style ?? (view.props?.discipline === "electrical" ? "arcs" : "off"));
  // Read tolerantly: a record without it (or with a word a newer build wrote) reads as off.
  const marks: unknown = p.hashMarks;
  return { style, homeRuns: p.homeRuns ?? true, switchLegs: p.switchLegs ?? true, allCopies: p.allCopies ?? false, hashMarks: isHashMarkStyle(marks) ? marks : "off", hints: p.hints ?? {}, typLabelsOnce: p.typLabelsOnce !== false };
}

/** The conductors a circuit's home run marks, in order: one per hot, the neutral on a single-pole or a circuit that states one, then the ground. */
export function circuitConductorMarks(model: Pick<ModelState, "elements">, linkId: string | null, style: CircuitHashMarkStyle): ReadonlyArray<"hot" | "neutral" | "ground"> {
  if (style === "off" || !linkId) return [];
  const link = model.elements[linkId];
  if (link?.kind !== "service_link") return [];
  const hots = Math.max(1, link.source.positions.length);
  const neutral = hots === 1 || link.electrical?.conductors?.neutralSize !== undefined;
  return [...Array.from({ length: hots }, () => "hot" as const), ...(neutral ? ["neutral" as const] : []), ...(style === "hots_neutral_ground" ? ["ground" as const] : [])];
}

/** Paper mm: hash marks across a home run. */
const HASH_LONG_MM = 1.8;
const HASH_SHORT_MM = 1;
const HASH_PITCH_MM = 0.7;
const HASH_FOOT_MM = 0.6;

/** Hash marks across the shaft from `from` to `tip` (paper mm), centred 40 % of the way. */
function hashMarkLines(from: Vec2, tip: Vec2, marks: ReadonlyArray<"hot" | "neutral" | "ground">): Array<readonly [Vec2, Vec2]> {
  const l = dist(from, tip);
  if (l < 1e-6 || marks.length === 0) return [];
  const u = { x: (tip.x - from.x) / l, y: (tip.y - from.y) / l };
  const n = { x: -u.y, y: u.x };
  const centre = lerp(from, tip, 0.4);
  const out: Array<readonly [Vec2, Vec2]> = [];
  marks.forEach((m, i) => {
    const along = (i - (marks.length - 1) / 2) * HASH_PITCH_MM;
    const c = { x: centre.x + u.x * along, y: centre.y + u.y * along };
    const half = (m === "neutral" ? HASH_SHORT_MM : HASH_LONG_MM) / 2;
    const a = { x: c.x - n.x * half, y: c.y - n.y * half };
    const b = { x: c.x + n.x * half, y: c.y + n.y * half };
    out.push([a, b]);
    if (m === "ground") out.push([b, { x: b.x + u.x * HASH_FOOT_MM, y: b.y + u.y * HASH_FOOT_MM }]);
  });
  return out;
}

/** The key a pinned bend is stored under: the two devices' ids, sorted. */
export function bendKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The view's circuit settings with one bend pinned (or cleared with null): what `set_view_properties` takes as `circuitGraphics`. */
export function withCircuitBend(view: ViewElement, linkId: string, a: string, b: string, point: Vec2 | null): CircuitGraphicsProps {
  const props = view.props?.circuitGraphics ?? {};
  const hint = props.hints?.[linkId] ?? {};
  const bends = { ...(hint.bends ?? {}) };
  if (point) bends[bendKey(a, b)] = { x: Math.round(point.x), y: Math.round(point.y) };
  else delete bends[bendKey(a, b)];
  const nextHint: CircuitGraphicHint = { ...hint, bends };
  return { ...props, hints: { ...(props.hints ?? {}), [linkId]: nextHint } };
}

/** One drawn connection, in model mm. */
export interface CircuitGraphic {
  /** Link id (and `@copy` for a typical's copy), or `switch:<id>`. */
  readonly key: string;
  readonly linkId: string | null;
  readonly kind: "circuit" | "switch_leg";
  readonly priority: number;
  readonly dashed: boolean;
  /** Joining lines, member to member, in drawing order. */
  readonly paths: readonly (readonly Vec2[])[];
  /** Member pairs each path joins (same order as `paths`). */
  readonly joins: readonly (readonly [string, string])[];
  readonly homeRun: { readonly memberId: string; readonly from: Vec2; readonly tip: Vec2; readonly label: string } | null;
  readonly numbers: readonly { readonly memberId: string; readonly at: Vec2; readonly text: string }[];
}

/** Paper mm: home-run arrow length, label size, the gap each side of a crossing. */
const HOME_RUN_MM = 8;
const ARROW_HEAD_MM = 1.6;
const LABEL_MM = 2.2;
const NUMBER_MM = 2;
const CROSSING_GAP_MM = 1;
/** Arc bulge as a share of the chord. */
const ARC_SAG = 0.15;
const ARC_PIECES = 12;
const SWITCH_LEG_DASH: readonly number[] = [1.5, 1];
/** Paper mm between two square runs that would otherwise sit on each other; runs closer than half this count as stacked. */
const SQUARE_RUN_OFFSET_MM = 1.5;
/** How many offsets either side a square run may step before it accepts some overlap. */
const SQUARE_OFFSETS = 3;
/** Paper mm grid the drawn-runs index buckets on. */
const RUN_CELL_MM = 20;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

type Outline = { readonly kind: "seg"; readonly a: Vec2; readonly b: Vec2 } | { readonly kind: "circle"; readonly c: Vec2; readonly r: number };

/** A placed part's plan symbol as boundaries in world mm (text as a box the size it prints). */
function symbolOutline(model: ModelState, part: PartInstance, scale: number): Outline[] {
  const type = model.elements[part.typeId];
  if (type?.kind !== "part_type") return [];
  const w = (q: Vec2) => partToWorld(part, q);
  const out: Outline[] = [];
  const box = (c: Vec2, hx: number, hy: number) => {
    const k = [w({ x: c.x - hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y - hy }), w({ x: c.x + hx, y: c.y + hy }), w({ x: c.x - hx, y: c.y + hy })];
    for (let i = 0; i < 4; i++) out.push({ kind: "seg", a: k[i] ?? c, b: k[(i + 1) % 4] ?? c });
  };
  for (const s of resolveSymbol(type.definition, part.values)) {
    if (s.kind === "rect") box(s.center, s.size.x / 2, s.size.y / 2);
    else if (s.kind === "circle") out.push({ kind: "circle", c: w(s.center), r: s.radius });
    else if (s.kind === "line") out.push({ kind: "seg", a: w(s.from), b: w(s.to) });
    else if (s.kind === "polyline") {
      for (let i = 0; i + 1 < s.points.length; i++) out.push({ kind: "seg", a: w(s.points[i] ?? s.points[0]!), b: w(s.points[i + 1] ?? s.points[0]!) });
      if (s.closed && s.points.length > 2) out.push({ kind: "seg", a: w(s.points[s.points.length - 1]!), b: w(s.points[0]!) });
    } else box(s.at, 0.6 * NUMBER_MM * scale, 0.6 * NUMBER_MM * scale);
  }
  return out;
}

/** The connector's plan position, the symbol's connection point (the insertion point when the part has none). */
export function connectionPoint(model: ModelState, part: PartInstance, connector: string): Vec2 {
  const type = model.elements[part.typeId];
  if (type?.kind !== "part_type") return part.position;
  const c = resolveConnectors(type.definition, part.values).find((x) => x.id === connector);
  return c ? partToWorld(part, { x: c.position[0], y: c.position[1] }) : part.position;
}

/** Where a line from `from` toward `to` leaves the symbol: the last crossing of its outline before `to`, else `from`. */
export function exitPoint(outline: readonly Outline[], from: Vec2, to: Vec2): Vec2 {
  const d = { x: to.x - from.x, y: to.y - from.y };
  let best = 0;
  for (const o of outline) {
    if (o.kind === "seg") {
      const e = { x: o.b.x - o.a.x, y: o.b.y - o.a.y };
      const den = d.x * e.y - d.y * e.x;
      if (Math.abs(den) < 1e-12) continue;
      const w = { x: o.a.x - from.x, y: o.a.y - from.y };
      const t = (w.x * e.y - w.y * e.x) / den;
      const u = (w.x * d.y - w.y * d.x) / den;
      if (t > best && t <= 1 && u >= -1e-9 && u <= 1 + 1e-9) best = t;
    } else {
      const f = { x: from.x - o.c.x, y: from.y - o.c.y };
      const a = d.x * d.x + d.y * d.y;
      const b = 2 * (f.x * d.x + f.y * d.y);
      const c = f.x * f.x + f.y * f.y - o.r * o.r;
      const disc = b * b - 4 * a * c;
      if (a < 1e-12 || disc < 0) continue;
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      if (t > best && t <= 1) best = t;
    }
  }
  return lerp(from, to, best);
}

/** Points along the circle through a, m, b from a to b (a straight line when they are in a row). */
function arcThrough(a: Vec2, m: Vec2, b: Vec2): Vec2[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9 * Math.max(1, dist(a, b) ** 2)) return [a, b];
  const sq = (p: Vec2) => p.x * p.x + p.y * p.y;
  const c = { x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d, y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d };
  const r = dist(c, a);
  const ang = (p: Vec2) => Math.atan2(p.y - c.y, p.x - c.x);
  const a0 = ang(a);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const toB = norm(ang(b) - a0);
  const toM = norm(ang(m) - a0);
  // Counter-clockwise from a reaches m before b, or the arc runs clockwise.
  const sweep = toM <= toB ? toB : toB - 2 * Math.PI;
  const out: Vec2[] = [];
  for (let i = 0; i <= ARC_PIECES; i++) {
    const t = a0 + (sweep * i) / ARC_PIECES;
    out.push(i === 0 ? a : i === ARC_PIECES ? b : { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return out;
}

interface Node {
  readonly id: string;
  readonly part: PartInstance;
  readonly point: Vec2;
  readonly outline: readonly Outline[];
}

/** A square line through `corners`, its ends where it leaves each symbol. */
function squarePath(a: Node, b: Node, corners: readonly Vec2[]): Vec2[] {
  const first = corners[0] ?? b.point;
  const last = corners[corners.length - 1] ?? a.point;
  const pts = [exitPoint(a.outline, a.point, first), ...corners, exitPoint(b.outline, b.point, last)];
  return pts.filter((q, i) => i === 0 || dist(q, pts[i - 1] ?? q) > 0.5);
}

/**
 * Square routes from a to b, shortest first: the two L corners (or the
 * straight run when they line up), then the same shapes with one run pushed
 * sideways by 1, 2, 3 offsets either way, so a run that would sit on top of
 * another can step beside it instead.
 */
function squareCandidates(a: Vec2, b: Vec2, step: number): Vec2[][] {
  const aligned = Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1;
  const out: Vec2[][] = aligned ? [[]] : [[{ x: b.x, y: a.y }], [{ x: a.x, y: b.y }]];
  const horizontal = Math.abs(a.y - b.y) < 1;
  for (let k = 1; k <= SQUARE_OFFSETS; k++) {
    for (const o of [k * step, -k * step]) {
      if (aligned) {
        out.push(horizontal ? [{ x: a.x, y: a.y + o }, { x: b.x, y: a.y + o }] : [{ x: a.x + o, y: a.y }, { x: a.x + o, y: b.y }]);
        continue;
      }
      out.push([{ x: a.x, y: a.y + o }, { x: b.x, y: a.y + o }]);
      out.push([{ x: a.x + o, y: a.y }, { x: a.x + o, y: b.y }]);
      out.push([{ x: b.x + o, y: a.y }, { x: b.x + o, y: b.y }]);
      out.push([{ x: a.x, y: b.y + o }, { x: b.x, y: b.y + o }]);
    }
  }
  return out;
}

/**
 * Lines already drawn on a plan, bucketed on a model grid so a new line only
 * compares against its neighbours: what keeps square runs from stacking.
 */
export class DrawnRuns {
  private readonly cells = new Map<string, Array<readonly [Vec2, Vec2]>>();
  /** `tolerance`: runs closer than this (model mm) side by side count as on top of each other. */
  constructor(
    private readonly cell: number,
    readonly tolerance: number,
  ) {}

  private keys(a: Vec2, b: Vec2, pad: number): string[] {
    const x0 = Math.floor((Math.min(a.x, b.x) - pad) / this.cell);
    const x1 = Math.floor((Math.max(a.x, b.x) + pad) / this.cell);
    const y0 = Math.floor((Math.min(a.y, b.y) - pad) / this.cell);
    const y1 = Math.floor((Math.max(a.y, b.y) + pad) / this.cell);
    const out: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  }

  add(path: readonly Vec2[]): void {
    for (let i = 0; i + 1 < path.length; i++) {
      const s = [path[i]!, path[i + 1]!] as const;
      for (const k of this.keys(s[0], s[1], 0)) pushTo(this.cells, k, s);
    }
  }

  /** Length of `path` (model mm) lying along a drawn run, within the tolerance. */
  overlap(path: readonly Vec2[]): number {
    let total = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const seen = new Set<readonly [Vec2, Vec2]>();
      for (const k of this.keys(a, b, this.tolerance)) {
        for (const s of this.cells.get(k) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          total += collinearOverlap(a, b, s[0], s[1], this.tolerance);
        }
      }
    }
    return total;
  }
}

/** How far segment p..q runs along r..s (parallel and within `tolerance` of it), in mm; 0 when they only touch or cross. */
export function collinearOverlap(p: Vec2, q: Vec2, r: Vec2, s: Vec2, tolerance: number): number {
  const len = dist(p, q);
  const other = dist(r, s);
  if (len < 1e-6 || other < 1e-6) return 0;
  const u = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
  if (Math.abs(u.x * (s.y - r.y) - u.y * (s.x - r.x)) / other > 1e-6) return 0;
  if (Math.abs(u.x * (r.y - p.y) - u.y * (r.x - p.x)) > tolerance) return 0;
  const t0 = u.x * (r.x - p.x) + u.y * (r.y - p.y);
  const t1 = u.x * (s.x - p.x) + u.y * (s.y - p.y);
  const lo = Math.max(0, Math.min(t0, t1));
  const hi = Math.min(len, Math.max(t0, t1));
  return hi - lo > tolerance ? hi - lo : 0;
}

const pathLength = (path: readonly Vec2[]) => path.reduce((s, p, i) => (i === 0 ? 0 : s + dist(path[i - 1]!, p)), 0);

/** The square line a..b that stacks on the fewest drawn runs (then the shortest, then the first L): the corner is chosen per line. */
function squareJoin(a: Node, b: Node, bend: Vec2 | undefined, drawn: DrawnRuns, step: number): Vec2[] {
  if (bend) return squarePath(a, b, [{ x: bend.x, y: a.point.y }, { x: bend.x, y: b.point.y }]);
  let best: Vec2[] | null = null;
  let bestOverlap = Infinity;
  let bestLength = Infinity;
  for (const corners of squareCandidates(a.point, b.point, step)) {
    const path = squarePath(a, b, corners);
    const over = drawn.overlap(path);
    const length = pathLength(path);
    if (over < bestOverlap - 1e-6 || (Math.abs(over - bestOverlap) <= 1e-6 && length < bestLength - 1e-6)) {
      best = path;
      bestOverlap = over;
      bestLength = length;
    }
    // Candidates come shortest first, so the first clear one is the answer.
    if (over === 0) break;
  }
  return best ?? squarePath(a, b, []);
}

/** The joining line between two members in the view's style, ends on the symbols. */
function joinPath(style: CircuitGraphicStyle, a: Node, b: Node, bend: Vec2 | undefined, drawn: DrawnRuns, step: number): Vec2[] {
  if (style === "orthogonal") return squareJoin(a, b, bend, drawn, step);
  if (bend) return arcThrough(exitPoint(a.outline, a.point, bend), bend, exitPoint(b.outline, b.point, bend));
  const pa = exitPoint(a.outline, a.point, b.point);
  const pb = exitPoint(b.outline, b.point, a.point);
  const chord = dist(pa, pb);
  if (chord < 1) return [pa, pb];
  const n = { x: -(pb.y - pa.y) / chord, y: (pb.x - pa.x) / chord };
  const mid = lerp(pa, pb, 0.5);
  return arcThrough(pa, { x: mid.x + n.x * chord * ARC_SAG, y: mid.y + n.y * chord * ARC_SAG }, pb);
}

/** Members joined nearest-neighbour from `start` (ties: the order they were added). Display only. */
function chain(start: Node, rest: readonly Node[]): Node[] {
  const out = [start];
  const left = [...rest];
  let at = start;
  while (left.length > 0) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (dist(at.point, left[i]!.point) < dist(at.point, left[bi]!.point)) bi = i;
    at = left.splice(bi, 1)[0]!;
    out.push(at);
  }
  return out;
}

/**
 * Square style: each member joins the nearest one already drawn (square
 * distance), growing a tree out from the home run, so a line never runs back
 * across the room over the lines before it. Ties: the order they were added.
 * Display only, like `chain`.
 */
function squareTree(start: Node, rest: readonly Node[]): Array<readonly [Node, Node]> {
  const manhattan = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
  const inTree: Node[] = [start];
  const left = [...rest];
  const out: Array<readonly [Node, Node]> = [];
  while (left.length > 0) {
    let bi = 0;
    let bt = start;
    let bd = Infinity;
    for (let i = 0; i < left.length; i++) {
      for (const t of inTree) {
        const d = manhattan(t.point, left[i]!.point);
        if (d < bd) {
          bd = d;
          bi = i;
          bt = t;
        }
      }
    }
    const next = left.splice(bi, 1)[0]!;
    out.push([bt, next]);
    inTree.push(next);
  }
  return out;
}

/** Pairs to join in drawing order: a tree for square lines, the nearest-neighbour chain otherwise. */
function joinPairs(style: CircuitGraphicStyle, start: Node, rest: readonly Node[]): Array<readonly [Node, Node]> {
  if (style === "orthogonal") return squareTree(start, rest);
  const ordered = chain(start, rest);
  return ordered.slice(1).map((b, i) => [ordered[i]!, b] as const);
}

function nodeOf(model: ModelState, part: PartInstance, connector: string, scale: number): Node {
  return { id: part.id, part, point: connectionPoint(model, part, connector), outline: symbolOutline(model, part, scale) };
}

/** The circuit drawing for one link in model mm, or null when none of its members is shown. */
function linkGraphic(model: ModelState, link: ServiceLink, shown: ReadonlyMap<string, PartInstance>, settings: ResolvedCircuitGraphics, scale: number, typ: boolean, drawn: DrawnRuns): CircuitGraphic | null {
  const nodes: Node[] = [];
  for (const m of link.members) {
    const part = shown.get(m.elementId);
    if (part) nodes.push(nodeOf(model, part, m.connector, scale));
  }
  if (nodes.length === 0) return null;
  const hint = settings.hints[link.id];
  const source = model.elements[link.source.elementId];
  const sourceAt = source?.kind === "part" ? source.position : null;
  let home = nodes[0]!;
  if (sourceAt) for (const n of nodes) if (dist(n.part.position, sourceAt) < dist(home.part.position, sourceAt)) home = n;
  const paths: Vec2[][] = [];
  const joins: Array<[string, string]> = [];
  const name = serviceLinkName(model.elements, link);
  let homeRun: CircuitGraphic["homeRun"] = null;
  if (settings.homeRuns) {
    const toward = sourceAt && dist(sourceAt, home.point) > 1 ? sourceAt : { x: home.point.x + 1, y: home.point.y };
    const from = exitPoint(home.outline, home.point, { x: home.point.x + (toward.x - home.point.x) * 1e6, y: home.point.y + (toward.y - home.point.y) * 1e6 });
    const len = dist(home.point, toward);
    const tip = { x: from.x + ((toward.x - home.point.x) / len) * HOME_RUN_MM * scale, y: from.y + ((toward.y - home.point.y) / len) * HOME_RUN_MM * scale };
    homeRun = { memberId: home.id, from, tip, label: typ ? `${name} TYP.` : name };
    drawn.add([from, tip]);
  }
  if (settings.style === "arcs" || settings.style === "orthogonal") {
    for (const [a, b] of joinPairs(settings.style, home, nodes.filter((n) => n !== home))) {
      const path = joinPath(settings.style, a, b, hint?.bends?.[bendKey(a.id, b.id)], drawn, SQUARE_RUN_OFFSET_MM * scale);
      if (settings.style === "orthogonal") drawn.add(path);
      paths.push(path);
      joins.push([a.id, b.id]);
    }
  }
  const numbers =
    settings.style === "numbers" && link.source.positions.length > 0
      ? nodes.map((n) => {
          const r = n.outline.reduce((m, o) => Math.max(m, o.kind === "circle" ? o.r + dist(o.c, n.point) : Math.max(dist(o.a, n.point), dist(o.b, n.point))), 0);
          const off = r + 1.2 * scale;
          return { memberId: n.id, at: { x: n.point.x + off * Math.SQRT1_2, y: n.point.y + off * Math.SQRT1_2 }, text: [...link.source.positions].sort((x, y) => x - y).join(",") };
        })
      : [];
  return { key: link.id, linkId: link.id, kind: "circuit", priority: hint?.priority ?? (link.role === "feeder" ? 3 : 2), dashed: false, paths, joins, homeRun, numbers };
}

function isSwitch(model: ModelState, part: PartInstance): boolean {
  const type = model.elements[part.typeId];
  return type?.kind === "part_type" && type.definition.category === "electrical_device" && /switch/i.test(type.definition.familyName);
}

function legOf(part: PartInstance): string {
  const v = part.values.switch_leg;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** Dashed switch legs: each switch to the shown fixtures with its switch leg letter, nearest-neighbour. */
function switchLegs(model: ModelState, shown: ReadonlyMap<string, PartInstance>, settings: ResolvedCircuitGraphics, scale: number, drawn: DrawnRuns): CircuitGraphic[] {
  const fixtures = new Map<string, PartInstance[]>();
  const switches: PartInstance[] = [];
  for (const part of shown.values()) {
    const leg = legOf(part);
    if (!leg) continue;
    if (isSwitch(model, part)) switches.push(part);
    else {
      const type = model.elements[part.typeId];
      if (type?.kind === "part_type" && type.definition.category === "lighting_fixture") pushTo(fixtures, leg, part);
    }
  }
  const out: CircuitGraphic[] = [];
  const style = settings.style === "orthogonal" ? "orthogonal" : "arcs";
  for (const sw of switches.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const lit = fixtures.get(legOf(sw)) ?? [];
    if (lit.length === 0) continue;
    const start = nodeOf(model, sw, "power", scale);
    const paths: Vec2[][] = [];
    const joins: Array<[string, string]> = [];
    for (const [a, b] of joinPairs(style, start, lit.map((f) => nodeOf(model, f, "power", scale)))) {
      const path = joinPath(style, a, b, undefined, drawn, SQUARE_RUN_OFFSET_MM * scale);
      if (style === "orthogonal") drawn.add(path);
      paths.push(path);
      joins.push([a.id, b.id]);
    }
    out.push({ key: `switch:${sw.id}`, linkId: null, kind: "switch_leg", priority: 0, dashed: true, paths, joins, homeRun: null, numbers: [] });
  }
  return out;
}

function moved(g: CircuitGraphic, spec: TypicalSpec, copy: TypicalCopy): CircuitGraphic {
  const T = (p: Vec2) => copyPoint(spec, copy, p);
  return {
    ...g,
    key: `${g.key}@${copy.id}`,
    paths: g.paths.map((path) => path.map(T)),
    homeRun: g.homeRun ? { ...g.homeRun, from: T(g.homeRun.from), tip: T(g.homeRun.tip), label: copyText(spec, copy, g.homeRun.label) } : null,
    numbers: g.numbers.map((n) => ({ ...n, at: T(n.at) })),
  };
}

function withHomeRunLabel(g: CircuitGraphic, label: string): CircuitGraphic {
  return g.homeRun ? { ...g, homeRun: { ...g.homeRun, label } } : g;
}

/** The original's home-run label with how many units carry the circuit, through the project's template ("L1-1 (3) TYP." by default). */
export function typLabel(g: CircuitGraphic, spec: TypicalSpec, template: string = DEFAULT_TYP_LABEL_TEMPLATE): string {
  return typLabelFrom(template, g.homeRun?.label ?? "", spec.copies.length + 1);
}

/**
 * Every connection graphic a plan draws, in model mm, before crossing gaps:
 * the links serving the parts shown (`shown`, what the plan drew), switch
 * legs, and the copies of typicals.
 */
export function deriveCircuitGraphics(model: ModelState, view: ViewElement, shown: ReadonlyMap<string, PartInstance>, scale: number): CircuitGraphic[] {
  const settings = resolveCircuitGraphics(view);
  if (settings.style === "off") return [];
  const links = new Map<string, ServiceLink>();
  for (const part of shown.values()) {
    for (const id of Object.values(part.served ?? {})) {
      const link = model.elements[id];
      if (link?.kind === "service_link" && link.role === "branch") links.set(id, link);
    }
  }
  const typicals = new Map<string, TypicalSpec>();
  for (const g of organizationOf(model).groups) {
    const spec = (g.entry as GroupEntry).typical;
    if (spec && spec.copies.length > 0) typicals.set(g.id, spec);
  }
  const out: CircuitGraphic[] = [];
  // Every circuit on the plan shares one index, so a second circuit's square run steps beside the first's.
  const drawn = new DrawnRuns(RUN_CELL_MM * scale, (SQUARE_RUN_OFFSET_MM / 2) * scale);
  for (const link of [...links.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    // A circuit wholly inside one typical repeats with it.
    const groups = new Set(link.members.map((m) => model.elements[m.elementId]?.groupId));
    const only = groups.size === 1 ? [...groups][0] : undefined;
    const spec = only ? typicals.get(only) : undefined;
    const g = linkGraphic(model, link, shown, settings, scale, spec !== undefined && !settings.allCopies, drawn);
    if (!g) continue;
    if (!spec || !settings.allCopies) {
      out.push(g);
      continue;
    }
    const copies = spec.copies.map((copy) => moved(g, spec, copy));
    // Copies whose home runs read the same panel and circuit as the original (a shared panel, not each unit's own) are labelled once, with the count.
    const once = settings.typLabelsOnce && g.homeRun !== null && copies.every((c) => c.homeRun?.label === g.homeRun?.label);
    out.push(once ? withHomeRunLabel(g, typLabel(g, spec, typLabelTemplateOf(model))) : g);
    for (const c of copies) out.push(once ? withHomeRunLabel(c, "") : c);
  }
  if (settings.switchLegs) out.push(...switchLegs(model, shown, settings, scale, drawn));
  return out;
}

/** A graphic on paper, its lines split where a higher-priority line crosses. */
export interface PaperGraphic {
  readonly source: CircuitGraphic;
  /** Polylines on paper after gaps. */
  readonly lines: readonly (readonly Vec2[])[];
}

interface Seg {
  readonly g: number;
  /** Which of the graphic's polylines (paths then the home run). */
  readonly path: number;
  readonly a: Vec2;
  readonly b: Vec2;
  /** Arc length along that polyline where the segment starts. */
  readonly s0: number;
}

function cross(p: Seg, q: Seg): { t: number; u: number } | null {
  const d = { x: p.b.x - p.a.x, y: p.b.y - p.a.y };
  const e = { x: q.b.x - q.a.x, y: q.b.y - q.a.y };
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-12) return null;
  const w = { x: q.a.x - p.a.x, y: q.a.y - p.a.y };
  const t = (w.x * e.y - w.y * e.x) / den;
  const u = (w.x * d.y - w.y * d.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u } : null;
}

/** Split a polyline, leaving out the arc-length intervals in `cuts`. */
function cutPolyline(line: readonly Vec2[], cuts: ReadonlyArray<readonly [number, number]>): Vec2[][] {
  if (cuts.length === 0) return [[...line]];
  const sorted = [...cuts].sort((x, y) => x[0] - y[0]);
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  let s = 0;
  const inCut = (at: number) => sorted.some(([lo, hi]) => at > lo && at < hi);
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const l = dist(a, b);
    // Break points inside this piece, in order.
    const marks = [0, ...sorted.flatMap(([lo, hi]) => [lo - s, hi - s]).filter((m) => m > 0 && m < l), l].sort((x, y) => x - y);
    for (let k = 0; k + 1 < marks.length; k++) {
      const m0 = marks[k]!;
      const m1 = marks[k + 1]!;
      if (m1 - m0 < 1e-9) continue;
      const mid = s + (m0 + m1) / 2;
      const p0 = lerp(a, b, m0 / l);
      const p1 = lerp(a, b, m1 / l);
      if (inCut(mid)) {
        if (cur.length > 1) out.push(cur);
        cur = [];
        continue;
      }
      if (cur.length === 0) cur.push(p0);
      cur.push(p1);
    }
    s += l;
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/**
 * Graphics on paper with gaps at crossings: where two different graphics
 * cross (not where they meet at a device), the lower-priority one breaks
 * `CROSSING_GAP_MM` either side; equal priorities break the one whose key
 * sorts later, so the result is the same every time. Pieces are bucketed on
 * a paper grid so a busy plan doesn't compare every pair.
 */
export function layoutCircuitGraphics(graphics: readonly CircuitGraphic[], toPaper: (p: Vec2) => Vec2, gapMm = CROSSING_GAP_MM): PaperGraphic[] {
  const polylines = graphics.map((g) => [...g.paths, ...(g.homeRun ? [[g.homeRun.from, g.homeRun.tip]] : [])].map((path) => path.map(toPaper)));
  const segs: Seg[] = [];
  polylines.forEach((lines, g) =>
    lines.forEach((line, path) => {
      let s0 = 0;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i]!;
        const b = line[i + 1]!;
        segs.push({ g, path, a, b, s0 });
        s0 += dist(a, b);
      }
    }),
  );
  const CELL = 20;
  const grid = new Map<string, number[]>();
  segs.forEach((sg, i) => {
    const x0 = Math.floor(Math.min(sg.a.x, sg.b.x) / CELL);
    const x1 = Math.floor(Math.max(sg.a.x, sg.b.x) / CELL);
    const y0 = Math.floor(Math.min(sg.a.y, sg.b.y) / CELL);
    const y1 = Math.floor(Math.max(sg.a.y, sg.b.y) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) pushTo(grid, `${x},${y}`, i);
  });
  const ends = polylines.map((lines) => lines.flatMap((l) => (l.length > 0 ? [l[0]!, l[l.length - 1]!] : [])));
  const nearEnd = (g: number, p: Vec2) => (ends[g] ?? []).some((q) => dist(p, q) < 0.5);
  const cuts = new Map<string, Array<[number, number]>>();
  const seen = new Set<string>();
  for (const bucket of grid.values()) {
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x]!;
        const j = bucket[y]!;
        const p = segs[i]!;
        const q = segs[j]!;
        if (p.g === q.g) continue;
        const pair = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const hit = cross(p, q);
        if (!hit) continue;
        const at = lerp(p.a, p.b, hit.t);
        if (nearEnd(p.g, at) || nearEnd(q.g, at)) continue;
        const gp = graphics[p.g]!;
        const gq = graphics[q.g]!;
        const pLoses = gp.priority < gq.priority || (gp.priority === gq.priority && gp.key > gq.key);
        const loser = pLoses ? p : q;
        const s = loser.s0 + dist(loser.a, at);
        const key = `${loser.g}:${loser.path}`;
        pushTo(cuts, key, [s - gapMm, s + gapMm]);
      }
    }
  }
  return graphics.map((source, g) => ({ source, lines: (polylines[g] ?? []).flatMap((line, path) => cutPolyline(line, cuts.get(`${g}:${path}`) ?? [])) }));
}

/** One drawn line between two devices of a circuit, on paper: what a drag on the drawing pins a bend on. */
export interface CircuitJoinOnPaper {
  readonly linkId: string;
  /** The circuit as drawings name it ("L1-1"). */
  readonly name: string;
  readonly a: string;
  readonly b: string;
  readonly points: readonly Vec2[];
}

/** The plan's circuit lines that can take a bend (originals, not typical copies or switch legs), on paper. */
export function circuitJoinsOnPaper(model: ModelState, view: ViewElement, shown: ReadonlyMap<string, PartInstance>, scale: number, toPaper: (p: Vec2) => Vec2): CircuitJoinOnPaper[] {
  const out: CircuitJoinOnPaper[] = [];
  for (const g of deriveCircuitGraphics(model, view, shown, scale)) {
    if (g.kind !== "circuit" || !g.linkId || g.key !== g.linkId) continue;
    const link = model.elements[g.linkId];
    const name = link?.kind === "service_link" ? serviceLinkName(model.elements, link) : g.linkId;
    g.paths.forEach((path, i) => {
      const [a, b] = g.joins[i] ?? [];
      if (a && b) out.push({ linkId: g.linkId!, name, a, b, points: path.map(toPaper) });
    });
  }
  return out;
}

/** The circuit line within `tolerance` paper mm of `p`, nearest first; null when none is. */
export function circuitJoinNear(joins: readonly CircuitJoinOnPaper[], p: Vec2, tolerance: number): CircuitJoinOnPaper | null {
  let best: CircuitJoinOnPaper | null = null;
  let bestD = tolerance;
  for (const j of joins) {
    for (let i = 0; i + 1 < j.points.length; i++) {
      const a = j.points[i]!;
      const b = j.points[i + 1]!;
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      const d = dist(p, lerp(a, b, t));
      if (d <= bestD) {
        bestD = d;
        best = j;
      }
    }
  }
  return best;
}

type TextAnchor = "start" | "middle" | "end";
interface Box {
  readonly min: Vec2;
  readonly max: Vec2;
}

/** The paper box a line of text covers (baseline at `at.y`, cap height `size`, width `w`). */
function textBox(at: Vec2, w: number, size: number, anchor: TextAnchor): Box {
  const x0 = anchor === "start" ? at.x : anchor === "end" ? at.x - w : at.x - w / 2;
  return { min: { x: x0, y: at.y - size }, max: { x: x0 + w, y: at.y + size * 0.25 } };
}

const boxesMeet = (p: Box, q: Box) => p.min.x < q.max.x && q.min.x < p.max.x && p.min.y < q.max.y && q.min.y < p.max.y;

/**
 * Where a home run's label may go, in order: past the arrow tip (where it
 * always went), then beside the shaft on either side, then beside the tip.
 * The first one clear of other text wins, so "L1-1" never prints over the
 * panel's own "P1".
 */
function homeRunLabel(from: Vec2, tip: Vec2, u: Vec2, n: Vec2, w: number): Array<{ readonly at: Vec2; readonly anchor: TextAnchor }> {
  const anchor: TextAnchor = u.x >= -1e-9 ? "start" : "end";
  const mid = lerp(from, tip, 0.5);
  const side = LABEL_MM * 0.9;
  const beside = (p: Vec2, s: number) => ({ x: p.x + n.x * s * (side + Math.abs(n.x) * w * 0.5), y: p.y + n.y * s * side + LABEL_MM * 0.35 });
  return [
    { at: { x: tip.x + u.x * 1.2 + (anchor === "start" ? 0.6 : -0.6), y: tip.y + u.y * 1.2 + LABEL_MM * 0.35 }, anchor },
    { at: beside(mid, -1), anchor: "middle" },
    { at: beside(mid, 1), anchor: "middle" },
    { at: beside(tip, -1), anchor: "middle" },
    { at: beside(tip, 1), anchor: "middle" },
  ];
}

export interface CircuitDrawContext {
  readonly toPaper: (p: Vec2) => Vec2;
  readonly scale: number;
  /** Paper rectangle the view prints inside: lines clip to it, text must fit in it. */
  readonly window: { readonly min: Vec2; readonly max: Vec2 };
  readonly prims: Primitive[];
}

/** The category circuits, feeders and switch legs show, hide and halftone by in Visibility/Graphics (the class `mep.service_link`). */
export const CIRCUIT_GRAPHICS_CATEGORY = "mep.service_link";

/** Draw a plan's connection graphics (lines, arrows, tags, numbers) onto paper, as the view's circuit category shows them. */
export function drawCircuitGraphics(ctx: CircuitDrawContext, model: ModelState, view: ViewElement, shown: ReadonlyMap<string, PartInstance>): PaperGraphic[] {
  const look = categoryLook(view, CIRCUIT_GRAPHICS_CATEGORY);
  if (!look.visible) return [];
  const from = ctx.prims.length;
  const laid = drawCircuitGraphicsInk(ctx, model, view, shown);
  if (look.halftone === true) {
    for (let i = from; i < ctx.prims.length; i++) {
      const prim = ctx.prims[i];
      if (prim && (prim.kind === "line" || prim.kind === "text")) ctx.prims[i] = { ...prim, tone: "halftone" };
    }
  }
  return laid;
}

/**
 * Circuit lines, home runs and switch legs on plans, through the kernel's view
 * graphics point. The kernel shows, hides and halftones them by the row's
 * category (as `drawCircuitGraphics` does) and draws them after the view's
 * parts and typicals' copies; the view keeps its settings under `circuitGraphics`.
 */
export const CIRCUIT_GRAPHICS_ROW: ViewGraphicsRow = {
  id: "circuit_lines",
  label: "Circuit lines",
  hintsKey: "circuitGraphics",
  category: CIRCUIT_GRAPHICS_CATEGORY,
  order: 100,
  draw: (ctx) => {
    drawCircuitGraphicsInk(ctx, ctx.model, ctx.view, ctx.shown);
  },
  hintsSchema: circuitGraphicsSchema,
  hintsRefusal: circuitGraphicsRefusal,
};

function drawCircuitGraphicsInk(ctx: CircuitDrawContext, model: ModelState, view: ViewElement, shown: ReadonlyMap<string, PartInstance>): PaperGraphic[] {
  const laid = layoutCircuitGraphics(deriveCircuitGraphics(model, view, shown, ctx.scale), ctx.toPaper);
  const marks = resolveCircuitGraphics(view).hashMarks;
  const { min, max } = ctx.window;
  const fits = (p: Vec2, w: number, anchor: TextAnchor) => {
    const b = textBox(p, w, LABEL_MM, anchor);
    return b.min.x >= min.x && b.max.x <= max.x && p.y - LABEL_MM >= min.y && p.y <= max.y;
  };
  // Text already on the plan (part marks such as the panel's "P1", tags): home-run labels keep clear of it.
  const taken: Box[] = [];
  for (const prim of ctx.prims) if (prim.kind === "text") taken.push(textBox(prim.at, prim.text.length * prim.size * 0.6, prim.size, prim.anchor));
  for (const { source, lines } of laid) {
    const pen = source.kind === "switch_leg" ? "thin" : "medium";
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const c = clipSegment(line[i]!, line[i + 1]!, min, max);
        if (c) ctx.prims.push({ kind: "line", a: c[0], b: c[1], pen, ...(source.dashed ? { dash: SWITCH_LEG_DASH } : {}) });
      }
    }
    if (source.homeRun) {
      const from = ctx.toPaper(source.homeRun.from);
      const tip = ctx.toPaper(source.homeRun.tip);
      const l = dist(from, tip);
      if (l > 1e-6 && tip.x >= min.x && tip.x <= max.x && tip.y >= min.y && tip.y <= max.y) {
        const u = { x: (tip.x - from.x) / l, y: (tip.y - from.y) / l };
        const n = { x: -u.y, y: u.x };
        const back = { x: tip.x - u.x * ARROW_HEAD_MM, y: tip.y - u.y * ARROW_HEAD_MM };
        ctx.prims.push({ kind: "line", a: tip, b: { x: back.x + n.x * ARROW_HEAD_MM * 0.4, y: back.y + n.y * ARROW_HEAD_MM * 0.4 }, pen: "medium" });
        ctx.prims.push({ kind: "line", a: tip, b: { x: back.x - n.x * ARROW_HEAD_MM * 0.4, y: back.y - n.y * ARROW_HEAD_MM * 0.4 }, pen: "medium" });
        for (const [a, b] of hashMarkLines(from, tip, circuitConductorMarks(model, source.linkId, marks))) ctx.prims.push({ kind: "line", a, b, pen: "thin" });
        const text = source.homeRun.label;
        const w = text.length * LABEL_MM * 0.6;
        const label = homeRunLabel(from, tip, u, n, w).find((c) => fits(c.at, w, c.anchor) && !taken.some((t) => boxesMeet(t, textBox(c.at, w, LABEL_MM, c.anchor))));
        const fallback = homeRunLabel(from, tip, u, n, w)[0]!;
        const place = text === "" ? null : (label ?? (fits(fallback.at, w, fallback.anchor) ? fallback : null));
        if (place) {
          ctx.prims.push({ kind: "text", at: place.at, text, size: LABEL_MM, anchor: place.anchor });
          taken.push(textBox(place.at, w, LABEL_MM, place.anchor));
        }
      }
    }
    for (const n of source.numbers) {
      const at = ctx.toPaper(n.at);
      const w = n.text.length * NUMBER_MM * 0.6;
      if (fits(at, w, "start")) {
        ctx.prims.push({ kind: "text", at, text: n.text, size: NUMBER_MM, anchor: "start" });
        taken.push(textBox(at, w, NUMBER_MM, "start"));
      }
    }
  }
  return laid;
}
