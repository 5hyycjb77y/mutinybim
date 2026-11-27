import type { DimSpec, TagSpec } from "./annotation/annotations";
import type { BattSpec, ComponentPlacement, DraftingCategory, LineStyle, RegionFill } from "./annotation/detailing";
import type { SheetFigureSpec } from "./annotation/figures";
import type { SheetMarkupSpec } from "./annotation/markups";
import type { RichTextNote } from "./annotation/rich-text";
import type { DiagramDefinition } from "./diagrams/definition";
import type { FieldBlockSpec } from "./blocks/types";
import type { Discipline, ElementId, ModelElementBase, Partition, Vec2, ViewElement, BimElement } from "./types";
import type { CropBox3d, View3dCamera } from "./view3d";
import type { FormScheduleDefinition } from "./schedules/forms/types";
import type { ScheduleDefinition, ScheduleDefinitionV2 } from "./schedules/definition";
import type { CategoryOverrides } from "./categories/types";
import type { ViewGraphicsHints } from "./layout/view-graphics-point";
import type { TitleBlockRow } from "./drawing/title-block-definition";

/**
 * Views, sheets and the drawing-only content placed on them. These are model
 * elements like any other (stable ids, versions, authored revisions), so they
 * sync, conflict and undo through the same changesets as the network.
 *
 * Coordinates: views and detail-view drafting are in model millimetres (plan
 * x east, y north). Sheet content (viewport centres and sizes, sheet notes)
 * is in paper millimetres, origin top-left, y down.
 */

export type ViewType = "floor_plan" | "ceiling_plan" | "section" | "elevation" | "three_d" | "schedule" | "detail";

/** Vertical orthographic views (sections and elevations share the same projection plane and far clip). */
export function isVerticalView(viewType: ViewType): boolean {
  return viewType === "section" || viewType === "elevation";
}

/** Categories a view can switch off. Linked models are switched per reference in `references`. */
export const VIEW_CATEGORIES = ["duct", "duct_fitting", "pipe", "air_terminal", "equipment", "walls", "doors_windows", "rooms", "grids", "structure", "tags", "dimensions", "electrical_devices", "lighting_fixtures", "electrical_equipment", "insulation", "opening_tags"] as const;
export type ViewCategory = (typeof VIEW_CATEGORIES)[number];

export type DetailLevel = "coarse" | "medium" | "fine";

/**
 * How a view draws model geometry. Wireframe: every edge, nothing hides
 * anything. Hidden line: edges behind nearer elements are removed (or dashed,
 * with hidden lines shown). Shaded: surfaces filled grey, nearer over farther,
 * no edges. Shaded with edges: both.
 */
export const VISUAL_STYLES = ["wireframe", "hidden_line", "shaded", "shaded_edges"] as const;
export type VisualStyle = (typeof VISUAL_STYLES)[number];

/** How a cut duct or pipe is filled in a section: an X across the shape, solid, or 45° hatch. */
export const CUT_PATTERNS = ["cross", "solid", "hatch"] as const;
export type CutPattern = (typeof CUT_PATTERNS)[number];

/** Pen names, thinnest first (the sheet scene's pens). */
export const LINE_WEIGHTS = ["thin", "medium", "wide", "heavy"] as const;
export type LineWeight = (typeof LINE_WEIGHTS)[number];

/** A category's pens where it is cut and where it is seen beyond the cut. */
export interface CategoryLineWeights {
  readonly cut?: LineWeight;
  readonly projection?: LineWeight;
}

/** How one IFC category of a linked model shows in one view; absent fields follow the model's setting. */
export interface ReferenceCategoryDisplay {
  readonly visible?: boolean;
  readonly halftone?: boolean;
}

/** How one linked model shows in one view (`reference-display.ts` resolves the defaults). */
export interface ReferenceDisplay {
  readonly visible: boolean;
  readonly halftone: boolean;
  /** 3D: how see-through it draws, 0–90 %. Absent: 30 % for halftone architecture, else 0. */
  readonly transparencyPct?: number;
  /** Draw beneath the view's own work, greyed: screened linework on paper, faint in 3D. Absent: off. */
  readonly underlay?: boolean;
  /** Per IFC category ("IFCWALL", "IFCDOOR"…). Absent categories follow the model. */
  readonly categories?: Readonly<Record<string, ReferenceCategoryDisplay>>;
  /** Drawings: the pen for what the cut passes through (walls). Absent: wide. */
  readonly cutPen?: LineWeight;
  /** Drawings: the pen for what is seen below or beyond the cut (furniture, slab edges). Absent: thin. */
  readonly beyondPen?: LineWeight;
}

/** A vertical cut: the line it cuts along, which side it looks at, and how far. */
export interface SectionCut {
  readonly start: Vec2;
  readonly end: Vec2;
  /** +1 looks to the left of start→end, -1 to the right. */
  readonly direction: 1 | -1;
  /** How far beyond the cut line the section sees, in model mm. */
  readonly depthMm: number;
  /** Extra annotative extension of the section head past `start` along -axis (model mm; independent of cut range). */
  readonly headExtMm?: number;
  /** Extra annotative extension of the section tail past `end` along +axis (model mm; independent of cut range). */
  readonly tailExtMm?: number;
  /** Revit split/broken section line: hides the middle dash across the interior of the plan while keeping head & tail stubs. */
  readonly splitGap?: boolean;
  /** Optional explicit source plan view id this section/elevation references back to (overrides automatic sheet lookup). */
  readonly referencingViewId?: string;
  /** Optional discipline ids of plans on which this section/elevation mark should appear (absent: all matching-level plans). */
  readonly showInDisciplines?: readonly string[];
}

/** How a plan's upper view-range plane (`viewTopMm`) is anchored: relative to this level, relative to the next level above (Revit default for MEP plans), or unlimited. */
export const VIEW_TOP_REFS = ["associated_level", "level_above", "unlimited"] as const;
export type ViewTopRef = (typeof VIEW_TOP_REFS)[number];

/** Peers that store and evaluate level-relative view range (`viewTopRef`) and Project Browser view grouping/sorting (`browserGroup`, `sortOrder`). */
export const VIEW_RANGE_AND_BROWSER_FEATURE = "views:range_and_browser";

/** Peers that store and resolve reusable first-class view templates (`view_template` elements & `ViewProps.viewTemplateId`). */
export const VIEW_TEMPLATES_FEATURE = "views:templates";

/**
 * Property groups a `view_template` can control and lock across all bound views.
 * - `view_range`: `cutHeightMm`, `viewTopMm`, `viewTopRef`, `viewBottomMm`, `viewDepthMm`
 * - `category_overrides`: `categoryOverrides`, `hiddenCategories`, `hiddenDraftingCategories`, `lineWeights`
 * - `detail_level`: `detailLevel`, `scale`, `symbolScale`, `showLineCodes`, `offsetStackedRuns`, `cutPattern`
 * - `visual_style`: `visualStyle`, `showHiddenLines`, `hiddenLineCategories`
 * - `discipline`: `discipline`, `browserGroup`, `showReferenceDisciplines`
 * - `annotations`: `hideDeviceMarks`, `showClearanceLabels`
 * - `pack_props`: any add-on `ViewGraphicsHints` records stored on the template
 */
export const VIEW_TEMPLATE_LOCK_KEYS = [
  "view_range",
  "category_overrides",
  "detail_level",
  "visual_style",
  "discipline",
  "annotations",
  "pack_props",
] as const;
export type ViewTemplateLockKey = (typeof VIEW_TEMPLATE_LOCK_KEYS)[number];

/** Reusable view settings stored on a `view_template` (including any pack-registered `ViewGraphicsHints`). */
export type ViewTemplateProps = Omit<
  ViewProps,
  "level" | "levelElevationMm" | "section" | "cropView" | "cropPolygon" | "showCropBox" | "camera3d" | "cropBox3d" | "workingFor" | "schedule" | "formSchedule" | "scheduleV2" | "diagram" | "viewTemplateId"
>;

/** A saved, reusable view template bound live to any number of views via `ViewProps.viewTemplateId`. */
export interface ViewTemplateElement extends ModelElementBase {
  readonly kind: "view_template";
  readonly name: string;
  readonly description?: string;
  /** View types this template applies to (absent or empty: any view type). */
  readonly viewTypes?: readonly ViewType[];
  /** Property groups controlled and locked by this template. */
  readonly locks: readonly ViewTemplateLockKey[];
  /** View settings applied to bound views for each locked group. */
  readonly props: ViewTemplateProps;
  /** Optional library item id this template came from (firm or add-on library). */
  readonly sourceLibraryId?: string;
  readonly deleted?: boolean;
}

/** Resolved effective view properties after overlaying any bound `view_template`. */
export interface ResolvedViewProps {
  readonly props: ViewProps;
  readonly template: ViewTemplateElement | null;
  readonly lockedGroups: ReadonlySet<ViewTemplateLockKey>;
}

const KNOWN_TEMPLATE_KERNEL_KEYS: ReadonlySet<string> = new Set([
  "scale",
  "cutHeightMm",
  "viewDepthMm",
  "viewBottomMm",
  "viewTopMm",
  "viewTopRef",
  "browserGroup",
  "sortOrder",
  "discipline",
  "hiddenCategories",
  "hiddenElementIds",
  "showClearanceLabels",
  "hideDeviceMarks",
  "hiddenDraftingCategories",
  "references",
  "linkedHiddenLines",
  "linkedMinObjectMm",
  "levelLeftExtMm",
  "levelRightExtMm",
  "detailLevel",
  "showLineCodes",
  "offsetStackedRuns",
  "showReferenceDisciplines",
  "symbolScale",
  "visualStyle",
  "showHiddenLines",
  "hiddenLineCategories",
  "lineWeights",
  "categoryOverrides",
  "cutPattern",
  "annotationCrop",
  "annotationCropOffsetMm",
  "phaseId",
  "phaseFilterId",
  "groupDisplay",
  "orientation",
  "workingAngleDeg",
  "projection",
  "viewTemplateId",
]);

/**
 * Resolve a view's effective `ViewProps` by applying its bound `view_template` (if any).
 * Single canonical kernel resolver used by 2D/3D renderers, Inspector UI, and scripts.
 */
export function resolveViewProps(
  elements: Readonly<Record<string, BimElement>>,
  view: Pick<ViewElement, "props">,
): ResolvedViewProps {
  const base: ViewProps = view.props ?? {};
  const tid = base.viewTemplateId;
  const tpl = tid ? elements[tid] : undefined;
  if (!tpl || tpl.kind !== "view_template" || tpl.deleted) {
    return { props: base, template: null, lockedGroups: new Set<ViewTemplateLockKey>() };
  }
  const locked = new Set<ViewTemplateLockKey>(tpl.locks);
  const next: Record<string, unknown> = { ...base };
  const tp = tpl.props as Readonly<Record<string, unknown>>;
  const copyIfDefined = (keys: readonly string[]) => {
    for (const k of keys) {
      if (tp[k] !== undefined) next[k] = tp[k];
    }
  };
  if (locked.has("view_range")) {
    // Replace the entire view-range tuple cleanly so stale view-level overrides don't leak past a template.
    delete next.cutHeightMm;
    delete next.viewTopMm;
    delete next.viewTopRef;
    delete next.viewBottomMm;
    delete next.viewDepthMm;
    copyIfDefined(["cutHeightMm", "viewTopMm", "viewTopRef", "viewBottomMm", "viewDepthMm"]);
  }
  if (locked.has("category_overrides")) {
    copyIfDefined(["categoryOverrides", "hiddenCategories", "hiddenDraftingCategories", "lineWeights"]);
  }
  if (locked.has("detail_level")) {
    copyIfDefined(["detailLevel", "scale", "symbolScale", "showLineCodes", "offsetStackedRuns", "cutPattern"]);
  }
  if (locked.has("visual_style")) {
    copyIfDefined(["visualStyle", "showHiddenLines", "hiddenLineCategories"]);
  }
  if (locked.has("discipline")) {
    copyIfDefined(["discipline", "browserGroup", "showReferenceDisciplines"]);
  }
  if (locked.has("annotations")) {
    copyIfDefined(["hideDeviceMarks", "showClearanceLabels"]);
  }
  if (locked.has("pack_props")) {
    for (const [k, v] of Object.entries(tp)) {
      if (!KNOWN_TEMPLATE_KERNEL_KEYS.has(k) && v !== undefined) {
        const cur = next[k];
        if (
          typeof cur === "object" &&
          cur !== null &&
          !Array.isArray(cur) &&
          typeof v === "object" &&
          v !== null &&
          !Array.isArray(v)
        ) {
          // Template keys override the view's style settings while preserving view-local drafting state (e.g. per-wire hints).
          next[k] = { ...(cur as Record<string, unknown>), ...(v as Record<string, unknown>) };
        } else {
          next[k] = v;
        }
      }
    }
  }
  return { props: next as ViewProps, template: tpl, lockedGroups: locked };
}

/** Return a copy of `view` with its `props` resolved through any bound `view_template` (returns `view` untouched when unbound). */
export function resolveViewElement(
  elements: Readonly<Record<string, BimElement>>,
  view: ViewElement,
): ViewElement {
  if (!view.props?.viewTemplateId) return view;
  const resolved = resolveViewProps(elements, view);
  if (!resolved.template) return view;
  return { ...view, props: resolved.props };
}

/** Everything about a view a person can set; absent fields take the view type's default. */
export interface ViewProps extends ViewGraphicsHints {
  /** Optional bound `view_template` element id; locked template groups override this view's local values live. */
  readonly viewTemplateId?: ElementId;
  /** Level the plan belongs to (matches element partitions). */
  readonly level?: string;
  /** Level elevation above project zero, mm. */
  readonly levelElevationMm?: number;
  /** Model units per paper unit (48 = 1/4" = 1'-0"). */
  readonly scale?: number;
  /** Plan cut plane above the level, mm. */
  readonly cutHeightMm?: number;
  /** Plans: how far below the bottom of the view it still sees, mm. Counts once `viewBottomMm` is set. */
  readonly viewDepthMm?: number;
  /** Plans: the bottom of what the view shows, mm above the level (negative is below it). Absent: no lower limit. */
  readonly viewBottomMm?: number;
  /** Plans: the top of what the view shows, mm above its reference plane (`viewTopRef`: associated level or level above). Absent: automatic to next level. */
  readonly viewTopMm?: number;
  /** Plans: reference datum for `viewTopMm` (`"associated_level"`, `"level_above"`, or `"unlimited"`). Absent: associated level when `viewTopMm` is set, else automatic to next level. */
  readonly viewTopRef?: ViewTopRef;
  /** Optional Project Browser folder/group label for organizing views alongside sheets. */
  readonly browserGroup?: string;
  /** Optional numeric sort key for ordering views in the Project Browser. */
  readonly sortOrder?: number;
  /** Elements of this discipline print in ink; underlay disciplines (the building) halftone; plans leave other disciplines' runs out (`leftOutOfDisciplineView`). Absent: all in ink. */
  readonly discipline?: Discipline;
  readonly hiddenCategories?: readonly ViewCategory[];
  /** Individual element ids hidden in this view only; cleared by removing them from the list. Stored only when peers advertise `views:hidden_elements`. */
  readonly hiddenElementIds?: readonly string[];
  /** Plans: draw text labels inside clearance zones (dashed outlines always draw). Absent: on. */
  readonly showClearanceLabels?: boolean;
  /** Plans: hide automatic per-instance marks on repetitive devices (outlets, switches, luminaires) while keeping equipment & manual tags visible. Absent: off. */
  readonly hideDeviceMarks?: boolean;
  /** Drafting categories this view hides (detail lines, hatching, components, insulation…); the model's categories are `hiddenCategories`. */
  readonly hiddenDraftingCategories?: readonly DraftingCategory[];
  /** Per linked model id. Absent: visible, halftone. */
  readonly references?: Readonly<Record<string, ReferenceDisplay>>;
  /** Drawings: linked models' lines hidden under nearer elements are removed (a chair under a table). Absent: on. */
  readonly linkedHiddenLines?: boolean;
  /** Drawings: linked furniture, fixtures and other small things narrower than this, mm, are left out. Absent: 0 (all drawn). */
  readonly linkedMinObjectMm?: number;
  /** Sections/elevations: annotative extension of level datum lines past the left crop edge (paper mm, default 8 mm). */
  readonly levelLeftExtMm?: number;
  /** Sections/elevations: annotative extension of level datum lines past the right crop edge (paper mm, default 8 mm). */
  readonly levelRightExtMm?: number;
  /** Coarse: all runs single-line with schematic fitting & rise/drop symbols. Medium: air runs double-line with fittings; other runs single-line schematic with fitting & rise/drop symbols. Fine: all runs double-line with fitting bodies and turning vanes. Absent: medium. */
  readonly detailLevel?: DetailLevel;
  /** Plans: print repeating inline service codes (CW, SAN, G…) inside single-line runs when the service or system defines one. Absent: on. */
  readonly showLineCodes?: boolean;
  /** Plans: visually offset horizontally stacked single-line runs at different elevations so coincident lines stay readable without moving 3D geometry. Absent: on for single-line runs. */
  readonly offsetStackedRuns?: boolean;
  /** Plans: limit which section/elevation view disciplines show reference marks on this plan (absent: all allowed by each vertical view). */
  readonly showReferenceDisciplines?: readonly string[];
  /** Plans: multiplier for annotative paper-space symbols and `minPaperMm` floors in this view (0.5–3.0). Absent: 1. */
  readonly symbolScale?: number;
  /** Absent: hidden line. */
  readonly visualStyle?: VisualStyle;
  /** Draw edges hidden behind nearer elements dashed, for every category. Absent: off (hidden edges are removed). */
  readonly showHiddenLines?: boolean;
  /** Categories whose hidden edges draw dashed even with `showHiddenLines` off. */
  readonly hiddenLineCategories?: readonly ViewCategory[];
  /** Per-category pens, cut and projection. Absent: the drawing defaults. */
  readonly lineWeights?: Readonly<Partial<Record<ViewCategory, CategoryLineWeights>>>;
  /**
   * Visibility/Graphics: per category id (view category, class, `service:<id>`,
   * `drafting:<id>`, firm class) show, halftone, pens, pattern, colour and plan
   * symbol. Wins over `hiddenCategories` / `lineWeights` for the categories it
   * names; `categories/resolve.ts` is the one reader. Absent: those older
   * fields alone, as before. Stored only when the model server advertises
   * `graphics:category_overrides`.
   */
  readonly categoryOverrides?: CategoryOverrides;
  /** Sections: how cut duct and pipe are filled. Absent: cross. */
  readonly cutPattern?: CutPattern;
  readonly section?: SectionCut;
  /** Crop view: only what is inside the crop box (or `cropPolygon` when set) draws and prints. Absent: on. Off: the view shows all its content. */
  readonly cropView?: boolean;
  /** Optional closed polygonal crop boundary (model mm, >= 3 vertices) for custom L-shape / P-line enlarged plan crops; falls back to rectangular `cropMin`/`cropMax` when absent. */
  readonly cropPolygon?: readonly Vec2[];
  /** Show the crop box boundary while editing (never printed). Absent: on. */
  readonly showCropBox?: boolean;
  /** Let notes, tags and dimensions reach past the crop box by `annotationCropOffsetMm` of paper. Absent: off. */
  readonly annotationCrop?: boolean;
  /** Paper mm notes may reach past the crop box when annotation crop is on. Absent: 6. */
  readonly annotationCropOffsetMm?: number;
  /** The phase the view shows the model as of. Absent: the latest phase. */
  readonly phaseId?: string;
  /** How new, existing, demolished and temporary elements draw. Absent: Show all. */
  readonly phaseFilterId?: string;
  /** Per group id: show, halftone or hide in this view. Absent groups use the group's default. */
  readonly groupDisplay?: Readonly<Record<string, "show" | "halftone" | "hide">>;
  /** Plans only: draw with plan north up, turned so true north is up, or turned square to the working angle. Absent: plan north. */
  readonly orientation?: PlanOrientation;
  /** This view's own working angle (`work-frame.ts`), in (−45, 45]. Absent: the model's. */
  readonly workingAngleDeg?: number;
  /** 3D views only: how the live view draws depth. Absent: perspective. Sheets print 3D views orthographic (isometric) either way. */
  readonly projection?: ViewProjection;
  /** Schedule views only: what the table lists and how (`schedules/schedule.ts`). */
  readonly schedule?: ScheduleDefinition;
  /** Schedule views only, instead of `schedule`: a form schedule (panel, switchboard, feeder…; `schedules/forms`). */
  readonly formSchedule?: FormScheduleDefinition;
  /** Schedule views only, instead of `schedule` / `formSchedule`: a v2 schedule (classes, typed columns, list or form; `schedules/paper.ts`). */
  readonly scheduleV2?: ScheduleDefinitionV2;
  /** Detail views only: a live diagram drawn from the model's connection graph at every evaluation (`diagrams/`). */
  readonly diagram?: DiagramDefinition;
  /** 3D views only: where the view looks from (`view3d.ts`). */
  readonly camera3d?: View3dCamera;
  /** 3D views only: the 3D crop box; it crops while `cropView` is on and shows while `showCropBox` is on. */
  readonly cropBox3d?: CropBox3d;
  /** 3D views only: the user id whose working 3D view this is. */
  readonly workingFor?: string;
}

/** Peers that store and draw a view's hash-mark choice (an older peer's strict schema refuses the field). */
export const VIEW_HASH_MARKS_FEATURE = "views:hash_marks";
/** Peers that store a view's "label repeated typicals once" switch (round 13; an older peer's strict schema refuses the field). */
export const VIEW_TYP_LABELS_FEATURE = "views:typ_labels";
/** Peers that store and draw pack-contributed spatial analysis overlays on plan views. */
export const VIEW_ANALYSIS_OVERLAY_FEATURE = "views:analysis_overlay";
/** Peers that store per-viewport north-arrow sheet offsets and accept offset-only `set_viewport_north_arrow` commands. */
export const VIEWPORT_NORTH_ARROW_OFFSET_FEATURE = "documents:viewport_north_arrow_offset";
/** Peers that store per-view hidden element lists (`ViewProps.hiddenElementIds`). */
export const VIEW_HIDDEN_ELEMENTS_FEATURE = "views:hidden_elements";

/** A callout: a box or custom closed polygon around part of a plan, bound to the view that shows it enlarged; its head reads that view's number and sheet, live. */
export interface CalloutSpec {
  readonly viewId: string;
  /** Replaces the view's detail number in the head (e.g. "EEP"). */
  readonly label?: string;
  /** Optional custom closed polygon boundary (owner model mm, >= 3 vertices) for L-shape or P-line callouts. When absent, `points[0..1]` define a rectangle. */
  readonly boundary?: readonly Vec2[];
  /** Whether to print the referenced view's name beside the callout bubble (default true). */
  readonly showLabel?: boolean;
}

/** Schedule definitions live with the schedule engine; re-exported here so existing imports keep working. */
export { SCHEDULE_CATEGORIES, SCHEDULE_FILTER_OPS } from "./schedules/definition";
export type { ScheduleCategory, ScheduleColumn, ScheduleDefinition, ScheduleFilterOp } from "./schedules/definition";

/** One line of a sheet's revision (issue) table. */
export interface SheetRevision {
  readonly number: string;
  /** As it prints, e.g. 2026-10-20. */
  readonly date: string;
  readonly description: string;
}

/** Perspective (things farther away look smaller) or orthographic (parallel: true elevations and isometrics). */
export const VIEW_PROJECTIONS = ["perspective", "orthographic"] as const;
export type ViewProjection = (typeof VIEW_PROJECTIONS)[number];

/** plan_north: model +Y up. true_north: true north up. working_angle: turned so the working axes (the building's walls) run square to the paper. */
export const PLAN_ORIENTATIONS = ["plan_north", "true_north", "working_angle"] as const;
export type PlanOrientation = (typeof PLAN_ORIENTATIONS)[number];

export const DEFAULT_ANNOTATION_CROP_OFFSET_MM = 6;

export const TITLE_BLOCK_TYPES = ["arch_d_mutinybim", "ansi_b_mutinybim"] as const;
export type TitleBlockType = (typeof TITLE_BLOCK_TYPES)[number];

/** Editable title block text. Free-form keys beyond these print in order. */
export interface SheetProps {
  readonly titleBlock?: TitleBlockType;
  /**
   * A library title block (a firm's), copied when it was chosen: it sets the
   * paper and draws the border and strip in place of `titleBlock`. Absent: the
   * built-in `titleBlock`, drawn exactly as before.
   */
  readonly titleBlockRow?: TitleBlockRow;
  readonly fields?: Readonly<Record<string, string>>;
  /** The revision table, oldest first. Prints in the title block above the sheet number. */
  readonly revisions?: readonly SheetRevision[];
  /** Optional discipline id for organizing sheets in the browser and print set (e.g. `"general"`, `"coordination"`). */
  readonly discipline?: string;
  /** Optional custom folder/group label for browser grouping (e.g. `"General"`, `"Life Safety"`). */
  readonly group?: string;
  /** Optional explicit sort order within its group or sheet list (lower sorts first; falls back to sheet number). */
  readonly sortOrder?: number;
}

/** A view placed on a sheet at a scale. One view sits on at most one sheet. */
export interface Viewport {
  readonly id: ElementId;
  readonly version: number;
  readonly authoredRev: Readonly<Record<string, number>>;
  readonly partition?: Partition;
  /** Shared element fields; sheet content has no group or phase. */
  readonly groupId?: string;
  readonly phaseCreated?: string;
  readonly phaseDemolished?: string;
  readonly kind: "viewport";
  readonly sheetId: ElementId;
  readonly viewId: ElementId;
  /** Paper mm, centre of the viewport frame. */
  readonly center: Vec2;
  /** Paper mm, frame size (the window onto the view). */
  readonly size: Vec2;
  /** Model units per paper unit. */
  readonly scale: number;
  /** Print a north arrow beside the view title, turned to true north. Absent: on for plans, off for other views. */
  readonly northArrow?: boolean;
  /** Optional paper-mm offset of the viewport's north arrow from its default anchor beside the view title. */
  readonly northArrowOffsetMm?: Vec2;
  /** Optional paper-mm offset of the viewport title block (bubble, rule, title, scale, north arrow) from its default anchor below the viewport. */
  readonly titleOffsetMm?: Vec2;
  /** Optional explicit paper-mm length of the viewport title horizontal rule line (Revit draggable title bar end). */
  readonly titleRuleMm?: number;
  /** Removed (kept so undo can bring it back). */
  readonly deleted?: boolean;
}

export type DrawingShape = "text" | "line" | "rect" | "cloud" | "dimension" | "tag" | "arc" | "circle" | "polyline" | "spline" | "region" | "component" | "repeat" | "batt" | "callout" | "figure" | "field_block" | "markup";

/**
 * Drawing-only content: a note, line, rectangle or revision cloud on a sheet,
 * or linework, text and dimensions in a detail view. Not model-linked.
 */
export interface DrawingItem {
  readonly id: ElementId;
  readonly version: number;
  readonly authoredRev: Readonly<Record<string, number>>;
  readonly partition?: Partition;
  /** Shared element fields; drawing-only content has no group or phase. */
  readonly groupId?: string;
  readonly phaseCreated?: string;
  readonly phaseDemolished?: string;
  readonly kind: "drawing_item";
  /** The sheet (paper mm) or detail view (model mm) it is drawn in. */
  readonly ownerId: ElementId;
  readonly shape: DrawingShape;
  /** text / tag: [at]; line: [a, b]; cloud: [corner, opposite corner]; dimension: its witness points (see `dim`). `rect` is a stored shape from before drafting schema 2: it reads and prints as before and becomes four joined lines when first edited (`annotation/drafting-migrations`). */
  readonly points: readonly Vec2[];
  /** Dimensions: kind, references the points follow, offset, overrides and style (`annotation/annotations.ts`). Absent on a plain two-point dimension. */
  readonly dim?: DimSpec;
  /** Tags: the element it labels and what it says; the point is the tag head. */
  readonly tag?: TagSpec;
  /** Callouts: the view it refers to (points: box corner, opposite corner, head). */
  readonly callout?: CalloutSpec;
  /** Linework weight and pattern (lines, rectangles, arcs, circles, polylines, splines, region outlines). */
  readonly lineStyle?: LineStyle;
  /** Polylines and splines: join the last point to the first. */
  readonly closed?: boolean;
  /** Arcs: points are [centre, start, end]; the arc runs counter-clockwise from start to end unless false. */
  readonly ccw?: boolean;
  /** Regions: a hatch or solid fill, or a masking region. */
  readonly fill?: RegionFill;
  /** Detail components (point: insertion) and repeating details (points: start, end). */
  readonly component?: ComponentPlacement;
  /** Insulation batts: thickness (points: start, end). */
  readonly batt?: BattSpec;
  /** Shown and hidden by this category; absent: what the shape implies. */
  readonly category?: DraftingCategory;
  /** Items in one detail group select, move and copy together. */
  readonly detailGroup?: string;
  /** Pinned: Move, Rotate, trims, splits and Delete refuse it until it is unpinned. */
  readonly pinned?: boolean;
  readonly text?: string;
  /** Cap height, paper mm (a rich note's default run size). */
  readonly textSize?: number;
  /** Rich text: a wrapping box of styled paragraphs (`annotation/rich-text`). Its point is the box's top-left. */
  readonly note?: RichTextNote;
  /** Figures (a live chart or a picture) on a sheet: points are the frame's top-left and bottom-right, paper mm. */
  readonly figure?: SheetFigureSpec;
  /** Field blocks on a sheet (`blocks/`): live text read from the model; the point is the box's top-left, paper mm. `textSize` and `note.box.width` style it. */
  readonly block?: FieldBlockSpec;
  /** Sheet review markups (`annotation/markups.ts`): non-printing felt-tip marker & highlighter ink on sheets (paper mm). */
  readonly markup?: SheetMarkupSpec;
  readonly deleted?: boolean;
}

export const PAPER_SIZES: Record<TitleBlockType, Vec2> = {
  arch_d_mutinybim: { x: 36 * 25.4, y: 24 * 25.4 },
  ansi_b_mutinybim: { x: 17 * 25.4, y: 11 * 25.4 },
};

/** A sheet's paper: its library title block's, else its built-in title block's. */
export function sheetPaperSize(sheet: { readonly props?: Pick<SheetProps, "titleBlock" | "titleBlockRow"> }): Vec2 {
  return sheet.props?.titleBlockRow?.definition.paperMm ?? PAPER_SIZES[sheet.props?.titleBlock ?? "arch_d_mutinybim"];
}

export const DEFAULT_PLAN_SCALE = 48;
export const DEFAULT_DETAIL_SCALE = 8;
export const DEFAULT_CUT_HEIGHT_MM = 1219.2;

/** Common architectural scales offered in pickers, as model units per paper unit. */
export const STANDARD_SCALES: ReadonlyArray<{ readonly scale: number; readonly label: string }> = [
  { scale: 192, label: '1/16" = 1\'-0"' },
  { scale: 96, label: '1/8" = 1\'-0"' },
  { scale: 64, label: '3/16" = 1\'-0"' },
  { scale: 48, label: '1/4" = 1\'-0"' },
  { scale: 32, label: '3/8" = 1\'-0"' },
  { scale: 24, label: '1/2" = 1\'-0"' },
  { scale: 16, label: '3/4" = 1\'-0"' },
  { scale: 12, label: '1" = 1\'-0"' },
  { scale: 8, label: '1 1/2" = 1\'-0"' },
  { scale: 4, label: '3" = 1\'-0"' },
];

export function scaleLabel(scale: number): string {
  return STANDARD_SCALES.find((s) => Math.abs(s.scale - scale) < 1e-9)?.label ?? `1:${Number(scale.toFixed(2))}`;
}
