import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DIAGRAM_KINDS,
  DIAGRAM_KIND_LABELS,
  ONE_LINE_TEXT_MM,
  diagramHintsSchema,
  documentIndex,
  evaluateDiagram,
  executeCommand,
  layoutOneLine,
  oneLineCommands,
  oneLineCropCommand,
  type BatchCommand,
  type DiagramDefinition,
  type DiagramEvaluation,
  type DiagramHints,
  type DiagramKind,
  type StoredDiagramKind,
  type DiagramNodeBox,
  type ModelState,
  type OneLineLayout,
  type OneLineSpec,
  type ViewCommand,
} from "@permitzip/bim-kernel";
import { checkOneLineSpec, oneLineSpecSchema, type OneLineFromModel, COMMAND_FAMILY_COPY, ONE_LINE_ARG_COPY, ONE_LINE_TOOL_COPY } from "@permitzip/bim-pack-electrical";
import { explain, failure, runEdit, target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import { previewTokenProblem, findSheet, findView, previewDocumentEdit, stableId } from "../views/views";
import { commandFamily, parseFamilyValue } from "../parts/describe-commands";

/**
 * Diagrams for agents. With from_model: a LIVE diagram (one-line, electrical
 * riser or plumbing riser): a drafting view that stores only its kind and
 * layout hints and is drawn from the model's connection graph every time, so
 * ratings, feeders and enclosures on it are never stale (DIAGRAMS.md). With
 * diagram: the static path, for a distribution described by hand when there
 * is no model: symbols, conductors and labels drawn as drafting items.
 * Preview free; saving pauses for approval.
 */

const IN = 25.4;

type OneLineTool = "bim_preview_one_line" | "bim_layout_one_line";

/** The static distribution and the live layout hints, read in full with bim_describe_commands; advertised as plain objects. Their words are the Electrical add-on's. */
function diagramFamiliesOf(tool: OneLineTool) {
  const label = (field: "diagram" | "hints") => COMMAND_FAMILY_COPY.find((f) => f.tool === tool && f.field === field)?.label ?? field;
  return {
    diagram: commandFamily({ tool, field: "diagram", label: label("diagram"), schema: oneLineSpecSchema }),
    hints: commandFamily({ tool, field: "hints", label: label("hints"), schema: diagramHintsSchema }),
  };
}

const DIAGRAM_FAMILIES: Readonly<Record<OneLineTool, ReturnType<typeof diagramFamiliesOf>>> = {
  bim_preview_one_line: diagramFamiliesOf("bim_preview_one_line"),
  bim_layout_one_line: diagramFamiliesOf("bim_layout_one_line"),
};

/** The arguments with diagram and hints read by their full schemas, or the misfit in plain words. */
function parseOneLineArgs<A extends { diagram?: unknown; hints?: unknown }>(tool: OneLineTool, args: A): { ok: true; args: Omit<A, "diagram" | "hints"> & { diagram?: OneLineSpec; hints?: DiagramHints } } | { ok: false; message: string } {
  const families = DIAGRAM_FAMILIES[tool];
  const { diagram, hints, ...rest } = args;
  const d = diagram === undefined ? null : parseFamilyValue(families.diagram, diagram, "diagram");
  if (d && !d.ok) return d;
  const h = hints === undefined ? null : parseFamilyValue(families.hints, hints, "hints");
  if (h && !h.ok) return h;
  return { ok: true, args: { ...rest, ...(d?.ok ? { diagram: d.data } : {}), ...(h?.ok ? { hints: h.data } : {}) } };
}

const oneLineInput = () => ({
  ...target,
  view: z.string().min(1).max(200).optional().describe("An existing drafting (detail) view to draw into (id or exact name). The diagram is added to whatever is there unless replace_existing is true."),
  replace_existing: z.literal(true).optional().describe("With view: delete everything already drawn in that view (linework, symbols, notes) in the same change, so a hand-drawn or older diagram is redrawn instead of drawn over."),
  new_view_name: z.string().trim().min(1).max(120).optional().describe('Create a new drafting view with this name, at SCALE: NONE, e.g. "E-601 One-line diagram". Give this or view.'),
  diagram: z.record(z.string(), z.unknown()).optional().describe(ONE_LINE_ARG_COPY.diagram),
  from_model: z.literal(true).optional().describe(ONE_LINE_ARG_COPY.from_model),
  kind: z.enum(DIAGRAM_KINDS).optional().describe(ONE_LINE_ARG_COPY.kind),
  hints: z.record(z.string(), z.unknown()).optional().describe(ONE_LINE_ARG_COPY.hints),
  place_on: z
    .object({ sheet: z.string().min(1).max(200).describe("Sheet id or number."), center_in: z.object({ x: z.number().finite(), y: z.number().finite() }).describe("Viewport centre, paper inches from the sheet's top-left.") })
    .strict()
    .optional()
    .describe("Also put the drafting view on a sheet in the same change."),
});

type OneLineArgs = {
  project_id: string;
  model_id: string;
  view?: string;
  replace_existing?: true;
  new_view_name?: string;
  diagram?: OneLineSpec;
  from_model?: true;
  kind?: DiagramKind;
  hints?: DiagramHints;
  place_on?: { sheet: string; center_in: { x: number; y: number } };
};

interface Planned {
  readonly command: BatchCommand;
  readonly layout: OneLineLayout | null;
  /** A live diagram as it will draw after the change. */
  readonly live: DiagramEvaluation | null;
  readonly viewId: string;
  readonly fromModel: OneLineFromModel | null;
  /** Items already in the view that this change deletes (replace_existing). */
  readonly replaced: number;
  /** Items already in the view that stay under the diagram. */
  readonly kept: number;
}

function requestArgs(args: OneLineArgs) {
  return { view: args.view, replace_existing: args.replace_existing, new_view_name: args.new_view_name, diagram: args.diagram, from_model: args.from_model, kind: args.kind, hints: args.hints, place_on: args.place_on, model_id: args.model_id };
}

/** The whole change as one batch, or the plain reason it can't be drawn. */
function plan(model: ModelState, extra: Extra, args: OneLineArgs): Planned | string {
  if (Boolean(args.diagram) === Boolean(args.from_model)) return "Give either diagram (the distribution) or from_model: true, not both.";
  if (Boolean(args.view) === Boolean(args.new_view_name)) return "Give either view (an existing drafting view) or new_view_name (a new one), not both.";
  if (args.replace_existing && !args.view) return "replace_existing clears an existing view; give it with view, not new_view_name.";
  if (args.from_model) return planLive(model, extra, args);
  if (args.kind || args.hints) return "kind and hints are for a live diagram: give from_model: true.";
  const fromModel: OneLineFromModel | null = null;
  const spec: OneLineSpec | undefined = args.diagram;
  if (!spec) return "Give either diagram or from_model: true.";
  const parsed = oneLineSpecSchema.safeParse(spec);
  if (!parsed.success) return `The diagram isn't a one-line this release reads: ${parsed.error.issues[0]?.message ?? "unknown shape"}.`;
  const problem = checkOneLineSpec(parsed.data);
  if (problem) return problem;

  const steps: ViewCommand[] = [];
  let viewId: string;
  if (args.new_view_name) {
    viewId = stableId("view", extra, requestArgs(args));
    // The same call again (a retry after it saved) makes the same ids, so the server answers with the first save.
    const existing = findView(model, args.new_view_name);
    if (existing && existing !== viewId) return `A view named "${args.new_view_name}" already exists; give it as view, or pick another name.`;
    steps.push({ type: "create_view", viewId, name: args.new_view_name, viewType: "detail", props: { scale: 1 } });
  } else {
    const found = findView(model, args.view ?? "");
    const view = found ? model.elements[found] : undefined;
    if (!found || view?.kind !== "view") return `No view "${args.view}". List views and sheets first.`;
    if (view.viewType !== "detail") return `${view.name} is a ${view.viewType.replace("_", " ")}; a one-line goes in a drafting (detail) view. Use new_view_name to make one.`;
    viewId = found;
    if (args.replace_existing) {
      for (const item of documentIndex(model).itemsByOwner.get(found) ?? []) {
        if (!item.deleted) steps.push({ type: "delete_drawing_item", itemId: item.id });
      }
    }
  }
  const replaced = steps.length;
  const layout = layoutOneLine(spec);
  steps.push(...oneLineCommands(viewId, layout, stableId("sld", extra, requestArgs(args)), ONE_LINE_TEXT_MM));
  if (args.view) steps.push({ type: "set_view_properties", viewId, props: { scale: 1 } });
  steps.push(oneLineCropCommand(viewId, layout));
  if (args.place_on) {
    const sheetId = findSheet(model, args.place_on.sheet);
    if (!sheetId) return `No sheet "${args.place_on.sheet}". List views and sheets first.`;
    steps.push({ type: "place_viewport", viewportId: stableId("vp", extra, requestArgs(args)), sheetId, viewId, center: { x: args.place_on.center_in.x * IN, y: args.place_on.center_in.y * IN }, scale: 1 });
  }
  if (steps.length > 500) return `That diagram is ${steps.length} drawing steps; 500 is the most one change takes. Split it into two drafting views.`;
  return { command: { type: "batch_documents", label: `One-line diagram: ${layout.nodes.length} pieces of equipment`, commands: steps }, layout, live: null, viewId, fromModel, replaced, kept: args.view && !args.replace_existing ? (documentIndex(model).itemsByOwner.get(viewId) ?? []).filter((i) => !i.deleted).length : 0 };
}

const EMPTY_LIVE: Readonly<Record<DiagramKind, string>> & Readonly<Partial<Record<StoredDiagramKind, string>>> = {
  one_line: "The model has no electrical equipment to draw. Place panels and switchboards and feed them (bim_feed_panel), or describe a distribution with no model in diagram.",
  electrical_riser: "The model has no electrical equipment to draw. Place panels and switchboards and feed them (bim_feed_panel) first.",
  plumbing_riser: "The model has no plumbing systems with fixtures connected to draw. Route the piping first.",
  plumbing_isometric: "The model has no plumbing systems with fixtures connected to draw. Route the piping first.",
};

/** A live diagram: create the view (or make an existing drafting view live, or change its hints), optionally place it. No line work is saved. */
function planLive(model: ModelState, extra: Extra, args: OneLineArgs): Planned | string {
  const steps: ViewCommand[] = [];
  let viewId: string;
  let replaced = 0;
  if (args.new_view_name) {
    viewId = stableId("view", extra, requestArgs(args));
    const existing = findView(model, args.new_view_name);
    if (existing && existing !== viewId) return `A view named "${args.new_view_name}" already exists; give it as view, or pick another name.`;
    const diagram: DiagramDefinition = { kind: args.kind ?? "one_line", ...(args.hints ? { hints: args.hints } : {}) };
    steps.push({ type: "create_view", viewId, name: args.new_view_name, viewType: "detail", props: { diagram } });
  } else {
    const found = findView(model, args.view ?? "");
    const view = found ? model.elements[found] : undefined;
    if (!found || view?.kind !== "view") return `No view "${args.view}". List views and sheets first.`;
    if (view.viewType !== "detail") return `${view.name} is a ${view.viewType.replace("_", " ")}; a live diagram is a drafting (detail) view. Use new_view_name to make one.`;
    viewId = found;
    const before = view.props?.diagram;
    const drawn = (documentIndex(model).itemsByOwner.get(found) ?? []).filter((i) => !i.deleted);
    if (!before && drawn.length > 0 && !args.replace_existing) return `${view.name} already has ${drawn.length} drawn items (a static diagram?). Pass replace_existing: true to clear them as it becomes live, or use new_view_name.`;
    if (args.replace_existing) for (const item of drawn) steps.push({ type: "delete_drawing_item", itemId: item.id });
    replaced = steps.length;
    const diagram: DiagramDefinition = { kind: args.kind ?? before?.kind ?? "one_line", hints: { ...(before?.hints ?? {}), ...(args.hints ?? {}) } };
    steps.push({ type: "set_view_properties", viewId, props: { diagram, scale: 1, cropView: false } });
  }
  if (args.place_on) {
    const sheetId = findSheet(model, args.place_on.sheet);
    if (!sheetId) return `No sheet "${args.place_on.sheet}". List views and sheets first.`;
    steps.push({ type: "place_viewport", viewportId: stableId("vp", extra, requestArgs(args)), sheetId, viewId, center: { x: args.place_on.center_in.x * IN, y: args.place_on.center_in.y * IN }, scale: 1 });
  }
  const kind = args.kind ?? "one_line";
  const command: BatchCommand = { type: "batch_documents", label: `${DIAGRAM_KIND_LABELS[kind]} (live)`, commands: steps };
  const after = executeCommand(model, command);
  if (!after.ok) return after.error.message;
  const v = after.model.elements[viewId];
  const live = v?.kind === "view" ? evaluateDiagram(after.model.elements, v) : null;
  const storedKind = v?.kind === "view" ? v.props?.diagram?.kind : undefined;
  if (!live || live.equipment.length === 0) return (storedKind !== undefined ? EMPTY_LIVE[storedKind] : undefined) ?? EMPTY_LIVE[kind];
  return { command, layout: null, live, viewId, fromModel: null, replaced, kept: 0 };
}

/** Each model pipe a piping diagram draws, by the element a click on it selects, and how many drawn pieces light up for it. */
function pipeSummary(boxes: readonly DiagramNodeBox[]): Array<{ id: string; name: string; pieces: number }> {
  const out = new Map<string, { id: string; name: string; pieces: number }>();
  for (const b of boxes) {
    const known = out.get(b.elementId);
    if (known) known.pieces += 1;
    else out.set(b.elementId, { id: b.elementId, name: b.name, pieces: 1 });
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Pairs of text blocks whose boxes overlap (at most 20), so an agent knows what to move. */
function textOverlaps(texts: ReadonlyArray<{ key: string; min: { x: number; y: number }; max: { x: number; y: number } }>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < texts.length && out.length < 20; i++) {
    const a = texts[i];
    for (let j = i + 1; a && j < texts.length && out.length < 20; j++) {
      const b = texts[j];
      if (b && a.min.x < b.max.x && b.min.x < a.max.x && a.min.y < b.max.y && b.min.y < a.max.y) out.push([a.key, b.key]);
    }
  }
  return out;
}

function describe(p: Planned) {
  if (p.live) {
    const e = p.live.extent;
    const pipes = p.live.boxes.filter((b) => b.pipe)
    return {
      view_id: p.viewId,
      live: true,
      kind: p.live.kind,
      equipment: p.live.boxes.filter((b) => !b.pipe).map((b) => ({ id: b.elementId, name: b.name })),
      ...(pipes.length > 0 ? { pipes: pipeSummary(pipes) } : {}),
      warnings: p.live.warnings.map((w) => ({ element_id: w.elementId, message: w.message })),
      // Every block of text, by the key hints.textOffsets moves it with; and which blocks run into each other.
      texts: p.live.texts.slice(0, 80).map((t) => ({ key: t.key, says: t.text, ...(t.elementId ? { element_id: t.elementId } : {}), ...(t.moved ? { moved: true } : {}) })),
      text_overlaps: textOverlaps(p.live.texts),
      size_in: { width: Math.round(((e.max.x - e.min.x) / IN) * 10) / 10, height: Math.round(((e.max.y - e.min.y) / IN) * 10) / 10 },
      ...(p.replaced ? { replaces_existing_items: p.replaced } : {}),
    };
  }
  if (!p.layout) return { view_id: p.viewId };
  const w = p.layout.extent.max.x - p.layout.extent.min.x;
  const h = p.layout.extent.max.y - p.layout.extent.min.y;
  return {
    view_id: p.viewId,
    equipment: p.layout.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name, level: n.depth })),
    drawing_steps: p.command.commands.length,
    size_in: { width: Math.round((w / IN) * 10) / 10, height: Math.round((h / IN) * 10) / 10 },
    ...(p.replaced ? { replaces_existing_items: p.replaced } : {}),
    ...(p.kept ? { drawn_over_existing_items: p.kept, note: `The view already has ${p.kept} drawn items; the diagram is added on top of them. Pass replace_existing: true to clear them in the same change.` } : {}),
    ...(p.fromModel
      ? {
          from_model: {
            equipment: p.fromModel.equipment,
            linked_by_fed_from: p.fromModel.linked,
            at_top: p.fromModel.roots,
            unmatched_fed_from: p.fromModel.unmatchedFedFrom,
            kinds_from_names: p.fromModel.kindsFromNames,
          },
        }
      : {}),
  };
}

export function registerBimOneLineTools(server: McpServer, caller: ResolveBimCaller) {
  server.registerTool(
    "bim_preview_one_line",
    {
      ...ONE_LINE_TOOL_COPY.bim_preview_one_line,
      inputSchema: oneLineInput(),
    },
    async (raw, extra) => {
      const read = parseOneLineArgs("bim_preview_one_line", raw);
      if (!read.ok) return failure(read.message);
      const args = read.args;
      try {
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const p = plan(model, extra, args);
          if (typeof p === "string") return failure(p);
          return text({ ...previewDocumentEdit(model, args.model_id, p.command), ...describe(p) });
        });
      } catch (err) {
        return explain(err, "bim_preview_one_line");
      }
    },
  );

  server.registerTool(
    "bim_layout_one_line",
    {
      ...ONE_LINE_TOOL_COPY.bim_layout_one_line,
      inputSchema: {
        ...oneLineInput(),
        base_revision: z.number().int().min(0).describe("The revision bim_preview_one_line returned."),
        preview_token: z.string().min(16).max(64).describe("The preview_token bim_preview_one_line returned."),
      },
    },
    async (raw, extra) => {
      const read = parseOneLineArgs("bim_layout_one_line", raw);
      if (!read.ok) return failure(read.message);
      const args = read.args;
      try {
        const who = await caller(extra, args.project_id, false);
        const planned = await withSession(who, args.model_id, undefined, async (s) => plan(s.model(), extra, args));
        if (typeof planned === "string") return failure(planned);
        const stale = previewTokenProblem({ modelId: args.model_id, branchId: who.branchId ?? null, command: planned.command, revision: args.base_revision, token: args.preview_token, otherwise: `This isn't the diagram that was previewed at Rev ${args.base_revision}: the arguments or revision differ from the preview. Preview it again and draw with the new preview_token.` });
        if (stale) return failure(stale);
        return runEdit(caller, "bim_layout_one_line", extra, args, planned.command, { model_id: args.model_id, preview_token: args.preview_token });
      } catch (err) {
        return explain(err, "bim_layout_one_line");
      }
    },
  );
}
