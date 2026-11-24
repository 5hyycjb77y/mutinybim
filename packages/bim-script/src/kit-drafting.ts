import {
  DEFAULT_NOTE_SIZE_MM,
  DETAIL_LINE_STYLES,
  DRAFTING_CAD_STANDARDS_FEATURE,
  HATCH_PATTERNS,
  LINE_PATTERNS,
  LINE_WEIGHTS_2D,
  NOTE_LEADER_ARROWS,
  REGION_TONES,
  arcStartEndRadius,
  chainLines,
  checkDetailView,
  detailComponent,
  detailComponents,
  detailContentBounds,
  documentIndex,
  layoutNote,
  lineStyleFor,
  modifyCommand,
  polygonLines,
  rectangleLines,
  tangentEndArc,
  type Command,
  type DetailCheckReport,
  type DetailLineStyleId,
  type DraftingCategory,
  type HatchPattern,
  type LinePattern,
  type LineStyle,
  type LineWeight2D,
  type ModelState,
  type ModifyOp,
  type NoteAlign,
  type NoteLeaderArrow,
  type NoteParagraph,
  type RegionTone,
  type Sheet,
  type Vec2,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { measureIn, type Measure } from "@permitzip/bim-units";
import { ScriptRunError, type ScriptContext } from "./context";
import { hasSliceFeature, onWorking } from "./working";

/**
 * `drafting`: first-class CAD drafting for detail views, plans, sections, and
 * sheets. Every coordinate, size, radius, offset, and thickness uses typed
 * `Measure` lengths (`units.in`, `units.ft`, `units.mm`) and dispatches through
 * the kernel's real drafting commands (`create_view`, `add_drawing_item`,
 * `create_text_note`, `modifyCommand`, `update_view_crop`).
 */

type AddDrawingItem = Extract<Command, { type: "add_drawing_item" }>;
type DimOf = NonNullable<AddDrawingItem["dim"]>;

const IN_MM = 25.4;

export interface DraftPoint {
  readonly x: Measure;
  readonly y: Measure;
}

export interface DraftStyleSpec {
  readonly lineStyle?: DetailLineStyleId;
  readonly weight?: LineWeight2D;
  readonly pattern?: LinePattern;
  readonly category?: DraftingCategory;
  readonly group?: string;
}

export interface DetailViewSpec {
  readonly name: string;
  /** Drawing scale denominator (default 16 = 3/4" = 1'-0"). Common: 8 (1-1/2"), 12 (1"), 16 (3/4"), 24 (1/2"), 48 (1/4"). */
  readonly scale?: number;
  readonly discipline?: string;
  readonly crop?: { readonly from: DraftPoint; readonly to: DraftPoint };
  readonly id?: string;
}

export interface FitCropSpec {
  /** Paper-space margin around the tight content bounds (default 0.35 in). */
  readonly margin?: Measure;
  /** Minimum model-space margin if preferred over paper margin. */
  readonly modelMargin?: Measure;
}

export interface DraftLineSpec extends DraftStyleSpec {
  readonly view: string;
  readonly from: DraftPoint;
  readonly to: DraftPoint;
  readonly id?: string;
}

export type DraftRectGeometry =
  | { readonly corner: DraftPoint; readonly opposite: DraftPoint; readonly at?: undefined; readonly width?: undefined; readonly height?: undefined }
  | { readonly at: DraftPoint; readonly width: Measure; readonly height: Measure; readonly corner?: undefined; readonly opposite?: undefined };

export type DraftRectSpec = DraftStyleSpec & DraftRectGeometry & {
  readonly view: string;
  readonly id?: string;
};

export interface DraftChainSpec extends DraftStyleSpec {
  readonly view: string;
  readonly points: readonly DraftPoint[];
  readonly closed?: boolean;
  readonly id?: string;
}

export interface DraftPolygonSpec extends DraftStyleSpec {
  readonly view: string;
  readonly center: DraftPoint;
  readonly radius: Measure;
  readonly sides: number;
  readonly inscribed?: boolean;
  readonly rotationDeg?: number;
  readonly id?: string;
}

export interface DraftArcSpec extends DraftStyleSpec {
  readonly view: string;
  readonly center: DraftPoint;
  readonly start: DraftPoint;
  readonly end: DraftPoint;
  readonly clockwise?: boolean;
  readonly id?: string;
}

export interface DraftArcRadiusSpec extends DraftStyleSpec {
  readonly view: string;
  readonly start: DraftPoint;
  readonly end: DraftPoint;
  readonly radius: Measure;
  /** Point on the bulge side of the arc. */
  readonly toward: DraftPoint;
  readonly id?: string;
}

export interface DraftArcTangentSpec extends DraftStyleSpec {
  readonly view: string;
  readonly start: DraftPoint;
  /** Point behind `start` along the line this arc continues tangentially from. */
  readonly from: DraftPoint;
  readonly end: DraftPoint;
  readonly id?: string;
}

export interface DraftCircleSpec extends DraftStyleSpec {
  readonly view: string;
  readonly center: DraftPoint;
  readonly radius: Measure;
  readonly id?: string;
}

export interface DraftSplineSpec extends DraftStyleSpec {
  readonly view: string;
  readonly points: readonly DraftPoint[];
  readonly closed?: boolean;
  readonly id?: string;
}

export interface DraftRegionSpec extends DraftStyleSpec {
  readonly view: string;
  /** Closed polygon boundary (>= 3 vertices). Provide either `points` or `rect`. */
  readonly points?: readonly DraftPoint[];
  /** Rectangular shorthand boundary (`{ at, width, height }` or `{ corner, opposite }`). */
  readonly rect?: DraftRectGeometry;
  /** CAD hatch pattern (default `"diagonal"`, or `"solid"` when `masking: true`). */
  readonly hatch?: HatchPattern;
  /** Ink tone for figure-ground hierarchy: `"ink"` (default black), `"halftone"` (mid-grey), or `"screened"` (light grey). */
  readonly tone?: RegionTone;
  /** Opaque white masking region hiding geometry behind it. */
  readonly masking?: boolean;
  /** Draw boundary outline around region (default true). */
  readonly boundary?: boolean;
  /** Paper-space hatch spacing (e.g. `units.in(0.08)`). */
  readonly spacing?: Measure;
  readonly id?: string;
}

export interface DraftComponentSpec extends DraftStyleSpec {
  readonly view: string;
  /** 2D detail component id from `drafting.catalog(ctx)` (e.g. `"mechanical.hooded_louver"`, `"break_line"`, `"flow_arrow"`). */
  readonly symbol: string;
  readonly at: DraftPoint;
  readonly width?: Measure;
  readonly height?: Measure;
  readonly rotationDeg?: number;
  readonly mirror?: boolean;
  readonly id?: string;
}

export interface DraftRepeatSpec extends DraftStyleSpec {
  readonly view: string;
  readonly symbol: string;
  readonly from: DraftPoint;
  readonly to: DraftPoint;
  readonly spacing?: Measure;
  readonly width?: Measure;
  readonly height?: Measure;
  readonly id?: string;
}

export interface DraftBattSpec extends DraftStyleSpec {
  readonly view: string;
  readonly from: DraftPoint;
  readonly to: DraftPoint;
  readonly thickness: Measure;
  readonly id?: string;
}

export interface DraftBreakLineSpec extends DraftStyleSpec {
  readonly view: string;
  readonly from: DraftPoint;
  readonly to: DraftPoint;
  /** Optional masking strip on one side of the break line to cleanly hide truncated geometry (`"left"` / `"right"` relative to `from → to`, or `"none"`). */
  readonly maskSide?: "left" | "right" | "none";
  /** Depth of the masking strip when `maskSide` is `"left"` or `"right"` (default 6 in). */
  readonly maskDepth?: Measure;
  readonly id?: string;
}

export interface DraftLeaderSpec {
  readonly to: DraftPoint;
  /** `"auto"` (default) computes a crisp horizontal landing shoulder off the note box; pass a point for an explicit elbow or `null` for a straight leader. */
  readonly elbow?: "auto" | DraftPoint | null;
  /** Arrowhead terminator (`"filled_arrow"` default when CAD standards are active, `"arrow"` otherwise). */
  readonly arrow?: NoteLeaderArrow;
}

export interface DraftNoteSpec {
  readonly view: string;
  /** Top-left corner of the note box (view coordinates, or paper coordinates on a sheet). */
  readonly at: DraftPoint;
  /** Plain multi-line text (newlines become paragraphs). Provide either `text` or `paragraphs`. */
  readonly text?: string;
  /** Full rich-text paragraphs (bold, italic, underline, lists, alignment). */
  readonly paragraphs?: readonly NoteParagraph[];
  /** Paper-space wrapping width (default `units.in(2.4)`). */
  readonly width?: Measure;
  /** Paper-space cap height (default `units.in(0.09375)` = 3/32"). */
  readonly textHeight?: Measure;
  readonly align?: NoteAlign;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  /** Opaque paper-white background mask behind the note (default true when supported). */
  readonly mask?: boolean;
  readonly textStyleId?: string;
  readonly leaders?: readonly DraftLeaderSpec[];
  readonly id?: string;
}

export interface CalloutStackEntry {
  readonly text: string;
  /** One target point or multiple target points for a multi-leader callout. */
  readonly to?: DraftPoint | readonly DraftPoint[];
  readonly arrow?: NoteLeaderArrow;
  readonly bold?: boolean;
  readonly id?: string;
}

export interface DraftCalloutStackSpec {
  readonly view: string;
  /** `"left"` places right-aligned notes to the left of `x`; `"right"` places left-aligned notes to the right of `x`. */
  readonly side: "left" | "right";
  /** Inner margin line x-coordinate (closest to the detail geometry). */
  readonly x: Measure;
  /** Top y-coordinate of the first callout note. */
  readonly topY: Measure;
  /** Paper-space width of every callout box (default `units.in(2.4)`). */
  readonly width?: Measure;
  /** Paper-space cap height (default `units.in(0.09375)` = 3/32"). */
  readonly textHeight?: Measure;
  /** Paper-space vertical gap between stacked callouts (default `units.in(0.11)`). */
  readonly gap?: Measure;
  /** Opaque paper-white background mask behind each callout (default true when supported). */
  readonly mask?: boolean;
  /** Default leader arrowhead (default `"filled_arrow"` when supported). */
  readonly arrow?: NoteLeaderArrow;
  readonly notes: readonly CalloutStackEntry[];
}

export interface DraftDetailTitleSpec {
  readonly view: string;
  /** Top-left position of the title block inside the drafting view. */
  readonly at: DraftPoint;
  readonly title: string;
  readonly subtitle?: string;
  /** Paper-space width for title wrapping & default underline length (default `units.in(5.5)`). */
  readonly width?: Measure;
  /** Explicit view-space underline length (overrides paper width). */
  readonly ruleLength?: Measure;
  /** Title cap height on paper (default `units.in(0.14)`). */
  readonly textHeight?: Measure;
  /** Draw heavy underline rule beneath title (default true). */
  readonly underline?: boolean;
  readonly id?: string;
}

export interface DraftDimensionSpec {
  readonly view: string;
  /** Start point (for a 2-point dimension). Provide either `from`/`to` or `points` (>= 2 points for a chain). */
  readonly from?: DraftPoint;
  readonly to?: DraftPoint;
  /** Two or more points for a continuous chain dimension. */
  readonly points?: readonly DraftPoint[];
  /** Paper-space offset from measured points to the dimension line (default `units.in(0.35)`). */
  readonly offset?: Measure;
  readonly kind?: "linear" | "aligned";
  readonly prefix?: string;
  readonly suffix?: string;
  readonly textOverride?: string;
  readonly direction?: DimOf["direction"];
  readonly refs?: DimOf["refs"];
  readonly style?: DimOf["style"];
  readonly id?: string;
}

export type DraftModifyOp =
  | { readonly op: "move"; readonly dx: Measure; readonly dy: Measure; readonly disjoin?: boolean }
  | { readonly op: "copy"; readonly dx: Measure; readonly dy: Measure }
  | { readonly op: "rotate"; readonly center: DraftPoint; readonly angleDeg: number; readonly copy?: boolean }
  | { readonly op: "scale"; readonly center: DraftPoint; readonly factor: number }
  | { readonly op: "mirror"; readonly axisFrom: DraftPoint; readonly axisTo: DraftPoint; readonly copy?: boolean }
  | { readonly op: "linear_array"; readonly dx: Measure; readonly dy: Measure; readonly count: number; readonly group?: boolean }
  | { readonly op: "radial_array"; readonly center: DraftPoint; readonly angleDeg: number; readonly count: number; readonly group?: boolean }
  | { readonly op: "align"; readonly from: DraftPoint; readonly axisFrom: DraftPoint; readonly axisTo: DraftPoint }
  | { readonly op: "offset"; readonly distance: Measure; readonly side: DraftPoint; readonly copy?: boolean }
  | { readonly op: "trim_corner"; readonly keepA: DraftPoint; readonly keepB: DraftPoint }
  | { readonly op: "trim_single"; readonly boundaryId: string; readonly pick: DraftPoint }
  | { readonly op: "trim_multiple"; readonly boundaryId: string; readonly picks: readonly DraftPoint[] }
  | { readonly op: "trim"; readonly boundaryId: string; readonly keep: DraftPoint }
  | { readonly op: "extend"; readonly boundaryId: string; readonly near: DraftPoint }
  | { readonly op: "split"; readonly at: DraftPoint; readonly to?: DraftPoint }
  | { readonly op: "split_gap"; readonly at: DraftPoint; readonly gap: Measure }
  | { readonly op: "fillet"; readonly radius: Measure; readonly near1?: DraftPoint; readonly near2?: DraftPoint }
  | { readonly op: "chamfer"; readonly distanceA: Measure; readonly distanceB?: Measure; readonly near1?: DraftPoint; readonly near2?: DraftPoint }
  | { readonly op: "drag_end"; readonly end: 0 | 1 | "start" | "end"; readonly to: DraftPoint; readonly disjoin?: boolean }
  | { readonly op: "pin" | "unpin" | "delete" }
  | { readonly op: "match_type"; readonly sourceId: string };

export interface DraftModifySpec {
  readonly view: string;
  readonly items: readonly string[];
  readonly op: DraftModifyOp;
}

export interface DraftGroupSpec {
  readonly view: string;
  readonly items: readonly string[];
  readonly group: string;
}

interface OwnerInfo {
  readonly id: string;
  readonly scale: number;
  readonly isSheet: boolean;
  readonly view?: ViewElement;
}

function mm(m: Measure, what: string): number {
  if (m.kind !== "length") throw new ScriptRunError(`${what} is a length; got ${m.kind}.`);
  return Math.round(measureIn(m, "mm") * 1000) / 1000;
}

function ptMm(p: DraftPoint, what: string): Vec2 {
  return { x: mm(p.x, `${what}.x`), y: mm(p.y, `${what}.y`) };
}

function resolveOwner(model: ModelState, ref: string, caller: string): OwnerInfo {
  const direct = model.elements[ref];
  if (direct?.kind === "view" && !direct.deleted) {
    if (direct.viewType === "three_d" || direct.viewType === "schedule") {
      throw new ScriptRunError(`${caller}: "${direct.name}" is a ${direct.viewType} view and does not accept 2D drafting.`);
    }
    return { id: direct.id, scale: direct.props?.scale ?? 16, isSheet: false, view: direct };
  }
  if (direct?.kind === "sheet" && !direct.deleted) {
    return { id: direct.id, scale: 1, isSheet: true };
  }
  const byName = Object.values(model.elements).find(
    (e): e is ViewElement => e.kind === "view" && !e.deleted && e.name === ref,
  );
  if (byName) {
    if (byName.viewType === "three_d" || byName.viewType === "schedule") {
      throw new ScriptRunError(`${caller}: "${byName.name}" is a ${byName.viewType} view and does not accept 2D drafting.`);
    }
    return { id: byName.id, scale: byName.props?.scale ?? 16, isSheet: false, view: byName };
  }
  const sheet = Object.values(model.elements).find(
    (e): e is Sheet => e.kind === "sheet" && !e.deleted && (e.number === ref || e.title === ref),
  );
  if (sheet) return { id: sheet.id, scale: 1, isSheet: true };
  throw new ScriptRunError(`${caller}: no view or sheet "${ref}" in this model. Create one with drafting.view(ctx, ...) or read views/sheets.`);
}

function ownerOf(ctx: ScriptContext, ref: string, caller: string): OwnerInfo {
  return onWorking(ctx, caller, (m) => resolveOwner(m, ref, caller));
}

function styleProps(spec: DraftStyleSpec): {
  readonly lineStyle?: LineStyle;
  readonly category?: DraftingCategory;
  readonly detailGroup?: string;
} {
  const named: LineStyle = spec.lineStyle ? lineStyleFor(spec.lineStyle) : {};
  const lineStyle: LineStyle = {
    ...named,
    ...(spec.weight ? { weight: spec.weight } : {}),
    ...(spec.pattern ? { pattern: spec.pattern } : {}),
  };
  return {
    ...(Object.keys(lineStyle).length > 0 ? { lineStyle } : {}),
    ...(spec.category ? { category: spec.category } : {}),
    ...(spec.group ? { detailGroup: spec.group } : {}),
  };
}

function rectCorners(geom: DraftRectGeometry, what: string): readonly [Vec2, Vec2] {
  if (geom.at !== undefined) {
    const a = ptMm(geom.at, `${what}.at`);
    const w = mm(geom.width, `${what}.width`);
    const h = mm(geom.height, `${what}.height`);
    return [a, { x: a.x + w, y: a.y + h }];
  }
  return [ptMm(geom.corner, `${what}.corner`), ptMm(geom.opposite, `${what}.opposite`)];
}

function paragraphsFromSpec(spec: Pick<DraftNoteSpec, "text" | "paragraphs" | "align" | "bold" | "italic" | "underline">): NoteParagraph[] {
  if (spec.paragraphs && spec.paragraphs.length > 0) {
    return spec.paragraphs.map((p) => ({
      ...(p.align ? { align: p.align } : {}),
      ...(p.list ? { list: p.list } : {}),
      runs: p.runs.map((r) => ({ ...r })),
    }));
  }
  const raw = spec.text ?? "";
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    throw new ScriptRunError("drafting.note requires non-empty `text` or `paragraphs`.");
  }
  return lines.map((line) => ({
    ...(spec.align ? { align: spec.align } : {}),
    runs: [
      {
        text: line,
        ...(spec.bold ? { bold: true } : {}),
        ...(spec.italic ? { italic: true } : {}),
        ...(spec.underline ? { underline: true } : {}),
      },
    ],
  }));
}

/** Auto-compute a clean dead-level horizontal shoulder elbow off the left or right edge of a note box. */
function autoElbow(atMm: Vec2, widthPaperMm: number, firstLineMidPaperMm: number, scale: number, toMm: Vec2): Vec2 {
  const boxWidthModel = widthPaperMm * scale;
  const shoulderModel = 0.18 * IN_MM * scale;
  const centerX = atMm.x + boxWidthModel / 2;
  const attachY = atMm.y - firstLineMidPaperMm * scale;
  const onRight = toMm.x >= centerX;
  return {
    x: Math.round((onRight ? atMm.x + boxWidthModel + shoulderModel : atMm.x - shoulderModel) * 1000) / 1000,
    y: Math.round(attachY * 1000) / 1000,
  };
}

function convertModifyOp(op: DraftModifyOp): ModifyOp {
  switch (op.op) {
    case "move":
      return { op: "move", delta: { x: mm(op.dx, "move.dx"), y: mm(op.dy, "move.dy") }, ...(op.disjoin ? { disjoin: true } : {}) };
    case "copy":
      return { op: "copy", delta: { x: mm(op.dx, "copy.dx"), y: mm(op.dy, "copy.dy") } };
    case "rotate":
      return { op: "rotate", center: ptMm(op.center, "rotate.center"), angleDeg: op.angleDeg, ...(op.copy ? { copy: true } : {}) };
    case "scale":
      return { op: "scale", center: ptMm(op.center, "scale.center"), factor: op.factor };
    case "mirror":
      return { op: "mirror", a: ptMm(op.axisFrom, "mirror.axisFrom"), b: ptMm(op.axisTo, "mirror.axisTo"), ...(op.copy ? { copy: true } : {}) };
    case "linear_array":
      return { op: "array", delta: { x: mm(op.dx, "linear_array.dx"), y: mm(op.dy, "linear_array.dy") }, count: op.count, ...(op.group ? { group: true } : {}) };
    case "radial_array":
      return { op: "polar_array", center: ptMm(op.center, "radial_array.center"), angleDeg: op.angleDeg, count: op.count, ...(op.group ? { group: true } : {}) };
    case "align":
      return { op: "align", from: ptMm(op.from, "align.from"), a: ptMm(op.axisFrom, "align.axisFrom"), b: ptMm(op.axisTo, "align.axisTo") };
    case "offset":
      return { op: "offset", distance: mm(op.distance, "offset.distance"), side: ptMm(op.side, "offset.side"), ...(op.copy !== undefined ? { copy: op.copy } : {}) };
    case "trim_corner":
      return { op: "trim_extend_corner", keep1: ptMm(op.keepA, "trim_corner.keepA"), keep2: ptMm(op.keepB, "trim_corner.keepB") };
    case "trim_single":
      return { op: "trim_extend_single", boundaryId: op.boundaryId, keep: ptMm(op.pick, "trim_single.pick") };
    case "trim_multiple":
      return { op: "trim_extend_multiple", boundaryId: op.boundaryId, keeps: op.picks.map((p, i) => ptMm(p, `trim_multiple.picks[${i}]`)) };
    case "trim":
      return { op: "trim", boundaryId: op.boundaryId, keep: ptMm(op.keep, "trim.keep") };
    case "extend":
      return { op: "extend", boundaryId: op.boundaryId, near: ptMm(op.near, "extend.near") };
    case "split":
      return { op: "split", at: ptMm(op.at, "split.at"), ...(op.to ? { to: ptMm(op.to, "split.to") } : {}) };
    case "split_gap":
      return { op: "split_gap", at: ptMm(op.at, "split_gap.at"), gap: mm(op.gap, "split_gap.gap") };
    case "fillet":
      return {
        op: "fillet_arc",
        radius: mm(op.radius, "fillet.radius"),
        ...(op.near1 ? { near1: ptMm(op.near1, "fillet.near1") } : {}),
        ...(op.near2 ? { near2: ptMm(op.near2, "fillet.near2") } : {}),
      };
    case "chamfer": {
      const d1 = mm(op.distanceA, "chamfer.distanceA");
      return {
        op: "chamfer",
        d1,
        ...(op.distanceB ? { d2: mm(op.distanceB, "chamfer.distanceB") } : {}),
        ...(op.near1 ? { near1: ptMm(op.near1, "chamfer.near1") } : {}),
        ...(op.near2 ? { near2: ptMm(op.near2, "chamfer.near2") } : {}),
      };
    }
    case "drag_end":
      return {
        op: "move_end",
        end: op.end === 0 || op.end === "start" ? "start" : "end",
        to: ptMm(op.to, "drag_end.to"),
        ...(op.disjoin ? { disjoin: true } : {}),
      };
    case "pin":
    case "unpin":
    case "delete":
      return { op: op.op };
    case "match_type":
      return { op: "match_type", sourceId: op.sourceId };
  }
}

export const drafting = {
  /** Creates a 2D drafting detail view (default scale 16 = 3/4" = 1'-0"). */
  view(ctx: ScriptContext, spec: DetailViewSpec): string {
    const viewId = spec.id ?? ctx.id("detail");
    const crop = spec.crop
      ? {
          min: {
            x: Math.min(mm(spec.crop.from.x, "Crop x"), mm(spec.crop.to.x, "Crop x")),
            y: Math.min(mm(spec.crop.from.y, "Crop y"), mm(spec.crop.to.y, "Crop y")),
          },
          max: {
            x: Math.max(mm(spec.crop.from.x, "Crop x"), mm(spec.crop.to.x, "Crop x")),
            y: Math.max(mm(spec.crop.from.y, "Crop y"), mm(spec.crop.to.y, "Crop y")),
          },
        }
      : undefined;
    ctx.edit({
      type: "create_view",
      viewId,
      name: spec.name,
      viewType: "detail",
      ...(crop ? { crop } : {}),
      props: {
        scale: spec.scale ?? 16,
        ...(spec.discipline ? { discipline: spec.discipline } : {}),
      },
    });
    return viewId;
  },

  /** Fits a drafting view's crop box tightly around all drawn items, notes, leaders, and dimensions with a clean margin. */
  fitCrop(ctx: ScriptContext, viewRef: string, opts: FitCropSpec = {}): { readonly min: Vec2; readonly max: Vec2; readonly itemCount: number } {
    const measured = onWorking(ctx, "drafting.fitCrop", (m) => {
      const owner = resolveOwner(m, viewRef, "drafting.fitCrop");
      if (!owner.view) throw new ScriptRunError("drafting.fitCrop operates on a view, not a sheet.");
      const bounds = detailContentBounds(m, owner.id);
      if (!bounds) throw new ScriptRunError(`drafting.fitCrop: view "${owner.view.name}" has no drawn items yet.`);
      const itemCount = (documentIndex(m).itemsByOwner.get(owner.id) ?? []).filter((i) => !i.deleted).length;
      const padMm = opts.modelMargin
        ? mm(opts.modelMargin, "fitCrop.modelMargin")
        : (opts.margin ? mm(opts.margin, "fitCrop.margin") : 0.35 * IN_MM) * owner.scale;
      const min = { x: Math.round((bounds.min.x - padMm) * 1000) / 1000, y: Math.round((bounds.min.y - padMm) * 1000) / 1000 };
      const max = { x: Math.round((bounds.max.x + padMm) * 1000) / 1000, y: Math.round((bounds.max.y + padMm) * 1000) / 1000 };
      return { viewId: owner.id, min, max, itemCount };
    });
    ctx.edit({ type: "set_view_crop", viewId: measured.viewId, crop: { min: measured.min, max: measured.max } });
    return { min: measured.min, max: measured.max, itemCount: measured.itemCount };
  },

  /** Draws one 2D detail line. */
  line(ctx: ScriptContext, spec: DraftLineSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.line");
    const itemId = spec.id ?? ctx.id("dl");
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: owner.id,
      shape: "line",
      points: [ptMm(spec.from, "line.from"), ptMm(spec.to, "line.to")],
      ...styleProps(spec),
    });
    return itemId;
  },

  /** Draws a rectangle as four joined detail lines (accepts `{ corner, opposite }` or `{ at, width, height }`). */
  rect(ctx: ScriptContext, spec: DraftRectSpec): string[] {
    const owner = ownerOf(ctx, spec.view, "drafting.rect");
    const [a, b] = rectCorners(spec, "rect");
    const segs = rectangleLines(a, b);
    if (segs.length === 0) throw new ScriptRunError("drafting.rect: rectangle has zero width or height.");
    const prefix = spec.id ?? ctx.id("rect");
    const style = styleProps(spec);
    const ids: string[] = [];
    for (const [k, [p0, p1]] of segs.entries()) {
      const itemId = `${prefix}-${k}`;
      ctx.edit({ type: "add_drawing_item", itemId, ownerId: owner.id, shape: "line", points: [p0, p1], ...style });
      ids.push(itemId);
    }
    return ids;
  },

  /** Draws a joined chain of detail lines through `points` (optionally `closed: true`). */
  chain(ctx: ScriptContext, spec: DraftChainSpec): string[] {
    const owner = ownerOf(ctx, spec.view, "drafting.chain");
    const pts = spec.points.map((p, i) => ptMm(p, `chain.points[${i}]`));
    const segs = chainLines(pts, spec.closed === true);
    if (segs.length === 0) throw new ScriptRunError("drafting.chain: need at least two distinct points.");
    const prefix = spec.id ?? ctx.id("chn");
    const style = styleProps(spec);
    const ids: string[] = [];
    for (const [k, [p0, p1]] of segs.entries()) {
      const itemId = `${prefix}-${k}`;
      ctx.edit({ type: "add_drawing_item", itemId, ownerId: owner.id, shape: "line", points: [p0, p1], ...style });
      ids.push(itemId);
    }
    return ids;
  },

  /** Draws a regular inscribed or circumscribed polygon as joined detail lines. */
  polygon(ctx: ScriptContext, spec: DraftPolygonSpec): string[] {
    const owner = ownerOf(ctx, spec.view, "drafting.polygon");
    const c = ptMm(spec.center, "polygon.center");
    const r = mm(spec.radius, "polygon.radius");
    const rad = ((spec.rotationDeg ?? 0) * Math.PI) / 180;
    const segs = polygonLines(c, { x: c.x + r * Math.cos(rad), y: c.y + r * Math.sin(rad) }, spec.sides, spec.inscribed !== false);
    if (segs.length === 0) throw new ScriptRunError("drafting.polygon: invalid radius or side count.");
    const prefix = spec.id ?? ctx.id("poly");
    const style = styleProps(spec);
    const ids: string[] = [];
    for (const [k, [p0, p1]] of segs.entries()) {
      const itemId = `${prefix}-${k}`;
      ctx.edit({ type: "add_drawing_item", itemId, ownerId: owner.id, shape: "line", points: [p0, p1], ...style });
      ids.push(itemId);
    }
    return ids;
  },

  /** Draws a center-start-end circular arc. */
  arc(ctx: ScriptContext, spec: DraftArcSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.arc");
    const itemId = spec.id ?? ctx.id("arc");
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: owner.id,
      shape: "arc",
      points: [ptMm(spec.center, "arc.center"), ptMm(spec.start, "arc.start"), ptMm(spec.end, "arc.end")],
      ccw: !spec.clockwise,
      ...styleProps(spec),
    });
    return itemId;
  },

  /** Draws a start-end-radius circular arc bulging toward `toward`. */
  arcRadius(ctx: ScriptContext, spec: DraftArcRadiusSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.arcRadius");
    const arc = arcStartEndRadius(
      ptMm(spec.start, "arcRadius.start"),
      ptMm(spec.end, "arcRadius.end"),
      mm(spec.radius, "arcRadius.radius"),
      ptMm(spec.toward, "arcRadius.toward"),
    );
    if (!arc) throw new ScriptRunError("drafting.arcRadius: radius is less than half the distance between start and end.");
    const itemId = spec.id ?? ctx.id("arc");
    ctx.edit({ type: "add_drawing_item", itemId, ownerId: owner.id, shape: "arc", points: arc.points, ccw: arc.ccw, ...styleProps(spec) });
    return itemId;
  },

  /** Draws an arc tangent to `from → start` ending at `end`. */
  arcTangent(ctx: ScriptContext, spec: DraftArcTangentSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.arcTangent");
    const s = ptMm(spec.start, "arcTangent.start");
    const f = ptMm(spec.from, "arcTangent.from");
    const arc = tangentEndArc(s, { x: s.x - f.x, y: s.y - f.y }, ptMm(spec.end, "arcTangent.end"));
    if (!arc) throw new ScriptRunError("drafting.arcTangent: end is collinear with the tangent direction.");
    const itemId = spec.id ?? ctx.id("arc");
    ctx.edit({ type: "add_drawing_item", itemId, ownerId: owner.id, shape: "arc", points: arc.points, ccw: arc.ccw, ...styleProps(spec) });
    return itemId;
  },

  /** Draws a detail circle. */
  circle(ctx: ScriptContext, spec: DraftCircleSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.circle");
    const c = ptMm(spec.center, "circle.center");
    const r = mm(spec.radius, "circle.radius");
    const itemId = spec.id ?? ctx.id("cir");
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: owner.id,
      shape: "circle",
      points: [c, { x: c.x + r, y: c.y }],
      ...styleProps(spec),
    });
    return itemId;
  },

  /** Draws a smooth Catmull-Rom spline through three or more points. */
  spline(ctx: ScriptContext, spec: DraftSplineSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.spline");
    if (spec.points.length < 3) throw new ScriptRunError("drafting.spline requires at least 3 points.");
    const itemId = spec.id ?? ctx.id("spl");
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: owner.id,
      shape: "spline",
      points: spec.points.map((p, i) => ptMm(p, `spline.points[${i}]`)),
      ...(spec.closed !== undefined ? { closed: spec.closed } : {}),
      ...styleProps(spec),
    });
    return itemId;
  },

  /** Draws a CAD hatched/filled or opaque white masking region (accepts `points` or `rect`, plus `hatch` and `tone`). */
  region(ctx: ScriptContext, spec: DraftRegionSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.region");
    let pts: Vec2[];
    if (spec.rect) {
      const [a, b] = rectCorners(spec.rect, "region.rect");
      pts = [
        { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
        { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
        { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
        { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) },
      ];
    } else if (spec.points && spec.points.length >= 3) {
      pts = spec.points.map((p, i) => ptMm(p, `region.points[${i}]`));
    } else {
      throw new ScriptRunError("drafting.region requires `points` (>= 3 vertices) or `rect`.");
    }
    const itemId = spec.id ?? ctx.id("reg");
    const spacingMm = spec.spacing ? mm(spec.spacing, "region.spacing") : undefined;
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: owner.id,
      shape: "region",
      points: pts,
      fill: {
        pattern: spec.masking ? "solid" : (spec.hatch ?? "diagonal"),
        ...(spec.masking ? { masking: true } : {}),
        ...(spec.tone ? { tone: spec.tone } : {}),
        ...(spec.boundary !== undefined ? { boundary: spec.boundary } : {}),
        ...(spacingMm !== undefined ? { spacingMm } : {}),
      },
      ...styleProps(spec),
    });
    return itemId;
  },

  /** Places a 2D detail component from the kernel or active discipline packs (e.g. `mechanical.hooded_louver`, `break_line`, `flow_arrow`). */
  component(ctx: ScriptContext, spec: DraftComponentSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.component");
    const found = onWorking(ctx, "drafting.component", () => detailComponent(spec.symbol));
    if (!found) {
      const available = onWorking(ctx, "drafting.component", () => detailComponents().map((c) => c.id));
      throw new ScriptRunError(`drafting.component: unknown symbol "${spec.symbol}". Available: ${available.slice(0, 20).join(", ")}${available.length > 20 ? "…" : ""} (call drafting.catalog(ctx) for all).`);
    }
    const itemId = spec.id ?? ctx.id("cmp");
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: owner.id,
      shape: "component",
      points: [ptMm(spec.at, "component.at")],
      component: {
        symbolId: spec.symbol,
        ...(spec.width ? { widthMm: mm(spec.width, "component.width") } : {}),
        ...(spec.height ? { heightMm: mm(spec.height, "component.height") } : {}),
        ...(spec.rotationDeg !== undefined ? { rotationDeg: spec.rotationDeg } : {}),
        ...(spec.mirror ? { mirror: true } : {}),
      },
      ...styleProps(spec),
    });
    return itemId;
  },

  /** Repeats a 2D detail component along `from → to`. */
  repeat(ctx: ScriptContext, spec: DraftRepeatSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.repeat");
    const itemId = spec.id ?? ctx.id("rep");
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: owner.id,
      shape: "repeat",
      points: [ptMm(spec.from, "repeat.from"), ptMm(spec.to, "repeat.to")],
      component: {
        symbolId: spec.symbol,
        ...(spec.spacing ? { spacingMm: mm(spec.spacing, "repeat.spacing") } : {}),
        ...(spec.width ? { widthMm: mm(spec.width, "repeat.width") } : {}),
        ...(spec.height ? { heightMm: mm(spec.height, "repeat.height") } : {}),
      },
      ...styleProps(spec),
    });
    return itemId;
  },

  /** Draws a batt insulation zig-zag strip between `from` and `to`. */
  batt(ctx: ScriptContext, spec: DraftBattSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.batt");
    const itemId = spec.id ?? ctx.id("batt");
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: owner.id,
      shape: "batt",
      points: [ptMm(spec.from, "batt.from"), ptMm(spec.to, "batt.to")],
      batt: { thicknessMm: mm(spec.thickness, "batt.thickness") },
      ...styleProps(spec),
    });
    return itemId;
  },

  /** Places an architectural/mechanical break line spanning `from → to`, optionally masking cut-off geometry on one side. */
  breakLine(ctx: ScriptContext, spec: DraftBreakLineSpec): { readonly breakLineId: string; readonly maskId?: string } {
    const owner = ownerOf(ctx, spec.view, "drafting.breakLine");
    const a = ptMm(spec.from, "breakLine.from");
    const b = ptMm(spec.to, "breakLine.to");
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) throw new ScriptRunError("drafting.breakLine: `from` and `to` must be distinct points.");
    const ux = dx / len;
    const uy = dy / len;
    const rotationDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const heightMm = Math.max(40, Math.min(len * 0.22, 0.22 * IN_MM * owner.scale));
    // Place mask first (if requested) following the exact break-line zig-zag profile so
    // nothing (not even a hatch or boundary edge) peeks through inside the zig-zag teeth.
    let maskId: string | undefined;
    if (spec.maskSide && spec.maskSide !== "none") {
      const depth = spec.maskDepth ? mm(spec.maskDepth, "breakLine.maskDepth") : 6 * IN_MM;
      const sideSign = spec.maskSide === "left" ? 1 : -1;
      const nx = -uy * sideSign;
      const ny = ux * sideSign;
      // Normal perpendicular to from→to pointing to the symbol's +v side (left of from→to): (-uy, ux)
      const lx = -uy;
      const ly = ux;
      const zigAt = (u: number, vOffset: number): Vec2 => ({
        x: a.x + ux * (u * len) + lx * (vOffset * heightMm),
        y: a.y + uy * (u * len) + ly * (vOffset * heightMm),
      });
      const zig: Vec2[] = [
        zigAt(0, 0),
        zigAt(0.42, 0),
        zigAt(0.46, 0.45),
        zigAt(0.54, -0.45),
        zigAt(0.58, 0),
        zigAt(1, 0),
      ];
      maskId = `${spec.id ?? ctx.id("brk")}-mask`;
      ctx.edit({
        type: "add_drawing_item",
        itemId: maskId,
        ownerId: owner.id,
        shape: "region",
        points: [
          ...zig,
          { x: b.x + nx * depth, y: b.y + ny * depth },
          { x: a.x + nx * depth, y: a.y + ny * depth },
        ],
        fill: { pattern: "solid", masking: true, boundary: false },
      });
    }
    const breakLineId = spec.id ?? ctx.id("brk");
    // `break_line` has `linear: true`, so `placeSymbol` centers its spine (v = 0.5) on `points[0]` along `rotationDeg`.
    // When masking on the right side, flip direction so the symbol's built-in whiteout mask faces the cut side too.
    const flip = spec.maskSide === "right";
    ctx.edit({
      type: "add_drawing_item",
      itemId: breakLineId,
      ownerId: owner.id,
      shape: "component",
      points: [flip ? b : a],
      component: { symbolId: "break_line", widthMm: len, heightMm, rotationDeg: flip ? rotationDeg + 180 : rotationDeg },
      ...styleProps(spec),
    });
    return maskId ? { breakLineId, maskId } : { breakLineId };
  },

  /**
   * Places a CAD rich-text note (`create_text_note`) with word wrap, opaque paper-white
   * background mask (on by default when supported), and auto-elbowed horizontal-shoulder leaders.
   */
  note(ctx: ScriptContext, spec: DraftNoteSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.note");
    const at = ptMm(spec.at, "note.at");
    const widthMm = spec.width ? mm(spec.width, "note.width") : 2.4 * IN_MM;
    const textSizeMm = spec.textHeight ? mm(spec.textHeight, "note.textHeight") : DEFAULT_NOTE_SIZE_MM;
    const paragraphs = paragraphsFromSpec(spec);
    const measured = layoutNote(paragraphs, { width: widthMm, height: null, size: textSizeMm });
    const firstMidPaperMm = measured.lines[0] ? measured.lines[0].top + measured.lines[0].height / 2 : measured.height / 2;
    const cadReady = hasSliceFeature(ctx, DRAFTING_CAD_STANDARDS_FEATURE);
    const mask = spec.mask !== undefined ? spec.mask : cadReady;
    const defaultArrow: NoteLeaderArrow = cadReady ? "filled_arrow" : "arrow";
    const leaders = spec.leaders?.map((l, i) => {
      const to = ptMm(l.to, `note.leaders[${i}].to`);
      const elbow =
        l.elbow === null
          ? undefined
          : l.elbow === undefined || l.elbow === "auto"
            ? autoElbow(at, widthMm, firstMidPaperMm, owner.scale, to)
            : ptMm(l.elbow, `note.leaders[${i}].elbow`);
      return {
        to,
        ...(elbow ? { elbow } : {}),
        arrow: l.arrow ?? defaultArrow,
      };
    });
    const itemId = spec.id ?? ctx.id("note");
    ctx.edit({
      type: "create_text_note",
      itemId,
      ownerId: owner.id,
      at,
      width: widthMm,
      textSize: textSizeMm,
      paragraphs,
      ...(mask ? { mask: true } : {}),
      ...(spec.textStyleId ? { textStyleId: spec.textStyleId } : {}),
      ...(leaders && leaders.length > 0 ? { leaders } : {}),
    });
    return itemId;
  },

  /**
   * Places a vertically aligned margin column of callout notes that auto-space by
   * exact wrapped text height (zero overlap) and route horizontal-shoulder leaders
   * cleanly to each target point.
   */
  calloutStack(ctx: ScriptContext, spec: DraftCalloutStackSpec): string[] {
    const owner = ownerOf(ctx, spec.view, "drafting.calloutStack");
    const widthMm = spec.width ? mm(spec.width, "calloutStack.width") : 2.4 * IN_MM;
    const textSizeMm = spec.textHeight ? mm(spec.textHeight, "calloutStack.textHeight") : DEFAULT_NOTE_SIZE_MM;
    const gapPaperMm = spec.gap ? mm(spec.gap, "calloutStack.gap") : 0.11 * IN_MM;
    const marginXMm = mm(spec.x, "calloutStack.x");
    const widthModelMm = widthMm * owner.scale;
    const noteX = spec.side === "left" ? marginXMm - widthModelMm : marginXMm;
    const align: NoteAlign = spec.side === "left" ? "right" : "left";
    const cadReady = hasSliceFeature(ctx, DRAFTING_CAD_STANDARDS_FEATURE);
    const mask = spec.mask !== undefined ? spec.mask : cadReady;
    const defaultArrow: NoteLeaderArrow = spec.arrow ?? (cadReady ? "filled_arrow" : "arrow");

    let cursorY = mm(spec.topY, "calloutStack.topY");
    const ids: string[] = [];

    for (const [idx, entry] of spec.notes.entries()) {
      const paragraphs = paragraphsFromSpec({ text: entry.text, align, bold: entry.bold });
      const measured = layoutNote(paragraphs, { width: widthMm, height: null, size: textSizeMm });
      const firstMidPaperMm = measured.lines[0] ? measured.lines[0].top + measured.lines[0].height / 2 : measured.height / 2;
      const at: Vec2 = { x: Math.round(noteX * 1000) / 1000, y: Math.round(cursorY * 1000) / 1000 };
      const targets = entry.to === undefined ? [] : Array.isArray(entry.to) ? entry.to : [entry.to];
      const leaders = targets.map((t, ti) => {
        const to = ptMm(t, `calloutStack.notes[${idx}].to[${ti}]`);
        const shoulderModel = 0.18 * IN_MM * owner.scale;
        const attachY = at.y - firstMidPaperMm * owner.scale;
        const elbowX = spec.side === "left" ? marginXMm + shoulderModel : marginXMm - shoulderModel;
        return {
          to,
          elbow: { x: Math.round(elbowX * 1000) / 1000, y: Math.round(attachY * 1000) / 1000 },
          arrow: entry.arrow ?? defaultArrow,
        };
      });
      const itemId = entry.id ?? ctx.id("call");
      ctx.edit({
        type: "create_text_note",
        itemId,
        ownerId: owner.id,
        at,
        width: widthMm,
        textSize: textSizeMm,
        paragraphs,
        ...(mask ? { mask: true } : {}),
        ...(leaders.length > 0 ? { leaders } : {}),
      });
      ids.push(itemId);
      cursorY -= (measured.height + gapPaperMm) * owner.scale;
    }
    return ids;
  },

  /** Draws an NCS-standard detail subtitle heading (bold uppercase title + heavy underline rule + optional subtitle). */
  detailTitle(ctx: ScriptContext, spec: DraftDetailTitleSpec): { readonly titleId: string; readonly ruleId?: string; readonly subtitleId?: string } {
    const owner = ownerOf(ctx, spec.view, "drafting.detailTitle");
    const at = ptMm(spec.at, "detailTitle.at");
    const widthMm = spec.width ? mm(spec.width, "detailTitle.width") : 5.5 * IN_MM;
    const textSizeMm = spec.textHeight ? mm(spec.textHeight, "detailTitle.textHeight") : 0.13 * IN_MM;
    const cadReady = hasSliceFeature(ctx, DRAFTING_CAD_STANDARDS_FEATURE);
    const titleId = spec.id ?? ctx.id("title");
    const titleParagraphs: NoteParagraph[] = [{ runs: [{ text: spec.title, bold: true }] }];
    const titleLayout = layoutNote(titleParagraphs, { width: widthMm, height: null, size: textSizeMm });
    ctx.edit({
      type: "create_text_note",
      itemId: titleId,
      ownerId: owner.id,
      at,
      width: widthMm,
      textSize: textSizeMm,
      paragraphs: titleParagraphs,
      ...(cadReady ? { mask: true } : {}),
    });

    const ruleY = at.y - (titleLayout.height + 0.04 * IN_MM) * owner.scale;
    const ruleLen = spec.ruleLength ? mm(spec.ruleLength, "detailTitle.ruleLength") : widthMm * owner.scale;
    let ruleId: string | undefined;
    if (spec.underline !== false) {
      ruleId = `${titleId}-rule`;
      ctx.edit({
        type: "add_drawing_item",
        itemId: ruleId,
        ownerId: owner.id,
        shape: "line",
        points: [
          { x: at.x, y: Math.round(ruleY * 1000) / 1000 },
          { x: Math.round((at.x + ruleLen) * 1000) / 1000, y: Math.round(ruleY * 1000) / 1000 },
        ],
        lineStyle: { weight: "wide", pattern: "solid" },
      });
    }

    let subtitleId: string | undefined;
    if (spec.subtitle) {
      subtitleId = `${titleId}-sub`;
      const subY = ruleY - 0.05 * IN_MM * owner.scale;
      ctx.edit({
        type: "create_text_note",
        itemId: subtitleId,
        ownerId: owner.id,
        at: { x: at.x, y: Math.round(subY * 1000) / 1000 },
        width: widthMm,
        textSize: DEFAULT_NOTE_SIZE_MM,
        paragraphs: [{ runs: [{ text: spec.subtitle }] }],
        ...(cadReady ? { mask: true } : {}),
      });
    }
    return { titleId, ...(ruleId ? { ruleId } : {}), ...(subtitleId ? { subtitleId } : {}) };
  },

  /** Draws a CAD dimension (single `from`/`to` or multi-segment chain `points`) with optional prefix, suffix, text override, and style. */
  dimension(ctx: ScriptContext, spec: DraftDimensionSpec): string {
    const owner = ownerOf(ctx, spec.view, "drafting.dimension");
    let pts: Vec2[];
    if (spec.points && spec.points.length >= 2) {
      pts = spec.points.map((p, i) => ptMm(p, `dimension.points[${i}]`));
    } else if (spec.from && spec.to) {
      pts = [ptMm(spec.from, "dimension.from"), ptMm(spec.to, "dimension.to")];
    } else {
      throw new ScriptRunError("drafting.dimension requires `from` and `to`, or `points` (>= 2 points).");
    }
    const itemId = spec.id ?? ctx.id("dim");
    const dim: DimOf = {
      kind: spec.kind ?? "aligned",
      offsetMm: spec.offset ? mm(spec.offset, "dimension.offset") : 0.35 * IN_MM,
      ...(spec.direction ? { direction: spec.direction } : {}),
      ...(spec.refs ? { refs: spec.refs } : {}),
      ...(spec.prefix ? { prefix: spec.prefix } : {}),
      ...(spec.suffix ? { suffix: spec.suffix } : {}),
      ...(spec.textOverride ? { textOverride: spec.textOverride } : {}),
      ...(spec.style ? { style: spec.style } : {}),
    };
    ctx.edit({ type: "add_drawing_item", itemId, ownerId: owner.id, shape: "dimension", points: pts, dim });
    return itemId;
  },

  /** Runs any CAD Modify operation (move, copy, rotate, scale, mirror, arrays, align, offset, trim/extend, split, fillet, chamfer, pin, match_type, delete) on drafted items. */
  modify(ctx: ScriptContext, spec: DraftModifySpec): void {
    const command = onWorking(ctx, "drafting.modify", (m) => {
      const owner = resolveOwner(m, spec.view, "drafting.modify");
      const ownerItems = documentIndex(m).itemsByOwner.get(owner.id) ?? [];
      const op = convertModifyOp(spec.op);
      const idPrefix = ctx.id("mod");
      const out = modifyCommand(ownerItems, [...spec.items], op, owner.id, idPrefix);
      if (!out.ok) throw new ScriptRunError(`drafting.modify (${spec.op.op}): ${out.reason}`);
      return out.command;
    });
    ctx.editSteps(command);
  },

  /** Assigns drafted items to a detail group so they select, move, and copy together. */
  group(ctx: ScriptContext, spec: DraftGroupSpec): void {
    const owner = ownerOf(ctx, spec.view, "drafting.group");
    const name = spec.group.trim();
    if (!name) throw new ScriptRunError("drafting.group requires a non-empty group name.");
    for (const itemId of spec.items) {
      ctx.edit({ type: "update_drawing_item", itemId, detailGroup: name });
    }
    void owner;
  },

  /** Lists all available 2D detail components (kernel + active discipline packs), hatch patterns, region tones, line styles, patterns, weights, and leader arrows. */
  catalog(ctx: ScriptContext): {
    readonly components: readonly { readonly id: string; readonly name: string; readonly category: string; readonly widthIn: number; readonly heightIn: number; readonly linear: boolean }[];
    readonly hatchPatterns: readonly HatchPattern[];
    readonly regionTones: readonly RegionTone[];
    readonly lineStyles: readonly { readonly id: DetailLineStyleId; readonly name: string }[];
    readonly linePatterns: readonly LinePattern[];
    readonly lineWeights: readonly LineWeight2D[];
    readonly leaderArrows: readonly NoteLeaderArrow[];
  } {
    const components = onWorking(ctx, "drafting.catalog", () =>
      detailComponents().map((c) => ({
        id: c.id,
        name: c.name,
        category: c.category,
        widthIn: Math.round((c.widthMm / IN_MM) * 100) / 100,
        heightIn: Math.round((c.heightMm / IN_MM) * 100) / 100,
        linear: c.linear === true,
      })),
    );
    return {
      components,
      hatchPatterns: [...HATCH_PATTERNS],
      regionTones: [...REGION_TONES],
      lineStyles: DETAIL_LINE_STYLES.map((s) => ({ id: s.id, name: s.name })),
      linePatterns: [...LINE_PATTERNS],
      lineWeights: [...LINE_WEIGHTS_2D],
      leaderArrows: [...NOTE_LEADER_ARROWS],
    };
  },

  /** Audits a drafting view for CAD legibility & print quality: text-vs-text overlaps, unmasked text crossing linework, items clipped outside crop, and orphaned dimensions. */
  check(
    ctx: ScriptContext,
    viewRef: string,
  ): DetailCheckReport & { readonly ok: boolean; readonly dimCount: number; readonly issues: readonly string[] } {
    return onWorking(ctx, "drafting.check", (m) => {
      const owner = resolveOwner(m, viewRef, "drafting.check");
      if (!owner.view) throw new ScriptRunError("drafting.check operates on a view, not a sheet.");
      const report = checkDetailView(m, owner.id);
      const issues: string[] = [
        ...report.textOverlaps.map((o) => `Text overlap (${o.overlapAreaMm2} mm²): "${o.aText}" (${o.aId}) ↔ "${o.bText}" (${o.bId})`),
        ...report.lineCrossings.map((c) => `Unmasked text crosses ${c.crossingCount} line(s): "${c.text}" (${c.itemId})`),
        ...report.clippedItems.map((id) => `Item clipped outside crop box: ${id}`),
        ...report.orphanedDimensions.map((id) => `Dimension has orphaned element ref: ${id}`),
      ];
      return { ...report, ok: report.clean, dimCount: report.dimensionCount, issues };
    });
  },
};
