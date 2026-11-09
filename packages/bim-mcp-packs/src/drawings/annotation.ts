import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ANCHORS,
  AUTO_TAG_CATEGORIES,
  DIMENSION_KINDS,
  DIMENSION_UNITS,
  TAG_STYLE_BOXES,
  TAG_STYLE_CATEGORIES,
  TAG_STYLE_ORIENTATIONS,
  TAG_STYLE_UNITS,
  TAG_TEMPLATES,
  TERMINATORS,
  anchorInView,
  autoDimensionCommand,
  asElementId,
  clearSpotForTag,
  createTagStyleFromPreset,
  defaultTagStyleFor,
  detailItemBounds,
  dimensionLabels,
  dimensionPoints,
  documentIndex,
  noteText,
  paragraphsForCommand,
  planAutoTags,
  planTagSpread,
  resolveNote,
  organizationOf,
  tagFieldNames,
  tagHasLeader,
  tagItemBox,
  tagLines,
  tagStyleCategoryOf,
  tagSituation,
  tagStyleName,
  tagStylePreset,
  tagStylePresets,
  DEFAULT_NOTE_SIZE_MM,
  type AnchorRef,
  type BatchCommand,
  type Command,
  type DimSpec,
  type DrawingItem,
  type ModelState,
  type TagSpec,
  type TagSpreadPlan,
  type Vec2,
  type ViewElement,
} from "@permitzip/bim-kernel";
import { noteContentInput, noteParagraphs } from "../support/note-input";
import { baseRevision, explain, failure, runEdit, target, text, withSession, type ResolveBimCaller } from "../runtime";
import { editWithModel, previewBranchOf, previewTokenProblem, findSheet, findView, previewDocumentEdit, stableId } from "../views/views";

/**
 * Drafting annotation tools for agents: dimensions (associative to elements or
 * to detail linework), tags driven by element data, deterministic auto-tag,
 * notes with leaders in any view or on a sheet, and reading what a view's
 * annotations say and where they are. The same kernel commands the Annotate
 * tools in the Building Model send; every edit pauses for approval in Cmd+J.
 *
 * Units: points in a view are feet in the view's own frame (plan x/y, a
 * section's distance along the cut and elevation, a detail view's drawing
 * feet); on a sheet, paper inches from its top-left. Offsets and text sizes
 * are paper inches.
 */

const FT = 304.8;
const IN = 25.4;
const ft = (v: number) => v * FT;
const r2 = (v: number) => Math.round(v * 100) / 100;

const ownerRef = z.string().min(1).max(200).describe("A view (id or exact name) or a sheet (id or number).");
const viewRef = z.string().min(1).max(200).describe("View id or exact name.");
const pointInput = z.object({ x: z.number().finite(), y: z.number().finite() });
const anchorInput = z.object({
  element_id: z.string().min(1).max(200).describe("A model element (duct or pipe run, wall, grid, part, equipment, terminal), or a line or other drawing item in the same detail view."),
  anchor: z.enum(ANCHORS).describe("start / end / mid of a run, wall, grid or line; edge_left / edge_right of a duct, pipe or wall; center or insertion of a part."),
  index: z.number().int().min(0).max(49).optional().describe("Drawing items: which of its points."),
});
const dimPointInput = z.union([anchorInput, pointInput]).describe("Follow an element (element_id + anchor: the dimension updates when it moves) or a fixed point (x, y).");
const styleInput = z
  .object({
    units: z.enum(DIMENSION_UNITS).optional(),
    round_to: z.number().positive().max(1000).optional().describe("Inches for ft_in / in (0.125 = 1/8\"), millimetres for mm / m."),
    terminator: z.enum(TERMINATORS).optional(),
    text_height_in: z.number().min(0.06).max(0.4).optional(),
  })
  .optional();

interface Owner {
  readonly id: string;
  readonly view: ViewElement | null;
  /** Agent units → stored coordinates. */
  readonly toStored: (p: Vec2) => Vec2;
  /** Stored coordinates → agent units. */
  readonly toAgent: (p: Vec2) => Vec2;
  /** Stored → this owner's paper mm (a view's own paper, y down; a sheet's paper). */
  readonly toPaper: (p: Vec2) => Vec2;
  readonly unit: "ft" | "in";
}

function resolveOwner(model: ModelState, ref: string): Owner | string {
  const sheetId = findSheet(model, ref);
  if (sheetId) {
    const toStored = (p: Vec2) => ({ x: p.x * IN, y: p.y * IN });
    return { id: sheetId, view: null, toStored, toAgent: (p) => ({ x: r2(p.x / IN), y: r2(p.y / IN) }), toPaper: (p) => p, unit: "in" };
  }
  const viewId = findView(model, ref);
  const view = viewId ? model.elements[viewId] : undefined;
  if (!viewId || view?.kind !== "view") return `No view or sheet "${ref}". List views and sheets first.`;
  if (view.viewType === "three_d" || view.viewType === "schedule") return `${view.name} is a ${view.viewType === "three_d" ? "3D view" : "schedule"}; annotate a plan, section, detail view or sheet.`;
  const s = view.props?.scale ?? 48;
  return {
    id: view.id,
    view,
    toStored: (p) => ({ x: ft(p.x), y: ft(p.y) }),
    toAgent: (p) => ({ x: r2(p.x / FT), y: r2(p.y / FT) }),
    toPaper: (p) => ({ x: p.x / s, y: -p.y / s }),
    unit: "ft",
  };
}

function isAnchor(p: z.infer<typeof dimPointInput>): p is z.infer<typeof anchorInput> {
  return "element_id" in p;
}

/** Each point's stored position (its reference's current spot, or the fixed point) and its reference. */
function dimPoints(model: ModelState, owner: Owner, input: ReadonlyArray<z.infer<typeof dimPointInput>>): { points: Vec2[]; refs: (AnchorRef | null)[] } | string {
  const points: Vec2[] = [];
  const refs: (AnchorRef | null)[] = [];
  for (const p of input) {
    if (isAnchor(p)) {
      const ref: AnchorRef = { elementId: p.element_id, anchor: p.anchor, ...(p.index !== undefined ? { index: p.index } : {}) };
      const at = anchorInView(model, owner.view, ref);
      if (!at) return `Element ${p.element_id} has no ${p.anchor} here (gone, or not that kind of element). Read the view's elements first.`;
      points.push(at);
      refs.push(ref);
    } else {
      points.push(owner.toStored(p));
      refs.push(null);
    }
  }
  return { points, refs };
}

function styleFrom(input: z.infer<typeof styleInput>): DimSpec["style"] | undefined {
  if (!input) return undefined;
  return {
    ...(input.units ? { units: input.units } : {}),
    ...(input.round_to !== undefined ? { roundTo: input.round_to } : {}),
    ...(input.terminator ? { terminator: input.terminator } : {}),
    ...(input.text_height_in !== undefined ? { textSizeMm: input.text_height_in * IN } : {}),
  };
}

function boxOf(model: ModelState, owner: Owner, item: DrawingItem): { min: Vec2; max: Vec2 } | null {
  if (item.tag && item.points[0]) {
    const b = tagItemBox(model, owner.view, item, owner.toPaper);
    return b ? { min: b.min, max: b.max } : null;
  }
  if (!item.dim && item.shape !== "text") {
    // Circles and arcs store a centre and an edge point, components an insertion point: box what prints.
    const drawn = detailItemBounds(item, owner.toPaper);
    if (drawn) return { min: { x: drawn.min.x - 0.5, y: drawn.min.y - 0.5 }, max: { x: drawn.max.x + 0.5, y: drawn.max.y + 0.5 } };
  }
  const pts = (item.dim ? dimensionPoints(model, owner.view, item).points : item.points).map(owner.toPaper);
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const pad = item.dim ? Math.abs(item.dim.offsetMm) + 3 : item.shape === "text" ? 0 : 0.5;
  const w = item.shape === "text" ? (item.note?.box.width ?? 30) : 0;
  return { min: { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad }, max: { x: Math.max(...xs) + pad + w, y: Math.max(...ys) + pad + (item.shape === "text" ? 6 : 0) } };
}

/** A view's or sheet's annotations as an agent reads them. */
export function listAnnotations(model: ModelState, owner: Owner) {
  const items = (documentIndex(model).itemsByOwner.get(owner.id) ?? []).filter((i) => !i.deleted);
  const rows = items.map((item) => {
    const box = boxOf(model, owner, item);
    const base = { id: item.id, shape: item.shape, points: item.points.map(owner.toAgent), paper_box_in: box ? { left: r2(box.min.x / IN), top: r2(box.min.y / IN), right: r2(box.max.x / IN), bottom: r2(box.max.y / IN) } : null };
    if (item.dim) {
      const { orphaned } = dimensionPoints(model, owner.view, item);
      return { ...base, dimension: { kind: item.dim.kind, chain: item.dim.chain ?? null, prints: dimensionLabels(model, owner.view, item), refs: item.dim.refs ?? [], orphaned_points: orphaned, offset_in: r2(item.dim.offsetMm / IN) } };
    }
    if (item.tag) return { ...base, tag: { element_id: item.tag.elementId, template: item.tag.template, prints: tagLines(model, item.tag), leader: tagHasLeader(model, item.tag), ...(item.tag.styleId ? { style: tagStyleName(model, item.tag) ?? item.tag.styleId } : {}) } };
    if (item.shape === "text") {
      const resolved = resolveNote(item);
      return { ...base, note: { text: resolved ? noteText(resolved.note.paragraphs) : (item.text ?? ""), leaders: [...(item.note?.leader ? [item.note.leader] : []), ...(item.note?.leaders ?? [])].map((l) => ({ to: owner.toAgent(l.to), ...(l.elbow ? { elbow: owner.toAgent(l.elbow) } : {}), arrow: l.arrow ?? "arrow" })) } };
    }
    return base;
  });
  const overlaps: Array<[string, string]> = [];
  const boxes = items.flatMap((i) => {
    const b = boxOf(model, owner, i);
    return b && (i.tag || i.dim || i.shape === "text") ? [{ id: i.id, ...b }] : [];
  });
  for (let a = 0; a < boxes.length; a++)
    for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a];
      const q = boxes[b];
      if (p && q && p.min.x < q.max.x && q.min.x < p.max.x && p.min.y < q.max.y && q.min.y < p.max.y) overlaps.push([p.id, q.id]);
    }
  return { owner: owner.id, units: owner.unit === "ft" ? "points in view feet, boxes in paper inches" : "paper inches", count: rows.length, annotations: rows, overlaps };
}

const inches = (mm: number) => Math.round((mm / IN) * 100) / 100;

/**
 * What a tag will look like where the edit puts it, read off the model the
 * command was built from: its words, paper box, and what it overlaps, crosses
 * or crowds. Null for anything that isn't one tag in a plan or section.
 */
export function tagLooks(model: ModelState, owner: Owner, command: Command): Record<string, unknown> | null {
  if (!owner.view) return null;
  let candidate: DrawingItem | null = null;
  if (command.type === "add_drawing_item" && command.shape === "tag" && command.tag) {
    candidate = { id: asElementId(command.itemId), version: 0, authoredRev: {}, kind: "drawing_item", ownerId: asElementId(owner.id), shape: "tag", points: command.points, tag: command.tag };
  } else if (command.type === "update_drawing_item") {
    const was = model.elements[command.itemId];
    if (was?.kind !== "drawing_item" || !was.tag) return null;
    candidate = { ...was, ...(command.points ? { points: command.points } : {}), ...(command.tag ? { tag: command.tag } : {}) };
  }
  if (!candidate) return null;
  const s = tagSituation(model, owner.id, candidate);
  if (!s) return null;
  return {
    looks: {
      prints: s.prints,
      paper_box_in: { left: inches(s.box.min.x), top: inches(s.box.min.y), right: inches(s.box.max.x), bottom: inches(s.box.max.y) },
      ...(s.rotationDeg !== 0 ? { turned_deg: s.rotationDeg } : {}),
      clear: s.clear,
      overlaps: s.overlaps.map((o) => ({ item_id: o.itemId, what: o.what, ...(o.prints ? { prints: o.prints } : {}) })),
      crosses_lines: s.crossesLines,
      nearby_tags: s.nearbyTags.map((t) => ({ item_id: t.itemId, prints: t.prints, gap_in: inches(t.gapMm) })),
      from_element_in: s.distanceToElementMm === null ? null : inches(s.distanceToElementMm),
      ...(s.clear ? {} : { hint: "Not clear: bim_edit_annotation action move with auto_place true puts it at the first clear spot beside its element." }),
    },
  };
}

const styleRef = z.string().min(1).max(200).describe("Tag style id or exact name (bim_list_tag_styles).");
/** Absent, a new tag takes the default style for its element's kind, if one is set. */
const newTagStyle = styleRef.optional().describe("Tag style id or exact name (bim_list_tag_styles). Absent: the kind's default style, if any.");

const autoTagInput = {
  view: viewRef,
  categories: z.array(z.enum(AUTO_TAG_CATEGORIES)).min(1).max(AUTO_TAG_CATEGORIES.length).describe("What to tag: duct (sizes), pipe (sizes), air_terminal (mark + CFM), equipment, fixture, part."),
  leaders: z.enum(["when_away", "always", "never"]).default("when_away"),
  include_tagged: z.boolean().default(false).describe("Also tag elements that already have a tag in this view."),
  text_height_in: z.number().min(0.06).max(0.25).optional(),
  style: newTagStyle,
};

type AutoTagArgs = { view: string; categories: Array<(typeof AUTO_TAG_CATEGORIES)[number]>; leaders?: "when_away" | "always" | "never"; include_tagged?: boolean; text_height_in?: number; style?: string };


/** A tag style's id from its id or name; null when there is none. */
function findTagStyle(model: ModelState, ref: string): string | null {
  const key = ref.trim().toLowerCase();
  return organizationOf(model).tagStyles.find((s) => s.id === ref || s.entry.name.trim().toLowerCase() === key)?.id ?? null;
}

/** Tag styles as an agent reads them: what each says, how it looks, what it is the default for, and how many tags use it. */
export function listTagStyles(model: ModelState) {
  const used = new Map<string, number>();
  for (const items of documentIndex(model).itemsByOwner.values()) for (const it of items) if (!it.deleted && it.tag?.styleId) used.set(it.tag.styleId, (used.get(it.tag.styleId) ?? 0) + 1);
  return {
    revision: model.revision,
    fields: tagFieldNames(model),
    styles: organizationOf(model).tagStyles.map((s) => ({
      id: s.id,
      name: s.entry.name,
      lines: s.entry.lines,
      text_height_in: Math.round((s.entry.textSizeMm / IN) * 1000) / 1000,
      leader: s.entry.leader,
      // true / false for the plain box or none (as before shapes existed), else the shape's name.
      box: s.entry.box === "box" ? true : s.entry.box === "none" ? false : s.entry.box,
      ...(s.entry.prefix ? { prefix: s.entry.prefix } : {}),
      ...(s.entry.suffix ? { suffix: s.entry.suffix } : {}),
      ...(s.entry.orientation ? { orientation: s.entry.orientation } : {}),
      ...(s.entry.units ? { units: s.entry.units } : {}),
      ...(s.entry.leaderEnd ? { leader_end: s.entry.leaderEnd } : {}),
      ...(s.entry.arrow ? { arrow: s.entry.arrow } : {}),
      ...(s.entry.appliesTo?.length ? { applies_to: s.entry.appliesTo } : {}),
      default_for: s.entry.defaultFor,
      tags_using_it: used.get(s.id) ?? 0,
      built_in: s.builtIn,
    })),
    presets: tagStylePresets().map((p) => ({ id: p.id, name: p.name, trade: p.trade, does: p.description })),
  };
}

function autoTagBatch(model: ModelState, viewId: string, args: AutoTagArgs, idPrefix: string) {
  const plan = planAutoTags(model, viewId, {
    categories: args.categories,
    leader: args.leaders ?? "when_away",
    skipTagged: !(args.include_tagged ?? false),
    idPrefix,
    ...(args.text_height_in ? { textSizeMm: args.text_height_in * IN } : {}),
    ...(args.style ? { styleId: findTagStyle(model, args.style) ?? args.style } : {}),
  });
  const command: BatchCommand | null =
    plan.items.length > 0
      ? { type: "batch_documents", label: `Tag ${plan.items.length} element${plan.items.length === 1 ? "" : "s"}`, commands: plan.items.slice(0, 500).map((it) => ({ type: "add_drawing_item" as const, itemId: it.itemId, ownerId: viewId, shape: "tag" as const, points: [it.at], tag: it.tag })) }
      : null;
  return { plan, command };
}

/** The `describe` hook for tag edits: resolve the owner again on the same model and say what the tag will look like. */
function describeTag(ownerRef: string) {
  return (model: ModelState, command: Command): Record<string, unknown> | null => {
    const owner = resolveOwner(model, ownerRef);
    return typeof owner === "string" ? null : tagLooks(model, owner, command);
  };
}

type SpreadPlan = { readonly plan: TagSpreadPlan } | { readonly refused: string };

function planSpread(model: ModelState, owner: Owner, itemIds: readonly string[]): SpreadPlan {
  if (!owner.view) return { refused: "Spread tags works on tags in a plan or section, not on a sheet." };
  if (new Set(itemIds).size < 2) return { refused: "Spreading moves two or more tags: give the others in item_ids." };
  try {
    return { plan: planTagSpread(model, owner.id, itemIds) };
  } catch (err) {
    console.error("[bim_edit_annotation] planning a tag spread failed", { viewId: owner.id, err });
    return { refused: err instanceof Error ? err.message : "The tags couldn't be spread." };
  }
}

/**
 * Selection › Spread tags (U9): the chosen tags move clear of every other
 * tag, note and dimension, each with an elbow leader, as one undo step.
 * Unchosen annotations stay put; a bend placed by hand is kept.
 */
function spreadTagsCommand(model: ModelState, owner: Owner, itemIds: readonly string[]): Command | string {
  const planned = planSpread(model, owner, itemIds);
  if ("refused" in planned) return planned.refused;
  const { updates, kept } = planned.plan;
  if (updates.length === 0) return `Nothing to move: ${kept.map((k) => `${k.itemId} (${k.reason})`).join(", ") || "no tags given"}.`;
  return { type: "batch_documents", label: "Spread tags", commands: updates.map((u) => ({ type: "update_drawing_item" as const, itemId: u.itemId, points: [u.at], tag: u.tag })) };
}

function describeSpread(ownerRef: string, itemIds: readonly string[]) {
  return (model: ModelState): Record<string, unknown> | null => {
    const owner = resolveOwner(model, ownerRef);
    if (typeof owner === "string") return null;
    const planned = planSpread(model, owner, itemIds);
    if ("refused" in planned) return null;
    const { updates, kept } = planned.plan;
    const hand = updates.filter((u) => !u.clear).map((u) => u.itemId);
    return {
      spread: updates.length,
      ...(hand.length > 0 ? { need_a_hand: hand, need_a_hand_why: "No clear spot near them; move them by hand (dx / dy) or crop the view less tightly." } : {}),
      ...(kept.length > 0 ? { kept: kept.map((k) => ({ item_id: k.itemId, reason: k.reason })) } : {}),
    };
  };
}

export function registerBimAnnotationTools(server: McpServer, caller: ResolveBimCaller) {
  server.registerTool(
    "bim_list_view_annotations",
    {
      title: "Read a view's or sheet's annotations",
      description:
        "Every dimension, tag, note, line, rectangle and cloud in a plan, section, detail view or on a sheet: id, what it prints (dimension values, tag words, note text), points (view feet, or paper inches on a sheet), its paper box, the elements a dimension or tag follows and any it lost (orphaned), note leaders, and which annotations overlap. Use it before editing a detail or tidying a plan.",
      inputSchema: { ...target, owner: ownerRef },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const owner = resolveOwner(model, args.owner);
          if (typeof owner === "string") return failure(owner);
          return text({ ...listAnnotations(model, owner), revision: model.revision });
        });
      } catch (err) {
        return explain(err, "bim_list_view_annotations");
      }
    },
  );

  server.registerTool(
    "bim_add_dimension",
    {
      title: "Add a dimension",
      description:
        "Dimension in a plan, section or detail view. kind: linear (horizontal / vertical), aligned, angular (vertex, two points), radial / diameter (centre, a point on it), arc_length (centre, start, end), spot_elevation / spot_coordinate (the point, then the text). Two points, or more with chain continuous or baseline. A point follows an element (element_id + anchor; updates when the model moves) or is fixed in view feet. offset_in: the line's distance from the first point on paper (sign picks the side). Text override, prefix, suffix, style optional.",
      inputSchema: {
        ...target,
        ...baseRevision,
        view: viewRef,
        kind: z.enum(DIMENSION_KINDS),
        points: z.array(dimPointInput).min(2).max(50),
        direction: z.enum(["horizontal", "vertical"]).optional().describe("linear only."),
        chain: z.enum(["continuous", "baseline"]).optional(),
        offset_in: z.number().min(-8).max(8).default(0.375),
        text_override: z.string().trim().min(1).max(80).optional(),
        prefix: z.string().max(20).optional(),
        suffix: z.string().max(20).optional(),
        style: styleInput,
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_add_dimension", extra, args, (model) => {
        const owner = resolveOwner(model, args.view);
        if (typeof owner === "string") return owner;
        if (!owner.view) return "Dimensions measure a view. Give a plan, section or detail view, not a sheet.";
        const pts = dimPoints(model, owner, args.points);
        if (typeof pts === "string") return pts;
        const style = styleFrom(args.style);
        const dim: DimSpec = {
          kind: args.kind,
          ...(args.direction ? { direction: args.direction } : args.kind === "linear" ? { direction: "horizontal" as const } : {}),
          ...(args.chain ? { chain: args.chain } : {}),
          ...(pts.refs.some((r) => r) ? { refs: pts.refs } : {}),
          offsetMm: (args.offset_in ?? 0.375) * IN,
          ...(args.text_override ? { textOverride: args.text_override } : {}),
          ...(args.prefix ? { prefix: args.prefix } : {}),
          ...(args.suffix ? { suffix: args.suffix } : {}),
          ...(style && Object.keys(style).length > 0 ? { style } : {}),
        };
        return { type: "add_drawing_item", itemId: stableId("dim", extra, { ...args, base_revision: undefined }), ownerId: owner.id, shape: "dimension", points: pts.points, dim };
      }),
  );

  server.registerTool(
    "bim_auto_dimension",
    {
      title: "Dimension runs or grid lines automatically",
      description:
        "Deterministic dimensions for elements in a plan or section: mode each puts one aligned dimension along every run, wall or grid given (its start to end, offset beside it); mode chain puts one continuous string across them (horizontal or vertical) through each one's centreline, ordered along the string. All of it is one edit and every dimension follows its element.",
      inputSchema: {
        ...target,
        ...baseRevision,
        view: viewRef,
        element_ids: z.array(z.string().min(1).max(200)).min(1).max(200),
        mode: z.enum(["each", "chain"]),
        direction: z.enum(["horizontal", "vertical"]).optional().describe("chain only (default: horizontal)."),
        offset_in: z.number().min(-8).max(8).default(0.375),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_auto_dimension", extra, args, (model) => {
        const owner = resolveOwner(model, args.view);
        if (typeof owner === "string") return owner;
        if (!owner.view) return "Automatic dimensions measure model elements; give a plan or a section.";
        const prefix = stableId("adim", extra, { ...args, base_revision: undefined });
        return autoDimensionCommand(model, owner.id, owner.view, args.element_ids, { mode: args.mode, ...(args.direction ? { direction: args.direction } : {}), offsetMm: (args.offset_in ?? 0.375) * IN, idPrefix: prefix });
      }),
  );

  server.registerTool(
    "bim_add_tag",
    {
      title: "Tag an element",
      description:
        "Tag one element in a plan or section. template auto picks by kind (duct or pipe size, terminal mark + CFM, equipment or fixture mark), or name one; fields lists parameters, one per line. The words always come from the element. at_ft places the head; absent, the first clear spot beside it. Returns looks: what it overlaps or crosses.",
      inputSchema: {
        ...target,
        ...baseRevision,
        view: viewRef,
        element_id: z.string().min(1).max(200),
        template: z.enum(TAG_TEMPLATES).default("auto"),
        fields: z.array(z.string().min(1).max(60)).max(6).optional(),
        leader: z.boolean().default(false),
        at_ft: pointInput.optional(),
        text_height_in: z.number().min(0.06).max(0.25).optional(),
        style: newTagStyle,
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_add_tag", extra, args, (model) => {
        const owner = resolveOwner(model, args.view);
        if (typeof owner === "string") return owner;
        if (!owner.view) return "Tags go in a plan or a section.";
        const element = model.elements[args.element_id];
        const styleId = args.style ? findTagStyle(model, args.style) : element ? defaultTagStyleFor(model, element) : null;
        if (args.style && !styleId) return `No tag style "${args.style}". List them with bim_list_tag_styles.`;
        const tag: TagSpec = { elementId: args.element_id, template: args.template ?? "auto", leader: args.leader ?? false, ...(args.fields ? { fields: args.fields } : {}), ...(args.text_height_in ? { textSizeMm: args.text_height_in * IN } : {}), ...(styleId ? { styleId } : {}) };
        let at: Vec2 | null = args.at_ft ? owner.toStored(args.at_ft) : null;
        if (!at) {
          const plan = planAutoTags(model, owner.id, { categories: ["duct", "pipe", "air_terminal", "equipment", "fixture", "part"], idPrefix: "probe", skipTagged: false, leader: args.leader ? "always" : "never" });
          at = plan.items.find((i) => i.elementId === args.element_id)?.at ?? anchorInView(model, owner.view, { elementId: args.element_id, anchor: "mid" });
        }
        if (!at) return `Element ${args.element_id} isn't in this view.`;
        return { type: "add_drawing_item", itemId: stableId("tag", extra, { ...args, base_revision: undefined }), ownerId: owner.id, shape: "tag", points: [at], tag };
      }, describeTag(args.view)),
  );

  server.registerTool(
    "bim_preview_auto_tag",
    {
      title: "Preview tagging a view",
      description:
        "Tag all in a plan or section, previewed: everything of the categories, each tag at the first spot beside its element clear of linework and other annotations; existing tags stay. Returns what each will say, what couldn't be tagged and why, and a preview_token for bim_auto_tag_view.",
      inputSchema: { ...target, ...autoTagInput },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const viewId = findView(model, args.view);
          if (!viewId) return failure(`No view "${args.view}". List views and sheets first.`);
          const { plan, command } = autoTagBatch(model, viewId, args, stableId("autotag", extra, { view: viewId, categories: args.categories }));
          const preview = command ? previewDocumentEdit(model, args.model_id, command) : null;
          return text({
            status: !command ? "nothing_to_tag" : preview?.status,
            revision: model.revision,
            will_tag: plan.items.length,
            tags: plan.items.slice(0, 100).map((i) => ({ element_id: i.elementId, prints: i.text, leader: i.tag.leader })),
            already_tagged: plan.alreadyTagged,
            could_not_tag: plan.skipped,
            ...(preview?.status === "would_save" ? { preview_token: preview.preview_token } : preview ? { message: preview.message } : {}),
          });
        });
      } catch (err) {
        return explain(err, "bim_preview_auto_tag");
      }
    },
  );

  server.registerTool(
    "bim_auto_tag_view",
    {
      title: "Tag a view",
      description: "Apply the tags bim_preview_auto_tag returned (same arguments, its base_revision and preview_token) as one edit. Refused if the model changed since the preview: preview again.",
      inputSchema: { ...target, ...autoTagInput, base_revision: z.number().int().min(0), preview_token: z.string().min(16).max(64) },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const built = await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          if (model.revision !== args.base_revision) return `The model is at Rev ${model.revision}, not Rev ${args.base_revision} where the tags were previewed. Preview again.`;
          const viewId = findView(model, args.view);
          if (!viewId) return `No view "${args.view}".`;
          const { command } = autoTagBatch(model, viewId, args, stableId("autotag", extra, { view: viewId, categories: args.categories }));
          if (!command) return "Nothing to tag in this view.";
          const stale = previewTokenProblem({ modelId: args.model_id, branchId: previewBranchOf(model), command, revision: model.revision, token: args.preview_token, otherwise: "These aren't the tags that were previewed. Preview again with the same arguments." });
          if (stale) return stale;
          return command;
        });
        if (typeof built === "string") return failure(built);
        return runEdit(caller, "bim_auto_tag_view", extra, args, built, { model_id: args.model_id, preview_token: args.preview_token });
      } catch (err) {
        return explain(err, "bim_auto_tag_view");
      }
    },
  );

  server.registerTool(
    "bim_add_note",
    {
      title: "Add a note anywhere",
      description:
        "A rich text note (bold, italic, underline, lists, sizes; prints as shown) in a plan, section, detail view or on a sheet, with leaders to points, each with an optional elbow and an arrow, dot, tick or none. Points are view feet, or paper inches on a sheet (at_in). The box stays paper-sized at any scale.",
      inputSchema: {
        ...target,
        ...baseRevision,
        owner: ownerRef,
        ...noteContentInput,
        at: pointInput.describe("The box's top-left: view feet, or paper inches on a sheet."),
        width_in: z.number().min(0.5).max(30).default(3),
        text_height_in: z.number().min(0.06).max(1).optional(),
        leaders: z
          .array(z.object({ to: pointInput, elbow: pointInput.optional(), arrow: z.enum(["arrow", "dot", "tick", "none"]).optional() }))
          .max(9)
          .optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_add_note", extra, args, (model) => {
        const owner = resolveOwner(model, args.owner);
        if (typeof owner === "string") return owner;
        const paragraphs = noteParagraphs(args);
        if (typeof paragraphs === "string") return paragraphs;
        return {
          type: "create_text_note",
          itemId: stableId("note", extra, { ...args, base_revision: undefined }),
          ownerId: owner.id,
          at: owner.toStored(args.at),
          width: (args.width_in ?? 3) * IN,
          textSize: args.text_height_in !== undefined ? args.text_height_in * IN : DEFAULT_NOTE_SIZE_MM,
          paragraphs: paragraphsForCommand(paragraphs),
          ...(args.leaders ? { leaders: args.leaders.map((l) => ({ to: owner.toStored(l.to), ...(l.elbow ? { elbow: owner.toStored(l.elbow) } : {}), ...(l.arrow ? { arrow: l.arrow } : {}) })) } : {}),
        };
      }),
  );

  server.registerTool(
    "bim_edit_annotation",
    {
      title: "Edit an annotation",
      description:
        "Change one annotation by id (from bim_list_view_annotations): move it by dx / dy (view feet, or paper inches on a sheet) or auto_place a tag clear beside its element; change a dimension's text override / prefix / suffix / offset / style or points (as in bim_add_dimension); a tag's template, fields, leader, elbow or style; a note's leaders; spread tags (item_id + item_ids) clear of each other; or delete it. Tag edits return looks (what it overlaps or crosses). One per call; for many, bim_apply_views_sheets_edit with a batch.",
      inputSchema: {
        ...target,
        ...baseRevision,
        owner: ownerRef,
        item_id: z.string().min(1).max(200),
        action: z.enum(["move", "dimension", "tag", "leaders", "delete", "spread"]),
        dx: z.number().finite().optional(),
        dy: z.number().finite().optional(),
        auto_place: z.boolean().optional(),
        points: z.array(dimPointInput).min(2).max(50).optional(),
        offset_in: z.number().min(-8).max(8).optional(),
        text_override: z.string().trim().max(80).optional().describe("Empty string clears it."),
        prefix: z.string().max(20).optional(),
        suffix: z.string().max(20).optional(),
        style: styleInput,
        template: z.enum(TAG_TEMPLATES).optional(),
        fields: z.array(z.string().min(1).max(60)).max(6).optional(),
        leader: z.boolean().optional(),
        tag_style: z.string().max(200).optional().describe("action tag: tag style id or name; \"\" removes it."),
        elbow: z.union([z.literal("auto"), pointInput]).optional().describe('action tag: "auto" = elbow leader (also straightens a hand-placed bend); a point (view feet) places the bend.'),
        item_ids: z.array(z.string().min(1).max(200)).max(499).optional().describe("action spread: the other tags that move with item_id, clear of each other, with elbow leaders."),
        leaders: z
          .array(z.object({ to: pointInput, elbow: pointInput.optional(), arrow: z.enum(["arrow", "dot", "tick", "none"]).optional() }))
          .max(9)
          .optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_edit_annotation", extra, args, (model) => {
        const owner = resolveOwner(model, args.owner);
        if (typeof owner === "string") return owner;
        if (args.action === "spread") return spreadTagsCommand(model, owner, [args.item_id, ...(args.item_ids ?? [])]);
        const item = model.elements[args.item_id];
        if (item?.kind !== "drawing_item" || item.deleted || item.ownerId !== owner.id) return `No annotation "${args.item_id}" in ${args.owner}. Read its annotations first.`;
        const delta = owner.toStored({ x: args.dx ?? 0, y: args.dy ?? 0 });
        switch (args.action) {
          case "delete":
            return item.shape === "text" ? { type: "delete_text_note", itemId: item.id } : { type: "delete_drawing_item", itemId: item.id };
          case "move": {
            if (args.auto_place) {
              if (!item.tag) return "auto_place moves tags; give dx / dy for other annotations.";
              const spot = clearSpotForTag(model, owner.id, item.id);
              if (!spot) return "No clear spot beside its element (or this isn't a plan or section). Give dx / dy, or crop the view less tightly.";
              return { type: "update_drawing_item", itemId: item.id, points: [spot.at] };
            }
            if (args.dx === undefined && args.dy === undefined) return "Moving needs dx or dy (or auto_place for a tag).";
            if (item.shape === "text") {
              const at = item.points[0];
              if (!at) return "That note has no position.";
              return { type: "move_text_note", itemId: item.id, at: { x: at.x + delta.x, y: at.y + delta.y } };
            }
            return { type: "update_drawing_item", itemId: item.id, points: item.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })) };
          }
          case "dimension": {
            if (!item.dim) return "That isn't a dimension.";
            let points = item.points.slice();
            let refs = item.dim.refs;
            if (args.points) {
              const pts = dimPoints(model, owner, args.points);
              if (typeof pts === "string") return pts;
              points = pts.points;
              refs = pts.refs.some((r) => r) ? pts.refs : undefined;
            }
            const style = { ...item.dim.style, ...styleFrom(args.style) };
            const { textOverride: _o, prefix: _p, suffix: _s, refs: _r, ...rest } = item.dim;
            const override = args.text_override === undefined ? item.dim.textOverride : args.text_override || undefined;
            const prefix = args.prefix ?? item.dim.prefix;
            const suffix = args.suffix ?? item.dim.suffix;
            const dim: DimSpec = {
              ...rest,
              ...(refs ? { refs } : {}),
              ...(args.offset_in !== undefined ? { offsetMm: args.offset_in * IN } : {}),
              ...(override ? { textOverride: override } : {}),
              ...(prefix ? { prefix } : {}),
              ...(suffix ? { suffix } : {}),
              ...(Object.keys(style).length > 0 ? { style } : {}),
            };
            return { type: "update_drawing_item", itemId: item.id, points, dim };
          }
          case "tag": {
            if (!item.tag) return "That isn't a tag.";
            const { styleId: oldStyle, ...unstyled } = item.tag;
            let styleId = oldStyle;
            if (args.tag_style !== undefined) {
              styleId = args.tag_style === "" ? undefined : (findTagStyle(model, args.tag_style) ?? undefined);
              if (args.tag_style !== "" && !styleId) return `No tag style "${args.tag_style}". List them with bim_list_tag_styles.`;
            }
            if (args.elbow !== undefined && args.leader === false) return "An elbow bends the tag's leader; leave out leader: false (or turn the leader off without an elbow).";
            const elbow = args.elbow === undefined ? {} : { elbow: args.elbow === "auto" ? ("auto" as const) : owner.toStored(args.elbow), leader: true };
            const tag: TagSpec = { ...unstyled, ...(args.template ? { template: args.template } : {}), ...(args.fields ? { fields: args.fields } : {}), ...(args.leader !== undefined ? { leader: args.leader } : {}), ...elbow, ...(styleId ? { styleId } : {}) };
            return { type: "update_drawing_item", itemId: item.id, tag };
          }
          case "leaders": {
            if (item.shape !== "text") return "Only notes have leaders this way; a tag's leader is on or off (action tag, leader).";
            return { type: "move_text_note", itemId: item.id, leaders: (args.leaders ?? []).map((l) => ({ to: owner.toStored(l.to), ...(l.elbow ? { elbow: owner.toStored(l.elbow) } : {}), ...(l.arrow ? { arrow: l.arrow } : {}) })) };
          }
        }
      }, args.action === "spread" ? describeSpread(args.owner, [args.item_id, ...(args.item_ids ?? [])]) : describeTag(args.owner)),
  );

  server.registerTool(
    "bim_list_tag_styles",
    {
      title: "List tag styles",
      description: "The model's tag styles (lines with {field} placeholders, text height, leader, box, default_for kinds, tags using each) and the field names a style can use.",
      inputSchema: { ...target },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) => text(listTagStyles(s.model())));
      } catch (err) {
        return explain(err, "bim_list_tag_styles");
      }
    },
  );

  server.registerTool(
    "bim_save_tag_style",
    {
      title: "Create, change or delete a tag style",
      description:
        "A named tag look many tags share; changing it changes them all. style (id or name) changes or deletes one; without it, creates one named name, or from a preset (bim_list_tag_styles). lines: words and {field paths} per printed line, e.g. [\"{size}[ {insulation}]\"], [\"{pipe.size}\", \"{pipe.length_lf}\"]. box: true, false or a shape. orientation along: words follow the run. applies_to: kinds it labels; default_for: kinds whose new tags take it. \"\" clears prefix / suffix. delete: true removes an unused style.",
      inputSchema: {
        ...target,
        ...baseRevision,
        style: styleRef.optional(),
        name: z.string().trim().min(1).max(80).optional(),
        lines: z.array(z.string().trim().min(1).max(120)).min(1).max(6).optional(),
        text_height_in: z.number().min(0.06).max(0.4).optional(),
        leader: z.boolean().optional(),
        box: z.union([z.boolean(), z.enum(TAG_STYLE_BOXES)]).optional(),
        prefix: z.string().max(20).optional(),
        suffix: z.string().max(20).optional(),
        orientation: z.enum(TAG_STYLE_ORIENTATIONS).optional(),
        units: z.enum(TAG_STYLE_UNITS).optional(),
        applies_to: z.array(z.enum(TAG_STYLE_CATEGORIES)).max(TAG_STYLE_CATEGORIES.length).optional(),
        default_for: z.array(z.enum(TAG_STYLE_CATEGORIES)).max(TAG_STYLE_CATEGORIES.length).optional(),
        preset: z.string().min(1).max(80).optional(),
        delete: z.literal(true).optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_save_tag_style", extra, args, (model) => {
        const existing = args.style ? findTagStyle(model, args.style) : null;
        if (args.style && !existing) return `No tag style "${args.style}". List them with bim_list_tag_styles, or leave style out to create one.`;
        const box = args.box === undefined ? undefined : args.box === true ? ("box" as const) : args.box === false ? ("none" as const) : args.box;
        const looks = {
          ...(args.lines ? { lines: args.lines } : {}),
          ...(args.text_height_in !== undefined ? { textSizeMm: Math.round(args.text_height_in * IN * 100) / 100 } : {}),
          ...(args.leader !== undefined ? { leader: args.leader } : {}),
          ...(box ? { box } : {}),
          ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
          ...(args.suffix !== undefined ? { suffix: args.suffix } : {}),
          ...(args.orientation ? { orientation: args.orientation } : {}),
          ...(args.units ? { units: args.units } : {}),
          ...(args.applies_to ? { appliesTo: args.applies_to } : {}),
          ...(args.default_for ? { defaultFor: args.default_for } : {}),
        };
        if (args.delete) {
          if (!existing) return "Name the tag style to delete (style).";
          return { type: "delete_tag_style", styleId: existing };
        }
        if (existing) return { type: "update_tag_style", styleId: existing, ...(args.name ? { name: args.name } : {}), ...looks };
        if (args.preset) {
          const preset = tagStylePreset(args.preset);
          if (!preset) return `No tag style preset "${args.preset}". bim_list_tag_styles lists them.`;
          const made = createTagStyleFromPreset(preset, stableId("tst", extra, { preset: args.preset, name: args.name }), organizationOf(model).tagStyles.map((t) => t.entry.name));
          return { ...made, ...(args.name ? { name: args.name } : {}), ...looks };
        }
        if (!args.name || !args.lines) return "A new tag style needs a name and its lines (or a preset).";
        return { type: "create_tag_style", styleId: stableId("tst", extra, { name: args.name }), name: args.name, lines: args.lines, ...looks };
      }),
  );

  server.registerTool(
    "bim_apply_tag_style",
    {
      title: "Give tags a tag style",
      description: "Put the tags in a plan or section (all, or only kinds / item_ids) on one tag style in one edit; their words, size, box and leader then follow it.",
      inputSchema: {
        ...target,
        ...baseRevision,
        view: viewRef,
        style: styleRef,
        kinds: z.array(z.enum(TAG_STYLE_CATEGORIES)).min(1).max(TAG_STYLE_CATEGORIES.length).optional(),
        item_ids: z.array(z.string().min(1).max(200)).min(1).max(500).optional().describe("Tag ids (bim_list_view_annotations)."),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_apply_tag_style", extra, args, (model) => {
        const owner = resolveOwner(model, args.view);
        if (typeof owner === "string") return owner;
        const styleId = findTagStyle(model, args.style);
        if (!styleId) return `No tag style "${args.style}". List them with bim_list_tag_styles.`;
        const kinds = args.kinds ? new Set(args.kinds) : null;
        const ids = args.item_ids ? new Set(args.item_ids) : null;
        const tags = (documentIndex(model).itemsByOwner.get(owner.id) ?? []).filter((it) => {
          if (it.deleted || !it.tag || it.tag.styleId === styleId) return false;
          if (ids && !ids.has(it.id)) return false;
          if (kinds) {
            const el = model.elements[it.tag.elementId];
            const kind = el ? tagStyleCategoryOf(model, el) : null;
            if (!kind || !kinds.has(kind)) return false;
          }
          return true;
        });
        if (tags.length === 0) return "No tags there need this style (they already use it, or none match).";
        const name = organizationOf(model).tagStyleById.get(styleId)?.entry.name ?? styleId;
        return {
          type: "batch_documents",
          label: `Use "${name}" on ${tags.length} tag${tags.length === 1 ? "" : "s"}`,
          commands: tags.slice(0, 500).flatMap((it) => (it.tag ? [{ type: "update_drawing_item" as const, itemId: it.id, tag: { ...it.tag, styleId } }] : [])),
        };
      }),
  );
}
