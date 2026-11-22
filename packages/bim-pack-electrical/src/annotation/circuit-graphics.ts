import {
  clipSegment,
  copyPoint,
  copyText,
  organizationOf,
  partPlanOutline,
  partToWorld,
  pushTo,
  resolveConnectors,
  resolveTextStyle,
  serviceLinkName,
  type DetailLevel,
  type GroupEntry,
  type ModelState,
  type PartInstance,
  type PlanOutline,
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
import {
  HASH_MARK_LOCATIONS,
  HASH_MARK_STYLES,
  circuitGraphicsRefusal,
  circuitGraphicsSchema,
  type CircuitGraphicHint,
  type CircuitGraphicStyle,
  type CircuitGraphicsProps,
  type HashMarkLocation,
  type HashMarkStyle,
  type HomeRunHint,
} from "./circuit-graphics-settings";

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
  readonly showCircuits: boolean;
  readonly homeRuns: boolean;
  readonly switchLegs: boolean;
  readonly switchLegLabels: boolean;
  readonly allCopies: boolean;
  readonly hashMarks: CircuitHashMarkStyle;
  readonly hashMarksOn: HashMarkLocation;
  readonly hints: Readonly<Record<string, CircuitGraphicHint>>;
  /** With copies drawn: a repeated home run is labelled once, "(3) TYP.", on the original. */
  readonly typLabelsOnce: boolean;
}

const isHashMarkStyle = (v: unknown): v is CircuitHashMarkStyle => typeof v === "string" && (CIRCUIT_HASH_MARK_STYLES as readonly string[]).includes(v);
const isHashMarkLocation = (v: unknown): v is HashMarkLocation => typeof v === "string" && (HASH_MARK_LOCATIONS as readonly string[]).includes(v);

/** The view's settings with defaults: arcs on electrical plans, nothing on other plans and views; no hash marks. */
export function resolveCircuitGraphics(view: ViewElement): ResolvedCircuitGraphics {
  const p: CircuitGraphicsProps = view.props?.circuitGraphics ?? {};
  const plan = view.viewType === "floor_plan" || view.viewType === "ceiling_plan";
  const style: CircuitGraphicStyle = !plan ? "off" : (p.style ?? (view.props?.discipline === "electrical" ? "arcs" : "off"));
  // Read tolerantly: a record without it (or with a word a newer build wrote) reads as off.
  const marks: unknown = p.hashMarks;
  const marksOn: unknown = p.hashMarksOn;
  return {
    style,
    showCircuits: p.showCircuits ?? true,
    homeRuns: p.homeRuns ?? true,
    switchLegs: p.switchLegs ?? true,
    switchLegLabels: p.switchLegLabels ?? true,
    allCopies: p.allCopies ?? false,
    hashMarks: isHashMarkStyle(marks) ? marks : "off",
    hashMarksOn: isHashMarkLocation(marksOn) ? marksOn : "home_runs",
    hints: p.hints ?? {},
    typLabelsOnce: p.typLabelsOnce !== false,
  };
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

/** Conductor hash marks for a dashed switch leg or low-voltage control run. */
export function switchLegConductorMarks(lowVolt: boolean, multiController: boolean, style: CircuitHashMarkStyle): ReadonlyArray<"hot" | "neutral" | "ground"> {
  if (style === "off") return [];
  if (lowVolt) return ["hot", "hot"];
  const hots = multiController ? 3 : 2;
  return [...Array.from({ length: hots }, () => "hot" as const), "neutral", ...(style === "hots_neutral_ground" ? ["ground" as const] : [])];
}

/** Paper mm: ANSI/NECA 100 slanted conductor hash marks across a wire or home run. */
const HASH_LONG_MM = 2.2;
const HASH_SHORT_MM = 1.3;
const HASH_PITCH_MM = 0.85;
const HASH_FOOT_MM = 0.75;
/** Slant factor along wire direction (~60 deg standard NECA 100 conductor slash). */
const HASH_SLANT = 0.36;

/** Evaluate position + unit tangent at fractional arc length `frac` (0..1) along a polyline. */
function samplePolylineAt(pts: readonly Vec2[], frac: number): { readonly at: Vec2; readonly u: Vec2 } | null {
  if (pts.length < 2) return null;
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) total += dist(pts[i]!, pts[i + 1]!);
  if (total < 1e-6) return null;
  const target = total * Math.max(0, Math.min(1, frac));
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const seg = dist(a, b);
    if (seg < 1e-6) continue;
    if (acc + seg >= target || i === pts.length - 2) {
      const t = Math.max(0, Math.min(1, (target - acc) / seg));
      return { at: lerp(a, b, t), u: { x: (b.x - a.x) / seg, y: (b.y - a.y) / seg } };
    }
    acc += seg;
  }
  return null;
}

/** Slanted ANSI/NECA 100 hash marks across a wire polyline at `frac` along its length (paper mm). */
function hashMarkLinesAlongPath(pts: readonly Vec2[], marks: ReadonlyArray<"hot" | "neutral" | "ground">, frac = 0.44): Array<readonly [Vec2, Vec2]> {
  if (marks.length === 0) return [];
  const sample = samplePolylineAt(pts, frac);
  if (!sample) return [];
  const { at: centre, u } = sample;
  const n = { x: -u.y, y: u.x };
  const out: Array<readonly [Vec2, Vec2]> = [];
  marks.forEach((m, i) => {
    const along = (i - (marks.length - 1) / 2) * HASH_PITCH_MM;
    const c = { x: centre.x + u.x * along, y: centre.y + u.y * along };
    const half = (m === "neutral" ? HASH_SHORT_MM : HASH_LONG_MM) / 2;
    const sx = n.x * half + u.x * half * HASH_SLANT;
    const sy = n.y * half + u.y * half * HASH_SLANT;
    const a = { x: c.x - sx, y: c.y - sy };
    const b = { x: c.x + sx, y: c.y + sy };
    out.push([a, b]);
    if (m === "ground") out.push([b, { x: b.x + u.x * HASH_FOOT_MM, y: b.y + u.y * HASH_FOOT_MM }]);
  });
  return out;
}

/** The key a pinned bend or waypoint list is stored under: the two devices' ids, sorted. */
export function bendKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function cleanHint(hint: CircuitGraphicHint): CircuitGraphicHint | null {
  const bends = hint.bends && Object.keys(hint.bends).length > 0 ? hint.bends : undefined;
  const waypoints = hint.waypoints && Object.keys(hint.waypoints).length > 0 ? hint.waypoints : undefined;
  const flipArc = hint.flipArc && Object.keys(hint.flipArc).length > 0 ? hint.flipArc : undefined;
  const homeRun =
    hint.homeRun &&
    (hint.homeRun.memberId !== undefined ||
      hint.homeRun.tipOffset !== undefined ||
      hint.homeRun.bendOffset !== undefined ||
      hint.homeRun.labelOffset !== undefined)
      ? hint.homeRun
      : undefined;
  const memberLabelOffsets = hint.memberLabelOffsets && Object.keys(hint.memberLabelOffsets).length > 0 ? hint.memberLabelOffsets : undefined;
  const mwbcGroup = hint.mwbcGroup && hint.mwbcGroup.trim() !== "" ? hint.mwbcGroup.trim() : undefined;
  if (!bends && !waypoints && !flipArc && !homeRun && !memberLabelOffsets && !mwbcGroup && hint.priority === undefined) return null;
  return {
    ...(bends ? { bends } : {}),
    ...(waypoints ? { waypoints } : {}),
    ...(flipArc ? { flipArc } : {}),
    ...(homeRun ? { homeRun } : {}),
    ...(memberLabelOffsets ? { memberLabelOffsets } : {}),
    ...(mwbcGroup ? { mwbcGroup } : {}),
    ...(hint.priority !== undefined ? { priority: hint.priority } : {}),
  };
}

/** The view's circuit settings with one bend pinned (or cleared with null): what `set_view_properties` takes as `circuitGraphics`. */
export function withCircuitBend(view: ViewElement, linkId: string, a: string, b: string, point: Vec2 | null): CircuitGraphicsProps {
  const props = view.props?.circuitGraphics ?? {};
  const hint = props.hints?.[linkId] ?? {};
  const key = bendKey(a, b);
  const bends = { ...(hint.bends ?? {}) };
  const waypoints = { ...(hint.waypoints ?? {}) };
  delete waypoints[key];
  if (point) bends[key] = { x: Math.round(point.x), y: Math.round(point.y) };
  else delete bends[key];
  const nextHints = { ...(props.hints ?? {}) };
  const cleaned = cleanHint({ ...hint, bends, waypoints });
  if (cleaned) nextHints[linkId] = cleaned;
  else delete nextHints[linkId];
  return { ...props, hints: nextHints };
}

/**
 * Set multi-vertex spline/orthogonal waypoints on one wire span (circuit link or `"switch:<leg>"`).
 * `waypoints` is stored in canonical `a < b` order (when `a > b`, points are reversed so endpoints stay aligned).
 * Pass `null` or `[]` to clear back to automatic routing.
 */
export function withCircuitWaypoints(view: ViewElement, hintKey: string, a: string, b: string, points: readonly Vec2[] | null): CircuitGraphicsProps {
  const props = view.props?.circuitGraphics ?? {};
  const hint = props.hints?.[hintKey] ?? {};
  const key = bendKey(a, b);
  const bends = { ...(hint.bends ?? {}) };
  delete bends[key];
  const waypoints = { ...(hint.waypoints ?? {}) };
  if (points && points.length > 0) {
    const ordered = a < b ? points : [...points].reverse();
    waypoints[key] = ordered.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) }));
  } else {
    delete waypoints[key];
  }
  const nextHints = { ...(props.hints ?? {}) };
  const cleaned = cleanHint({ ...hint, bends, waypoints });
  if (cleaned) nextHints[hintKey] = cleaned;
  else delete nextHints[hintKey];
  return { ...props, hints: nextHints };
}

/** Flip (or set) the automatic arc bulge direction on one wire span. */
export function withCircuitFlipArc(view: ViewElement, hintKey: string, a: string, b: string, flipped?: boolean): CircuitGraphicsProps {
  const props = view.props?.circuitGraphics ?? {};
  const hint = props.hints?.[hintKey] ?? {};
  const key = bendKey(a, b);
  const bends = { ...(hint.bends ?? {}) };
  const waypoints = { ...(hint.waypoints ?? {}) };
  delete bends[key];
  delete waypoints[key];
  const flipArc = { ...(hint.flipArc ?? {}) };
  const next = flipped ?? !flipArc[key];
  if (next) flipArc[key] = true;
  else delete flipArc[key];
  const nextHints = { ...(props.hints ?? {}) };
  const cleaned = cleanHint({ ...hint, bends, waypoints, flipArc });
  if (cleaned) nextHints[hintKey] = cleaned;
  else delete nextHints[hintKey];
  return { ...props, hints: nextHints };
}

/** Set or clear movable home-run overrides (host member, arrow tip offset, shaft curve offset, label offset) for one circuit. */
export function withCircuitHomeRun(view: ViewElement, linkId: string, homeRun: HomeRunHint | null): CircuitGraphicsProps {
  const props = view.props?.circuitGraphics ?? {};
  const hint = props.hints?.[linkId] ?? {};
  const roundPt = (pt: Vec2 | undefined) => (pt ? { x: Math.round(pt.x), y: Math.round(pt.y) } : undefined);
  const nextHr: HomeRunHint | undefined = homeRun
    ? {
        ...(homeRun.memberId !== undefined ? { memberId: homeRun.memberId } : {}),
        ...(homeRun.tipOffset !== undefined ? { tipOffset: roundPt(homeRun.tipOffset) } : {}),
        ...(homeRun.bendOffset !== undefined ? { bendOffset: roundPt(homeRun.bendOffset) } : {}),
        ...(homeRun.labelOffset !== undefined ? { labelOffset: roundPt(homeRun.labelOffset) } : {}),
      }
    : undefined;
  const nextHints = { ...(props.hints ?? {}) };
  const cleaned = cleanHint({ ...hint, homeRun: nextHr });
  if (cleaned) nextHints[linkId] = cleaned;
  else delete nextHints[linkId];
  return { ...props, hints: nextHints };
}

/** Reposition (or reset with null) one switch-leg designation ("a", "b") relative to its member anchor in model mm. */
export function withSwitchLegLabelOffset(view: ViewElement, hintKey: string, memberId: string, offsetModel: Vec2 | null): CircuitGraphicsProps {
  const props = view.props?.circuitGraphics ?? {};
  const hint = props.hints?.[hintKey] ?? {};
  const memberLabelOffsets = { ...(hint.memberLabelOffsets ?? {}) };
  if (offsetModel) memberLabelOffsets[memberId] = { x: Math.round(offsetModel.x), y: Math.round(offsetModel.y) };
  else delete memberLabelOffsets[memberId];
  const nextHints = { ...(props.hints ?? {}) };
  const cleaned = cleanHint({ ...hint, memberLabelOffsets });
  if (cleaned) nextHints[hintKey] = cleaned;
  else delete nextHints[hintKey];
  return { ...props, hints: nextHints };
}

/** Group (or ungroup with null) branch circuits into a shared-neutral Multi-Wire Branch Circuit (MWBC, NEC 210.4) combined home run. */
export function withCircuitMwbcGroup(view: ViewElement, linkIds: readonly string[], groupName: string | null): CircuitGraphicsProps {
  const props = view.props?.circuitGraphics ?? {};
  const nextHints = { ...(props.hints ?? {}) };
  const trimmed = groupName?.trim() || undefined;
  for (const id of linkIds) {
    const hint = nextHints[id] ?? {};
    const cleaned = cleanHint({ ...hint, mwbcGroup: trimmed });
    if (cleaned) nextHints[id] = cleaned;
    else delete nextHints[id];
  }
  return { ...props, hints: nextHints };
}

/** One drawn connection, in model mm. */
export interface CircuitGraphic {
  /** Link id (and `@copy` for a typical's copy), or `switch:<leg>`. */
  readonly key: string;
  readonly linkId: string | null;
  readonly kind: "circuit" | "switch_leg";
  readonly priority: number;
  readonly dashed: boolean;
  /** Optional explicit dash pattern (paper mm), e.g. dash-dot for 0-10V / low-voltage control wiring. */
  readonly dashPattern?: readonly number[];
  /** True when a switch leg carries low-voltage control wiring (0-10V / DALI / low_voltage). */
  readonly lowVoltage?: boolean;
  /** True when a switch leg has 2+ controllers (3-way/4-way travelers). */
  readonly multiController?: boolean;
  /** Joining lines, member to member, in drawing order. */
  readonly paths: readonly (readonly Vec2[])[];
  /** Member pairs each path joins (same order as `paths`). */
  readonly joins: readonly (readonly [string, string])[];
  readonly homeRun: {
    readonly memberId: string;
    readonly from: Vec2;
    readonly tip: Vec2;
    /** Curved home-run shaft polyline in model mm (omitted when straight `[from, tip]`). */
    readonly path?: readonly Vec2[];
    readonly label: string;
    /** Explicit model-mm label position when repositioned by the user or script. */
    readonly labelAt?: Vec2;
    /** Stacked arrowheads on a combined Multi-Wire Branch Circuit (MWBC) home run (absent / 1 for single circuit). */
    readonly arrows?: number;
    /** Total hot conductors on a combined MWBC home run (absent for single-link circuits). */
    readonly mwbcHots?: number;
  } | null;
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
const CONTROL_LEG_DASH: readonly number[] = [2.2, 0.8, 0.45, 0.8];
/** Paper mm between two square runs that would otherwise sit on each other; runs closer than half this count as stacked. */
const SQUARE_RUN_OFFSET_MM = 1.5;
/** How many offsets either side a square run may step before it accepts some overlap. */
const SQUARE_OFFSETS = 3;
/** Paper mm grid the drawn-runs index buckets on. */
const RUN_CELL_MM = 20;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

type Outline = PlanOutline;

/** A placed part's rendered plan boundary in world mm (symbol, schema-2 detail symbol, class symbol, or 3D body footprint). */
function symbolOutline(model: ModelState, part: PartInstance, scale: number, detail: DetailLevel = "medium", symbolScale = 1): { readonly outline: Outline[]; readonly bounds: { readonly min: Vec2; readonly max: Vec2 } | null } {
  return partPlanOutline(model, part, { detail, scale, symbolScale });
}

/** First/last crossing parameter t in (0, 1] of segment `from -> to` against `outline`, or null when it doesn't cross. Zero-allocation hot path. */
function lastCrossT(outline: readonly Outline[], from: Vec2, to: Vec2): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let best = -1;
  for (let i = 0; i < outline.length; i++) {
    const o = outline[i]!;
    if (o.kind === "seg") {
      const ex = o.b.x - o.a.x;
      const ey = o.b.y - o.a.y;
      const den = dx * ey - dy * ex;
      if (den > -1e-12 && den < 1e-12) continue;
      const wx = o.a.x - from.x;
      const wy = o.a.y - from.y;
      const t = (wx * ey - wy * ex) / den;
      if (t <= best || t <= 1e-6 || t > 1) continue;
      const u = (wx * dy - wy * dx) / den;
      if (u >= -1e-9 && u <= 1 + 1e-9) best = t;
    } else {
      const fx = from.x - o.c.x;
      const fy = from.y - o.c.y;
      const a = dx * dx + dy * dy;
      if (a < 1e-12) continue;
      const b = 2 * (fx * dx + fy * dy);
      const c = fx * fx + fy * fy - o.r * o.r;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const root = Math.sqrt(disc);
      const inv2a = 1 / (2 * a);
      const t1 = (-b - root) * inv2a;
      if (t1 > best && t1 > 1e-6 && t1 <= 1) best = t1;
      const t2 = (-b + root) * inv2a;
      if (t2 > best && t2 > 1e-6 && t2 <= 1) best = t2;
    }
  }
  return best > 0 ? best : null;
}

/** Trim both ends of a polyline (curved arc or straight run) against its start and end symbol outlines without intermediate copies. */
function trimPolylineEnds(pts: readonly Vec2[], startOutline: readonly Outline[], endOutline: readonly Outline[]): Vec2[] {
  const n = pts.length;
  if (n < 2) return [...pts];
  // Start trim: last crossing going forward from pts[0] toward pts[n - 1].
  let startIdx = 0;
  let startPt: Vec2 | null = null;
  if (startOutline.length > 0) {
    let bestSeg = -1;
    let bestT = 0;
    for (let i = 0; i + 1 < n; i++) {
      const t = lastCrossT(startOutline, pts[i]!, pts[i + 1]!);
      if (t !== null) {
        bestSeg = i;
        bestT = t;
      }
    }
    if (bestSeg >= 0) {
      const exit = lerp(pts[bestSeg]!, pts[bestSeg + 1]!, bestT);
      if (dist(exit, pts[bestSeg + 1]!) < 0.5) {
        startIdx = bestSeg + 1;
      } else {
        startIdx = bestSeg + 1;
        startPt = exit;
      }
    }
  }
  // End trim: last crossing going backward over ONLY the start-trimmed path (including startPt).
  let endIdx = n - 1;
  let endPt: Vec2 | null = null;
  if (endOutline.length > 0) {
    let bestSeg = -1;
    let bestT = 0;
    let bestFrom: Vec2 | null = null;
    let bestTo: Vec2 | null = null;
    for (let i = n - 1; i > startIdx; i--) {
      const t = lastCrossT(endOutline, pts[i]!, pts[i - 1]!);
      if (t !== null) {
        bestSeg = i;
        bestT = t;
        bestFrom = pts[i]!;
        bestTo = pts[i - 1]!;
      }
    }
    if (startPt && startIdx < n) {
      const t = lastCrossT(endOutline, pts[startIdx]!, startPt);
      if (t !== null) {
        bestSeg = startIdx;
        bestT = t;
        bestFrom = pts[startIdx]!;
        bestTo = startPt;
      }
    }
    if (bestSeg >= 0 && bestFrom && bestTo) {
      const exit = lerp(bestFrom, bestTo, bestT);
      if (bestSeg === startIdx && startPt) {
        // Crossing happened on the final [startPt, pts[startIdx]] segment.
        return dist(startPt, exit) >= 0.5 ? [startPt, exit] : [...pts];
      }
      if (dist(exit, bestTo) < 0.5) {
        endIdx = bestSeg - 1;
      } else {
        endIdx = bestSeg - 1;
        endPt = exit;
      }
    }
  }
  const out: Vec2[] = [];
  if (startPt) out.push(startPt);
  for (let i = startIdx; i <= endIdx; i++) out.push(pts[i]!);
  if (endPt) out.push(endPt);
  return out.length >= 2 ? out : [...pts];
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

/** Sample a cubic Bezier segment `p0 -> p1 -> p2 -> p3` excluding `p0` (so chained segments don't duplicate vertices). */
function cubicPoints(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, pieces: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i <= pieces; i++) {
    const t = i / pieces;
    const u = 1 - t;
    out.push(
      i === pieces
        ? p3
        : {
            x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
            y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
          },
    );
  }
  return out;
}

/**
 * Bounded C1 smooth curve passing strictly through `a -> m -> b` without the >180°
 * major-arc circumcircle blow-up that happens when `m` sits past `a` or `b` (or when
 * one endpoint moves close to the other while a bend stays behind).
 */
function smoothThroughThree(a: Vec2, m: Vec2, b: Vec2, halfPieces = 10): Vec2[] {
  const d1 = dist(a, m);
  const d2 = dist(m, b);
  if (d1 < 1e-3 || d2 < 1e-3) return [a, b];
  const u1 = { x: (m.x - a.x) / d1, y: (m.y - a.y) / d1 };
  const u2 = { x: (b.x - m.x) / d2, y: (b.y - m.y) / d2 };
  let tx = u1.x + u2.x;
  let ty = u1.y + u2.y;
  const tl = Math.hypot(tx, ty);
  let tm: Vec2;
  if (tl > 1e-3) {
    tm = { x: tx / tl, y: ty / tl };
  } else {
    // Tight hairpin U-turn: orient tangent perpendicular to `a -> m` toward `b` so the loop turns smoothly around `m`.
    const perp = { x: -u1.y, y: u1.x };
    const sign = (b.x - a.x) * perp.x + (b.y - a.y) * perp.y >= 0 ? 1 : -1;
    tm = { x: perp.x * sign, y: perp.y * sign };
  }
  const handle = Math.min(d1, d2) * 0.35;
  const p1 = lerp(a, m, 0.35);
  const p2 = { x: m.x - tm.x * handle, y: m.y - tm.y * handle };
  const q1 = { x: m.x + tm.x * handle, y: m.y + tm.y * handle };
  const q2 = lerp(b, m, 0.35);
  return [a, ...cubicPoints(a, p1, p2, m, halfPieces), ...cubicPoints(m, q1, q2, b, halfPieces)];
}

/**
 * Points along the circular arc through `a, m, b` from `a` to `b` when the sweep is gentle
 * (≤ 135°), falling back to a bounded C1 curve through `a -> m -> b` whenever `m` sits outside
 * the shallow-arc zone so dragged wires and moved devices never explode into a 300°+ loop.
 */
function arcThrough(a: Vec2, m: Vec2, b: Vec2): Vec2[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-9 * Math.max(1, dist(a, b) ** 2)) {
    // Collinear: if m lies past a or b, still pass through m smoothly instead of jumping past it.
    const ab = dist(a, b);
    if (dist(a, m) + dist(m, b) > ab + 1) return smoothThroughThree(a, m, b);
    return [a, b];
  }
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
  // Guard against >135° major arcs (when m is pulled past an endpoint or devices move close together).
  if (Math.abs(sweep) > (3 * Math.PI) / 4) return smoothThroughThree(a, m, b);
  const pieces = Math.max(ARC_PIECES, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const out: Vec2[] = [];
  for (let i = 0; i <= pieces; i++) {
    const t = a0 + (sweep * i) / pieces;
    out.push(i === 0 ? a : i === pieces ? b : { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return out;
}

/** Smooth paper-space preview polyline for an interactive wire or curved home-run drag (matches committed geometry). */
export function previewWireCurve(start: Vec2, waypoints: readonly Vec2[], end: Vec2): Vec2[] {
  if (waypoints.length === 0) return [start, end];
  if (waypoints.length === 1) return arcThrough(start, waypoints[0]!, end);
  return splineThrough([start, ...waypoints, end]);
}

/** Centripetal Catmull-Rom smooth spline passing through every control point in `pts`. */
function splineThrough(pts: readonly Vec2[], segPieces = 10): Vec2[] {
  if (pts.length <= 2) return [...pts];
  if (pts.length === 3) return arcThrough(pts[0]!, pts[1]!, pts[2]!);
  const out: Vec2[] = [pts[0]!];
  const n = pts.length;
  const knot = (a: Vec2, b: Vec2) => Math.max(1e-3, Math.sqrt(dist(a, b)));
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(n - 1, i + 2)]!;
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const mix = (u: Vec2, v: Vec2, w: number): Vec2 => ({ x: u.x + (v.x - u.x) * w, y: u.y + (v.y - u.y) * w });
    for (let s = 1; s <= segPieces; s++) {
      const t = t1 + ((t2 - t1) * s) / segPieces;
      const a1 = i === 0 ? mix(p1, p2, (t - t1) / (t2 - t1)) : mix(p0, p1, (t - t0) / (t1 - t0));
      const a2 = mix(p1, p2, (t - t1) / (t2 - t1));
      const a3 = i === n - 2 ? mix(p1, p2, (t - t1) / (t2 - t1)) : mix(p2, p3, (t - t2) / (t3 - t2));
      const b1 = t2 - t0 > 1e-6 ? mix(a1, a2, (t - t0) / (t2 - t0)) : a2;
      const b2 = t3 - t1 > 1e-6 ? mix(a2, a3, (t - t1) / (t3 - t1)) : a2;
      out.push(s === segPieces ? p2 : mix(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  return out;
}

/** Resolve ordered waypoints for span `a -> b` from a hint (checking `waypoints` first, then legacy single `bends`). */
function spanWaypoints(hint: CircuitGraphicHint | undefined, aId: string, bId: string): readonly Vec2[] | undefined {
  const key = bendKey(aId, bId);
  const wps = hint?.waypoints?.[key];
  if (wps && wps.length > 0) return aId < bId ? wps : [...wps].reverse();
  const bend = hint?.bends?.[key];
  return bend ? [bend] : undefined;
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
function squareJoin(a: Node, b: Node, waypoints: readonly Vec2[] | undefined, drawn: DrawnRuns, step: number): Vec2[] {
  if (waypoints && waypoints.length === 1) {
    const bend = waypoints[0]!;
    return squarePath(a, b, [{ x: bend.x, y: a.point.y }, { x: bend.x, y: b.point.y }]);
  }
  if (waypoints && waypoints.length > 1) {
    const corners: Vec2[] = [];
    let prev = a.point;
    for (const wp of waypoints) {
      if (Math.abs(wp.x - prev.x) > 1 && Math.abs(wp.y - prev.y) > 1) corners.push({ x: wp.x, y: prev.y });
      corners.push(wp);
      prev = wp;
    }
    if (Math.abs(b.point.x - prev.x) > 1 && Math.abs(b.point.y - prev.y) > 1) corners.push({ x: prev.x, y: b.point.y });
    return squarePath(a, b, corners);
  }
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

/** The joining line between two members in the view's style, trimmed cleanly at each symbol's rendered boundary. */
function joinPath(style: CircuitGraphicStyle, a: Node, b: Node, waypoints: readonly Vec2[] | undefined, flip: boolean, drawn: DrawnRuns, step: number): Vec2[] {
  if (style === "orthogonal") return squareJoin(a, b, waypoints, drawn, step);
  if (waypoints && waypoints.length === 1) return trimPolylineEnds(arcThrough(a.point, waypoints[0]!, b.point), a.outline, b.outline);
  if (waypoints && waypoints.length > 1) return trimPolylineEnds(splineThrough([a.point, ...waypoints, b.point]), a.outline, b.outline);
  const pa = exitPoint(a.outline, a.point, b.point);
  const pb = exitPoint(b.outline, b.point, a.point);
  const chord = dist(a.point, b.point);
  if (chord < 1) return [pa, pb];
  const visibleSpan = dist(pa, pb);
  let nx = -(b.point.y - a.point.y) / chord;
  let ny = (b.point.x - a.point.x) / chord;
  // When devices are mounted on a wall face (local +Y points into the room), bow the arc
  // toward the room side so wiring never loops backward into the wall thickness or outside a corner.
  let roomX = 0;
  let roomY = 0;
  for (const node of [a, b]) {
    if (node.part.host?.kind !== "wall_face") continue;
    const rad = (node.part.rotationDeg * Math.PI) / 180;
    roomX += -Math.sin(rad);
    roomY += Math.cos(rad);
  }
  if (roomX * nx + roomY * ny < -1e-6) {
    nx = -nx;
    ny = -ny;
  }
  if (flip) {
    nx = -nx;
    ny = -ny;
  }
  const mid = lerp(a.point, b.point, 0.5);
  const fullArc = arcThrough(a.point, { x: mid.x + nx * visibleSpan * ARC_SAG, y: mid.y + ny * visibleSpan * ARC_SAG }, b.point);
  return trimPolylineEnds(fullArc, a.outline, b.outline);
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

/**
 * For wall-mounted paper symbols whose insertion point `(0, 0)` sits on the
 * wall finish face while the symbol body sits out in the room (`+Y`), wire arcs
 * and home runs should radiate from the symbol's circle / body center rather
 * than the wall-face prong tip so trimmed wires stop cleanly at the symbol rim.
 */
function wireAnchorPoint(base: Vec2, part: PartInstance, outline: readonly Outline[], bounds: { readonly min: Vec2; readonly max: Vec2 } | null): Vec2 {
  let circleCount = 0;
  let allOutside = true;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < outline.length; i++) {
    const o = outline[i]!;
    if (o.kind !== "circle") continue;
    circleCount++;
    const dx = base.x - o.c.x;
    const dy = base.y - o.c.y;
    const lim = o.r + 1e-3;
    if (dx * dx + dy * dy <= lim * lim) {
      allOutside = false;
      break;
    }
    sx += o.c.x;
    sy += o.c.y;
  }
  if (circleCount > 0 && allOutside) {
    return { x: sx / circleCount, y: sy / circleCount };
  }
  if (part.host?.kind === "wall_face" && bounds) {
    const cx = (bounds.min.x + bounds.max.x) * 0.5;
    const cy = (bounds.min.y + bounds.max.y) * 0.5;
    if (
      base.x < bounds.min.x - 1e-3 ||
      base.x > bounds.max.x + 1e-3 ||
      base.y < bounds.min.y - 1e-3 ||
      base.y > bounds.max.y + 1e-3 ||
      (cx - base.x) * (cx - base.x) + (cy - base.y) * (cy - base.y) > 1
    ) {
      return { x: cx, y: cy };
    }
  }
  return base;
}

function nodeOf(model: ModelState, part: PartInstance, connector: string, scale: number, detail: DetailLevel = "medium", symbolScale = 1): Node {
  const base = connectionPoint(model, part, connector);
  const { outline, bounds } = symbolOutline(model, part, scale, detail, symbolScale);
  return { id: part.id, part, point: wireAnchorPoint(base, part, outline, bounds), outline };
}

/** The circuit drawing for one link in model mm, or null when none of its members is shown. */
function linkGraphic(model: ModelState, link: ServiceLink, shown: ReadonlyMap<string, PartInstance>, settings: ResolvedCircuitGraphics, scale: number, typ: boolean, drawn: DrawnRuns, detail: DetailLevel = "medium", symbolScale = 1): CircuitGraphic | null {
  const nodes: Node[] = [];
  for (const m of link.members) {
    const part = shown.get(m.elementId);
    if (part) nodes.push(nodeOf(model, part, m.connector, scale, detail, symbolScale));
  }
  if (nodes.length === 0) return null;
  const hint = settings.hints[link.id];
  const hrHint = hint?.homeRun;
  const source = model.elements[link.source.elementId];
  const sourceAt = source?.kind === "part" ? source.position : null;
  let home = (hrHint?.memberId ? nodes.find((n) => n.id === hrHint.memberId) : undefined) ?? nodes[0]!;
  if (!hrHint?.memberId && sourceAt) {
    for (const n of nodes) if (dist(n.part.position, sourceAt) < dist(home.part.position, sourceAt)) home = n;
  }
  const paths: Vec2[][] = [];
  const joins: Array<[string, string]> = [];
  const name = serviceLinkName(model.elements, link);
  let homeRun: CircuitGraphic["homeRun"] = null;
  if (settings.homeRuns) {
    let tip: Vec2;
    let hrPath: Vec2[];
    let from: Vec2;
    if (hrHint?.tipOffset && dist({ x: 0, y: 0 }, hrHint.tipOffset) > 1) {
      tip = { x: home.point.x + hrHint.tipOffset.x, y: home.point.y + hrHint.tipOffset.y };
      if (hrHint.bendOffset) {
        const bend = { x: home.point.x + hrHint.bendOffset.x, y: home.point.y + hrHint.bendOffset.y };
        hrPath = trimPolylineEnds(arcThrough(home.point, bend, tip), home.outline, []);
        from = hrPath[0] ?? home.point;
      } else {
        from = exitPoint(home.outline, home.point, tip);
        hrPath = [from, tip];
      }
    } else {
      const toward = sourceAt && dist(sourceAt, home.point) > 1 ? sourceAt : { x: home.point.x + 1, y: home.point.y };
      const len = dist(home.point, toward);
      from = exitPoint(home.outline, home.point, { x: home.point.x + (toward.x - home.point.x) * 1e6, y: home.point.y + (toward.y - home.point.y) * 1e6 });
      tip = { x: from.x + ((toward.x - home.point.x) / len) * HOME_RUN_MM * scale, y: from.y + ((toward.y - home.point.y) / len) * HOME_RUN_MM * scale };
      if (hrHint?.bendOffset) {
        const bend = { x: home.point.x + hrHint.bendOffset.x, y: home.point.y + hrHint.bendOffset.y };
        hrPath = trimPolylineEnds(arcThrough(home.point, bend, tip), home.outline, []);
        from = hrPath[0] ?? from;
      } else {
        hrPath = [from, tip];
      }
    }
    const labelAt = hrHint?.labelOffset ? { x: tip.x + hrHint.labelOffset.x, y: tip.y + hrHint.labelOffset.y } : undefined;
    homeRun = {
      memberId: home.id,
      from,
      tip,
      ...(hrPath.length > 2 ? { path: hrPath } : {}),
      label: typ ? `${name} TYP.` : name,
      ...(labelAt ? { labelAt } : {}),
    };
    drawn.add(hrPath);
  }
  if (settings.style === "arcs" || settings.style === "orthogonal") {
    for (const [a, b] of joinPairs(settings.style, home, nodes.filter((n) => n !== home))) {
      const k = bendKey(a.id, b.id);
      const path = joinPath(settings.style, a, b, spanWaypoints(hint, a.id, b.id), hint?.flipArc?.[k] === true, drawn, SQUARE_RUN_OFFSET_MM * scale);
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

function isControlDevice(model: ModelState, part: PartInstance): boolean {
  const type = model.elements[part.typeId];
  return (
    type?.kind === "part_type" &&
    type.definition.category === "electrical_device" &&
    /(switch|dimmer|sensor|photocell|time clock|relay pack)/i.test(type.definition.familyName)
  );
}

function legOf(part: PartInstance): string {
  const v = part.values.switch_leg;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function controlProtocolOf(part: PartInstance): string {
  const v = part.values.control_type;
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function isLowVoltageControl(parts: readonly PartInstance[]): boolean {
  return parts.some((p) => {
    const proto = controlProtocolOf(p);
    return proto === "0-10v" || proto === "dali" || proto === "low_voltage";
  });
}

function switchLegLabelPoint(node: Node, scale: number, symbolScale: number, hasSubscript: boolean, offset?: Vec2): Vec2 {
  if (offset) return { x: node.point.x + offset.x, y: node.point.y + offset.y };
  // Compute full visual outline radius around `node.point` and clear subscripts like `$3`, `$4`, `$D` on switches (which sit at +1.55 mm right, -0.7 mm down).
  let maxX = node.point.x;
  let maxY = node.point.y;
  let minY = node.point.y;
  for (const o of node.outline) {
    if (o.kind === "circle") {
      maxX = Math.max(maxX, o.c.x + o.r);
      maxY = Math.max(maxY, o.c.y + o.r);
      minY = Math.min(minY, o.c.y - o.r);
    } else {
      maxX = Math.max(maxX, o.a.x, o.b.x);
      maxY = Math.max(maxY, o.a.y, o.b.y);
      minY = Math.min(minY, o.a.y, o.b.y);
    }
  }
  const s = scale * symbolScale;
  if (hasSubscript) {
    // Sit neatly to the upper-right of the switch symbol, well clear of lower-right subscript (`3`, `4`, `D`, `OS`).
    return { x: Math.max(maxX, node.point.x + 1.6 * s) + 1.15 * s, y: maxY + 0.5 * s };
  }
  const r = Math.max(maxX - node.point.x, (maxY - minY) / 2);
  return { x: node.point.x + r + 1.15 * s, y: node.point.y - (maxY - minY) * 0.15 };
}

function hasSymbolSubscript(model: ModelState, part: PartInstance): boolean {
  const type = model.elements[part.typeId];
  if (type?.kind !== "part_type") return false;
  return type.definition.symbol.some((p) => p.kind === "text" && p.uprightOffset !== undefined);
}

/**
 * Dashed switch legs and low-voltage control loops: grouped by `switch_leg` letter
 * so 3-way/4-way switch pairs and occupancy/daylight sensors share one traveler
 * chain to their controlled fixtures and controlled receptacles, with ANSI/NECA 100
 * lowercase switch-leg designations ("a", "b") beside each device.
 */
function switchLegs(model: ModelState, shown: ReadonlyMap<string, PartInstance>, settings: ResolvedCircuitGraphics, scale: number, drawn: DrawnRuns, detail: DetailLevel = "medium", symbolScale = 1): CircuitGraphic[] {
  const controllersByLeg = new Map<string, PartInstance[]>();
  const loadsByLeg = new Map<string, PartInstance[]>();
  for (const part of shown.values()) {
    const leg = legOf(part);
    if (!leg) continue;
    if (isControlDevice(model, part)) {
      pushTo(controllersByLeg, leg, part);
    } else {
      const type = model.elements[part.typeId];
      if (type?.kind === "part_type" && (type.definition.category === "lighting_fixture" || type.definition.category === "electrical_device")) {
        pushTo(loadsByLeg, leg, part);
      }
    }
  }
  const out: CircuitGraphic[] = [];
  const style = settings.style === "orthogonal" ? "orthogonal" : "arcs";
  for (const leg of [...controllersByLeg.keys()].sort()) {
    const ctrls = [...(controllersByLeg.get(leg) ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    const loads = [...(loadsByLeg.get(leg) ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (ctrls.length === 0 || loads.length === 0) continue;
    const key = ctrls.length === 1 ? `switch:${ctrls[0]!.id}` : `switch:${leg}`;
    const hint = settings.hints[key] ?? settings.hints[`switch:${leg}`];
    const ctrlNodes = ctrls.map((c) => nodeOf(model, c, "power", scale, detail, symbolScale));
    const loadNodes = loads.map((f) => nodeOf(model, f, "power", scale, detail, symbolScale));
    const paths: Vec2[][] = [];
    const joins: Array<[string, string]> = [];
    // Chain multiple controllers (3-way/4-way travelers, switch + occupancy sensor) first, then feed controlled loads from the closest controller.
    const orderedCtrls = ctrlNodes.length > 1 ? chain(ctrlNodes[0]!, ctrlNodes.slice(1)) : ctrlNodes;
    for (let i = 0; i + 1 < orderedCtrls.length; i++) {
      const a = orderedCtrls[i]!;
      const b = orderedCtrls[i + 1]!;
      const k = bendKey(a.id, b.id);
      const path = joinPath(style, a, b, spanWaypoints(hint, a.id, b.id), hint?.flipArc?.[k] === true, drawn, SQUARE_RUN_OFFSET_MM * scale);
      if (style === "orthogonal") drawn.add(path);
      paths.push(path);
      joins.push([a.id, b.id]);
    }
    const anchorCtrl = orderedCtrls[orderedCtrls.length - 1]!;
    for (const [a, b] of joinPairs(style, anchorCtrl, loadNodes)) {
      const k = bendKey(a.id, b.id);
      const path = joinPath(style, a, b, spanWaypoints(hint, a.id, b.id), hint?.flipArc?.[k] === true, drawn, SQUARE_RUN_OFFSET_MM * scale);
      if (style === "orthogonal") drawn.add(path);
      paths.push(path);
      joins.push([a.id, b.id]);
    }
    const lowVolt = isLowVoltageControl(ctrls);
    const numbers = settings.switchLegLabels
      ? [...orderedCtrls, ...loadNodes].map((n) => ({
          memberId: n.id,
          at: switchLegLabelPoint(n, scale, symbolScale, hasSymbolSubscript(model, n.part), hint?.memberLabelOffsets?.[n.id]),
          text: leg,
        }))
      : [];
    out.push({
      key,
      linkId: null,
      kind: "switch_leg",
      priority: hint?.priority ?? 0,
      dashed: true,
      dashPattern: lowVolt ? CONTROL_LEG_DASH : SWITCH_LEG_DASH,
      lowVoltage: lowVolt,
      multiController: ctrls.length > 1,
      paths,
      joins,
      homeRun: null,
      numbers,
    });
  }
  return out;
}

function moved(g: CircuitGraphic, spec: TypicalSpec, copy: TypicalCopy): CircuitGraphic {
  const T = (p: Vec2) => copyPoint(spec, copy, p);
  return {
    ...g,
    key: `${g.key}@${copy.id}`,
    paths: g.paths.map((path) => path.map(T)),
    homeRun: g.homeRun
      ? {
          ...g.homeRun,
          from: T(g.homeRun.from),
          tip: T(g.homeRun.tip),
          ...(g.homeRun.path ? { path: g.homeRun.path.map(T) } : {}),
          label: copyText(spec, copy, g.homeRun.label),
          ...(g.homeRun.labelAt ? { labelAt: T(g.homeRun.labelAt) } : {}),
        }
      : null,
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
export function deriveCircuitGraphics(model: ModelState, view: ViewElement, shown: ReadonlyMap<string, PartInstance>, scale: number, detail: DetailLevel = "medium"): CircuitGraphic[] {
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
  const symbolScale = view.props?.symbolScale ?? 1;
  // Every circuit on the plan shares one index, so a second circuit's square run steps beside the first's.
  const drawn = new DrawnRuns(RUN_CELL_MM * scale, (SQUARE_RUN_OFFSET_MM / 2) * scale);
  if (settings.showCircuits) {
    for (const link of [...links.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      // A circuit wholly inside one typical repeats with it.
      const groups = new Set(link.members.map((m) => model.elements[m.elementId]?.groupId));
      const only = groups.size === 1 ? [...groups][0] : undefined;
      const spec = only ? typicals.get(only) : undefined;
      const g = linkGraphic(model, link, shown, settings, scale, spec !== undefined && !settings.allCopies, drawn, detail, symbolScale);
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
    // Combine Multi-Wire Branch Circuits (MWBC, NEC 210.4) sharing a panel + `mwbcGroup` into one multi-arrowhead home run.
    const mwbcBuckets = new Map<string, number[]>();
    out.forEach((g, idx) => {
      if (g.kind !== "circuit" || !g.linkId || g.key.includes("@") || !g.homeRun) return;
      const grp = settings.hints[g.linkId]?.mwbcGroup?.trim();
      const link = model.elements[g.linkId];
      if (!grp || link?.kind !== "service_link") return;
      pushTo(mwbcBuckets, `${link.source.elementId}:${grp}`, idx);
    });
    for (const indices of mwbcBuckets.values()) {
      if (indices.length < 2) continue;
      const linksInGroup = indices.map((idx) => ({ idx, g: out[idx]!, link: model.elements[out[idx]!.linkId!] as ServiceLink }));
      linksInGroup.sort((a, b) => (a.link.source.positions[0] ?? 0) - (b.link.source.positions[0] ?? 0));
      const slots = linksInGroup.flatMap((x) => x.link.source.positions).sort((a, b) => a - b);
      const totalHots = linksInGroup.reduce((s, x) => s + Math.max(1, x.link.source.positions.length), 0);
      const leader = linksInGroup[0]!;
      const combinedLabel = serviceLinkName(model.elements, {
        ...leader.link,
        source: { ...leader.link.source, positions: slots },
      });
      out[leader.idx] = {
        ...leader.g,
        homeRun: leader.g.homeRun
          ? { ...leader.g.homeRun, label: combinedLabel, arrows: linksInGroup.length, mwbcHots: totalHots }
          : null,
      };
      for (let i = 1; i < linksInGroup.length; i++) {
        const sub = linksInGroup[i]!;
        out[sub.idx] = { ...sub.g, homeRun: null };
      }
    }
  }
  if (settings.switchLegs) out.push(...switchLegs(model, shown, settings, scale, drawn, detail, symbolScale));
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
  const polylines = graphics.map((g) => [...g.paths, ...(g.homeRun ? [g.homeRun.path ?? [g.homeRun.from, g.homeRun.tip]] : [])].map((path) => path.map(toPaper)));
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

/** One drawn line between two devices of a circuit or switch leg, on paper: what a drag or right-click edits. */
export interface CircuitJoinOnPaper {
  /** Key in `ViewProps.circuitGraphics.hints` (the link id for a circuit, or `"switch:<leg>"` for a switch leg). */
  readonly linkId: string;
  readonly kind: "circuit" | "switch_leg";
  /** The circuit or switch leg as drawings name it ("L1-1", "Switch leg a"). */
  readonly name: string;
  readonly a: string;
  readonly b: string;
  readonly points: readonly Vec2[];
  /** Currently pinned control vertices in model mm (in `a -> b` order; empty when automatic). */
  readonly waypointsModel: readonly Vec2[];
  /** Currently pinned control vertices on paper mm (in `a -> b` order). */
  readonly waypointsPaper: readonly Vec2[];
  /** True when `flipArc` is active on this span. */
  readonly flipped: boolean;
}

/** The plan's editable wire spans (original circuits and switch legs, not typical copies), on paper. */
export function circuitJoinsOnPaper(model: ModelState, view: ViewElement, shown: ReadonlyMap<string, PartInstance>, scale: number, toPaper: (p: Vec2) => Vec2): CircuitJoinOnPaper[] {
  const settings = resolveCircuitGraphics(view);
  const out: CircuitJoinOnPaper[] = [];
  for (const g of deriveCircuitGraphics(model, view, shown, scale)) {
    if (g.key.includes("@")) continue;
    const hintKey = g.linkId ?? g.key;
    const hint = settings.hints[hintKey];
    const link = g.linkId ? model.elements[g.linkId] : undefined;
    const name =
      g.kind === "switch_leg"
        ? `Switch leg ${g.key.replace(/^switch:/, "")}`
        : link?.kind === "service_link"
          ? serviceLinkName(model.elements, link)
          : hintKey;
    g.paths.forEach((path, i) => {
      const [a, b] = g.joins[i] ?? [];
      if (!a || !b) return;
      const wps = spanWaypoints(hint, a, b) ?? [];
      const k = bendKey(a, b);
      out.push({
        linkId: hintKey,
        kind: g.kind,
        name,
        a,
        b,
        points: path.map(toPaper),
        waypointsModel: wps,
        waypointsPaper: wps.map(toPaper),
        flipped: hint?.flipArc?.[k] === true,
      });
    });
  }
  return out;
}

/** One drawn home run on paper: interactive tip, mid-curve, and label handles. */
export interface CircuitHomeRunOnPaper {
  readonly linkId: string;
  readonly name: string;
  readonly memberId: string;
  /** Host member anchor in model mm (origin for relative tipOffset / bendOffset). */
  readonly anchorModel: Vec2;
  readonly fromPaper: Vec2;
  readonly tipPaper: Vec2;
  readonly tipModel: Vec2;
  /** Current mid-shaft point on paper (for curving the home run). */
  readonly midPaper: Vec2;
  readonly pathPaper: readonly Vec2[];
  readonly label: string;
  readonly labelAtPaper: Vec2;
  readonly labelBoxPaper: { readonly min: Vec2; readonly max: Vec2 };
  readonly hasCustom: boolean;
}

/** Every original circuit's home run on paper so the editor can drag its tip, curve, or label. */
export function circuitHomeRunsOnPaper(model: ModelState, view: ViewElement, shown: ReadonlyMap<string, PartInstance>, scale: number, toPaper: (p: Vec2) => Vec2): CircuitHomeRunOnPaper[] {
  const settings = resolveCircuitGraphics(view);
  const textLook = resolveTextStyle(model, "link_label");
  const labelSize = textLook?.textSizeMm ?? LABEL_MM;
  const symbolScale = view.props?.symbolScale ?? 1;
  const out: CircuitHomeRunOnPaper[] = [];
  for (const g of deriveCircuitGraphics(model, view, shown, scale)) {
    if (g.kind !== "circuit" || !g.linkId || g.key !== g.linkId || !g.homeRun) continue;
    const hr = g.homeRun;
    const pathModel = hr.path ?? [hr.from, hr.tip];
    const pathPaper = pathModel.map(toPaper);
    const fromPaper = pathPaper[0] ?? toPaper(hr.from);
    const tipPaper = pathPaper[pathPaper.length - 1] ?? toPaper(hr.tip);
    const mid = samplePolylineAt(pathPaper, 0.5)?.at ?? lerp(fromPaper, tipPaper, 0.5);
    const lastSegFrom = pathPaper[pathPaper.length - 2] ?? fromPaper;
    const segLen = Math.max(1e-6, dist(lastSegFrom, tipPaper));
    const u = { x: (tipPaper.x - lastSegFrom.x) / segLen, y: (tipPaper.y - lastSegFrom.y) / segLen };
    const n = { x: -u.y, y: u.x };
    const text = textLook?.uppercase ? hr.label.toUpperCase() : hr.label;
    const w = Math.max(labelSize, text.length * labelSize * 0.62);
    const defaultPos = homeRunLabel(fromPaper, tipPaper, u, n, w, labelSize)[0]!;
    const labelAtPaper = hr.labelAt ? toPaper(hr.labelAt) : defaultPos.at;
    const anchor: TextAnchor = hr.labelAt ? "middle" : defaultPos.anchor;
    const labelBoxPaper = textBox(labelAtPaper, w + 0.8, labelSize + 0.6, anchor);
    const link = model.elements[g.linkId];
    const name = link?.kind === "service_link" ? serviceLinkName(model.elements, link) : g.linkId;
    const member = shown.get(hr.memberId);
    const memberConn = link?.kind === "service_link" ? (link.members.find((m) => m.elementId === hr.memberId)?.connector ?? "power") : "power";
    const anchorModel = member ? nodeOf(model, member, memberConn, scale, "medium", symbolScale).point : hr.from;
    const hint = settings.hints[g.linkId]?.homeRun;
    out.push({
      linkId: g.linkId,
      name,
      memberId: hr.memberId,
      anchorModel,
      fromPaper,
      tipPaper,
      tipModel: hr.tip,
      midPaper: mid,
      pathPaper,
      label: text,
      labelAtPaper,
      labelBoxPaper,
      hasCustom: hint !== undefined,
    });
  }
  return out;
}

export type HomeRunHitPart = "tip" | "shaft" | "label";

/** Hit-test home runs on paper: tight arrow tip > label box > looser tip > shaft. */
export function circuitHomeRunNear(
  homeRuns: readonly CircuitHomeRunOnPaper[],
  p: Vec2,
  tolerance: number,
): { readonly homeRun: CircuitHomeRunOnPaper; readonly part: HomeRunHitPart } | null {
  const tightTipTol = Math.min(Math.max(tolerance * 0.75, 1.4), 2.0);
  for (const hr of homeRuns) {
    if (dist(p, hr.tipPaper) <= tightTipTol) return { homeRun: hr, part: "tip" };
  }
  const pad = Math.min(tolerance * 0.35, 0.8);
  for (const hr of homeRuns) {
    const b = hr.labelBoxPaper;
    if (hr.label && p.x >= b.min.x - pad && p.x <= b.max.x + pad && p.y >= b.min.y - pad && p.y <= b.max.y + pad) {
      return { homeRun: hr, part: "label" };
    }
  }
  const looseTipTol = Math.max(tolerance, 2.2);
  for (const hr of homeRuns) {
    if (dist(p, hr.tipPaper) <= looseTipTol) return { homeRun: hr, part: "tip" };
  }
  let best: CircuitHomeRunOnPaper | null = null;
  let bestD = tolerance;
  for (const hr of homeRuns) {
    for (let i = 0; i + 1 < hr.pathPaper.length; i++) {
      const a = hr.pathPaper[i]!;
      const b = hr.pathPaper[i + 1]!;
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      const d = dist(p, lerp(a, b, t));
      if (d <= bestD) {
        bestD = d;
        best = hr;
      }
    }
  }
  return best ? { homeRun: best, part: "shaft" } : null;
}

/** One drawn switch-leg designation ("a", "b") on paper: draggable relative to its device. */
export interface CircuitSwitchLegLabelOnPaper {
  readonly hintKey: string;
  readonly memberId: string;
  readonly text: string;
  readonly memberAnchorModel: Vec2;
  readonly atPaper: Vec2;
  readonly custom: boolean;
}

/** Every editable switch-leg label on a plan (excludes typical copies), on paper. */
export function circuitSwitchLegLabelsOnPaper(
  model: ModelState,
  view: ViewElement,
  shown: ReadonlyMap<string, PartInstance>,
  scale: number,
  toPaper: (p: Vec2) => Vec2,
): CircuitSwitchLegLabelOnPaper[] {
  const settings = resolveCircuitGraphics(view);
  const symbolScale = view.props?.symbolScale ?? 1;
  const out: CircuitSwitchLegLabelOnPaper[] = [];
  for (const g of deriveCircuitGraphics(model, view, shown, scale)) {
    if (g.kind !== "switch_leg" || g.key.includes("@")) continue;
    const hint = settings.hints[g.key];
    for (const num of g.numbers) {
      const part = shown.get(num.memberId);
      if (!part) continue;
      const node = nodeOf(model, part, "power", scale, view.props?.detailLevel ?? "medium", symbolScale);
      out.push({
        hintKey: g.key,
        memberId: num.memberId,
        text: num.text,
        memberAnchorModel: node.point,
        atPaper: toPaper(num.at),
        custom: hint?.memberLabelOffsets?.[num.memberId] !== undefined,
      });
    }
  }
  return out;
}

/** Hit-test movable switch-leg labels ("a", "b") on paper; returns nearest within tolerance. */
export function circuitSwitchLegLabelNear(labels: readonly CircuitSwitchLegLabelOnPaper[], p: Vec2, tolerance: number): CircuitSwitchLegLabelOnPaper | null {
  let best: CircuitSwitchLegLabelOnPaper | null = null;
  let bestD = tolerance;
  for (const l of labels) {
    const cx = l.atPaper.x + Math.max(0.8, l.text.length * 0.65);
    const cy = l.atPaper.y - 0.9;
    const d = dist(p, { x: cx, y: cy });
    if (d <= bestD) {
      bestD = d;
      best = l;
    }
  }
  return best;
}

/** The circuit or switch-leg line within `tolerance` paper mm of `p`, nearest first (preferring power circuits over overlapping switch legs on close ties); null when none is. */
export function circuitJoinNear(joins: readonly CircuitJoinOnPaper[], p: Vec2, tolerance: number): CircuitJoinOnPaper | null {
  let best: CircuitJoinOnPaper | null = null;
  let bestD = tolerance;
  for (const j of joins) {
    let minD = Infinity;
    for (let i = 0; i + 1 < j.points.length; i++) {
      const a = j.points[i]!;
      const b = j.points[i + 1]!;
      const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
      const d = dist(p, lerp(a, b, t));
      if (d < minD) minD = d;
    }
    if (minD > tolerance) continue;
    const circuitTieWin = best !== null && best.kind === "switch_leg" && j.kind === "circuit" && minD <= bestD + 0.6;
    const switchTieLoss = best !== null && best.kind === "circuit" && j.kind === "switch_leg" && minD >= bestD - 0.6;
    if (!switchTieLoss && (best === null || minD < bestD - 1e-4 || circuitTieWin)) {
      bestD = minD;
      best = j;
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
function homeRunLabel(from: Vec2, tip: Vec2, u: Vec2, n: Vec2, w: number, labelSize = LABEL_MM): Array<{ readonly at: Vec2; readonly anchor: TextAnchor }> {
  const anchor: TextAnchor = u.x >= -1e-9 ? "start" : "end";
  const mid = lerp(from, tip, 0.5);
  const side = labelSize * 0.9;
  const beside = (p: Vec2, s: number) => ({ x: p.x + n.x * s * (side + Math.abs(n.x) * w * 0.5), y: p.y + n.y * s * side + labelSize * 0.35 });
  return [
    { at: { x: tip.x + u.x * 1.2 + (anchor === "start" ? 0.6 : -0.6), y: tip.y + u.y * 1.2 + labelSize * 0.35 }, anchor },
    { at: beside(mid, -1), anchor: "middle" },
    { at: beside(mid, 1), anchor: "middle" },
    { at: beside(tip, -1), anchor: "middle" },
    { at: beside(tip, 1), anchor: "middle" },
  ];
}

export interface CircuitDrawContext {
  readonly toPaper: (p: Vec2) => Vec2;
  readonly scale: number;
  readonly detail?: DetailLevel;
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
  const laid = drawCircuitGraphicsInk(ctx, model, view, shown, "all");
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
 * graphics point. Wire arcs, switch legs and home-run shafts draw on
 * `layer: "under_parts"` (behind light fixtures and device symbols), while
 * home-run labels and circuit numbers draw on `drawOver` so text stays above
 * symbol masks and avoids every placed part mark.
 */
export const CIRCUIT_GRAPHICS_ROW: ViewGraphicsRow = {
  id: "circuit_lines",
  label: "Circuit lines",
  hintsKey: "circuitGraphics",
  category: CIRCUIT_GRAPHICS_CATEGORY,
  order: 100,
  layer: "under_parts",
  draw: (ctx) => {
    drawCircuitGraphicsInk(ctx, ctx.model, ctx.view, ctx.shown, "lines");
  },
  drawOver: (ctx) => {
    drawCircuitGraphicsInk(ctx, ctx.model, ctx.view, ctx.shown, "labels");
  },
  hintsSchema: circuitGraphicsSchema,
  hintsRefusal: circuitGraphicsRefusal,
};

/** Per-render cache keyed by `ctx.shown` so `draw` ("lines") and `drawOver` ("labels") share one derive+layout pass. */
const LAST_LAID = new WeakMap<
  ReadonlyMap<string, PartInstance>,
  { readonly model: ModelState; readonly view: ViewElement; readonly scale: number; readonly detail: DetailLevel; readonly laid: PaperGraphic[] }
>();

function drawCircuitGraphicsInk(
  ctx: CircuitDrawContext,
  model: ModelState,
  view: ViewElement,
  shown: ReadonlyMap<string, PartInstance>,
  pass: "all" | "lines" | "labels" = "all",
): PaperGraphic[] {
  const detail: DetailLevel = ctx.detail ?? "medium";
  // Only reuse the cached layout on the paired "labels" pass so every "lines" or standalone "all" render recomputes with its own `ctx.toPaper`.
  const cached = pass === "labels" ? LAST_LAID.get(shown) : undefined;
  const hit = cached && cached.model === model && cached.view === view && cached.scale === ctx.scale && cached.detail === detail;
  const laid = hit ? cached.laid : layoutCircuitGraphics(deriveCircuitGraphics(model, view, shown, ctx.scale, detail), ctx.toPaper);
  if (pass === "lines") LAST_LAID.set(shown, { model, view, scale: ctx.scale, detail, laid });
  else if (hit) LAST_LAID.delete(shown);
  const resolvedSettings = resolveCircuitGraphics(view);
  const marks = resolvedSettings.hashMarks;
  const marksOn = resolvedSettings.hashMarksOn;
  const textLook = resolveTextStyle(model, "link_label");
  const labelSize = textLook?.textSizeMm ?? LABEL_MM;
  const switchLabelSize = Math.max(1.7, Math.min(labelSize * 0.85, 2.2));
  const numberSize = Math.min(labelSize, NUMBER_MM);
  const { min, max } = ctx.window;
  const fits = (p: Vec2, w: number, anchor: TextAnchor, sz = labelSize) => {
    const b = textBox(p, w, sz, anchor);
    return b.min.x >= min.x && b.max.x <= max.x && p.y - sz >= min.y && p.y <= max.y;
  };
  const drawLines = pass === "all" || pass === "lines";
  const drawLabels = pass === "all" || pass === "labels";
  // Text already on the plan (part marks such as the panel's "P1", tags): home-run labels keep clear of it.
  const taken: Box[] = [];
  if (drawLabels) {
    for (const prim of ctx.prims) if (prim.kind === "text") taken.push(textBox(prim.at, prim.text.length * prim.size * 0.6, prim.size, prim.anchor));
  }
  const textExtras = textLook
    ? {
        ...(textLook.mask ? { mask: true } : {}),
        ...(textLook.bold ? { bold: true } : {}),
        ...(textLook.italic ? { italic: true } : {}),
        ...(textLook.fontFamily ? { fontFamily: textLook.fontFamily } : {}),
        ...(textLook.color ? { color: textLook.color } : {}),
      }
    : {};
  for (const { source, lines } of laid) {
    const pen = source.kind === "switch_leg" ? "thin" : "medium";
    const dash = source.dashed ? (source.dashPattern ?? SWITCH_LEG_DASH) : undefined;
    const conductorMarks =
      drawLines && marks !== "off"
        ? source.kind === "circuit"
          ? source.homeRun?.mwbcHots
            ? [
                ...Array.from({ length: source.homeRun.mwbcHots }, () => "hot" as const),
                "neutral" as const,
                ...(marks === "hots_neutral_ground" ? (["ground"] as const) : []),
              ]
            : circuitConductorMarks(model, source.linkId, marks)
          : switchLegConductorMarks(source.lowVoltage === true, source.multiController === true, marks)
        : [];
    const branchSpanMarks =
      drawLines && marks !== "off" && source.kind === "circuit" ? circuitConductorMarks(model, source.linkId, marks) : conductorMarks;
    if (drawLines) {
      for (const line of lines) {
        for (let i = 0; i + 1 < line.length; i++) {
          const c = clipSegment(line[i]!, line[i + 1]!, min, max);
          if (c) ctx.prims.push({ kind: "line", a: c[0], b: c[1], pen, ...(dash ? { dash } : {}) });
        }
      }
      const drawSpanHashes =
        (source.kind === "circuit" && marksOn === "all_runs") ||
        (source.kind === "switch_leg" && (marksOn === "all_runs" || marksOn === "home_runs_and_switch_legs"));
      if (drawSpanHashes && branchSpanMarks.length > 0) {
        for (const rawPath of source.paths) {
          const pPaper = rawPath.map(ctx.toPaper);
          for (const [a, b] of hashMarkLinesAlongPath(pPaper, branchSpanMarks, 0.5)) {
            const c = clipSegment(a, b, min, max);
            if (c) ctx.prims.push({ kind: "line", a: c[0], b: c[1], pen: "thin" });
          }
        }
      }
    }
    if (source.homeRun) {
      const hrPaper = (source.homeRun.path ?? [source.homeRun.from, source.homeRun.tip]).map(ctx.toPaper);
      const from = hrPaper[0] ?? ctx.toPaper(source.homeRun.from);
      const tip = hrPaper[hrPaper.length - 1] ?? ctx.toPaper(source.homeRun.tip);
      const tailFrom = hrPaper[hrPaper.length - 2] ?? from;
      const tailLen = dist(tailFrom, tip);
      if (tailLen > 1e-6 && tip.x >= min.x && tip.x <= max.x && tip.y >= min.y && tip.y <= max.y) {
        const u = { x: (tip.x - tailFrom.x) / tailLen, y: (tip.y - tailFrom.y) / tailLen };
        const n = { x: -u.y, y: u.x };
        if (drawLines) {
          const arrowCount = Math.max(1, source.homeRun.arrows ?? 1);
          const arrowPitch = ARROW_HEAD_MM * 0.9;
          for (let k = 0; k < arrowCount; k++) {
            const head = { x: tip.x - u.x * (k * arrowPitch), y: tip.y - u.y * (k * arrowPitch) };
            const back = { x: head.x - u.x * ARROW_HEAD_MM, y: head.y - u.y * ARROW_HEAD_MM };
            ctx.prims.push({ kind: "line", a: head, b: { x: back.x + n.x * ARROW_HEAD_MM * 0.4, y: back.y + n.y * ARROW_HEAD_MM * 0.4 }, pen: "medium" });
            ctx.prims.push({ kind: "line", a: head, b: { x: back.x - n.x * ARROW_HEAD_MM * 0.4, y: back.y - n.y * ARROW_HEAD_MM * 0.4 }, pen: "medium" });
          }
          for (const [a, b] of hashMarkLinesAlongPath(hrPaper, conductorMarks, arrowCount > 1 ? 0.36 : 0.44)) ctx.prims.push({ kind: "line", a, b, pen: "thin" });
        }
        if (drawLabels) {
          const rawText = source.homeRun.label;
          const text = textLook?.uppercase ? rawText.toUpperCase() : rawText;
          const w = text.length * labelSize * 0.6;
          if (text !== "") {
            if (source.homeRun.labelAt) {
              const at = ctx.toPaper(source.homeRun.labelAt);
              if (fits(at, w, "middle", labelSize)) {
                ctx.prims.push({ kind: "text", at, text, size: labelSize, anchor: "middle", ...textExtras });
                taken.push(textBox(at, w, labelSize, "middle"));
              }
            } else {
              const candidates = homeRunLabel(from, tip, u, n, w, labelSize);
              const label = candidates.find((c) => fits(c.at, w, c.anchor, labelSize) && !taken.some((t) => boxesMeet(t, textBox(c.at, w, labelSize, c.anchor))));
              const fallback = candidates[0]!;
              const place = label ?? (fits(fallback.at, w, fallback.anchor, labelSize) ? fallback : null);
              if (place) {
                ctx.prims.push({ kind: "text", at: place.at, text, size: labelSize, anchor: place.anchor, ...textExtras });
                taken.push(textBox(place.at, w, labelSize, place.anchor));
              }
            }
          }
        }
      }
    }
    if (drawLabels) {
      const sz = source.kind === "switch_leg" ? switchLabelSize : numberSize;
      for (const n of source.numbers) {
        const at = ctx.toPaper(n.at);
        const w = n.text.length * sz * 0.6;
        if (fits(at, w, "start", sz)) {
          ctx.prims.push({
            kind: "text",
            at,
            text: n.text,
            size: sz,
            anchor: "start",
            ...(source.kind === "switch_leg" ? { italic: true, mask: true } : {}),
            ...textExtras,
          });
          taken.push(textBox(at, w, sz, "start"));
        }
      }
    }
  }
  return laid;
}
