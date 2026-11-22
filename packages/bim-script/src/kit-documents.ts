import {
  DETAIL_LINE_STYLES,
  HATCH_PATTERNS,
  KEYNOTE_FIELD,
  LINE_PATTERNS,
  LINE_WEIGHTS_2D,
  ONE_LINE_TEXT_MM,
  autoDimensionCommand,
  boxAroundAabb,
  boxForRegion,
  buildViewScene,
  builtinFormTemplate,
  cameraLookingFrom,
  defaultCamera,
  detailComponents,
  diagramKinds,
  elementsAabb,
  enlargedPlanCommands,
  formScheduleKinds,
  isBoundFormKind,
  fieldProviderRegistry,
  layoutOneLine,
  modelAabb,
  normalizeBox,
  oneLineCommands,
  oneLineCropCommand,
  planAutoTags,
  sheetLayoutCommand,
  viewCamera3d,
  viewCropBox3d,
  workingAngleOf,
  type Aabb3,
  type AutoTagCategory,
  type Command,
  type CropBox3d,
  type DetailLevel,
  type DiagramHints,
  type LookFrom,
  type ModelState,
  type OneLineSpec,
  type ScheduleColumnDef,
  type ScheduleDefinition,
  type ScheduleDefinitionV2,
  type ScheduleFilter,
  type ScheduleGroup,
  type ScheduleSort,
  type StoredDiagramKind,
  type View3dCamera,
  type ViewElement,
  type ViewProjection,
  type VisualStyle,
} from "@permitzip/bim-kernel";
import { openSchedule, scheduleV1ToV2, ScheduleDefinitionError, type ColumnValues, type RowSet } from "@permitzip/bim-kernel/schedules";
import { measureIn, type Measure } from "@permitzip/bim-units";
import { ScriptRunError, type ScriptContext } from "./context";
import { onWorking } from "./working";

/**
 * `documents`: sheets, views and schedules, each one of the
 * kernel's document commands sent through `ctx.edit`. A script prepares the
 * drawing set; printing and issuing are a person's (product decision, Nov 4): there is
 * no print or issue here, and the script output refuses one.
 */

type CreateSheet = Extract<Command, { type: "create_sheet" }>;
type CreateView = Extract<Command, { type: "create_view" }>;
type ViewProps = NonNullable<CreateView["props"]>;
type EditSchedule = Extract<Command, { type: "edit_schedule" }>;
type AddDrawingItem = Extract<Command, { type: "add_drawing_item" }>;
type TagSpecOf = NonNullable<AddDrawingItem["tag"]>;
type DimOf = NonNullable<AddDrawingItem["dim"]>;

/** A schedule of one v1 category (the older list format). */
export interface ScheduleSpec {
  readonly name: string;
  /** The element category it lists ("mechanical_equipment", "air_terminal", "plumbing_fixture", "lighting_fixture", "duct", "pipe", "sheet_list"…). */
  readonly category: ScheduleDefinition["category"];
  /** The fields it shows, in order ("mark", "cfm", "name"…). */
  readonly columns: readonly string[];
  /** The title printed above it; absent: the name. */
  readonly title?: string;
  readonly id?: string;
}

/**
 * A schedule of model classes (the v2 format): rooms, spaces, zones,
 * equipment, any class `documents.scheduleFields` lists, with fields,
 * formulas, totals, filters, sorting and grouping.
 */
export interface ClassScheduleSpec {
  readonly name: string;
  /** Class ids: "arch.room", "gen.space", "gen.zone", "mep.air_terminal"… (`documents.scheduleFields(ctx)` lists every class). */
  readonly classes: readonly string[];
  /** Field paths in order ("number", "name", "area"), or full column definitions (formula, aggregate, parameter). */
  readonly columns: readonly (string | ScheduleColumnDef)[];
  /** Only these levels (names). */
  readonly levels?: readonly string[];
  readonly filters?: readonly ScheduleFilter[];
  /** Field paths to sort by (ascending), or full sort rules. */
  readonly sort?: readonly (string | ScheduleSort)[];
  /** Field paths to group by (a header row each), or groups with header, footer and subtotals. */
  readonly groups?: readonly (string | { readonly path: string; readonly header?: boolean; readonly footer?: boolean; readonly totals?: boolean })[];
  /** A grand total row, and a total on every column whose field adds up (area, occupants, airflow). */
  readonly totals?: boolean;
  /** Include subclasses of each class (default yes). */
  readonly includeSubclasses?: boolean;
  readonly id?: string;
}

/** One schedule row as numbers and words: quantities in SI (m², L/s, W…), the unit named per column. */
export interface ScheduleRow {
  readonly key: string;
  /** The element the row is (the first one, for a combined row). */
  readonly element: string;
  readonly cells: Readonly<Record<string, number | string | boolean | null>>;
}

export interface ScheduleRows {
  readonly name: string;
  readonly columns: readonly { readonly id: string; readonly heading: string; readonly valueType: string; readonly quantityKind?: string }[];
  readonly rows: readonly ScheduleRow[];
  /** Grand totals by column (SI), when the schedule has them. */
  readonly totals: Readonly<Record<string, number | null>>;
  /** Rows in the whole schedule (`rows` is the window asked for). */
  readonly totalRows: number;
}

export interface ScheduleClassFields {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly { readonly path: string; readonly label: string; readonly valueType: string; readonly kind?: string; readonly unit?: string; readonly totals?: string }[];
  readonly relationships: readonly { readonly id: string; readonly label: string; readonly to: string }[];
}

export interface AutoTagSpec {
  /** The plan or section to tag in. */
  readonly view: string;
  /** What gets a tag: "duct", "pipe", "air_terminal", "equipment", "fixture"… (the kernel's auto-tag categories). */
  readonly categories: readonly AutoTagCategory[];
  readonly leaders?: "always" | "never" | "when_away";
  /** Tag elements that already have a tag here too (default no). */
  readonly includeTagged?: boolean;
  /** Only these elements (the rest of the view still counts as obstacles). */
  readonly only?: readonly string[];
  readonly textHeight?: Measure;
  readonly styleId?: string;
}

export interface AutoDimensionSpec {
  /** The plan or section. */
  readonly view: string;
  /** Runs, walls or grid lines. */
  readonly elements: readonly string[];
  /** "each": one dimension along every element; "chain": one string across them all. */
  readonly mode: "each" | "chain";
  readonly direction?: "horizontal" | "vertical";
  /** Paper distance from what is measured (default 3/8"). */
  readonly offset?: Measure;
}

export interface PackSheetSpec {
  /** "pack" (default): biggest first, packed tight; "grid": rows and columns. */
  readonly mode?: "pack" | "grid";
  /** Grid only: how many columns. */
  readonly columns?: number;
  /** Shrink a view to the largest standard scale that fits (never larger than it is now). */
  readonly fitScales?: boolean;
  /** Smallest drawing allowed when fitting (largest scale number), e.g. 96 for 1/8" = 1'-0". */
  readonly minScale?: number;
  /** Viewports in this order, left to right, top to bottom; absent: the sheet's own order. */
  readonly order?: readonly string[];
  /** Space between views on paper. */
  readonly gap?: Measure;
}

/** A one-line, riser, or pack-contributed live diagram in a new drafting view: drawn from a distribution you describe, or live from the model. */
export type OneLineDiagramSpec =
  | { readonly name: string; readonly diagram: OneLineSpec; readonly id?: string }
  | { readonly name: string; readonly live: StoredDiagramKind; readonly hints?: DiagramHints; readonly id?: string };

/** Any live diagram kind registered by an active pack (e.g. `"one_line"`, `"electrical_riser"`, `"electrical.controls_diagram"`, `"plumbing_riser"`). */
export interface LiveDiagramSpec {
  readonly name: string;
  readonly kind: StoredDiagramKind;
  readonly hints?: DiagramHints;
  readonly id?: string;
}

/** A form schedule (a panel's, a switchboard's, a feeder list): the add-on's built-in form, filled from the model. */
export interface FormScheduleSpec {
  /** The form kind the model's add-ons offer ("panel", "switchboard", "feeder"…; `documents.formKinds(ctx)` lists them). */
  readonly kind: string;
  readonly name: string;
  /** The element it is the schedule of (a panel), for a kind bound to one. */
  readonly element?: string;
  /** Demand rules to print by (a load read's `rules.id`); absent: connected load only. */
  readonly rules?: string;
  readonly id?: string;
}

export interface TagSpec {
  /** The plan view the tag is drawn in. */
  readonly view: string;
  /** The element it labels. */
  readonly element: string;
  /** Where the tag's text sits, on plan. */
  readonly at: { readonly x: Measure; readonly y: Measure };
  /** What it says; absent: the right text for the element ("auto"). */
  readonly template?: TagSpecOf["template"];
  /** With template "fields": the field paths it prints, one per line ("pipe.size", "pipe.slope", "pipe.carries.dfu"). */
  readonly fields?: readonly string[];
  /** A leader line to the element (default yes). */
  readonly leader?: boolean;
  /** Override the tag style's leader choice for this tag only. */
  readonly leaderOverride?: boolean;
  /** Opaque paper-white background mask behind the tag so crossing lines stay broken and readable. */
  readonly mask?: boolean;
  /** Paper text height in mm. */
  readonly textSizeMm?: number;
  /** Optional named tag style id (e.g. `"tst-mark-clean"`). */
  readonly styleId?: string;
  /** Leader elbow: `"auto"` for a horizontal shoulder, or an explicit plan bend point. */
  readonly elbow?: "auto" | { readonly x: Measure; readonly y: Measure };
  readonly id?: string;
}

type CreateTextStyle = Extract<Command, { type: "create_text_style" }>;
type UpdateTextStyle = Extract<Command, { type: "update_text_style" }>;

/** A named model Text Type (font family, paper cap height, bold/italic/uppercase, opaque or transparent background, default roles). */
export type TextStyleSpec = Omit<CreateTextStyle, "type" | "styleId"> & { readonly id?: string };
/** Changes to a model Text Type. Pass `""` for `fontFamily` or `color` to reset to defaults. */
export type TextStyleChanges = Omit<UpdateTextStyle, "type" | "styleId">;

/** Plan-level circuit & control wiring display settings (`ViewProps.circuitGraphics`). */
export interface CircuitGraphicsSettingsSpec {
  readonly style?: "arcs" | "orthogonal" | "numbers" | "off";
  /** Draw branch power circuits & home runs. Set `false` with `switchLegs: true` for a dedicated controls schematic plan. */
  readonly showCircuits?: boolean;
  readonly homeRuns?: boolean;
  readonly switchLegs?: boolean;
  readonly switchLegLabels?: boolean;
  readonly allCopies?: boolean;
  readonly hashMarks?: "off" | "hots_neutral" | "hots_neutral_ground";
  readonly hashMarksOn?: "home_runs" | "home_runs_and_switch_legs" | "all_runs";
  readonly typLabelsOnce?: boolean;
}

/** Movable home-run arrow/curve/label offsets in typed length units (relative to the host device so it moves with the device). */
export interface HomeRunSpec {
  /** Re-attach the home run to another member device on the circuit. */
  readonly member?: string;
  /** Offset from the host device's anchor to the arrow tip (e.g. `{ x: units.ft(-4), y: units.ft(1) }`). */
  readonly tipOffset?: { readonly x: Measure; readonly y: Measure };
  /** Optional mid-shaft curve offset from the host device's anchor for a curved home run. */
  readonly bendOffset?: { readonly x: Measure; readonly y: Measure };
  /** Optional offset from the arrow tip to reposition the circuit label independently. */
  readonly labelOffset?: { readonly x: Measure; readonly y: Measure };
}

export interface DimensionSpec {
  /** The view (plan or detail) it is drawn in. */
  readonly view: string;
  /** The two ends, on plan. */
  readonly from: { readonly x: Measure; readonly y: Measure };
  readonly to: { readonly x: Measure; readonly y: Measure };
  /** Elements the ends follow when they move (each end: an element and where on it), or null for a free end. */
  readonly refs?: DimOf["refs"];
  /** How far the dimension line sits from the measured points (on paper). */
  readonly offset?: Measure;
  readonly kind?: "linear" | "aligned";
  readonly id?: string;
}
type CreateTagStyle = Extract<Command, { type: "create_tag_style" }>;
type UpdateTagStyle = Extract<Command, { type: "update_tag_style" }>;

/**
 * A tag style: its lines (field templates such as `"{pipe.size}"`), box,
 * orientation, the categories it applies to, and `arrow` — `"down_slope"`
 * points downhill along a sloped run on the view's paper, `"up_slope"` uphill.
 */
export type TagStyleSpec = Omit<CreateTagStyle, "type" | "styleId"> & { readonly id?: string };
/** Changes to a tag style; `arrow: "none"` removes its arrow, `""` clears a prefix or suffix. */
export type TagStyleChanges = Omit<UpdateTagStyle, "type" | "styleId">

function mm(m: Measure, what: string): number {
  if (m.kind !== "length") throw new Error(`${what} is a length; the value given is a ${m.kind}.`);
  return Math.round(measureIn(m, "mm") * 1000) / 1000;
}

/** A 3D point in model space, typed lengths (`x` east, `y` plan north, `z` up from project zero). */
export interface Point3Spec {
  readonly x: Measure;
  readonly y: Measure;
  readonly z: Measure;
}

/** Named vantage directions for a 3D view (`south_west`, `south_east`, `north_west`, `north_east`, `south`, `north`, `east`, `west`, `top`). */
export type LookFrom3d = LookFrom;

/** Camera settings for a saved 3D view: named vantage or explicit eye/target, lens angle (`fovDeg`, 5–120°), orthographic framing height, and projection. */
export interface Camera3dSpec {
  /** Named vantage looking at the view's 3D crop box (alternative to `eye` + `target`). */
  readonly lookFrom?: LookFrom3d;
  readonly eye?: Point3Spec;
  readonly target?: Point3Spec;
  /** Up direction (unitless vector; default `{ x: 0, y: 0, z: 1 }`). */
  readonly up?: { readonly x: number; readonly y: number; readonly z: number };
  /** Perspective vertical field of view, degrees (5–120). */
  readonly fovDeg?: number;
  /** Orthographic visible vertical span at the target (typed length). */
  readonly orthoHeight?: Measure;
  /** Projection for live 3D viewing (`"perspective"` or `"orthographic"`). */
  readonly projection?: ViewProjection;
}

/** A saved 3D view with optional camera (`fovDeg`, `lookFrom`, `eye`/`target`), projection, and 3D crop box. */
export interface View3dSpec extends Camera3dSpec {
  readonly name: string;
  /** Fit the 3D crop box to these element ids, grown out to nearby levels and grid lines. */
  readonly fitElements?: readonly string[];
  /** Fit the 3D crop box to this typed 3D region. */
  readonly fitRegion?: { readonly min: Point3Spec; readonly max: Point3Spec };
  /** Explicit oriented 3D crop box. */
  readonly cropBox?: { readonly center: Point3Spec; readonly halfSize: Point3Spec; readonly rotationDeg?: number };
  /** Crop on/off (default on). */
  readonly cropView?: boolean;
  /** Show the 3D crop box while editing (default on). */
  readonly showCropBox?: boolean;
  readonly id?: string;
}

function point3Mm(pt: Point3Spec, what: string): { readonly x: number; readonly y: number; readonly z: number } {
  return { x: mm(pt.x, `${what} x`), y: mm(pt.y, `${what} y`), z: mm(pt.z, `${what} z`) };
}

function validFovDeg(fovDeg: number): number {
  if (!Number.isFinite(fovDeg) || fovDeg < 5 || fovDeg > 120) {
    throw new ScriptRunError(`Field of view (${fovDeg}°) must be between 5° and 120°.`);
  }
  return fovDeg;
}

function regionAabb(region: { readonly min: Point3Spec; readonly max: Point3Spec }): Aabb3 {
  const a = point3Mm(region.min, "3D region min");
  const b = point3Mm(region.max, "3D region max");
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

function cropBoxForCreate(model: ModelState, spec: View3dSpec): { readonly box: CropBox3d; readonly cropBox?: CropBox3d; readonly fit?: { readonly elementIds?: readonly string[]; readonly region?: Aabb3 } } {
  const fitElements = spec.fitElements && spec.fitElements.length > 0 ? [...spec.fitElements] : undefined;
  const fitRegion = spec.fitRegion ? regionAabb(spec.fitRegion) : undefined;
  if (spec.cropBox && (fitElements || fitRegion)) throw new ScriptRunError("Give either cropBox or fitElements/fitRegion, not both.");
  if (spec.cropBox) {
    const cropBox = normalizeBox({
      center: point3Mm(spec.cropBox.center, "3D crop box center"),
      halfSize: point3Mm(spec.cropBox.halfSize, "3D crop box half-size"),
      rotationDeg: spec.cropBox.rotationDeg ?? 0,
    });
    return { box: cropBox, cropBox };
  }
  if (fitElements || fitRegion) {
    const fromElements = fitElements ? elementsAabb(model, fitElements) : null;
    if (fitElements && !fromElements && !fitRegion) throw new ScriptRunError("None of those elements is in what the script reads, or none has a size to fit the 3D view to.");
    const parts = [fromElements, fitRegion ?? null].filter((x): x is Aabb3 => x !== null);
    const merged: Aabb3 = {
      min: { x: Math.min(...parts.map((b) => b.min.x)), y: Math.min(...parts.map((b) => b.min.y)), z: Math.min(...parts.map((b) => b.min.z)) },
      max: { x: Math.max(...parts.map((b) => b.max.x)), y: Math.max(...parts.map((b) => b.max.y)), z: Math.max(...parts.map((b) => b.max.z)) },
    };
    return { box: boxForRegion(model, merged), fit: { ...(fitElements ? { elementIds: fitElements } : {}), ...(fitRegion ? { region: fitRegion } : {}) } };
  }
  return { box: boxAroundAabb(modelAabb(model), workingAngleOf(model)) };
}

function cameraFromSpec(base: View3dCamera, spec: Camera3dSpec, fallbackFovDeg = base.fovDeg): View3dCamera {
  return {
    eye: spec.eye ? point3Mm(spec.eye, "Camera eye") : base.eye,
    target: spec.target ? point3Mm(spec.target, "Camera target") : base.target,
    up: spec.up ?? base.up,
    fovDeg: spec.fovDeg !== undefined ? validFovDeg(spec.fovDeg) : fallbackFovDeg,
    orthoHeightMm: spec.orthoHeight !== undefined ? mm(spec.orthoHeight, "Orthographic view height") : base.orthoHeightMm,
  };
}

export interface SheetSpec {
  /** The sheet number people read ("M-101"). */
  readonly number: string;
  readonly name: string;
  readonly titleBlock?: CreateSheet["titleBlock"];
  /** Title block fields by name (drawn by, checked by, …). */
  readonly fields?: CreateSheet["fields"];
  readonly id?: string;
}

type PatchCategoryOverride = NonNullable<ViewProps["categoryOverrides"]>[string];

/** Per-category or per-service visibility/graphics override in a view (e.g. `"pipe"`, `"service:sanitary"`, `"duct"`). */
export interface CategoryOverrideSpec extends Omit<PatchCategoryOverride, "singleLineBelowMm"> {
  /** Runs narrower than this nominal width draw single-line; runs at or above draw double-line (e.g. `units.in(4)`). */
  readonly singleLineBelow?: Measure;
}

export interface PlanViewSpec {
  /** The level it shows (its id or name). */
  readonly level: string;
  readonly name: string;
  /** The discipline it is drawn for ("mechanical"); absent: every discipline. */
  readonly discipline?: string;
  /** Drawing scale as a ratio (48 is 1/4" = 1'-0"). */
  readonly scale?: number;
  readonly cutHeight?: Measure;
  /** Coarse: all runs single-line schematic. Medium: duct double-line, pipe/conduit single-line schematic. Fine: all double-line. */
  readonly detailLevel?: DetailLevel;
  /** Visual style: wireframe, hidden_line, shaded, shaded_edges. */
  readonly visualStyle?: VisualStyle;
  /** Print repeating inline service codes (CW, SAN, G…) inside single-line runs. Absent: on. */
  readonly showLineCodes?: boolean;
  /** Multiplier for annotative paper-space symbols and `minPaperMm` floors in this plan (0.5–3.0). Absent: 1. */
  readonly symbolScale?: number;
  /** Categories the view hides. */
  readonly hide?: ViewProps["hiddenCategories"];
  /** Per-category or per-service overrides (`pipe`, `service:sanitary`, `duct`…): detailLevel, singleLineBelow, lineWeights, pattern, halftone, visible. */
  readonly categoryOverrides?: Readonly<Record<string, CategoryOverrideSpec>>;
  /** Optional crop box corners on plan (model coordinates). */
  readonly crop?: { readonly from: { readonly x: Measure; readonly y: Measure }; readonly to: { readonly x: Measure; readonly y: Measure } };
  readonly id?: string;
}

export interface ViewChanges {
  readonly discipline?: string | null;
  readonly scale?: number;
  readonly cutHeight?: Measure;
  readonly detailLevel?: DetailLevel;
  readonly visualStyle?: VisualStyle;
  readonly showLineCodes?: boolean;
  /** Multiplier for annotative paper-space symbols and `minPaperMm` floors in this plan (0.5–3.0). */
  readonly symbolScale?: number;
  readonly hide?: ViewProps["hiddenCategories"];
  /** Replaces the view's per-category and per-service (`"service:<id>"`) graphics overrides map. Pass `{}` to clear all overrides. */
  readonly categoryOverrides?: Readonly<Record<string, CategoryOverrideSpec>>;
}

function toCategoryOverrides(spec: Readonly<Record<string, CategoryOverrideSpec>>): NonNullable<ViewProps["categoryOverrides"]> {
  const out: Record<string, PatchCategoryOverride> = {};
  for (const [id, o] of Object.entries(spec)) {
    const { singleLineBelow, ...rest } = o;
    out[id] = {
      ...rest,
      ...(singleLineBelow !== undefined ? { singleLineBelowMm: mm(singleLineBelow, `Single-line threshold for ${id}`) } : {}),
    };
  }
  return out;
}

/** A vertical orthographic view (section or elevation): the line it cuts/looks from, which side it faces, and how far it sees. */
export interface VerticalViewSpec {
  readonly name: string;
  /** Start of the cut/view plane on plan. */
  readonly from: { readonly x: Measure; readonly y: Measure };
  /** End of the cut/view plane on plan. */
  readonly to: { readonly x: Measure; readonly y: Measure };
  /** +1 looks to the left of from→to, -1 to the right (default +1). */
  readonly direction?: 1 | -1;
  /** Far clip depth beyond the plane (default 20 ft). */
  readonly depth?: Measure;
  /** Optional explicit section crop box (along-cut x and elevation y). */
  readonly crop?: { readonly from: { readonly x: Measure; readonly y: Measure }; readonly to: { readonly x: Measure; readonly y: Measure } };
  /** Extra annotative extension of the section head past `from` (independent of cut range). */
  readonly headExt?: Measure;
  /** Extra annotative extension of the section tail past `to` (independent of cut range). */
  readonly tailExt?: Measure;
  /** Split/broken section line across the middle of the plan (Revit break). */
  readonly splitGap?: boolean;
  /** Left paper-mm extension of level datum lines past the crop box. */
  readonly levelLeftExtMm?: number;
  /** Right paper-mm extension of level datum heads past the crop box. */
  readonly levelRightExtMm?: number;
  /** Drawing scale as a ratio (default 48 = 1/4" = 1'-0"). */
  readonly scale?: number;
  /** Optional level whose plan shows this marker; absent: shown on every level's plan it overlaps. */
  readonly level?: string;
  readonly discipline?: string;
  readonly hide?: ViewProps["hiddenCategories"];
  readonly id?: string;
}

/** A Revit-style enlarged plan: creates a cropped plan view at enlarged scale AND places a live auto-updating callout bubble on the parent plan. */
export interface EnlargedPlanSpec {
  /** Parent floor plan or ceiling plan (id or name). */
  readonly parent: string;
  /** Name of the new enlarged plan view. */
  readonly name: string;
  /** One corner of the enlarged callout box on plan. */
  readonly from: { readonly x: Measure; readonly y: Measure };
  /** Opposite corner of the enlarged callout box on plan. */
  readonly to: { readonly x: Measure; readonly y: Measure };
  /** Enlarged scale ratio (e.g. 48 = 1/4"=1'-0", 24 = 1/2"=1'-0"). Defaults to 24 if parent is <= 48, else 48. */
  readonly scale?: number;
  /** Optional callout head label (e.g. "EEP"); absent: live detail number on its sheet. */
  readonly label?: string;
  /** Optional head bubble position on plan; absent: just outside the upper-left corner. */
  readonly head?: { readonly x: Measure; readonly y: Measure };
  readonly discipline?: string;
  readonly cutHeight?: Measure;
  readonly id?: string;
  readonly calloutId?: string;
}

/** A live parametric callout box + split bubble placed on a view, referencing any existing enlarged plan, detail, section, or elevation view. */
export interface CalloutRefSpec {
  /** View the callout is drawn on (id or name). */
  readonly view: string;
  /** Existing view the callout refers to (id or name); head reads its live detail#/sheet#. */
  readonly target: string;
  readonly from: { readonly x: Measure; readonly y: Measure };
  readonly to: { readonly x: Measure; readonly y: Measure };
  /** Optional head bubble position on plan; absent: just outside the upper-left corner. */
  readonly head?: { readonly x: Measure; readonly y: Measure };
  /** Optional head label; absent: live detail number on its sheet. */
  readonly label?: string;
  readonly id?: string;
}

/** Changes a view's crop box (and optionally far clip depth, level datum extensions, or annotative section head/tail/split for sections/elevations). */
export interface CropBoxSpec {
  readonly from?: { readonly x: Measure; readonly y: Measure };
  readonly to?: { readonly x: Measure; readonly y: Measure };
  readonly cropView?: boolean;
  readonly showCropBox?: boolean;
  /** Toggle annotation crop boundary and its paper-mm offset outside the model crop box (for section/grid/level bubbles & tags). */
  readonly annotationCrop?: boolean;
  readonly annotationCropOffsetMm?: number;
  /** Sections and elevations only: far clip depth beyond the cut/view plane. */
  readonly depth?: Measure;
  /** Sections and elevations: left/right paper-mm extension of level datum lines past crop. */
  readonly levelLeftExtMm?: number;
  readonly levelRightExtMm?: number;
  /** Sections: annotative head/tail extensions (model units) and middle split-gap toggle. */
  readonly headExt?: Measure;
  readonly tailExt?: Measure;
  readonly splitGap?: boolean;
}

/** Where a view sits on its sheet: its centre, from the sheet's lower-left corner. */
export interface SheetPoint {
  readonly x: Measure;
  readonly y: Measure;
}

/** A view names its level by name (that is what it draws by); scripts give the level's id or its name. */
function levelName(ctx: ScriptContext, level: string): string {
  const el = ctx.model.find(level);
  return el?.kind === "level" && typeof el.name === "string" ? el.name : level;
}

function view(ctx: ScriptContext, viewType: CreateView["viewType"], spec: PlanViewSpec): string {
  const props: ViewProps = {
    level: levelName(ctx, spec.level),
    ...(spec.discipline ? { discipline: spec.discipline } : {}),
    ...(spec.scale ? { scale: spec.scale } : {}),
    ...(spec.cutHeight ? { cutHeightMm: mm(spec.cutHeight, "Cut height") } : {}),
    ...(spec.detailLevel ? { detailLevel: spec.detailLevel } : {}),
    ...(spec.visualStyle ? { visualStyle: spec.visualStyle } : {}),
    ...(spec.showLineCodes !== undefined ? { showLineCodes: spec.showLineCodes } : {}),
    ...(spec.symbolScale !== undefined ? { symbolScale: spec.symbolScale } : {}),
    ...(spec.hide ? { hiddenCategories: spec.hide } : {}),
    ...(spec.categoryOverrides ? { categoryOverrides: toCategoryOverrides(spec.categoryOverrides) } : {}),
  };
  const viewId = spec.id ?? ctx.id("view");
  const crop = spec.crop
    ? {
        min: { x: Math.min(mm(spec.crop.from.x, "Crop x"), mm(spec.crop.to.x, "Crop x")), y: Math.min(mm(spec.crop.from.y, "Crop y"), mm(spec.crop.to.y, "Crop y")) },
        max: { x: Math.max(mm(spec.crop.from.x, "Crop x"), mm(spec.crop.to.x, "Crop x")), y: Math.max(mm(spec.crop.from.y, "Crop y"), mm(spec.crop.to.y, "Crop y")) },
      }
    : undefined;
  ctx.edit({ type: "create_view", viewId, name: spec.name, viewType, ...(crop ? { crop } : {}), props });
  return viewId;
}

function verticalView(ctx: ScriptContext, viewType: "section" | "elevation", spec: VerticalViewSpec): string {
  const viewId = spec.id ?? ctx.id("view");
  const start = { x: mm(spec.from.x, `${viewType} start x`), y: mm(spec.from.y, `${viewType} start y`) };
  const end = { x: mm(spec.to.x, `${viewType} end x`), y: mm(spec.to.y, `${viewType} end y`) };
  const depthMm = spec.depth ? mm(spec.depth, `${viewType} depth`) : 20 * 304.8;
  const crop = spec.crop
    ? {
        min: { x: Math.min(mm(spec.crop.from.x, "Crop x"), mm(spec.crop.to.x, "Crop x")), y: Math.min(mm(spec.crop.from.y, "Crop y"), mm(spec.crop.to.y, "Crop y")) },
        max: { x: Math.max(mm(spec.crop.from.x, "Crop x"), mm(spec.crop.to.x, "Crop x")), y: Math.max(mm(spec.crop.from.y, "Crop y"), mm(spec.crop.to.y, "Crop y")) },
      }
    : undefined;
  const props: ViewProps = {
    ...(spec.level ? { level: levelName(ctx, spec.level) } : {}),
    ...(spec.discipline ? { discipline: spec.discipline } : {}),
    ...(spec.scale ? { scale: spec.scale } : {}),
    ...(spec.hide ? { hiddenCategories: spec.hide } : {}),
    ...(spec.levelLeftExtMm !== undefined ? { levelLeftExtMm: spec.levelLeftExtMm } : {}),
    ...(spec.levelRightExtMm !== undefined ? { levelRightExtMm: spec.levelRightExtMm } : {}),
    section: {
      start,
      end,
      direction: spec.direction ?? 1,
      depthMm,
      ...(spec.headExt !== undefined ? { headExtMm: mm(spec.headExt, "Section head extension") } : {}),
      ...(spec.tailExt !== undefined ? { tailExtMm: mm(spec.tailExt, "Section tail extension") } : {}),
      ...(spec.splitGap !== undefined ? { splitGap: spec.splitGap } : {}),
    },
  };
  ctx.edit({ type: "create_view", viewId, name: spec.name, viewType, ...(crop ? { crop } : {}), props });
  return viewId;
}

function viewIn(model: Pick<ModelState, "elements">, ref: string, what: string): ViewElement {
  const direct = model.elements[ref];
  if (direct?.kind === "view") return direct;
  const key = ref.trim().toLowerCase();
  const named = Object.values(model.elements).find((e): e is ViewElement => e.kind === "view" && e.name.trim().toLowerCase() === key);
  if (!named) throw new ScriptRunError(`No ${what} "${ref}" in what the script reads (give its id, or add views to reads.kinds).`);
  return named;
}

function sheetIdIn(model: Pick<ModelState, "elements">, ref: string): string {
  const direct = model.elements[ref];
  if (direct?.kind === "sheet") return direct.id;
  const key = ref.trim().toLowerCase();
  const hit = Object.values(model.elements).find((e) => e.kind === "sheet" && (e.number.trim().toLowerCase() === key || e.title.trim().toLowerCase() === key));
  if (!hit) throw new ScriptRunError(`No sheet "${ref}" in what the script reads.`);
  return hit.id;
}

const columnId = (path: string) => path.replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 80) || "column";

function classDefinition(spec: ClassScheduleSpec, title: string): ScheduleDefinitionV2 {
  const registry = fieldProviderRegistry();
  const adds = (path: string) => spec.classes.some((c) => { const a = registry.field(c, path)?.aggregation; return a !== undefined && a !== "none"; });
  const known = (path: string) => spec.classes.some((c) => registry.field(c, path) !== undefined);
  const used = new Set<string>();
  const columns = spec.columns.map((c): ScheduleColumnDef => {
    if (typeof c !== "string") return c;
    let id = columnId(c);
    for (let n = 2; used.has(id); n++) id = `${columnId(c)}_${n}`;
    used.add(id);
    return { id, kind: known(c) ? "field" : "parameter", path: c, ...(spec.totals && adds(c) ? { total: true } : {}) };
  });
  const levels = spec.levels?.filter((l) => l.trim().length > 0) ?? [];
  return {
    name: title,
    source: { kind: "classes", classes: [...spec.classes], includeSubclasses: spec.includeSubclasses ?? true, ...(levels.length > 0 ? { scope: { levels } } : {}) },
    columns,
    filters: [...(spec.filters ?? [])],
    sort: (spec.sort ?? []).map((s) => (typeof s === "string" ? { path: s, direction: "asc" as const } : s)),
    groups: (spec.groups ?? []).map((g): ScheduleGroup => (typeof g === "string" ? { path: g, header: true, footer: false, totals: false } : { path: g.path, header: g.header ?? true, footer: g.footer ?? false, totals: g.totals ?? false })),
    grandTotals: spec.totals ?? false,
    itemize: true,
    presentation: { kind: "list" },
    display: { textSizeMm: 2.38, emptyText: "NONE" },
  };
}

function cellAt(values: ColumnValues | undefined, i: number): number | string | boolean | null {
  if (!values) return null;
  if (values.type === "quantity") {
    const v = values.values[i];
    return v === undefined || Number.isNaN(v) ? null : v;
  }
  if (values.type === "boolean") {
    const v = values.values[i] ?? -1;
    return v === -1 ? null : v === 1;
  }
  return values.values[i] ?? null;
}

function rowsOut(name: string, set: RowSet): ScheduleRows {
  const columns = set.columns.map((c) => ({ id: c.id, heading: c.heading, valueType: c.valueType, ...(c.quantityKind ? { quantityKind: c.quantityKind } : {}) }));
  const rows = set.rowKeys.map((key, i) => ({ key, element: set.elementIds[i] ?? "", cells: Object.fromEntries(set.columns.map((c) => [c.id, c.kind === "expand" ? (set.children.get(c.id)?.get(key)?.rowCount ?? 0) : cellAt(set.values.get(c.id), i)])) }));
  const totals = Object.fromEntries([...(set.totals ?? new Map())].map(([id, m]) => [id, m ? m.value : null]));
  return { name, columns, rows, totals, totalRows: set.window?.totalRows ?? set.rowCount };
}

function storedDefinition(view: ViewElement): ScheduleDefinitionV2 {
  const props = view.props;
  if (props?.scheduleV2) {
    if (props.scheduleV2.presentation.kind === "form") throw new ScriptRunError(`${view.name} is a form schedule (a panel or feeder form): its numbers are the add-on's reads, e.g. ctx.read("electrical.loads", { panel }).`);
    return props.scheduleV2;
  }
  if (props?.formSchedule) throw new ScriptRunError(`${view.name} is a form schedule (a panel or feeder form): its numbers are the add-on's reads, e.g. ctx.read("electrical.loads", { panel }).`);
  if (props?.schedule) return scheduleV1ToV2(props.schedule);
  throw new ScriptRunError(`Schedule view "${view.name}" has no definition yet.`);
}

function openRows(model: ModelState, def: ScheduleDefinitionV2, viewId: string) {
  try {
    return openSchedule(model, def, { viewId, revision: model.revision, registry: fieldProviderRegistry() });
  } catch (err) {
    if (err instanceof ScheduleDefinitionError) throw new ScriptRunError(`This schedule can't be built: ${err.problems.map((p) => p.message).join(" ")}`);
    throw err;
  }
}

export const documents = {
  /** A new sheet; returns its id. */
  sheet(ctx: ScriptContext, spec: SheetSpec): string {
    const sheetId = spec.id ?? ctx.id("sheet");
    ctx.edit({ type: "create_sheet", sheetId, number: spec.number, name: spec.name, ...(spec.titleBlock ? { titleBlock: spec.titleBlock } : {}), ...(spec.fields ? { fields: spec.fields } : {}) });
    return sheetId;
  },
  /** Changes a sheet's number, name, title block or fields. */
  setSheet(ctx: ScriptContext, sheetId: string, changes: Omit<SheetSpec, "id">): void {
    ctx.edit({ type: "set_sheet_properties", sheetId, ...changes });
  },
  /** A floor plan of one level; returns the view's id. */
  planView(ctx: ScriptContext, spec: PlanViewSpec): string {
    return view(ctx, "floor_plan", spec);
  },
  /** A reflected ceiling plan of one level; returns the view's id. */
  ceilingView(ctx: ScriptContext, spec: PlanViewSpec): string {
    return view(ctx, "ceiling_plan", spec);
  },
  /** A vertical building section cut across the model; its live section mark prints on overlapping plans. Returns the view's id. */
  sectionView(ctx: ScriptContext, spec: VerticalViewSpec): string {
    return verticalView(ctx, "section", spec);
  },
  /** An interior or exterior elevation looking from `from..to`; its live elevation marker prints on overlapping plans. Returns the view's id. */
  elevationView(ctx: ScriptContext, spec: VerticalViewSpec): string {
    return verticalView(ctx, "elevation", spec);
  },
  /** A saved 3D view with its 3D crop box, projection, and camera (`lookFrom` preset or explicit `eye`/`target`, `fovDeg` 5–120°, `orthoHeight`). Returns the view's id. */
  view3d(ctx: ScriptContext, spec: View3dSpec): string {
    const viewId = spec.id ?? ctx.id("view3d");
    const hasCamera = spec.lookFrom !== undefined || spec.eye !== undefined || spec.target !== undefined || spec.up !== undefined || spec.fovDeg !== undefined || spec.orthoHeight !== undefined;
    const resolved = onWorking(ctx, "documents.view3d", (model) => {
      const { box, cropBox, fit } = cropBoxForCreate(model, spec);
      const base = spec.lookFrom ? cameraLookingFrom(box, spec.lookFrom) : defaultCamera(box);
      const camera = hasCamera ? cameraFromSpec(base, spec) : undefined;
      return { cropBox, fit, camera };
    });
    ctx.edit({
      type: "create_3d_view",
      viewId,
      name: spec.name,
      ...(resolved.camera ? { camera: resolved.camera } : {}),
      ...(spec.projection ? { projection: spec.projection } : {}),
      ...(resolved.cropBox ? { cropBox: resolved.cropBox } : {}),
      ...(resolved.fit ? { fit: resolved.fit } : {}),
      ...(spec.cropView !== undefined ? { cropView: spec.cropView } : {}),
      ...(spec.showCropBox !== undefined ? { showCropBox: spec.showCropBox } : {}),
    });
    return viewId;
  },
  /** Updates a saved 3D view's camera (`fovDeg` 5–120°, `lookFrom`, `eye`/`target`, `orthoHeight`, `projection`), preserving any unspecified fields from its current camera. */
  setCamera3d(ctx: ScriptContext, viewRef: string, spec: Camera3dSpec): void {
    const { viewId, camera } = onWorking(ctx, "documents.setCamera3d", (model) => {
      const v = viewIn(model, viewRef, "3D view");
      if (v.viewType !== "three_d") throw new ScriptRunError(`View "${v.name}" is not a 3D view.`);
      const box = viewCropBox3d(model, v);
      const current = viewCamera3d(model, v);
      if (!box || !current) throw new ScriptRunError(`View "${v.name}" has no 3D camera.`);
      const base = spec.lookFrom ? cameraLookingFrom(box, spec.lookFrom) : current;
      return { viewId: v.id, camera: cameraFromSpec(base, spec, current.fovDeg) };
    });
    ctx.edit({
      type: "set_3d_view_camera",
      viewId,
      camera,
      ...(spec.projection ? { projection: spec.projection } : {}),
    });
  },
  /**
   * A Revit-style enlarged plan: creates a cropped plan view on the same level
   * at enlarged scale and places a live auto-updating callout bubble on the
   * parent plan pointing to it. Returns `{ viewId, calloutId }`.
   */
  enlargedPlan(ctx: ScriptContext, spec: EnlargedPlanSpec): { readonly viewId: string; readonly calloutId: string } {
    const viewId = spec.id ?? ctx.id("view");
    const calloutId = spec.calloutId ?? ctx.id("callout");
    const box = {
      min: { x: mm(spec.from.x, "Callout start x"), y: mm(spec.from.y, "Callout start y") },
      max: { x: mm(spec.to.x, "Callout end x"), y: mm(spec.to.y, "Callout end y") },
    };
    const head = spec.head ? { x: mm(spec.head.x, "Callout head x"), y: mm(spec.head.y, "Callout head y") } : undefined;
    const cutHeightMm = spec.cutHeight ? mm(spec.cutHeight, "Cut height") : undefined;
    const commands = onWorking(ctx, "documents.enlargedPlan", (model) => {
      const parent = viewIn(model, spec.parent, "parent plan view");
      return enlargedPlanCommands(model, {
        parentViewId: parent.id,
        viewId,
        calloutId,
        name: spec.name,
        box,
        ...(spec.scale ? { scale: spec.scale } : {}),
        ...(spec.label ? { label: spec.label } : {}),
        ...(head ? { head } : {}),
        ...(spec.discipline ? { discipline: spec.discipline } : {}),
        ...(cutHeightMm !== undefined ? { cutHeightMm } : {}),
      });
    });
    if (typeof commands === "string") throw new ScriptRunError(commands);
    for (const step of commands) ctx.edit(step);
    return { viewId, calloutId };
  },
  /**
   * A live parametric callout box + split head bubble on `view` pointing to an
   * existing `target` view (enlarged plan, 2D detail, section, or elevation).
   * The head reads the target's live detail#/sheet# whenever it moves sheets.
   */
  callout(ctx: ScriptContext, spec: CalloutRefSpec): string {
    const itemId = spec.id ?? ctx.id("callout");
    const min = { x: Math.min(mm(spec.from.x, "Callout x"), mm(spec.to.x, "Callout x")), y: Math.min(mm(spec.from.y, "Callout y"), mm(spec.to.y, "Callout y")) };
    const max = { x: Math.max(mm(spec.from.x, "Callout x"), mm(spec.to.x, "Callout x")), y: Math.max(mm(spec.from.y, "Callout y"), mm(spec.to.y, "Callout y")) };
    const resolved = onWorking(ctx, "documents.callout", (model) => {
      const owner = viewIn(model, spec.view, "view");
      const target = viewIn(model, spec.target, "target view");
      const scale = owner.props?.scale ?? 96;
      const head = spec.head ? { x: mm(spec.head.x, "Callout head x"), y: mm(spec.head.y, "Callout head y") } : { x: min.x - 8 * scale, y: max.y + 8 * scale };
      return { ownerId: owner.id, targetId: target.id, head };
    });
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: resolved.ownerId,
      shape: "callout",
      points: [min, max, resolved.head],
      callout: { viewId: resolved.targetId, ...(spec.label?.trim() ? { label: spec.label.trim() } : {}) },
    });
    return itemId;
  },
  /** Sets a view's crop box (and optionally crop on/off, far clip depth, level datum extensions, or section head/tail/split). */
  setCrop(ctx: ScriptContext, viewRef: string, spec: CropBoxSpec): void {
    const { viewId, existingSection } = onWorking(ctx, "documents.setCrop", (model) => {
      const v = viewIn(model, viewRef, "view");
      return { viewId: v.id, existingSection: v.props?.section };
    });
    const crop =
      spec.from && spec.to
        ? {
            min: { x: Math.min(mm(spec.from.x, "Crop x"), mm(spec.to.x, "Crop x")), y: Math.min(mm(spec.from.y, "Crop y"), mm(spec.to.y, "Crop y")) },
            max: { x: Math.max(mm(spec.from.x, "Crop x"), mm(spec.to.x, "Crop x")), y: Math.max(mm(spec.from.y, "Crop y"), mm(spec.to.y, "Crop y")) },
          }
        : undefined;
    const sectionUpdate =
      existingSection && (spec.headExt !== undefined || spec.tailExt !== undefined || spec.splitGap !== undefined)
        ? {
            ...existingSection,
            ...(spec.headExt !== undefined ? { headExtMm: mm(spec.headExt, "Section head extension") } : {}),
            ...(spec.tailExt !== undefined ? { tailExtMm: mm(spec.tailExt, "Section tail extension") } : {}),
            ...(spec.splitGap !== undefined ? { splitGap: spec.splitGap } : {}),
          }
        : undefined;
    ctx.edit({
      type: "set_view_crop",
      viewId,
      ...(crop ? { crop } : {}),
      ...(spec.cropView !== undefined ? { cropView: spec.cropView } : {}),
      ...(spec.showCropBox !== undefined ? { showCropBox: spec.showCropBox } : {}),
      ...(spec.annotationCrop !== undefined ? { annotationCrop: spec.annotationCrop } : {}),
      ...(spec.annotationCropOffsetMm !== undefined ? { annotationCropOffsetMm: spec.annotationCropOffsetMm } : {}),
      ...(spec.depth ? { farClipMm: mm(spec.depth, "Far clip depth") } : {}),
      ...(spec.levelLeftExtMm !== undefined ? { levelLeftExtMm: spec.levelLeftExtMm } : {}),
      ...(spec.levelRightExtMm !== undefined ? { levelRightExtMm: spec.levelRightExtMm } : {}),
      ...(sectionUpdate ? { section: sectionUpdate } : {}),
    });
  },
  /** Changes a view's detail level, visual style, inline service codes, scale, discipline, or per-category/service graphics overrides. */
  setView(ctx: ScriptContext, viewId: string, changes: ViewChanges): void {
    ctx.edit({
      type: "set_view_properties",
      viewId,
      props: {
        ...(changes.discipline !== undefined ? { discipline: changes.discipline } : {}),
        ...(changes.scale !== undefined ? { scale: changes.scale } : {}),
        ...(changes.cutHeight !== undefined ? { cutHeightMm: mm(changes.cutHeight, "Cut height") } : {}),
        ...(changes.detailLevel !== undefined ? { detailLevel: changes.detailLevel } : {}),
        ...(changes.visualStyle !== undefined ? { visualStyle: changes.visualStyle } : {}),
        ...(changes.showLineCodes !== undefined ? { showLineCodes: changes.showLineCodes } : {}),
        ...(changes.symbolScale !== undefined ? { symbolScale: changes.symbolScale } : {}),
        ...(changes.hide !== undefined ? { hiddenCategories: changes.hide } : {}),
        ...(changes.categoryOverrides !== undefined ? { categoryOverrides: toCategoryOverrides(changes.categoryOverrides) } : {}),
      },
    });
  },
  /** A copy of a view (a second plan of the same level for another discipline); returns the new id. */
  duplicateView(ctx: ScriptContext, viewId: string, name: string, id?: string): string {
    const newViewId = id ?? ctx.id("view");
    ctx.edit({ type: "duplicate_view", viewId, newViewId, name });
    return newViewId;
  },
  /** Puts a view (a plan, a schedule, a detail) on a sheet; returns the viewport's id. */
  place(
    ctx: ScriptContext,
    sheetId: string,
    viewId: string,
    at: SheetPoint,
    scale?: number,
    title?: { readonly offset?: { readonly x: Measure; readonly y: Measure }; readonly ruleLength?: Measure },
  ): string {
    const viewportId = ctx.id("vp");
    ctx.edit({
      type: "place_viewport",
      viewportId,
      sheetId,
      viewId,
      center: { x: mm(at.x, "Viewport x"), y: mm(at.y, "Viewport y") },
      ...(scale ? { scale } : {}),
      ...(title?.offset ? { titleOffsetMm: { x: mm(title.offset.x, "Title offset x"), y: mm(title.offset.y, "Title offset y") } } : {}),
      ...(title?.ruleLength ? { titleRuleMm: mm(title.ruleLength, "Title rule length") } : {}),
    });
    return viewportId;
  },
  /** Moves a placed viewport's title block on its sheet and/or changes its title horizontal rule length (Revit viewport title grips). */
  setViewportTitle(
    ctx: ScriptContext,
    viewportId: string,
    spec: { readonly offset?: { readonly x: Measure; readonly y: Measure }; readonly ruleLength?: Measure | null },
  ): void {
    ctx.edit({
      type: "set_viewport_title",
      viewportId,
      ...(spec.offset ? { titleOffsetMm: { x: mm(spec.offset.x, "Title offset x"), y: mm(spec.offset.y, "Title offset y") } } : {}),
      ...(spec.ruleLength !== undefined ? { titleRuleMm: spec.ruleLength === null ? null : mm(spec.ruleLength, "Title rule length") } : {}),
    });
  },
  /** Edits a schedule view, one undo step per call: add / move / remove columns, filter, sort, group, totals. */
  editSchedule(ctx: ScriptContext, viewId: string, steps: EditSchedule["steps"]): void {
    ctx.edit({ type: "edit_schedule", viewId, steps });
  },
  /**
   * A schedule view; returns its id. Put it on a sheet with `documents.place`.
   * Give `classes` (rooms, spaces, zones, any class) for the full format, or
   * `category` for a one-category list.
   */
  schedule(ctx: ScriptContext, spec: ScheduleSpec | ClassScheduleSpec): string {
    const viewId = spec.id ?? ctx.id("schedule");
    const definition =
      "classes" in spec
        ? onWorking(ctx, "documents.schedule", () => classDefinition(spec, spec.name))
        : scheduleV1ToV2({ category: spec.category, title: spec.title ?? spec.name, columns: spec.columns.map((field) => ({ field })) });
    if ("classes" in spec) onWorking(ctx, "documents.schedule", (model) => openRows(model, definition, viewId));
    ctx.edit({ type: "create_view", viewId, name: spec.name, viewType: "schedule", props: { scheduleV2: definition } });
    return viewId;
  },
  /** A schedule's rows as numbers and words (the model as the script has it so far): from `offset`, at most `limit` (default 200). */
  scheduleRows(ctx: ScriptContext, schedule: string, window: { readonly offset?: number; readonly limit?: number } = {}): ScheduleRows {
    return onWorking(ctx, "documents.scheduleRows", (model) => {
      const view = viewIn(model, schedule, "schedule view");
      if (view.viewType !== "schedule") throw new ScriptRunError(`${view.name} is a ${view.viewType.replace("_", " ")}, not a schedule.`);
      const session = openRows(model, storedDefinition(view), view.id);
      return rowsOut(view.name, session.window(Math.max(0, window.offset ?? 0), Math.min(Math.max(1, window.limit ?? 200), 2000)));
    });
  },
  /** What a schedule can list and show: every class (no argument), or each named class's fields and relationships. */
  scheduleFields(ctx: ScriptContext, classes?: readonly string[]): readonly ScheduleClassFields[] {
    return onWorking(ctx, "documents.scheduleFields", () => {
      const registry = fieldProviderRegistry();
      const ids = classes && classes.length > 0 ? classes : registry.listClasses().map((c) => c.id);
      return ids.map((id) => {
        const cls = registry.getClass(id);
        if (!cls) throw new ScriptRunError(`No schedule class "${id}". documents.scheduleFields(ctx) lists them.`);
        const detail = classes && classes.length > 0;
        return {
          id,
          label: cls.label,
          fields: detail ? registry.fieldsFor(id).map((f) => ({ path: f.path, label: f.label, valueType: String(f.valueType), ...(f.kind ? { kind: String(f.kind) } : {}), ...(f.unit ? { unit: String(f.unit) } : {}), ...(f.aggregation && f.aggregation !== "none" ? { totals: String(f.aggregation) } : {}) })) : [],
          relationships: detail ? registry.relationshipsFor(id).map((r) => ({ id: r.id, label: r.label, to: String(r.to) })) : [],
        };
      });
    });
  },
  /**
   * Tags every element of these categories in a view, each head placed clear
   * of the others and of notes and dimensions, as one edit. Returns how many
   * it tagged and what it skipped, with why.
   */
  autoTag(ctx: ScriptContext, spec: AutoTagSpec): { readonly tagged: number; readonly skipped: readonly { readonly elementId: string; readonly reason: string }[] } {
    const { view, plan } = onWorking(ctx, "documents.autoTag", (model) => {
      const v = viewIn(model, spec.view, "view");
      return {
        view: v,
        plan: planAutoTags(model, v.id, {
          categories: spec.categories,
          leader: spec.leaders ?? "when_away",
          skipTagged: !(spec.includeTagged ?? false),
          idPrefix: ctx.id("atag"),
          ...(spec.textHeight ? { textSizeMm: mm(spec.textHeight, "Tag text height") } : {}),
          ...(spec.styleId ? { styleId: spec.styleId } : {}),
          ...(spec.only ? { onlyElementIds: new Set(spec.only) } : {}),
        }),
      };
    });
    const items = plan.items.slice(0, 500);
    for (const it of items) ctx.edit({ type: "add_drawing_item", itemId: it.itemId, ownerId: view.id, shape: "tag", points: [it.at], tag: it.tag });
    return { tagged: items.length, skipped: plan.skipped };
  },
  /** Dimensions runs, walls or grid lines in a plan or section as one edit; every dimension follows its elements. */
  autoDimension(ctx: ScriptContext, spec: AutoDimensionSpec): void {
    const command = onWorking(ctx, "documents.autoDimension", (model) => {
      const v = viewIn(model, spec.view, "view");
      return autoDimensionCommand(model, v.id, v, spec.elements, { mode: spec.mode, ...(spec.direction ? { direction: spec.direction } : {}), offsetMm: spec.offset ? mm(spec.offset, "Dimension offset") : 0.375 * 25.4, idPrefix: ctx.id("adim") });
    });
    if (typeof command === "string") throw new ScriptRunError(command);
    ctx.editSteps(command);
  },
  /** Packs a sheet's viewports into its drawing area (the editor's Arrange), as one edit. Returns how many moved. */
  packSheet(ctx: ScriptContext, sheet: string, spec: PackSheetSpec = {}): { readonly moved: number } {
    const planned = onWorking(ctx, "documents.packSheet", (model) => sheetLayoutCommand(model, sheetIdIn(model, sheet), { mode: spec.mode ?? "pack", ...(spec.columns ? { columns: spec.columns } : {}), ...(spec.fitScales ? { fitScales: true } : {}), ...(spec.minScale ? { minScale: spec.minScale } : {}), ...(spec.order ? { order: spec.order } : {}), ...(spec.gap ? { gapMm: mm(spec.gap, "Gap") } : {}) }));
    if (planned.command) ctx.editSteps(planned.command);
    return { moved: planned.layout.moves.length };
  },
  /** Every live diagram kind available from the model's active packs (`"one_line"`, `"electrical_riser"`, `"electrical.controls_diagram"`, `"plumbing_riser"`, …). */
  diagramKinds(ctx: ScriptContext): readonly { readonly kind: StoredDiagramKind; readonly label: string }[] {
    return onWorking(ctx, "documents.diagramKinds", () => diagramKinds());
  },
  /** A live diagram view derived from the model by any active pack (`documents.diagramKinds(ctx)` lists available kinds). Returns the view's id. */
  diagram(ctx: ScriptContext, spec: LiveDiagramSpec): string {
    const viewId = spec.id ?? ctx.id("view");
    ctx.edit({ type: "create_view", viewId, name: spec.name, viewType: "detail", props: { diagram: { kind: spec.kind, ...(spec.hints ? { hints: spec.hints } : {}) } } });
    return viewId;
  },
  /** A one-line, riser, or live pack diagram in a new drafting view; returns the view's id. Put it on a sheet with `documents.place`. */
  oneLine(ctx: ScriptContext, spec: OneLineDiagramSpec): string {
    const viewId = spec.id ?? ctx.id("view");
    if ("live" in spec) {
      ctx.edit({ type: "create_view", viewId, name: spec.name, viewType: "detail", props: { diagram: { kind: spec.live, ...(spec.hints ? { hints: spec.hints } : {}) } } });
      return viewId;
    }
    const layout = layoutOneLine(spec.diagram);
    ctx.edit({ type: "create_view", viewId, name: spec.name, viewType: "detail", props: { scale: 1 } });
    for (const step of oneLineCommands(viewId, layout, ctx.id("sld"), ONE_LINE_TEXT_MM)) ctx.edit(step);
    ctx.edit(oneLineCropCommand(viewId, layout));
    return viewId;
  },
  /** The form schedule kinds the model's add-ons offer, and whether each is bound to one element (a panel). */
  formKinds(ctx: ScriptContext): readonly { readonly kind: string; readonly boundToElement: boolean }[] {
    return onWorking(ctx, "documents.formKinds", () => formScheduleKinds().map((kind) => ({ kind, boundToElement: isBoundFormKind(kind) })));
  },
  /** A form schedule view (a panel schedule…) with the add-on's built-in form; returns its id. Put it on a sheet with `documents.place`. */
  formSchedule(ctx: ScriptContext, spec: FormScheduleSpec): string {
    const viewId = spec.id ?? ctx.id("schedule");
    const formSchedule = onWorking(ctx, "documents.formSchedule", () => {
      if (!formScheduleKinds().includes(spec.kind)) throw new ScriptRunError(`No form schedule "${spec.kind}" on this model. documents.formKinds(ctx) lists them.`);
      if (isBoundFormKind(spec.kind) && !spec.element) throw new ScriptRunError(`A ${spec.kind} schedule is the schedule of one element: give element.`);
      return { kind: spec.kind, ...(spec.element ? { elementId: spec.element } : {}), template: builtinFormTemplate(spec.kind), ...(spec.rules ? { rules: spec.rules } : {}) };
    });
    ctx.edit({ type: "create_view", viewId, name: spec.name, viewType: "schedule", props: { formSchedule } });
    return viewId;
  },
  /** The 2D detail library: components (with their default size, mm), hatch and line patterns, line styles and weights. */
  detailLibrary(ctx: ScriptContext) {
    return onWorking(ctx, "documents.detailLibrary", () => ({
      components: detailComponents().map((c) => ({ id: c.id, name: c.name, category: c.category, widthMm: c.widthMm, heightMm: c.heightMm, linear: c.linear === true })),
      hatchPatterns: HATCH_PATTERNS,
      linePatterns: LINE_PATTERNS,
      lineStyles: DETAIL_LINE_STYLES.map((x) => ({ id: x.id, name: x.name })),
      lineWeights: LINE_WEIGHTS_2D,
    }));
  },
  /** A tag on one element in a plan view; returns the tag's id. */
  tag(ctx: ScriptContext, spec: TagSpec): string {
    const itemId = spec.id ?? ctx.id("tag");
    const elbow =
      spec.elbow === "auto"
        ? ("auto" as const)
        : spec.elbow
          ? { x: mm(spec.elbow.x, "Tag elbow x"), y: mm(spec.elbow.y, "Tag elbow y") }
          : undefined;
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: spec.view,
      shape: "tag",
      points: [{ x: mm(spec.at.x, "Tag x"), y: mm(spec.at.y, "Tag y") }],
      tag: {
        elementId: spec.element,
        template: spec.template ?? (spec.fields ? "fields" : "auto"),
        leader: spec.leader ?? true,
        ...(spec.fields ? { fields: [...spec.fields] } : {}),
        ...(spec.leaderOverride !== undefined ? { leaderOverride: spec.leaderOverride } : {}),
        ...(spec.mask !== undefined ? { mask: spec.mask } : {}),
        ...(spec.textSizeMm !== undefined ? { textSizeMm: spec.textSizeMm } : {}),
        ...(spec.styleId !== undefined ? { styleId: spec.styleId } : {}),
        ...(elbow !== undefined ? { elbow } : {}),
      },
    });
    return itemId;
  },
  /** A dimension between two points in a view (tied to elements with `refs`); returns its id. */
  dimension(ctx: ScriptContext, spec: DimensionSpec): string {
    const itemId = spec.id ?? ctx.id("dim");
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: spec.view,
      shape: "dimension",
      points: [
        { x: mm(spec.from.x, "Dimension start x"), y: mm(spec.from.y, "Dimension start y") },
        { x: mm(spec.to.x, "Dimension end x"), y: mm(spec.to.y, "Dimension end y") },
      ],
      dim: { kind: spec.kind ?? "aligned", offsetMm: spec.offset ? mm(spec.offset, "Dimension offset") : -8, ...(spec.refs ? { refs: spec.refs } : {}) },
    });
    return itemId;
  },
  /** A new tag style (a drain slope tag with a downhill arrow, a duct size tag); returns its id. */
  tagStyle(ctx: ScriptContext, spec: TagStyleSpec): string {
    const { id, ...style } = spec;
    const styleId = id ?? ctx.id("tag-style");
    ctx.edit({ type: "create_tag_style", styleId, ...style });
    return styleId;
  },
  /** Changes a tag style's look: lines, box, orientation, applies-to, mask, textStyleId or its arrow (`"none"` removes it). */
  setTagStyle(ctx: ScriptContext, styleId: string, changes: TagStyleChanges): void {
    ctx.edit({ type: "update_tag_style", styleId, ...changes });
  },
  /** Creates a model-wide Text Type (font, cap height on paper, bold/italic/uppercase, opaque or transparent background, default roles); returns its id. */
  textStyle(ctx: ScriptContext, spec: TextStyleSpec): string {
    const { id, ...style } = spec;
    const styleId = id ?? ctx.id("text-style");
    ctx.edit({ type: "create_text_style", styleId, ...style });
    return styleId;
  },
  /** Updates a model-wide Text Type (updates every mark, circuit label, tag, dimension or room title inheriting it). */
  setTextStyle(ctx: ScriptContext, styleId: string, changes: TextStyleChanges): void {
    ctx.edit({ type: "update_text_style", styleId, ...changes });
  },
  /** Deletes an unused model-wide Text Type. */
  deleteTextStyle(ctx: ScriptContext, styleId: string): void {
    ctx.edit({ type: "delete_text_style", styleId });
  },
  /** Configures a plan view's circuit & switch-leg display (style, home runs, switch legs/labels, NECA 100 hash marks & placement) while preserving existing wire/home-run routing hints. */
  setCircuitGraphics(ctx: ScriptContext, viewRef: string, settings: CircuitGraphicsSettingsSpec): void {
    const view = onWorking(ctx, "documents.setCircuitGraphics", (m) => viewIn(m, viewRef, "plan view"));
    const cur = (view.props as { readonly circuitGraphics?: Record<string, unknown> } | undefined)?.circuitGraphics ?? {};
    const next: Record<string, unknown> = {
      ...cur,
      ...(settings.style !== undefined ? { style: settings.style } : {}),
      ...(settings.showCircuits !== undefined ? { showCircuits: settings.showCircuits } : {}),
      ...(settings.homeRuns !== undefined ? { homeRuns: settings.homeRuns } : {}),
      ...(settings.switchLegs !== undefined ? { switchLegs: settings.switchLegs } : {}),
      ...(settings.switchLegLabels !== undefined ? { switchLegLabels: settings.switchLegLabels } : {}),
      ...(settings.allCopies !== undefined ? { allCopies: settings.allCopies } : {}),
      ...(settings.hashMarks !== undefined ? { hashMarks: settings.hashMarks } : {}),
      ...(settings.hashMarksOn !== undefined ? { hashMarksOn: settings.hashMarksOn } : {}),
      ...(settings.typLabelsOnce !== undefined ? { typLabelsOnce: settings.typLabelsOnce } : {}),
    };
    ctx.edit({ type: "set_view_properties", viewId: view.id, props: { circuitGraphics: next } as ViewProps });
  },
  /**
   * Pins multi-vertex spline/orthogonal waypoints on one circuit or switch-leg wire span in a plan view.
   * Pass 1 point for a custom arc, 2+ points for a smooth Catmull-Rom spline, or `null` / `[]` to reset to automatic routing.
   */
  setWirePath(
    ctx: ScriptContext,
    viewRef: string,
    hintKey: string,
    fromElementId: string,
    toElementId: string,
    waypoints: readonly { readonly x: Measure; readonly y: Measure }[] | null,
  ): void {
    const view = onWorking(ctx, "documents.setWirePath", (m) => viewIn(m, viewRef, "plan view"));
    const cur = ((view.props as { readonly circuitGraphics?: Record<string, unknown> } | undefined)?.circuitGraphics ?? {}) as Record<string, unknown>;
    const hints = { ...((cur.hints as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    const hint = { ...(hints[hintKey] ?? {}) };
    const spanKey = fromElementId < toElementId ? `${fromElementId}|${toElementId}` : `${toElementId}|${fromElementId}`;
    const bends = { ...((hint.bends as Record<string, unknown> | undefined) ?? {}) };
    delete bends[spanKey];
    const wps = { ...((hint.waypoints as Record<string, unknown> | undefined) ?? {}) };
    if (waypoints && waypoints.length > 0) {
      const mmPts = waypoints.map((pt, i) => ({ x: Math.round(mm(pt.x, `Waypoint ${i + 1} x`)), y: Math.round(mm(pt.y, `Waypoint ${i + 1} y`)) }));
      wps[spanKey] = fromElementId < toElementId ? mmPts : [...mmPts].reverse();
    } else {
      delete wps[spanKey];
    }
    const nextHint: Record<string, unknown> = { ...hint };
    if (Object.keys(bends).length > 0) nextHint.bends = bends;
    else delete nextHint.bends;
    if (Object.keys(wps).length > 0) nextHint.waypoints = wps;
    else delete nextHint.waypoints;
    if (Object.keys(nextHint).length > 0) hints[hintKey] = nextHint;
    else delete hints[hintKey];
    ctx.edit({ type: "set_view_properties", viewId: view.id, props: { circuitGraphics: { ...cur, hints } } as ViewProps });
  },
  /** Flips (or explicitly sets) the automatic wire arc bulge side on one circuit or switch-leg span. */
  flipWireArc(ctx: ScriptContext, viewRef: string, hintKey: string, fromElementId: string, toElementId: string, flipped?: boolean): void {
    const view = onWorking(ctx, "documents.flipWireArc", (m) => viewIn(m, viewRef, "plan view"));
    const cur = ((view.props as { readonly circuitGraphics?: Record<string, unknown> } | undefined)?.circuitGraphics ?? {}) as Record<string, unknown>;
    const hints = { ...((cur.hints as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    const hint = { ...(hints[hintKey] ?? {}) };
    const spanKey = fromElementId < toElementId ? `${fromElementId}|${toElementId}` : `${toElementId}|${fromElementId}`;
    const bends = { ...((hint.bends as Record<string, unknown> | undefined) ?? {}) };
    const wps = { ...((hint.waypoints as Record<string, unknown> | undefined) ?? {}) };
    delete bends[spanKey];
    delete wps[spanKey];
    const flipMap = { ...((hint.flipArc as Record<string, boolean> | undefined) ?? {}) };
    const next = flipped ?? !flipMap[spanKey];
    if (next) flipMap[spanKey] = true;
    else delete flipMap[spanKey];
    const nextHint: Record<string, unknown> = { ...hint };
    if (Object.keys(bends).length > 0) nextHint.bends = bends;
    else delete nextHint.bends;
    if (Object.keys(wps).length > 0) nextHint.waypoints = wps;
    else delete nextHint.waypoints;
    if (Object.keys(flipMap).length > 0) nextHint.flipArc = flipMap;
    else delete nextHint.flipArc;
    if (Object.keys(nextHint).length > 0) hints[hintKey] = nextHint;
    else delete hints[hintKey];
    ctx.edit({ type: "set_view_properties", viewId: view.id, props: { circuitGraphics: { ...cur, hints } } as ViewProps });
  },
  /** Aims, resizes, curves, re-attaches, or repositions a circuit's home run arrow & label (relative to its host device so it auto-follows moves). Pass `null` to reset. */
  setHomeRun(ctx: ScriptContext, viewRef: string, linkId: string, spec: HomeRunSpec | null): void {
    const view = onWorking(ctx, "documents.setHomeRun", (m) => viewIn(m, viewRef, "plan view"));
    const cur = ((view.props as { readonly circuitGraphics?: Record<string, unknown> } | undefined)?.circuitGraphics ?? {}) as Record<string, unknown>;
    const hints = { ...((cur.hints as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    const hint = { ...(hints[linkId] ?? {}) };
    if (spec === null) {
      delete hint.homeRun;
    } else {
      const hr: Record<string, unknown> = {};
      if (spec.member !== undefined) hr.memberId = spec.member;
      if (spec.tipOffset !== undefined) hr.tipOffset = { x: Math.round(mm(spec.tipOffset.x, "Home run tip offset x")), y: Math.round(mm(spec.tipOffset.y, "Home run tip offset y")) };
      if (spec.bendOffset !== undefined) hr.bendOffset = { x: Math.round(mm(spec.bendOffset.x, "Home run bend offset x")), y: Math.round(mm(spec.bendOffset.y, "Home run bend offset y")) };
      if (spec.labelOffset !== undefined) hr.labelOffset = { x: Math.round(mm(spec.labelOffset.x, "Home run label offset x")), y: Math.round(mm(spec.labelOffset.y, "Home run label offset y")) };
      if (Object.keys(hr).length > 0) hint.homeRun = hr;
      else delete hint.homeRun;
    }
    if (Object.keys(hint).length > 0) hints[linkId] = hint;
    else delete hints[linkId];
    ctx.edit({ type: "set_view_properties", viewId: view.id, props: { circuitGraphics: { ...cur, hints } } as ViewProps });
  },
  /** Repositions (or resets with `null`) a switch-leg designation ("a", "b") relative to its member device in typed length units. */
  setSwitchLegLabelOffset(
    ctx: ScriptContext,
    viewRef: string,
    hintKey: string,
    memberId: string,
    offset: { readonly x: Measure; readonly y: Measure } | null,
  ): void {
    const view = onWorking(ctx, "documents.setSwitchLegLabelOffset", (m) => viewIn(m, viewRef, "plan view"));
    const cur = ((view.props as { readonly circuitGraphics?: Record<string, unknown> } | undefined)?.circuitGraphics ?? {}) as Record<string, unknown>;
    const hints = { ...((cur.hints as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    const hint = { ...(hints[hintKey] ?? {}) };
    const offsets = { ...((hint.memberLabelOffsets as Record<string, unknown> | undefined) ?? {}) };
    if (offset === null) {
      delete offsets[memberId];
    } else {
      offsets[memberId] = { x: Math.round(mm(offset.x, "Switch-leg label offset x")), y: Math.round(mm(offset.y, "Switch-leg label offset y")) };
    }
    if (Object.keys(offsets).length > 0) hint.memberLabelOffsets = offsets;
    else delete hint.memberLabelOffsets;
    if (Object.keys(hint).length > 0) hints[hintKey] = hint;
    else delete hints[hintKey];
    ctx.edit({ type: "set_view_properties", viewId: view.id, props: { circuitGraphics: { ...cur, hints } } as ViewProps });
  },
  /** Combines (or splits with `null`) branch circuits on the same panel into a shared-neutral Multi-Wire Branch Circuit (MWBC, NEC 210.4) multi-arrowhead home run. */
  setMwbcGroup(ctx: ScriptContext, viewRef: string, linkIds: readonly string[], groupName: string | null): void {
    const view = onWorking(ctx, "documents.setMwbcGroup", (m) => viewIn(m, viewRef, "plan view"));
    const cur = ((view.props as { readonly circuitGraphics?: Record<string, unknown> } | undefined)?.circuitGraphics ?? {}) as Record<string, unknown>;
    const hints = { ...((cur.hints as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    const trimmed = groupName?.trim() || undefined;
    for (const id of linkIds) {
      const hint = { ...(hints[id] ?? {}) };
      if (trimmed) hint.mwbcGroup = trimmed;
      else delete hint.mwbcGroup;
      if (Object.keys(hint).length > 0) hints[id] = hint;
      else delete hints[id];
    }
    ctx.edit({ type: "set_view_properties", viewId: view.id, props: { circuitGraphics: { ...cur, hints } } as ViewProps });
  },
  /** Moves an existing tag in a plan view to `at` (and optionally toggles its leader). */
  moveTag(ctx: ScriptContext, tagId: string, at: { readonly x: Measure; readonly y: Measure }, opts?: { readonly leader?: boolean }): void {
    const existing = onWorking(ctx, "documents.moveTag", (m) => {
      const el = m.elements[tagId];
      if (!el || el.kind !== "drawing_item" || el.shape !== "tag") throw new ScriptRunError(`No tag "${tagId}" on this model.`);
      return el;
    });
    const nx = mm(at.x, "Tag x");
    const ny = mm(at.y, "Tag y");
    const oldHead = existing.points[0];
    const translatedElbow =
      existing.tag?.elbow && existing.tag.elbow !== "auto" && oldHead
        ? {
            x: Math.round((existing.tag.elbow.x + (nx - oldHead.x)) * 1000) / 1000,
            y: Math.round((existing.tag.elbow.y + (ny - oldHead.y)) * 1000) / 1000,
          }
        : existing.tag?.elbow;
    ctx.edit({
      type: "update_drawing_item",
      itemId: tagId,
      points: [{ x: nx, y: ny }],
      ...(opts?.leader !== undefined && existing.tag
        ? { tag: { ...existing.tag, leader: opts.leader, ...(translatedElbow ? { elbow: translatedElbow } : {}) } }
        : {}),
    });
  },
  /**
   * Every text label rendered on a plan view (paper mm, including rotated tags
   * and laid-out text blocks) plus any colliding pairs, so a script can verify
   * legibility and move overlapping tags.
   */
  planLabels(ctx: ScriptContext, viewRef: string): {
    readonly viewId: string;
    readonly scale: number;
    readonly labels: readonly {
      readonly text: string;
      readonly at: { readonly xMm: number; readonly yMm: number };
      readonly sizeMm: number;
      readonly anchor: "start" | "middle" | "end";
      readonly box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
    }[];
    readonly overlaps: readonly { readonly a: string; readonly b: string; readonly overlapAreaMm2: number }[];
  } {
    return onWorking(ctx, "documents.planLabels", (m) => {
      const v = viewIn(m, viewRef, "planLabels");
      const { scene, frame } = buildViewScene(m, v.id);
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const rotatedBounds = (
        origin: { readonly x: number; readonly y: number },
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        deg: number,
      ) => {
        if (!deg) return { minX: r2(x0), minY: r2(y0), maxX: r2(x1), maxY: r2(y1) };
        const rad = (deg * Math.PI) / 180;
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const corners = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ] as const;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [cx, cy] of corners) {
          const dx = cx - origin.x;
          const dy = cy - origin.y;
          const rx = origin.x + dx * c - dy * s;
          const ry = origin.y + dx * s + dy * c;
          if (rx < minX) minX = rx;
          if (ry < minY) minY = ry;
          if (rx > maxX) maxX = rx;
          if (ry > maxY) maxY = ry;
        }
        return { minX: r2(minX), minY: r2(minY), maxX: r2(maxX), maxY: r2(maxY) };
      };
      const labels: {
        readonly text: string;
        readonly at: { readonly xMm: number; readonly yMm: number };
        readonly sizeMm: number;
        readonly anchor: "start" | "middle" | "end";
        readonly box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
      }[] = scene.primitives
        .filter((p): p is Extract<typeof p, { kind: "text" }> => p.kind === "text")
        .map((p) => {
          const w = Math.max(p.size * 0.65, p.text.length * p.size * 0.6);
          const x0 = p.anchor === "start" ? p.at.x : p.anchor === "end" ? p.at.x - w : p.at.x - w / 2;
          const y0 = p.at.y - p.size;
          const x1 = x0 + w;
          const y1 = p.at.y + p.size * 0.25;
          return {
            text: p.text,
            at: { xMm: r2(p.at.x), yMm: r2(p.at.y) },
            sizeMm: p.size,
            anchor: p.anchor,
            box: rotatedBounds(p.at, x0, y0, x1, y1, p.rotate ?? 0),
          };
        });
      for (const block of scene.textBlocks ?? []) {
        for (const line of block.layout.lines) {
          const text = line.pieces.map((pc) => pc.text).join("").trim();
          if (!text) continue;
          const x0 = block.origin.x + line.left;
          const y0 = block.origin.y + line.top;
          const x1 = block.origin.x + line.right;
          const y1 = block.origin.y + line.top + line.height;
          labels.push({
            text,
            at: { xMm: r2(x0), yMm: r2(block.origin.y + line.baseline) },
            sizeMm: r2(line.height),
            anchor: "start",
            box: rotatedBounds(block.origin, x0, y0, x1, y1, block.rotation),
          });
        }
      }
      const overlaps: { readonly a: string; readonly b: string; readonly overlapAreaMm2: number }[] = [];
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i]!;
          const b = labels[j]!;
          const ox = Math.min(a.box.maxX, b.box.maxX) - Math.max(a.box.minX, b.box.minX);
          const oy = Math.min(a.box.maxY, b.box.maxY) - Math.max(a.box.minY, b.box.minY);
          if (ox > 0.1 && oy > 0.1) {
            overlaps.push({ a: a.text, b: b.text, overlapAreaMm2: r2(ox * oy) });
          }
        }
      }
      return { viewId: v.id, scale: frame.scale, labels, overlaps };
    });
  },
  /** Gives elements a keynote (its key, "P1"): a keynote tag on a view prints it and the sheet's keynote list words it. */
  keynote(ctx: ScriptContext, elementIds: readonly string[], key: string): void {
    ctx.edit({ type: "set_element_values", elementIds: [...elementIds], values: { [KEYNOTE_FIELD]: key } });
  },
};
