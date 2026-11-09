/**
 * The live plan's symbol layer: the same plan graphics the printed drawing
 * draws (`planGraphicsOf`: a class's plan symbols, else the kind row's), for
 * the records the 3D cut can't show as a symbol. A door's swing and a
 * window's glass lines come from their classes' rows; a record with no body
 * (a home run, an add-on's arc) draws its kind row's lines; any text a row
 * places (a mark, a tag) comes along. Records whose body is already drawn and
 * whose class adds no symbol are left to the cut. Pure, no three.js: plan
 * model millimetres in, segments and texts out.
 */
import { activeClassRegistry, classPlanGraphicsFace, drawViewGraphics, elementValues, graphicSegments, kindRowOf, planGraphicsContext, planGraphicsOf, type BimElement, type ElementId, type ModelState, type PartInstance, type PlanGraphic, type PlanPen, type Primitive, type Vec2, type ViewElement } from "@permitzip/bim-kernel";
import { kernelToScene } from "./coords";

export interface LivePlanSegment {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly pen: PlanPen;
  readonly dashed: boolean;
  readonly halftone: boolean;
  readonly owner: string;
}

export interface LivePlanText {
  readonly at: Vec2;
  readonly text: string;
  /** Printed cap height, paper mm. */
  readonly heightMm: number;
  readonly rotationDeg: number;
  readonly owner: string;
}

export interface LivePlanSymbols {
  readonly segments: readonly LivePlanSegment[];
  readonly texts: readonly LivePlanText[];
}

export interface LivePlanOptions {
  /** The plan's level element id (the view's `level`), as the printed drawing passes it. */
  readonly levelId: string;
  readonly scale: number;
  readonly detail: "coarse" | "medium" | "fine";
  readonly lookingUp?: boolean;
  /** Partition levels drawn; null: every level (the same filter the live solids use). */
  readonly levels: ReadonlySet<string> | null;
  /** True when the live model already draws a body for this record. */
  readonly hasBody: (elementId: string) => boolean;
  /** Records the open view hides (category off, phase, group). */
  readonly hidden?: (elementId: string) => boolean;
  /**
   * The open plan view's settings (its view graphics switches and categories).
   * Absent: a plain plan of `levelId`. The view graphics rows in force (an
   * add-on's lines between the things a network connects) draw from it.
   */
  readonly view?: Pick<ViewElement, "props">;
}

/** Owner of the lines and texts the view graphics rows draw (they belong to the view, not to one record). */
export const VIEW_GRAPHICS_OWNER = "view_graphics";

/** The paper window the live plan gives the rows: unbounded, the live plan has no sheet edge. */
const NO_EDGE_MM = 1e9;

function planPen(pen: Extract<Primitive, { kind: "line" }>["pen"]): PlanPen {
  return pen === "heavy" ? "cut" : pen;
}

const EMPTY: LivePlanSymbols = { segments: [], texts: [] };

function levelOf(el: BimElement): string {
  return el.partition?.level ?? "L1";
}

/** Whether this record draws symbols on the live plan: its class has plan symbols, or nothing else shows it and its kind row draws it. */
function drawsSymbols(el: BimElement, model: ModelState, opts: LivePlanOptions): boolean {
  if (classPlanGraphicsFace(el, model.elements, activeClassRegistry())) return true;
  return !opts.hasBody(el.id) && kindRowOf(el.kind)?.planGraphics !== undefined;
}

function take(g: PlanGraphic, owner: string, segments: LivePlanSegment[], texts: LivePlanText[]): void {
  if (g.form === "text") {
    texts.push({ at: g.at, text: g.text, heightMm: g.heightMm, rotationDeg: g.rotationDeg, owner });
    return;
  }
  if (g.form === "tag_place") {
    if (g.text !== undefined && g.text.trim().length > 0) texts.push({ at: g.at, text: g.text, heightMm: g.heightMm ?? 2.5, rotationDeg: g.rotationDeg, owner });
    return;
  }
  const pen: PlanPen = g.pen;
  const dashed = "dash" in g && g.dash !== undefined && g.dash !== "solid";
  const halftone = "tone" in g && g.tone === "halftone";
  for (const [a, b] of graphicSegments(g)) segments.push({ a, b, pen, dashed, halftone, owner });
}

/** The plan symbols the live plan draws over its cut, for the records on its levels. */
export function livePlanSymbols(model: ModelState, opts: LivePlanOptions): LivePlanSymbols {
  const ctx = planGraphicsContext(model, { scale: opts.scale, levelId: opts.levelId, detail: opts.detail, drawing: "view", ...(opts.lookingUp !== undefined ? { lookingUp: opts.lookingUp } : {}) });
  const segments: LivePlanSegment[] = [];
  const texts: LivePlanText[] = [];
  for (const el of elementValues(model.elements)) {
    if (opts.levels && !opts.levels.has(levelOf(el))) continue;
    if (opts.hidden?.(el.id)) continue;
    if (!drawsSymbols(el, model, opts)) continue;
    const graphics = planGraphicsOf(el, ctx);
    if (!graphics) continue;
    for (const g of graphics) take(g, el.id, segments, texts);
  }
  liveViewGraphics(model, opts, segments, texts);
  return segments.length === 0 && texts.length === 0 ? EMPTY : { segments, texts };
}

/**
 * The view graphics rows in force (`drawViewGraphics`, the same call the
 * printed plan makes after its parts), drawn for the live plan: paper is the
 * plan at its scale with no sheet edge, mapped back to model millimetres. The
 * rows see the parts on the plan's levels that the view doesn't hide.
 */
function liveViewGraphics(model: ModelState, opts: LivePlanOptions, segments: LivePlanSegment[], texts: LivePlanText[]): void {
  const shown = new Map<string, PartInstance>();
  for (const el of elementValues(model.elements)) {
    if (el.kind !== "part") continue;
    if (opts.levels ? !opts.levels.has(levelOf(el)) : opts.levelId !== "" && levelOf(el) !== opts.levelId) continue;
    if (opts.hidden?.(el.id)) continue;
    shown.set(el.id, el);
  }
  if (shown.size === 0) return;
  const scale = opts.scale;
  const view: ViewElement = { id: "live-plan" as ElementId, kind: "view", version: 0, authoredRev: {}, name: "Live plan", viewType: opts.lookingUp ? "ceiling_plan" : "floor_plan", cropMin: { x: -NO_EDGE_MM, y: -NO_EDGE_MM }, cropMax: { x: NO_EDGE_MM, y: NO_EDGE_MM }, props: { level: opts.levelId, scale, ...(opts.view?.props ?? {}) } };
  const prims: Primitive[] = [];
  const toPaper = (p: Vec2): Vec2 => ({ x: p.x / scale, y: -p.y / scale });
  const toModel = (p: Vec2): Vec2 => ({ x: p.x * scale, y: -p.y * scale });
  drawViewGraphics({ model, view, shown, toPaper, scale, window: { min: { x: -NO_EDGE_MM, y: -NO_EDGE_MM }, max: { x: NO_EDGE_MM, y: NO_EDGE_MM } }, prims });
  for (const prim of prims) {
    if (prim.kind === "line") segments.push({ a: toModel(prim.a), b: toModel(prim.b), pen: planPen(prim.pen), dashed: prim.dash !== undefined && prim.dash.length > 0, halftone: prim.tone === "halftone", owner: VIEW_GRAPHICS_OWNER });
    else if (prim.kind === "text") texts.push({ at: toModel(prim.at), text: prim.text, heightMm: prim.size, rotationDeg: prim.rotate ?? 0, owner: VIEW_GRAPHICS_OWNER });
  }
}

/** Segment end points as one flat buffer in scene metres at `elevationMm`, for one `LineSegments` draw. */
export function symbolPositions(segments: readonly LivePlanSegment[], elevationMm: number): Float32Array {
  const out = new Float32Array(segments.length * 6);
  let i = 0;
  for (const s of segments) {
    for (const q of [s.a, s.b]) {
      const [x, y, z] = kernelToScene(q.x, q.y, elevationMm);
      out[i++] = x;
      out[i++] = y;
      out[i++] = z;
    }
  }
  return out;
}
