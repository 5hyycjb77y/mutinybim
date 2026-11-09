import type { SheetImage } from "../annotation/figures";
import { elementValues, recordsOfKinds } from "../store";
import { scale } from "../geometry";
import { clipSegment, type ReferencePlan } from "../reference";
import type { LinkedReferenceModel } from "../reference-geometry/index-geometry";
import type { TextBlock } from "../annotation/text-note";
import type { BimElement, ElementId, ModelState, Vec2 } from "../types";
import { headlineKindValue, storedField } from "../kinds";
import { elementKindTable } from "../registry/element-kind-point";
import type { PlanGraphic } from "../registry/kind-row-faces";
import { dashOf, graphicSegments, penOf, planGraphicsContext, planGraphicsOf } from "./plan-graphics";
import { drawPartSymbol, drawRunFitting, drawRunSegment } from "./runs";

/** Paper-space drawing primitives, in millimetres, origin top-left, y down. */
export type Pen = "thin" | "medium" | "wide" | "heavy";

export const PEN_MM: Record<Pen, number> = { thin: 0.18, medium: 0.35, wide: 0.5, heavy: 0.7 };

/** Ink is the default; linked references print screened so native work reads first. */
export type Tone = "ink" | "halftone" | "screened";

/** Grey level (0 = black) per tone, shared by the SVG and PDF writers. */
export const TONE_GREY: Record<Tone, number> = { ink: 0, halftone: 0.5, screened: 0.68 };

/** Printed grey of a fill: its own grey, lifted toward white by the tone exactly as lines are. */
export function fillGrey(grey: number, tone: Tone | undefined): number {
  const g = Math.min(1, Math.max(0, grey));
  return g + (1 - g) * TONE_GREY[tone ?? "ink"];
}

/**
 * Optional print styling a firm's title block uses (`drawing/title-block`):
 * an ink colour (`#rrggbb`), a line width in paper mm that overrides the pen,
 * and a font from the scene's `fonts`. Absent everywhere else, so every other
 * drawing prints exactly as before. A monochrome print draws every colour black.
 */
export interface PrimitiveStyle {
  readonly color?: string;
  readonly widthMm?: number;
}

export type Primitive =
  | ({
      readonly kind: "line";
      readonly a: Vec2;
      readonly b: Vec2;
      readonly pen: Pen;
      readonly dash?: readonly number[];
      readonly tone?: Tone;
    } & PrimitiveStyle)
  | ({ readonly kind: "rect"; readonly at: Vec2; readonly size: Vec2; readonly pen: Pen } & PrimitiveStyle)
  /** A filled polygon with no outline (section poche, shaded surfaces). `grey`: 0 black, 1 white; a tone lightens it. `color` replaces the grey in colour; a monochrome print uses the grey. */
  | ({ readonly kind: "fill"; readonly points: readonly Vec2[]; readonly grey: number; readonly tone?: Tone } & Pick<PrimitiveStyle, "color">)
  | ({
      readonly kind: "text";
      readonly at: Vec2;
      readonly text: string;
      /** Cap height in paper mm. */
      readonly size: number;
      readonly anchor: "start" | "middle" | "end";
      readonly bold?: boolean;
      readonly tone?: Tone;
      /** Degrees, clockwise on paper, about `at` (a tag turned along its run). Absent: level. */
      readonly rotate?: number;
      /** A font id from the scene's `fonts`. Absent: the standard sheet font. */
      readonly font?: string;
    } & Pick<PrimitiveStyle, "color">);

/** A font a scene's text uses besides the standard sheet font: its id, family, weight and the file the writers load. */
export interface SceneFont {
  readonly id: string;
  readonly family: string;
  readonly weight: number;
  /** As the title block names it; the host's font source resolves it (a served path, a library file). */
  readonly file: string;
  /** Cap height as a fraction of the em (sizes text to its cap height). */
  readonly capHeight: number;
}

/** Paper line width of a line or rect: its own width, else its pen's. */
export function lineWidthMm(p: { readonly pen: Pen; readonly widthMm?: number }): number {
  return p.widthMm ?? PEN_MM[p.pen];
}

/** A model-linked annotation, re-resolved from its semantic anchor every build. */
export interface TagPlacement {
  readonly elementId: ElementId;
  readonly ref: "centerline_mid" | "insertion";
  readonly text: string;
  readonly at: Vec2;
}

/** A semantic anchor on a model element, re-resolved on every build (never a mesh index). */
export interface AnnotationRef {
  readonly elementId: string;
  /** start/end: segment ends; branch_centerline: a tap's centreline on its host; insertion: element position. */
  readonly ref: "start" | "end" | "branch_centerline" | "insertion";
}

/** A linear dimension between two anchors, measured along one axis. */
export interface DimensionSpec {
  readonly id: string;
  readonly from: AnnotationRef;
  readonly to: AnnotationRef;
  readonly axis: "x" | "y";
  /** Distance of the dimension line from the first anchor, in paper mm (negative = below/left). */
  readonly offsetMm: number;
}

export interface DimensionPlacement {
  readonly id: string;
  readonly text: string;
  readonly valueMm: number;
  readonly orphaned: boolean;
}

/** Firm-standard content placed on the sheet (not model-linked), versioned by file hash. */
export interface PlacedDetail {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly file: string;
  readonly sha256: string;
  /** Frame on paper; the PDF writer embeds the detail's vector page inside it. */
  readonly at: Vec2;
  readonly size: Vec2;
}

export interface ScheduleRow {
  readonly mark: string;
  readonly description: string;
  readonly cfm: number;
}

export interface ReferenceStroke {
  readonly pen: Pen;
  readonly tone: Tone;
  readonly dash?: readonly number[];
}

/** A linked, read-only reference drawn under the native model in this viewport. */
export interface SheetReference {
  readonly plan: ReferencePlan;
  readonly pen: Pen;
  readonly tone: Tone;
  /**
   * Per-layer strokes, looked up by `${kind}:${category}` then `${kind}`
   * (e.g. "cut:IFCWALL", "projection"). Layers with no entry use pen/tone.
   */
  readonly strokes?: Readonly<Record<string, ReferenceStroke>>;
  /** The linked elements this view's dimensions name, as the server read them (only those): printed dimensions follow them. */
  readonly linkedAnchors?: readonly LinkedReferenceModel[];
}

export function referenceStroke(ref: SheetReference, layer: { readonly kind: string; readonly category: string }): ReferenceStroke {
  return ref.strokes?.[`${layer.kind}:${layer.category}`] ?? ref.strokes?.[layer.kind] ?? { pen: ref.pen, tone: ref.tone };
}

export interface SheetDefinition {
  readonly number: string;
  readonly title: string;
  readonly projectName: string;
  readonly paper: Vec2;
  /** Viewport rectangle on paper. */
  readonly viewport: { readonly at: Vec2; readonly size: Vec2 };
  /** Model point shown at the viewport centre. */
  readonly viewCenter: Vec2;
  /** Model units per paper unit (48 = 1/4" = 1'-0"). */
  readonly scale: number;
  readonly scaleLabel: string;
  readonly scheduleAt: Vec2;
  readonly dimensions: readonly DimensionSpec[];
  readonly details: readonly PlacedDetail[];
  readonly references?: readonly SheetReference[];
  /** Viewport title; defaults to the sheet title. */
  readonly viewTitle?: string;
}

export interface SheetScene {
  readonly paper: Vec2;
  readonly revision: number;
  readonly primitives: readonly Primitive[];
  readonly tags: readonly TagPlacement[];
  readonly dimensions: readonly DimensionPlacement[];
  readonly details: readonly PlacedDetail[];
  readonly schedule: readonly ScheduleRow[];
  /** Notes, laid out once for screen and print (`annotation/text-note`). */
  readonly textBlocks?: readonly TextBlock[];
  /** Pictures placed on the sheet (`annotation/figures`); the screen and the PDF writer fetch their bytes from the host. */
  readonly images?: readonly SheetImage[];
  /** Fonts the scene's text names (a firm title block's); absent: the standard sheet font only. */
  readonly fonts?: readonly SceneFont[];
  /** Where an issued sheet's Verify code goes, paper mm (a library title block's QR slot). Absent: the built-in sheet-number box (`titleBlockCodeSlot`). */
  readonly codeSlot?: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
}

const INCH = 25.4;

/** ARCH D (36" x 24"), 1/4" = 1'-0". */
export function demoSheetDefinition(projectName = "MutinyBIM feasibility"): SheetDefinition {
  return {
    number: "M-101",
    title: "MECHANICAL PLAN - LEVEL 1",
    projectName,
    paper: { x: 36 * INCH, y: 24 * INCH },
    viewport: { at: { x: 25, y: 25 }, size: { x: 600, y: 380 } },
    viewCenter: { x: 16 * 304.8, y: 4 * 304.8 },
    scale: 48,
    scaleLabel: '1/4" = 1\'-0"',
    scheduleAt: { x: 25, y: 440 },
    dimensions: [
      { id: "dim-unit-to-branch-1", from: { elementId: "seg-trunk", ref: "start" }, to: { elementId: "tap-1", ref: "branch_centerline" }, axis: "x", offsetMm: -14 },
      { id: "dim-branch-1-to-branch-2", from: { elementId: "tap-1", ref: "branch_centerline" }, to: { elementId: "tap-2", ref: "branch_centerline" }, axis: "x", offsetMm: -14 },
    ],
    details: [
      {
        id: "detail-typ-branch-takeoff",
        number: "2",
        title: "TYPICAL RECTANGULAR BRANCH TAKEOFF",
        file: "typ-branch-takeoff.pdf",
        sha256: STANDARD_DETAIL_SHA256,
        at: { x: 260, y: 430 },
        size: { x: 180, y: 120 },
      },
    ],
  };
}

/** sha256 of packages/bim-sheets/details/typ-branch-takeoff.pdf (verified by the PDF writer). */
export const STANDARD_DETAIL_SHA256 = "3a7657a210e279fa566d5d73e662b6f806d9e67113d7cb102ece4dd70f835d47";

/** Feet-and-inches label, rounded to the nearest 1/2". */
export function feetInches(mm: number): string {
  const totalHalfInches = Math.round(Math.abs(mm) / 25.4 * 2);
  const feet = Math.floor(totalHalfInches / 24);
  const halfInches = totalHalfInches - feet * 24;
  const inches = halfInches / 2;
  const inchText = Number.isInteger(inches) ? String(inches) : `${Math.floor(inches)} 1/2`;
  return `${feet}'-${inchText}"`;
}

/** Resolve a semantic anchor to a model point, or null if the element or anchor is gone. */
export function resolveAnchor(model: ModelState, ref: AnnotationRef): Vec2 | null {
  const el = model.elements[ref.elementId];
  if (!el) return null;
  if (ref.ref === "insertion") return "position" in el ? el.position : null;
  // Segment ends and a hosted record's centreline on its host come from the add-on row that owns the kind.
  const ends = elementKindTable().row(el.kind)?.connectorEnds;
  if (!ends?.point) return null;
  if (ref.ref === "branch_centerline") {
    const hostField = ends.hostedBy?.field;
    const hostId = hostField !== undefined ? storedField(el, hostField) : undefined;
    const upstream = ends.ends.find((d) => d.role === "upstream");
    if (typeof hostId !== "string" || !model.elements[hostId] || !upstream) return null;
    return ends.point(el, upstream.end, model.elements);
  }
  return ends.ends.some((d) => d.end === ref.ref) ? ends.point(el, ref.ref, model.elements) : null;
}

/** `localeCompare(…, undefined, { numeric: true })` as one comparer: building one per comparison was most of a 30k-row sort. */
const MARK_ORDER = new Intl.Collator(undefined, { numeric: true });

/**
 * Schedule rows evaluated from model state at one revision (live display
 * path): the records of every kind whose row lists them
 * (`scheduleListing`), kinds in row order, each kind in stored order or by
 * mark, with its mark, type name and headline value.
 */
export function evaluateEquipmentSchedule(model: ModelState): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const table = elementKindTable();
  for (const kind of table.kinds) {
    const listing = table.row(kind)?.scheduleListing;
    if (listing === undefined) continue;
    const records = recordsOfKinds(model.elements, [kind]);
    const listed = records.map((el) => ({ el, mark: textField(el, "mark") }));
    if (listing === "by_mark") listed.sort((a, b) => MARK_ORDER.compare(a.mark, b.mark));
    for (const { el, mark } of listed) rows.push({ mark, description: textField(el, "typeName"), cfm: headlineKindValue(el, table)?.value ?? 0 });
  }
  return rows;
}

const textField = (el: object, name: string): string => {
  const v = storedField(el, name);
  return typeof v === "string" ? v : "";
};

export function buildSheetScene(model: ModelState, def: SheetDefinition): SheetScene {
  const prims: Primitive[] = [];
  const tags: TagPlacement[] = [];
  const toPaper = (p: Vec2): Vec2 => ({
    x: def.viewport.at.x + def.viewport.size.x / 2 + (p.x - def.viewCenter.x) / def.scale,
    y: def.viewport.at.y + def.viewport.size.y / 2 - (p.y - def.viewCenter.y) / def.scale,
  });
  const line = (a: Vec2, b: Vec2, pen: Pen, dash?: number[]) =>
    prims.push({ kind: "line", a: toPaper(a), b: toPaper(b), pen, dash });

  // Sheet border.
  prims.push({ kind: "rect", at: { x: 12.7, y: 12.7 }, size: { x: def.paper.x - 25.4, y: def.paper.y - 25.4 }, pen: "heavy" });

  // Linked references first, so native work prints over them.
  if (def.references?.length) drawReferences(prims, def, toPaper);

  const graphicsCtx = planGraphicsContext(model, { scale: def.scale, levelId: "", detail: "medium", drawing: "sheet" });
  for (const el of elementValues(model.elements)) {
    const graphics = planGraphicsOf(el, graphicsCtx);
    if (graphics) {
      drawSheetGraphics(el, graphics, def.scale, prims, tags, toPaper);
      continue;
    }
    switch (el.kind) {
      case "run_segment":
        drawRunSegment(model, el, line, (at, text, size) => {
          const paperAt = toPaper(at);
          tags.push({ elementId: el.id, ref: "centerline_mid", text, at: paperAt });
          prims.push({ kind: "text", at: paperAt, text, size, anchor: "middle" });
        }, def.scale);
        break;
      case "run_fitting":
        drawRunFitting(model, el, line);
        break;
      case "part":
        drawPartSymbol(model, el, line, (at, text, size) => prims.push({ kind: "text", at: toPaper(at), text, size, anchor: "middle" }));
        break;
      default:
        break;
    }
  }

  // Viewport title and scale bar (for print-scale verification).
  const vp = def.viewport;
  const titleY = vp.at.y + vp.size.y + 12;
  prims.push({ kind: "text", at: { x: vp.at.x, y: titleY }, text: `1  ${def.viewTitle ?? def.title}`, size: 4, anchor: "start", bold: true });
  prims.push({ kind: "text", at: { x: vp.at.x, y: titleY + 6 }, text: `SCALE: ${def.scaleLabel}`, size: 2.5, anchor: "start" });
  const barLen = (10 * 304.8) / def.scale;
  const barX = vp.at.x + 90;
  const barY = titleY + 4;
  prims.push({ kind: "line", a: { x: barX, y: barY }, b: { x: barX + barLen, y: barY }, pen: "heavy" });
  for (let ft = 0; ft <= 10; ft += 2) {
    const x = barX + (ft * 304.8) / def.scale;
    prims.push({ kind: "line", a: { x, y: barY - 1.5 }, b: { x, y: barY + 1.5 }, pen: "medium" });
  }
  prims.push({ kind: "text", at: { x: barX + barLen + 3, y: barY + 1 }, text: "10'-0\"", size: 2.5, anchor: "start" });

  const dimensions = def.dimensions.map((d) => drawDimension(prims, model, d, toPaper));
  for (const detail of def.details) drawDetailFrame(prims, detail);

  const schedule = evaluateEquipmentSchedule(model);
  drawSchedule(prims, def.scheduleAt, schedule);
  drawTitleBlock(prims, def, model.revision);

  return { paper: def.paper, revision: model.revision, primitives: prims, tags, dimensions, details: def.details, schedule };
}

export type LineFn = (a: Vec2, b: Vec2, pen: Pen, dash?: number[]) => void;

/** Reference linework clipped to the viewport's model extent; labels only when inside it. */
function drawReferences(prims: Primitive[], def: SheetDefinition, toPaper: (p: Vec2) => Vec2): void {
  const halfW = (def.viewport.size.x * def.scale) / 2;
  const halfH = (def.viewport.size.y * def.scale) / 2;
  const min = { x: def.viewCenter.x - halfW, y: def.viewCenter.y - halfH };
  const max = { x: def.viewCenter.x + halfW, y: def.viewCenter.y + halfH };
  drawReferenceLayers(prims, def.references ?? [], min, max, toPaper);
}

/** Linked-reference linework and labels inside the model window `min`..`max`. */
export function drawReferenceLayers(prims: Primitive[], references: readonly SheetReference[], min: Vec2, max: Vec2, toPaper: (p: Vec2) => Vec2): void {
  for (const ref of references) {
    for (const layer of ref.plan.layers) {
      const { pen, tone, dash } = referenceStroke(ref, layer);
      const s = layer.segments;
      for (let i = 0; i + 3 < s.length; i += 4) {
        const clipped = clipSegment({ x: s[i] ?? 0, y: s[i + 1] ?? 0 }, { x: s[i + 2] ?? 0, y: s[i + 3] ?? 0 }, min, max);
        if (!clipped) continue;
        prims.push(dash ? { kind: "line", a: toPaper(clipped[0]), b: toPaper(clipped[1]), pen, tone, dash } : { kind: "line", a: toPaper(clipped[0]), b: toPaper(clipped[1]), pen, tone });
      }
    }
    for (const label of ref.plan.labels) {
      if (label.at.x < min.x || label.at.x > max.x || label.at.y < min.y || label.at.y > max.y) continue;
      prims.push({ kind: "text", at: toPaper(label.at), text: label.text, size: 2, anchor: "middle", tone: ref.tone });
    }
  }
}

function drawDimension(prims: Primitive[], model: ModelState, d: DimensionSpec, toPaper: (p: Vec2) => Vec2): DimensionPlacement {
  const a = resolveAnchor(model, d.from);
  const b = resolveAnchor(model, d.to);
  if (!a || !b) {
    // Orphaned: the anchor no longer exists. Visible, never silently dropped.
    const at = toPaper(a ?? b ?? { x: 0, y: 0 });
    prims.push({ kind: "text", at, text: "?? DIMENSION REFERENCE MISSING", size: 2.5, anchor: "start", bold: true });
    return { id: d.id, text: "??", valueMm: 0, orphaned: true };
  }
  const valueMm = Math.abs(d.axis === "x" ? b.x - a.x : b.y - a.y);
  const pa = toPaper(a);
  const pb = toPaper(b);
  const text = feetInches(valueMm);
  if (d.axis === "x") {
    const y = pa.y - d.offsetMm;
    const ext = Math.sign(-d.offsetMm) || 1;
    prims.push({ kind: "line", a: { x: pa.x, y: pa.y + ext * 1.5 }, b: { x: pa.x, y: y + ext * 1.5 }, pen: "thin" });
    prims.push({ kind: "line", a: { x: pb.x, y: pb.y + ext * 1.5 }, b: { x: pb.x, y: y + ext * 1.5 }, pen: "thin" });
    prims.push({ kind: "line", a: { x: pa.x - 1.5, y }, b: { x: pb.x + 1.5, y }, pen: "thin" });
    for (const x of [pa.x, pb.x]) prims.push({ kind: "line", a: { x: x - 1, y: y + 1 }, b: { x: x + 1, y: y - 1 }, pen: "medium" });
    prims.push({ kind: "text", at: { x: (pa.x + pb.x) / 2, y: y - 1.2 }, text, size: 2.5, anchor: "middle" });
  } else {
    const x = pa.x + d.offsetMm;
    prims.push({ kind: "line", a: { x: pa.x, y: pa.y }, b: { x, y: pa.y }, pen: "thin" });
    prims.push({ kind: "line", a: { x: pb.x, y: pb.y }, b: { x, y: pb.y }, pen: "thin" });
    prims.push({ kind: "line", a: { x, y: pa.y }, b: { x, y: pb.y }, pen: "thin" });
    prims.push({ kind: "text", at: { x: x + 1.5, y: (pa.y + pb.y) / 2 }, text, size: 2.5, anchor: "start" });
  }
  return { id: d.id, text, valueMm, orphaned: false };
}

function drawDetailFrame(prims: Primitive[], d: PlacedDetail): void {
  prims.push({ kind: "rect", at: d.at, size: d.size, pen: "medium" });
  const titleY = d.at.y + d.size.y + 8;
  prims.push({ kind: "text", at: { x: d.at.x, y: titleY }, text: `${d.number}  ${d.title}`, size: 4, anchor: "start", bold: true });
  prims.push({ kind: "text", at: { x: d.at.x, y: titleY + 5.5 }, text: "SCALE: NONE   STANDARD DETAIL", size: 2.5, anchor: "start" });
}

/** One record's plan graphics on the sheet: linework, boxes and texts, and each labelled tag place as a tag and its text. */
function drawSheetGraphics(el: BimElement, graphics: readonly PlanGraphic[], viewScale: number, prims: Primitive[], tags: TagPlacement[], toPaper: (p: Vec2) => Vec2): void {
  for (const g of graphics) {
    switch (g.form) {
      case "line":
      case "polyline":
      case "arc": {
        const pen = penOf(g.pen);
        const dash = dashOf(g.dash);
        for (const [a, b] of graphicSegments(g)) prims.push({ kind: "line", a: toPaper(a), b: toPaper(b), pen, dash });
        break;
      }
      case "rect": {
        const half = scale(g.size, 0.5);
        const tl = toPaper({ x: g.center.x - half.x, y: g.center.y + half.y });
        prims.push({ kind: "rect", at: tl, size: { x: g.size.x / viewScale, y: g.size.y / viewScale }, pen: penOf(g.pen) });
        break;
      }
      case "text": {
        const placed = toPaper(g.at);
        const at = g.paperOffsetMm ? { x: placed.x + g.paperOffsetMm.x, y: placed.y + g.paperOffsetMm.y } : placed;
        prims.push({ kind: "text", at, text: g.text, size: g.heightMm, anchor: g.anchor ?? "start", ...(g.bold ? { bold: true } : {}), ...(g.rotationDeg ? { rotate: -g.rotationDeg } : {}) });
        break;
      }
      case "tag_place": {
        if (g.text === undefined) break;
        const at = toPaper(g.at);
        tags.push({ elementId: el.id, ref: g.ref ?? "insertion", text: g.text, at });
        prims.push({ kind: "text", at, text: g.text, size: g.heightMm ?? 2.5, anchor: g.anchor ?? "start", ...(g.bold ? { bold: true } : {}), ...(g.rotationDeg ? { rotate: -g.rotationDeg } : {}) });
        break;
      }
    }
  }
}

function drawSchedule(prims: Primitive[], at: Vec2, rows: readonly ScheduleRow[]): void {
  const cols = [25, 75, 25];
  const rowH = 7;
  const width = cols.reduce((a, b) => a + b, 0);
  prims.push({ kind: "text", at: { x: at.x, y: at.y - 3 }, text: "AIR DEVICE AND EQUIPMENT SCHEDULE", size: 3, anchor: "start", bold: true });
  const header = ["MARK", "DESCRIPTION", "CFM"];
  const allRows = [header, ...rows.map((r) => [r.mark, r.description, String(Math.round(r.cfm))])];
  allRows.forEach((cells, i) => {
    const y = at.y + i * rowH;
    prims.push({ kind: "line", a: { x: at.x, y }, b: { x: at.x + width, y }, pen: i <= 1 ? "medium" : "thin" });
    let x = at.x;
    cells.forEach((cell, j) => {
      const w = cols[j] ?? 25;
      prims.push({ kind: "text", at: { x: x + 1.5, y: y + 4.8 }, text: cell, size: 2.5, anchor: "start", bold: i === 0 });
      x += w;
    });
  });
  const bottom = at.y + allRows.length * rowH;
  prims.push({ kind: "line", a: { x: at.x, y: bottom }, b: { x: at.x + width, y: bottom }, pen: "medium" });
  let x = at.x;
  for (const w of [0, ...cols]) {
    x += w;
    prims.push({ kind: "line", a: { x, y: at.y }, b: { x, y: bottom }, pen: "thin" });
  }
}

function drawTitleBlock(prims: Primitive[], def: SheetDefinition, revision: number): void {
  const w = 100;
  const x = def.paper.x - 12.7 - w;
  const top = 12.7;
  const bottom = def.paper.y - 12.7;
  prims.push({ kind: "line", a: { x, y: top }, b: { x, y: bottom }, pen: "heavy" });
  const field = (y: number, label: string, value: string, size = 3.5) => {
    prims.push({ kind: "line", a: { x, y: y - 6 }, b: { x: x + w, y: y - 6 }, pen: "thin" });
    prims.push({ kind: "text", at: { x: x + 3, y: y - 1.5 }, text: label, size: 1.8, anchor: "start" });
    prims.push({ kind: "text", at: { x: x + 3, y: y + size + 1 }, text: value, size, anchor: "start", bold: true });
  };
  prims.push({ kind: "text", at: { x: x + w / 2, y: top + 14 }, text: "MUTINYBIM", size: 6, anchor: "middle", bold: true });
  field(top + 40, "PROJECT", def.projectName);
  field(top + 60, "SHEET TITLE", def.title, 3);
  field(bottom - 110, "SCALE", def.scaleLabel, 3);
  field(bottom - 90, "MODEL REVISION", `Rev ${revision}`, 3);
  field(bottom - 70, "STATUS", "FEASIBILITY - NOT FOR CONSTRUCTION", 2.5);
  prims.push({ kind: "line", a: { x, y: bottom - 45 }, b: { x: x + w, y: bottom - 45 }, pen: "medium" });
  prims.push({ kind: "text", at: { x: x + 3, y: bottom - 40 }, text: "SHEET NUMBER", size: 1.8, anchor: "start" });
  prims.push({ kind: "text", at: { x: x + w / 2, y: bottom - 14 }, text: def.number, size: 14, anchor: "middle", bold: true });
}
