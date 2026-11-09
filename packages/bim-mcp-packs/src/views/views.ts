import { createHash } from "node:crypto";
import { ensureBimChartKinds } from "@permitzip/bim-editor/contracts/bim/chart-kinds";
import { agentSheetTitle } from "./sheet-title";
import type { FirmClassesSource, ViewToolsHost } from "./capabilities";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_CUT_HEIGHT_MM,
  DEFAULT_NOTE_SIZE_MM,
  DRAFTING_CATEGORIES,
  LINE_WEIGHTS,
  VIEW_CATEGORIES,
  NOTE_LIMITS,
  STANDARD_SCALES,
  buildSheetSceneFor,
  canonicalJson,
  parseBranchModelId,
  commandIssueMessage,
  commandSchema,
  documentIndex,
  executeCommand,
  isBatchCommand,
  isViewCommand,
  noteContentFingerprint,
  noteText,
  paragraphsForCommand,
  resolveNote,
  scaleLabel,
  type BatchCommand,
  type CategoryLineWeights,
  type Command,
  type DrawingItem,
  type LineWeight,
  type ModelState,
  type ViewCategory,
  type ViewCommand,
  type ViewElement,
  type ViewProps,
  evaluateDiagram,
  isBlockCommand,
  renderFieldBlock,
  spaceCommandSchema,
  LOAD_SUMMARY_TEMPLATE,
  LOAD_SUMMARY_TITLE,
  type BlockCommand,
  type SpaceDesignCommand,
  type LoadPointCommand,
  blockTableKindSchema,
  blockTableTitle,
  isQuestionCommand,
  type QuestionCommand,
  buildCategoryRegistry,
  builtinCategoryRegistry,
  overridesOutsideRegistry,
  sheetViewports,
  withCategoryRegistry,
  SYSTEM_LINE_PATTERNS,
  type CategoryOverride,
  type CategoryOverrides,
  type CategoryRegistry,
} from "@permitzip/bim-kernel";
import {
  isVerticalRunCommand,
  type VerticalRunCommand,
} from "@permitzip/bim-pack-plumbing";
import path from "node:path";
import { nodeNoteFonts, renderSheetPdf, sheetPrintNotes } from "@permitzip/bim-sheets";
import type { LinkedModelIndex } from "@permitzip/bim-lint";
import { isPlanView, planFitCrop } from "../support/linked-fit-crop";
import { noteContentInput, noteParagraphs } from "../support/note-input";
import { documentCommandFromAgent } from "../support/document-units";
import { baseRevision, explain, failure, notSent, runEdit, target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import { previewQuestionCommand } from "../support/question-preview";
import { resolveAreaLevel } from "@permitzip/bim-mcp";
import { view3dSummary } from "../support/view3d-summary";
import { linkedModelsInput, linkedModelsPatch, linkedModelsSummary } from "../support/linked-display-input";

/**
 * Views and sheets tools for agents: the same kernel commands the Building
 * Model's views and sheets panel sends, through the same model authority, as
 * the person's own agent identity. Edits pause for approval in Cmd+J; a
 * preview tool runs any of them against the latest revision without saving.
 */

ensureBimChartKinds();

const MM_PER_FT = 304.8;
/** The note fonts, from the repository root (a host that bundles the server must ship this folder with it). */
export const NOTE_FONTS_DIR = path.join(process.cwd(), "packages/bim-sheets/fonts");

export type { StoreSheetPdf } from "./capabilities";

const ft = (v: number) => v * MM_PER_FT;
export const pointFt = z.object({ x: z.number().finite(), y: z.number().finite() });
export const scaleInput = z
  .number()
  .positive()
  .max(10000)
  .optional()
  .describe(`Drawing scale as model units per paper unit: ${STANDARD_SCALES.map((s) => `${s.scale} = ${s.label}`).join(", ")}.`);

const IN = 25.4;

/** A note as an agent reads it: id, full text, box, and the fingerprint bim_edit_text_note must name. */
function noteSummary(item: DrawingItem) {
  const resolved = resolveNote(item);
  return {
    id: item.id,
    text: resolved ? noteText(resolved.note.paragraphs) : (item.text ?? ""),
    rich: Boolean(item.note),
    width_in: resolved ? Math.round((resolved.note.box.width / IN) * 100) / 100 : null,
    expected_content: noteContentFingerprint(item),
  };
}

/** Lines, rectangles, revision clouds and dimensions, by id, so an agent can move or delete them. */
function drawingSummary(items: readonly DrawingItem[]) {
  return items.filter((i) => i.shape !== "text" && i.shape !== "field_block").map((i) => ({ id: i.id, shape: i.shape, points_mm: i.points }));
}

/** Live field blocks (load summary…) on a sheet: what each says now and which fields don't resolve. */
function blockSummary(model: ModelState, items: readonly DrawingItem[]) {
  return items.flatMap((i) => {
    if (i.shape !== "field_block" || !i.block) return [];
    const r = renderFieldBlock(model, i.block);
    return [{ id: i.id, title: i.block.title ?? null, table_kind: i.block.table?.kind ?? null, subject_id: i.block.subjectId ?? null, at_mm: i.points[0] ?? null, text: r.text, ...(r.unresolved.length > 0 ? { unresolved: r.unresolved } : {}) }];
  });
}

/** Same call, same new id: a retried create never makes a second view or sheet. */
export function stableId(prefix: string, extra: Extra, args: unknown): string {
  const who = extra.authInfo?.clientId ?? "agent";
  return `${prefix}-${createHash("sha256").update(canonicalJson({ who, args })).digest("hex").slice(0, 16)}`;
}

export function findSheet(model: ModelState, sheet: string): string | null {
  const index = documentIndex(model);
  const key = sheet.trim().toLowerCase();
  return index.sheets.find((s) => s.id === sheet || s.number.trim().toLowerCase() === key)?.id ?? null;
}

export function findView(model: ModelState, view: string): string | null {
  const index = documentIndex(model);
  const key = view.trim().toLowerCase();
  return index.views.find((v) => v.id === view || v.name.trim().toLowerCase() === key)?.id ?? null;
}

/** A views/sheets command or a batch of them, a live sheet block, or a space/zone/underlay command, as the preview and apply tools take it. */
export type DocumentCommand = ViewCommand | BatchCommand | BlockCommand | SpaceDesignCommand | LoadLifecycleCommand | QuestionCommand | VerticalRunCommand;

/** The load lifecycle as one concept for every trade: estimates on spaces, moves that keep the id, sources, the allocation policy. */
type LoadLifecycleCommand = Extract<LoadPointCommand, { type: "create_load" | "move_load" | "split_load" | "edit_load_point" | "set_load_allocation_policy" }>;
const LOAD_COMMAND_TYPES: ReadonlySet<string> = new Set(["create_load", "move_load", "split_load", "edit_load_point", "set_load_allocation_policy"]);

function isLoadLifecycleCommand(command: { readonly type: string }): command is LoadLifecycleCommand {
  return LOAD_COMMAND_TYPES.has(command.type);
}

const SPACE_COMMAND_TYPES: ReadonlySet<string> = new Set(spaceCommandSchema.options.map((o) => o.shape.type.value));

function isSpaceDesignCommand(command: { readonly type: string }): command is SpaceDesignCommand {
  return SPACE_COMMAND_TYPES.has(command.type);
}

/** add_field_block without a template is the load summary; at_in is paper inches. */
function blockDefaults(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record: Record<string, unknown> = { ...input };
  if (record.type !== "add_field_block") return input;
  if (record.at_in !== undefined) {
    if (record.at !== undefined) return record;
    const at = pointFt.safeParse(record.at_in);
    if (!at.success) return record;
    delete record.at_in;
    record.at = { x: at.data.x * IN, y: at.data.y * IN };
  }
  const block: Record<string, unknown> = typeof record.block === "object" && record.block !== null && !Array.isArray(record.block) ? { ...record.block } : {};
  const table = block.table;
  if (typeof table === "object" && table !== null && !Array.isArray(table)) {
    // A ventilation or pressurization table: the whole model unless a scope is named; its title doubles as the editor caption.
    const spec: Record<string, unknown> = { ...table };
    if (spec.scope === undefined && spec.kind !== "keynotes") spec.scope = { kind: "model" };
    const kind = blockTableKindSchema.safeParse(spec.kind);
    const title = kind.success ? blockTableTitle(kind.data) : undefined;
    record.block = { ...(title ? { template: title, title } : {}), ...block, table: spec };
    return record;
  }
  if (!("template" in block)) record.block = { template: LOAD_SUMMARY_TEMPLATE, title: LOAD_SUMMARY_TITLE, ...block };
  return record;
}

/** Parse an agent's command (feet and inches as the standalone tools take them, or kernel millimetres); a string is the plain reason it isn't one. */
export function parseDocumentCommand(input: unknown): DocumentCommand | string {
  const converted = documentCommandFromAgent(blockDefaults(input));
  if (!converted.ok) return notSent(converted.message);
  const parsed = commandSchema.safeParse(converted.command);
  if (!parsed.success) return notSent(commandIssueMessage(parsed.error, converted.command));
  const command = parsed.data;
  if (isBatchCommand(command) || isViewCommand(command) || isBlockCommand(command) || isSpaceDesignCommand(command) || isLoadLifecycleCommand(command) || isQuestionCommand(command) || isVerticalRunCommand(command)) return command;
  return `${command.type} isn't a views or sheets command (nor a live block, space, load or question one); use the model edit tools for it.`;
}

/**
 * Names exactly one change against one revision. The apply tool recomputes it,
 * so what is saved is byte-for-byte what was previewed and approved.
 */
export function documentPreviewToken(modelId: string, command: DocumentCommand, revision: number, branchId: string | null = null): string {
  // A branch forked at Rev N has Main's revision N too: the branch is part of what was previewed (Main's tokens are unchanged).
  return createHash("sha256").update(canonicalJson(branchId ? { modelId, branchId, command, revision } : { modelId, command, revision })).digest("hex").slice(0, 32);
}

/** The branch a session's model is (null: Main), for preview tokens. */
export function previewBranchOf(model: Pick<ModelState, "modelId">): string | null {
  return parseBranchModelId(model.modelId)?.branchId ?? null;
}

/**
 * Null when `token` is this change previewed on the branch (or Main) the
 * thread edits now; otherwise why not, in words. `otherwise`: the tool's own
 * words for a different command or revision.
 */
export function previewTokenProblem(input: { readonly modelId: string; readonly branchId: string | null; readonly command: DocumentCommand; readonly revision: number; readonly token: string; readonly otherwise: string }): string | null {
  const { modelId, branchId, command, revision, token } = input;
  if (documentPreviewToken(modelId, command, revision, branchId) === token) return null;
  if (branchId && documentPreviewToken(modelId, command, revision) === token) return PREVIEWED_ON_MAIN;
  return input.otherwise;
}

export const PREVIEWED_ON_MAIN = "Not saved: this change was previewed on Main, but this thread now edits a branch, so it would land somewhere other than what was approved. Nothing changed. Preview it again on the branch and apply with the new preview_token.";

const PREVIEW_CHANGE_LIMIT = 200;

/** What a views/sheets change would do at the model's current revision, without saving it. `decide`: how the host decides it (a question command: the session's features and the agent's identity). */
export function previewDocumentEdit(model: ModelState, modelId: string, command: DocumentCommand, decide: (model: ModelState, command: DocumentCommand) => ReturnType<typeof executeCommand> = executeCommand) {
  const result = decide(model, command);
  if (!result.ok) return { status: "would_be_refused" as const, code: result.error.code, message: result.error.message, element_ids: result.error.elementIds, revision: model.revision };
  const changes = result.changedIds.map((elementId) => {
    const after = result.model.elements[elementId];
    return { element_id: elementId, kind: after?.kind ?? null, created: !model.elements[elementId], removed: Boolean(after && "deleted" in after && after.deleted) };
  });
  return {
    status: "would_save" as const,
    revision: model.revision,
    preview_token: documentPreviewToken(modelId, command, model.revision, previewBranchOf(model)),
    steps: isBatchCommand(command) ? command.commands.length : 1,
    ...(result.summary ? { summary: result.summary } : {}),
    changed_count: changes.length,
    changes: changes.slice(0, PREVIEW_CHANGE_LIMIT),
    ...(changes.length > PREVIEW_CHANGE_LIMIT ? { changes_truncated: changes.length - PREVIEW_CHANGE_LIMIT } : {}),
  };
}

const toFt = (mm: number) => Math.round((mm / 304.8) * 100) / 100;

/** A plan's top, cut, bottom and depth in feet above its level (null: no limit). */
function viewRangeSummary(v: ViewElement) {
  const p = v.props ?? {};
  return { top_ft: p.viewTopMm === undefined ? null : toFt(p.viewTopMm), cut_ft: toFt(p.cutHeightMm ?? DEFAULT_CUT_HEIGHT_MM), bottom_ft: p.viewBottomMm === undefined ? null : toFt(p.viewBottomMm), view_depth_ft: toFt(p.viewDepthMm ?? 0) };
}

type LineWeightInput = Partial<Record<ViewCategory, { cut?: LineWeight | null; beyond?: LineWeight | null } | null>>;

/** A view's pens after applying what the agent sent: given pens replace, null clears. */
export function lineWeightsPatch(current: ViewProps["lineWeights"], input: LineWeightInput): NonNullable<ViewProps["lineWeights"]> {
  const out: Partial<Record<ViewCategory, CategoryLineWeights>> = { ...(current ?? {}) };
  for (const c of VIEW_CATEGORIES) {
    if (!(c in input)) continue;
    const change = input[c];
    if (change === null || change === undefined) {
      delete out[c];
      continue;
    }
    const next: { cut?: LineWeight; projection?: LineWeight } = { ...(out[c] ?? {}) };
    if (change.cut !== undefined) {
      if (change.cut === null) delete next.cut;
      else next.cut = change.cut;
    }
    if (change.beyond !== undefined) {
      if (change.beyond === null) delete next.projection;
      else next.projection = change.beyond;
    }
    if (next.cut || next.projection) out[c] = next;
    else delete out[c];
  }
  return out;
}

/** A live diagram view: its kind and hints, what it draws now and any warnings (it is never stored line work). */
function liveDiagramSummary(model: ModelState, v: ViewElement) {
  const ev = evaluateDiagram(model.elements, v);
  return {
    kind: v.props?.diagram?.kind ?? "one_line",
    hints: v.props?.diagram?.hints ?? {},
    equipment: (ev?.boxes ?? []).map((b) => b.name),
    warnings: (ev?.warnings ?? []).map((w) => w.message),
  };
}

/** Views and sheets as an agent reads them: names, types, scales and where each view is placed. */
export function listViewsAndSheets(model: ModelState) {
  const index = documentIndex(model);
  const sheetNumber = new Map<string, string>(index.sheets.map((s) => [s.id, s.number]));
  return {
    revision: model.revision,
    views: index.views.map((v) => ({
      id: v.id,
      name: v.name,
      type: v.viewType,
      level: v.props?.level ?? null,
      scale: v.props?.scale ? scaleLabel(v.props.scale) : null,
      on_sheet: sheetNumber.get(index.viewportByView.get(v.id)?.sheetId ?? "") ?? null,
      ...(v.viewType === "detail" ? { notes: (index.itemsByOwner.get(v.id) ?? []).filter((i) => i.shape === "text").map(noteSummary), drawing: drawingSummary(index.itemsByOwner.get(v.id) ?? []) } : {}),
      ...(v.viewType === "schedule" && v.props?.schedule ? { schedule: v.props.schedule } : {}),
      ...(v.props?.diagram ? { live_diagram: liveDiagramSummary(model, v) } : {}),
      ...(v.viewType === "three_d" ? view3dSummary(model, v) : {}),
      ...(v.props?.references && Object.keys(v.props.references).length > 0 ? { linked_models: linkedModelsSummary(v.props.references) } : {}),
      ...(v.viewType === "floor_plan" || v.viewType === "ceiling_plan" ? { shows: viewRangeSummary(v) } : {}),
      ...(v.props?.lineWeights && Object.keys(v.props.lineWeights).length > 0 ? { line_weights: Object.fromEntries(Object.entries(v.props.lineWeights).map(([c, w]) => [c, { ...(w?.cut ? { cut: w.cut } : {}), ...(w?.projection ? { beyond: w.projection } : {}) }])) } : {}),
      ...(v.props?.categoryOverrides && Object.keys(v.props.categoryOverrides).length > 0 ? { category_overrides: categoryOverridesSummary(v.props.categoryOverrides) } : {}),
      ...(v.props?.linkedHiddenLines === false ? { linked_hidden_lines: false } : {}),
      ...(v.props?.linkedMinObjectMm ? { linked_min_object_in: Math.round((v.props.linkedMinObjectMm / 25.4) * 10) / 10 } : {}),
    })),
    sheets: index.sheets.map((s) => ({
      id: s.id,
      number: s.number,
      name: s.title,
      title_block: s.props?.titleBlock ?? "arch_d_mutinybim",
      fields: s.props?.fields ?? {},
      revisions: s.props?.revisions ?? [],
      viewports: (index.viewportsBySheet.get(s.id) ?? []).map((vp) => ({ id: vp.id, view_id: vp.viewId, scale: scaleLabel(vp.scale), center_mm: vp.center, size_mm: vp.size })),
      notes: (index.itemsByOwner.get(s.id) ?? []).filter((i) => i.shape === "text").map(noteSummary),
      drawing: drawingSummary(index.itemsByOwner.get(s.id) ?? []),
      blocks: blockSummary(model, index.itemsByOwner.get(s.id) ?? []),
    })),
  };
}

const categoryOverrideInput = z
  .object({
    visible: z.boolean(),
    halftone: z.boolean(),
    cut: z.enum(LINE_WEIGHTS).nullable(),
    beyond: z.enum(LINE_WEIGHTS).nullable(),
    pattern: z.enum(SYSTEM_LINE_PATTERNS),
    colour: z.string().regex(/^#[0-9a-f]{6}$/i, "a colour as #rrggbb"),
  })
  .partial()
  .strict();

type CategoryOverrideInput = z.infer<typeof categoryOverrideInput>;

/** A view's per-category graphics as the agent reads them back: `beyond` for the kernel's projection pen. */
function categoryOverridesSummary(overrides: CategoryOverrides) {
  return Object.fromEntries(
    Object.entries(overrides).map(([id, o]) => {
      const { lineWeights, ...rest } = o;
      return [id, { ...rest, ...(lineWeights?.cut ? { cut: lineWeights.cut } : {}), ...(lineWeights?.projection ? { beyond: lineWeights.projection } : {}) }];
    }),
  );
}

/** The view's overrides with the agent's patch merged in: fields replace, a null pen clears it, a null category clears that category. */
type ViewCategoryOverrides = NonNullable<Extract<Command, { type: "set_view_properties" }>["props"]["categoryOverrides"]>;

/**
 * The view's merged overrides as the command writes them (known patterns only). A stored pattern
 * from a newer peer can't be written back, so the edit is refused rather than dropping it.
 */
function writableOverrides(all: Readonly<Record<string, CategoryOverride>>): { readonly ok: true; readonly overrides: ViewCategoryOverrides } | { readonly ok: false; readonly id: string; readonly unknownPattern: string } {
  const out: ViewCategoryOverrides = {};
  for (const [id, o] of Object.entries(all)) {
    const { pattern, ...rest } = o;
    if (pattern === undefined) {
      out[id] = rest;
      continue;
    }
    const known = SYSTEM_LINE_PATTERNS.find((p) => p === pattern);
    if (!known) return { ok: false, id, unknownPattern: pattern };
    out[id] = { ...rest, pattern: known };
  }
  return { ok: true, overrides: out };
}

export function categoryOverridesPatch(current: CategoryOverrides | undefined, patch: Readonly<Record<string, CategoryOverrideInput | null>>): Record<string, CategoryOverride> {
  const out = new Map<string, CategoryOverride>(Object.entries(current ?? {}));
  for (const [id, o] of Object.entries(patch)) {
    if (o === null) {
      out.delete(id);
      continue;
    }
    const { cut, beyond, ...look } = o;
    const prior: CategoryOverride = out.get(id) ?? {};
    const { lineWeights: pens, ...prev } = prior;
    const pen = (given: LineWeight | null | undefined, had: LineWeight | undefined) => (given === null ? undefined : (given ?? had));
    const cutPen = pen(cut, pens?.cut);
    const beyondPen = pen(beyond, pens?.projection);
    const lineWeights = { ...(cutPen ? { cut: cutPen } : {}), ...(beyondPen ? { projection: beyondPen } : {}) };
    out.set(id, { ...prev, ...look, ...(cutPen || beyondPen ? { lineWeights } : {}) });
  }
  return Object.fromEntries(out);
}

/**
 * Category ids the caller's registry doesn't know: checked against the
 * built-in categories first, then the firm library's classes, so a typo is
 * refused instead of stored as an override that draws nothing.
 */
async function unknownCategories(extra: Extra, ids: readonly string[], firmClasses: FirmClassesSource): Promise<{ readonly unknown: readonly string[]; readonly registry: CategoryRegistry }> {
  const builtin = builtinCategoryRegistry();
  if (ids.every((id) => builtin.get(id))) return { unknown: [], registry: builtin };
  const library = await firmClasses(extra);
  if (library.warning) console.error("[bim_set_view_properties] firm library unavailable for category check", { warning: library.warning });
  const registry = buildCategoryRegistry({ classes: library.registry });
  return { unknown: ids.filter((id) => !registry.get(id)), registry };
}

function unknownCategoryMessage(unknown: readonly string[], registry: CategoryRegistry): string {
  const near = (id: string) => {
    const tail = (id.split(/[.:]/).pop() ?? id).toLowerCase();
    const stem = tail.slice(0, Math.max(4, tail.length - 2));
    return registry
      .list()
      .filter((c) => c.id.toLowerCase().includes(stem) || c.label.toLowerCase().includes(stem))
      .slice(0, 5)
      .map((c) => c.id);
  };
  return notSent(`no category ${unknown.map((id) => { const n = near(id); return `${id}${n.length > 0 ? ` (close: ${n.join(", ")})` : ""}`; }).join("; ")}`);
}

/** The categories a drawing resolves against, and why the firm's own are missing when they are. */
export interface DrawingCategories {
  readonly categories: CategoryRegistry;
  readonly note: string | null;
}

/**
 * Visibility/Graphics on a firm library class prints through the firm's
 * classes, read on the caller's own client. Every other drawing resolves the
 * same under the built-in categories, so the library is read only when one
 * of the drawn views overrides a category the kernel doesn't know.
 */
export async function drawingCategoriesFor(extra: Extra, views: readonly Pick<ViewElement, "props">[], firmClasses: FirmClassesSource): Promise<DrawingCategories> {
  if (!overridesOutsideRegistry(views)) return { categories: builtinCategoryRegistry(), note: null };
  try {
    const library = await firmClasses(extra);
    return { categories: buildCategoryRegistry({ classes: library.registry }), note: library.warning ? `${library.warning} Firm-class graphics printed as their parent category.` : null };
  } catch (err) {
    console.error("[bim drawings] the firm library could not be read for firm-class graphics; drawing with the built-in categories", { err });
    return { categories: builtinCategoryRegistry(), note: `The firm library couldn't be read (${err instanceof Error ? err.message : "unknown error"}), so firm-class graphics printed as their parent category.` };
  }
}

export function registerBimViewTools(server: McpServer, caller: ResolveBimCaller, host: ViewToolsHost) {
  const { storeSheetPdf, sheetTitle, firmClasses, sheetImages, linkedModels } = host;
  server.registerTool(
    "bim_list_views_and_sheets",
    {
      title: "List views and sheets",
      description: "Every view (plan, ceiling plan, section, 3D, detail view) with its level, scale and the sheet it is on, and every sheet with its viewports, notes and live blocks (text now, unresolved fields). Use before creating or placing so you reuse names and ids.",
      inputSchema: { ...target },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) => text(listViewsAndSheets(s.model())));
      } catch (err) {
        return explain(err, "bim_list_views_and_sheets");
      }
    },
  );

  server.registerTool(
    "bim_preview_views_sheets_edit",
    {
      title: "Preview a views or sheets change",
      description:
        "Preview one views/sheets command, or batch_documents { label, commands: [...] } (≤500, all or nothing, one approval), at the latest revision, unsaved: what would change or why it'd be refused, plus a preview_token. Save with bim_apply_views_sheets_edit: same command, base_revision = the returned revision, the token. Commands: create_view (schedules: props.schedule), create_3d_view, set_3d_view_camera, set_3d_crop_box, rename_view, duplicate_view, delete_view, set_view_properties (plans: props.circuitGraphics), set_view_crop, create_sheet, set_sheet_properties (incl. revisions), delete_sheet, place_viewport, move_viewport, resize_viewport, set_viewport_scale, set_viewport_north_arrow, remove_viewport, add/update/delete_drawing_item (shape callout: 3 points, callout.viewId), create/edit/resize/move/delete_text_note; live blocks: add_field_block { itemId, sheetId, at or at_in, block? } (no block: the load summary; block.table { kind: ventilation|pressurization|gas, scope? }: that table), edit_field_block; spaces: create_space, edit_space (estimateCounting max|actual_only|allocation_only|null), delete_spaces, make_spaces_from_rooms, place_space_in_walls { spaceId, levelId, seed } (a room from the walls around a point), split_space { spaceId, line, typedLoadsTo } (sub-rooms under the room; typedLoadsTo names the sub-room, e.g. 101A, that keeps loads not by area: required when it has any), merge_space_children { spaceId }, create/edit/delete_zone(s) (servedBy), place/calibrate/edit/delete_underlay(s); loads (any trade): create_load (anchor space/zone = estimate), move_load, split_load, edit_load_point (servedBy), set_load_allocation_policy; questions (no one has to answer; nothing is due): add_question { questions: [{ questionId, text, askOf, anchor: { elementIds }, type? assumption, blocksIssue?, askedBefore? }] }, answer_question { questionId, answer, status? assumed, outcome? judgment_recorded|design_revision, links? [{ kind: branch|determination, ref }] }, reply_question { questionId, text }, decline_question { questionId, note?, not_in_scope?, keep_closed? reason }, take_over_question { questionId }, forward_question { questionId, askOf }, set_question_status { questionIds, status withdrawn|open (declined: owner only) }, edit_question, delete_questions; stacks: name_stacks { stacks: [{ stackId, pipeId, number? }] }, edit_stack, delete_stacks, set_stack_checks { baseClearanceDiameters }. Kernel fields: mm (sheet positions, note sizes: paper). Standalone tools' names convert: crop_min_ft/crop_max_ft, far_clip_ft, cut_height_ft, top_ft, bottom_ft, view_depth_ft, center_in, size_in, level/scale atop create_view / set_view_properties. Unknown keys are refused by name.",
      inputSchema: { ...target, command: z.record(z.string(), z.unknown()).describe("The kernel command, e.g. { type: 'place_viewport', viewportId, sheetId, viewId, center: { x, y } }.") },
    },
    async (args, extra) => {
      try {
        const command = parseDocumentCommand(args.command);
        if (typeof command === "string") return failure(command);
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) =>
          text(previewDocumentEdit(s.model(), args.model_id, command, isQuestionCommand(command) ? (m, c) => previewQuestionCommand(m, c, who, s.upgradePolicy()) : executeCommand)),
        );
      } catch (err) {
        return explain(err, "bim_preview_views_sheets_edit");
      }
    },
  );

  server.registerTool(
    "bim_create_view",
    {
      title: "Create a view",
      description:
        "Create a floor plan or ceiling plan for a level, a section from a cut line (plan feet) with a look direction and depth, a 3D view, or a detail view (drawing-only: lines, text, dimensions). Returns the new view id. Refused with a plain reason if the name is taken or a plan has no level.",
      inputSchema: {
        ...target,
        ...baseRevision,
        name: z.string().trim().min(1).max(120),
        view_type: z.enum(["floor_plan", "ceiling_plan", "section", "three_d", "detail"]),
        level: z.string().min(1).max(40).optional().describe("Level name or id; required for floor and ceiling plans."),
        scale: scaleInput,
        cut_height_ft: z.number().min(0).max(100).optional(),
        section_start_ft: pointFt.optional(),
        section_end_ft: pointFt.optional(),
        section_looks: z.enum(["left", "right"]).optional().describe("Which side of start→end the section looks at."),
        section_depth_ft: z.number().positive().max(1000).optional(),
      },
    },
    async (args, extra) => {
      const viewId = stableId("view", extra, { ...args, base_revision: undefined });
      const section =
        args.view_type === "section"
          ? args.section_start_ft && args.section_end_ft
            ? {
                start: { x: ft(args.section_start_ft.x), y: ft(args.section_start_ft.y) },
                end: { x: ft(args.section_end_ft.x), y: ft(args.section_end_ft.y) },
                direction: args.section_looks === "right" ? (-1 as const) : (1 as const),
                depthMm: ft(args.section_depth_ft ?? 20),
              }
            : null
          : undefined;
      if (section === null) return failure("A section needs section_start_ft and section_end_ft (the cut line in plan feet).");
      const build = (level: string | undefined): Command => ({
        type: "create_view",
        viewId,
        name: args.name,
        viewType: args.view_type,
        props: {
          ...(level ? { level } : {}),
          ...(args.scale ? { scale: args.scale } : {}),
          ...(args.cut_height_ft !== undefined ? { cutHeightMm: ft(args.cut_height_ft) } : {}),
          ...(section ? { section } : {}),
        },
      });
      const ref = args.level;
      if (!ref) return runEdit(caller, "bim_create_view", extra, args, build(undefined));
      // The plan stores the level's canonical name, so a later rename of the level follows it.
      return editWithModel(caller, "bim_create_view", extra, args, (model) => {
        const level = resolveAreaLevel(model, ref);
        return level.ok ? build(level.name) : level.message;
      });
    },
  );

  server.registerTool(
    "bim_set_view_properties",
    {
      title: "Change a view's properties",
      description:
        "Set a view's scale, what a plan shows (top_ft, cut_height_ft, bottom_ft, view_depth_ft: our model and the linked models both follow them), line weights by category (line_weights; linked models take cut_line_weight / beyond_line_weight), linked-model simplification (linked_hidden_lines removes a chair under a table; linked_min_object_in leaves out small things), plan orientation (plan north, true north or the working angle up), discipline (others print halftone; null for all in ink), hidden categories, how each linked model draws (normal, halftone, transparent, underlay or hidden, a 3D see-through %, per-IFC-category exceptions; a person's working 3D view '{3D - name}' takes these too), detail level, or its crop box. The crop box is in feet in the view's own frame: plan x/y for plans and 3D views, along-the-cut distance by elevation for sections, drawing feet for detail views. crop_view off shows everything; show_crop_box only changes what editors see (the boundary never prints); annotation_crop lets notes and tags reach past the crop; far_clip_ft sets how far a section sees; fit_crop sizes the crop to the view's content (send it on its own). A placed view's viewport resizes with its crop. Give the view by id or exact name.",
      inputSchema: {
        ...target,
        ...baseRevision,
        view: z.string().min(1).max(200).describe("View id or exact name."),
        scale: scaleInput,
        cut_height_ft: z.number().min(0).max(100).optional(),
        discipline: z.enum(["architecture", "structure", "mechanical", "plumbing", "electrical", "fire_protection"]).nullable().optional(),
        hidden_categories: z.array(z.enum(["duct", "duct_fitting", "air_terminal", "equipment", "walls", "doors_windows", "rooms", "grids", "structure", "tags", "dimensions"])).optional(),
        hidden_drafting_categories: z.array(z.enum(DRAFTING_CATEGORIES)).optional().describe("Drafting this view hides: detail_lines, hatching, masking, components, insulation, text, dimensions, tags, clouds. [] shows all."),
        linked_models: linkedModelsInput.optional(),
        detail_level: z.enum(["coarse", "medium", "fine"]).optional(),
        crop_min_ft: pointFt.optional(),
        crop_max_ft: pointFt.optional(),
        fit_crop: z.literal(true).optional().describe("Size the crop box to the view's content (its level's model, or a detail view's drawing)."),
        keep_viewport_center: z.boolean().optional().describe("On a sheet: keep the viewport's centre instead of moving it so the model stays put on paper."),
        crop_view: z.boolean().optional().describe("Crop the view to its crop box (true) or show everything (false)."),
        show_crop_box: z.boolean().optional().describe("Show the crop box boundary to people editing. It never prints."),
        annotation_crop: z.boolean().optional().describe("Let notes, tags and dimensions reach past the crop box."),
        annotation_crop_offset_in: z.number().min(0).max(4).optional().describe("How far past the crop box notes may reach, paper inches (default 1/4)."),
        far_clip_ft: z.number().positive().max(1000).optional().describe("Sections only: how far beyond the cut line the section sees."),
        orientation: z.enum(["plan_north", "true_north", "working_angle"]).optional().describe("Plans only: draw with plan north up, turned so true north is up, or turned so the working angle (the building's walls) runs square to the paper (see bim_read_coordinates)."),
        projection: z.enum(["perspective", "orthographic"]).optional().describe("3D views only: how the live 3D view draws depth. Sheets print 3D views orthographic from their camera either way."),
        top_ft: z.number().min(0).max(200).nullable().optional().describe("Plans only: the top of what the view shows, feet above its level (at or above the cut). null: no limit (ductwork above the cut still shows)."),
        bottom_ft: z.number().min(-100).max(100).nullable().optional().describe("Plans only: the bottom of what the view shows, feet above its level (negative is below; at or below the cut). Our model and the linked models drop what lies wholly below bottom minus view_depth_ft. null: no limit."),
        view_depth_ft: z.number().min(0).max(100).optional().describe("Plans only: how far below the bottom it still sees. Sets the bottom at the level when no bottom is set yet."),
        line_weights: z
          .partialRecord(z.enum(VIEW_CATEGORIES), z.object({ cut: z.enum(LINE_WEIGHTS).nullable().optional(), beyond: z.enum(LINE_WEIGHTS).nullable().optional() }).strict().nullable())
          .optional()
          .describe('Pens by category where cut and where seen beyond, e.g. {"duct": {"beyond": "wide"}, "walls": {"cut": "heavy"}}. null clears a pen (or the whole category) back to the drawing default. Linked models take cut_line_weight / beyond_line_weight under linked_models.'),
        linked_hidden_lines: z.boolean().optional().describe("Drawings: remove linked-model lines hidden under nearer elements (a chair under a table). Default on."),
        linked_min_object_in: z.number().min(0).max(120).optional().describe("Drawings: leave out linked furniture, fixtures and other non-cut things smaller than this across, inches. 0 draws everything."),
        category_overrides: z
          .record(z.string().min(1).max(120), categoryOverrideInput.nullable())
          .optional()
          .describe("Visibility/Graphics by category id (a view category like duct, a class like mep.receptacle incl. firm and add-on classes, service:<id>, drafting:<id>): show, halftone, pens, pattern, colour. Merged into the view's; null clears a category."),
      },
    },
    async (args, extra) => {
      const linkedForFit = args.fit_crop ? await linkedIndexesForFit(linkedModels, extra, args.project_id) : [];
      if (typeof linkedForFit === "string") return failure(linkedForFit);
      if (args.category_overrides) {
        try {
          const checked = await unknownCategories(extra, Object.keys(args.category_overrides), firmClasses);
          if (checked.unknown.length > 0) return failure(unknownCategoryMessage(checked.unknown, checked.registry));
        } catch (err) {
          return explain(err, "bim_set_view_properties");
        }
      }
      const categoryOverrides = args.category_overrides;
      return editWithModel(caller, "bim_set_view_properties", extra, args, (model) => {
        const viewId = findView(model, args.view);
        if (!viewId) return `No view named or numbered "${args.view}". List views and sheets first.`;
        if ((args.crop_min_ft === undefined) !== (args.crop_max_ft === undefined)) return "Give both crop_min_ft and crop_max_ft, the crop box's opposite corners.";
        const crop =
          args.crop_min_ft && args.crop_max_ft
            ? { min: { x: ft(args.crop_min_ft.x), y: ft(args.crop_min_ft.y) }, max: { x: ft(args.crop_max_ft.x), y: ft(args.crop_max_ft.y) } }
            : undefined;
        const current = model.elements[viewId];
        const merged = categoryOverrides ? writableOverrides(categoryOverridesPatch(current?.kind === "view" ? current.props?.categoryOverrides : undefined, categoryOverrides)) : null;
        if (merged && !merged.ok)
          return `This view's ${merged.id} graphics use a line pattern ("${merged.unknownPattern}") from a newer version of MutinyBIM, so its graphics can't be saved here. Set that category's pattern to one of ${SYSTEM_LINE_PATTERNS.join(", ")}, or open the view in the newer version.`;
        const overrides = merged?.overrides;
        const props = {
          ...(args.scale ? { scale: args.scale } : {}),
          ...(args.cut_height_ft !== undefined ? { cutHeightMm: ft(args.cut_height_ft) } : {}),
          ...(args.discipline !== undefined ? { discipline: args.discipline } : {}),
          ...(args.hidden_categories ? { hiddenCategories: args.hidden_categories } : {}),
          ...(args.hidden_drafting_categories ? { hiddenDraftingCategories: args.hidden_drafting_categories } : {}),
          ...(args.linked_models ? { references: linkedModelsPatch(current?.kind === "view" ? current.props?.references : undefined, args.linked_models) } : {}),
          ...(args.detail_level ? { detailLevel: args.detail_level } : {}),
          ...(args.orientation ? { orientation: args.orientation } : {}),
          ...(args.projection ? { projection: args.projection } : {}),
          ...(args.top_ft !== undefined ? { viewTopMm: args.top_ft === null ? null : ft(args.top_ft) } : {}),
          ...(args.bottom_ft !== undefined ? { viewBottomMm: args.bottom_ft === null ? null : ft(args.bottom_ft) } : {}),
          ...(args.view_depth_ft !== undefined ? { viewDepthMm: ft(args.view_depth_ft), ...(args.bottom_ft === undefined && current?.kind === "view" && current.props?.viewBottomMm === undefined ? { viewBottomMm: 0 } : {}) } : {}),
          ...(args.line_weights ? { lineWeights: lineWeightsPatch(current?.kind === "view" ? current.props?.lineWeights : undefined, args.line_weights) } : {}),
          ...(args.linked_hidden_lines !== undefined ? { linkedHiddenLines: args.linked_hidden_lines } : {}),
          ...(args.linked_min_object_in !== undefined ? { linkedMinObjectMm: args.linked_min_object_in * 25.4 } : {}),
          ...(overrides ? { categoryOverrides: overrides } : {}),
        };
        const cropOnly = Object.keys(props).length === 0;
        if (args.fit_crop && (!cropOnly || crop)) return "Fit the crop box on its own call, without other properties or a crop box.";
        // Crop-only edits go through set_view_crop, which also handles fit and the section's far clip.
        if (cropOnly) {
          // A plan's fit counts the linked models it draws; the model server's fit sees only ours.
          const target = model.elements[viewId];
          const planFit = args.fit_crop && target?.kind === "view" && isPlanView(target) ? planFitCrop(model, target, linkedForFit) : null;
          if (typeof planFit === "string") return planFit;
          return {
            type: "set_view_crop",
            viewId,
            ...(crop ? { crop } : planFit ? { crop: planFit } : {}),
            ...(args.fit_crop && !planFit ? { fit: true as const } : {}),
            ...(args.crop_view !== undefined ? { cropView: args.crop_view } : {}),
            ...(args.show_crop_box !== undefined ? { showCropBox: args.show_crop_box } : {}),
            ...(args.annotation_crop !== undefined ? { annotationCrop: args.annotation_crop } : {}),
            ...(args.annotation_crop_offset_in !== undefined ? { annotationCropOffsetMm: args.annotation_crop_offset_in * 25.4 } : {}),
            ...(args.far_clip_ft !== undefined ? { farClipMm: ft(args.far_clip_ft) } : {}),
            ...(args.keep_viewport_center ? { keepViewportCenter: true } : {}),
          };
        }
        const view = model.elements[viewId];
        const section = view?.kind === "view" ? view.props?.section : undefined;
        if (args.far_clip_ft !== undefined && !section) return "Only sections have a far clip depth.";
        return {
          type: "set_view_properties",
          viewId,
          props: {
            ...props,
            ...(args.crop_view !== undefined ? { cropView: args.crop_view } : {}),
            ...(args.show_crop_box !== undefined ? { showCropBox: args.show_crop_box } : {}),
            ...(args.annotation_crop !== undefined ? { annotationCrop: args.annotation_crop } : {}),
            ...(args.annotation_crop_offset_in !== undefined ? { annotationCropOffsetMm: args.annotation_crop_offset_in * 25.4 } : {}),
            ...(args.far_clip_ft !== undefined && section ? { section: { ...section, depthMm: ft(args.far_clip_ft) } } : {}),
          },
          ...(crop ? { crop } : {}),
          ...(args.keep_viewport_center ? { keepViewportCenter: true } : {}),
        };
      }, categoryOverrides ? (_model, command) => (command.type === "set_view_properties" && command.props.categoryOverrides ? { category_overrides: categoryOverridesSummary(command.props.categoryOverrides) } : null) : undefined);
    },
  );

  server.registerTool(
    "bim_create_sheet",
    {
      title: "Create a sheet",
      description: "Create a sheet with a number, name, title block (ARCH D 36x24 by default, or ANSI B 17x11) and title block fields (client, address, drawn_by, checked_by, date, status). Refused if the number is taken.",
      inputSchema: {
        ...target,
        ...baseRevision,
        number: z.string().trim().min(1).max(40),
        name: z.string().trim().min(1).max(200),
        title_block: z.enum(["arch_d_mutinybim", "ansi_b_mutinybim"]).optional(),
        fields: z.record(z.string().min(1).max(40), z.string().max(200)).optional(),
      },
    },
    async (args, extra) =>
      runEdit(caller, "bim_create_sheet", extra, args, {
        type: "create_sheet",
        sheetId: stableId("sheet", extra, { ...args, base_revision: undefined }),
        number: args.number,
        name: args.name,
        ...(args.title_block ? { titleBlock: args.title_block } : {}),
        ...(args.fields ? { fields: args.fields } : {}),
      }),
  );

  server.registerTool(
    "bim_place_viewport",
    {
      title: "Place a view on a sheet",
      description:
        "Place a view on a sheet as a viewport, centred at a paper position in inches from the sheet's top-left, at the view's scale or the one given. A view goes on one sheet only; the refusal names the sheet it is already on.",
      inputSchema: {
        ...target,
        ...baseRevision,
        sheet: z.string().min(1).max(200).describe("Sheet id or number, e.g. M-101."),
        view: z.string().min(1).max(200).describe("View id or exact name."),
        center_in: pointFt.describe("Viewport centre on paper, inches from the top-left corner."),
        scale: scaleInput,
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_place_viewport", extra, args, (model) => {
        const sheetId = findSheet(model, args.sheet);
        const viewId = findView(model, args.view);
        if (!sheetId) return `No sheet "${args.sheet}". List views and sheets first.`;
        if (!viewId) return `No view "${args.view}". List views and sheets first.`;
        return {
          type: "place_viewport",
          viewportId: stableId("vp", extra, { sheetId, viewId }),
          sheetId,
          viewId,
          center: { x: args.center_in.x * 25.4, y: args.center_in.y * 25.4 },
          ...(args.scale ? { scale: args.scale } : {}),
        };
      }),
  );

  server.registerTool(
    "bim_add_sheet_note",
    {
      title: "Add a note to a sheet",
      description:
        "Write a note on a sheet: a box at a paper position (inches from the top-left) that wraps its text at width_in. Plain text, or rich paragraphs with bold, italic, underline, bullets, numbered lists (with levels), alignment and per-run text height. It prints exactly as people see it. Use bim_preview_views_sheets_edit with create_text_note to check it first. Characters outside letters, numbers and drafting symbols are refused with the reason.",
      inputSchema: {
        ...target,
        ...baseRevision,
        sheet: z.string().min(1).max(200).describe("Sheet id or number."),
        ...noteContentInput,
        at_in: pointFt.describe("The note box's top-left corner on paper, inches from the sheet's top-left."),
        width_in: z.number().min(NOTE_LIMITS.minWidthMm / IN).max(NOTE_LIMITS.maxWidthMm / IN).optional().describe('Box width in inches; text wraps at it (default 4").'),
        height_in: z.number().min(NOTE_LIMITS.minHeightMm / IN).max(NOTE_LIMITS.maxHeightMm / IN).optional().describe("Fixed box height in inches; text that doesn't fit isn't printed. Absent: grows with the text."),
        rotation_deg: z.number().min(-360).max(360).optional().describe("Turn the note clockwise about its top-left corner."),
        leader_to_in: pointFt.optional().describe("Point a leader arrow from the note to this paper position (inches from the top-left)."),
        text_height_in: z.number().positive().max(1).optional().describe('Default cap height in inches (default 3/32").'),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_add_sheet_note", extra, args, (model) => {
        const sheetId = findSheet(model, args.sheet);
        if (!sheetId) return `No sheet "${args.sheet}". List views and sheets first.`;
        const paragraphs = noteParagraphs(args);
        if (typeof paragraphs === "string") return paragraphs;
        return {
          type: "create_text_note",
          itemId: stableId("note", extra, { ...args, base_revision: undefined }),
          ownerId: sheetId,
          at: { x: args.at_in.x * IN, y: args.at_in.y * IN },
          width: (args.width_in ?? 4) * IN,
          ...(args.height_in !== undefined ? { height: args.height_in * IN } : {}),
          ...(args.rotation_deg !== undefined ? { rotation: args.rotation_deg } : {}),
          ...(args.leader_to_in ? { leader: { x: args.leader_to_in.x * IN, y: args.leader_to_in.y * IN } } : {}),
          textSize: args.text_height_in !== undefined ? args.text_height_in * IN : DEFAULT_NOTE_SIZE_MM,
          paragraphs: paragraphsForCommand(paragraphs),
        };
      }),
  );

  server.registerTool(
    "bim_edit_text_note",
    {
      title: "Edit a note's text",
      description:
        "Replace a note's whole text (on a sheet or in a detail view) with plain text or rich paragraphs, keeping its box and position. Pass expected_content from bim_list_views_and_sheets: if anyone changed the note's words since you read it, nothing is saved and the result says so. Read again and re-plan.",
      inputSchema: {
        ...target,
        ...baseRevision,
        note: z.string().min(1).max(200).describe("The note's id, from bim_list_views_and_sheets."),
        expected_content: z.string().min(1).max(64).describe("The note's expected_content from bim_list_views_and_sheets."),
        ...noteContentInput,
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_edit_text_note", extra, args, (model) => {
        const item = model.elements[args.note];
        if (item?.kind !== "drawing_item" || item.shape !== "text" || item.deleted) return `No note "${args.note}". List views and sheets first.`;
        const paragraphs = noteParagraphs(args);
        if (typeof paragraphs === "string") return paragraphs;
        return { type: "edit_text_note", itemId: item.id, expectedContent: args.expected_content, paragraphs: paragraphsForCommand(paragraphs) };
      }),
  );

  server.registerTool(
    "bim_print_sheet_pdf",
    {
      title: "Print a sheet to PDF",
      description:
        "Draw one sheet from the last saved revision of the model to a vector PDF at true scale and return a download link valid for 5 minutes, with the revision printed and the file's sha256. It prints what is saved; edits still in flight are not included. print_notes: viewports past the drawing area, labels the PDF font printed as plain text (1⅜ as 1-3/8). Does not issue the sheet.",
      inputSchema: { ...target, sheet: z.string().min(1).max(200).describe("Sheet id or number.") },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const titleBlock = await agentSheetTitle(sheetTitle, extra, args.project_id);
        const printed = await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const sheetId = findSheet(model, args.sheet);
          if (!sheetId) return null;
          const sheet = model.elements[sheetId];
          const number = sheet?.kind === "sheet" ? sheet.number : args.sheet;
          const graphics = await drawingCategoriesFor(extra, sheet?.kind === "sheet" ? sheetViewports(model, sheet).map((v) => v.view) : [], firmClasses);
          const scene = withCategoryRegistry(graphics.categories, () => buildSheetSceneFor(model, sheetId, { projectName: titleBlock.projectName, projectNumber: titleBlock.projectNumber, firmName: titleBlock.firmName }));
          const snapshotSha256 = createHash("sha256").update(canonicalJson({ modelId: model.modelId, revision: model.revision, sheetId })).digest("hex");
          const pdf = await renderSheetPdf(scene, { title: `${number}`, modelRevision: model.revision, snapshotSha256, renderer: "mutinybim-mcp" }, nodeNoteFonts(NOTE_FONTS_DIR), sheetImages(extra, args.project_id));
          return { number, revision: model.revision, bytes: pdf.bytes, notes: sheetPrintNotes(model, sheetId, number, pdf), graphicsNote: graphics.note };
        });
        if (!printed) return failure(`No sheet "${args.sheet}". List views and sheets first.`);
        const sha256 = createHash("sha256").update(printed.bytes).digest("hex");
        const safe = printed.number.replace(/[^\w.-]/g, "_");
        const path = `projects/${args.project_id}/building-model/sheets/${safe}-rev${printed.revision}-${sha256.slice(0, 12)}.pdf`;
        const stored = await storeSheetPdf(extra, args.project_id, path, printed.bytes);
        return text({
          status: "printed",
          message: `Printed sheet ${printed.number} from saved Rev ${printed.revision}. The link works for ${Math.round(stored.expiresInSeconds / 60)} minutes.`,
          sheet: printed.number,
          revision: printed.revision,
          sha256,
          bytes: printed.bytes.byteLength,
          download_url: stored.downloadUrl,
          ...(titleBlock.note ? { title_block_note: titleBlock.note } : {}),
          ...(printed.notes.length > 0 ? { print_notes: printed.notes } : {}),
          ...(printed.graphicsNote ? { graphics_note: printed.graphicsNote } : {}),
        });
      } catch (err) {
        return explain(err, "bim_print_sheet_pdf");
      }
    },
  );
}

/** An edit whose command needs the current model (names → ids); a string is a plain refusal before anything is sent. */
/** The linked models' lint index, for a plan's fit (seconds the first time a file is read, cached after). */
async function linkedIndexesForFit(linkedModels: ViewToolsHost["linkedModels"], extra: Extra, projectId: string): Promise<readonly LinkedModelIndex[] | string> {
  try {
    return await linkedModels(extra, projectId);
  } catch (err) {
    console.error("[bim_set_view_properties] linked models unreadable for fit", { projectId, err });
    return `Not saved: the linked models couldn't be read to fit the crop to them (${err instanceof Error ? err.message : "unknown error"}). Try again, or set the crop with crop_min_ft / crop_max_ft.`;
  }
}

export async function editWithModel(
  caller: ResolveBimCaller,
  tool: string,
  extra: Extra,
  args: { project_id: string; model_id: string; base_revision?: number },
  build: (model: ModelState) => Command | string,
  /** Read beside the result: what the command would look like on the model it was built from. */
  describe?: (model: ModelState, command: Command) => Record<string, unknown> | null,
) {
  try {
    const who = await caller(extra, args.project_id, false);
    const built = await withSession(who, args.model_id, undefined, async (s) => {
      const model = s.model();
      const command = build(model);
      return typeof command === "string" ? command : { command, described: describe ? describe(model, command) : null };
    });
    if (typeof built === "string") return failure(built);
    return runEdit(caller, tool, extra, args, built.command, undefined, built.described);
  } catch (err) {
    return explain(err, tool);
  }
}
