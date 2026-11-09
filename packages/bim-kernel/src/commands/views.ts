import { pushTo } from "../collections";
import { z } from "zod";
import { convert } from "@permitzip/bim-units";
import { canonicalJson } from "../canonical";
import { sheetFigureSchema } from "../annotation/figures";
import { recomputeDerivedAfter } from "../derived";
import { peerReads } from "../elements/feature";
import { parseLinkedElementKey } from "../reference-geometry/index-geometry";
import { ANNOTATION_LINKED_ANCHORS_FEATURE } from "../reference-geometry/linked-anchors";
import { TAGS_MASK_LEADER_FEATURE } from "../organization/model";
import { DIAGRAM_FAULT_CURRENT_FEATURE } from "../diagrams/definition";
import { viewGraphicsHintsRefusal, viewGraphicsRowByKey, type ViewGraphicsHints } from "../layout/view-graphics-point";
import {
  CUT_PATTERNS,
  DEFAULT_CUT_HEIGHT_MM,
  DEFAULT_DETAIL_SCALE,
  LINE_WEIGHTS,
  VISUAL_STYLES,
  VIEW_PROJECTIONS,
  PLAN_ORIENTATIONS,
  DEFAULT_PLAN_SCALE,
  sheetPaperSize,
  SCHEDULE_CATEGORIES,
  SCHEDULE_FILTER_OPS,
  TITLE_BLOCK_TYPES,
  VIEW_CATEGORIES,
  type DrawingItem,
  type SheetProps,
  type ViewProps,
  type Viewport,
} from "../documents";
import { titleBlockRowSchema } from "../drawing/title-block-definition";
import { cropForWindow, effectiveCrop, fitCrop, rectCenter, sectionDefaultCrop, viewCrop, viewWindow, windowPaperSize, type Rect } from "../crop";
import { distance, round, roundVec } from "../geometry";
import { KernelError, TrackedReader, isKind } from "../model";
import { markKnownIssues } from "../network";
import { disciplineSchema, isStoredDiscipline, partitionMembers, sharePartitionIndex } from "../partition";
import { checkStoredDisciplines } from "../elements/discipline-gate";
import { draftElements } from "../store";
import { canonicalViewLevel } from "../levels";
import { fieldBlockSpecSchema } from "../blocks/schema";
import { checkEdit } from "../validate";
import {
  asElementId,
  DEFAULT_PARTITION,
  type BimElement,
  type Discipline,
  type ElementId,
  type ModelState,
  type Partition,
  type Sheet,
  type Vec2,
  type ViewElement,
} from "../types";
import type { AuthoredWrite, ExecuteResult } from "../commands";
import { siteOf } from "../site";
import { viewRotationDeg } from "../drawing/north";
import { normalizeWorkingAngleDeg } from "../work-frame";
import { noteLabel, richTextNoteSchema } from "../annotation/rich-text";
import { executeTextNoteCommand, isTextNoteCommand, textNoteCommandSchemas } from "../annotation/text-note-commands";
import { DOCUMENT_FIELDS, documentFieldValue, propValue } from "../document-fields";
import { dimensionPointRange, dimSpecSchema, tagSpecNeedsMaskLeaderPeers, tagSpecSchema, tagStyleCategoryOf, type DimSpec, type TagSpec } from "../annotation/annotations";
import { DRAFTING_CATEGORIES, battSpecSchema, componentPlacementSchema, detailComponent, detailPointRange, lineStyleSchema, regionFillSchema } from "../annotation/detailing";
import { carryOrganization, organizationOf, viewOrganizationProblem } from "../organization/model";
import { referenceDisplaySchema } from "../reference-display";
import { boxFollowingPlanCrop, view3dPropsProblem, view3dPropsShape, withDefault3d, withoutWorking } from "../view3d";
import { executeView3dCommand, isView3dCommand, view3dCommandSchemas } from "./view3d";
import { formScheduleSchema } from "../schedules/forms/types";
import { UNIT_CODES, type UnitCode } from "../registry/units";
import { diagramDefinitionSchema } from "../diagrams/definition";
import { SYSTEM_LINE_PATTERNS } from "../routing/system-graphics";
import { categoryOverridesWritable } from "../categories/feature";
import { isRegistryIdShape } from "../ids";
import { diagramItemsOf } from "../diagrams/evaluate";
import { diagramKindStoreRefusal } from "../diagrams/kinds";

/**
 * Views and sheets commands: create and change plan, ceiling, section, 3D and
 * drawing-only detail views; create sheets; place views on sheets as
 * viewports; and draw notes, lines, rectangles, revision clouds and detail
 * linework. Same rules as every other command: validated against the head,
 * idempotent by request key, expected revision, attributed, and undoable with
 * `restore_document_elements` (which refuses if someone changed the element since).
 *
 * Removal is a `deleted` flag, so undo can bring a view back with its id and
 * everything that pointed at it.
 */

/** Zone every view, sheet and sheet item lives in, so an area load can include or skip documents. */
export const DOCUMENT_ZONE = "documents";
/** Level for documents not tied to a level (sheets, 3D and detail views). */
export const PROJECT_DOCUMENT_LEVEL = "project";
/** Shortest section cut, and the smallest viewport frame. */
const MIN_SECTION_MM = 300;
const MIN_VIEWPORT_PAPER_MM = 10;

const id = z.string().min(1).max(200);
const vec2 = z.object({ x: z.number().finite(), y: z.number().finite() });
const name = z.string().trim().min(1).max(120);
const scale = z.number().positive().max(10000);

const sectionSchema = z.object({
  start: vec2,
  end: vec2,
  direction: z.union([z.literal(1), z.literal(-1)]),
  depthMm: z.number().positive().max(300000),
});


const scheduleField = z.string().trim().min(1).max(80);
const scheduleSchema = z
  .object({
    category: z.enum(SCHEDULE_CATEGORIES),
    title: z.string().trim().min(1).max(120).optional(),
    columns: z
      .array(z.object({ field: scheduleField, heading: z.string().trim().min(1).max(60).optional(), widthMm: z.number().min(8).max(200).optional() }).strict())
      .min(1)
      .max(20)
      .readonly(),
    sort: z.array(z.object({ field: scheduleField, descending: z.boolean().optional() }).strict()).max(4).readonly().optional(),
    filters: z.array(z.object({ field: scheduleField, op: z.enum(SCHEDULE_FILTER_OPS), value: z.string().max(120) }).strict()).max(8).readonly().optional(),
    level: z.string().min(1).max(40).optional(),
    itemize: z.boolean().optional(),
    textSizeMm: z.number().min(1.5).max(6).optional(),
    emptyText: z.string().trim().max(60).optional(),
  })
  .strict();

/** A v2 schedule (`ScheduleDefinitionV2`) as a command carries it: the shape only. What its paths and formulas mean is the schedule engine's to check when it opens. */
const schedulePath = z.string().trim().min(1).max(200);
const scheduleFormula = z.string().trim().min(1).max(4000);
const scheduleColumnBase = {
  id: z.string().trim().min(1).max(80),
  heading: z.string().trim().min(1).max(60).optional(),
  // Checked when parsed, not when this module loads: registry/units sits in an import cycle with this file in the app bundle.
  unit: z.custom<UnitCode>((v) => typeof v === "string" && (UNIT_CODES as readonly string[]).includes(v), { message: "That is not a unit MutinyBIM knows (use a code such as cfm, MBH, ft)" }).optional(),
  precision: z.discriminatedUnion("kind", [z.object({ kind: z.literal("decimals"), digits: z.number().int().min(0).max(6) }).strict(), z.object({ kind: z.literal("fraction"), denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32), z.literal(64)]) }).strict()]).optional(),
  total: z.boolean().optional(),
  hideWhenEmpty: z.boolean().optional(),
  width: z.number().finite().min(20).max(2000).optional(),
  widthMm: z.number().min(8).max(200).optional(),
  highlights: z.array(z.object({ when: scheduleFormula, tone: z.enum(["warning", "danger"]), reason: z.string().trim().min(1).max(200) }).strict()).max(8).readonly().optional(),
};
export const scheduleV2Schema = z
  .object({
    name: z.string().trim().min(1).max(120),
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("classes"),
          classes: z.array(z.string().trim().min(1).max(80)).min(1).max(50).readonly(),
          includeSubclasses: z.boolean(),
          scope: z
            .object({
              levels: z.array(z.string().trim().min(1).max(40)).max(200).readonly().optional(),
              systems: z.array(z.string().trim().min(1).max(80)).max(200).readonly().optional(),
              zones: z.array(z.string().trim().min(1).max(80)).max(200).readonly().optional(),
              rooms: z.array(z.string().trim().min(1).max(80)).max(500).readonly().optional(),
              phase: z.string().trim().min(1).max(80).optional(),
              links: z.boolean().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z.object({ kind: z.literal("related"), from: id, relationship: z.string().trim().min(1).max(80), depth: z.number().int().min(1).max(8).optional() }).strict(),
      z.object({ kind: z.literal("catalog"), catalog: z.string().trim().min(1).max(80) }).strict(),
    ]),
    columns: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ ...scheduleColumnBase, kind: z.literal("field"), path: schedulePath }).strict(),
          z.object({ ...scheduleColumnBase, kind: z.literal("parameter"), path: schedulePath }).strict(),
          z.object({ ...scheduleColumnBase, kind: z.literal("formula"), expression: scheduleFormula, calculation: z.string().trim().min(1).max(120).optional() }).strict(),
          z.object({ ...scheduleColumnBase, kind: z.literal("aggregate"), fn: z.enum(["sum", "count", "min", "max", "avg", "list"]), relationship: z.string().trim().min(1).max(80), path: schedulePath.optional() }).strict(),
          z.object({ ...scheduleColumnBase, kind: z.literal("expand"), relationship: z.string().trim().min(1).max(80), columns: z.array(schedulePath).min(1).max(20).readonly(), paper: z.enum(["nested", "summary", "hidden"]) }).strict(),
        ]),
      )
      .min(1)
      .max(60)
      .readonly(),
    filters: z.array(z.object({ path: schedulePath, op: z.enum(["equals", "not_equals", "contains", "greater_than", "less_than", "present", "absent"]), value: z.string().max(120).optional() }).strict()).max(16).readonly(),
    sort: z.array(z.object({ path: schedulePath, direction: z.enum(["asc", "desc"]) }).strict()).max(8).readonly(),
    groups: z.array(z.object({ path: schedulePath, header: z.boolean(), footer: z.boolean(), totals: z.boolean() }).strict()).max(4).readonly(),
    grandTotals: z.boolean(),
    itemize: z.boolean(),
    presentation: z.discriminatedUnion("kind", [z.object({ kind: z.literal("list") }).strict(), z.object({ kind: z.literal("form"), template: z.string().trim().min(1).max(80), form: formScheduleSchema.optional() }).strict()]),
    display: z.object({ profile: z.string().trim().min(1).max(80).optional(), textSizeMm: z.number().min(1.5).max(6), emptyText: z.string().trim().max(60) }).strict(),
    pins: z.array(z.object({ id: z.string().min(1).max(120), type: z.string().min(1).max(40).optional(), revision: z.number().int().min(1), contentHash: z.string().min(1).max(100), body: z.unknown() }).strict()).max(100).readonly().optional(),
  })
  .strict();

const calloutSpecSchema = z.object({ viewId: id, label: z.string().trim().min(1).max(12).optional() }).strict();

const revisionsSchema = z
  .array(z.object({ number: z.string().trim().min(1).max(10), date: z.string().trim().min(1).max(20), description: z.string().trim().min(1).max(80) }).strict())
  .max(20)
  .readonly();

/**
 * A category id: a view category, a class (`mep.electrical_device`, a pack's
 * `fp.sprinkler_head`), `service:<id>`, `drafting:<id>`. Any registry id is
 * kept, known to this release or not, so a view saved by a newer peer loses
 * nothing here (round 5b A2/E3).
 */
const categoryIdSchema = z.string().refine(isRegistryIdShape, "a category id such as electrical_devices, mep.lighting_fixture or service:grease_waste");
const categoryOverrideSchema = z
  .object({
    visible: z.boolean(),
    halftone: z.boolean(),
    lineWeights: z.object({ cut: z.enum(LINE_WEIGHTS), projection: z.enum(LINE_WEIGHTS) }).partial().strict(),
    pattern: z.enum(SYSTEM_LINE_PATTERNS),
    colour: z.string().regex(/^#[0-9a-f]{6}$/i, "a colour as #rrggbb"),
    planSymbol: z.boolean(),
    maskBeneath: z.boolean(),
    transparency: z.number().finite().min(0).max(1),
  })
  .partial()
  .strict();
/** At most this many categories carry overrides in one view (the registry lists a few hundred). */
const MAX_CATEGORY_OVERRIDES = 500;

const viewPropsPatchObject = z
  .object({
    level: z.string().min(1).max(40),
    levelElevationMm: z.number().finite().min(-100000).max(1000000),
    scale,
    cutHeightMm: z.number().finite().min(0).max(30000),
    viewDepthMm: z.number().finite().min(0).max(30000),
    /** null: no lower limit again. */
    viewBottomMm: z.number().finite().min(-30000).max(30000).nullable(),
    /** null: no upper limit again. */
    viewTopMm: z.number().finite().min(0).max(60000).nullable(),
    discipline: disciplineSchema.nullable(),
    hiddenCategories: z.array(z.enum(VIEW_CATEGORIES)).max(VIEW_CATEGORIES.length),
    hiddenDraftingCategories: z.array(z.enum(DRAFTING_CATEGORIES)).max(DRAFTING_CATEGORIES.length),
    references: z.record(id, referenceDisplaySchema),
    linkedHiddenLines: z.boolean(),
    linkedMinObjectMm: z.number().finite().min(0).max(3000),
    detailLevel: z.enum(["coarse", "medium", "fine"]),
    visualStyle: z.enum(VISUAL_STYLES),
    showHiddenLines: z.boolean(),
    hiddenLineCategories: z.array(z.enum(VIEW_CATEGORIES)).max(VIEW_CATEGORIES.length),
    lineWeights: z.partialRecord(z.enum(VIEW_CATEGORIES), z.object({ cut: z.enum(LINE_WEIGHTS), projection: z.enum(LINE_WEIGHTS) }).partial().strict()),
    /** Visibility/Graphics per category. Replaces the whole setting; {} clears it. */
    categoryOverrides: z.record(categoryIdSchema, categoryOverrideSchema).refine((o) => Object.keys(o).length <= MAX_CATEGORY_OVERRIDES, `A view can set at most ${MAX_CATEGORY_OVERRIDES} categories.`),
    cutPattern: z.enum(CUT_PATTERNS),
    section: sectionSchema,
    cropView: z.boolean(),
    showCropBox: z.boolean(),
    annotationCrop: z.boolean(),
    annotationCropOffsetMm: z.number().finite().min(0).max(100),
    phaseId: id,
    phaseFilterId: id,
    groupDisplay: z.record(id, z.enum(["show", "halftone", "hide"])),
    orientation: z.enum(PLAN_ORIENTATIONS),
    /** This view's own working angle; null goes back to the model's. */
    workingAngleDeg: z.number().finite().min(-3600).max(3600).nullable(),
    projection: z.enum(VIEW_PROJECTIONS),
    schedule: scheduleSchema,
    formSchedule: formScheduleSchema,
    /** A v2 schedule: classes, typed columns (fields, formulas, aggregates, expand), groups, list or form. */
    scheduleV2: scheduleV2Schema,
    diagram: diagramDefinitionSchema,
  })
  .partial()
  // An add-on's record under its view graphics row's `hintsKey` passes through to the row's own schema; any other key is refused by name.
  .catchall(z.unknown());

const KERNEL_VIEW_PROP_KEYS: ReadonlySet<string> = new Set(Object.keys(viewPropsPatchObject.shape));

/** What a view setting command takes: the kernel's fields, and each add-on record read by its row's schema where commands are read. */
const viewPropsPatch = viewPropsPatchObject.superRefine((patch, ctx) => {
  for (const [key, value] of Object.entries(patch)) {
    if (KERNEL_VIEW_PROP_KEYS.has(key) || value === undefined) continue;
    const row = viewGraphicsRowByKey(key);
    if (!row) {
      ctx.addIssue({ code: "custom", message: `Unrecognized key: "${key}" (no add-on loaded here keeps a view setting by that name)`, path: [key] });
      continue;
    }
    const parsed = row.hintsSchema?.safeParse(value);
    for (const issue of parsed && !parsed.success ? parsed.error.issues : []) ctx.addIssue({ code: "custom", message: issue.message, path: [key, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))] });
  }
});

/** A set_view_properties change: present fields replace; `discipline: null` clears it. Add-ons' records (`ViewGraphicsHints`) replace whole. */
export type ViewPropsPatch = z.infer<typeof viewPropsPatch> & ViewGraphicsHints;

/** Every key the kernel doesn't name must be a view graphics row's record in force, saved as that row allows on this view. */
function checkViewGraphicsPatch(viewType: ViewElement["viewType"], patch: Readonly<Record<string, unknown>> | undefined, viewId: string): void {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (KERNEL_VIEW_PROP_KEYS.has(key) || value === undefined) continue;
    const refusal = viewGraphicsHintsRefusal(key, value, viewType);
    if (refusal !== null) fail(refusal, [viewId]);
  }
}

const crop = z.object({ min: vec2, max: vec2 });

const fields = z.record(z.string().min(1).max(40), z.string().max(200));

const drawingShape = z.enum(["text", "line", "rect", "cloud", "dimension", "tag", "arc", "circle", "polyline", "spline", "region", "component", "repeat", "batt", "callout", "figure", "field_block"]);

/** What `restore_document_elements` may write back: the four document kinds, as committed. */
// Restore puts back a record as stored, so it reads any stored discipline; the partition write gate refuses a new one the server can't store.
const partitionSchema = z.object({ level: z.string().min(1).max(40), zone: z.string().min(1).max(40), discipline: z.custom<Discipline>(isStoredDiscipline, "Not a discipline") });
const base = { id, version: z.number().int().min(0), authoredRev: z.record(z.string(), z.number()), partition: partitionSchema.optional(), deleted: z.boolean().optional() };
const documentRecord = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("view"),
    name,
    viewType: z.enum(["floor_plan", "ceiling_plan", "section", "three_d", "schedule", "detail"]),
    cropMin: vec2,
    cropMax: vec2,
    props: viewPropsPatchObject.extend({ discipline: disciplineSchema, workingAngleDeg: z.number().finite().min(-45).max(45), viewBottomMm: z.number().finite().min(-30000).max(30000), viewTopMm: z.number().finite().min(0).max(60000), ...view3dPropsShape }).partial().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("sheet"),
    number: z.string().min(1).max(40),
    title: z.string().min(1).max(200),
    viewIds: z.array(id).max(500),
    props: z.object({ titleBlock: z.enum(TITLE_BLOCK_TYPES).optional(), titleBlockRow: titleBlockRowSchema.optional(), fields: fields.optional(), revisions: revisionsSchema.optional() }).optional(),
  }),
  z.object({ ...base, kind: z.literal("viewport"), sheetId: id, viewId: id, center: vec2, size: vec2, scale, northArrow: z.boolean().optional() }),
  z.object({
    ...base,
    kind: z.literal("drawing_item"),
    ownerId: id,
    shape: drawingShape,
    points: z.array(vec2).min(1).max(500),
    text: z.string().max(500).optional(),
    textSize: z.number().positive().max(50).optional(),
    note: richTextNoteSchema.optional(),
    dim: dimSpecSchema.optional(),
    tag: tagSpecSchema.optional(),
    callout: calloutSpecSchema.optional(),
    lineStyle: lineStyleSchema.optional(),
    closed: z.boolean().optional(),
    ccw: z.boolean().optional(),
    fill: regionFillSchema.optional(),
    component: componentPlacementSchema.optional(),
    batt: battSpecSchema.optional(),
    category: z.enum(DRAFTING_CATEGORIES).optional(),
    detailGroup: z.string().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
    figure: sheetFigureSchema.optional(),
    block: fieldBlockSpecSchema.optional(),
  }),
]);
type DocumentRecord = z.infer<typeof documentRecord>;

/** A view, sheet, viewport or drawing item as `restore_document_elements` takes it back (null for any other kind). */
export function toDocumentRecord(el: BimElement): DocumentRecord | null {
  if (el.kind !== "view" && el.kind !== "sheet" && el.kind !== "viewport" && el.kind !== "drawing_item") return null;
  const parsed = documentRecord.safeParse(JSON.parse(canonicalJson(el)));
  return parsed.success ? parsed.data : null;
}

export const viewCommandSchemas = [
  z.object({
    type: z.literal("create_view"),
    viewId: id,
    name,
    viewType: z.enum(["floor_plan", "ceiling_plan", "section", "three_d", "detail", "schedule"]),
    crop: crop.optional(),
    props: viewPropsPatch.optional(),
  }),
  z.object({ type: z.literal("rename_view"), viewId: id, name }),
  z.object({ type: z.literal("duplicate_view"), viewId: id, newViewId: id, name: name.optional() }),
  z.object({
    type: z.literal("delete_view"),
    viewId: id,
    /** refuse (default): a view on a sheet is not removed; remove_from_sheet: its viewport goes too. */
    placed: z.enum(["refuse", "remove_from_sheet"]).optional(),
  }),
  z.object({ type: z.literal("set_view_properties"), viewId: id, props: viewPropsPatch, crop: crop.optional(), keepViewportCenter: z.boolean().optional() }),
  z.object({
    type: z.literal("set_view_crop"),
    viewId: id,
    /** The crop box in the view's own frame: plan mm; sections along-cut mm by elevation mm. */
    crop: crop.optional(),
    /** Set the crop box to fit the view's content (model on its level, or a detail view's drawing). */
    fit: z.literal(true).optional(),
    cropView: z.boolean().optional(),
    showCropBox: z.boolean().optional(),
    annotationCrop: z.boolean().optional(),
    annotationCropOffsetMm: z.number().finite().min(0).max(100).optional(),
    /** Sections only: how far beyond the cut line the section sees, mm. */
    farClipMm: z.number().positive().max(300000).optional(),
    /** Placed on a sheet: keep the viewport's centre where it is instead of moving it so the model stays put on paper. */
    keepViewportCenter: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("create_sheet"),
    sheetId: id,
    number: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(200),
    titleBlock: z.enum(TITLE_BLOCK_TYPES).optional(),
    /** A library title block (a firm's), copied onto the sheet: it sets the paper and draws the strip. */
    titleBlockRow: titleBlockRowSchema.optional(),
    fields: fields.optional(),
    revisions: revisionsSchema.optional(),
  }),
  z.object({
    type: z.literal("set_sheet_properties"),
    sheetId: id,
    number: z.string().trim().min(1).max(40).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    titleBlock: z.enum(TITLE_BLOCK_TYPES).optional(),
    /** A library title block copied onto the sheet; null goes back to the built-in `titleBlock`. */
    titleBlockRow: titleBlockRowSchema.nullable().optional(),
    fields: fields.optional(),
    /** The whole revision table, oldest first (replaces it). */
    revisions: revisionsSchema.optional(),
  }),
  z.object({ type: z.literal("delete_sheet"), sheetId: id }),
  z.object({ type: z.literal("place_viewport"), viewportId: id, sheetId: id, viewId: id, center: vec2, scale: scale.optional() }),
  z.object({ type: z.literal("move_viewport"), viewportId: id, center: vec2 }),
  /** Drag the frame's edges: the view's crop box follows at the viewport's scale. `center` moves the frame too (one edge dragged). */
  z.object({ type: z.literal("resize_viewport"), viewportId: id, size: vec2, center: vec2.optional() }),
  z.object({ type: z.literal("set_viewport_scale"), viewportId: id, scale }),
  /** Show or hide the viewport's north arrow (it turns itself to true north). */
  z.object({ type: z.literal("set_viewport_north_arrow"), viewportId: id, show: z.boolean() }),
  z.object({ type: z.literal("remove_viewport"), viewportId: id }),
  z.object({
    type: z.literal("add_drawing_item"),
    itemId: id,
    ownerId: id,
    shape: drawingShape,
    points: z.array(vec2).min(1).max(500),
    text: z.string().trim().min(1).max(500).optional(),
    textSize: z.number().positive().max(50).optional(),
    /** Dimensions: kind, the references each point follows, offset, overrides, style. */
    dim: dimSpecSchema.optional(),
    /** Tags: the element, what it says, leader. */
    tag: tagSpecSchema.optional(),
    /** Callouts (points: box corner, opposite corner, head): the view it refers to, and an optional label for the head. */
    callout: calloutSpecSchema.optional(),
    /** Detailing: line weight and pattern, closed / direction, fill, component, batt, category, detail group. */
    lineStyle: lineStyleSchema.optional(),
    closed: z.boolean().optional(),
    ccw: z.boolean().optional(),
    fill: regionFillSchema.optional(),
    component: componentPlacementSchema.optional(),
    batt: battSpecSchema.optional(),
    category: z.enum(DRAFTING_CATEGORIES).optional(),
    detailGroup: z.string().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
    /** Figures (shape "figure", sheets only): a live chart or a picture in the frame the two points span. */
    figure: sheetFigureSchema.optional(),
  }),
  z.object({
    type: z.literal("update_drawing_item"),
    itemId: id,
    points: z.array(vec2).min(1).max(500).optional(),
    text: z.string().trim().min(1).max(500).optional(),
    /** Replace the dimension's spec (kind, references, offset, overrides, style). */
    dim: dimSpecSchema.optional(),
    /** Replace the tag's spec (template, fields, leader). */
    tag: tagSpecSchema.optional(),
    /** Replace the callout's view or label. */
    callout: calloutSpecSchema.optional(),
    /** Detailing properties: given fields replace; `detailGroup: null` takes it out of its group. */
    lineStyle: lineStyleSchema.optional(),
    closed: z.boolean().optional(),
    ccw: z.boolean().optional(),
    fill: regionFillSchema.optional(),
    component: componentPlacementSchema.optional(),
    batt: battSpecSchema.optional(),
    category: z.enum(DRAFTING_CATEGORIES).optional(),
    detailGroup: z.string().min(1).max(120).nullable().optional(),
    /** Pin (Move, trims and Delete refuse it) or unpin. */
    pinned: z.boolean().optional(),
    /** Replace a figure's chart or picture. */
    figure: sheetFigureSchema.optional(),
  }),
  z.object({
    type: z.literal("copy_drawing_items"),
    /** Items to copy (from one owner). Dimensions among them that follow other copied items follow the copies. */
    itemIds: z.array(id).min(1).max(500),
    /** Where the copies go: the same or another sheet or view (detail, plan, section). */
    toOwnerId: id,
    /** Added to every point, in the target's coordinates. */
    offset: vec2.optional(),
    /** New ids are `${idPrefix}-${old id}`. */
    idPrefix: z.string().min(1).max(80),
  }),
  z.object({ type: z.literal("delete_drawing_item"), itemId: id }),
  z.object({
    type: z.literal("restore_document_elements"),
    /** Undo: put each element back as it was before an edit, if nobody changed it since. */
    items: z
      .array(z.object({ elementId: id, before: documentRecord.nullable(), expectedVersion: z.number().int().min(0) }))
      .min(1)
      .max(500),
  }),
  ...textNoteCommandSchemas,
  ...view3dCommandSchemas,
] as const;

export type ViewCommand = z.infer<(typeof viewCommandSchemas)[number]>;

const VIEW_COMMAND_TYPES: ReadonlySet<string> = new Set(viewCommandSchemas.map((s) => s.shape.type.value));

export function isViewCommand(command: { readonly type: string }): command is ViewCommand {
  return VIEW_COMMAND_TYPES.has(command.type);
}

// ── Document index ───────────────────────────────────────────────────────────

/** Live (not deleted) views, sheets and what is placed on each, for one element record. */
export interface DocumentIndex {
  readonly views: readonly ViewElement[];
  readonly sheets: readonly Sheet[];
  readonly viewportsBySheet: ReadonlyMap<string, readonly Viewport[]>;
  readonly viewportByView: ReadonlyMap<string, Viewport>;
  readonly itemsByOwner: ReadonlyMap<string, readonly DrawingItem[]>;
}

const indexes = new WeakMap<object, DocumentIndex>();

/**
 * Views, sheets and their content live in the documents zone of each level, so
 * the index reads only those partitions (through the shared partition index),
 * never the whole model.
 */
export function documentIndex(model: Pick<ModelState, "elements" | "connections">): DocumentIndex {
  const cached = indexes.get(model.elements);
  if (cached) return cached;
  const views: ViewElement[] = [];
  const sheets: Sheet[] = [];
  const viewportsBySheet = new Map<string, Viewport[]>();
  const viewportByView = new Map<string, Viewport>();
  const itemsByOwner = new Map<string, DrawingItem[]>();
  for (const el of partitionMembers(model, (p) => p.zone === DOCUMENT_ZONE)) {
    switch (el.kind) {
      case "view":
        if (!el.deleted) views.push(el);
        break;
      case "sheet":
        if (!el.deleted) sheets.push(el);
        break;
      case "viewport":
        if (el.deleted) break;
        pushTo(viewportsBySheet, el.sheetId, el);
        viewportByView.set(el.viewId, el);
        break;
      case "drawing_item":
        if (!el.deleted) pushTo(itemsByOwner, el.ownerId, el);
        break;
      default:
        break;
    }
  }
  const built: DocumentIndex = { views, sheets, viewportsBySheet, viewportByView, itemsByOwner };
  indexes.set(model.elements, built);
  return built;
}

const PLAN_TYPES: ReadonlySet<ViewElement["viewType"]> = new Set(["floor_plan", "ceiling_plan"]);

const sameLevel = (a: string | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The crop a new plan of a level starts with: the crop of a plan already drawn
 * for that level, so a ceiling plan lines up with its floor plan on the
 * sheets (and a second floor plan with the first). Floor plans are preferred,
 * then the most recently listed plan. Null when the level has no plan yet
 * (the caller fits the crop to the work). O(views).
 */
export function matchingPlanCrop(model: Pick<ModelState, "elements" | "connections">, viewType: ViewElement["viewType"], level: string | null | undefined): Rect | null {
  if (!PLAN_TYPES.has(viewType) || !level?.trim()) return null;
  let found: ViewElement | null = null;
  for (const view of documentIndex(model).views) {
    if (view.deleted || !PLAN_TYPES.has(view.viewType) || !sameLevel(view.props?.level, level)) continue;
    if (view.props?.cropView === false) continue;
    if (!found || (found.viewType !== "floor_plan" && view.viewType === "floor_plan")) found = view;
  }
  return found ? { min: found.cropMin, max: found.cropMax } : null;
}

const isDocument = (el: BimElement | undefined): el is ViewElement | Sheet | Viewport | DrawingItem =>
  el !== undefined && (el.kind === "view" || el.kind === "sheet" || el.kind === "viewport" || el.kind === "drawing_item");

function withoutId<T extends { readonly id: ElementId }>(list: readonly T[], elementId: string): T[] {
  return list.filter((x) => x.id !== elementId);
}

/** Sets `key` to `list`, or drops it when the list is empty: a fresh build lists no sheet or owner with nothing on it. */
function setOrDrop<T>(map: Map<string, readonly T[]>, key: string, list: readonly T[]): void {
  if (list.length === 0) map.delete(key);
  else map.set(key, list);
}

function replaced<T extends { readonly id: ElementId }>(list: readonly T[], next: T): T[] | null {
  const i = list.findIndex((x) => x.id === next.id);
  if (i < 0) return null;
  const out = list.slice();
  out[i] = next;
  return out;
}

/**
 * Carry `from`'s document index to `to` when `to` differs only in `changedIds`
 * (as after a views/sheets command): changed documents are replaced in place,
 * new ones appended (element order), removed or deleted ones dropped. A batch
 * of many steps then costs one small update per step instead of a re-index.
 * Anything it can't place exactly (an owner or sheet that changed) is left to
 * the full build on next read.
 */
function shareDocumentIndex(from: Readonly<Record<string, BimElement>>, to: Pick<ModelState, "elements">, changedIds: readonly string[]): void {
  const prev = indexes.get(from);
  if (!prev || indexes.has(to.elements)) return;
  let views = prev.views;
  let sheets = prev.sheets;
  const viewportsBySheet = new Map(prev.viewportsBySheet);
  const viewportByView = new Map(prev.viewportByView);
  const itemsByOwner = new Map(prev.itemsByOwner);
  for (const elementId of changedIds) {
    const before = from[elementId];
    const after = to.elements[elementId];
    if (!isDocument(before) && !isDocument(after)) continue;
    if (before && after && before.kind !== after.kind) return;
    const beforeLive = isDocument(before) && !before.deleted;
    const afterLive = isDocument(after) && !after.deleted;
    if (after?.kind === "view" || before?.kind === "view") {
      if (beforeLive && afterLive && after.kind === "view") {
        const next = replaced(views, after);
        if (!next) return;
        views = next;
      } else if (beforeLive) views = withoutId(views, elementId);
      else if (afterLive && after.kind === "view") {
        // Restored or new: its place in element order is only certain when it is new.
        if (before) return;
        views = [...views, after];
      }
      continue;
    }
    if (after?.kind === "sheet" || before?.kind === "sheet") {
      if (beforeLive && afterLive && after.kind === "sheet") {
        const next = replaced(sheets, after);
        if (!next) return;
        sheets = next;
      } else if (beforeLive) sheets = withoutId(sheets, elementId);
      else if (afterLive && after.kind === "sheet") {
        if (before) return;
        sheets = [...sheets, after];
      }
      continue;
    }
    if (after?.kind === "viewport" || before?.kind === "viewport") {
      const b = before?.kind === "viewport" ? before : undefined;
      const a = after?.kind === "viewport" ? after : undefined;
      if (b && a && (b.sheetId !== a.sheetId || b.viewId !== a.viewId)) return;
      const sheetId = (a ?? b)?.sheetId;
      if (!sheetId) return;
      const list = viewportsBySheet.get(sheetId) ?? [];
      if (beforeLive && afterLive && a) {
        const next = replaced(list, a);
        if (!next) return;
        viewportsBySheet.set(sheetId, next);
        viewportByView.set(a.viewId, a);
      } else if (beforeLive && b) {
        setOrDrop(viewportsBySheet, sheetId, withoutId(list, elementId));
        if (viewportByView.get(b.viewId)?.id === b.id) viewportByView.delete(b.viewId);
      } else if (afterLive && a) {
        if (b) return;
        viewportsBySheet.set(sheetId, [...list, a]);
        viewportByView.set(a.viewId, a);
      }
      continue;
    }
    const b = before?.kind === "drawing_item" ? before : undefined;
    const a = after?.kind === "drawing_item" ? after : undefined;
    if (b && a && b.ownerId !== a.ownerId) return;
    const ownerId = (a ?? b)?.ownerId;
    if (!ownerId) return;
    const list = itemsByOwner.get(ownerId) ?? [];
    if (beforeLive && afterLive && a) {
      const next = replaced(list, a);
      if (!next) return;
      itemsByOwner.set(ownerId, next);
    } else if (beforeLive) setOrDrop(itemsByOwner, ownerId, withoutId(list, elementId));
    else if (afterLive && a) {
      if (b) return;
      itemsByOwner.set(ownerId, [...list, a]);
    }
  }
  indexes.set(to.elements, { views, sheets, viewportsBySheet, viewportByView, itemsByOwner });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const F = DOCUMENT_FIELDS;

export { documentFieldValue };

function fail(message: string, ids: readonly string[] = [], code: "invalid_value" | "already_exists" | "in_use" | "element_not_found" | "wrong_kind" = "invalid_value"): never {
  throw new KernelError(code, message, ids.map(asElementId));
}

function live<K extends "view" | "sheet" | "viewport" | "drawing_item">(reader: TrackedReader, elementId: string, kind: K, label: string): Extract<BimElement, { kind: K }> {
  const el = reader.find(asElementId(elementId));
  if (!el || ("deleted" in el && el.deleted)) fail(`${label} no longer exists. Someone may have removed it.`, [elementId], "element_not_found");
  if (!isKind(el, kind)) fail(`${elementId} is a ${el.kind}, not a ${label.toLowerCase()}`, [elementId], "wrong_kind");
  return el;
}

function mustBeNew(model: ModelState, elementId: string): void {
  const el = model.elements[elementId];
  if (!el) return;
  if ("deleted" in el && el.deleted) fail(`${elementId} belonged to a removed ${el.kind.replace(/_/g, " ")}; ids aren't reused. Use a new id.`, [elementId], "already_exists");
  fail(`${elementId} is already used by another element`, [elementId], "already_exists");
}

const label = (v: ViewElement): string => `View "${v.name}"`;

function documentPartition(level: string | undefined, discipline: Partition["discipline"] | undefined): Partition {
  return { level: level ?? PROJECT_DOCUMENT_LEVEL, zone: DOCUMENT_ZONE, discipline: discipline ?? DEFAULT_PARTITION.discipline };
}

const SCHEDULE_KINDS = ["schedule", "formSchedule", "scheduleV2"] as const;

/** Setting one kind of schedule replaces the others the view had (a v1 list becomes v2 by setting `scheduleV2`); two kinds in one patch replace nothing, so the view check refuses them. */
function replacedScheduleKinds(current: ViewProps | undefined, patch: z.infer<typeof viewPropsPatch>): readonly (typeof SCHEDULE_KINDS)[number][] {
  const set = SCHEDULE_KINDS.filter((k) => patch[k] !== undefined);
  if (set.length !== 1) return [];
  return SCHEDULE_KINDS.filter((k) => k !== set[0] && current?.[k] !== undefined);
}

/** Patch fields replace; `discipline: null` clears the discipline (everything prints in ink). */
function mergeProps(current: ViewProps | undefined, patch: z.infer<typeof viewPropsPatch>): ViewProps {
  const { discipline, workingAngleDeg, viewBottomMm, viewTopMm, categoryOverrides, ...rest } = patch;
  let merged: ViewProps = { ...current, ...rest };
  if (categoryOverrides !== undefined) {
    const { categoryOverrides: _old, ...without } = merged;
    merged = Object.keys(categoryOverrides).length === 0 ? without : { ...without, categoryOverrides };
  }
  for (const key of replacedScheduleKinds(current, patch)) {
    const { [key]: _replaced, ...without } = merged;
    merged = without;
  }
  for (const [key, value] of [["viewBottomMm", viewBottomMm], ["viewTopMm", viewTopMm]] as const) {
    if (value === undefined) continue;
    const { [key]: _old, ...without } = merged;
    merged = value === null ? without : { ...without, [key]: value };
  }
  if (workingAngleDeg === null) {
    const { workingAngleDeg: _model, ...withoutOwnAngle } = merged;
    merged = withoutOwnAngle;
  } else if (workingAngleDeg !== undefined) merged = { ...merged, workingAngleDeg: normalizeWorkingAngleDeg(workingAngleDeg) };
  if (discipline === null) {
    const { discipline: _cleared, ...withoutDiscipline } = merged;
    return withoutDiscipline;
  }
  return discipline ? { ...merged, discipline } : merged;
}

/** A view named its level by id (a script's or agent's new level): store the level's name, as every reader of a view's level expects. */
function withCanonicalLevel(model: ModelState, props: ViewProps): ViewProps {
  const level = canonicalViewLevel(model, props.level);
  return level === undefined || level === props.level ? props : { ...props, level };
}

function sectionLength(cut: { start: Vec2; end: Vec2 }): number {
  return distance(cut.start, cut.end);
}

function defaultViewProps(viewType: ViewElement["viewType"], patch: z.infer<typeof viewPropsPatch> | undefined): ViewProps {
  const defaults: ViewProps =
    viewType === "schedule"
      ? { scale: 1, cropView: false }
      : viewType === "detail" && patch?.diagram
      ? { scale: 1, cropView: false }
      : viewType === "detail"
      ? { scale: DEFAULT_DETAIL_SCALE }
      : viewType === "floor_plan" || viewType === "ceiling_plan"
        ? { scale: DEFAULT_PLAN_SCALE, cutHeightMm: viewType === "ceiling_plan" ? 2743.2 : DEFAULT_CUT_HEIGHT_MM, viewDepthMm: 0, detailLevel: "medium" }
        : { scale: DEFAULT_PLAN_SCALE, detailLevel: "medium" };
  return patch ? mergeProps(defaults, patch) : defaults;
}

/**
 * Per-category graphics are stored only when the model server reads them
 * (`graphics:category_overrides`, `categories/feature.ts`). Clearing them
 * ({}) is always allowed; so is any edit that leaves them alone.
 */
function checkCategoryOverridesPatch(patch: z.infer<typeof viewPropsPatch> | undefined, viewId: string): void {
  const overrides = patch?.categoryOverrides;
  if (overrides === undefined || Object.keys(overrides).length === 0) return;
  if (!categoryOverridesWritable()) fail("This model server can't save per-category graphics yet, so the change wasn't made. Showing, hiding and pens for the standard categories (Duct, Electrical devices…) still save; an administrator can update the model server.", [viewId]);
}

/** A diagram kind is written only when a row in force draws it and the peers read it; a view already holding one keeps it untouched. */
function checkDiagramKindPatch(patch: z.infer<typeof viewPropsPatch> | undefined, viewId: string, stored?: ViewProps): void {
  const kind = patch?.diagram?.kind;
  if (kind === undefined || kind === stored?.diagram?.kind) return;
  const refusal = diagramKindStoreRefusal(kind);
  if (refusal) fail(refusal, [viewId]);
}

function checkProps(viewType: ViewElement["viewType"], props: ViewProps, viewId: string): void {
  if ((viewType === "floor_plan" || viewType === "ceiling_plan") && !props.level) fail("A plan needs a level. Pick the level it shows.", [viewId]);
  if (viewType === "section") {
    const cut = props.section;
    if (!cut) fail("A section needs a cut line. Draw it in a plan view.", [viewId]);
    if (sectionLength(cut) < MIN_SECTION_MM) fail("The section cut line is too short. Draw it at least 1 ft long.", [viewId]);
  }
  if (viewType !== "section" && props.section) fail("Only section views have a cut line.", [viewId]);
  const isPlan = viewType === "floor_plan" || viewType === "ceiling_plan";
  if (props.diagram?.hints?.faultCurrent !== undefined && !peerReads(DIAGRAM_FAULT_CURRENT_FEATURE)) fail("Show fault current can't be saved yet: the model server this model is open on is an older version. Try again once it is updated.", [viewId]);
  if (!isPlan && (props.viewBottomMm !== undefined || props.viewTopMm !== undefined)) fail("Only plans have a top and bottom to what they show. A section's reach is its far clip depth.", [viewId]);
  if (isPlan && props.viewTopMm !== undefined && props.viewTopMm < (props.cutHeightMm ?? DEFAULT_CUT_HEIGHT_MM)) fail(`The top of the view must be at or above the cut height (${Math.round((props.cutHeightMm ?? DEFAULT_CUT_HEIGHT_MM) / 30.48) / 10} ft).`, [viewId]);
  if (isPlan && viewType === "floor_plan" && props.viewBottomMm !== undefined && props.viewBottomMm > (props.cutHeightMm ?? DEFAULT_CUT_HEIGHT_MM)) fail(`The bottom of the view must be at or below the cut height (${Math.round((props.cutHeightMm ?? DEFAULT_CUT_HEIGHT_MM) / 30.48) / 10} ft).`, [viewId]);
  if (viewType !== "floor_plan" && viewType !== "ceiling_plan" && props.orientation !== undefined && props.orientation !== "plan_north") fail(props.orientation === "true_north" ? "Only plans turn to true north. Sections, 3D and detail views keep their own direction." : "Only plans turn to the working angle. Sections, 3D and detail views keep their own direction.", [viewId]);
  if (viewType === "schedule") {
    const kinds = [props.schedule, props.formSchedule, props.scheduleV2].filter((s) => s !== undefined).length;
    if (kinds === 0) fail("A schedule needs a category and at least one column.", [viewId]);
    if (kinds > 1) fail("A schedule is a list of one category, a form (panel, feeder…) or a v2 schedule: pick one, not both.", [viewId]);
    if (props.formSchedule) {
      const parsed = formScheduleSchema.safeParse(props.formSchedule);
      if (!parsed.success) fail(parsed.error.issues[0]?.message ?? "That schedule template doesn't fit.", [viewId]);
    }
    if (props.scale !== undefined && props.scale !== 1) fail("Schedules print at their own size; they have no drawing scale.", [viewId]);
    if (props.cropView === true) fail("A schedule is always as big as its rows; it has no crop box.", [viewId]);
  } else if (props.schedule || props.formSchedule || props.scheduleV2) fail("Only schedule views list elements in a table.", [viewId]);
  if (props.diagram) {
    if (viewType !== "detail") fail("A live diagram is a drafting view; create it as a detail view.", [viewId]);
    if (props.scale !== undefined && props.scale !== 1) fail("A live diagram prints at its own size, like a schedule; it has no drawing scale.", [viewId]);
    if (props.cropView === true) fail(DIAGRAM_NO_CROP, [viewId]);
  }
  if (viewType !== "three_d" && props.projection) fail("Only 3D views switch between perspective and orthographic. Plans, sections and details are always orthographic.", [viewId]);
  const problem3d = view3dPropsProblem(viewType, props);
  if (problem3d) fail(problem3d, [viewId]);
}

const DIAGRAM_NO_CROP = "A live diagram is as big as what it draws, like a schedule; it has no crop box. Change what it draws (hints: orientation, hidden, roots) to change its size.";

/**
 * A live diagram is its own size, like a schedule: its frame is what it draws,
 * so cropping, resizing or rescaling it is refused in words (a crop put the
 * diagram outside its own frame, bug log #41). Moving it is fine.
 */
function refuseDiagramFrameEdit(model: ModelState, command: ViewCommand): void {
  const viewOf = (id: string) => {
    const el = model.elements[id];
    return el?.kind === "view" && !el.deleted && el.props?.diagram ? el : null;
  };
  const viewportView = (id: string) => {
    const vp = model.elements[id];
    return vp?.kind === "viewport" && !vp.deleted ? viewOf(vp.viewId) : null;
  };
  if (command.type === "set_view_crop" && viewOf(command.viewId)) fail(DIAGRAM_NO_CROP, [command.viewId]);
  if (command.type === "set_viewport_scale" && viewportView(command.viewportId)) fail("A live diagram prints at its own size, like a schedule; it has no drawing scale.", [command.viewportId]);
  if (command.type !== "resize_viewport") return;
  const view = viewportView(command.viewportId);
  if (!view) return;
  const s = viewportFrameSize(model, view, 1);
  fail(`"${view.name}" is a live diagram: its frame is as big as what it draws (${convert(s.x, "mm", "in").toFixed(1)} x ${convert(s.y, "mm", "in").toFixed(1)} in), like a schedule. Move it, or change what it draws (hints: orientation, hidden, roots) to change its size.`, [command.viewportId]);
}

/** A 3D view whose plan crop was just changed: its 3D box follows (heights and turn kept). */
function boxOnPlanCrop(view: ViewElement, authored: AuthoredWrite[]): ViewElement {
  const box = view.viewType === "three_d" ? view.props?.cropBox3d : undefined;
  if (!box) return view;
  const cropBox3d = boxFollowingPlanCrop(box, { min: view.cropMin, max: view.cropMax });
  authored.push({ elementId: view.id, field: F.prop("cropBox3d"), value: canonicalJson(cropBox3d) });
  return { ...view, props: { ...view.props, cropBox3d } };
}

/** Smallest crop box side, model mm (1 in). */
const MIN_CROP_MM = 25.4;

function checkCrop(c: { min: Vec2; max: Vec2 }, viewId: string): void {
  if (!(c.max.x - c.min.x >= MIN_CROP_MM && c.max.y - c.min.y >= MIN_CROP_MM)) fail("The crop box needs a width and height of at least 1 in.", [viewId]);
}

function paperOf(sheet: Sheet): Vec2 {
  return sheetPaperSize(sheet);
}

/** Paper size of a view (crop on) placed at `scale`: its crop box at that scale. */
export function viewportSizeFor(view: ViewElement, scale: number): Vec2 {
  return windowPaperSize(viewWindow(view, viewCrop(view)), scale);
}

/** Paper size of a placed view's frame: its window at the scale, bounded after turning when the plan is drawn to true north. */
function framePaperSize(model: Pick<ModelState, "elements">, view: ViewElement, window: Rect, scale: number): Vec2 {
  const size = windowPaperSize(window, scale);
  const deg = viewRotationDeg(siteOf(model), view);
  if (!deg) return size;
  const a = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return roundVec({ x: size.x * c + size.y * s, y: size.x * s + size.y * c });
}

/** A view's viewport frame on paper at `scale` (a schedule ignores the scale: it is its table's size). */
export function viewportFrameSize(model: Pick<ModelState, "elements" | "connections">, view: ViewElement, scale: number): Vec2 {
  return framePaperSize(model, view, viewWindowIn(model, view), view.viewType === "schedule" ? 1 : scale);
}

/** The view's window in its drawing frame: its crop box, or all of its content with crop off. */
export function viewWindowIn(model: Pick<ModelState, "elements" | "connections">, view: ViewElement): Rect {
  return viewWindow(view, effectiveCrop(model, view, viewContentItems(model, view)));
}

/** What a view draws as drawing items: its own, then (a live diagram) what the diagram draws from the model now. */
export function viewContentItems(model: Pick<ModelState, "elements" | "connections">, view: ViewElement): readonly DrawingItem[] {
  const own = documentIndex(model).itemsByOwner.get(view.id) ?? [];
  if (!view.props?.diagram) return own;
  return [...diagramItemsOf(model.elements, view), ...own];
}

/**
 * After a view's crop or content window changed, its viewport (if placed)
 * takes the new window's size at its scale and moves so what stayed in the
 * crop stays where it was on paper. With `keepCenter` it keeps its centre
 * on the sheet instead (the model shifts on paper).
 */
function followCrop(reader: TrackedReader, docs: DocumentIndex, before: Rect, after: Rect, view: ViewElement, write: (el: BimElement) => void, authored: AuthoredWrite[], keepCenter = false): void {
  const vp = docs.viewportByView.get(view.id);
  if (!vp) return;
  reader.find(vp.id);
  const sheet = live(reader, vp.sheetId, "sheet", "The sheet");
  const b = rectCenter(before);
  const a = rectCenter(after);
  const deg = viewRotationDeg(siteOf(reader.model), view);
  const r = (deg * Math.PI) / 180;
  const d = { x: (a.x - b.x) * Math.cos(r) - (a.y - b.y) * Math.sin(r), y: (a.x - b.x) * Math.sin(r) + (a.y - b.y) * Math.cos(r) };
  const size = framePaperSize(reader.model, view, after, vp.scale);
  // A live diagram grows down and right from its top-left corner, as it is drawn (frameForViewport).
  const center = view.props?.diagram
    ? roundVec({ x: vp.center.x - vp.size.x / 2 + size.x / 2, y: vp.center.y - vp.size.y / 2 + size.y / 2 })
    : keepCenter ? vp.center : roundVec({ x: vp.center.x + d.x / vp.scale, y: vp.center.y - d.y / vp.scale });
  const next: Viewport = { ...vp, center, size };
  const paper = paperOf(sheet);
  if (!keepCenter && (center.x < 0 || center.y < 0 || center.x > paper.x || center.y > paper.y)) {
    const at = (p: Vec2) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
    fail(
      `The crop centre moves ${at({ x: a.x - b.x, y: a.y - b.y })} mm in the model, so the viewport on sheet ${sheet.number} would follow it from ${at(vp.center)} to ${at(center)} mm on paper, off the ${Math.round(paper.x)} x ${Math.round(paper.y)} mm sheet. Send keepViewportCenter: true to keep the viewport where it is, or check the crop's units (millimetres).`,
      [vp.id, view.id],
    );
  }
  checkViewport(sheet, next);
  write(next);
  authored.push({ elementId: vp.id, field: F.size, value: size }, { elementId: vp.id, field: F.center, value: center });
}

function checkViewport(sheet: Sheet, vp: Pick<Viewport, "center" | "size" | "id">): void {
  if (vp.size.x < MIN_VIEWPORT_PAPER_MM || vp.size.y < MIN_VIEWPORT_PAPER_MM) fail("The viewport would be smaller than 10 mm on paper. Make it bigger or use a larger scale.", [vp.id]);
  const paper = paperOf(sheet);
  if (vp.center.x < 0 || vp.center.y < 0 || vp.center.x > paper.x || vp.center.y > paper.y) fail(`The viewport's centre is off sheet ${sheet.number}. Drop it on the sheet.`, [vp.id]);
}

/** What a detailing shape needs besides its points: a known component for components and repeats, a thickness for batts. */
function checkDetail(shape: DrawingItem["shape"], fields: Pick<DrawingItem, "component" | "batt" | "fill">, itemId: string): void {
  if (shape === "component" || shape === "repeat") {
    if (!fields.component) fail(`A ${shape === "repeat" ? "repeating detail" : "detail component"} needs a component.`, [itemId]);
    if (!detailComponent(fields.component.symbolId)) fail(`There is no detail component "${fields.component.symbolId}". List detail components first.`, [itemId], "element_not_found");
  }
  if (shape === "batt" && !fields.batt) fail("Insulation needs its thickness.", [itemId]);
  if (fields.fill && shape !== "region") fail("Only a region takes a fill.", [itemId]);
  if (fields.batt && shape !== "batt") fail("Only insulation takes a thickness.", [itemId]);
  if (fields.component && shape !== "component" && shape !== "repeat") fail("Only a detail component or repeating detail takes a component.", [itemId]);
}

function checkPoints(shape: DrawingItem["shape"], points: readonly Vec2[], text: string | undefined, itemId: string, dim?: DimSpec, tag?: TagSpec): void {
  if (shape === "dimension" && dim) {
    const [lo, hi] = dimensionPointRange(dim);
    if (points.length < lo || points.length > hi) fail(`A ${dim.kind.replace(/_/g, " ")} dimension${dim.chain ? ` (${dim.chain})` : ""} needs ${lo === hi ? lo : `${lo} to ${hi}`} points; it has ${points.length}.`, [itemId]);
    if ((dim.refs?.length ?? 0) > points.length) fail("A dimension has more references than points.", [itemId]);
    if ((dim.kind === "linear" || dim.kind === "aligned") && !dim.chain) {
      const [a, b] = points;
      if (a && b && distance(a, b) < 0.5) fail("The dimension's two points are on top of each other.", [itemId]);
    }
    return;
  }
  const detail = detailPointRange(shape);
  if (detail) {
    const [lo, hi] = detail;
    if (points.length < lo || points.length > hi) fail(`A ${shape} needs ${lo === hi ? lo : `${lo} to ${hi}`} points; it has ${points.length}.`, [itemId]);
    return;
  }
  if (shape === "tag") {
    if (!tag) fail("A tag needs the element it labels.", [itemId]);
    if (points.length !== 1) fail("A tag needs one point: where its head goes.", [itemId]);
    return;
  }
  if (shape === "callout") {
    if (points.length !== 3) fail("A callout needs three points: two corners of its box, then where its head goes.", [itemId]);
    return;
  }
  if (shape === "field_block") {
    if (points.length !== 1) fail("A live block needs one point: its top-left corner on the sheet.", [itemId]);
    return;
  }
  const need = shape === "text" ? 1 : 2;
  if (points.length !== need) fail(`A ${shape === "text" ? "note" : shape} needs ${need} point${need === 1 ? "" : "s"}.`, [itemId]);
  if (shape === "text" && !text) fail("A note needs text.", [itemId]);
  const [a, b] = points;
  if (need === 2 && a && b && distance(a, b) < 0.5) fail(`The ${shape} is too small to see. Drag it out further.`, [itemId]);
}

const MODEL_VIEW_TYPES: ReadonlySet<string> = new Set(["floor_plan", "ceiling_plan", "section"]);

/** A callout names a live plan, section or detail view other than the one it is drawn in, and its box has some size. */
function checkCallout(reader: TrackedReader, shape: DrawingItem["shape"], spec: DrawingItem["callout"], ownerId: string, itemId: string, points: readonly Vec2[]): void {
  if (shape !== "callout") {
    if (spec) fail("Only a callout takes a callout spec.", [itemId]);
    return;
  }
  if (!spec) fail("A callout needs the view it refers to (callout.viewId).", [itemId]);
  if (spec.viewId === ownerId) fail("A callout can't refer to the view it is drawn in. Pick the enlarged view it points to.", [itemId]);
  const target = reader.find(asElementId(spec.viewId));
  if (!target || target.kind !== "view" || target.deleted) fail(`There is no view ${spec.viewId} for the callout to refer to. It may have been deleted.`, [spec.viewId], "element_not_found");
  if (target.viewType === "schedule" || target.viewType === "three_d") fail(`"${target.name}" is a ${target.viewType === "schedule" ? "schedule" : "3D view"}; callouts refer to a plan, section or detail view.`, [spec.viewId], "wrong_kind");
  const [a, b] = points;
  if (a && b && (Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1)) fail("The callout's box is too small to see. Drag it out further.", [itemId]);
}

/** The detailing fields a command sets (only the ones it names). */
function detailFieldsOf(c: { lineStyle?: DrawingItem["lineStyle"]; closed?: boolean; ccw?: boolean; fill?: DrawingItem["fill"]; component?: DrawingItem["component"]; batt?: DrawingItem["batt"]; category?: DrawingItem["category"]; detailGroup?: string; pinned?: boolean }): Partial<DrawingItem> {
  return {
    ...(c.lineStyle ? { lineStyle: c.lineStyle } : {}),
    ...(c.closed !== undefined ? { closed: c.closed } : {}),
    ...(c.ccw !== undefined ? { ccw: c.ccw } : {}),
    ...(c.fill ? { fill: c.fill } : {}),
    ...(c.component ? { component: c.component } : {}),
    ...(c.batt ? { batt: c.batt } : {}),
    ...(c.category ? { category: c.category } : {}),
    ...(c.detailGroup ? { detailGroup: c.detailGroup } : {}),
    ...(c.pinned ? { pinned: true } : {}),
  };
}

/** References an annotation names must exist: model elements, or drawing items in the same view. */
/** A tag's background, own leader choice or name-and-number words are stored only by peers that read them. */
function checkTagStored(itemId: string, tag: TagSpec | undefined): void {
  if (tag && tagSpecNeedsMaskLeaderPeers(tag) && !peerReads(TAGS_MASK_LEADER_FEATURE)) {
    fail("This tag's background, leader or room words can't be saved yet: the model server this model is open on is an older version. Try again once it is updated.", [itemId]);
  }
}

function checkReferences(reader: TrackedReader, ownerId: string, itemId: string, dim: DimSpec | undefined, tag: TagSpec | undefined): void {
  const ids = [...(dim?.refs ?? []).flatMap((r) => (r ? [r.elementId] : [])), ...(tag ? [tag.elementId] : [])];
  for (const ref of ids) {
    // A linked model's element is outside the model: the dimension keeps its point and follows it while the link is loaded.
    if (dim && !tag && parseLinkedElementKey(ref)) {
      if (!peerReads(ANNOTATION_LINKED_ANCHORS_FEATURE)) fail("This dimension can't be attached to the linked model yet: the model server this model is open on is an older version. Try again once it is updated.", [itemId]);
      continue;
    }
    const el = reader.find(asElementId(ref));
    if (!el || ("deleted" in el && el.deleted)) fail(`The element ${ref} this annotation points at doesn't exist.`, [itemId, ref], "element_not_found");
    if (el.kind === "drawing_item" && el.ownerId !== ownerId) fail("A dimension can follow drawing items only in its own view.", [itemId, ref]);
    if (tag && ref === tag.elementId && (el.kind === "drawing_item" || el.kind === "view" || el.kind === "sheet" || el.kind === "viewport")) fail("Tags label model elements, not drawings.", [itemId, ref], "wrong_kind");
  }
  if (tag?.styleId) {
    // Read the style's record (when stored) so an edit racing its deletion conflicts.
    reader.find(asElementId(tag.styleId));
    const style = organizationOf(reader.model).tagStyleById.get(tag.styleId);
    if (!style) fail(`There is no tag style "${tag.styleId}". It may have been deleted; pick another in Tag styles.`, [itemId, tag.styleId], "element_not_found");
    const appliesTo = style.entry.appliesTo ?? [];
    const el = reader.model.elements[tag.elementId];
    const kind = el ? tagStyleCategoryOf(reader.model, el) : null;
    if (appliesTo.length > 0 && (!kind || !appliesTo.includes(kind))) {
      fail(`The tag style "${style.entry.name}" labels ${appliesTo.map((k) => k.replace(/_/g, " ")).join(", ")}, not ${kind ? kind.replace(/_/g, " ") : "this kind of element"}. Pick a style made for it, or widen what this one applies to in Tag styles.`, [itemId, tag.styleId, tag.elementId], "wrong_kind");
    }
  }
}

// ── Executor ─────────────────────────────────────────────────────────────────

function finishDocs(reader: TrackedReader, working: Record<string, BimElement>, touched: readonly ElementId[], authored: AuthoredWrite[]): ExecuteResult {
  const base = reader.model;
  checkStoredDisciplines(base.elements, working, touched);
  const derived = recomputeDerivedAfter(base, working, touched);
  const changed = [...new Set<ElementId>([...touched, ...derived.changedIds])];
  const check = checkEdit(base, base, derived.model, changed, touched);
  const issue = check.refusal;
  if (issue) return { ok: false, error: { code: issue.code, message: issue.message, elementIds: issue.elementIds } };
  markKnownIssues(derived.model, check.open);
  // A local prediction is drawn straight away (the sheet follows a crop drag); don't re-index the whole model for it.
  sharePartitionIndex(base.elements, derived.model.elements, changed);
  shareDocumentIndex(base.elements, derived.model, changed);
  carryOrganization(base.elements, derived.model.elements, changed);
  return {
    ok: true,
    model: derived.model,
    changedIds: changed,
    removedIds: [],
    removedConnections: [],
    addedConnections: [],
    readSet: reader.readSet(),
    authored,
    intents: authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })),
    ...(check.open.length > 0 ? { openIssues: check.open } : {}),
  };
}

function guarded(fn: () => ExecuteResult): ExecuteResult {
  try {
    return fn();
  } catch (err) {
    if (err instanceof KernelError) return { ok: false, error: { code: err.code, message: err.message, elementIds: err.elementIds } };
    throw err;
  }
}

const NEW_META = { version: 0, authoredRev: {} } as const;

/** What a document edit outside this file (block commands) writes through: the same reader, working set and authored list a view command uses. */
export interface DocumentEditContext {
  readonly model: ModelState;
  readonly reader: TrackedReader;
  readonly write: (el: BimElement) => void;
  readonly authored: AuthoredWrite[];
}

/**
 * Run a document edit with the view commands' frame: derived values, the
 * edit check, the shared partition and document indexes, and the
 * cross-element document rules. A KernelError thrown by `edit` is a refusal.
 */
export function executeDocumentEdit(model: ModelState, edit: (ctx: DocumentEditContext) => void): ExecuteResult {
  return guarded(() => {
    const reader = new TrackedReader(model);
    const working = draftElements(model.elements);
    const touched: ElementId[] = [];
    const authored: AuthoredWrite[] = [];
    edit({
      model,
      reader,
      authored,
      write: (el) => {
        working[el.id] = el;
        touched.push(el.id);
      },
    });
    const result = finishDocs(reader, working, touched, authored);
    if (result.ok) {
      const issue = documentIssue(model, result.model, touched);
      if (issue) return issue;
    }
    return result;
  });
}

export function executeViewCommand(model: ModelState, command: ViewCommand): ExecuteResult {
  return guarded(() => {
    const reader = new TrackedReader(model);
    const working = draftElements(model.elements);
    const touched: ElementId[] = [];
    const authored: AuthoredWrite[] = [];
    const write = (el: BimElement) => {
      working[el.id] = el;
      touched.push(el.id);
    };
    const docs = () => documentIndex(model);
    refuseDiagramFrameEdit(model, command);

    switch (command.type) {
      case "create_view": {
        mustBeNew(model, command.viewId);
        checkCategoryOverridesPatch(command.props, command.viewId);
        checkViewGraphicsPatch(command.viewType, command.props, command.viewId);
        checkDiagramKindPatch(command.props, command.viewId);
        const props = withCanonicalLevel(model, defaultViewProps(command.viewType, command.props));
        checkProps(command.viewType, props, command.viewId);
        uniqueViewName(docs(), command.name, null);
        // No crop given: a plan of a level that already has one starts on that plan's crop, so the two line up on sheets.
        const c = command.crop ?? matchingPlanCrop(model, command.viewType, props.level) ?? fitCrop(model, { viewType: command.viewType, props }, []);
        checkCrop(c, command.viewId);
        write({
          ...NEW_META,
          id: asElementId(command.viewId),
          kind: "view",
          name: command.name,
          viewType: command.viewType,
          cropMin: roundVec(c.min),
          cropMax: roundVec(c.max),
          props: command.viewType === "three_d" ? withDefault3d(model, props, c) : props,
          partition: documentPartition(props.level, props.discipline),
        });
        break;
      }
      case "rename_view": {
        const view = live(reader, command.viewId, "view", "The view");
        uniqueViewName(docs(), command.name, view.id);
        write({ ...view, name: command.name });
        authored.push({ elementId: view.id, field: F.name, value: command.name });
        break;
      }
      case "duplicate_view": {
        const view = live(reader, command.viewId, "view", "The view");
        mustBeNew(model, command.newViewId);
        const newName = command.name ?? nextCopyName(docs(), view.name);
        uniqueViewName(docs(), newName, null);
        const copy: ViewElement = { ...view, ...NEW_META, id: asElementId(command.newViewId), name: newName, props: withoutWorking(view.props) };
        write(copy);
        for (const item of docs().itemsByOwner.get(view.id) ?? []) {
          const itemId = `${command.newViewId}~${item.id}`.slice(0, 200);
          mustBeNew(model, itemId);
          reader.find(item.id);
          write({ ...item, ...NEW_META, id: asElementId(itemId), ownerId: copy.id });
        }
        break;
      }
      case "delete_view": {
        const view = live(reader, command.viewId, "view", "The view");
        const vp = docs().viewportByView.get(view.id);
        if (vp) {
          const sheet = reader.find(vp.sheetId);
          const where = sheet?.kind === "sheet" ? `sheet ${sheet.number}` : "a sheet";
          if ((command.placed ?? "refuse") === "refuse") fail(`${label(view)} is placed on ${where}. Remove it from the sheet first, or delete it from the sheet too.`, [view.id, vp.id], "in_use");
          reader.find(vp.id);
          write({ ...vp, deleted: true });
          authored.push({ elementId: vp.id, field: F.deleted, value: "true" });
          if (sheet?.kind === "sheet") write({ ...sheet, viewIds: sheet.viewIds.filter((v) => v !== view.id) });
        }
        write({ ...view, deleted: true });
        authored.push({ elementId: view.id, field: F.deleted, value: "true" });
        break;
      }
      case "set_view_properties": {
        const view = live(reader, command.viewId, "view", "The view");
        checkCategoryOverridesPatch(command.props, view.id);
        checkViewGraphicsPatch(view.viewType, command.props, view.id);
        checkDiagramKindPatch(command.props, view.id, view.props);
        const props = withCanonicalLevel(model, mergeProps(view.props, command.props));
        checkProps(view.viewType, props, view.id);
        const organizationProblem = viewOrganizationProblem(model, command.props);
        if (organizationProblem) fail(organizationProblem, [view.id], "element_not_found");
        let cropMin = view.cropMin;
        let cropMax = view.cropMax;
        if (command.crop) {
          checkCrop(command.crop, view.id);
          cropMin = roundVec(command.crop.min);
          cropMax = roundVec(command.crop.max);
          authored.push({ elementId: view.id, field: F.crop, value: canonicalJson({ min: cropMin, max: cropMax }) });
        } else if (view.viewType === "section" && command.props.section) {
          // A moved cut line re-crops along its new length.
          const c = sectionDefaultCrop({ props });
          cropMin = c.min;
          cropMax = { x: c.max.x, y: view.cropMax.y };
        }
        const level = props.level ?? view.partition?.level;
        const cropped: ViewElement = { ...view, props, cropMin, cropMax, partition: documentPartition(level === PROJECT_DOCUMENT_LEVEL ? undefined : level, props.discipline) };
        const next = command.crop ? boxOnPlanCrop(cropped, authored) : cropped;
        write(next);
        for (const key of [...Object.keys(command.props), ...replacedScheduleKinds(view.props, command.props)]) {
          authored.push({ elementId: view.id, field: F.prop(key), value: canonicalJson(propValue(props, key)) });
        }
        // The window a live diagram fills is what it draws from the model now, not just its own drafting.
        const items = viewContentItems(model, view);
        followCrop(reader, docs(), viewWindow(view, effectiveCrop(model, view, items)), viewWindow(next, effectiveCrop(model, next, viewContentItems(model, next))), next, write, authored, command.keepViewportCenter === true);
        break;
      }
      case "set_view_crop": {
        const view = live(reader, command.viewId, "view", "The view");
        if (view.viewType === "schedule") fail("A schedule is always as big as its rows; it has no crop box. Change its columns or filters instead.", [view.id]);
        if (command.crop && command.fit) fail("Send a crop box or ask to fit it to the content, not both.", [view.id]);
        if (command.farClipMm !== undefined && view.viewType !== "section") fail("Only sections have a far clip depth.", [view.id]);
        const items = viewContentItems(model, view);
        let props: ViewProps = view.props ?? {};
        const setProp = <K extends "cropView" | "showCropBox" | "annotationCrop" | "annotationCropOffsetMm">(key: K, value: ViewProps[K] | undefined) => {
          if (value === undefined) return;
          props = { ...props, [key]: value };
          authored.push({ elementId: view.id, field: F.prop(key), value: canonicalJson(value) });
        };
        setProp("cropView", command.cropView);
        setProp("showCropBox", command.showCropBox);
        setProp("annotationCrop", command.annotationCrop);
        setProp("annotationCropOffsetMm", command.annotationCropOffsetMm);
        if (command.farClipMm !== undefined && props.section) {
          props = { ...props, section: { ...props.section, depthMm: round(command.farClipMm) } };
          authored.push({ elementId: view.id, field: F.prop("section"), value: canonicalJson(props.section) });
        }
        const wanted = command.crop ?? (command.fit ? fitCrop(model, view, items) : null);
        let cropMin = view.cropMin;
        let cropMax = view.cropMax;
        if (wanted) {
          checkCrop(wanted, view.id);
          cropMin = roundVec(wanted.min);
          cropMax = roundVec(wanted.max);
          authored.push({ elementId: view.id, field: F.crop, value: canonicalJson({ min: cropMin, max: cropMax }) });
          // Moving the crop box means you want it to crop.
          if (command.cropView === undefined && props.cropView === false) setProp("cropView", true);
        }
        const cropped: ViewElement = { ...view, props, cropMin, cropMax };
        const next = wanted ? boxOnPlanCrop(cropped, authored) : cropped;
        write(next);
        followCrop(reader, docs(), viewWindow(view, effectiveCrop(model, view, items)), viewWindow(next, effectiveCrop(model, next, items)), next, write, authored, command.keepViewportCenter === true);
        break;
      }
      case "create_3d_view":
      case "set_3d_view_camera":
      case "set_3d_crop_box":
        if (isView3dCommand(command)) {
          executeView3dCommand(
            {
              model,
              views: docs().views,
              view: (viewId) => live(reader, viewId, "view", "The view"),
              write,
              authored,
              uniqueName: (wanted, except) => uniqueViewName(docs(), wanted, except === null ? null : asElementId(except)),
              partition: () => documentPartition(undefined, undefined),
              follow: (before, after) => {
                const items = docs().itemsByOwner.get(after.id) ?? [];
                followCrop(reader, docs(), viewWindow(before, effectiveCrop(model, before, items)), viewWindow(after, effectiveCrop(model, after, items)), after, write, authored);
              },
            },
            command,
          );
        }
        break;
      case "create_sheet": {
        mustBeNew(model, command.sheetId);
        uniqueSheetNumber(docs(), command.number, null);
        const props: SheetProps = {
          titleBlock: command.titleBlock ?? "arch_d_mutinybim",
          ...(command.titleBlockRow ? { titleBlockRow: command.titleBlockRow } : {}),
          ...(command.fields ? { fields: command.fields } : {}),
          ...(command.revisions && command.revisions.length > 0 ? { revisions: command.revisions } : {}),
        };
        write({ ...NEW_META, id: asElementId(command.sheetId), kind: "sheet", number: command.number, title: command.name, viewIds: [], props, partition: documentPartition(undefined, undefined) });
        break;
      }
      case "set_sheet_properties": {
        const sheet = live(reader, command.sheetId, "sheet", "The sheet");
        if (command.number !== undefined) {
          uniqueSheetNumber(docs(), command.number, sheet.id);
          authored.push({ elementId: sheet.id, field: F.number, value: command.number });
        }
        if (command.name !== undefined) authored.push({ elementId: sheet.id, field: F.title, value: command.name });
        if (command.titleBlock !== undefined) authored.push({ elementId: sheet.id, field: F.titleBlock, value: command.titleBlock });
        if (command.titleBlockRow !== undefined) authored.push({ elementId: sheet.id, field: F.titleBlockRow, value: command.titleBlockRow ? `${command.titleBlockRow.id}@${command.titleBlockRow.revision}` : "" });
        if (command.revisions !== undefined) authored.push({ elementId: sheet.id, field: F.revisions, value: canonicalJson(command.revisions) });
        const nextFields = { ...(sheet.props?.fields ?? {}) };
        for (const [key, value] of Object.entries(command.fields ?? {})) {
          if (value === "") delete nextFields[key];
          else nextFields[key] = value;
          authored.push({ elementId: sheet.id, field: F.field(key), value });
        }
        const { titleBlockRow: keptRow, ...keptProps } = sheet.props ?? {};
        const row = command.titleBlockRow === undefined ? keptRow : command.titleBlockRow ?? undefined;
        const next: Sheet = {
          ...sheet,
          number: command.number ?? sheet.number,
          title: command.name ?? sheet.title,
          props: {
            ...keptProps,
            ...(row ? { titleBlockRow: row } : {}),
            ...(command.titleBlock ? { titleBlock: command.titleBlock } : {}),
            fields: nextFields,
            ...(command.revisions !== undefined ? { revisions: command.revisions } : {}),
          },
        };
        write(next);
        // A smaller title block must still hold every viewport.
        if (command.titleBlock || command.titleBlockRow !== undefined) for (const vp of docs().viewportsBySheet.get(sheet.id) ?? []) checkViewport(next, vp);
        break;
      }
      case "delete_sheet": {
        const sheet = live(reader, command.sheetId, "sheet", "The sheet");
        for (const vp of docs().viewportsBySheet.get(sheet.id) ?? []) {
          reader.find(vp.id);
          write({ ...vp, deleted: true });
        }
        for (const item of docs().itemsByOwner.get(sheet.id) ?? []) {
          reader.find(item.id);
          write({ ...item, deleted: true });
        }
        write({ ...sheet, viewIds: [], deleted: true });
        authored.push({ elementId: sheet.id, field: F.deleted, value: "true" });
        break;
      }
      case "place_viewport": {
        mustBeNew(model, command.viewportId);
        const sheet = live(reader, command.sheetId, "sheet", "The sheet");
        const view = live(reader, command.viewId, "view", "The view");
        if (view.viewType === "schedule" && command.scale !== undefined && command.scale !== 1) fail("Schedules print at their own size; they have no drawing scale.", [view.id]);
        if (view.props?.workingFor) fail(`"${view.name}" is someone's working 3D view. Duplicate it to make a saved 3D view you can place on a sheet.`, [view.id], "in_use");
        const existing = docs().viewportByView.get(view.id);
        if (existing) {
          const other = model.elements[existing.sheetId];
          fail(`${label(view)} is already on ${other?.kind === "sheet" ? `sheet ${other.number}` : "another sheet"}. A view goes on one sheet; duplicate it to show it again.`, [view.id, existing.id], "in_use");
        }
        const s = view.viewType === "schedule" ? 1 : (command.scale ?? view.props?.scale ?? DEFAULT_PLAN_SCALE);
        const vp: Viewport = {
          ...NEW_META,
          id: asElementId(command.viewportId),
          kind: "viewport",
          sheetId: sheet.id,
          viewId: view.id,
          center: roundVec(command.center),
          size: framePaperSize(model, view, viewWindowIn(model, view), s),
          scale: s,
          partition: sheet.partition,
        };
        checkViewport(sheet, vp);
        write(vp);
        write({ ...sheet, viewIds: [...sheet.viewIds, view.id] });
        break;
      }
      case "move_viewport": {
        const vp = live(reader, command.viewportId, "viewport", "The viewport");
        const sheet = live(reader, vp.sheetId, "sheet", "The sheet");
        const center = roundVec(command.center);
        checkViewport(sheet, { ...vp, center });
        write({ ...vp, center });
        authored.push({ elementId: vp.id, field: F.center, value: center });
        break;
      }
      case "resize_viewport": {
        // The frame is the view's crop box at this scale: dragging its edges edits the crop.
        const vp = live(reader, command.viewportId, "viewport", "The viewport");
        const sheet = live(reader, vp.sheetId, "sheet", "The sheet");
        const view = live(reader, vp.viewId, "view", "The view");
        if (view.viewType === "schedule") fail("A schedule's frame is as big as its rows and columns. Change the schedule instead.", [vp.id]);
        if (view.viewType === "three_d" && view.props?.camera3d) fail("A 3D view's frame is its 3D crop box seen from its camera. Change the box (its grips or numbers) or the camera in the view; the frame follows.", [vp.id]);
        if (viewRotationDeg(siteOf(model), view) !== 0) fail(`This plan is turned to ${view.props?.orientation === "working_angle" ? "the working angle" : "true north"}, so its frame's edges aren't square to the crop box. Change the crop box in the view; the frame follows.`, [vp.id]);
        const items = viewContentItems(model, view);
        const oldCrop = effectiveCrop(model, view, items);
        const oldWindow = viewWindow(view, oldCrop);
        const center = roundVec(command.center ?? vp.center);
        const size = roundVec(command.size);
        checkViewport(sheet, { ...vp, center, size });
        const wc = rectCenter(oldWindow);
        const newCenter = { x: wc.x + (center.x - vp.center.x) * vp.scale, y: wc.y - (center.y - vp.center.y) * vp.scale };
        const half = { x: (size.x * vp.scale) / 2, y: (size.y * vp.scale) / 2 };
        const c = cropForWindow(view, oldCrop, { min: { x: newCenter.x - half.x, y: newCenter.y - half.y }, max: { x: newCenter.x + half.x, y: newCenter.y + half.y } });
        checkCrop(c, view.id);
        const props: ViewProps = view.props?.cropView === false ? { ...view.props, cropView: true } : (view.props ?? {});
        const next = boxOnPlanCrop({ ...view, props, cropMin: c.min, cropMax: c.max }, authored);
        write(next);
        authored.push({ elementId: view.id, field: F.crop, value: canonicalJson({ min: c.min, max: c.max }) });
        if (view.props?.cropView === false) authored.push({ elementId: view.id, field: F.prop("cropView"), value: "true" });
        followCrop(reader, docs(), oldWindow, viewWindow(next, viewCrop(next)), next, write, authored);
        break;
      }
      case "set_viewport_scale": {
        const vp = live(reader, command.viewportId, "viewport", "The viewport");
        const sheet = live(reader, vp.sheetId, "sheet", "The sheet");
        const view = live(reader, vp.viewId, "view", "The view");
        if (view.viewType === "schedule") fail("Schedules print at their own size; they have no drawing scale.", [vp.id]);
        // Keep the same crop box: the frame grows or shrinks on paper.
        const size = framePaperSize(model, view, viewWindowIn(model, view), command.scale);
        checkViewport(sheet, { ...vp, size });
        write({ ...vp, scale: command.scale, size });
        authored.push({ elementId: vp.id, field: F.scale, value: command.scale });
        break;
      }
      case "set_viewport_north_arrow": {
        const vp = live(reader, command.viewportId, "viewport", "The viewport");
        write({ ...vp, northArrow: command.show });
        authored.push({ elementId: vp.id, field: F.northArrow, value: String(command.show) });
        break;
      }
      case "remove_viewport": {
        const vp = live(reader, command.viewportId, "viewport", "The viewport");
        const sheet = reader.find(vp.sheetId);
        write({ ...vp, deleted: true });
        authored.push({ elementId: vp.id, field: F.deleted, value: "true" });
        if (sheet?.kind === "sheet") write({ ...sheet, viewIds: sheet.viewIds.filter((v) => v !== vp.viewId) });
        break;
      }
      case "add_drawing_item": {
        mustBeNew(model, command.itemId);
        const owner = reader.find(asElementId(command.ownerId));
        if (!owner || ("deleted" in owner && owner.deleted)) fail("The sheet or detail view you're drawing in no longer exists.", [command.ownerId], "element_not_found");
        const onSheet = owner.kind === "sheet";
        const inDetail = owner.kind === "view" && owner.viewType === "detail";
        const inModelView = owner.kind === "view" && MODEL_VIEW_TYPES.has(owner.viewType);
        if (!onSheet && !inDetail && !inModelView) fail("Lines, notes, dimensions and tags go on a sheet, a detail view, a plan or a section.", [command.ownerId], "wrong_kind");
        if (onSheet && command.shape === "dimension") fail("Dimensions on a sheet measure a view; draw them in the view.", [command.ownerId]);
        if (command.shape === "tag" && !inModelView) fail("Tags label the model, so they go in a plan or a section.", [command.ownerId]);
        if (command.dim && command.shape !== "dimension") fail("Only a dimension takes a dimension spec.", [command.itemId]);
        if (command.tag && command.shape !== "tag") fail("Only a tag takes a tag spec.", [command.itemId]);
        if (command.shape === "figure" && (!onSheet || !command.figure)) fail(onSheet ? "A figure needs its chart or picture." : "Charts and pictures go on a sheet.", [command.ownerId], onSheet ? "invalid_value" : "wrong_kind");
        if (command.figure && command.shape !== "figure") fail("Only a figure takes a chart or picture.", [command.itemId]);
        if (command.shape === "field_block") fail("Place a live field block with add_field_block; it checks the template.", [command.itemId]);
        if (command.shape === "callout" && !(owner.kind === "view" && (owner.viewType === "floor_plan" || owner.viewType === "ceiling_plan" || owner.viewType === "section"))) fail("Callouts mark part of a plan or a section, so they go in one.", [command.ownerId], "wrong_kind");
        const points = command.points.map(roundVec);
        checkPoints(command.shape, points, command.text, command.itemId, command.dim, command.tag);
        checkCallout(reader, command.shape, command.callout, owner.id, command.itemId, points);
        checkDetail(command.shape, command, command.itemId);
        checkReferences(reader, owner.id, command.itemId, command.dim, command.tag);
        checkTagStored(command.itemId, command.tag);
        write({
          ...NEW_META,
          id: asElementId(command.itemId),
          kind: "drawing_item",
          ownerId: owner.id,
          shape: command.shape,
          points,
          ...(command.text ? { text: command.text } : {}),
          ...(command.textSize ? { textSize: command.textSize } : {}),
          ...(command.dim ? { dim: command.dim } : {}),
          ...(command.tag ? { tag: command.tag } : {}),
          ...(command.callout ? { callout: command.callout } : {}),
          ...(command.figure ? { figure: command.figure } : {}),
          ...detailFieldsOf(command),
          partition: owner.partition,
        });
        break;
      }
      case "update_drawing_item": {
        const item = live(reader, command.itemId, "drawing_item", "That drawing item");
        if (item.note && command.text) fail("This note has formatting. Change its text with edit_text_note.", [item.id]);
        if (command.dim && item.shape !== "dimension") fail("Only a dimension takes a dimension spec.", [item.id]);
        if (command.tag && item.shape !== "tag") fail("Only a tag takes a tag spec.", [item.id]);
        if (command.figure && item.shape !== "figure") fail("Only a figure takes a chart or picture.", [item.id]);
        if (command.text && item.shape === "field_block") fail("A live block's words come from its template. Change them with edit_field_block.", [item.id]);
        if (item.pinned && command.points && command.pinned !== false) fail(`${describe(item)} is pinned. Unpin it before moving or reshaping it.`, [item.id], "in_use");
        const points = command.points ? command.points.map(roundVec) : item.points;
        const text = command.text ?? item.text;
        const dim = command.dim ?? item.dim;
        const head = item.points[0];
        const to = points[0];
        // Moving a tag's head carries an elbow placed by hand with it; a command that sets the tag says where its elbow goes.
        const tag =
          command.tag ??
          (item.tag?.elbow && item.tag.elbow !== "auto" && command.points && head && to ? { ...item.tag, elbow: roundVec({ x: item.tag.elbow.x + to.x - head.x, y: item.tag.elbow.y + to.y - head.y }) } : item.tag);
        const callout = command.callout ?? item.callout;
        if (!item.note) checkPoints(item.shape, points, text, item.id, dim, tag);
        if (command.callout || command.points) checkCallout(reader, item.shape, callout, item.ownerId, item.id, points);
        if (command.dim || command.tag) checkReferences(reader, item.ownerId, item.id, command.dim, command.tag);
        checkTagStored(item.id, command.tag);
        const { detailGroup: _group, ...kept } = item;
        const { pinned: _pin, ...base } = command.detailGroup === null ? kept : item;
        const merged: DrawingItem = {
          ...(command.pinned === false ? base : command.detailGroup === null ? kept : item),
          points,
          ...(text ? { text } : {}),
          ...(dim ? { dim } : {}),
          ...(tag ? { tag } : {}),
          ...(callout ? { callout } : {}),
          ...(command.figure ? { figure: command.figure } : {}),
          ...detailFieldsOf({ ...command, detailGroup: command.detailGroup ?? undefined }),
        };
        checkDetail(item.shape, merged, item.id);
        write(merged);
        const detailChanged = [command.lineStyle, command.closed, command.ccw, command.fill, command.component, command.batt, command.category, command.detailGroup, command.pinned].some((v) => v !== undefined);
        if (detailChanged) authored.push({ elementId: item.id, field: F.detail, value: documentFieldValue(merged, F.detail) ?? "" });
        if (command.points) authored.push({ elementId: item.id, field: F.points, value: canonicalJson(points) });
        if (command.text) authored.push({ elementId: item.id, field: F.text, value: command.text });
        if (command.dim) authored.push({ elementId: item.id, field: F.dim, value: canonicalJson(command.dim) });
        if (command.tag) authored.push({ elementId: item.id, field: F.tag, value: canonicalJson(command.tag) });
        if (command.callout) authored.push({ elementId: item.id, field: F.callout, value: canonicalJson(command.callout) });
        if (command.figure) authored.push({ elementId: item.id, field: F.figure, value: canonicalJson(command.figure) });
        break;
      }
      case "copy_drawing_items": {
        const target = reader.find(asElementId(command.toOwnerId));
        if (!target || ("deleted" in target && target.deleted)) fail("The sheet or view to copy into no longer exists.", [command.toOwnerId], "element_not_found");
        const intoView = target.kind === "view" && (target.viewType === "detail" || MODEL_VIEW_TYPES.has(target.viewType));
        if (target.kind !== "sheet" && !intoView) fail("Copy drawing items into a sheet, a detail view, a plan or a section.", [command.toOwnerId], "wrong_kind");
        const sources = command.itemIds.map((itemId) => live(reader, itemId, "drawing_item", "That drawing item"));
        const fromOwner = sources[0]?.ownerId;
        if (sources.some((it) => it.ownerId !== fromOwner)) fail("Copy items from one sheet or view at a time.", command.itemIds);
        const newId = (old: string) => `${command.idPrefix}-${old}`.slice(0, 200);
        const copied = new Set(sources.map((it) => it.id as string));
        const d = command.offset ?? { x: 0, y: 0 };
        const shift = (p: Vec2) => roundVec({ x: p.x + d.x, y: p.y + d.y });
        for (const it of sources) {
          const nid = newId(it.id);
          mustBeNew(model, nid);
          // Tags label the model: they copy only into a plan or section.
          if (it.tag && !(target.kind === "view" && MODEL_VIEW_TYPES.has(target.viewType))) fail("Tags copy only into a plan or a section.", [it.id]);
          const refs = it.dim?.refs?.map((r) => (r && copied.has(r.elementId) ? { ...r, elementId: newId(r.elementId) } : r));
          const note = it.note ? { ...it.note, ...(it.note.leader ? { leader: { ...it.note.leader, to: shift(it.note.leader.to), ...(it.note.leader.elbow ? { elbow: shift(it.note.leader.elbow) } : {}) } } : {}), ...(it.note.leaders ? { leaders: it.note.leaders.map((l) => ({ ...l, to: shift(l.to), ...(l.elbow ? { elbow: shift(l.elbow) } : {}) })) } : {}) } : undefined;
          const tag = it.tag?.elbow && it.tag.elbow !== "auto" ? { ...it.tag, elbow: shift(it.tag.elbow) } : it.tag;
          const { detailGroup, ...rest } = it;
          write({
            ...rest,
            ...NEW_META,
            id: asElementId(nid),
            ownerId: target.id,
            points: it.points.map(shift),
            ...(tag ? { tag } : {}),
            ...(it.dim ? { dim: { ...it.dim, ...(refs ? { refs } : {}) } } : {}),
            ...(note ? { note } : {}),
            ...(detailGroup ? { detailGroup: `${command.idPrefix}-${detailGroup}`.slice(0, 120) } : {}),
            partition: target.partition,
          });
        }
        break;
      }
      case "delete_drawing_item": {
        const item = live(reader, command.itemId, "drawing_item", "That drawing item");
        if (item.pinned) fail(`${describe(item)} is pinned. Unpin it before deleting it.`, [item.id], "in_use");
        write({ ...item, deleted: true });
        authored.push({ elementId: item.id, field: F.deleted, value: "true" });
        break;
      }
      case "create_text_note":
      case "edit_text_note":
      case "resize_text_note":
      case "move_text_note":
      case "delete_text_note":
        if (isTextNoteCommand(command)) {
          const conflict = executeTextNoteCommand({ model, reader, write, authored }, command);
          if (conflict) return { ok: false, error: conflict };
        }
        break;
      case "restore_document_elements": {
        for (const entry of command.items) {
          const current = reader.find(asElementId(entry.elementId));
          if (!current) fail("Nothing to undo: that element is gone.", [entry.elementId], "element_not_found");
          if (current.kind !== "view" && current.kind !== "sheet" && current.kind !== "viewport" && current.kind !== "drawing_item") {
            fail(`Undo here only restores views, sheets and drawing content, not a ${current.kind}.`, [entry.elementId], "wrong_kind");
          }
          if (current.version !== entry.expectedVersion) {
            return { ok: false, error: { code: "conflict", message: `${describe(current)} changed since your edit; undoing would overwrite that work.`, elementIds: [current.id] } };
          }
          const restored = entry.before ? restoreRecord(entry.before, current) : { ...current, deleted: true };
          write(restored);
        }
        break;
      }
    }
    const result = finishDocs(reader, working, touched, authored);
    if (result.ok) {
      const issue = documentIssue(model, result.model, touched);
      if (issue) return issue;
    }
    return result;
  });
}

function describe(el: BimElement): string {
  switch (el.kind) {
    case "view":
      return `View "${el.name}"`;
    case "sheet":
      return `Sheet ${el.number}`;
    case "viewport":
      return "That viewport";
    case "drawing_item":
      return el.shape === "text" ? `Note "${el.note ? noteLabel(el.note.paragraphs, 30) : (el.text ?? "")}"` : `That ${el.shape}`;
    default:
      return el.id;
  }
}

/** The record as it was, at the current version (the commit bumps it). */
function restoreRecord(before: DocumentRecord, current: BimElement): BimElement {
  if (before.kind !== current.kind || before.id !== current.id) fail("Undo record does not match the element.", [current.id]);
  const { deleted, ...rest } = before;
  const restored = { ...rest, id: asElementId(before.id), version: current.version, authoredRev: current.authoredRev, ...(deleted ? { deleted } : {}) };
  switch (restored.kind) {
    case "view":
      return restored;
    case "sheet":
      return { ...restored, viewIds: restored.viewIds.map(asElementId) };
    case "viewport":
      return { ...restored, sheetId: asElementId(restored.sheetId), viewId: asElementId(restored.viewId) };
    case "drawing_item":
      return { ...restored, ownerId: asElementId(restored.ownerId) };
  }
}

function uniqueViewName(index: DocumentIndex, wanted: string, except: ElementId | null): void {
  const key = wanted.trim().toLowerCase();
  const clash = index.views.find((v) => v.id !== except && v.name.trim().toLowerCase() === key);
  if (clash) fail(`A view named "${clash.name}" already exists. Pick another name.`, [clash.id], "already_exists");
}

function uniqueSheetNumber(index: DocumentIndex, wanted: string, except: ElementId | null): void {
  const key = wanted.trim().toLowerCase();
  const clash = index.sheets.find((s) => s.id !== except && s.number.trim().toLowerCase() === key);
  if (clash) fail(`Sheet ${clash.number} already exists. Pick another number.`, [clash.id], "already_exists");
}

function nextCopyName(index: DocumentIndex, original: string): string {
  const names = new Set(index.views.map((v) => v.name.trim().toLowerCase()));
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${original} Copy` : `${original} Copy ${n}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${original} Copy ${Date.now()}`;
}

/** Cross-element rules after the change: one sheet per view, viewports and drawing items on live owners. Reads only what changed plus the head's index. */
function documentIssue(base: ModelState, after: ModelState, touched: readonly ElementId[]): ExecuteResult | null {
  // Only a placed viewport can put a view on two sheets; skip the index otherwise.
  const viewportTouched = touched.some((id) => after.elements[id]?.kind === "viewport");
  const viewportByView = new Map(viewportTouched ? documentIndex(base).viewportByView : []);
  for (const elementId of touched) {
    const el = after.elements[elementId];
    if (el?.kind !== "viewport") continue;
    for (const [viewId, vp] of viewportByView) if (vp.id === el.id) viewportByView.delete(viewId);
  }
  for (const elementId of touched) {
    const el = after.elements[elementId];
    if (el?.kind !== "viewport" || el.deleted) continue;
    const other = viewportByView.get(el.viewId);
    if (other && other.id !== el.id) {
      const view = after.elements[el.viewId];
      return refusal(`View "${view?.kind === "view" ? view.name : el.viewId}" is already on another sheet.`, [el.id], "in_use");
    }
    viewportByView.set(el.viewId, el);
  }
  for (const elementId of touched) {
    const el = after.elements[elementId];
    if (!el || ("deleted" in el && el.deleted)) continue;
    if (el.kind === "viewport") {
      const sheet = after.elements[el.sheetId];
      const view = after.elements[el.viewId];
      if (!sheet || sheet.kind !== "sheet" || sheet.deleted) return refusal("That viewport's sheet no longer exists.", [el.id]);
      if (!view || view.kind !== "view" || view.deleted) return refusal("That viewport's view no longer exists.", [el.id]);
    }
    if (el.kind === "drawing_item") {
      const owner = after.elements[el.ownerId];
      if (!owner || ("deleted" in owner && owner.deleted)) return refusal("The sheet or detail view this was drawn in no longer exists.", [el.id]);
    }
  }
  return null;
}

function refusal(message: string, ids: readonly ElementId[], code: "invalid_value" | "in_use" = "invalid_value"): ExecuteResult {
  return { ok: false, error: { code, message, elementIds: ids } };
}
