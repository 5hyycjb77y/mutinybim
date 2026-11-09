import type { DimSpec, TagSpec } from "./annotation/annotations";
import type { BattSpec, ComponentPlacement, DraftingCategory, LineStyle, RegionFill } from "./annotation/detailing";
import type { SheetFigureSpec } from "./annotation/figures";
import type { RichTextNote } from "./annotation/rich-text";
import type { DiagramDefinition } from "./diagrams/definition";
import type { FieldBlockSpec } from "./blocks/types";
import type { Discipline, ElementId, Partition, Vec2 } from "./types";
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

export type ViewType = "floor_plan" | "ceiling_plan" | "section" | "three_d" | "schedule" | "detail";

/** Categories a view can switch off. Linked models are switched per reference in `references`. */
export const VIEW_CATEGORIES = ["duct", "duct_fitting", "pipe", "air_terminal", "equipment", "walls", "doors_windows", "rooms", "grids", "structure", "tags", "dimensions", "electrical_devices", "lighting_fixtures", "electrical_equipment", "insulation"] as const;
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
}

/** Everything about a view a person can set; absent fields take the view type's default. */
export interface ViewProps extends ViewGraphicsHints {
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
  /** Plans: the top of what the view shows, mm above the level. Absent: no upper limit (ductwork above the cut still shows). */
  readonly viewTopMm?: number;
  /** Elements of this discipline print in ink; underlay disciplines (the building) halftone; plans leave other disciplines' runs out (`leftOutOfDisciplineView`). Absent: all in ink. */
  readonly discipline?: Discipline;
  readonly hiddenCategories?: readonly ViewCategory[];
  /** Drafting categories this view hides (detail lines, hatching, components, insulation…); the model's categories are `hiddenCategories`. */
  readonly hiddenDraftingCategories?: readonly DraftingCategory[];
  /** Per linked model id. Absent: visible, halftone. */
  readonly references?: Readonly<Record<string, ReferenceDisplay>>;
  /** Drawings: linked models' lines hidden under nearer elements are removed (a chair under a table). Absent: on. */
  readonly linkedHiddenLines?: boolean;
  /** Drawings: linked furniture, fixtures and other small things narrower than this, mm, are left out. Absent: 0 (all drawn). */
  readonly linkedMinObjectMm?: number;
  /** Coarse: duct and pipe single-line, no fitting bodies. Medium: double-line with fittings. Fine: adds turning vanes and joints. Absent: medium. */
  readonly detailLevel?: DetailLevel;
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
  /** Crop view: only what is inside the crop box draws and prints. Absent: on. Off: the view shows all its content. */
  readonly cropView?: boolean;
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

/** A callout: a box around part of a plan, bound to the view that shows it enlarged; its head reads that view's number and sheet, live. */
export interface CalloutSpec {
  readonly viewId: string;
  /** Replaces the view's detail number in the head (e.g. "EEP"). */
  readonly label?: string;
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
  /** Removed (kept so undo can bring it back). */
  readonly deleted?: boolean;
}

export type DrawingShape = "text" | "line" | "rect" | "cloud" | "dimension" | "tag" | "arc" | "circle" | "polyline" | "spline" | "region" | "component" | "repeat" | "batt" | "callout" | "figure" | "field_block";

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
