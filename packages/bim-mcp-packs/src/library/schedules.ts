import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NEC_EDITIONS, resolveNecEdition } from "@permitzip/bim-calc";
import { necElectricalRules, distributionEquipment, electricalRulesById } from "@permitzip/bim-pack-electrical";
import { fieldPaths, formScheduleKindLabel, formScheduleKinds, formScheduleRow, isBoundFormKind, builtinFormTemplate, canonicalJson, commandIssueMessage, commandSchema, documentIndex, elementsOfKind, evaluateFormSchedule, executeCommand, fieldProviderRegistry, formScheduleSchema, scheduleEditStepSchema, scheduleV2Form, sheetDrawingArea, viewportFrameSize, withBaseFields, withPackParameters, type Command, type FormScheduleDefinition, type ModelState, type Registry, type ScheduleColumnDef, type ScheduleDefinitionV2, type SchedulePin, type Vec2, type ViewCommand } from "@permitzip/bim-kernel";
import { ScheduleDefinitionError, applyScheduleSteps, openSchedule, scheduleProfile, scheduleV1ToV2, type CellValue, type ColumnValues, type RowSet, type RowSetColumn, type ScheduleSession } from "@permitzip/bim-kernel/schedules";
import {
  FileLibraryProvider,
  ITEM_SECTIONS,
  LIBRARY_ITEM_TYPES,
  builtinLibrarySource,
  builtinMepLibrarySource,
  checkBundle,
  libraryBundleSchema,
  parseItem,
  pinItem,
  registryForLibrary,
  type LibraryItem,
  type LibraryItemType,
  type StoredLibraryItem,
} from "@permitzip/bim-library";
import { bimFormulaEngine, bimUnitsCatalog } from "@permitzip/bim-library/bim-formula";
import type { AgentSession } from "@permitzip/bim-sync";
import { formatter, parseToSI, type DisplayOverride, type Measure } from "@permitzip/bim-units";
import { ensureFirstPartyAddOns, withPinnedPacks } from "@permitzip/bim-editor/contracts/building-model/installed-packs";
import { BUILTIN_LIST_IDS, BUILTIN_LIST_LABELS, builtinListDefinition, builtinListRegistry, type BuiltinListId } from "@permitzip/bim-editor/editor/schedules/builtin-lists";
import { baseRevision, editIdempotencyKey, editResultBody, explain, failure, notSent, target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import { findSheet, findView, pointFt, stableId } from "../views/views";
import type { ScheduleLibrary, ScheduleToolsHost } from "./capabilities";
import { chooseScheduleTemplate, FirmScheduleTemplateRefusal, type ChosenScheduleTemplate } from "./firm-schedule-templates";

export type { BimScheduleToolOptions, ScheduleLibrary, ScheduleToolsHost } from "./capabilities";

/** The Building Model's built-in lists (Views › Schedules › Load schedules, New schedule…), by the id bim_schedule_define takes as a template. */
function isBuiltinListId(value: string): value is BuiltinListId {
  return (BUILTIN_LIST_IDS as readonly string[]).includes(value);
}

/**
 * Schedules for agents (SCHEDULES-PLAN §8). Five tools: `bim_schedule_read`
 * (in the MutinyBIM core) and the `mutinybim-schedules` pack's
 * `bim_schedule_fields`, `bim_schedule_define`, `bim_schedule_edit_cells`
 * and `bim_library`. Rows come from the kernel's row engine over the
 * registry (field providers plus the firm library), so the agent reads what
 * the grid and the sheet show.
 *
 * Define, edit-cells and a library publish are confirm-gated: the first call
 * (user_confirmed absent or false) previews, saves nothing and returns a
 * preview_token; the commit call (same arguments plus that token, with
 * user_confirmed) pauses on the Approve card and runs once from the persisted
 * action row. Every model edit goes through the same authority path as the
 * browser.
 */

const IN = 25.4;
const GAP_MM = 12.7;
const ROW_CAP = 60;
const READ_PAGE = 50;
const READ_MAX = 200;
const PREVIEW_ROWS = 10;
const SUB_ROW_CAP = 20;
const TEMPLATE_LANGUAGE = "{path} prints a field; [ ... ] prints only when every field inside has a value; \\ escapes { } [ ].";

let builtinLibrary: Promise<ScheduleLibrary> | undefined;

/** The built-in AEC + MEP library, layered once per process: `withBaseFields(registryForLibrary(fieldProviderRegistry(), resolved))`. */
export function builtinScheduleLibrary(): Promise<ScheduleLibrary> {
  builtinLibrary ??= (async () => {
    const base = fieldProviderRegistry();
    const provider = new FileLibraryProvider({ sources: [builtinMepLibrarySource(), builtinLibrarySource()], env: { formula: bimFormulaEngine, units: bimUnitsCatalog, registry: base } });
    try {
      const { resolved } = await provider.resolved();
      const layered = registryForLibrary(base, resolved);
      if (!layered.ok) throw new Error(layered.problems.map((p) => p.message).join(" "));
      return { provider, registry: withBaseFields(layered.registry) };
    } catch (err) {
      console.error("[mcp:bim_schedules] the built-in library could not be layered; schedules read the kernel's fields only", err);
      return { provider, registry: base, warning: `The built-in library could not be loaded (${err instanceof Error ? err.message : String(err)}), so library calculations and fields are missing.` };
    }
  })();
  return builtinLibrary;
}

/** What a form schedule prints now, as the agent reads it. */
export function formScheduleReport(model: ModelState, def: FormScheduleDefinition, rowCap = ROW_CAP) {
  const form = evaluateFormSchedule(model, def);
  return {
    kind: def.kind,
    template: def.template.name,
    rules: electricalRulesById(def.rules).label,
    title: form.title,
    header: form.header,
    headings: form.grid.headings,
    rows: form.grid.rows.slice(0, rowCap),
    ...(form.grid.rows.length > rowCap ? { rows_shown: rowCap, rows_total: form.grid.rows.length } : {}),
    summary: form.summary,
    totals: form.totals,
    notes: form.notes,
    footer: form.footer,
    problem: form.problem,
  };
}

function findPanel(model: ModelState, ref: string): { id: string; name: string } | string {
  const list = distributionEquipment(model.elements);
  const key = ref.trim().toLowerCase();
  const hit = list.find((d) => d.id === ref || d.name.toLowerCase() === key);
  return hit ?? `No panel, switchboard or transformer "${ref}". Distribution equipment here: ${list.map((d) => d.name).join(", ") || "none yet"}.`;
}

/** A free spot for a frame of `size` on the sheet: the leftmost, then highest, place that overlaps no viewport. */
function freeCenter(model: ModelState, sheetId: string, size: Vec2): Vec2 {
  const sheet = model.elements[sheetId];
  if (sheet?.kind !== "sheet") throw new Error(`Sheet ${sheetId} does not exist`);
  const area = sheetDrawingArea(sheet);
  const frames = elementsOfKind(model.elements, "viewport").flatMap((e) =>
    e.sheetId === sheetId && !e.deleted ? [{ x0: e.center.x - e.size.x / 2, y0: e.center.y - e.size.y / 2, x1: e.center.x + e.size.x / 2, y1: e.center.y + e.size.y / 2 }] : [],
  );
  const xs = [area.min.x, ...frames.map((f) => f.x1 + GAP_MM)].sort((a, b) => a - b);
  const ys = [area.min.y, ...frames.map((f) => f.y1 + GAP_MM)].sort((a, b) => a - b);
  for (const x of xs) {
    for (const y of ys) {
      if (x + size.x > area.max.x || y + size.y > area.max.y) continue;
      const clear = frames.every((f) => x + size.x <= f.x0 || x >= f.x1 || y + size.y <= f.y0 || y >= f.y1);
      if (clear) return { x: x + size.x / 2, y: y + size.y / 2 };
    }
  }
  return { x: area.min.x + size.x / 2, y: area.min.y + size.y / 2 };
}

// ---------------------------------------------------------------- v2 schedules: definitions, rows, cells

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check only; the engine refuses a definition with problems, in plain words. */
function isDefinitionV2(value: unknown): value is ScheduleDefinitionV2 {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isRecord(value.source) &&
    typeof value.source.kind === "string" &&
    Array.isArray(value.columns) &&
    Array.isArray(value.filters) &&
    Array.isArray(value.sort) &&
    Array.isArray(value.groups) &&
    typeof value.grandTotals === "boolean" &&
    typeof value.itemize === "boolean" &&
    isRecord(value.presentation) &&
    isRecord(value.display)
  );
}

/** Fills the parts of a v2 definition an agent may leave out (empty filters, list presentation…), so a short definition still opens. */
function completeDefinition(input: Record<string, unknown>, name: string | undefined): unknown {
  const display = isRecord(input.display) ? input.display : {};
  return {
    filters: [],
    sort: [],
    groups: [],
    grandTotals: false,
    itemize: true,
    presentation: { kind: "list" },
    ...input,
    ...(name ? { name } : {}),
    display: { textSizeMm: 2.38, emptyText: "NONE", ...display },
  };
}

type ResolvedSchedule =
  | { readonly kind: "v2"; readonly viewId: string | null; readonly name: string; readonly def: ScheduleDefinitionV2; readonly stored: "v1" | "v2" | "ad_hoc" }
  | { readonly kind: "form"; readonly viewId: string; readonly name: string; readonly form: FormScheduleDefinition };

/** A schedule view (any kind it was saved as) as the engine reads it. */
function resolveScheduleView(model: ModelState, ref: string): ResolvedSchedule | string {
  const viewId = findView(model, ref);
  const view = viewId ? model.elements[viewId] : undefined;
  if (!viewId || view?.kind !== "view" || view.viewType !== "schedule") return `No schedule view "${ref}". Call bim_schedule_read without schedule to list them.`;
  const props = view.props;
  if (props?.scheduleV2) {
    const form = props.scheduleV2.presentation.kind === "form" ? scheduleV2Form(props.scheduleV2) : null;
    if (form) return { kind: "form", viewId, name: view.name, form };
    return { kind: "v2", viewId, name: view.name, def: props.scheduleV2, stored: "v2" };
  }
  if (props?.formSchedule) return { kind: "form", viewId, name: view.name, form: props.formSchedule };
  if (props?.schedule) return { kind: "v2", viewId, name: view.name, def: scheduleV1ToV2(props.schedule), stored: "v1" };
  return `Schedule view "${view.name}" has no definition yet. Give it one with bim_schedule_define.`;
}

function openOrProblems(model: ModelState, def: ScheduleDefinitionV2, viewId: string, registry: Registry): ScheduleSession | string {
  try {
    // The classes and parameters of the add-ons this model pins join the library's fields (the same registry object when it pins none).
    return withPinnedPacks(model, () => {
      const withPacks = withPackParameters(registry);
      return openSchedule(model, def, { viewId, revision: model.revision, registry: withPacks === registry ? registry : withBaseFields(withPacks) });
    });
  } catch (err) {
    if (err instanceof ScheduleDefinitionError) return `This schedule can't be built: ${err.problems.map((p) => p.message).join(" ")}`;
    throw err;
  }
}

function cellAt(values: ColumnValues | undefined, i: number): CellValue {
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

/** A column's cell as text: the definition's unit and precision, else the profile's (the same rule the sheet prints by). */
function cellText(column: RowSetColumn, def: ScheduleColumnDef | undefined, schedule: ScheduleDefinitionV2): (v: CellValue) => string | null {
  const kind = column.quantityKind;
  let format: ((si: number) => string) | null = null;
  if (kind) {
    const profile = scheduleProfile(schedule);
    const unit = def?.unit ?? (profile.kinds[kind] ? undefined : column.unit);
    const precision = def?.precision ?? column.precision;
    const override: DisplayOverride | undefined = unit || precision ? { ...(unit ? { unit } : {}), ...(precision ? { precision } : {}) } : undefined;
    format = formatter(kind, profile, override);
  }
  return (v) => {
    if (v === null || v === "") return null;
    if (typeof v === "number") return format ? format(v) : String(v);
    if (typeof v === "boolean") return v ? "YES" : "NO";
    return v;
  };
}

function columnSummary(c: RowSetColumn) {
  return {
    id: c.id,
    heading: c.heading,
    ...(c.unit ? { unit: c.unit } : {}),
    edit: c.writer ? c.writer.scope : null,
    ...(c.writer ? {} : c.lockedReason ? { locked: c.lockedReason } : {}),
    ...(c.childColumns ? { sub_columns: c.childColumns.map((s) => s.heading) } : {}),
  };
}

/** One window of rows as compact arrays: `[row_key, ...cells]`, expand columns as their sub-row count, plus their sub-rows. */
function windowReport(rows: RowSet, def: ScheduleDefinitionV2, only: readonly string[] | undefined) {
  const columns = rows.columns.filter((c) => !only || only.includes(c.id) || only.includes(c.heading));
  const texts = columns.map((c) => cellText(c, def.columns.find((d) => d.id === c.id), def));
  const subRows: Record<string, Record<string, (string | null)[][]>> = {};
  const out = rows.rowKeys.map((key, i) => {
    const cells = columns.map((c, k) => {
      if (c.kind !== "expand") return texts[k]?.(cellAt(rows.values.get(c.id), i)) ?? null;
      const set = rows.children.get(c.id)?.get(key);
      if (set && set.rowCount > 0) {
        const childTexts = set.columns.map((cc) => cellText(cc, undefined, def));
        (subRows[key] ??= {})[c.id] = set.rowKeys.slice(0, SUB_ROW_CAP).map((ck, j) => [ck, ...set.columns.map((cc, m) => childTexts[m]?.(cellAt(set.values.get(cc.id), j)) ?? null)]);
      }
      return `${set?.rowCount ?? 0} items`;
    });
    return [key, ...cells];
  });
  const totals: Record<string, string | null> = {};
  for (const [id, m] of rows.totals ?? new Map<string, Measure | null>()) {
    const c = rows.columns.find((x) => x.id === id);
    if (c && m) totals[id] = cellText(c, def.columns.find((d) => d.id === id), def)(m.value);
  }
  return {
    columns: columns.map(columnSummary),
    rows: out,
    ...(Object.keys(subRows).length > 0 ? { sub_rows: subRows } : {}),
    ...(Object.keys(totals).length > 0 ? { totals } : {}),
    ...(rows.groups && rows.groups.length > 0 ? { groups: rows.groups.map((g) => ({ label: g.label, first_row: g.start, rows: g.count })) } : {}),
  };
}

/** A cell value the agent typed, in the canonical SI the engine plans with: quantities parse with their unit ("199 MBH"), a bare number reads in the unit the schedule shows. */
function cellInput(column: RowSetColumn, def: ScheduleDefinitionV2, value: string | number | boolean | null): { ok: true; value: CellValue } | { ok: false; reason: string } {
  if (value === null || value === "") return { ok: true, value: null };
  const kind = column.quantityKind;
  if (column.valueType === "boolean" && typeof value !== "boolean") {
    // Read back as the schedule prints it: the words bim_schedule_read showed for on and off.
    const shown = cellText(column, undefined, def);
    const typed = String(value).trim().toUpperCase();
    if (typed === shown(true)) return { ok: true, value: true };
    if (typed === shown(false)) return { ok: true, value: false };
    return { ok: false, reason: `"${column.heading}" is ${shown(true)} or ${shown(false)}, or true / false.` };
  }
  if (!kind) return { ok: true, value };
  try {
    const own = def.columns.find((c) => c.id === column.id)?.unit ?? column.unit;
    const text = typeof value === "number" && own ? `${value} ${own}` : String(value);
    return { ok: true, value: parseToSI(text, kind, scheduleProfile(def)) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function previewToken(parts: unknown): string {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 32);
}

/** Commands as one edit: one command, or a `batch_edits` of them (one revision, one undo). */
function oneEdit(commands: readonly Command[], label: string): Command | string {
  if (commands.length === 1 && commands[0]) return commands[0];
  const parsed = commandSchema.safeParse({ type: "batch_edits", label: label.slice(0, 160), commands });
  return parsed.success ? parsed.data : notSent(commandIssueMessage(parsed.error, { type: "batch_edits", commands }));
}

function partTypeName(model: ModelState, partId: string): string {
  const part = model.elements[partId];
  const type = part?.kind === "part" ? model.elements[part.typeId] : undefined;
  return type?.kind === "part_type" ? type.definition.typeName || type.definition.familyName : partId;
}

/** "WH-1 type: 14 parts": who a type-scope edit changes, named by the type and counted. */
function typeScopeLine(model: ModelState, commands: readonly Command[], affected: number): string {
  const ids = commands.flatMap((c) => (c.type === "set_parameters" ? [c.id] : []));
  const names = [...new Set(ids.map((id) => partTypeName(model, id)))];
  return `${names.join(", ")} type: ${affected} part${affected === 1 ? "" : "s"}`;
}

const confirmArg = z.boolean().optional().describe("Absent/false: preview only. true: commit the previewed change (needs base_revision and preview_token); it pauses for approval.");
const tokenArg = z.string().min(16).max(64).optional().describe("The preview_token the preview returned.");
const cellValue = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);

// The kinds are the add-ons' (`formScheduleKinds()` where the model is open); an unknown one is refused in words by the form schema.
const kindArg = z.string().trim().min(1).max(60).describe("The form kind; bim_library (action list, type schedule_template) names the kinds this model's add-ons make.");

/** A new schedule view created and placed on a sheet in one edit: at `top_left_in`, else the first free spot from the left. */
function placeNew(model: ModelState, extra: Extra, create: Command, viewId: string, name: string, placeOn: { sheet: string; top_left_in?: { x: number; y: number } }): Command | string {
  const sheetId = findSheet(model, placeOn.sheet);
  if (!sheetId) return `No sheet "${placeOn.sheet}". List views and sheets first.`;
  const created = executeCommand(model, create);
  if (!created.ok) return `Not created: ${created.error.message}.`;
  const view = created.model.elements[viewId];
  if (view?.kind !== "view") return "The schedule couldn't be created.";
  const size = viewportFrameSize(created.model, view, 1);
  const center = placeOn.top_left_in ? { x: placeOn.top_left_in.x * IN + size.x / 2, y: placeOn.top_left_in.y * IN + size.y / 2 } : freeCenter(created.model, sheetId, size);
  const sheet = model.elements[sheetId];
  const number = sheet?.kind === "sheet" ? sheet.number : placeOn.sheet;
  const batch = { type: "batch_documents", label: `Create "${name}" and place it on ${number}`, commands: [create, { type: "place_viewport", viewportId: stableId("vp", extra, { sheetId, viewId }), sheetId, viewId, center }] };
  const parsed = commandSchema.safeParse(batch);
  return parsed.success ? parsed.data : notSent(commandIssueMessage(parsed.error, batch));
}

type FormArg = { kind: string; panel?: string; template_name?: string; template?: Record<string, unknown>; nec_edition?: (typeof NEC_EDITIONS)[number] | "none" };

/** A form schedule (panel, feeder…) created or changed: the same view props the browser's schedule menu writes. */
function planFormSchedule(
  model: ModelState,
  extra: Extra,
  args: { model_id: string; schedule?: string; name?: string; place_on?: { sheet: string; top_left_in?: { x: number; y: number } } },
  form: FormArg,
  chosen: ChosenScheduleTemplate | null,
  rules: string | undefined,
  code: string,
): { command: Command; tokenParts: unknown; preview: Record<string, unknown> } | { refused: string } {
  const existingId = args.schedule ? findView(model, args.schedule) : null;
  if (args.schedule && !existingId) return { refused: `No schedule view "${args.schedule}". Call bim_schedule_read without schedule to list them.` };
  const existingView = existingId ? model.elements[existingId] : undefined;
  const current = existingView?.kind === "view" ? existingView.props?.formSchedule : undefined;
  if (existingId && !current) return { refused: `"${args.schedule}" isn't a form schedule; change it with definition instead.` };
  const bound = isBoundFormKind(form.kind);
  let elementId = current?.elementId;
  let panelName: string | null = null;
  if (form.panel) {
    if (!bound) return { refused: `A ${formScheduleKindLabel(form.kind).toLowerCase()} lists the whole model; leave panel out.` };
    const panel = findPanel(model, form.panel);
    if (typeof panel === "string") return { refused: panel };
    elementId = panel.id;
    panelName = panel.name;
  }
  if (bound && !elementId) return { refused: `A ${formScheduleKindLabel(form.kind).toLowerCase()} needs panel: the ${formScheduleRow(form.kind)?.boundTo ?? "element"} it is the schedule of.` };
  const template = form.template ?? chosen?.template ?? current?.template;
  const keepRules = form.nec_edition === undefined && current ? current.rules : rules;
  const candidate = {
    kind: form.kind,
    ...(elementId ? { elementId } : {}),
    template,
    ...(keepRules ? { rules: keepRules } : {}),
    ...(chosen?.source === "firm" && chosen.revision ? { templateSource: { name: chosen.name, revision: chosen.revision } } : {}),
  };
  const parsed = formScheduleSchema.safeParse(candidate);
  if (!parsed.success) return { refused: `Not valid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".").replace(/^template\./, "") || "template"}: ${i.message}`).join("; ")}.` };
  const def = parsed.data;
  const name = args.name ?? (existingView?.kind === "view" ? existingView.name : panelName ? `${form.kind === "switchboard" ? "Switchboard" : "Panel"} ${panelName} schedule` : formScheduleKindLabel(form.kind));
  const viewId = existingId ?? stableId("form", extra, { model_id: args.model_id, kind: form.kind, panel: elementId ?? null, name });
  const preview = { schedule: name, view_id: viewId, prints: formScheduleReport(model, def, 8), template: chosen ? { name: chosen.name, from: chosen.source } : "as given", code };
  if (existingId) {
    const command: Command = { type: "set_view_properties", viewId: existingId, props: { formSchedule: def } };
    return { command, tokenParts: command, preview };
  }
  const create: ViewCommand = { type: "create_view", viewId, name, viewType: "schedule", props: { formSchedule: def } };
  if (!args.place_on) return { command: create, tokenParts: create, preview };
  const placed = placeNew(model, extra, create, viewId, name, args.place_on);
  if (typeof placed === "string") return { refused: placed };
  return { command: placed, tokenParts: placed, preview: { ...preview, sheet: args.place_on.sheet } };
}

export function registerBimScheduleTools(server: McpServer, caller: ResolveBimCaller, host: ScheduleToolsHost) {
  const projectAdoption = host.projectAdoption;
  // Firm form layouts and defaults live in the firm library: the host's template store reads and publishes there.
  const templates = host.scheduleTemplates;
  const libraryAccess = host.firmLibraryAccess;
  // The firm library over the built-in ones; publishes stay preview + Approve card.
  const library = host.library;

  /** The rules id to store, and the line saying what the demand rests on. */
  async function rulesFor(extra: Extra, projectId: string, nec: (typeof NEC_EDITIONS)[number] | undefined): Promise<{ rules?: string; code: string }> {
    const adoption = nec ? null : await projectAdoption(extra, projectId);
    const resolved = resolveNecEdition({ necEdition: nec, projectAdoption: adoption });
    if (!resolved.ok) return { code: `No NEC edition (${resolved.reason}): the schedule prints connected loads only and says so.` };
    return { rules: necElectricalRules(resolved.edition).id, code: `NEC ${resolved.edition.edition}${nec ? " (asked for)" : resolved.step ? ` (${resolved.step.detail})` : ""}` };
  }

  /** Form schedule templates per kind: the built-in one, the firm's, and which a new schedule starts from. */
  async function formTemplates(extra: Extra) {
    const access = await libraryAccess(extra);
    const firm = access.read ? await (await templates(extra)).list() : [];
    ensureFirstPartyAddOns();
    return formScheduleKinds().map((kind) => {
      const mine = firm.filter((t) => t.kind === kind);
      return { kind, label: formScheduleKindLabel(kind), needs_panel: isBoundFormKind(kind), built_in: builtinFormTemplate(kind).name, firm: mine.map((t) => t.name), starts_from: mine.find((t) => t.isDefault)?.name ?? builtinFormTemplate(kind).name };
    });
  }

  /**
   * The shared body of the confirm-gated model edits: plan at the current
   * model, return a preview with its token, or (committing) check the token
   * and save the planned command as the caller.
   */
  async function previewOrCommit(
    tool: string,
    extra: Extra,
    args: { project_id: string; model_id: string; base_revision?: number; preview_token?: string; user_confirmed?: boolean },
    plan: (session: AgentSession, sl: ScheduleLibrary) => { command: Command; tokenParts: unknown; preview: Record<string, unknown> } | { refused: string; preview?: Record<string, unknown> },
  ) {
    try {
      const commit = args.user_confirmed === true;
      if (commit && (args.base_revision === undefined || !args.preview_token)) return failure(`${tool} commits only a previewed change: call it without user_confirmed first, then again with the preview's base_revision and preview_token.`);
      const who = await caller(extra, args.project_id, commit);
      const sl = await library(extra, args.project_id);
      return await withSession(who, args.model_id, undefined, async (s) => {
        const planned = plan(s, sl);
        if ("refused" in planned) return planned.preview ? text({ status: "would_be_refused", message: planned.refused, ...planned.preview, revision: s.revision() }) : failure(planned.refused);
        const base = commit ? (args.base_revision ?? s.revision()) : s.revision();
        const token = previewToken({ tool, model_id: args.model_id, base, parts: planned.tokenParts });
        if (!commit) {
          return text({
            status: "preview",
            ...planned.preview,
            base_revision: base,
            preview_token: token,
            next: "Nothing is saved yet. To save exactly this, call again with the same arguments plus base_revision, preview_token and user_confirmed: true; the person approves it on the Approve card first.",
            ...(sl.warning ? { library_warning: sl.warning } : {}),
          });
        }
        if (token !== args.preview_token) return failure(`This isn't the change that was previewed at Rev ${base}: what it would change is different now. Preview again and commit with the new preview_token.`);
        const checked = commandSchema.safeParse(planned.command);
        if (!checked.success) return failure(notSent(commandIssueMessage(checked.error, planned.command)));
        const result = await s.edit(checked.data, { idempotencyKey: editIdempotencyKey(who.runId, tool, { model_id: args.model_id, token }, base), baseRevision: base });
        return text({ ...editResultBody(result, args.model_id), ...planned.preview });
      });
    } catch (err) {
      return explain(err, tool);
    }
  }

  // ── bim_schedule_read (core) ───────────────────────────────────────────────

  server.registerTool(
    "bim_schedule_read",
    {
      title: "Read a schedule",
      description:
        "Rows of a schedule view (or an ad hoc v2 definition): columns with unit and whether a cell edits per instance or per type, rows as [row_key, ...cells] (limit ≤200 from offset), totals, and explain text for locked cells. Panel/feeder form schedules return what prints. No schedule: lists schedule views. Read-only.",
      inputSchema: {
        ...target,
        schedule: z.string().min(1).max(200).optional().describe("Schedule view name or id."),
        definition: z.record(z.string(), z.unknown()).optional().describe("Ad hoc v2 definition (see bim_schedule_define)."),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(READ_MAX).optional(),
        columns: z.array(z.string().max(80)).max(40).optional().describe("Only these column ids."),
        explain: z.array(z.object({ row: z.string().max(200), column: z.string().max(80) })).max(20).optional(),
      },
    },
    async (args, extra: Extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const sl = await library(extra, args.project_id);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          if (!args.schedule && !args.definition) {
            const schedules = documentIndex(model).views.filter((v) => v.viewType === "schedule");
            return text({
              schedules: schedules.map((v) => ({ id: v.id, name: v.name, kind: v.props?.formSchedule ? `form: ${v.props.formSchedule.kind}` : v.props?.scheduleV2 ? "v2" : v.props?.schedule ? `list: ${v.props.schedule.category}` : "empty" })),
              revision: model.revision,
            });
          }
          let resolved: ResolvedSchedule | string;
          if (args.schedule) resolved = resolveScheduleView(model, args.schedule);
          else {
            const candidate = completeDefinition(args.definition ?? {}, undefined);
            resolved = isDefinitionV2(candidate) ? { kind: "v2", viewId: null, name: candidate.name, def: candidate, stored: "ad_hoc" } : "A definition needs at least name, source and columns (see bim_schedule_define).";
          }
          if (typeof resolved === "string") return failure(resolved);
          if (resolved.kind === "form") return text({ schedule: resolved.name, view_id: resolved.viewId, form: formScheduleReport(model, resolved.form), edit: "A form schedule's cells come from the model; change the model, or its template with bim_schedule_define.", revision: model.revision });
          const session = openOrProblems(model, resolved.def, resolved.viewId ?? "ad-hoc", sl.registry);
          if (typeof session === "string") return failure(session);
          const offset = args.offset ?? 0;
          const win = session.window(offset, args.limit ?? READ_PAGE);
          const total = win.window?.totalRows ?? win.rowCount;
          return text({
            schedule: resolved.name,
            ...(resolved.viewId ? { view_id: resolved.viewId } : {}),
            ...windowReport(win, resolved.def, args.columns),
            window: { offset, shown: win.rowCount, total },
            ...(args.explain && args.explain.length > 0 ? { explain: args.explain.map((e) => ({ ...e, text: session.explain(e.row, e.column) ?? "Not calculated: this cell is read from the model (or the row or column doesn't exist)." })) } : {}),
            ...(sl.warning ? { library_warning: sl.warning } : {}),
            revision: model.revision,
          });
        });
      } catch (err) {
        return explain(err, "bim_schedule_read");
      }
    },
  );

  // ── mutinybim-schedules pack ──────────────────────────────────────────────

  server.registerTool(
    "bim_schedule_fields",
    {
      title: "Schedule classes, fields and relationships",
      description:
        "What a schedule can list and show. No classes: every class by discipline. With classes: each one's fields (path, label, kind, unit, edit instance/type or why locked, how it totals) and relationships (serves, source, fed_from…) for aggregate and expand columns. Read-only.",
      inputSchema: {
        project_id: target.project_id,
        classes: z.array(z.string().max(80)).max(10).optional().describe("Class ids, e.g. mep.water_heater."),
      },
    },
    async (args, extra: Extra) => {
      try {
        await caller(extra, args.project_id, false);
        const { registry, warning } = await library(extra, args.project_id);
        if (!args.classes || args.classes.length === 0) {
          const byDiscipline: Record<string, { id: string; label: string; parent?: string }[]> = {};
          for (const c of registry.listClasses()) (byDiscipline[c.discipline] ??= []).push({ id: c.id, label: c.label, ...(c.parent ? { parent: c.parent } : {}) });
          return text({ classes: byDiscipline, ...(warning ? { library_warning: warning } : {}) });
        }
        const unknown = args.classes.filter((id) => !registry.getClass(id));
        if (unknown.length > 0) return failure(`No class ${unknown.join(", ")}. Call bim_schedule_fields without classes to list them.`);
        return text({
          classes: args.classes.map((id) => ({
            id,
            label: registry.getClass(id)?.label,
            fields: registry.fieldsFor(id).map((f) => ({
              path: f.path,
              label: f.label,
              type: f.valueType,
              ...(f.kind ? { kind: f.kind } : {}),
              ...(f.unit ? { unit: f.unit } : {}),
              edit: f.writer.kind === "none" ? { locked: f.writer.reason } : f.writer.kind === "parameter" ? f.writer.scope : "instance",
              ...(f.aggregation ? { totals: f.aggregation } : {}),
              ...(f.source !== "builtin" ? { source: f.source } : {}),
            })),
            relationships: registry.relationshipsFor(id).map((r) => ({ id: r.id, label: r.label, to: r.to, cardinality: r.cardinality })),
          })),
          ...(warning ? { library_warning: warning } : {}),
        });
      } catch (err) {
        return explain(err, "bim_schedule_fields");
      }
    },
  );

  server.registerTool(
    "bim_schedule_define",
    {
      title: "Create or change a schedule",
      description:
        "Create a v2 schedule (definition, or a library template id) or replace an existing schedule view's definition; place_on puts a new one on a sheet in the same edit. Preview first: problems in plain words, the first rows, a preview_token. Commit with user_confirmed (pauses for approval).",
      inputSchema: {
        ...target,
        ...baseRevision,
        schedule: z.string().min(1).max(200).optional().describe("Existing schedule view to change; absent: create one."),
        name: z.string().trim().min(1).max(120).optional(),
        definition: z.record(z.string(), z.unknown()).optional().describe("ScheduleDefinition v2: source, columns, filters, sort, groups, grandTotals, itemize, presentation, display, pins."),
        // The step shapes are checked when the edit is planned: a column's unit is a custom type JSON Schema can't carry.
        steps: z.array(z.record(z.string(), z.unknown())).min(1).max(50).optional().describe("With schedule, instead of definition: change it column by column, the same edit as the grid's Columns sheet, one undo. Steps: {op:add_column,column,at?} {op:move_column,columnId,to} {op:remove_column,columnId} {op:rename_column,columnId,heading|null} {op:filter,filters} {op:sort,sort:[{path,direction}]} {op:group,groups} {op:totals,columnId?,show}."),
        template: z.string().min(1).max(200).optional().describe("Library schedule template id (bim_library), or a built-in list: space_loads, panel_loads, loads, equipment_list, not_placed_yet."),
        form: z
          .object({ kind: kindArg, panel: z.string().max(200).optional(), template_name: z.string().max(80).optional(), template: z.record(z.string(), z.unknown()).optional(), nec_edition: z.union([z.enum(NEC_EDITIONS), z.literal("none")]).optional() })
          .optional()
          .describe("Instead of definition: a panel, switchboard, feeder, connection type, equipment connection or gas form schedule."),
        place_on: z.object({ sheet: z.string().min(1).max(200), top_left_in: pointFt.optional() }).optional(),
        preview_token: tokenArg,
        user_confirmed: confirmArg,
      },
    },
    async (args, extra: Extra) => {
      if (args.form) {
        const form = args.form;
        let chosen: ChosenScheduleTemplate | null = null;
        try {
          if (!form.template) chosen = await chooseScheduleTemplate(await templates(extra), form.kind, form.template_name);
        } catch (err) {
          if (err instanceof FirmScheduleTemplateRefusal) return failure(`Not created: ${err.message}.`);
          return explain(err, "bim_schedule_define");
        }
        const nec = form.nec_edition === "none" ? undefined : form.nec_edition;
        const { rules, code } = form.nec_edition === "none" ? { rules: undefined, code: "Connected loads only (asked for)." } : await rulesFor(extra, args.project_id, nec);
        return previewOrCommit("bim_schedule_define", extra, args, (s) => planFormSchedule(s.model(), extra, args, form, chosen, rules, code));
      }
      let fromTemplate: Record<string, unknown> | null = null;
      const builtin = args.template && !args.definition && isBuiltinListId(args.template) ? args.template : null;
      if (args.template && !args.definition && !builtin) {
        try {
          const sl = await library(extra, args.project_id);
          const item = await sl.provider.get(args.template);
          if (item.type !== "schedule_template") return failure(`Library item ${args.template} is a ${item.type.replace(/_/g, " ")}, not a schedule template.`);
          fromTemplate = item.body.definition;
        } catch (err) {
          return explain(err, "bim_schedule_define");
        }
      }
      return previewOrCommit("bim_schedule_define", extra, args, (s, sl) => {
        const model = s.model();
        const existing = args.schedule ? findView(model, args.schedule) : null;
        if (args.schedule && !existing) return { refused: `No schedule view "${args.schedule}". Call bim_schedule_read without schedule to list them.` };
        const current = existing ? resolveScheduleView(model, existing) : null;
        if (typeof current === "string") return { refused: current };
        if (args.steps) {
          if (!existing || !current) return { refused: "steps change an existing schedule: name it with schedule." };
          if (current.kind === "form") return { refused: `"${current.name}" is laid out by its form, so it has no columns to change one by one. Give a form instead.` };
          const parsedSteps = z.array(scheduleEditStepSchema).safeParse(args.steps);
          if (!parsedSteps.success) return { refused: `Those steps don't fit: ${parsedSteps.error.issues[0]?.message ?? "check each step's op and fields"} (step ${Number(parsedSteps.error.issues[0]?.path[0] ?? 0) + 1}).` };
          const stepped = applyScheduleSteps(current.def, parsedSteps.data);
          if (!stepped.ok) return { refused: stepped.reason };
          const opened = openOrProblems(model, stepped.definition, existing, sl.registry);
          if (typeof opened === "string") return { refused: opened };
          const sample = opened.window(0, PREVIEW_ROWS);
          const preview = { schedule: current.name, view_id: existing, ...windowReport(sample, stepped.definition, undefined), rows_total: sample.window?.totalRows ?? sample.rowCount };
          const raw = { type: "edit_schedule", viewId: existing, steps: parsedSteps.data };
          const parsedEdit = commandSchema.safeParse(raw);
          if (!parsedEdit.success) return { refused: notSent(commandIssueMessage(parsedEdit.error, raw)), preview };
          return { command: parsedEdit.data, tokenParts: parsedEdit.data, preview };
        }
        const input = args.definition ?? fromTemplate ?? (builtin ? { ...builtinListDefinition(model, builtin) } : null) ?? (current?.kind === "v2" ? { ...current.def } : null);
        if (!input) return { refused: "Give a definition or a library template id." };
        const name = args.name ?? current?.name ?? (builtin ? BUILTIN_LIST_LABELS[builtin] : undefined) ?? (typeof input.name === "string" ? input.name : undefined);
        if (!name) return { refused: "Give the schedule a name." };
        const def = completeDefinition(input, name);
        if (!isDefinitionV2(def)) return { refused: "A definition needs source ({kind: classes, classes, includeSubclasses}) and columns." };
        const viewId = existing ?? stableId("schedule", extra, { model_id: args.model_id, name });
        // A built-in list names trade fields (loads, placement) the library registry may not carry; it opens over every field provider, as the model server does.
        const opened = openOrProblems(model, def, viewId, sl.registry);
        const session = builtin && typeof opened === "string" ? openOrProblems(model, def, viewId, builtinListRegistry()) : opened;
        if (typeof session === "string") return { refused: session };
        const sample = session.window(0, PREVIEW_ROWS);
        const preview = { schedule: name, view_id: viewId, ...windowReport(sample, def, undefined), rows_total: sample.window?.totalRows ?? sample.rowCount };
        const raw = existing ? { type: "set_view_properties", viewId, props: { scheduleV2: def } } : { type: "create_view", viewId, name, viewType: "schedule", props: { scheduleV2: def } };
        const parsedSet = commandSchema.safeParse(raw);
        if (!parsedSet.success) return { refused: notSent(commandIssueMessage(parsedSet.error, raw)), preview };
        const set = parsedSet.data;
        if (!args.place_on || existing) return { command: set, tokenParts: set, preview: { ...preview, ...(existing && args.place_on ? { note: "place_on applies to a new schedule; this one keeps its place." } : {}) } };
        const placed = placeNew(model, extra, set, viewId, name, args.place_on);
        if (typeof placed === "string") return { refused: placed };
        return { command: placed, tokenParts: placed, preview: { ...preview, sheet: args.place_on.sheet } };
      });
    },
  );

  server.registerTool(
    "bim_schedule_edit_cells",
    {
      title: "Edit schedule cells",
      description:
        "Change cells of a schedule (row_key and column id from bim_schedule_read; quantities with a unit, e.g. \"199 MBH\"). Each cell goes back through its field to the model; locked or wrong values are refused in plain words. Preview first: the changes, every type-wide edit as \"WH-1 type: 14 parts\", a preview_token. Commit with user_confirmed (pauses for approval; one undo step).",
      inputSchema: {
        ...target,
        ...baseRevision,
        schedule: z.string().min(1).max(200).describe("Schedule view name or id."),
        edits: z.array(z.object({ row: z.string().min(1).max(200), column: z.string().min(1).max(80), value: cellValue })).min(1).max(500),
        preview_token: tokenArg,
        user_confirmed: confirmArg,
      },
    },
    async (args, extra: Extra) =>
      previewOrCommit("bim_schedule_edit_cells", extra, args, (s, sl) => {
        const model = s.model();
        const resolved = resolveScheduleView(model, args.schedule);
        if (typeof resolved === "string") return { refused: resolved };
        if (resolved.kind === "form" || !resolved.viewId) return { refused: "A form schedule's cells come from the model; change the elements, or its template with bim_schedule_define." };
        const session = openOrProblems(model, resolved.def, resolved.viewId, sl.registry);
        if (typeof session === "string") return { refused: session };
        const columns = session.rows().columns;
        const commands: Command[] = [];
        const changes: Record<string, unknown>[] = [];
        const typeScope: string[] = [];
        const refusals: { row: string; column: string; reason: string }[] = [];
        for (const e of args.edits) {
          const column = columns.find((c) => c.id === e.column) ?? columns.find((c) => c.heading.toLowerCase() === e.column.toLowerCase());
          if (!column) {
            refusals.push({ row: e.row, column: e.column, reason: `No column "${e.column}" in this schedule.` });
            continue;
          }
          const value = cellInput(column, resolved.def, e.value);
          if (!value.ok) {
            refusals.push({ row: e.row, column: column.id, reason: value.reason });
            continue;
          }
          const plan = session.planEdit({ rowKey: e.row, columnId: column.id, value: value.value });
          if (!plan.ok) {
            refusals.push({ row: e.row, column: column.id, reason: plan.reason });
            continue;
          }
          commands.push(...plan.commands);
          const scope = plan.scope === "type" ? typeScopeLine(model, plan.commands, plan.affectedElementIds.length) : null;
          if (scope && !typeScope.includes(scope)) typeScope.push(scope);
          changes.push({ row: e.row, column: column.heading, to: e.value, scope: plan.scope, affects: plan.affectedElementIds.length, ...(plan.confirm ? { confirm: plan.confirm } : {}) });
        }
        const preview = { schedule: resolved.name, view_id: resolved.viewId, changes, ...(typeScope.length > 0 ? { type_scope: typeScope } : {}), ...(refusals.length > 0 ? { refused: refusals } : {}) };
        if (refusals.length > 0) return { refused: `${refusals.length} of ${args.edits.length} cell${args.edits.length === 1 ? "" : "s"} can't change (see refused). Fix or drop them; nothing is saved while any is refused.`, preview };
        const command = oneEdit(commands, `Edit ${changes.length} cell${changes.length === 1 ? "" : "s"} of "${resolved.name}"`);
        if (typeof command === "string") return { refused: command, preview };
        return { command, tokenParts: { commands, typeScope }, preview };
      }),
  );

  server.registerTool(
    "bim_library",
    {
      title: "MutinyBIM library",
      description:
        "The firm's named calculations, shared fields, classes and schedule templates. list (scopes and items), read (an item and its pin for a schedule's pins), test (validate an item, run its examples), publish (to firm or project scope: preview first, then user_confirmed; pauses for approval and needs firm library write access).",
      inputSchema: {
        project_id: target.project_id,
        action: z.enum(["list", "read", "test", "publish"]),
        type: z.enum(LIBRARY_ITEM_TYPES).optional(),
        text: z.string().max(120).optional().describe("list: match on key or name."),
        id: z.string().max(200).optional().describe("read: item id."),
        revision: z.number().int().positive().optional(),
        item: z.object({ type: z.enum(LIBRARY_ITEM_TYPES), body: z.record(z.string(), z.unknown()) }).optional().describe("test / publish: the item."),
        scope: z.string().max(200).optional().describe("publish: scope id from list."),
        base_revision: z.number().int().min(0).optional().describe("publish: the item's stored revision you edited (0: new)."),
        preview_token: tokenArg,
        user_confirmed: confirmArg,
      },
    },
    async (args, extra: Extra) => {
      try {
        await caller(extra, args.project_id, false);
        const sl = await library(extra, args.project_id);
        const provider = sl.provider;
        if (args.action === "list") {
          const scopes = await provider.scopes();
          const lists = await Promise.all(scopes.map(async (sc) => ({ ...sc, ...(await provider.capabilities(sc.id)), items: await provider.list(sc.id, { ...(args.type ? { type: args.type } : {}), ...(args.text ? { text: args.text } : {}) }) })));
          const forms = !args.type || args.type === "schedule_template" ? await formTemplates(extra) : null;
          return text({
            scopes: lists.map((l) => ({ id: l.id, name: l.name, kind: l.kind, publish: l.publish, ...(l.reason ? { reason: l.reason } : {}), items: l.items.map((i) => ({ id: i.id, type: i.type, key: i.key, name: i.name, revision: i.revision, ...(i.deprecated ? { deprecated: true } : {}) })) })),
            ...(forms ? { form_templates: forms, form_templates_use: 'read id "form:<kind>" (or "form:<kind>:<firm name>") for the template; bim_schedule_define form.template_name uses one.' } : {}),
          });
        }
        if (args.action === "read") {
          if (!args.id) return failure("read needs the item id (list shows them).");
          if (args.id.startsWith("form:")) {
            const [, kind, ...rest] = args.id.split(":");
            ensureFirstPartyAddOns();
            const formKind = formScheduleKinds().find((k) => k === kind);
            if (!formKind) return failure(`No form schedule kind "${kind}". Kinds: ${formScheduleKinds().join(", ")}.`);
            const firmName = rest.join(":");
            const access = await libraryAccess(extra);
            const firm = firmName && access.read ? (await (await templates(extra)).list({ kind: formKind })).find((t) => t.name === firmName) : undefined;
            if (firmName && !firm) return failure(access.read ? `No firm ${formKind} template "${firmName}".` : "You have no access to the firm library. Ask an admin for it.");
            return text({ kind: formKind, template: firm ? firm.template : builtinFormTemplate(formKind), ...(firm ? { revision: firm.revision, is_default: firm.isDefault } : { built_in: true }), field_paths: fieldPaths().map((f) => ({ path: f.path, label: f.label, on: f.on, example: f.example })), template_language: TEMPLATE_LANGUAGE });
          }
          const stored: StoredLibraryItem = await provider.get(args.id, args.revision);
          const pin = pinItem(stored);
          const schedulePin: SchedulePin = { id: pin.id, type: pin.type, revision: pin.revision, contentHash: pin.contentHash, body: pin.item.body };
          return text({ scope: stored.scope, type: stored.type, body: stored.body, pin: schedulePin, use: "Add pin to a definition's pins to use this item in a schedule; the model keeps its own copy." });
        }
        if (!args.item) return failure(`${args.action} needs item: { type, body }.`);
        const parsed = parseItem({ type: args.item.type as LibraryItemType, body: args.item.body });
        if (!parsed.ok) return failure(`Not a valid ${args.item.type.replace(/_/g, " ")}: ${parsed.issues.slice(0, 4).map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ")}.`);
        const problems = testItem(parsed.item, sl.registry);
        if (args.action === "test" || problems.length > 0) return text({ status: problems.length > 0 ? "invalid" : "valid", problems, ...(problems.length === 0 ? { message: "Valid: it parses, its units fit and every example passed." } : {}) });
        const access = await libraryAccess(extra);
        if (!access.write) return failure("Not published: adding to the firm library needs firm library write access, which you don't have. Ask an admin.");
        if (!args.scope) return failure("publish needs scope (a scope id from list).");
        const caps = await provider.capabilities(args.scope);
        if (!caps.publish || !provider.publish) return failure(`Not published: ${caps.reason ?? "this library can't be published to here"}.`);
        const base = args.base_revision ?? 0;
        const token = previewToken({ tool: "bim_library", project_id: args.project_id, scope: args.scope, base, item: parsed.item });
        if (args.user_confirmed !== true) {
          return text({ status: "preview", would_publish: { scope: args.scope, type: parsed.item.type, key: parsed.item.body.key, revision: parsed.item.body.revision }, base_revision: base, preview_token: token, next: "Nothing is published yet. Call again with the same item, scope, base_revision, preview_token and user_confirmed: true; the person approves it on the Approve card first. Schedules already drawn keep their pinned copy." });
        }
        if (args.preview_token !== token) return failure("This isn't the item that was previewed. Preview it again and publish with the new preview_token.");
        const result = await provider.publish(args.scope, parsed.item, base);
        if (!result.ok) return failure(`Not published (${result.code}): ${result.message}${result.problems?.length ? ` ${result.problems.map((p) => p.message).join(" ")}` : ""}`);
        return text({ status: "published", item: result.summary, message: `Published ${result.summary.key} revision ${result.summary.revision} to ${args.scope}. Schedules already drawn keep their pinned copy until someone updates them.` });
      } catch (err) {
        return explain(err, "bim_library");
      }
    },
  );

}

/** One item checked the way a bundle is on load and publish: schema, units, expression, examples. */
function testItem(item: LibraryItem, registry: Registry): { message: string; line?: number }[] {
  const section = ITEM_SECTIONS[item.type];
  const bundle = libraryBundleSchema.safeParse({ format: "mutinybim-library", version: 1, id: "agent-test", name: "Agent test", publisher: "Agent", revision: 1, [section]: [item.body] });
  if (!bundle.success) return bundle.error.issues.slice(0, 6).map((i) => ({ message: `${i.path.join(".")}: ${i.message}` }));
  return checkBundle(bundle.data, { formula: bimFormulaEngine, units: bimUnitsCatalog, registry }).map((p) => ({ message: p.message, ...(p.line !== undefined ? { line: p.line } : {}) }));
}
