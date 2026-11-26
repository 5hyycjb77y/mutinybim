import { z } from "zod";
import type { DrawingItem } from "../documents";
import type { Pen, Primitive, Tone } from "../drawing/sheet";
import type { Vec2 } from "../types";
import { activeSymbolRegistry, draftingFormOf, symbolById } from "../categories/symbol-registry";

/** Protocol feature gating CAD drafting standards: halftone/screened hatch tone, extended hatch patterns, opaque note masks, and filled leader arrows/dots. */
export const DRAFTING_CAD_STANDARDS_FEATURE = "drafting:cad_standards";

/**
 * Detailing: the drafting vocabulary of a detail (or any view, or a sheet) as
 * plain drawing items. Linework carries a weight and a pattern; regions fill
 * with a hatch or mask what is under them; detail components are 2D symbols
 * from a declarative library; repeating details and insulation batts lay a
 * pattern along a line. Everything is stored in the owner's coordinates (model
 * mm in a view, paper mm on a sheet) and drawn through `toPaper`, so a detail
 * scales with its view while hatch spacing and dash lengths stay paper-sized.
 *
 * The symbol format (`Symbol2D`) is deliberately small and serialisable: unit
 * box coordinates and a handful of primitive kinds. A part definition can carry
 * the same structure as its symbolic 2D representation later.
 */

export const LINE_PATTERNS = ["solid", "dashed", "hidden", "center", "phantom", "dotted"] as const;
export type LinePattern = (typeof LINE_PATTERNS)[number];
export const LINE_WEIGHTS_2D = ["thin", "medium", "wide", "heavy"] as const satisfies readonly Pen[];
export type LineWeight2D = (typeof LINE_WEIGHTS_2D)[number];

/** Dash arrays in paper mm. */
export const PATTERN_DASH: Readonly<Record<LinePattern, readonly number[] | undefined>> = {
  solid: undefined,
  dashed: [3, 1.5],
  hidden: [1.5, 1],
  center: [6, 1.2, 1.2, 1.2],
  phantom: [6, 1.2, 1.2, 1.2, 1.2, 1.2],
  dotted: [0.3, 1],
};

export interface LineStyle {
  readonly weight?: Pen;
  readonly pattern?: LinePattern;
  /** Optional tone (e.g. "halftone" for existing-phase diagram items). */
  readonly tone?: Tone;
}

/**
 * Named line styles, the way BIM drafting views pick linework: one style per
 * line (thin, medium, wide, hidden, centre...), each a fixed weight and
 * pattern, instead of a weight and a pattern chosen line by line.
 */
export const DETAIL_LINE_STYLES = [
  { id: "thin", name: "Thin lines", weight: "thin", pattern: "solid" },
  { id: "medium", name: "Medium lines", weight: "medium", pattern: "solid" },
  { id: "wide", name: "Wide lines", weight: "wide", pattern: "solid" },
  { id: "heavy", name: "Heavy lines", weight: "heavy", pattern: "solid" },
  { id: "hidden", name: "Hidden lines", weight: "thin", pattern: "hidden" },
  { id: "overhead", name: "Overhead lines", weight: "thin", pattern: "dashed" },
  { id: "dashed", name: "Dashed lines", weight: "medium", pattern: "dashed" },
  { id: "match", name: "Wide dashed", weight: "wide", pattern: "dashed" },
  { id: "center", name: "Centre lines", weight: "thin", pattern: "center" },
  { id: "phantom", name: "Phantom lines", weight: "thin", pattern: "phantom" },
  { id: "dotted", name: "Dotted lines", weight: "thin", pattern: "dotted" },
] as const satisfies ReadonlyArray<{ readonly id: string; readonly name: string; readonly weight: LineWeight2D; readonly pattern: LinePattern }>;
export type DetailLineStyleId = (typeof DETAIL_LINE_STYLES)[number]["id"];

/** The named style a line style is (weight defaults to medium, pattern to solid), or null for a weight and pattern no named style has. */
export function detailLineStyleOf(style: LineStyle | undefined): DetailLineStyleId | null {
  const weight = style?.weight ?? "medium";
  const pattern = style?.pattern ?? "solid";
  return DETAIL_LINE_STYLES.find((s) => s.weight === weight && s.pattern === pattern)?.id ?? null;
}

/** The stored line style for a named style (empty for medium solid, the default). */
export function lineStyleFor(id: DetailLineStyleId): LineStyle {
  const s = DETAIL_LINE_STYLES.find((x) => x.id === id);
  if (!s) return {};
  return { ...(s.weight !== "medium" ? { weight: s.weight } : {}), ...(s.pattern !== "solid" ? { pattern: s.pattern } : {}) };
}

export const LEGACY_HATCH_PATTERNS = ["solid", "diagonal", "diagonal_reverse", "crosshatch", "horizontal", "vertical", "dots", "concrete", "earth", "insulation_rigid", "masonry"] as const;
export const EXTENDED_HATCH_PATTERNS = ["steel_section", "gravel", "sand", "gypsum", "wood_grain", "metal_deck", "roofing_membrane", "acoustic"] as const;
export const HATCH_PATTERNS = [...LEGACY_HATCH_PATTERNS, ...EXTENDED_HATCH_PATTERNS] as const;
export type HatchPattern = (typeof HATCH_PATTERNS)[number];
const EXTENDED_HATCH_SET: ReadonlySet<string> = new Set(EXTENDED_HATCH_PATTERNS);
export const REGION_TONES = ["ink", "halftone", "screened"] as const;
export type RegionTone = (typeof REGION_TONES)[number];

export interface RegionFill {
  readonly pattern: HatchPattern;
  /** Line spacing on paper, mm (default by pattern). */
  readonly spacingMm?: number;
  /** Solid fill shade: 0 black, 1 white (default 0.8). */
  readonly grey?: number;
  /** Hatch stroke or fill tone: black ink (default), halftone (50% grey), or screened (68% grey). */
  readonly tone?: Tone;
  /** A masking region: white, no boundary, hides what was drawn before it. */
  readonly masking?: boolean;
  /** Draw the boundary (default true; masking regions never do). */
  readonly boundary?: boolean;
}

/** Whether a region fill uses fields or hatch patterns gated behind `DRAFTING_CAD_STANDARDS_FEATURE`. */
export function regionFillNeedsCadStandards(fill: RegionFill | undefined): boolean {
  if (!fill) return false;
  return fill.tone !== undefined || EXTENDED_HATCH_SET.has(fill.pattern);
}

export interface ComponentPlacement {
  readonly symbolId: string;
  /** Model (or paper on a sheet) size of the symbol's unit box; absent: the symbol's default. */
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly rotationDeg?: number;
  readonly mirror?: boolean;
  /** Repeating detail only: distance between copies (default: the symbol's width). */
  readonly spacingMm?: number;
}

export interface BattSpec {
  /** Insulation thickness, owner units (model mm in a view). */
  readonly thicknessMm: number;
}

export const DRAFTING_CATEGORIES = ["detail_lines", "hatching", "masking", "components", "insulation", "text", "dimensions", "tags", "clouds"] as const;
export type DraftingCategory = (typeof DRAFTING_CATEGORIES)[number];

/** The category an item is shown and hidden by: its own, or what its shape implies. */
export function categoryOf(item: Pick<DrawingItem, "shape" | "category" | "fill">): DraftingCategory {
  if (item.category) return item.category;
  switch (item.shape) {
    case "text":
      return "text";
    case "dimension":
      return "dimensions";
    case "tag":
    case "callout":
      return "tags";
    case "cloud":
      return "clouds";
    case "region":
      return item.fill?.masking ? "masking" : "hatching";
    case "component":
    case "repeat":
      return "components";
    case "batt":
      return "insulation";
    default:
      return "detail_lines";
  }
}

// ── Schemas ──────────────────────────────────────────────────────────────────

export const lineStyleSchema = z.object({ weight: z.enum(LINE_WEIGHTS_2D).optional(), pattern: z.enum(LINE_PATTERNS).optional() }).strict();
export const regionFillSchema = z
  .object({
    pattern: z.enum(HATCH_PATTERNS),
    spacingMm: z.number().min(0.5).max(20).optional(),
    grey: z.number().min(0).max(1).optional(),
    tone: z.enum(["ink", "halftone", "screened"]).optional(),
    masking: z.boolean().optional(),
    boundary: z.boolean().optional(),
  })
  .strict();
export const componentPlacementSchema = z
  .object({
    symbolId: z.string().min(1).max(80),
    widthMm: z.number().positive().max(100_000).optional(),
    heightMm: z.number().positive().max(100_000).optional(),
    rotationDeg: z.number().finite().min(-360).max(360).optional(),
    mirror: z.boolean().optional(),
    spacingMm: z.number().positive().max(100_000).optional(),
  })
  .strict();
export const battSpecSchema = z.object({ thicknessMm: z.number().positive().max(10_000) }).strict();

/** Stored points each detailing shape takes: [min, max]. */
export function detailPointRange(shape: DrawingItem["shape"]): [number, number] | null {
  switch (shape) {
    case "arc":
      return [3, 3];
    case "circle":
      return [2, 2];
    case "polyline":
    case "spline":
      return [2, 500];
    case "region":
      return [3, 500];
    case "component":
      return [1, 1];
    case "repeat":
    case "batt":
      return [2, 2];
    default:
      return null;
  }
}

// ── Geometry ─────────────────────────────────────────────────────────────────

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const len = (a: Vec2): number => Math.hypot(a.x, a.y);

/** Points along an arc from `start` to `end` about `center`, counter-clockwise when `ccw` (stored frame). */
export function arcPoints(center: Vec2, start: Vec2, end: Vec2, ccw: boolean, steps?: number): Vec2[] {
  const r = len(sub(start, center));
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let a1 = Math.atan2(end.y - center.y, end.x - center.x);
  if (ccw && a1 <= a0) a1 += 2 * Math.PI;
  if (!ccw && a1 >= a0) a1 -= 2 * Math.PI;
  const n = steps ?? Math.max(8, Math.ceil(Math.abs(a1 - a0) * 16));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: center.x + r * Math.cos(a0 + ((a1 - a0) * i) / n), y: center.y + r * Math.sin(a0 + ((a1 - a0) * i) / n) }));
}

export function circlePoints(center: Vec2, r: number, steps = 48): Vec2[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: center.x + r * Math.cos((2 * Math.PI * i) / steps), y: center.y + r * Math.sin((2 * Math.PI * i) / steps) }));
}

/** A Catmull–Rom spline through the points (closed joins the last to the first). */
export function splinePoints(points: readonly Vec2[], closed: boolean, perSpan = 10): Vec2[] {
  if (points.length < 3) return [...points];
  const at = (i: number) => (closed ? points[(i + points.length) % points.length] : points[Math.max(0, Math.min(points.length - 1, i))]) ?? { x: 0, y: 0 };
  const spans = closed ? points.length : points.length - 1;
  const out: Vec2[] = [];
  for (let s = 0; s < spans; s++) {
    const p0 = at(s - 1);
    const p1 = at(s);
    const p2 = at(s + 1);
    const p3 = at(s + 2);
    for (let k = 0; k < perSpan; k++) {
      const t = k / perSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(closed ? at(0) : at(points.length - 1));
  return out;
}

/** The polyline an item draws as, in stored coordinates (null when it isn't linework). */
export function itemPath(item: DrawingItem): Vec2[] | null {
  const p = item.points;
  switch (item.shape) {
    case "line":
      return p.length === 2 ? [...p] : null;
    case "rect": {
      const [a, b] = p;
      return a && b ? [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a] : null;
    }
    case "arc": {
      const [c, s, e] = p;
      return c && s && e ? arcPoints(c, s, e, item.ccw !== false) : null;
    }
    case "circle": {
      const [c, e] = p;
      return c && e ? circlePoints(c, len(sub(e, c))) : null;
    }
    case "polyline":
      return item.closed && p[0] ? [...p, p[0]] : [...p];
    case "spline":
      return splinePoints(p, item.closed === true);
    case "region":
      return p[0] ? [...p, p[0]] : null;
    default:
      return null;
  }
}

// ── Hatching ─────────────────────────────────────────────────────────────────

interface HatchFamily {
  readonly angleDeg: number;
  readonly spacing: number;
  readonly offset?: number;
  readonly dash?: readonly number[];
}

const HATCH_FAMILIES: Readonly<Record<Exclude<HatchPattern, "solid" | "dots" | "concrete">, readonly HatchFamily[]>> = {
  diagonal: [{ angleDeg: 45, spacing: 1.6 }],
  diagonal_reverse: [{ angleDeg: -45, spacing: 1.6 }],
  crosshatch: [
    { angleDeg: 45, spacing: 1.6 },
    { angleDeg: -45, spacing: 1.6 },
  ],
  horizontal: [{ angleDeg: 0, spacing: 1.6 }],
  vertical: [{ angleDeg: 90, spacing: 1.6 }],
  earth: [
    { angleDeg: 45, spacing: 2.4 },
    { angleDeg: 0, spacing: 2.4, dash: [1.2, 1.2] },
  ],
  insulation_rigid: [
    { angleDeg: 45, spacing: 3 },
    { angleDeg: -45, spacing: 3 },
    { angleDeg: 0, spacing: 3 },
  ],
  masonry: [
    { angleDeg: 0, spacing: 2 },
    { angleDeg: 90, spacing: 4, dash: [2, 2] },
  ],
  steel_section: [
    { angleDeg: 45, spacing: 2.8, offset: 0 },
    { angleDeg: 45, spacing: 2.8, offset: 0.65 },
  ],
  gravel: [
    { angleDeg: 25, spacing: 2.2, dash: [0.8, 1.8] },
    { angleDeg: -35, spacing: 2.4, dash: [0.7, 2.0] },
    { angleDeg: 80, spacing: 2.8, dash: [0.5, 2.3] },
  ],
  sand: [
    { angleDeg: 0, spacing: 1.4, dash: [0.22, 1.4] },
    { angleDeg: 60, spacing: 1.7, offset: 0.7, dash: [0.22, 1.7] },
  ],
  gypsum: [
    { angleDeg: 0, spacing: 1.8, dash: [0.2, 2.2] },
    { angleDeg: 45, spacing: 2.2, offset: 0.9, dash: [0.2, 2.5] },
  ],
  wood_grain: [
    { angleDeg: 0, spacing: 1.2, dash: [5, 1.2, 2.2, 1.0] },
    { angleDeg: 4, spacing: 2.6, offset: 0.6, dash: [3.5, 2.0] },
  ],
  metal_deck: [
    { angleDeg: 0, spacing: 2.4 },
    { angleDeg: 90, spacing: 3.2, dash: [1.2, 1.2] },
    { angleDeg: 45, spacing: 3.2, dash: [0.9, 2.3] },
  ],
  roofing_membrane: [
    { angleDeg: 0, spacing: 1.5, dash: [4.0, 1.2] },
    { angleDeg: 0, spacing: 1.5, offset: 0.75, dash: [0.6, 1.8] },
  ],
  acoustic: [
    { angleDeg: 45, spacing: 1.8, dash: [0.9, 1.1] },
    { angleDeg: -45, spacing: 1.8, offset: 0.9, dash: [0.9, 1.1] },
  ],
};

/** Even–odd crossings of a horizontal scanline (in the rotated frame) with a closed polygon. */
function scanCrossings(poly: readonly Vec2[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (!a || !b) continue;
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  return xs.sort((p, q) => p - q);
}

function rotate(p: Vec2, deg: number): Vec2 {
  const a = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) };
}

/** Hatch lines clipped to a closed paper polygon. */
export function hatchSegments(poly: readonly Vec2[], pattern: HatchPattern, spacingMm?: number): Array<[Vec2, Vec2, readonly number[] | undefined]> {
  if (pattern === "solid" || poly.length < 3) return [];
  const out: Array<[Vec2, Vec2, readonly number[] | undefined]> = [];
  const families: readonly HatchFamily[] =
    pattern === "dots" ? [{ angleDeg: 0, spacing: 2, dash: [0.2, 1.8] }] : pattern === "concrete" ? [{ angleDeg: 30, spacing: 2.5, dash: [0.25, 2.2] }, { angleDeg: -60, spacing: 3.5, dash: [0.6, 3.4] }] : HATCH_FAMILIES[pattern];
  for (const fam of families) {
    const scaleRatio = spacingMm ? spacingMm / (families[0]?.spacing ?? fam.spacing) : 1;
    const spacing = spacingMm ? fam.spacing * scaleRatio : fam.spacing;
    const offset = (fam.offset ?? 0) * scaleRatio;
    const local = poly.map((p) => rotate(p, -fam.angleDeg));
    const ys = local.map((p) => p.y);
    const y0 = Math.ceil((Math.min(...ys) - offset) / spacing) * spacing + offset;
    for (let y = y0; y <= Math.max(...ys); y += spacing) {
      const xs = scanCrossings(local, y);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = xs[i];
        const x1 = xs[i + 1];
        if (x0 === undefined || x1 === undefined || x1 - x0 < 0.05) continue;
        out.push([rotate({ x: x0, y }, fam.angleDeg), rotate({ x: x1, y }, fam.angleDeg), fam.dash]);
      }
    }
  }
  return out;
}

// ── Detail component library ─────────────────────────────────────────────────

/** A 2D symbol primitive in its unit box: x across 0..1, y up 0..1 (scaled by the placement's width and height). */
export type SymbolPrim =
  | { readonly k: "line"; readonly pts: readonly (readonly [number, number])[]; readonly pen?: Pen; readonly pattern?: LinePattern }
  | { readonly k: "circle"; readonly c: readonly [number, number]; readonly r: number; readonly pen?: Pen }
  | { readonly k: "fill"; readonly pts: readonly (readonly [number, number])[]; readonly grey: number };

export interface Symbol2D {
  readonly id: string;
  readonly name: string;
  readonly category: "insulation" | "duct" | "pipe" | "supports" | "valves" | "anchors" | "structure" | "electrical" | "annotation";
  /** Default size, mm (model mm in a view). */
  readonly widthMm: number;
  readonly heightMm: number;
  /** Linear symbols stretch along their width (flex duct, rod): they are drawn between two points. */
  readonly linear?: boolean;
  /** Where conductors attach, in the unit box (one-line symbols: `line` in, `load` out, `emergency` for a second source). */
  readonly terminals?: Readonly<Record<string, readonly [number, number]>>;
  readonly prims: readonly SymbolPrim[];
}

const IN = 25.4;
const wave = (cycles: number, y: number, amp: number, steps = 64): Array<[number, number]> => Array.from({ length: steps + 1 }, (_, i) => [i / steps, y + amp * Math.sin((i / steps) * cycles * 2 * Math.PI)]);

const MECHANICAL_COMPONENTS: readonly Symbol2D[] = [
  {
    id: "duct_rect_section",
    name: "Rectangular duct, cut",
    category: "duct",
    widthMm: 24 * IN,
    heightMm: 12 * IN,
    prims: [
      { k: "line", pts: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], pen: "wide" },
      { k: "line", pts: [[0, 0], [1, 1]], pen: "thin" },
      { k: "line", pts: [[0, 1], [1, 0]], pen: "thin" },
    ],
  },
  {
    id: "duct_round_section",
    name: "Round duct, cut",
    category: "duct",
    widthMm: 12 * IN,
    heightMm: 12 * IN,
    prims: [
      { k: "circle", c: [0.5, 0.5], r: 0.5, pen: "wide" },
      { k: "line", pts: [[0.15, 0.15], [0.85, 0.85]], pen: "thin" },
      { k: "line", pts: [[0.15, 0.85], [0.85, 0.15]], pen: "thin" },
    ],
  },
  {
    id: "flex_duct",
    name: "Flexible duct",
    category: "duct",
    widthMm: 48 * IN,
    heightMm: 8 * IN,
    linear: true,
    prims: [
      { k: "line", pts: wave(12, 0.08, 0.06), pen: "medium" },
      { k: "line", pts: wave(12, 0.92, -0.06), pen: "medium" },
      ...Array.from({ length: 12 }, (_, i): SymbolPrim => ({ k: "line", pts: [[(i + 0.5) / 12, 0.08], [(i + 0.5) / 12, 0.92]], pen: "thin" })),
    ],
  },
  {
    id: "pipe_section_insulated",
    name: "Pipe with insulation, cut",
    category: "pipe",
    widthMm: 4 * IN,
    heightMm: 4 * IN,
    prims: [
      { k: "circle", c: [0.5, 0.5], r: 0.5, pen: "thin" },
      { k: "circle", c: [0.5, 0.5], r: 0.25, pen: "wide" },
    ],
  },
  {
    id: "threaded_rod",
    name: "Threaded rod",
    category: "supports",
    widthMm: 36 * IN,
    heightMm: 0.375 * IN,
    linear: true,
    prims: [
      { k: "line", pts: [[0, 0.5], [1, 0.5]], pen: "medium" },
      ...Array.from({ length: 24 }, (_, i): SymbolPrim => ({ k: "line", pts: [[i / 24, 0], [(i + 0.5) / 24, 1]], pen: "thin" })),
    ],
  },
  {
    id: "trapeze_hanger",
    name: "Trapeze hanger (strut and rods)",
    category: "supports",
    widthMm: 30 * IN,
    heightMm: 18 * IN,
    prims: [
      { k: "line", pts: [[0.08, 1], [0.08, 0.12]], pen: "medium" },
      { k: "line", pts: [[0.92, 1], [0.92, 0.12]], pen: "medium" },
      { k: "line", pts: [[0, 0.12], [1, 0.12], [1, 0], [0, 0], [0, 0.12]], pen: "wide" },
      { k: "fill", pts: [[0.04, 0.16], [0.12, 0.16], [0.12, 0.12], [0.04, 0.12]], grey: 0 },
      { k: "fill", pts: [[0.88, 0.16], [0.96, 0.16], [0.96, 0.12], [0.88, 0.12]], grey: 0 },
    ],
  },
  {
    id: "strap_hanger",
    name: "Strap hanger",
    category: "supports",
    widthMm: 24 * IN,
    heightMm: 18 * IN,
    prims: [
      { k: "line", pts: [[0, 1], [0, 0], [1, 0], [1, 1]], pen: "medium" },
      { k: "circle", c: [0, 0.85], r: 0.02, pen: "thin" },
      { k: "circle", c: [1, 0.85], r: 0.02, pen: "thin" },
    ],
  },
  {
    id: "strut_channel",
    name: "Strut channel, section",
    category: "supports",
    widthMm: 1.625 * IN,
    heightMm: 1.625 * IN,
    prims: [{ k: "line", pts: [[0.3, 1], [0, 1], [0, 0], [1, 0], [1, 1], [0.7, 1]], pen: "wide" }],
  },
  {
    id: "gate_valve",
    name: "Gate valve",
    category: "valves",
    widthMm: 6 * IN,
    heightMm: 6 * IN,
    prims: [
      { k: "line", pts: [[0, 0.2], [1, 0.8], [1, 0.2], [0, 0.8], [0, 0.2]], pen: "medium" },
      { k: "line", pts: [[0.5, 0.5], [0.5, 1]], pen: "medium" },
      { k: "line", pts: [[0.35, 1], [0.65, 1]], pen: "medium" },
    ],
  },
  {
    id: "ball_valve",
    name: "Ball valve",
    category: "valves",
    widthMm: 6 * IN,
    heightMm: 6 * IN,
    prims: [
      { k: "line", pts: [[0, 0.2], [1, 0.8], [1, 0.2], [0, 0.8], [0, 0.2]], pen: "medium" },
      { k: "circle", c: [0.5, 0.5], r: 0.12, pen: "medium" },
    ],
  },
  {
    id: "check_valve",
    name: "Check valve",
    category: "valves",
    widthMm: 6 * IN,
    heightMm: 6 * IN,
    prims: [
      { k: "line", pts: [[0, 0.2], [1, 0.8], [1, 0.2], [0, 0.8], [0, 0.2]], pen: "medium" },
      { k: "fill", pts: [[0.5, 0.5], [1, 0.8], [1, 0.2]], grey: 0 },
    ],
  },
  {
    id: "concrete_anchor",
    name: "Concrete anchor",
    category: "anchors",
    widthMm: 1 * IN,
    heightMm: 4 * IN,
    prims: [
      { k: "line", pts: [[0.5, 1], [0.5, 0.1]], pen: "medium" },
      { k: "line", pts: [[0.1, 0.3], [0.5, 0.1], [0.9, 0.3]], pen: "medium" },
      { k: "line", pts: [[0, 1], [1, 1]], pen: "wide" },
    ],
  },
  {
    id: "beam_clamp",
    name: "Beam clamp",
    category: "anchors",
    widthMm: 3 * IN,
    heightMm: 3 * IN,
    prims: [
      { k: "line", pts: [[0, 1], [1, 1], [1, 0.4], [0.6, 0.4], [0.6, 0.7], [0, 0.7], [0, 1]], pen: "medium" },
      { k: "line", pts: [[0.8, 0.4], [0.8, 0]], pen: "medium" },
    ],
  },
  {
    id: "steel_angle",
    name: "Steel angle, section",
    category: "structure",
    widthMm: 3 * IN,
    heightMm: 3 * IN,
    prims: [{ k: "fill", pts: [[0, 0], [1, 0], [1, 0.1], [0.1, 0.1], [0.1, 1], [0, 1]], grey: 0 }],
  },
  {
    id: "break_line",
    name: "Break line (with cut-side whiteout mask)",
    category: "annotation",
    widthMm: 24 * IN,
    heightMm: 4 * IN,
    linear: true,
    prims: [
      // Opaque paper-white cut mask following the exact zig-zag profile on the +Y (left) side
      // so the masked half of any wall/deck/duct is cleanly wiped out right up to the zig-zag teeth.
      {
        k: "fill",
        pts: [
          [0, 0.5],
          [0.42, 0.5],
          [0.46, 0.95],
          [0.54, 0.05],
          [0.58, 0.5],
          [1, 0.5],
          [1, 2.2],
          [0, 2.2],
        ],
        grey: 1,
      },
      { k: "line", pts: [[0, 0.5], [0.42, 0.5], [0.46, 0.95], [0.54, 0.05], [0.58, 0.5], [1, 0.5]], pen: "thin" },
    ],
  },
  {
    id: "flow_arrow",
    name: "Direction arrow",
    category: "annotation",
    widthMm: 8 * IN,
    heightMm: 3 * IN,
    prims: [
      { k: "line", pts: [[0, 0.5], [0.68, 0.5]], pen: "medium" },
      { k: "fill", pts: [[1, 0.5], [0.62, 0.88], [0.62, 0.12]], grey: 0 },
    ],
  },
  {
    id: "centerline_mark",
    name: "Centreline symbol (CL)",
    category: "annotation",
    widthMm: 3 * IN,
    heightMm: 4 * IN,
    prims: [
      { k: "line", pts: [[0.56, 0.95], [0.22, 0.95], [0.06, 0.78], [0.06, 0.42], [0.22, 0.25], [0.56, 0.25]], pen: "thin" },
      { k: "line", pts: [[0.44, 0.72], [0.44, 0.05], [0.94, 0.05]], pen: "thin" },
    ],
  },
  {
    id: "slope_arrow",
    name: "Slope indicator arrow",
    category: "annotation",
    widthMm: 12 * IN,
    heightMm: 3 * IN,
    prims: [
      { k: "line", pts: [[0, 0.5], [0.8, 0.5]], pen: "thin" },
      { k: "fill", pts: [[1, 0.5], [0.74, 0.85], [0.74, 0.15]], grey: 0 },
    ],
  },
  {
    id: "section_cut_arrow",
    name: "Section direction arrow",
    category: "annotation",
    widthMm: 6 * IN,
    heightMm: 6 * IN,
    prims: [
      { k: "fill", pts: [[0.5, 1], [0.1, 0.35], [0.9, 0.35]], grey: 0 },
      { k: "line", pts: [[0.5, 0.35], [0.5, 0]], pen: "wide" },
    ],
  },
];

/** The kernel's own detail components (valves, hangers, sections). A pack's symbols join them through `detailComponents()`. */
export const DETAIL_COMPONENTS: readonly Symbol2D[] = MECHANICAL_COMPONENTS;

const BY_ID: ReadonlyMap<string, Symbol2D> = new Map(DETAIL_COMPONENTS.map((s) => [s.id, s]));

/** Every detail component a drawing can place now: the kernel's, then the symbols of the registry in force (a pack's, a firm's), in their drafting form. */
export function detailComponents(): readonly Symbol2D[] {
  const rows = activeSymbolRegistry().rows;
  return rows.length === 0 ? DETAIL_COMPONENTS : [...DETAIL_COMPONENTS, ...rows.map(draftingFormOf)];
}

/** A detail component by id: a symbol registry row (the electrical one-line symbols, a firm's or pack's rows), else a built-in mechanical component. */
export function detailComponent(id: string): Symbol2D | undefined {
  const row = symbolById(id);
  return row ? draftingFormOf(row) : BY_ID.get(id);
}

/** A symbol placed with its unit box's bottom-left at `origin` (or stretched origin→end for linear ones), in stored coordinates. */
function placeSymbol(sym: Symbol2D, origin: Vec2, placement: ComponentPlacement, end?: Vec2): (p: readonly [number, number]) => Vec2 {
  const w = end ? len(sub(end, origin)) : (placement.widthMm ?? sym.widthMm);
  const h = placement.heightMm ?? sym.heightMm;
  const angle = end ? Math.atan2(end.y - origin.y, end.x - origin.x) : ((placement.rotationDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Linear symbols sit centred on their line; boxed ones on their insertion point's bottom-left.
  const yShift = end || sym.linear ? -0.5 : 0;
  return ([u, v]) => {
    const x = (placement.mirror ? 1 - u : u) * w;
    const y = (v + yShift) * h;
    return { x: origin.x + x * c - y * s, y: origin.y + x * s + y * c };
  };
}

function drawSymbol(prims: Primitive[], sym: Symbol2D, map: (p: readonly [number, number]) => Vec2, toPaper: (p: Vec2) => Vec2, scaleHint: number): void {
  for (const prim of sym.prims) {
    if (prim.k === "line") {
      const pts = prim.pts.map((p) => toPaper(map(p)));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (a && b) prims.push({ kind: "line", a, b, pen: prim.pen ?? "medium", ...(prim.pattern && PATTERN_DASH[prim.pattern] ? { dash: PATTERN_DASH[prim.pattern] } : {}) });
      }
    } else if (prim.k === "circle") {
      const center = map(prim.c);
      const edge = map([prim.c[0] + prim.r, prim.c[1]]);
      const r = len(sub(edge, center));
      const pts = circlePoints(center, r, Math.max(8, Math.min(64, Math.round((r / scaleHint) * 4)))).map(toPaper);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (a && b) prims.push({ kind: "line", a, b, pen: prim.pen ?? "medium" });
      }
    } else {
      prims.push({ kind: "fill", points: prim.pts.map((p) => toPaper(map(p))), grey: prim.grey });
    }
  }
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function polyLines(prims: Primitive[], pts: readonly Vec2[], pen: Pen, dash: readonly number[] | undefined, tone?: Tone): void {
  const toneProp = tone && tone !== "ink" ? { tone } : {};
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b) prims.push({ kind: "line", a, b, pen, ...(dash ? { dash } : {}), ...toneProp });
  }
}

/**
 * The classic insulation batt: a looping curve (a prolate trochoid) that fills
 * the thickness `t` between the two faces along `a`→`b`, one loop per half
 * thickness of length.
 */
function battPath(a: Vec2, b: Vec2, t: number, unitsPerPaperMm = 1): Vec2[] {
  const l = len(sub(b, a));
  if (l < 1e-6 || t <= 0) return [];
  const u = mul(sub(b, a), 1 / l);
  const n = { x: -u.y, y: u.x };
  const r = t / 2;
  const loops = Math.max(1, Math.round(l / (t * 0.5)));
  const pitch = l / loops;
  const k = pitch / (2 * Math.PI);
  const out: Vec2[] = [];
  // Samples per loop follow the loop's size on paper: smooth when large, a few when it is a millimetre.
  const perLoop = Math.max(8, Math.min(24, Math.round((t / Math.max(unitsPerPaperMm, 1e-9)) * 3)));
  const steps = loops * perLoop;
  for (let i = 0; i <= steps; i++) {
    const theta = (2 * Math.PI * loops * i) / steps;
    // x = kθ + r(1 − cos θ)·0 keeps the ends on a and b; the sine term makes the loops.
    const along = Math.min(l, Math.max(0, k * theta - r * 0.6 * Math.sin(theta)));
    const across = -r * Math.cos(theta);
    out.push(add(add(a, mul(u, along)), mul(n, across)));
  }
  return out;
}

export interface DetailDrawContext {
  readonly toPaper: (p: Vec2) => Vec2;
  /** Owner units per paper mm (view scale; 1 on a sheet). */
  readonly scale: number;
  readonly prims: Primitive[];
}

/** Draw one detailing item (anything `itemPath`, regions, components, repeats, batts). Returns false when the item isn't one. */
export function drawDetailItem(ctx: DetailDrawContext, item: DrawingItem): boolean {
  const pen = item.lineStyle?.weight ?? (item.shape === "region" ? "thin" : "medium");
  const dash = item.lineStyle?.pattern ? PATTERN_DASH[item.lineStyle.pattern] : undefined;
  const tone = item.lineStyle?.tone;
  switch (item.shape) {
    case "arc":
    case "circle":
    case "polyline":
    case "spline": {
      const path = itemPath(item);
      if (path) polyLines(ctx.prims, path.map(ctx.toPaper), pen, dash, tone);
      return true;
    }
    case "region": {
      const path = itemPath(item);
      if (!path) return true;
      const paper = path.slice(0, -1).map(ctx.toPaper);
      const fill = item.fill ?? { pattern: "solid" as const };
      if (fill.masking) {
        ctx.prims.push({ kind: "fill", points: paper, grey: 1 });
        return true;
      }
      if (fill.pattern === "solid") ctx.prims.push({ kind: "fill", points: paper, grey: fill.grey ?? 0.8, ...(fill.tone ? { tone: fill.tone } : {}) });
      else ctx.prims.push({ kind: "fill", points: paper, grey: 1 });
      for (const [a, b, d] of hatchSegments(paper, fill.pattern, fill.spacingMm)) ctx.prims.push({ kind: "line", a, b, pen: "thin", ...(d ? { dash: d } : {}), ...(fill.tone ? { tone: fill.tone } : {}) });
      if (fill.boundary !== false) polyLines(ctx.prims, [...paper, ...(paper[0] ? [paper[0]] : [])], pen, dash, tone);
      return true;
    }
    case "component": {
      const at = item.points[0];
      const sym = item.component ? detailComponent(item.component.symbolId) : undefined;
      if (!at || !sym || !item.component) return true;
      const before = ctx.prims.length;
      drawSymbol(ctx.prims, sym, placeSymbol(sym, at, item.component), ctx.toPaper, ctx.scale);
      if ((tone && tone !== "ink") || dash) {
        for (let i = before; i < ctx.prims.length; i++) {
          const pr = ctx.prims[i]!;
          if (pr.kind === "line") ctx.prims[i] = { ...pr, ...(tone && tone !== "ink" ? { tone } : {}), ...(dash ? { dash } : {}) };
          else if (pr.kind === "fill" && tone && tone !== "ink") ctx.prims[i] = { ...pr, tone };
        }
      }
      return true;
    }
    case "repeat": {
      const [a, b] = item.points;
      const sym = item.component ? detailComponent(item.component.symbolId) : undefined;
      if (!a || !b || !sym || !item.component) return true;
      const l = len(sub(b, a));
      const spacing = item.component.spacingMm ?? item.component.widthMm ?? sym.widthMm;
      const u = mul(sub(b, a), 1 / (l || 1));
      const count = Math.min(500, Math.max(1, Math.floor(l / spacing + 1e-6)));
      const width = item.component.widthMm ?? Math.min(sym.widthMm, spacing);
      for (let i = 0; i < count; i++) {
        const origin = add(a, mul(u, i * spacing));
        drawSymbol(ctx.prims, sym, placeSymbol(sym, origin, { ...item.component, widthMm: width }, add(origin, mul(u, width))), ctx.toPaper, ctx.scale);
      }
      return true;
    }
    case "batt": {
      const [a, b] = item.points;
      if (!a || !b || !item.batt) return true;
      polyLines(ctx.prims, battPath(a, b, item.batt.thicknessMm, ctx.scale).map(ctx.toPaper), "thin", undefined);
      return true;
    }
    default:
      return false;
  }
}

/** The paper box of a detailing item (selection and collisions). */
export function detailItemBounds(item: DrawingItem, toPaper: (p: Vec2) => Vec2): { min: Vec2; max: Vec2 } | null {
  let pts: Vec2[] = [];
  if (item.shape === "component" && item.points[0] && item.component) {
    const sym = detailComponent(item.component.symbolId);
    if (sym) {
      const map = placeSymbol(sym, item.points[0], item.component);
      pts = ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map((p) => toPaper(map(p)));
    }
  } else if ((item.shape === "repeat" || item.shape === "batt") && item.points.length === 2) {
    const [a, b] = item.points;
    const h = item.shape === "batt" ? (item.batt?.thicknessMm ?? 0) : (item.component?.heightMm ?? detailComponent(item.component?.symbolId ?? "")?.heightMm ?? 0);
    if (a && b) {
      const l = len(sub(b, a)) || 1;
      const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
      pts = [add(a, mul(n, h / 2)), add(b, mul(n, h / 2)), sub(b, mul(n, h / 2)), sub(a, mul(n, h / 2))].map(toPaper);
    }
  } else {
    pts = (itemPath(item) ?? item.points).map(toPaper);
  }
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { min: { x: Math.min(...xs), y: Math.min(...ys) }, max: { x: Math.max(...xs), y: Math.max(...ys) } };
}
