import {
  DETAIL_LINE_STYLES,
  HATCH_PATTERNS,
  KEYNOTE_FIELD,
  LINE_PATTERNS,
  LINE_WEIGHTS_2D,
  ONE_LINE_TEXT_MM,
  autoDimensionCommand,
  builtinFormTemplate,
  detailComponents,
  formScheduleKinds,
  isBoundFormKind,
  fieldProviderRegistry,
  layoutOneLine,
  oneLineCommands,
  oneLineCropCommand,
  planAutoTags,
  sheetLayoutCommand,
  type AutoTagCategory,
  type Command,
  type DiagramHints,
  type DiagramKind,
  type ModelState,
  type OneLineSpec,
  type ScheduleColumnDef,
  type ScheduleDefinition,
  type ScheduleDefinitionV2,
  type ScheduleFilter,
  type ScheduleGroup,
  type ScheduleSort,
  type ViewElement,
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

/** A one-line (or riser) diagram in a new drafting view: drawn from a distribution you describe, or live from the model. */
export type OneLineDiagramSpec =
  | { readonly name: string; readonly diagram: OneLineSpec; readonly id?: string }
  | { readonly name: string; readonly live: DiagramKind; readonly hints?: DiagramHints; readonly id?: string };

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
  readonly id?: string;
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

export interface SheetSpec {
  /** The sheet number people read ("M-101"). */
  readonly number: string;
  readonly name: string;
  readonly titleBlock?: CreateSheet["titleBlock"];
  /** Title block fields by name (drawn by, checked by, …). */
  readonly fields?: CreateSheet["fields"];
  readonly id?: string;
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
  /** Categories the view hides. */
  readonly hide?: ViewProps["hiddenCategories"];
  readonly id?: string;
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
    ...(spec.hide ? { hiddenCategories: spec.hide } : {}),
  };
  const viewId = spec.id ?? ctx.id("view");
  ctx.edit({ type: "create_view", viewId, name: spec.name, viewType, props });
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
  /** A copy of a view (a second plan of the same level for another discipline); returns the new id. */
  duplicateView(ctx: ScriptContext, viewId: string, name: string, id?: string): string {
    const newViewId = id ?? ctx.id("view");
    ctx.edit({ type: "duplicate_view", viewId, newViewId, name });
    return newViewId;
  },
  /** Puts a view (a plan, a schedule, a detail) on a sheet; returns the viewport's id. */
  place(ctx: ScriptContext, sheetId: string, viewId: string, at: SheetPoint, scale?: number): string {
    const viewportId = ctx.id("vp");
    ctx.edit({ type: "place_viewport", viewportId, sheetId, viewId, center: { x: mm(at.x, "Viewport x"), y: mm(at.y, "Viewport y") }, ...(scale ? { scale } : {}) });
    return viewportId;
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
  /** A one-line or riser diagram in a new drafting view; returns the view's id. Put it on a sheet with `documents.place`. */
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
    ctx.edit({
      type: "add_drawing_item",
      itemId,
      ownerId: spec.view,
      shape: "tag",
      points: [{ x: mm(spec.at.x, "Tag x"), y: mm(spec.at.y, "Tag y") }],
      tag: { elementId: spec.element, template: spec.template ?? (spec.fields ? "fields" : "auto"), leader: spec.leader ?? true, ...(spec.fields ? { fields: [...spec.fields] } : {}) },
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
  /** Changes a tag style's look: lines, box, orientation, applies-to or its arrow (`"none"` removes it). */
  setTagStyle(ctx: ScriptContext, styleId: string, changes: TagStyleChanges): void {
    ctx.edit({ type: "update_tag_style", styleId, ...changes });
  },
  /** Gives elements a keynote (its key, "P1"): a keynote tag on a view prints it and the sheet's keynote list words it. */
  keynote(ctx: ScriptContext, elementIds: readonly string[], key: string): void {
    ctx.edit({ type: "set_element_values", elementIds: [...elementIds], values: { [KEYNOTE_FIELD]: key } });
  },
};
