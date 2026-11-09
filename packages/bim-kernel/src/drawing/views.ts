import { disciplineCovers, disciplineDef } from "../disciplines/registry";
import { linkedAnchorModelsOf, withLinkedReferenceModels } from "../reference-geometry/linked-anchors";
import { siteOf } from "../site";
import { frameOverhang, type ViewportOverhang } from "../layout/sheet-layout";
import { NORTH_ARROW_RADIUS_MM, drawNorthArrow, viewRotationDeg, viewportNorthArrow } from "./north";
import { drawTitleBlock } from "./title-block";
import { withSheetFieldValues } from "../project-parameters";
import { DOCUMENT_ZONE, documentIndex, viewContentItems } from "../commands/views";
import { TEXT_WIDTH_PER_CHAR, effectiveCrop, rectCenter, viewWindow, windowPaperSize, type Rect } from "../crop";
import {
  DEFAULT_ANNOTATION_CROP_OFFSET_MM,
  DEFAULT_DETAIL_SCALE,
  DEFAULT_PLAN_SCALE,
  sheetPaperSize,
  scaleLabel,
  type CutPattern,
  type DetailLevel,
  type DrawingItem,
  type ViewCategory,
  type Viewport,
  type VisualStyle,
} from "../documents";
import { add, length, perp, scale, sub, unit } from "../geometry";
import { modelLevels, viewFloorMm, viewLevelNames, viewModelLevel } from "../levels";
import { spacesOnLevel } from "../spaces/space-index";
import { outlineAreaMm2, spaceOutlines } from "../spaces/space-geometry";
import { levelOf } from "../fields/providers/level-room";
import { anchorOf } from "../model";
import { noteDrawing, type TextBlock } from "../annotation/text-note";
import { figureFrame, figurePrimitives, type SheetImage } from "../annotation/figures";
import { forEachPartitionMember, partitionMembers } from "../partition";
import { displayContextOf, displayResolver, type DisplayResolver } from "../organization/model";
import { clipSegment } from "../reference";
import { applyReferenceDisplay, resolveReferenceDisplay } from "../reference-display";
import { elementValues } from "../store";
import { DEFAULT_PARTITION, type BimElement, type ModelState, type Sheet, type Vec2, type ViewElement } from "../types";
import { FaceIndex, cellFor, isoProjector, planProjector, projectSolid, sectionProjector, splitHidden, type Face, type ProjEdge, type ProjectedSolid, type Projector } from "./projection";
import { dashOf, graphicSegments, penOf, planGraphicsContext, planGraphicsOf } from "./plan-graphics";
import { kindRowOf, storedField } from "../kinds";
import { isKernelElementKind } from "../registry/element-kinds";
import type { PlanGraphic } from "../registry/kind-row-faces";
import {
  drawReferenceLayers,
  feetInches,
  type Pen,
  type Primitive,
  type SheetReference,
  type SheetScene,
  type TagPlacement,
  type Tone,
} from "./sheet";
import { sizeLabel } from "../routing/rules";
import { loadPointPosition, loadPointsOnHost } from "../load-points/model";
import { drawScheduleView } from "../schedules/view";
import { drawDimension, drawTag, type AnnotationDrawContext } from "../annotation/annotations";
import { PATTERN_DASH, categoryOf, drawDetailItem } from "../annotation/detailing";
import type { SheetRevision } from "../documents";
import { drawPartSymbol, drawRunFitting, drawRunSegment, systemLine } from "./runs";
import { INSULATION_DASH, insulationSectionCuts } from "./insulation";
import { insulationHiddenInView } from "../view-categories";
import { elementCategoryChain, elementLook, elementViewCategory } from "../categories/element";
import { draftingCategoryId } from "../categories/registry";
import { DEFAULT_LOOK, categoryLook, hasCategoryOverrides, lookTone, resolveChain, type CategoryLook } from "../categories/resolve";
import { SYSTEM_LINE_PATTERNS, SYSTEM_PATTERN_DASH } from "../routing/system-graphics";
import { elementSolid, hull2, kindHasBody, planPointsOf, type ElementSolid, type SolidRole } from "./solids";
import { cameraProjector, projectSolidInBox } from "./view3d-drawing";
import { boxAabb, boxKeepPlanes, boxOverRect, elementFloorMm, viewCropBox3d } from "../view3d";
import { drawViewGraphics } from "../layout/view-graphics-point";
import { drawCallout } from "../annotation/callouts";
import { typicalCopiesOf } from "../organization/typicals";
import { fieldBlockTextBlock, type FrozenBlocks } from "../blocks/sheet-block";
import { renderFieldBlock } from "../blocks/render";
import type { PartInstance } from "../types";
import type { Ceiling } from "../ceilings/types";
import { ceilingForm, ceilingHeightAtPoint, ceilingRole, ceilingSlope } from "../ceilings/read";

/**
 * Drawing views and sheets from the model's view, sheet, viewport and drawing
 * elements. Plans draw what is on their level inside the crop region; sections
 * cut walls, slabs and ducts along the cut line; 3D views draw an isometric
 * outline; detail views draw their own drawing-only linework. Sheets draw each
 * viewport at its scale plus the sheet's notes, lines, rectangles, clouds and
 * title block. The scene graph is the same one the SVG and PDF writers use.
 */

const FT = 304.8;

/** Linked-model linework per view id (cut on the server from the linked IFC at the view's level and cut height). */
export type ViewBackgrounds = Readonly<Record<string, readonly SheetReference[]>>;

export interface SheetDrawOptions {
  /** The project's name, printed as PROJECT unless the sheet's own `project_name` field says otherwise. */
  readonly projectName: string;
  /** The project's number, printed as PROJECT NO. unless the sheet's own `project_number` field says otherwise. */
  readonly projectNumber?: string;
  /** The firm named at the head of the title block, unless the sheet's own `firm_name` field says otherwise. */
  readonly firmName?: string;
  readonly backgrounds?: ViewBackgrounds;
  /** Issued copies: block id → the rendered value frozen at issue. Absent: live. */
  readonly frozenBlocks?: FrozenBlocks;
  /** A library title block's project address, state (picks the firm's registration number), owner and consultants by role, and seal statement; the sheet's own fields win. */
  readonly projectAddress?: string;
  readonly projectState?: string;
  readonly consultants?: Readonly<Record<string, string>>;
  readonly sealStatement?: string;
}

/** Where a view sits on paper: the frame centre and size, the scale, and the model point at the centre. */
export interface ViewFrame {
  readonly center: Vec2;
  readonly size: Vec2;
  readonly scale: number;
  /** In the view's own drawing frame: plan x/y, section along-cut/elevation, 3D isometric u/v. */
  readonly modelCenter: Vec2;
  /** Degrees counter-clockwise the drawing turns about `modelCenter` (true-north plans). Absent: 0. */
  readonly rotationDeg?: number;
  /** Paper size of the unturned window, when it differs from `size` (a turned plan's frame is the turned window's bounds). */
  readonly windowSize?: Vec2;
}

function turn(v: Vec2, deg: number): Vec2 {
  if (!deg) return v;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** A frame for a window at a scale, turned by `rotationDeg`: the frame on paper bounds the turned window. */
export function turnedFrame(center: Vec2, window: Rect, scale: number, rotationDeg: number): ViewFrame {
  const size = windowPaperSize(window, scale);
  const modelCenter = rectCenter(window);
  if (!rotationDeg) return { center, size, scale, modelCenter };
  const a = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return { center, size: { x: size.x * c + size.y * s, y: size.x * s + size.y * c }, scale, modelCenter, rotationDeg, windowSize: size };
}

export function viewScale(view: ViewElement): number {
  return view.props?.scale ?? (view.viewType === "detail" ? DEFAULT_DETAIL_SCALE : DEFAULT_PLAN_SCALE);
}

/** What the view shows (crop box, or all content with crop off) and its window in the view's drawing frame. */
export function viewCropAndWindow(model: ModelState, view: ViewElement): { crop: Rect; window: Rect } {
  const crop = effectiveCrop(model, view, viewContentItems(model, view));
  return { crop, window: viewWindow(view, crop) };
}

/** The view's model window centre in its own drawing frame. */
export function viewModelCenter(model: ModelState, view: ViewElement): Vec2 {
  return rectCenter(viewCropAndWindow(model, view).window);
}

export function modelToPaper(frame: ViewFrame, p: Vec2): Vec2 {
  const d = turn({ x: p.x - frame.modelCenter.x, y: p.y - frame.modelCenter.y }, frame.rotationDeg ?? 0);
  return { x: frame.center.x + d.x / frame.scale, y: frame.center.y - d.y / frame.scale };
}

export function paperToModel(frame: ViewFrame, p: Vec2): Vec2 {
  const d = turn({ x: (p.x - frame.center.x) * frame.scale, y: -(p.y - frame.center.y) * frame.scale }, -(frame.rotationDeg ?? 0));
  return { x: frame.modelCenter.x + d.x, y: frame.modelCenter.y + d.y };
}


interface Painter {
  readonly prims: Primitive[];
  /** Filled surfaces and poche, printed under the view's linework. */
  readonly fills: Primitive[];
  readonly tags: TagPlacement[];
  /** Model window in the view's drawing frame: linework is clipped to it. */
  readonly min: Vec2;
  readonly max: Vec2;
  /** Where notes, tags and dimension text may sit: the window, or past it by the annotation crop offset. */
  readonly noteMin: Vec2;
  readonly noteMax: Vec2;
  /** The plan crop (3D views filter what they draw by it). */
  readonly crop: Rect;
  readonly scale: number;
  readonly toPaper: (p: Vec2) => Vec2;
  /** Notes drawn in this view, laid out (they print through the text writers, not as primitives). */
  readonly blocks: TextBlock[];
  /** Dash for the element being drawn (demolished, by the view's phase filter); undefined draws solid. */
  dash: readonly number[] | undefined;
}

function painter(prims: Primitive[], fills: Primitive[], tags: TagPlacement[], frame: ViewFrame, view: ViewElement, crop: Rect, blocks: TextBlock[]): Painter {
  const window = frame.windowSize ?? frame.size;
  const half = { x: (window.x * frame.scale) / 2, y: (window.y * frame.scale) / 2 };
  const min = sub(frame.modelCenter, half);
  const max = add(frame.modelCenter, half);
  const reach = view.props?.annotationCrop ? (view.props.annotationCropOffsetMm ?? DEFAULT_ANNOTATION_CROP_OFFSET_MM) * frame.scale : 0;
  return {
    prims,
    fills,
    tags,
    min,
    max,
    noteMin: { x: min.x - reach, y: min.y - reach },
    noteMax: { x: max.x + reach, y: max.y + reach },
    crop,
    scale: frame.scale,
    toPaper: (p) => modelToPaper(frame, p),
    blocks,
    dash: undefined,
  };
}

function lineIn(p: Painter, a: Vec2, b: Vec2, pen: Pen, tone: Tone, explicitDash?: readonly number[]): void {
  const dash = explicitDash ?? p.dash;
  const clipped = clipSegment(a, b, p.min, p.max);
  if (!clipped) return;
  const prim: Primitive = { kind: "line", a: p.toPaper(clipped[0]), b: p.toPaper(clipped[1]), pen, ...(tone !== "ink" ? { tone } : {}), ...(dash ? { dash } : {}) };
  p.prims.push(prim);
}

function inside(p: Painter, at: Vec2): boolean {
  return at.x >= p.noteMin.x && at.x <= p.noteMax.x && at.y >= p.noteMin.y && at.y <= p.noteMax.y;
}

/** The whole printed text (not just where it starts) lies where notes may sit, so nothing prints past the crop. */
function textFits(p: Painter, at: Vec2, text: string, size: number, anchor: "start" | "middle" | "end"): boolean {
  const w = text.length * size * TEXT_WIDTH_PER_CHAR * p.scale;
  const x0 = anchor === "start" ? at.x : anchor === "middle" ? at.x - w / 2 : at.x - w;
  return x0 >= p.noteMin.x && x0 + w <= p.noteMax.x && at.y >= p.noteMin.y && at.y + size * p.scale <= p.noteMax.y;
}

function textIn(p: Painter, at: Vec2, text: string, size: number, anchor: "start" | "middle" | "end", tone: Tone, bold = false): void {
  if (!textFits(p, at, text, size, anchor)) return;
  p.prims.push({ kind: "text", at: p.toPaper(at), text, size, anchor, ...(bold ? { bold } : {}), ...(tone !== "ink" ? { tone } : {}) });
}

function polygonIn(p: Painter, points: readonly Vec2[], pen: Pen, tone: Tone, dash?: readonly number[]): void {
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a && b) lineIn(p, a, b, pen, tone, dash);
  }
}

/** The view (Categories shown, Visibility/Graphics) switched this element's category off. */
function hidden(model: ModelState, view: ViewElement, el: BimElement): boolean {
  return !elementLook(model, view, el).visible;
}

/** The dash a category override's line pattern gives; undefined keeps the drawing's linework. */
function patternDash(look: CategoryLook): readonly number[] | undefined {
  const pattern = SYSTEM_LINE_PATTERNS.find((x) => x === look.pattern);
  return pattern === undefined ? undefined : SYSTEM_PATTERN_DASH[pattern];
}

/** Dash for elements a view's phase filter draws dashed (demolished, by default), paper mm. */
export const PHASE_DASH: readonly number[] = [2.5, 1.5];

/** The view's group and phase display for each element. */
function organizationDisplay(model: ModelState, view: ViewElement): DisplayResolver {
  return displayResolver(model, displayContextOf(view));
}

function disciplineTone(view: ViewElement, el: BimElement): Tone {
  const discipline = view.props?.discipline;
  if (!discipline) return "ink";
  // A view of a parent discipline (Fire protection) keeps its children (fire alarm and the rest) in ink.
  return disciplineCovers(discipline, (el.partition ?? DEFAULT_PARTITION).discipline) ? "ink" : "halftone";
}

/**
 * A plan drawn for one discipline leaves out the runs (segments and fittings)
 * of every other registered discipline that isn't an underlay (the building:
 * `DisciplineDef.underlay`). Another discipline's equipment stays, halftone,
 * because the plan's own work connects to it. An element with no partition,
 * or of a discipline this model's set doesn't register, is never left out.
 */
export function leftOutOfDisciplineView(view: Pick<ViewElement, "props">, el: BimElement): boolean {
  if (el.kind !== "run_segment" && el.kind !== "run_fitting") return false;
  const discipline = view.props?.discipline;
  const own = el.partition?.discipline;
  if (!discipline || !own || disciplineCovers(discipline, own)) return false;
  const def = disciplineDef(own);
  return def !== null && def.underlay !== true;
}

/** An element's tone: its category's halftone where the view sets one, otherwise by the view's discipline. */
function toneFor(model: ModelState, view: ViewElement, el: BimElement): Tone {
  return lookTone(elementLook(model, view, el), disciplineTone(view, el));
}

/**
 * Elements on the view's level (all of them when the view has none), read
 * through the shared partition index. The view's level matches every model
 * level on the same floor (name ignoring case and punctuation, or elevation),
 * so ductwork routed on "Level 1" draws in a plan of the linked storey "LEVEL 1".
 */
/** Model elements a view draws from: its level's (same-floor levels too), or everything when it has none. */
export function viewLevelElements(model: ModelState, view: ViewElement): BimElement[] {
  return levelElements(model, view);
}

function levelElements(model: ModelState, view: ViewElement): BimElement[] {
  const names = viewLevelNames(model, view.props?.level, view.props?.levelElevationMm);
  if (!names) return elementValues(model.elements);
  return partitionMembers(model, (p) => names.has(p.level));
}

/** Floor elevation a view draws from (the live canvas cuts from the same one); zero when nothing says. */
function viewFloor(model: ModelState, view: ViewElement): number {
  return viewFloorMm(model, view.props?.level, view.props?.levelElevationMm) ?? 0;
}

/** The floor an element stands on in a view that spans levels (a section, a 3D view): its own level's, else the view's. */
function ownFloor(model: ModelState, el: BimElement, fallbackMm: number): number {
  return levelOf(model.elements, el)?.elevationMm ?? fallbackMm;
}

/**
 * The heights a plan shows, absolute mm: from its bottom less the view depth
 * up to its top. Either end is null while the view sets none, so plans made
 * before the bottom and top existed draw exactly as they did.
 */
export function planHeightRange(view: Pick<ViewElement, "viewType" | "props">, floorMm: number): { readonly lowMm: number | null; readonly highMm: number | null } {
  const props = view.props ?? {};
  const isPlan = view.viewType === "floor_plan" || view.viewType === "ceiling_plan";
  if (!isPlan) return { lowMm: null, highMm: null };
  return {
    lowMm: props.viewBottomMm === undefined ? null : floorMm + props.viewBottomMm - (props.viewDepthMm ?? 0),
    highMm: props.viewTopMm === undefined ? null : floorMm + props.viewTopMm,
  };
}

/**
 * A plan's view range as one test, shared by the printed plan and the live
 * model so the two always agree: true when an element with a body lies wholly
 * below the view's bottom (less its depth) or wholly above its top. Null when
 * the view sets no range (every element on its levels shows).
 */
export function planViewRangeExcludes(model: ModelState, view: Pick<ViewElement, "viewType" | "props">): ((el: BimElement) => boolean) | null {
  const floor = viewFloorMm(model, view.props?.level, view.props?.levelElevationMm) ?? 0;
  const range = planHeightRange(view, floor);
  if (range.lowMm === null && range.highMm === null) return null;
  return (el) => {
    const z = elementHeightRange(model, el, floor);
    return z !== null && ((range.lowMm !== null && z[1] < range.lowMm) || (range.highMm !== null && z[0] > range.highMm));
  };
}

/** Touching a plan's range at one end is not reaching into it (a wall that stops at the floor above). */
const REACH_EPS_MM = 1;

/**
 * The heights a plan draws other levels' work from, absolute mm: its view
 * range where it sets one; otherwise from its floor up to the next level's
 * floor (or a storey's reach when it is the top level).
 */
export function planReachRange(model: ModelState, view: Pick<ViewElement, "viewType" | "props">): { readonly lowMm: number; readonly highMm: number } | null {
  const isPlan = view.viewType === "floor_plan" || view.viewType === "ceiling_plan";
  if (!isPlan || !view.props?.level) return null;
  const floor = viewFloorMm(model, view.props.level, view.props.levelElevationMm) ?? 0;
  const range = planHeightRange(view, floor);
  let next = Infinity;
  for (const l of modelLevels(model)) if (l.elevationMm > floor + REACH_EPS_MM && l.elevationMm < next) next = l.elevationMm;
  return { lowMm: range.lowMm ?? floor, highMm: range.highMm ?? (Number.isFinite(next) ? next : floor + STOREY_REACH_MM) };
}

/**
 * Elements standing on other levels that reach into a plan's height range:
 * RTUs hosted on "ROOF LOW POINT" show on the ROOF plan. Read through the
 * partition index, never the whole model: only the levels whose floor lies
 * inside the range, and the one level just below it (what stands on it rises
 * into the range), are opened; then each candidate's own heights decide,
 * read from a cache that lives as long as the element record does.
 */
export function otherLevelElementsInRange(model: ModelState, view: Pick<ViewElement, "viewType" | "props">): BimElement[] {
  return otherLevelReach(model, view).map((x) => x.el);
}

/**
 * An element's heights by its record, with what else they were read from: the
 * floor of its level (a level that moves gets a new floor) and its type's
 * record (a type made taller is a new record). Records never change in place.
 */
const HEIGHTS = new WeakMap<BimElement, { readonly floorMm: number; readonly type: BimElement | undefined; readonly z: readonly [number, number] | null }>();

function cachedHeightRange(model: ModelState, el: BimElement, floorMm: number): readonly [number, number] | null {
  const type = "typeId" in el && typeof el.typeId === "string" ? model.elements[el.typeId] : undefined;
  const held = HEIGHTS.get(el);
  if (held && held.floorMm === floorMm && held.type === type) return held.z;
  const z = elementHeightRange(model, el, floorMm);
  HEIGHTS.set(el, { floorMm, type, z });
  return z;
}

/** Each element with the floor of the level it stands on (legacy walls and columns are placed from it). */
function otherLevelReach(model: ModelState, view: Pick<ViewElement, "viewType" | "props">): Array<{ readonly el: BimElement; readonly floorMm: number }> {
  const reach = planReachRange(model, view);
  if (!reach) return [];
  const own = viewLevelNames(model, view.props?.level, view.props?.levelElevationMm) ?? new Set<string>();
  const others = modelLevels(model).filter((l) => !own.has(l.name));
  let below = -Infinity;
  for (const l of others) if (l.elevationMm <= reach.lowMm + REACH_EPS_MM && l.elevationMm > below) below = l.elevationMm;
  const floors = new Map<string, number>();
  for (const l of others) if (l.elevationMm <= reach.highMm && l.elevationMm >= below) floors.set(l.name, l.elevationMm);
  if (floors.size === 0) return [];
  const out: Array<{ el: BimElement; floorMm: number }> = [];
  forEachPartitionMember(
    model,
    (p) => p.zone !== DOCUMENT_ZONE && floors.has(p.level),
    (el) => {
      const floorMm = floors.get((el.partition ?? DEFAULT_PARTITION).level);
      if (floorMm === undefined) return;
      const z = cachedHeightRange(model, el, floorMm);
      if (z !== null && z[1] > reach.lowMm + REACH_EPS_MM && z[0] < reach.highMm - REACH_EPS_MM) out.push({ el, floorMm });
    },
  );
  return out;
}

/** What a plan draws: its level's elements, then other levels' work within its height range. */
export function planElements(model: ModelState, view: ViewElement): BimElement[] {
  const others = otherLevelElementsInRange(model, view);
  const own = levelElements(model, view);
  return others.length === 0 ? own : [...own, ...others];
}

/** Lowest and highest point of an element with a body, mm; null for drafting-like kinds that always draw on their level. */
function elementHeightRange(model: ModelState, el: BimElement, floorMm: number): [number, number] | null {
  if (!kindHasBody(el.kind)) return null;
  const solid = elementSolid(model, el, floorMm);
  if (!solid) return null;
  let lo = Infinity;
  let hi = -Infinity;
  const take = (z: number) => {
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  };
  for (const piece of solid.pieces) for (const q of [...piece.r0, ...piece.r1]) take(q.z);
  if (solid.mesh) for (let i = 2; i < solid.mesh.positions.length; i += 3) take(solid.mesh.positions[i] ?? 0);
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/** Margin around the window for the quick reject, so ducts and labels straddling the crop edge still draw (and clip). */
const REJECT_MARGIN_MM = 10 * FT;

/** Cheap test before drawing: can any part of this element fall inside the window? */
function nearWindow(p: Painter, el: BimElement): boolean {
  const minX = p.min.x - REJECT_MARGIN_MM;
  const minY = p.min.y - REJECT_MARGIN_MM;
  const maxX = p.max.x + REJECT_MARGIN_MM;
  const maxY = p.max.y + REJECT_MARGIN_MM;
  if ("start" in el && "end" in el) {
    return !(Math.max(el.start.x, el.end.x) < minX || Math.min(el.start.x, el.end.x) > maxX || Math.max(el.start.y, el.end.y) < minY || Math.min(el.start.y, el.end.y) > maxY);
  }
  if ("position" in el) return el.position.x >= minX && el.position.x <= maxX && el.position.y >= minY && el.position.y <= maxY;
  if ("outline" in el) return el.outline.some((q) => q.x >= minX && q.x <= maxX && q.y >= minY && q.y <= maxY);
  return true;
}

// ── Display settings ─────────────────────────────────────────────────────────

/** What a view's display settings resolve to, with defaults applied. */
interface Display {
  readonly style: VisualStyle;
  readonly detail: DetailLevel;
  readonly cutPattern: CutPattern;
  /** Hidden edges of this category draw dashed (otherwise they are removed). */
  dashed(category: ViewCategory | null): boolean;
  /** The pen for a category (and, with an owner, that element's own category line), where cut or seen beyond. */
  pen(category: ViewCategory | null, kind: "cut" | "projection", fallback: Pen, owner?: string): Pen;
  /** The element look for an owner drawn as a solid of `category` (sections and 3D). */
  lookOf(owner: string, category: ViewCategory | null): CategoryLook;
  /** Remember an element drawn as a solid, so its own category overrides reach its pens. */
  note(el: BimElement): void;
}

function displayOf(model: ModelState, view: ViewElement): Display {
  const props = view.props ?? {};
  const all = props.showHiddenLines === true;
  const some = new Set<ViewCategory>(props.hiddenLineCategories ?? []);
  // Without per-category overrides, a solid's look is its drawing category's (the older fields), exactly as before.
  const overrides = hasCategoryOverrides(view);
  const owners = new Map<string, BimElement>();
  const lookOf = (owner: string, category: ViewCategory | null): CategoryLook => {
    const el = overrides ? owners.get(owner) : undefined;
    if (!el) return category === null ? DEFAULT_LOOK : categoryLook(view, category);
    const chain = elementCategoryChain(model.elements, el);
    return resolveChain(view, category === null || chain.includes(category) ? chain : [...chain, category]);
  };
  return {
    style: props.visualStyle ?? "hidden_line",
    detail: props.detailLevel ?? "medium",
    cutPattern: props.cutPattern ?? "cross",
    dashed: (c) => all || (c !== null && some.has(c)),
    pen: (c, kind, fallback, owner) => (owner !== undefined ? lookOf(owner, c) : c ? categoryLook(view, c) : DEFAULT_LOOK).lineWeights[kind] ?? fallback,
    lookOf,
    note: (el) => {
      if (overrides) owners.set(el.id, el);
    },
  };
}

/** Dash for hidden edges, paper mm. */
export const HIDDEN_DASH: readonly number[] = [1.5, 1];
const hidesEdges = (s: VisualStyle) => s !== "wireframe";
const drawsEdges = (s: VisualStyle) => s !== "shaded";
const fillsFaces = (s: VisualStyle) => s === "shaded" || s === "shaded_edges";

/** Surface grey per role in shaded styles, before lighting. */
const ROLE_GREY: Readonly<Record<SolidRole, number>> = { mep: 0.72, equipment: 0.62, architecture: 0.86 };

function shade(role: SolidRole, light: number): number {
  return Math.min(0.95, ROLE_GREY[role] * (0.82 + 0.18 * light));
}

/** Clip a polygon to the painter's window (Sutherland–Hodgman); empty when it falls outside. */
function clipPolyToWindow(poly: readonly Vec2[], min: Vec2, max: Vec2): Vec2[] {
  let out = [...poly];
  const edges: Array<[(q: Vec2) => number, number]> = [
    [(q) => q.x - min.x, 0],
    [(q) => max.x - q.x, 0],
    [(q) => q.y - min.y, 0],
    [(q) => max.y - q.y, 0],
  ];
  for (const [d] of edges) {
    if (out.length === 0) break;
    const next: Vec2[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i] as Vec2;
      const b = out[(i + 1) % out.length] as Vec2;
      const da = d(a);
      const db = d(b);
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    out = next;
  }
  return out;
}

function fillIn(p: Painter, poly: readonly Vec2[], grey: number, tone: Tone): void {
  const clipped = clipPolyToWindow(poly, p.min, p.max);
  if (clipped.length < 3) return;
  p.fills.push({ kind: "fill", points: clipped.map((q) => p.toPaper(q)), grey, ...(tone !== "ink" ? { tone } : {}) });
}

/** Front faces filled farthest first, so nearer surfaces cover farther ones. */
function fillFaces(p: Painter, faces: readonly Face[], roleOf: (owner: string) => SolidRole, toneOf: (owner: string) => Tone): void {
  const sorted = [...faces].sort((a, b) => a.meanNear - b.meanNear);
  for (const f of sorted) fillIn(p, f.poly.map((q) => ({ x: q.u, y: q.v })), shade(roleOf(f.owner), f.light), toneOf(f.owner));
}

// ── Plans ────────────────────────────────────────────────────────────────────

/** One element's linework pen: (a, b, pen, dash). */
type PlanLine = (a: Vec2, b: Vec2, pen: Pen, dash?: number[]) => void;

/** A model element's linework, held until hidden lines are resolved. */
interface PendingLine {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly pen: Pen;
  readonly tone: Tone;
  readonly dash?: readonly number[];
  readonly owner: string;
  readonly category: ViewCategory | null;
}


function circleAt(c: Vec2, r: number, line: (a: Vec2, b: Vec2, pen: Pen) => void, pen: Pen): void {
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = ((i + 1) / n) * Math.PI * 2;
    line({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }, { x: c.x + r * Math.cos(b), y: c.y + r * Math.sin(b) }, pen);
  }
}

/** A load point on a run element's open end: a small circle at the end and its designator beside it (the "nub"). */
function drawLoadPoints(model: ModelState, hostId: string, line: (a: Vec2, b: Vec2, pen: Pen) => void, text: (at: Vec2, text: string, size: number) => void, scaleMm: number): void {
  for (const lp of loadPointsOnHost(model.elements, hostId)) {
    const at = loadPointPosition(model.elements, lp);
    if (!at) continue;
    const c = { x: at.point.x, y: at.point.y };
    const r = 1.2 * scaleMm;
    circleAt(c, r, line, "medium");
    const name = lp.mark || lp.connectionType;
    if (name) {
      const d = Math.hypot(at.direction.x, at.direction.y) > 0.1 ? unit({ x: at.direction.x, y: at.direction.y }) : { x: 1, y: 0 };
      text(add(c, scale(d, r + (1 + 0.6 * name.length) * scaleMm)), name, 2);
    }
  }
}

function drawPlan(model: ModelState, view: ViewElement, p: Painter, frame: ViewFrame, display: Display, shownParts: Map<string, PartInstance>): void {
  const ceiling = view.viewType === "ceiling_plan";
  const tagsShown = categoryLook(view, "tags").visible;
  // An element tagged in this view shows its tag, not the plan's own size label as well.
  const taggedHere = new Set((documentIndex(model).itemsByOwner.get(view.id) ?? []).flatMap((i) => (i.tag && !i.deleted ? [i.tag.elementId] : [])));
  const coarse = display.detail === "coarse";
  const pending: PendingLine[] = [];
  const bodies: BimElement[] = [];
  const floor = viewFloor(model, view);
  const shownAs = organizationDisplay(model, view);
  const outsideRange = planViewRangeExcludes(model, view);
  const graphicsCtx = planGraphicsContext(model, { scale: frame.scale, levelId: view.props?.level ?? "", detail: display.detail, drawing: "view", lookingUp: ceiling });
  // Other levels' work in this plan's height range, with the floor each stands on (already tested against the range).
  const reached = new Map<string, number>();
  const others: BimElement[] = [];
  for (const x of otherLevelReach(model, view)) {
    reached.set(x.el.id, x.floorMm);
    others.push(x.el);
  }
  const own = levelElements(model, view);
  for (const el of others.length === 0 ? own : [...own, ...others]) {
    if (!nearWindow(p, el)) continue;
    if (leftOutOfDisciplineView(view, el)) continue;
    const look = elementLook(model, view, el);
    if (!look.visible) continue;
    if (!reached.has(el.id) && outsideRange?.(el)) continue;
    const shown = shownAs(el);
    if (!shown.visible) continue;
    const tone = shown.halftone ? "halftone" : lookTone(look, disciplineTone(view, el));
    p.dash = shown.dashed ? PHASE_DASH : patternDash(look);
    const category = elementViewCategory(model.elements, el);
    const projectionPen = (pen: Pen): Pen => look.lineWeights.projection ?? pen;
    const elementDash = p.dash;
    const body = kindHasBody(el.kind);
    const lineToned = (lineTone: Tone): PlanLine => {
      const direct = (a: Vec2, b: Vec2, pen: Pen, dash?: number[]) => lineIn(p, a, b, projectionPen(pen), lineTone, dash);
      const held = (a: Vec2, b: Vec2, pen: Pen, dash?: number[]) => {
        const d = dash ?? elementDash;
        pending.push({ a, b, pen: projectionPen(pen), tone: lineTone, ...(d ? { dash: d } : {}), owner: el.id, category });
      };
      const drawn = body ? held : direct;
      return (a, b, pen, dash) => (dash !== INSULATION_DASH ? drawn(a, b, pen, dash) : insulationHiddenInView(view) ? undefined : drawn(a, b, display.pen("insulation", "projection", pen), dash));
    };
    // Looking up, the runs below the ceiling print screened.
    const line = lineToned(ceiling && el.kind === "run_segment" ? "halftone" : tone);
    if (body) bodies.push(el);
    const graphics = planGraphicsOf(el, graphicsCtx);
    if (graphics) {
      const showLabel = tagsShown && !taggedHere.has(el.id);
      drawPlanGraphics(p, el, graphics, { line, screened: lineToned("halftone") }, tone, showLabel, look.lineWeights.cut ?? "heavy");
      continue;
    }
    if (ownerNotLoaded(el)) {
      drawStoredOutline(el, lineToned("halftone"));
      continue;
    }
    switch (el.kind) {
      case "wall": {
        const n = perp(unit(sub(el.end, el.start)));
        const half = el.thickness / 2;
        const wallPen = look.lineWeights.cut ?? "heavy";
        lineIn(p, add(el.start, scale(n, half)), add(el.end, scale(n, half)), wallPen, tone);
        lineIn(p, add(el.start, scale(n, -half)), add(el.end, scale(n, -half)), wallPen, tone);
        lineIn(p, add(el.start, scale(n, half)), add(el.start, scale(n, -half)), wallPen, tone);
        lineIn(p, add(el.end, scale(n, half)), add(el.end, scale(n, -half)), wallPen, tone);
        break;
      }
      case "opening": {
        const half = el.width / 2;
        textIn(p, el.position, el.mark, 2, "middle", tone);
        lineIn(p, add(el.position, { x: -half, y: 0 }), add(el.position, { x: half, y: 0 }), "thin", tone);
        break;
      }
      case "room":
        textIn(p, centroidOf(el.outline), `${el.name.toUpperCase()} ${el.number}`, 2.5, "middle", tone);
        break;
      case "grid": {
        lineIn(p, el.start, el.end, "thin", tone, [6, 1.5, 1, 1.5]);
        textIn(p, el.start, el.label, 3.5, "middle", tone, true);
        break;
      }
      case "column": {
        const hx = el.size.x / 2;
        const hy = el.size.y / 2;
        const c = el.position;
        polygonIn(p, [add(c, { x: -hx, y: -hy }), add(c, { x: hx, y: -hy }), add(c, { x: hx, y: hy }), add(c, { x: -hx, y: hy })], look.lineWeights.cut ?? "heavy", tone);
        break;
      }
      case "tag": {
        if (inside(p, el.position)) {
          p.tags.push({ elementId: el.targetId, ref: "insertion", text: el.text, at: p.toPaper(el.position) });
          textIn(p, el.position, el.text, 2.5, "start", tone);
        }
        break;
      }
      case "dimension": {
        const a = model.elements[el.aId];
        const b = model.elements[el.bId];
        const pa = a ? anchorOf(a) : null;
        const pb = b ? anchorOf(b) : null;
        if (pa && pb) drawLinearDimension(p, pa, pb, el.offset, tone);
        break;
      }
      case "run_segment": {
        const label = tagsShown && !taggedHere.has(el.id)
          ? (at: Vec2, text: string, size: number) => {
              if (!inside(p, at)) return;
              p.tags.push({ elementId: el.id, ref: "centerline_mid", text, at: p.toPaper(at) });
              textIn(p, at, text, size, "middle", tone);
            }
          : null;
        if (coarse) {
          // Single line: the centreline; a drop or rise shows as a circle.
          const a = { x: el.start.x, y: el.start.y };
          const b = { x: el.end.x, y: el.end.y };
          const run = length(sub(b, a));
          const sys = systemLine(model, el.systemId);
          if (run < 0.01) circleAt(a, 3 * frame.scale / 2, line, "medium");
          else line(a, b, sys.weight ?? (el.domain === "duct" ? "wide" : "medium"), sys.dash);
          if (label && run / frame.scale > 25) label(add(scale(add(a, b), 0.5), scale(perp(unit(sub(b, a))), 6 * frame.scale)), sizeLabel(el.size), 2.5);
        } else {
          drawRunSegment(model, el, line, label, frame.scale);
        }
        drawLoadPoints(model, el.id, line, (at, text, size) => textIn(p, at, text, size, "middle", tone), frame.scale);
        break;
      }
      case "run_fitting":
        if (coarse) {
          for (const port of el.ports) line({ x: port.position.x, y: port.position.y }, { x: el.position.x, y: el.position.y }, el.domain === "duct" ? "wide" : "medium");
        } else {
          drawRunFitting(model, el, line, display.detail === "fine");
        }
        drawLoadPoints(model, el.id, line, (at, text, size) => textIn(p, at, text, size, "middle", tone), frame.scale);
        break;
      case "part":
        if (el.planned !== undefined) break;
        drawPartSymbol(model, el, line, (at, text, size) => textIn(p, at, text, size, "middle", tone), look.planSymbol, display.detail);
        shownParts.set(el.id, el);
        break;
      case "ceiling":
        // Looking up: a ceiling draws in a ceiling plan only (a floor plan's cut is below it).
        if (ceiling) drawCeilingOnPlan(p, el, look.lineWeights.projection ?? "medium", tone);
        break;
      default:
        break;
    }
  }
  p.dash = undefined;
  drawSpaceLabels(model, view, p, shownAs, taggedHere);

  // Hidden lines: element bodies seen from above (below for a ceiling plan).
  const style = display.style;
  if (!hidesEdges(style) && !fillsFaces(style)) {
    for (const l of pending) lineIn(p, l.a, l.b, l.pen, l.tone, l.dash);
    return;
  }
  const projector = planProjector(ceiling);
  const index = new FaceIndex(cellFor(p.min.x, p.min.y, p.max.x, p.max.y));
  const top = new Map<string, number>();
  const roles = new Map<string, SolidRole>();
  const tones = new Map<string, Tone>();
  const faces: Face[] = [];
  for (const el of bodies) {
    const solid = elementSolid(model, el, reached.get(el.id) ?? floor);
    if (!solid) continue;
    const projected = projectSolid(solid, projector);
    if (projected.faces.length === 0) continue;
    let nearest = -Infinity;
    for (const f of projected.faces) {
      index.add(f);
      faces.push(f);
      for (const q of f.poly) nearest = Math.max(nearest, q.near);
    }
    top.set(el.id, nearest);
    roles.set(el.id, solid.role);
    tones.set(el.id, shownAs(el).halftone ? "halftone" : toneFor(model, view, el));
  }
  if (fillsFaces(style)) fillFaces(p, faces, (o) => roles.get(o) ?? "mep", (o) => tones.get(o) ?? "ink");
  if (!drawsEdges(style)) return;
  for (const l of pending) {
    if (!hidesEdges(style)) {
      lineIn(p, l.a, l.b, l.pen, l.tone, l.dash);
      continue;
    }
    const near = top.get(l.owner) ?? Infinity;
    const split = splitHidden({ u: l.a.x, v: l.a.y, near }, { u: l.b.x, v: l.b.y, near }, index, () => near);
    for (const [a, b] of split.visible) lineIn(p, { x: a.u, y: a.v }, { x: b.u, y: b.v }, l.pen, l.tone, l.dash);
    if (display.dashed(l.category)) for (const [a, b] of split.hidden) lineIn(p, { x: a.u, y: a.v }, { x: b.u, y: b.v }, "thin", l.tone, HIDDEN_DASH);
  }
}

/**
 * One record's plan graphics (its kind row's `planGraphics`): seen linework
 * through the element's own line (projection weight, hidden-line hold, phase
 * dash), cut linework at the view's cut weight, boxes, texts, and each
 * labelled tag place as a tag when the view shows the record's own label.
 */
function drawPlanGraphics(
  p: Painter,
  el: BimElement,
  graphics: readonly PlanGraphic[],
  lines: { readonly line: PlanLine; readonly screened: PlanLine },
  tone: Tone,
  showLabel: boolean,
  cutPen: Pen,
): void {
  for (const g of graphics) {
    switch (g.form) {
      case "line":
      case "polyline":
      case "arc":
      case "rect": {
        const dash = g.form === "rect" ? undefined : dashOf(g.dash);
        const screened = (g.form === "line" || g.form === "polyline") && g.tone === "halftone";
        const line = screened ? lines.screened : lines.line;
        for (const [a, b] of graphicSegments(g)) {
          if (g.pen === "cut") lineIn(p, a, b, cutPen, screened ? "halftone" : tone, dash);
          else line(a, b, penOf(g.pen), dash);
        }
        break;
      }
      case "text":
        placedTextIn(p, g.at, g.text, g.heightMm, g.anchor ?? "start", tone, g.bold === true, g.rotationDeg, g.paperOffsetMm);
        break;
      case "tag_place": {
        if (g.text === undefined || !showLabel || !inside(p, g.at)) break;
        p.tags.push({ elementId: el.id, ref: g.ref ?? "insertion", text: g.text, at: p.toPaper(g.at) });
        placedTextIn(p, g.at, g.text, g.heightMm ?? 2.5, g.anchor ?? "start", tone, g.bold === true, g.rotationDeg, undefined);
        break;
      }
    }
  }
}

/** `textIn`, turned by `rotationDeg` (counter-clockwise in the model) and nudged on paper by `paperOffset`. */
function placedTextIn(p: Painter, at: Vec2, text: string, size: number, anchor: "start" | "middle" | "end", tone: Tone, bold: boolean, rotationDeg: number, paperOffset: Vec2 | undefined): void {
  if (!rotationDeg && !paperOffset) {
    textIn(p, at, text, size, anchor, tone, bold);
    return;
  }
  if (!textFits(p, at, text, size, anchor)) return;
  const placed = p.toPaper(at);
  const paperAt = paperOffset ? { x: placed.x + paperOffset.x, y: placed.y + paperOffset.y } : placed;
  p.prims.push({ kind: "text", at: paperAt, text, size, anchor, ...(bold ? { bold } : {}), ...(tone !== "ink" ? { tone } : {}), ...(rotationDeg ? { rotate: -rotationDeg } : {}) });
}

/** A record of an add-on that isn't loaded here: its kind is no kernel kind and no row in force names it. */
function ownerNotLoaded(el: BimElement): boolean {
  return !isKernelElementKind(el.kind) && kindRowOf(el.kind) === undefined;
}

const isPoint = (v: unknown): v is Vec2 => typeof v === "object" && v !== null && typeof Reflect.get(v, "x") === "number" && typeof Reflect.get(v, "y") === "number";

const UNLOADED_MARK_HALF_MM = 150;

/**
 * What a plan keeps of a record whose add-on isn't loaded: its stored
 * outline, screened, from the fields every placed record keeps (a run's
 * `start` and `end`, a box's `position` and `size`, a point's `position`, an
 * `outline`). Nothing is read from the add-on's own values.
 */
function drawStoredOutline(el: BimElement, line: PlanLine): void {
  const start = storedField(el, "start");
  const end = storedField(el, "end");
  if (isPoint(start) && isPoint(end)) {
    line(start, end, "medium");
    return;
  }
  const outline = storedField(el, "outline");
  if (Array.isArray(outline) && outline.length >= 3 && outline.every(isPoint)) {
    for (const [a, b] of graphicSegments({ form: "polyline", points: outline, closed: true, pen: "thin" })) line(a, b, "thin");
    return;
  }
  const position = storedField(el, "position");
  if (!isPoint(position)) return;
  const size = storedField(el, "size");
  const box = isPoint(size) ? size : { x: 2 * UNLOADED_MARK_HALF_MM, y: 2 * UNLOADED_MARK_HALF_MM };
  for (const [a, b] of graphicSegments({ form: "rect", center: position, size: box, pen: "thin" })) line(a, b, "thin");
}

/** Typicals' copies (their parts, in place) and the plan's circuit lines, home runs and switch legs, over the model. */
function drawPlanConnections(model: ModelState, view: ViewElement, p: Painter, shownParts: Map<string, PartInstance>): void {
  for (const copy of typicalCopiesOf(model, shownParts.values())) {
    const look = elementLook(model, view, copy);
    const tone = lookTone(look, disciplineTone(view, copy));
    drawPartSymbol(model, copy, (a, b, pen) => lineIn(p, a, b, pen, tone), (at, text, size) => textIn(p, at, text, size, "middle", tone), look.planSymbol);
  }
  const lo = p.toPaper({ x: p.min.x, y: p.max.y });
  const hi = p.toPaper({ x: p.max.x, y: p.min.y });
  const window = { min: { x: Math.min(lo.x, hi.x), y: Math.min(lo.y, hi.y) }, max: { x: Math.max(lo.x, hi.x), y: Math.max(lo.y, hi.y) } };
  drawViewGraphics({ model, view, shown: shownParts, toPaper: p.toPaper, scale: p.scale, window, prims: p.prims });
}

/**
 * A ceiling in a ceiling plan: its outline and openings, and its height at the
 * middle ("9'-0\"", a cloud or soffit by its role, "OPEN TO STRUCTURE"). A
 * sloped plane adds an arrow up its slope with the rise ("UP 3 IN 12"). A
 * cloud and exposed structure draw dashed: they are not a closed lid.
 */
function drawCeilingOnPlan(p: Painter, c: Ceiling, pen: Pen, tone: Tone): void {
  if (c.outline.length < 3) return;
  const role = ceilingRole(c);
  const form = ceilingForm(c);
  const dash = form === "cloud" || form === "open_to_structure" ? [3, 1.5] : undefined;
  polygonIn(p, c.outline, pen, tone, dash ?? p.dash);
  for (const hole of c.holes ?? []) if (hole.length >= 3) polygonIn(p, hole, "thin", tone);
  const mid = centroidOf(c.outline);
  const height = ceilingHeightAtPoint(c, mid);
  const words = form === "open_to_structure" ? "OPEN TO STRUCTURE" : `${role.id === "ceiling" ? "" : `${role.label.toUpperCase()} `}${ftInPlan(height)}`;
  textIn(p, mid, words, 2.5, "middle", tone);
  const slope = ceilingSlope(c);
  if (!slope) return;
  const a = (slope.directionDeg * Math.PI) / 180;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  const len = 12 * p.scale;
  const from = add(mid, scale(dir, -len / 2 - 4 * p.scale));
  const to = add(from, scale(dir, len));
  lineIn(p, from, to, "thin", tone);
  const back = scale(dir, -1.5 * p.scale);
  const side = scale(perp(dir), 1 * p.scale);
  lineIn(p, to, add(add(to, back), side), "thin", tone);
  lineIn(p, to, sub(add(to, back), side), "thin", tone);
  const rise = Math.round(Math.abs(slope.pitch) * 12 * 10) / 10;
  textIn(p, add(to, scale(dir, 2 * p.scale)), `${slope.pitch > 0 ? "UP" : "DOWN"} ${rise} IN 12`, 2, "middle", tone);
}

function ftInPlan(mm: number): string {
  const totalIn = Math.round(Math.abs(mm) / 25.4);
  return `${mm < 0 ? "-" : ""}${Math.floor(totalIn / 12)}'-${totalIn % 12}"`;
}

/**
 * Each space on the plan's level prints its name and number at the middle of
 * its largest outline, unless this view tags it (the tag says it) or hides it.
 * Spaces sit in the global partition and name their level by id, so they are
 * read by level, not with the level's elements.
 */
function drawSpaceLabels(model: ModelState, view: ViewElement, p: Painter, shownAs: DisplayResolver, taggedHere: ReadonlySet<string>): void {
  const level = viewModelLevel(model, view.props?.level, view.props?.levelElevationMm);
  if (!level || !categoryLook(view, "rooms").visible) return;
  for (const space of spacesOnLevel(model.elements, level.id)) {
    if (taggedHere.has(space.id) || leftOutOfDisciplineView(view, space)) continue;
    // Spaces print under the view's Rooms category (its show / hide and halftone).
    const look = categoryLook(view, "rooms");
    const shown = shownAs(space);
    if (!look.visible || !shown.visible) continue;
    let outline: readonly Vec2[] | null = null;
    let area = -1;
    for (const o of spaceOutlines(model.elements, space)) {
      const a = outlineAreaMm2(o);
      if (a > area) {
        outline = o;
        area = a;
      }
    }
    if (!outline || outline.length < 3) continue;
    const text = [space.name.toUpperCase(), space.number].filter((x) => x.trim() !== "").join(" ");
    if (text) textIn(p, centroidOf(outline), text, 2.5, "middle", shown.halftone ? "halftone" : lookTone(look, disciplineTone(view, space)));
  }
}

function centroidOf(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  return scale(points.reduce((acc, q) => add(acc, q), { x: 0, y: 0 }), 1 / points.length);
}

/** Aligned dimension between two model points, offset to the left of a→b by `offset` model mm. */
function drawLinearDimension(p: Painter, a: Vec2, b: Vec2, offset: number, tone: Tone): void {
  const d = sub(b, a);
  const len = length(d);
  if (len === 0) return;
  const u = scale(d, 1 / len);
  const n = perp(u);
  const a2 = add(a, scale(n, offset));
  const b2 = add(b, scale(n, offset));
  lineIn(p, a, add(a2, scale(n, Math.sign(offset) * 100)), "thin", tone);
  lineIn(p, b, add(b2, scale(n, Math.sign(offset) * 100)), "thin", tone);
  lineIn(p, a2, b2, "thin", tone);
  const tick = scale(add(u, n), 75);
  lineIn(p, sub(a2, tick), add(a2, tick), "medium", tone);
  lineIn(p, sub(b2, tick), add(b2, tick), "medium", tone);
  const mid = scale(add(a2, b2), 0.5);
  textIn(p, add(mid, scale(n, 60)), feetInches(len), 2.5, "middle", tone);
}

// ── Sections ─────────────────────────────────────────────────────────────────

/**
 * A section: an orthographic view square to the cut line, kept from the cut
 * plane to the far clip depth. Frame: u = distance along the cut from its
 * start, v = elevation. Elements the plane passes through draw their cut
 * shape (computed by intersecting the solid's edges with the plane) with the
 * heavy cut pen and poche; everything beyond draws its edges with the lighter
 * projection pen, hidden where nearer surfaces cover them. Levels draw as
 * datum lines with their elevations.
 */
function drawSection(model: ModelState, view: ViewElement, p: Painter, display: Display): void {
  const cut = view.props?.section;
  if (!cut) return;
  const projector = sectionProjector(cut.start, cut.end, cut.direction, cut.depthMm);
  const floor = viewFloor(model, view);
  const axis = unit(sub(cut.end, cut.start));
  const look = scale(perp(axis), cut.direction);
  const strip = [cut.start, cut.end, add(cut.end, scale(look, cut.depthMm)), add(cut.start, scale(look, cut.depthMm))];
  const minX = Math.min(...strip.map((q) => q.x)) - REJECT_MARGIN_MM;
  const minY = Math.min(...strip.map((q) => q.y)) - REJECT_MARGIN_MM;
  const maxX = Math.max(...strip.map((q) => q.x)) + REJECT_MARGIN_MM;
  const maxY = Math.max(...strip.map((q) => q.y)) + REJECT_MARGIN_MM;
  const cutLen = length(sub(cut.end, cut.start));

  drawLevelLines(model, view, p, floor);

  const projected: ProjectedSolid[] = [];
  const tones = new Map<string, Tone>();
  const dashed = new Set<string>();
  const slabCuts: Array<{ poly: Vec2[]; tone: Tone }> = [];
  const insulationCuts: Array<{ poly: Vec2[]; tone: Tone }> = [];
  const shownAs = organizationDisplay(model, view);
  for (const el of levelElements(model, view)) {
    if (hidden(model, view, el)) continue;
    const shown = shownAs(el);
    if (!shown.visible) continue;
    if (el.kind === "slab") {
      const top = ownFloor(model, el, floor);
      for (const [s0, s1] of polygonCrossings(el.outline, cut.start, cut.end, cutLen)) {
        slabCuts.push({ poly: [{ x: s0, y: top - el.thickness }, { x: s1, y: top - el.thickness }, { x: s1, y: top }, { x: s0, y: top }], tone: shown.halftone ? "halftone" : toneFor(model, view, el) });
      }
      continue;
    }
    const pts = planPointsOf(el);
    if (pts.length === 0 || pts.every((q) => q.x < minX) || pts.every((q) => q.x > maxX) || pts.every((q) => q.y < minY) || pts.every((q) => q.y > maxY)) continue;
    const solid = elementSolid(model, el, ownFloor(model, el, floor));
    if (!solid) continue;
    const proj = projectSolid(solid, projector);
    if (proj.faces.length === 0 && proj.cuts.length === 0 && proj.cutFills.length === 0 && proj.centerline.length === 0) continue;
    projected.push(proj);
    display.note(el);
    tones.set(el.id, shown.halftone ? "halftone" : toneFor(model, view, el));
    if (shown.dashed) dashed.add(el.id);
    if (!insulationHiddenInView(view)) for (const poly of insulationSectionCuts(model, el, projector)) insulationCuts.push({ poly, tone: tones.get(el.id) ?? "ink" });
  }
  drawProjected(p, projected, tones, display, projector, slabCuts, dashed);
  for (const { poly, tone } of insulationCuts) poly.forEach((q, i) => lineIn(p, q, poly[(i + 1) % poly.length] ?? q, "thin", tone, INSULATION_DASH));
}

/**
 * Draw projected solids with the view's display settings: fills (shaded),
 * edges with hidden-line removal, cut shapes with poche, and single-line duct
 * and pipe at coarse detail.
 */
function drawProjected(p: Painter, projected: readonly ProjectedSolid[], tones: ReadonlyMap<string, Tone>, display: Display, projector: Projector, extraCuts: ReadonlyArray<{ poly: Vec2[]; tone: Tone }> = [], dashed: ReadonlySet<string> = NONE_DASHED): void {
  const style = display.style;
  const coarse = display.detail === "coarse";
  const toneOf = (owner: string) => tones.get(owner) ?? "ink";
  const solidOf = new Map<string, ElementSolid>(projected.map((x) => [x.solid.owner, x.solid]));
  const singleLine = (s: ElementSolid) => coarse && (s.category === "duct" || s.category === "duct_fitting" || s.category === "pipe");
  const index = new FaceIndex(cellFor(p.min.x, p.min.y, p.max.x, p.max.y));
  const faces: Face[] = [];
  const cutPlane = Number.isFinite(projector.nearMax) ? projector.nearMax : null;
  for (const x of projected) {
    if (singleLine(x.solid)) continue;
    for (const f of x.faces) {
      index.add(f);
      faces.push(f);
    }
    // A cut face is the nearest surface there is: it hides everything behind it.
    if (cutPlane !== null) {
      for (const poly of [...x.cuts, ...x.cutFills]) {
        const face = cutFace(x.solid.owner, poly.map((q) => ({ x: q.u, y: q.v })), cutPlane);
        if (face) index.add(face);
      }
    }
  }
  if (fillsFaces(style)) fillFaces(p, faces, (o) => solidOf.get(o)?.role ?? "mep", toneOf);

  const drawEdge = (a: { u: number; v: number; near: number }, b: { u: number; v: number; near: number }, pen: Pen, tone: Tone, category: ViewCategory | null, edge?: ProjEdge) => {
    if (!hidesEdges(style)) {
      lineIn(p, { x: a.u, y: a.v }, { x: b.u, y: b.v }, pen, tone);
      return;
    }
    // A back edge of a closed convex piece is hidden by that piece itself; a front edge never is.
    if (edge?.facing === "back") {
      if (display.dashed(category)) lineIn(p, { x: a.u, y: a.v }, { x: b.u, y: b.v }, "thin", tone, HIDDEN_DASH);
      return;
    }
    const split = splitHidden(a, b, index, undefined, edge?.facing === "front" ? (f) => f.owner === edge.owner && f.piece === edge.piece : undefined);
    for (const [q0, q1] of split.visible) lineIn(p, { x: q0.u, y: q0.v }, { x: q1.u, y: q1.v }, pen, tone);
    if (display.dashed(category)) for (const [q0, q1] of split.hidden) lineIn(p, { x: q0.u, y: q0.v }, { x: q1.u, y: q1.v }, "thin", tone, HIDDEN_DASH);
  };

  if (drawsEdges(style)) {
    for (const x of projected) {
      const s = x.solid;
      const tone = toneOf(s.owner);
      p.dash = dashed.has(s.owner) ? PHASE_DASH : patternDash(display.lookOf(s.owner, s.category));
      if (singleLine(s)) {
        const pen = display.pen(s.category, "projection", "medium", s.owner);
        for (const e of x.centerline) drawEdge(e.a, e.b, pen, tone, s.category);
        continue;
      }
      const pen = display.pen(s.category, "projection", s.role === "architecture" ? "thin" : "medium", s.owner);
      for (const e of x.edges) drawEdge(e.a, e.b, pen, tone, s.category, e);
    }
  }

  // Cut shapes last, over everything beyond.
  for (const x of projected) {
    const s = x.solid;
    const tone = toneOf(s.owner);
    p.dash = dashed.has(s.owner) ? PHASE_DASH : undefined;
    if (singleLine(s)) {
      // Single-line duct or pipe cut: a circle with a cross at the centreline.
      const r = Math.max(1.2 * p.scale, Math.min((s.sizeMm ?? 0) / 2, 3 * p.scale));
      for (const c of x.centerCuts) {
        const at = { x: c.u, y: c.v };
        const ring: Vec2[] = [];
        for (let i = 0; i < 16; i++) ring.push({ x: at.x + r * Math.cos((i / 16) * Math.PI * 2), y: at.y + r * Math.sin((i / 16) * Math.PI * 2) });
        polygonIn(p, ring, display.pen(s.category, "cut", "wide", s.owner), tone);
        lineIn(p, { x: at.x - r, y: at.y }, { x: at.x + r, y: at.y }, "thin", tone);
        lineIn(p, { x: at.x, y: at.y - r }, { x: at.x, y: at.y + r }, "thin", tone);
      }
      continue;
    }
    for (const poly of x.cuts) drawCutShape(p, poly.map((q) => ({ x: q.u, y: q.v })), s, tone, display);
    // A mesh cut: poche the strips on one shared hatch grid (or one cross over the whole cut), then stroke only the true outlines.
    if (x.cutFills.length > 0 && s.role !== "architecture" && display.cutPattern === "cross") {
      const pts = x.cutOutlines.flat();
      const lo = { x: Math.min(...pts.map((q) => q.u)), y: Math.min(...pts.map((q) => q.v)) };
      const hi = { x: Math.max(...pts.map((q) => q.u)), y: Math.max(...pts.map((q) => q.v)) };
      for (const poly of x.cutFills) {
        const strip = hull2(poly.map((q) => ({ x: q.u, y: q.v })));
        for (const [a, b] of [[lo, hi], [{ x: lo.x, y: hi.y }, { x: hi.x, y: lo.y }]] as const) {
          const c = clipToConvex(a, b, strip);
          if (c) lineIn(p, c[0], c[1], "thin", tone);
        }
      }
    } else {
      for (const poly of x.cutFills) drawCutShape(p, poly.map((q) => ({ x: q.u, y: q.v })), s, tone, display, false);
    }
    for (const loop of x.cutOutlines) polygonIn(p, loop.map((q) => ({ x: q.u, y: q.v })), display.pen(s.category, "cut", s.role === "architecture" ? "heavy" : "wide", s.owner), tone);
  }
  p.dash = undefined;
  for (const c of extraCuts) {
    fillIn(p, c.poly, ROLE_GREY.architecture - 0.1, c.tone);
    polygonIn(p, c.poly, display.pen("structure", "cut", "heavy"), c.tone);
  }
}

const NONE_DASHED: ReadonlySet<string> = new Set();

/** A cut polygon as an occluding face at the cut plane. */
function cutFace(owner: string, poly: readonly Vec2[], near: number): Face | null {
  const ccw = hull2(poly);
  if (ccw.length < 3) return null;
  return {
    owner,
    piece: -1,
    poly: ccw.map((q) => ({ u: q.x, v: q.y, near })),
    a: 0,
    b: 0,
    c: near,
    minU: Math.min(...ccw.map((q) => q.x)),
    minV: Math.min(...ccw.map((q) => q.y)),
    maxU: Math.max(...ccw.map((q) => q.x)),
    maxV: Math.max(...ccw.map((q) => q.y)),
    light: 1,
    meanNear: near,
  };
}

/** Segment a→b clipped to a convex polygon (counter-clockwise), or null. */
function clipToConvex(a: Vec2, b: Vec2, poly: readonly Vec2[]): [Vec2, Vec2] | null {
  let t0 = 0;
  let t1 = 1;
  const d = sub(b, a);
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i] as Vec2;
    const p1 = poly[(i + 1) % poly.length] as Vec2;
    const e = sub(p1, p0);
    const g0 = e.x * (a.y - p0.y) - e.y * (a.x - p0.x);
    const gd = e.x * d.y - e.y * d.x;
    if (Math.abs(gd) < 1e-12) {
      if (g0 < 0) return null;
      continue;
    }
    const t = -g0 / gd;
    if (gd > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t1 - t0 < 1e-9) return null;
  }
  return [add(a, scale(d, t0)), add(a, scale(d, t1))];
}

/** A cut shape: heavy outline, then poche — duct and pipe by the view's cut pattern, walls and structure solid grey. */
function drawCutShape(p: Painter, polyIn: readonly Vec2[], s: ElementSolid, tone: Tone, display: Display, outline = true): void {
  const poly = hull2(polyIn);
  if (poly.length < 3) return;
  const xs = poly.map((q) => q.x);
  const ys = poly.map((q) => q.y);
  const lo = { x: Math.min(...xs), y: Math.min(...ys) };
  const hi = { x: Math.max(...xs), y: Math.max(...ys) };
  if (s.role === "architecture") {
    fillIn(p, poly, ROLE_GREY.architecture - 0.1, tone);
  } else if (display.cutPattern === "solid") {
    fillIn(p, poly, 0.15, tone);
  } else if (display.cutPattern === "cross") {
    for (const [a, b] of [[lo, hi], [{ x: lo.x, y: hi.y }, { x: hi.x, y: lo.y }]] as const) {
      const c = clipToConvex(a, b, poly);
      if (c) lineIn(p, c[0], c[1], "thin", tone);
    }
  } else {
    const step = 1.5 * p.scale;
    // 45° lines x - y = k across the shape's box. Strips of one cut share a grid so their lines meet.
    const k0 = outline ? lo.x - hi.y + step / 2 : Math.ceil((lo.x - hi.y) / step) * step;
    for (let k = k0; k < hi.x - lo.y; k += step) {
      const c = clipToConvex({ x: lo.x - 1, y: lo.x - 1 - k }, { x: hi.x + 1, y: hi.x + 1 - k }, poly);
      if (c) lineIn(p, c[0], c[1], "thin", tone);
    }
  }
  if (outline) polygonIn(p, poly, display.pen(s.category, "cut", s.role === "architecture" ? "heavy" : "wide", s.owner), tone);
}

/** Level datum lines across a section with each level's name and elevation, and a level head at the right. */
function drawLevelLines(model: ModelState, view: ViewElement, p: Painter, floor: number): void {
  const levels = modelLevels(model).map((l) => ({ name: l.name, elevationMm: l.elevationMm }));
  const own = view.props?.level;
  if (own && !levels.some((l) => Math.abs(l.elevationMm - floor) < 5)) levels.push({ name: own, elevationMm: floor });
  if (levels.length === 0) levels.push({ name: own ?? "LEVEL", elevationMm: floor });
  for (const l of levels) {
    if (l.elevationMm < p.min.y || l.elevationMm > p.max.y) continue;
    lineIn(p, { x: p.min.x, y: l.elevationMm }, { x: p.max.x, y: l.elevationMm }, "thin", "ink", [8, 2]);
    const head = 2.5 * p.scale;
    const hx = p.max.x - head * 2;
    polygonIn(p, [{ x: hx - head / 2, y: l.elevationMm + head }, { x: hx + head / 2, y: l.elevationMm + head }, { x: hx, y: l.elevationMm }], "thin", "ink");
    const sign = l.elevationMm < 0 ? "-" : "";
    textIn(p, { x: p.min.x + 1.5 * p.scale, y: l.elevationMm + 1 * p.scale }, `${l.name.toUpperCase()}  EL. ${sign}${feetInches(l.elevationMm)}`, 2.5, "start", "ink");
  }
}

/** Where segment c→d crosses a→b, as a fraction along a→b, or null. */
function crossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const ac = sub(c, a);
  const t = (ac.x * s.y - ac.y * s.x) / denom;
  const u = (ac.x * r.y - ac.y * r.x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Stretches of the cut line inside a polygon, in along-cut distance. */
function polygonCrossings(outline: readonly Vec2[], a: Vec2, b: Vec2, cutLen: number): Array<[number, number]> {
  const ts: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const c = outline[i];
    const d = outline[(i + 1) % outline.length];
    if (!c || !d) continue;
    const t = crossing(a, b, c, d);
    if (t !== null) ts.push(t * cutLen);
  }
  ts.sort((x, y) => x - y);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < ts.length; i += 2) {
    const s0 = ts[i];
    const s1 = ts[i + 1];
    if (s0 !== undefined && s1 !== undefined) out.push([s0, s1]);
  }
  return out;
}

// ── 3D (isometric) ───────────────────────────────────────────────────────────

/** The 3D view as an isometric drawing: elements inside the plan crop, with the view's visual style and hidden lines. */
function drawIso(model: ModelState, view: ViewElement, p: Painter, display: Display): void {
  const inCrop = (q: Vec2) => q.x >= p.crop.min.x && q.x <= p.crop.max.x && q.y >= p.crop.min.y && q.y <= p.crop.max.y;
  const floor = viewFloor(model, view);
  const projector = isoProjector();
  // The isometric window is laid out with the level at z = 0.
  const lowered: Projector = { ...projector, project: (q) => projector.project({ x: q.x, y: q.y, z: q.z - floor }) };
  const projected: ProjectedSolid[] = [];
  const tones = new Map<string, Tone>();
  const dashed = new Set<string>();
  const shownAs = organizationDisplay(model, view);
  for (const el of levelElements(model, view)) {
    if (hidden(model, view, el)) continue;
    const shown = shownAs(el);
    if (!shown.visible) continue;
    if (!planPointsOf(el).some(inCrop)) continue;
    const solid = elementSolid(model, el, ownFloor(model, el, floor));
    if (!solid) continue;
    projected.push(projectSolid(solid, lowered));
    display.note(el);
    tones.set(el.id, solid.role === "architecture" || shown.halftone ? "halftone" : toneFor(model, view, el));
    if (shown.dashed) dashed.add(el.id);
  }
  drawProjected(p, projected, tones, display, lowered, [], dashed);
}

/** Highest an element stands above its level's floor and still belongs to that storey (the storey's own height, generously). */
const STOREY_REACH_MM = 40 * FT;

/**
 * What a 3D view could show, read by partition: its own level when it has one;
 * otherwise every level whose floor lies within the box's heights (a storey
 * below the box included), plus partitions whose level the model doesn't
 * know (no floor to rule them out). Documents never.
 */
function camera3dElements(model: ModelState, view: ViewElement, bottomMm: number, topMm: number): BimElement[] {
  if (view.props?.level) return levelElements(model, view);
  const floors = new Map<string, number>();
  for (const l of modelLevels(model)) floors.set(l.name, l.elevationMm);
  return partitionMembers(model, (p) => {
    if (p.zone === DOCUMENT_ZONE) return false;
    const floor = floors.get(p.level);
    return floor === undefined || (floor <= topMm && floor + STOREY_REACH_MM >= bottomMm);
  });
}

/**
 * A saved 3D view as it prints: parallel projection from its camera (a
 * perspective camera prints orthographic from the same direction), everything
 * clipped to its 3D crop box with the cuts capped, then the view's visual
 * style and hidden lines. With crop off it shows the content's plan extent at
 * the box's heights. Each element stands on its own level's floor.
 */
function drawCamera3d(model: ModelState, view: ViewElement, p: Painter, display: Display): void {
  const camera = view.props?.camera3d;
  if (!camera) return;
  const own = viewCropBox3d(model, view);
  const box = view.props?.cropView !== false && own ? own : boxOverRect(p.crop, own);
  const planes = boxKeepPlanes(box);
  const bounds = boxAabb(box);
  const projector = cameraProjector(camera);
  const projected: ProjectedSolid[] = [];
  const tones = new Map<string, Tone>();
  const dashed = new Set<string>();
  const shownAs = organizationDisplay(model, view);
  // An element's floor is its level's: resolve each level once.
  const floorByLevel = new Map<string, number>();
  for (const el of camera3dElements(model, view, bounds.min.z, bounds.max.z)) {
    if (hidden(model, view, el)) continue;
    // Cheap reject in plan before building a solid: nothing of it can reach the box.
    const pts = planPointsOf(el);
    if (pts.length === 0) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const q of pts) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
    if (maxX < bounds.min.x - REJECT_MARGIN_MM || minX > bounds.max.x + REJECT_MARGIN_MM || maxY < bounds.min.y - REJECT_MARGIN_MM || minY > bounds.max.y + REJECT_MARGIN_MM) continue;
    const shown = shownAs(el);
    if (!shown.visible) continue;
    const levelName = el.partition?.level ?? DEFAULT_PARTITION.level;
    let floor = floorByLevel.get(levelName);
    if (floor === undefined) {
      floor = elementFloorMm(model, el);
      floorByLevel.set(levelName, floor);
    }
    const solid = elementSolid(model, el, floor);
    if (!solid) continue;
    const proj = projectSolidInBox(solid, projector, planes);
    if (proj.faces.length === 0 && proj.edges.length === 0 && proj.centerline.length === 0) continue;
    projected.push(proj);
    display.note(el);
    tones.set(el.id, solid.role === "architecture" || shown.halftone ? "halftone" : toneFor(model, view, el));
    if (shown.dashed) dashed.add(el.id);
  }
  drawProjected(p, projected, tones, display, projector, [], dashed);
}

// ── Detail views (drawing-only) ──────────────────────────────────────────────

function drawItemsInModel(p: Painter, items: readonly DrawingItem[], model: ModelState, view: ViewElement): void {
  const ctx: AnnotationDrawContext = { model, view, toPaper: p.toPaper, scale: p.scale, prims: p.prims };
  // Detailing linework clips to the view's window on paper, like the model's own.
  const lo = p.toPaper({ x: p.min.x, y: p.max.y });
  const hi = p.toPaper({ x: p.max.x, y: p.min.y });
  const window = { min: { x: Math.min(lo.x, hi.x), y: Math.min(lo.y, hi.y) }, max: { x: Math.max(lo.x, hi.x), y: Math.max(lo.y, hi.y) } };
  for (const item of items) {
    const [a, b] = item.points;
    if (!a) continue;
    const look = categoryLook(view, draftingCategoryId(categoryOf(item)));
    if (!look.visible) continue;
    const from = p.prims.length;
    drawItemInModel(p, item, a, b, ctx, window, model);
    if (look.halftone !== true) continue;
    for (let i = from; i < p.prims.length; i++) {
      const prim = p.prims[i];
      if (prim) p.prims[i] = halftoned(prim);
    }
  }
}

/** A drafting item's primitives in a halftoned category. */
function halftoned(prim: Primitive): Primitive {
  return prim.kind === "line" || prim.kind === "fill" || prim.kind === "text" ? { ...prim, tone: "halftone" } : prim;
}

function drawItemInModel(p: Painter, item: DrawingItem, a: Vec2, b: Vec2 | undefined, ctx: AnnotationDrawContext, window: { min: Vec2; max: Vec2 }, model: ModelState): void {
  const drawnDetail: Primitive[] = [];
  if (drawDetailItem({ toPaper: p.toPaper, scale: p.scale, prims: drawnDetail }, item)) {
    for (const prim of drawnDetail) {
      if (prim.kind !== "line") {
        p.prims.push(prim);
        continue;
      }
      const clipped = clipSegment(prim.a, prim.b, window.min, window.max);
      if (clipped) p.prims.push({ ...prim, a: clipped[0], b: clipped[1] });
    }
    return;
  }
  if (item.shape === "dimension" && item.dim) {
    drawDimension(ctx, item);
    return;
  }
  switch (item.shape) {
    case "text": {
      // The whole box must lie where notes may sit, so nothing prints past the crop.
      const lo = p.toPaper({ x: p.noteMin.x, y: p.noteMax.y });
      const hi = p.toPaper({ x: p.noteMax.x, y: p.noteMin.y });
      const drawn = noteDrawing(item, p.toPaper, (corners) => corners.every((c) => c.x >= lo.x - 1e-6 && c.x <= hi.x + 1e-6 && c.y >= lo.y - 1e-6 && c.y <= hi.y + 1e-6));
      if (!drawn) break;
      p.blocks.push(drawn.block);
      for (const [s, e] of drawn.leader) p.prims.push({ kind: "line", a: s, b: e, pen: "thin" });
      break;
    }
    case "line":
      if (b) lineIn(p, a, b, item.lineStyle?.weight ?? "medium", "ink", item.lineStyle?.pattern ? PATTERN_DASH[item.lineStyle.pattern] : undefined);
      break;
    case "rect":
      if (b) polygonIn(p, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], item.lineStyle?.weight ?? "medium", "ink", item.lineStyle?.pattern ? PATTERN_DASH[item.lineStyle.pattern] : undefined);
      break;
    case "dimension":
      if (b) drawLinearDimension(p, a, b, 300, "ink");
      break;
    case "cloud":
      if (b) for (const seg of revisionCloud(p.toPaper(a), p.toPaper(b))) p.prims.push({ kind: "line", a: seg[0], b: seg[1], pen: "medium" });
      break;
    case "tag":
      drawTag(ctx, item);
      break;
    case "callout":
      drawCallout(model, item, p.toPaper, p.prims);
      break;
  }
}

// ── Viewports and sheets ─────────────────────────────────────────────────────

/**
 * Draw one view into a frame on paper. Linked-model backgrounds (a plan cut
 * or a section cut of the linked IFC, in the view's drawing frame) print
 * first, screened unless the view turns halftone off; then fills and poche;
 * then the view's linework and annotations.
 */
export function drawView(prims: Primitive[], tags: TagPlacement[], model: ModelState, view: ViewElement, frame: ViewFrame, backgrounds: readonly SheetReference[] = [], blocks: TextBlock[] = []): void {
  // A print carries the linked elements its dimensions name: they resolve from those, not only the page's loaded links.
  withLinkedReferenceModels(linkedAnchorModelsOf(backgrounds), () => drawViewBody(prims, tags, model, view, frame, backgrounds, blocks));
}

function drawViewBody(prims: Primitive[], tags: TagPlacement[], model: ModelState, view: ViewElement, frame: ViewFrame, backgrounds: readonly SheetReference[], blocks: TextBlock[]): void {
  const body: Primitive[] = [];
  const fills: Primitive[] = [];
  const p = painter(body, fills, tags, frame, view, viewCropAndWindow(model, view).crop, blocks);
  const display = displayOf(model, view);
  if (view.viewType === "floor_plan" || view.viewType === "ceiling_plan" || view.viewType === "section") {
    const refs = backgrounds.flatMap((r) => applyReferenceDisplay(r, resolveReferenceDisplay(view.props?.references?.[r.plan.id], "drawing", "architecture")) ?? []);
    if (refs.length > 0) drawReferenceLayers(prims, refs, p.min, p.max, p.toPaper);
  }
  switch (view.viewType) {
    case "floor_plan":
    case "ceiling_plan": {
      const shownParts = new Map<string, PartInstance>();
      drawPlan(model, view, p, frame, display, shownParts);
      drawPlanConnections(model, view, p, shownParts);
      break;
    }
    case "section":
      drawSection(model, view, p, display);
      break;
    case "three_d":
      if (view.props?.camera3d) drawCamera3d(model, view, p, display);
      else drawIso(model, view, p, display);
      break;
    case "detail":
      drawItemsInModel(p, viewContentItems(model, view), model, view);
      break;
    case "schedule":
      drawScheduleView(body, model, view.props, { x: frame.center.x - frame.size.x / 2, y: frame.center.y - frame.size.y / 2 });
      break;
  }
  // Plans and sections carry their own notes, dimensions and tags, drawn over the model at paper size.
  if (view.viewType === "floor_plan" || view.viewType === "ceiling_plan" || view.viewType === "section") {
    const items = documentIndex(model).itemsByOwner.get(view.id) ?? [];
    if (items.length > 0) drawItemsInModel(p, items, model, view);
  }
  for (const f of fills) prims.push(f);
  for (const b of body) prims.push(b);
}

/** A viewport's frame: the view's crop window at the viewport's scale, centred where the viewport sits. */
export function frameForViewport(model: ModelState, vp: Viewport, view: ViewElement): ViewFrame {
  const { window } = viewCropAndWindow(model, view);
  const frame: ViewFrame =
    view.viewType === "schedule" || view.props?.diagram
      ? contentFrame(vp, window, view.viewType === "schedule")
      : turnedFrame(vp.center, window, vp.scale, viewRotationDeg(siteOf(model), view));
  return frameOnPaper(model, vp, frame);
}

/** A schedule's or live diagram's frame: it grows down and right from where its top-left corner sits. */
function contentFrame(vp: Viewport, window: Rect, isSchedule: boolean): ViewFrame {
  // Rows (or equipment) added since it was placed grow it down and right from where its top-left corner sits.
  const size = { x: window.max.x - window.min.x, y: window.max.y - window.min.y };
  const topLeft = { x: vp.center.x - vp.size.x / 2, y: vp.center.y - vp.size.y / 2 };
  const modelCenter = isSchedule ? { x: size.x / 2, y: -size.y / 2 } : { x: (window.min.x + window.max.x) / 2, y: (window.min.y + window.max.y) / 2 };
  return { center: { x: topLeft.x + size.x / 2, y: topLeft.y + size.y / 2 }, size, scale: 1, modelCenter };
}

/**
 * A frame that misses the paper entirely draws nothing, so the sheet exports
 * blank (finding f668fe10: a live diagram placed at 120 x 96 in on a 36 x 24
 * in sheet whose content later shrank, leaving its top-left anchor far off the
 * paper). Pull such a frame back until it shows — the drawing moves with it —
 * and let the sheet lint flag the viewport for repair. A frame that overlaps
 * the paper even partly stays exactly where it was placed.
 */
function frameOnPaper(model: ModelState, vp: Viewport, frame: ViewFrame): ViewFrame {
  const sheet = model.elements[vp.sheetId];
  if (sheet?.kind !== "sheet") return frame;
  const paper = sheetPaper(sheet);
  const axis = (center: number, span: number, spanOfPaper: number): number => {
    if (center + span / 2 > 0 && center - span / 2 < spanOfPaper) return center;
    const lo = Math.min(span / 2, spanOfPaper - span / 2);
    const hi = Math.max(span / 2, spanOfPaper - span / 2);
    return Math.min(Math.max(center, lo), hi);
  };
  const center = { x: axis(frame.center.x, frame.size.x, paper.x), y: axis(frame.center.y, frame.size.y, paper.y) };
  return center.x === frame.center.x && center.y === frame.center.y ? frame : { ...frame, center };
}

/** Paper size for a sheet's title block. */
export function sheetPaper(sheet: Sheet): Vec2 {
  return sheetPaperSize(sheet);
}

/** Viewports on a sheet in the order the sheet lists their views (that order numbers them). */
export function sheetViewports(model: ModelState, sheet: Sheet): Array<{ viewport: Viewport; view: ViewElement; number: number }> {
  const vps = documentIndex(model).viewportsBySheet.get(sheet.id) ?? [];
  const out: Array<{ viewport: Viewport; view: ViewElement; number: number }> = [];
  for (const vp of vps) {
    const view = model.elements[vp.viewId];
    if (view?.kind === "view" && !view.deleted) out.push({ viewport: vp, view, number: 0 });
  }
  out.sort((a, b) => sheet.viewIds.indexOf(a.view.id) - sheet.viewIds.indexOf(b.view.id));
  return out.map((entry, i) => ({ ...entry, number: i + 1 }));
}

/** Viewports on a sheet whose printed frame runs past its drawing area (a live diagram or schedule that grew, a frame too big for the sheet), in sheet order. */
export function sheetViewportOverhangs(model: ModelState, sheetId: string): ViewportOverhang[] {
  const sheet = model.elements[sheetId];
  if (sheet?.kind !== "sheet" || sheet.deleted) return [];
  const out: ViewportOverhang[] = [];
  for (const { viewport, view } of sheetViewports(model, sheet)) {
    const frame = frameForViewport(model, viewport, view);
    const found = frameOverhang(sheet, view, viewport.id, { x: frame.center.x - frame.size.x / 2, y: frame.center.y - frame.size.y / 2 }, frame.size);
    if (found) out.push(found);
  }
  return out;
}

/**
 * What a printed sheet depends on: the sheet, its viewports, its views and
 * their drawing items, and the model elements on the levels its views show
 * (every model element when a placed view has no level). Print and issue check
 * only these for unsaved edits.
 */
export function sheetDependsOn(model: ModelState, sheetId: string): (elementId: string, el: BimElement | undefined) => boolean {
  const sheet = model.elements[sheetId];
  if (!sheet || sheet.kind !== "sheet") return () => false;
  const index = documentIndex(model);
  const owned = new Set<string>([sheet.id]);
  const levels = new Set<string>();
  let allLevels = false;
  let sheetList = false;
  // Callouts read the sheet their view is on: moving that view or renumbering its sheet reprints this one.
  const referenced = new Set<string>();
  for (const { viewport, view } of sheetViewports(model, sheet)) {
    owned.add(viewport.id);
    owned.add(view.id);
    for (const item of index.itemsByOwner.get(view.id) ?? []) {
      owned.add(item.id);
      if (item.callout) referenced.add(item.callout.viewId);
    }
    if (view.props?.diagram) {
      // A live diagram is drawn from the whole model's connection graph.
      allLevels = true;
      continue;
    }
    if (view.viewType === "detail") continue;
    if (view.viewType === "schedule") {
      // A schedule lists elements on every level (or every sheet).
      if (view.props?.schedule?.category === "sheet_list") sheetList = true;
      else allLevels = true;
      continue;
    }
    const names = viewLevelNames(model, view.props?.level, view.props?.levelElevationMm);
    if (names) for (const n of names) levels.add(n);
    else allLevels = true;
  }
  for (const item of index.itemsByOwner.get(sheet.id) ?? []) {
    owned.add(item.id);
    // A block reads the distribution it summarises (its subtree only, never the model).
    if (item.shape === "field_block" && item.block) for (const id of renderFieldBlock(model, item.block).dependsOn) owned.add(id);
  }
  return (elementId, el) => {
    if (owned.has(elementId)) return true;
    if (!el) return false;
    // Something new drawn on this sheet or in one of its views.
    if (el.kind === "drawing_item") return owned.has(el.ownerId);
    if (el.kind === "viewport") return owned.has(el.sheetId) || referenced.has(el.viewId);
    if (el.kind === "sheet") return sheetList || referenced.size > 0;
    if (el.kind === "view") return referenced.has(elementId);
    // Circuit lines and home-run tags draw from links; typicals' copies from their group.
    if (el.kind === "service_link" || el.kind === "organization") return true;
    return allLevels || levels.has((el.partition ?? DEFAULT_PARTITION).level);
  };
}

/** The sheet as drawn and printed: border, viewports at scale with titles, sheet notes and linework, title block. */
export function buildSheetSceneFor(model: ModelState, sheetId: string, opts: SheetDrawOptions): SheetScene {
  const stored = model.elements[sheetId];
  if (!stored || stored.kind !== "sheet" || stored.deleted) throw new Error(`Sheet ${sheetId} does not exist`);
  // The title block prints the project's facts where the sheet states none (`project-parameters.ts`).
  const sheet = withSheetFieldValues(model, stored);
  const paper = sheetPaper(sheet);
  const prims: Primitive[] = [];
  const tags: TagPlacement[] = [];
  const blocks: TextBlock[] = [];
  const row = sheet.props?.titleBlockRow;
  // A library title block draws its own border (binding margin on the left) with its strip.
  if (!row) prims.push({ kind: "rect", at: { x: 12.7, y: 12.7 }, size: { x: paper.x - 25.4, y: paper.y - 25.4 }, pen: "heavy" });

  for (const { viewport, view, number } of sheetViewports(model, sheet)) {
    const frame = frameForViewport(model, viewport, view);
    drawView(prims, tags, model, view, frame, opts.backgrounds?.[view.id] ?? [], blocks);
    // A schedule carries its own title row.
    if (view.viewType === "schedule") continue;
    const left = frame.center.x - frame.size.x / 2;
    const titleY = frame.center.y + frame.size.y / 2 + 8;
    prims.push({ kind: "line", a: { x: left, y: titleY + 1.5 }, b: { x: left + Math.min(frame.size.x, 120), y: titleY + 1.5 }, pen: "wide" });
    prims.push({ kind: "text", at: { x: left, y: titleY }, text: `${number}  ${view.name.toUpperCase()}`, size: 3.5, anchor: "start", bold: true });
    const scaleText = view.viewType === "three_d" ? (view.props?.camera3d ? "3D VIEW, NOT TO SCALE" : "NOT TO SCALE (ISOMETRIC)") : view.viewType === "detail" && viewport.scale === 1 ? "SCALE: NONE" : `SCALE: ${scaleLabel(viewport.scale)}`;
    prims.push({ kind: "text", at: { x: left, y: titleY + 5.5 }, text: scaleText, size: 2.2, anchor: "start" });
    const arrow = viewportNorthArrow(model, viewport, view);
    // Beside the title, low enough that the N clears the frame whichever way it points.
    if (arrow) drawNorthArrow(prims, { x: left + Math.min(frame.size.x, 120) + NORTH_ARROW_RADIUS_MM + 8, y: titleY + 7 }, arrow.deg);
  }

  const images: SheetImage[] = [];
  drawSheetItems(prims, documentIndex(model).itemsByOwner.get(sheet.id) ?? [], blocks, model, images, opts.frozenBlocks);
  if (row) {
    const drawn = drawTitleBlock(model, sheet, row.definition, opts);
    prims.push(...drawn.primitives);
    return { paper, revision: model.revision, primitives: prims, tags, dimensions: [], details: [], schedule: [], textBlocks: blocks, ...(images.length > 0 ? { images } : {}), fonts: drawn.fonts, ...(drawn.codeSlot ? { codeSlot: drawn.codeSlot } : {}) };
  }
  drawTitleBlockFor(prims, sheet, paper, opts);
  return { paper, revision: model.revision, primitives: prims, tags, dimensions: [], details: [], schedule: [], textBlocks: blocks, ...(images.length > 0 ? { images } : {}) };
}

/** One view on its own, framed with a small margin (the detail editor and view previews). */
export function buildViewScene(model: ModelState, viewId: string, backgrounds: readonly SheetReference[] = []): { scene: SheetScene; frame: ViewFrame } {
  const view = model.elements[viewId];
  if (!view || view.kind !== "view" || view.deleted) throw new Error(`View ${viewId} does not exist`);
  const s = viewScale(view);
  const { window } = viewCropAndWindow(model, view);
  const turned = turnedFrame({ x: 0, y: 0 }, window, s, viewRotationDeg(siteOf(model), view));
  const margin = 10;
  const paper = { x: turned.size.x + margin * 2, y: turned.size.y + margin * 2 };
  const frame: ViewFrame = { ...turned, center: { x: paper.x / 2, y: paper.y / 2 } };
  const prims: Primitive[] = [];
  const tags: TagPlacement[] = [];
  const blocks: TextBlock[] = [];
  drawView(prims, tags, model, view, frame, backgrounds, blocks);
  return { scene: { paper, revision: model.revision, primitives: prims, tags, dimensions: [], details: [], schedule: [], textBlocks: blocks }, frame };
}

function drawSheetItems(prims: Primitive[], items: readonly DrawingItem[], blocks: TextBlock[], model: ModelState, images: SheetImage[], frozen?: FrozenBlocks): void {
  for (const item of items) {
    const [a, b] = item.points;
    if (!a) continue;
    if (drawDetailItem({ toPaper: (q) => q, scale: 1, prims }, item)) continue;
    const pen = item.lineStyle?.weight ?? "medium";
    const dash = item.lineStyle?.pattern ? PATTERN_DASH[item.lineStyle.pattern] : undefined;
    switch (item.shape) {
      case "text": {
        const drawn = noteDrawing(item, (q) => q);
        if (!drawn) break;
        blocks.push(drawn.block);
        for (const [s, e] of drawn.leader) prims.push({ kind: "line", a: s, b: e, pen: "thin" });
        break;
      }
      case "line":
        if (b) prims.push({ kind: "line", a, b, pen, ...(dash ? { dash } : {}) });
        break;
      case "rect":
        if (b) prims.push({ kind: "rect", at: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, size: { x: Math.abs(b.x - a.x), y: Math.abs(b.y - a.y) }, pen });
        break;
      case "cloud":
        if (b) for (const seg of revisionCloud(a, b)) prims.push({ kind: "line", a: seg[0], b: seg[1], pen: "medium" });
        break;
      case "dimension":
        break;
      case "figure": {
        const frame = figureFrame(item.points);
        if (!frame || !item.figure) break;
        if (item.figure.kind === "chart") prims.push(...figurePrimitives(model, item.figure, frame.min, frame.max));
        else images.push({ itemId: item.id, fileId: item.figure.image.fileId, name: item.figure.image.name, mime: item.figure.image.mime, at: frame.min, size: { x: frame.max.x - frame.min.x, y: frame.max.y - frame.min.y } });
        break;
      }
      case "field_block": {
        const block = fieldBlockTextBlock(model, item, frozen ? { frozen } : {});
        if (block) blocks.push(block);
        break;
      }
    }
  }
}

/** A revision cloud around a rectangle: outward scallops of about 6 mm, each drawn as short chords. */
export function revisionCloud(a: Vec2, b: Vec2): Array<[Vec2, Vec2]> {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const corners: Vec2[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const out: Array<[Vec2, Vec2]> = [];
  for (let i = 0; i < 4; i++) {
    const s = corners[i];
    const e = corners[(i + 1) % 4];
    if (!s || !e) continue;
    const edge = sub(e, s);
    const len = length(edge);
    const count = Math.max(1, Math.round(len / 6));
    const u = scale(edge, 1 / len);
    const outward = { x: u.y, y: -u.x };
    const step = len / count;
    for (let k = 0; k < count; k++) {
      const c = add(s, scale(u, step * (k + 0.5)));
      const r = step / 2;
      let prev: Vec2 | null = null;
      for (let j = 0; j <= 8; j++) {
        const t = Math.PI * (j / 8);
        const q = add(add(c, scale(u, -r * Math.cos(t))), scale(outward, r * Math.sin(t)));
        if (prev) out.push([prev, q]);
        prev = q;
      }
    }
  }
  return out;
}

const FIELD_ORDER = ["client", "address", "drawn_by", "checked_by", "date", "status"] as const;
const FIELD_LABEL: Record<string, string> = {
  client: "CLIENT",
  address: "PROJECT ADDRESS",
  drawn_by: "DRAWN BY",
  checked_by: "CHECKED BY",
  date: "DATE",
  status: "STATUS",
};

const REVISION_ROW_MM = 5;

/** The title block's revision (issue) table, bottom edge at `bottomY`, newest row on top. Returns its top edge (bottomY when empty). */
function drawRevisionTable(prims: Primitive[], revisions: readonly SheetRevision[], x: number, w: number, bottomY: number, small: boolean): number {
  if (revisions.length === 0) return bottomY;
  const rows = [...revisions].reverse();
  const top = bottomY - REVISION_ROW_MM * (rows.length + 2);
  const noW = small ? 8 : 10;
  const dateW = small ? 16 : 20;
  prims.push({ kind: "line", a: { x, y: top }, b: { x: x + w, y: top }, pen: "medium" });
  prims.push({ kind: "text", at: { x: x + 3, y: top + 3.6 }, text: "REVISIONS", size: 1.8, anchor: "start", bold: true });
  const header = top + REVISION_ROW_MM;
  const cells = (y: number, no: string, date: string, desc: string, bold: boolean) => {
    prims.push({ kind: "line", a: { x, y }, b: { x: x + w, y }, pen: "thin" });
    const base = y + REVISION_ROW_MM - 1.4;
    prims.push({ kind: "text", at: { x: x + noW / 2, y: base }, text: no, size: 1.8, anchor: "middle", bold });
    prims.push({ kind: "text", at: { x: x + noW + 1.5, y: base }, text: date, size: 1.8, anchor: "start", bold });
    const room = Math.floor((w - noW - dateW - 3) / (1.8 * TEXT_WIDTH_PER_CHAR));
    prims.push({ kind: "text", at: { x: x + noW + dateW + 1.5, y: base }, text: desc.length > room ? `${desc.slice(0, Math.max(1, room - 1))}…` : desc, size: 1.8, anchor: "start", bold });
  };
  cells(header, "NO.", "DATE", "DESCRIPTION", true);
  rows.forEach((r, i) => cells(header + REVISION_ROW_MM * (i + 1), r.number, r.date, r.description.toUpperCase(), false));
  prims.push({ kind: "line", a: { x: x + noW, y: header }, b: { x: x + noW, y: bottomY }, pen: "thin" });
  prims.push({ kind: "line", a: { x: x + noW + dateW, y: header }, b: { x: x + noW + dateW, y: bottomY }, pen: "thin" });
  prims.push({ kind: "line", a: { x, y: bottomY }, b: { x: x + w, y: bottomY }, pen: "medium" });
  return top;
}

/** Title-block fields with a fixed slot of their own (never repeated in the extra rows). */
const FIXED_FIELDS: ReadonlySet<string> = new Set(["firm_name", "project_name", "project_number"]);

/** What a sheet's title block prints in its fixed slots: the sheet's own fields, else the project's (blank when neither says). */
export function titleBlockValues(sheet: Pick<Sheet, "props">, opts: Pick<SheetDrawOptions, "projectName" | "projectNumber" | "firmName">): { readonly firm: string; readonly project: string; readonly projectNumber: string } {
  const fields = sheet.props?.fields ?? {};
  const own = (key: string, fallback: string | undefined) => (fields[key]?.trim() || fallback?.trim() || "").toUpperCase();
  return { firm: own("firm_name", opts.firmName), project: own("project_name", opts.projectName), projectNumber: own("project_number", opts.projectNumber) };
}

/** Height of the title block's sheet-number box, from the border up (mm). */
const SHEET_NUMBER_BOX_MM = 45;
/** The sheet number's cap height above its baseline (baseline 14 mm above the border, text 10 or 14 mm) stays under this (mm above the border). */
const SHEET_NUMBER_TOP_MM = 26;

/**
 * The clear slot for an issued sheet's Verify code (mm, y down): the upper
 * right of the title block's sheet-number box, right of the "SHEET NUMBER"
 * label, above the number and below the box's top line. Inside the border, so
 * a printer's unprintable edge never clips it.
 */
export function titleBlockCodeSlot(paper: Vec2): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } {
  const w = paper.x < 600 ? 70 : 100;
  const bottom = paper.y - 12.7;
  return { left: paper.x - 12.7 - w / 2, right: paper.x - 12.7 - 2, top: bottom - SHEET_NUMBER_BOX_MM + 1, bottom: bottom - SHEET_NUMBER_TOP_MM };
}

function drawTitleBlockFor(prims: Primitive[], sheet: Sheet, paper: Vec2, opts: SheetDrawOptions): void {
  const small = paper.x < 600;
  const w = small ? 70 : 100;
  const x = paper.x - 12.7 - w;
  const top = 12.7;
  const bottom = paper.y - 12.7;
  const fields = sheet.props?.fields ?? {};
  const printed = titleBlockValues(sheet, opts);
  // Shrink a value until it fits the block's width, so a long project name is never cut off.
  const fit = (value: string, size: number, room = w - 6) => Math.max(1.6, Math.min(size, room / Math.max(1, value.length * TEXT_WIDTH_PER_CHAR)));
  prims.push({ kind: "line", a: { x, y: top }, b: { x, y: bottom }, pen: "heavy" });
  const field = (y: number, labelText: string, value: string, size = 3) => {
    prims.push({ kind: "line", a: { x, y: y - 6 }, b: { x: x + w, y: y - 6 }, pen: "thin" });
    prims.push({ kind: "text", at: { x: x + 3, y: y - 1.5 }, text: labelText, size: 1.8, anchor: "start" });
    if (value) prims.push({ kind: "text", at: { x: x + 3, y: y + size + 1 }, text: value, size: fit(value, size), anchor: "start", bold: true });
  };
  if (printed.firm) prims.push({ kind: "text", at: { x: x + w / 2, y: top + 14 }, text: printed.firm, size: fit(printed.firm, small ? 4.5 : 6), anchor: "middle", bold: true });
  field(top + 32, "PROJECT", printed.project, 3);
  field(top + 47, "PROJECT NO.", printed.projectNumber, 2.8);
  field(top + 62, "SHEET TITLE", sheet.title.toUpperCase(), 2.8);
  const extra = Object.keys(fields).filter((k) => !FIXED_FIELDS.has(k));
  const keys = [...FIELD_ORDER.filter((k) => fields[k]), ...extra.filter((k) => !(FIELD_ORDER as readonly string[]).includes(k)).sort()];
  const revisionsTop = drawRevisionTable(prims, sheet.props?.revisions ?? [], x, w, bottom - 70, small);
  let y = top + 80;
  for (const key of keys) {
    const value = fields[key];
    if (!value || y > revisionsTop - 8) continue;
    field(y, FIELD_LABEL[key] ?? key.replace(/_/g, " ").toUpperCase(), value, 2.5);
    y += 15;
  }
  // The sheet's own issue revision (the last row of its revision table), not the model's save counter: a sheet is "Rev 3" because it was issued three times.
  const issued = sheet.props?.revisions?.at(-1);
  field(bottom - 62, "REVISION", issued ? issued.number : "NOT ISSUED", 2.5);
  prims.push({ kind: "line", a: { x, y: bottom - SHEET_NUMBER_BOX_MM }, b: { x: x + w, y: bottom - SHEET_NUMBER_BOX_MM }, pen: "medium" });
  prims.push({ kind: "text", at: { x: x + 3, y: bottom - 40 }, text: "SHEET NUMBER", size: 1.8, anchor: "start" });
  prims.push({ kind: "text", at: { x: x + w / 2, y: bottom - 14 }, text: sheet.number, size: small ? 10 : 14, anchor: "middle", bold: true });
}

