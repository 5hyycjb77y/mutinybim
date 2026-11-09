import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DETAIL_COMPONENTS,
  DETAIL_LINE_STYLES,
  DRAFTING_CATEGORIES,
  HATCH_PATTERNS,
  LINE_PATTERNS,
  LINE_WEIGHTS_2D,
  documentIndex,
  lineStyleFor,
  arcStartEndRadius,
  chartKind,
  chartKinds,
  chainLines,
  modifyCommand,
  polygonLines,
  rectangleLines,
  tangentEndArc,
  type LineStyle,
  type ModelState,
  type ModifyOp,
  type ViewCommand,
  type Vec2,
} from "@permitzip/bim-kernel";
import { explain, failure, target, text, baseRevision, type ResolveBimCaller } from "../runtime";
import { advertisedVariant, commandFamily, parseFamilyArray, parseFamilyValue } from "../parts/describe-commands";
import { editWithModel, findSheet, findView, stableId } from "../views/views";
import { ensureBimChartKinds } from "@permitzip/bim-editor/contracts/bim/chart-kinds";

ensureBimChartKinds();

/**
 * Detailing tools for agents, on BIM drafting-view conventions: draw a whole
 * detail (detail lines, which a rectangle, polygon or chain makes as joined
 * lines; arcs, circles, splines, hatched and masking regions, library
 * components, repeating details, insulation) as one edit; modify drawn items
 * (move, copy, rotate, scale, mirror, arrays, align, offset, trim/extend to
 * corner, single or multiple, split, split with gap, fillet arc, chamfer,
 * drag an end, pin, delete, match type) through the same planner people's
 * Modify tools use; copy items between views; group them. Every edit pauses
 * for approval in Cmd+J.
 *
 * Units: in a view, points are view feet and sizes inches (model inches: a
 * 6" valve is 6); on a sheet, points and sizes are paper inches.
 */

const FT = 304.8;
const IN = 25.4;

const ownerRef = z.string().min(1).max(200).describe("A detail view, plan or section (id or exact name), or a sheet (id or number).");
const pt = z.object({ x: z.number().finite(), y: z.number().finite() });
const LINE_STYLE_IDS = DETAIL_LINE_STYLES.map((s) => s.id) as [(typeof DETAIL_LINE_STYLES)[number]["id"], ...(typeof DETAIL_LINE_STYLES)[number]["id"][]];
/** Spread into every drawn shape, so its wording lives once in bim_draw_detail's description, not 15 times in the schema. */
const style = {
  line_style: z.enum(LINE_STYLE_IDS).optional(),
  weight: z.enum(LINE_WEIGHTS_2D).optional(),
  pattern: z.enum(LINE_PATTERNS).optional(),
  category: z.enum(DRAFTING_CATEGORIES).optional(),
  group: z.string().trim().min(1).max(120).optional(),
};
const sizeIn = z.number().positive().max(10_000);

const drawItem = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("line"), from: pt, to: pt, ...style }),
  z.object({ shape: z.literal("rect"), corner: pt, opposite: pt, ...style }),
  z.object({
    shape: z.literal("polygon"),
    center: pt,
    radius: z.number().positive(),
    sides: z.number().int().min(3).max(64),
    inscribed: z.boolean().default(true).describe("false: circumscribed."),
    rotation_deg: z.number().finite().min(-360).max(360).optional().describe("First corner's turn from +x."),
    ...style,
  }),
  z.object({ shape: z.literal("chain"), points: z.array(pt).min(2).max(500), closed: z.boolean().optional().describe("Close it."), ...style }),
  z.object({ shape: z.literal("arc"), center: pt, start: pt, end: pt, clockwise: z.boolean().optional().describe("Default counter-clockwise."), ...style }),
  z.object({ shape: z.literal("arc_radius"), start: pt, end: pt, radius: z.number().positive(), toward: pt.describe("Bulge side."), ...style }),
  z.object({ shape: z.literal("arc_tangent"), start: pt, end: pt, from: pt.describe("A point behind start on the line it continues."), ...style }),
  z.object({ shape: z.literal("circle"), center: pt, radius: z.number().positive(), ...style }),
  z.object({ shape: z.literal("polyline"), points: z.array(pt).min(2).max(500), closed: z.boolean().optional(), ...style }),
  z.object({ shape: z.literal("spline"), points: z.array(pt).min(3).max(500), closed: z.boolean().optional(), ...style }),
  z.object({
    shape: z.literal("region"),
    points: z.array(pt).min(3).max(500),
    hatch: z.enum(HATCH_PATTERNS).default("diagonal"),
    masking: z.boolean().optional().describe("White, hides what is under it."),
    boundary: z.boolean().optional().describe("Outline; default on."),
    spacing_in: z.number().min(0.02).max(1).optional().describe("Hatch spacing on paper."),
    ...style,
  }),
  z.object({
    shape: z.literal("component"),
    symbol: z.string().min(1).max(80).describe("From bim_list_detail_components."),
    at: pt.describe("Bottom-left (linear: centre line)."),
    width_in: sizeIn.optional(),
    height_in: sizeIn.optional(),
    rotation_deg: z.number().finite().min(-360).max(360).optional(),
    mirror: z.boolean().optional(),
    ...style,
  }),
  z.object({ shape: z.literal("repeat"), symbol: z.string().min(1).max(80), from: pt, to: pt, spacing_in: sizeIn.optional(), width_in: sizeIn.optional(), height_in: sizeIn.optional(), ...style }),
  z.object({ shape: z.literal("batt"), from: pt, to: pt, thickness_in: sizeIn, ...style }),
  z.object({ shape: z.literal("figure"), corner: pt, opposite: pt, chart: z.string().max(80).optional(), file_id: z.string().max(400).optional(), file_name: z.string().max(200).optional() }),
]);
type DrawInput = z.infer<typeof drawItem>;

const DRAW_SHAPES = ["line", "rect", "polygon", "chain", "arc", "arc_radius", "arc_tangent", "circle", "polyline", "spline", "region", "component", "repeat", "batt", "figure"] as const;
/** bim_draw_detail's items, read in full with bim_describe_commands; advertised by shape name only. */
const drawFamily = commandFamily({ tool: "bim_draw_detail", field: "items", label: "One drawn item: a shape and its points, sizes and line style.", schema: drawItem, discriminator: "shape" });
/** Everything drawn as linework (a figure has no line style). */
type StyledInput = Exclude<DrawInput, { shape: "figure" }>;

interface Owner {
  readonly id: string;
  /** Agent point → stored. */
  readonly p: (v: Vec2) => Vec2;
  /** Agent length (feet in a view, inches on a sheet) → stored. */
  readonly length: (v: number) => number;
  /** Agent size in inches → stored. */
  readonly size: (v: number) => number;
  readonly back: (v: Vec2) => Vec2;
  readonly sheet: boolean;
}

function resolveOwner(model: ModelState, ref: string): Owner | string {
  const sheetId = findSheet(model, ref);
  if (sheetId) return { id: sheetId, p: (v) => ({ x: v.x * IN, y: v.y * IN }), length: (v) => v * IN, size: (v) => v * IN, back: (v) => ({ x: v.x / IN, y: v.y / IN }), sheet: true };
  const viewId = findView(model, ref);
  const view = viewId ? model.elements[viewId] : undefined;
  if (!viewId || view?.kind !== "view") return `No view or sheet "${ref}". List views and sheets first.`;
  if (view.viewType === "three_d" || view.viewType === "schedule") return `${view.name} takes no drafting; use a detail view, plan, section or sheet.`;
  return { id: view.id, p: (v) => ({ x: v.x * FT, y: v.y * FT }), length: (v) => v * FT, size: (v) => v * IN, back: (v) => ({ x: v.x / FT, y: v.y / FT }), sheet: false };
}

/** The stored line style: a named style, with weight / pattern overriding it. */
function styleOf(input: Pick<StyledInput, "line_style" | "weight" | "pattern">): { lineStyle?: LineStyle } {
  const named: LineStyle = input.line_style ? lineStyleFor(input.line_style) : {};
  const lineStyle: LineStyle = { ...named, ...(input.weight ? { weight: input.weight } : {}), ...(input.pattern ? { pattern: input.pattern } : {}) };
  return Object.keys(lineStyle).length > 0 ? { lineStyle } : {};
}

/** The add commands for one drawn item: most are one; a rectangle, polygon or chain is one joined line per side. */
function commandsFor(owner: Owner, item: DrawInput, itemId: string): ViewCommand[] | string {
  if (item.shape === "figure") {
    const made = figureCommand(owner, item, itemId, owner.sheet);
    return typeof made === "string" ? made : [made];
  }
  const input: StyledInput = item;
  const common = {
    type: "add_drawing_item" as const,
    ownerId: owner.id,
    ...styleOf(input),
    ...(input.category ? { category: input.category } : {}),
    ...(input.group ? { detailGroup: input.group } : {}),
  };
  const lines = (segs: Array<[Vec2, Vec2]>): ViewCommand[] => segs.map(([a, b], k) => ({ ...common, itemId: `${itemId}-${k}`, shape: "line", points: [a, b] }));
  switch (input.shape) {
    case "rect":
      return lines(rectangleLines(owner.p(input.corner), owner.p(input.opposite)));
    case "polygon": {
      const c = owner.p(input.center);
      const r = owner.length(input.radius);
      const a = ((input.rotation_deg ?? 0) * Math.PI) / 180;
      const segs = polygonLines(c, { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }, input.sides, input.inscribed !== false);
      return segs.length > 0 ? lines(segs) : "That polygon has no size.";
    }
    case "chain":
    case "polyline": {
      const segs = chainLines(input.points.map(owner.p), input.closed === true);
      return segs.length > 0 ? lines(segs) : "Those points are all on one spot.";
    }
    case "arc_radius": {
      const arc = arcStartEndRadius(owner.p(input.start), owner.p(input.end), owner.length(input.radius), owner.p(input.toward));
      return arc ? [{ ...common, itemId, shape: "arc", points: arc.points, ccw: arc.ccw }] : "The radius is less than half the distance between the ends; make it larger.";
    }
    case "arc_tangent": {
      const s = owner.p(input.start);
      const f = owner.p(input.from);
      const arc = tangentEndArc(s, { x: s.x - f.x, y: s.y - f.y }, owner.p(input.end));
      return arc ? [{ ...common, itemId, shape: "arc", points: arc.points, ccw: arc.ccw }] : "The end is straight ahead of the line; there's no arc to draw (draw a line).";
    }
    default:
      return [commandFor(owner, input, itemId)];
  }
}

type SingleDrawInput = Exclude<StyledInput, { shape: "rect" | "polygon" | "chain" | "polyline" | "arc_radius" | "arc_tangent" }>;

/** A sheet figure: a chart kind (plumbing.hunter_curve) or a workspace picture (PNG / JPEG by its name). */
function figureCommand(owner: Owner, input: Extract<DrawInput, { shape: "figure" }>, itemId: string, onSheet: boolean): ViewCommand | string {
  if (!onSheet) return "Charts and pictures go on a sheet.";
  if (!input.chart === !input.file_id) return "Give chart (a chart kind, e.g. plumbing.hunter_curve) or file_id (a workspace PNG or JPEG), not both.";
  const points = [owner.p(input.corner), owner.p(input.opposite)];
  if (input.chart) {
    if (!chartKind(input.chart)) return `No chart "${input.chart}"; charts: ${chartKinds().map((k) => k.id).join(", ")}.`;
    return { type: "add_drawing_item", itemId, ownerId: owner.id, shape: "figure", points, figure: { kind: "chart", chart: input.chart, } };
  }
  const name = (input.file_name ?? input.file_id ?? "").trim();
  const mime = /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : null;
  if (!mime || !input.file_id) return "Give file_name ending .png, .jpg or .jpeg: sheets print PNG and JPEG pictures.";
  return { type: "add_drawing_item", itemId, ownerId: owner.id, shape: "figure", points, figure: { kind: "image", image: { fileId: input.file_id, name: name.slice(0, 200), mime } } };
}

function commandFor(owner: Owner, input: SingleDrawInput, itemId: string): ViewCommand {
  const common = {
    type: "add_drawing_item" as const,
    itemId,
    ownerId: owner.id,
    ...styleOf(input),
    ...(input.category ? { category: input.category } : {}),
    ...(input.group ? { detailGroup: input.group } : {}),
  };
  switch (input.shape) {
    case "line":
      return { ...common, shape: "line", points: [owner.p(input.from), owner.p(input.to)] };
    case "arc":
      return { ...common, shape: "arc", points: [owner.p(input.center), owner.p(input.start), owner.p(input.end)], ccw: !input.clockwise };
    case "circle": {
      const c = owner.p(input.center);
      return { ...common, shape: "circle", points: [c, { x: c.x + owner.length(input.radius), y: c.y }] };
    }
    case "spline":
      return { ...common, shape: input.shape, points: input.points.map(owner.p), ...(input.closed !== undefined ? { closed: input.closed } : {}) };
    case "region":
      return {
        ...common,
        shape: "region",
        points: input.points.map(owner.p),
        fill: { pattern: input.masking ? "solid" : (input.hatch ?? "diagonal"), ...(input.masking ? { masking: true } : {}), ...(input.boundary !== undefined ? { boundary: input.boundary } : {}), ...(input.spacing_in ? { spacingMm: input.spacing_in * IN } : {}) },
      };
    case "component":
      return {
        ...common,
        shape: "component",
        points: [owner.p(input.at)],
        component: {
          symbolId: input.symbol,
          ...(input.width_in ? { widthMm: owner.size(input.width_in) } : {}),
          ...(input.height_in ? { heightMm: owner.size(input.height_in) } : {}),
          ...(input.rotation_deg !== undefined ? { rotationDeg: input.rotation_deg } : {}),
          ...(input.mirror ? { mirror: true } : {}),
        },
      };
    case "repeat":
      return {
        ...common,
        shape: "repeat",
        points: [owner.p(input.from), owner.p(input.to)],
        component: { symbolId: input.symbol, ...(input.spacing_in ? { spacingMm: owner.size(input.spacing_in) } : {}), ...(input.width_in ? { widthMm: owner.size(input.width_in) } : {}), ...(input.height_in ? { heightMm: owner.size(input.height_in) } : {}) },
      };
    case "batt":
      return { ...common, shape: "batt", points: [owner.p(input.from), owner.p(input.to)], batt: { thicknessMm: owner.size(input.thickness_in) } };
  }
}

const len = z.number().positive();
const modifyInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("move"), dx: z.number().finite(), dy: z.number().finite(), disjoin: z.boolean().optional().describe("Joined lines that weren't picked stay put instead of stretching to follow.") }),
  z.object({ op: z.literal("copy"), dx: z.number().finite(), dy: z.number().finite() }),
  z.object({ op: z.literal("rotate"), center: pt, angle_deg: z.number().finite().min(-360).max(360), copy: z.boolean().optional() }),
  z.object({ op: z.literal("scale"), center: pt, factor: z.number().positive().max(100) }),
  z.object({ op: z.literal("mirror"), axis_from: pt, axis_to: pt, copy: z.boolean().optional() }),
  z.object({ op: z.literal("array"), count: z.number().int().min(2).max(100), dx: z.number().finite(), dy: z.number().finite(), group: z.boolean().optional().describe("Each copy becomes its own detail group.") }),
  z.object({ op: z.literal("polar_array"), count: z.number().int().min(2).max(100), center: pt, angle_deg: z.number().finite().min(-360).max(360).default(360), group: z.boolean().optional() }),
  z.object({ op: z.literal("align"), from: pt, line_from: pt, line_to: pt }),
  z.object({ op: z.literal("offset"), distance: z.number().positive(), toward: pt.describe("A point on the side to offset to."), copy: z.boolean().optional().describe("Default true: new lines. false: move the originals.") }),
  z.object({ op: z.literal("trim_extend_corner"), keep1: pt.describe("A point on the part of the first item to keep."), keep2: pt.describe("Same for the second item.") }),
  z.object({ op: z.literal("trim_extend_single"), boundary_id: z.string().min(1).max(200), keep: pt.describe("A point on the part to keep.") }),
  z.object({ op: z.literal("trim_extend_multiple"), boundary_id: z.string().min(1).max(200), keeps: z.array(pt).min(1).max(500).describe("One point per item_ids entry, on the part to keep.") }),
  z.object({ op: z.literal("split"), at: pt, delete_to: pt.optional().describe("Cut here too and delete the piece between (Delete Inner Segment).") }),
  z.object({ op: z.literal("split_gap"), at: pt, gap: len }),
  z.object({ op: z.literal("fillet_arc"), radius: len, near1: pt.optional().describe("A point on the part of the first line to keep (default its far end)."), near2: pt.optional() }),
  z.object({ op: z.literal("chamfer"), distance: len, distance2: len.optional(), near1: pt.optional(), near2: pt.optional() }),
  z.object({ op: z.literal("move_end"), end: z.enum(["start", "end"]), to: pt, disjoin: z.boolean().optional() }),
  z.object({ op: z.literal("pin") }),
  z.object({ op: z.literal("unpin") }),
  z.object({ op: z.literal("delete") }),
  z.object({ op: z.literal("match_type"), source_id: z.string().min(1).max(200).describe("The item whose line style and category the others take.") }),
  z.object({ op: z.literal("trim"), boundary_id: z.string().min(1).max(200), keep: pt.describe("A point on the part to keep.") }).describe("Older name: prefer trim_extend_single."),
  z.object({ op: z.literal("extend"), boundary_id: z.string().min(1).max(200), near: pt.describe("A point near the end to lengthen.") }).describe("Older name: prefer trim_extend_single."),
  z.object({ op: z.literal("fillet"), radius: z.number().min(0).describe("0 for a sharp corner.") }).describe("Older name: prefer fillet_arc or trim_extend_corner."),
]);

const MODIFY_OPS = ["move", "copy", "rotate", "scale", "mirror", "array", "polar_array", "align", "offset", "trim_extend_corner", "trim_extend_single", "trim_extend_multiple", "split", "split_gap", "fillet_arc", "chamfer", "move_end", "pin", "unpin", "delete", "match_type", "trim", "extend", "fillet"] as const;
/** bim_modify_detail's operation, read in full with bim_describe_commands; advertised by op name only. */
const modifyFamily = commandFamily({ tool: "bim_modify_detail", field: "operation", label: "One modify operation and its points and distances.", schema: modifyInput, discriminator: "op" });

function toModifyOp(owner: Owner, m: z.infer<typeof modifyInput>): ModifyOp {
  const d = (dx: number, dy: number) => owner.p({ x: dx, y: dy });
  switch (m.op) {
    case "move":
      return { op: "move", delta: d(m.dx, m.dy), ...(m.disjoin ? { disjoin: true } : {}) };
    case "copy":
      return { op: "copy", delta: d(m.dx, m.dy) };
    case "rotate":
      return { op: "rotate", center: owner.p(m.center), angleDeg: m.angle_deg, ...(m.copy ? { copy: true } : {}) };
    case "scale":
      return { op: "scale", center: owner.p(m.center), factor: m.factor };
    case "mirror":
      return { op: "mirror", a: owner.p(m.axis_from), b: owner.p(m.axis_to), ...(m.copy ? { copy: true } : {}) };
    case "array":
      return { op: "array", count: m.count, delta: d(m.dx, m.dy), ...(m.group ? { group: true } : {}) };
    case "polar_array":
      return { op: "polar_array", count: m.count, center: owner.p(m.center), angleDeg: m.angle_deg ?? 360, ...(m.group ? { group: true } : {}) };
    case "align":
      return { op: "align", from: owner.p(m.from), a: owner.p(m.line_from), b: owner.p(m.line_to) };
    case "offset":
      return { op: "offset", distance: owner.length(m.distance), side: owner.p(m.toward), ...(m.copy === false ? { copy: false } : {}) };
    case "trim_extend_corner":
      return { op: "trim_extend_corner", keep1: owner.p(m.keep1), keep2: owner.p(m.keep2) };
    case "trim_extend_single":
      return { op: "trim_extend_single", boundaryId: m.boundary_id, keep: owner.p(m.keep) };
    case "trim_extend_multiple":
      return { op: "trim_extend_multiple", boundaryId: m.boundary_id, keeps: m.keeps.map(owner.p) };
    case "split":
      return { op: "split", at: owner.p(m.at), ...(m.delete_to ? { to: owner.p(m.delete_to) } : {}) };
    case "split_gap":
      return { op: "split_gap", at: owner.p(m.at), gap: owner.length(m.gap) };
    case "fillet_arc":
      return { op: "fillet_arc", radius: owner.length(m.radius), ...(m.near1 ? { near1: owner.p(m.near1) } : {}), ...(m.near2 ? { near2: owner.p(m.near2) } : {}) };
    case "chamfer":
      return { op: "chamfer", d1: owner.length(m.distance), ...(m.distance2 ? { d2: owner.length(m.distance2) } : {}), ...(m.near1 ? { near1: owner.p(m.near1) } : {}), ...(m.near2 ? { near2: owner.p(m.near2) } : {}) };
    case "move_end":
      return { op: "move_end", end: m.end, to: owner.p(m.to), ...(m.disjoin ? { disjoin: true } : {}) };
    case "pin":
    case "unpin":
    case "delete":
      return { op: m.op };
    case "match_type":
      return { op: "match_type", sourceId: m.source_id };
    case "trim":
      return { op: "trim", boundaryId: m.boundary_id, keep: owner.p(m.keep) };
    case "extend":
      return { op: "extend", boundaryId: m.boundary_id, near: owner.p(m.near) };
    case "fillet":
      return { op: "fillet", radius: owner.length(m.radius) };
  }
}

/** Items named, plus everything sharing a detail group with them (groups move together). */
export function registerBimDetailingTools(server: McpServer, caller: ResolveBimCaller) {
  server.registerTool(
    "bim_list_detail_components",
    {
      title: "List detail components",
      description: "The 2D detail component library: id, name, category (duct, pipe, supports, valves, anchors, structure, insulation), default size in inches, and whether it stretches between two points (linear: flex duct, threaded rod). Use the id as `symbol` in bim_draw_detail.",
      inputSchema: { ...target },
    },
    async (args, extra) => {
      try {
        await caller(extra, args.project_id, false);
        return text({
          components: DETAIL_COMPONENTS.map((c) => ({ id: c.id, name: c.name, category: c.category, width_in: Math.round((c.widthMm / IN) * 100) / 100, height_in: Math.round((c.heightMm / IN) * 100) / 100, linear: c.linear === true })),
          hatch_patterns: HATCH_PATTERNS,
          line_patterns: LINE_PATTERNS,
          line_styles: DETAIL_LINE_STYLES.map((x) => ({ id: x.id, name: x.name })),
          line_weights: LINE_WEIGHTS_2D,
        });
      } catch (err) {
        return explain(err, "bim_list_detail_components");
      }
    },
  );

  server.registerTool(
    "bim_draw_detail",
    {
      title: "Draw detail linework, regions and components",
      description:
        `Draw up to 500 items in a detail view, plan, section or sheet as one edit, on BIM conventions: detail lines are separate elements joined at their ends, so rect (four joined lines), polygon (inscribed or circumscribed), chain (lines through points, optionally closed; polyline is the same) make one line per side, ids <item id>-0, -1, …. Also line, arc (centre, start, end), arc_radius (start, end, radius, bulge side), arc_tangent (continues a line), circle, spline, region (hatch pattern, or masking; a closed sketch boundary), component (a library symbol at a point, rotated, mirrored, sized), repeat (a symbol repeated from one point to another), batt (insulation of a thickness between two points); on a sheet, figure (frame corner/opposite) with chart (plumbing.hunter_curve, live) or file_id + file_name (workspace PNG/JPEG). Each takes an optional line_style (the usual way to pick linework); weight (default medium) and pattern (default solid) override it; category is the view show / hide group; group makes a detail group (select, move, copy together). Fillets: bim_modify_detail. View feet for points, radii and distances, inches for sizes; on a sheet, paper inches. Points are {x, y}. Fields: line from, to; rect corner, opposite; circle center, radius; chain / polyline points, closed; arc center, start, end, clockwise; component symbol, at, width_in, height_in, rotation_deg, mirror; region points, hatch, masking; style keys line_style, weight, pattern, category, group. Every other shape's exact fields: bim_describe_commands({ tool: "bim_draw_detail", field: "items", variant: "<shape>" }). Dimensions: bim_add_dimension; notes: bim_add_note.`,
      inputSchema: { ...target, ...baseRevision, owner: ownerRef, items: z.array(advertisedVariant(drawFamily, DRAW_SHAPES, "One item: shape plus its fields.")).min(1).max(500), label: z.string().trim().min(1).max(160).optional() },
    },
    async (args, extra) => {
      const items = parseFamilyArray(drawFamily, args.items, "items");
      if (!items.ok) return failure(items.message);
      const parsed = { ...args, items: items.data };
      return editWithModel(caller, "bim_draw_detail", extra, parsed, (model) => {
        const owner = resolveOwner(model, parsed.owner);
        if (typeof owner === "string") return owner;
        const prefix = stableId("dt", extra, { ...parsed, base_revision: undefined });
        const commands: ViewCommand[] = [];
        for (const [i, it] of items.data.entries()) {
          const made = commandsFor(owner, it, `${prefix}-${i}`);
          if (typeof made === "string") return `Item ${i + 1} (${it.shape}): ${made}`;
          commands.push(...made);
        }
        if (commands.length > 500) return `That draws ${commands.length} elements (a rectangle, polygon or chain is one per side); the limit is 500 per edit. Split it in two.`;
        return commands.length === 1 && commands[0] ? commands[0] : { type: "batch_documents", label: args.label ?? `Draw ${items.data.length} item${items.data.length === 1 ? "" : "s"}`, commands };
      });
    },
  );

  server.registerTool(
    "bim_modify_detail",
    {
      title: "Modify drawn items",
      description:
        "Change drafting items by id (from bim_list_view_annotations) with one operation, as one edit, on BIM drafting-view conventions. Detail lines joined end to end stay joined: moving, rotating, trimming or dragging an end stretches the joined line that wasn't picked (move disjoin: true leaves it). Operations: move / copy by dx, dy; rotate (about a centre, optionally a copy); scale; mirror about an axis (optionally a copy); array / polar_array (group: each copy its own detail group); align; offset lines, arcs and circles by a distance toward a side (pick a whole joined chain, e.g. a rectangle's four sides, and the corners still meet; copy: false moves them); trim_extend_corner (two items, a point on the part of each to keep); trim_extend_single (one item to a boundary, keep point); trim_extend_multiple (many items to one boundary, one keep point each); split (at a point; delete_to removes the piece between two points); split_gap; fillet_arc (two lines, radius; near1/near2 pick the parts to keep); chamfer; move_end (drag one end); pin / unpin (pinned items refuse to move, change shape or delete); delete; match_type (take source_id's line style and category). A rectangle drawn before joined lines existed becomes four joined lines on its first edit (ids <rect id>~s0..s3, in the same undo); naming it with two keep / near points picks the two sides at that corner. Items in a detail group bring the rest of their group (except the trims, splits, fillet, offset, move_end, match_type and delete, which act on exactly the items named). Dimensions that follow edited items update by themselves. Same units as bim_draw_detail (distance, radius and gap in view feet). Points are {x, y}. Fields: move / copy dx, dy (move disjoin); rotate center, angle_deg, copy; mirror axis_from, axis_to, copy; offset distance, toward, copy; trim_extend_corner keep1, keep2; trim_extend_single boundary_id, keep; split at, delete_to; fillet_arc radius, near1, near2; move_end end, to. Every other operation's exact fields: bim_describe_commands({ tool: \"bim_modify_detail\", field: \"operation\", variant: \"<op>\" }).",
      inputSchema: { ...target, ...baseRevision, owner: ownerRef, item_ids: z.array(z.string().min(1).max(200)).min(1).max(500), operation: advertisedVariant(modifyFamily, MODIFY_OPS, "One operation: op plus its fields.") },
    },
    async (args, extra) => {
      const operation = parseFamilyValue(modifyFamily, args.operation, "operation");
      if (!operation.ok) return failure(operation.message);
      const parsed = { ...args, operation: operation.data };
      return editWithModel(caller, "bim_modify_detail", extra, parsed, (model) => {
        const owner = resolveOwner(model, parsed.owner);
        if (typeof owner === "string") return owner;
        const made = modifyCommand(documentIndex(model).itemsByOwner.get(owner.id) ?? [], parsed.item_ids, toModifyOp(owner, parsed.operation), owner.id, stableId("mod", extra, { ...parsed, base_revision: undefined }));
        return made.ok ? made.command : made.reason;
      });
    },
  );

  server.registerTool(
    "bim_copy_detail_items",
    {
      title: "Copy drafting into another view",
      description: "Copy drawing items (by id, or every item when item_ids is absent) from one view or sheet into another (detail view, plan, section or sheet), shifted by dx / dy in the target's units. Dimensions among them that follow other copied items follow the copies; detail groups stay together. Use it to start a new detail from an existing one.",
      inputSchema: { ...target, ...baseRevision, from: ownerRef, to: ownerRef, item_ids: z.array(z.string().min(1).max(200)).max(500).optional(), dx: z.number().finite().default(0), dy: z.number().finite().default(0) },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_copy_detail_items", extra, args, (model) => {
        const from = resolveOwner(model, args.from);
        if (typeof from === "string") return from;
        const to = resolveOwner(model, args.to);
        if (typeof to === "string") return to;
        const all = (documentIndex(model).itemsByOwner.get(from.id) ?? []).filter((i) => !i.deleted && !(i.tag && from.id !== to.id));
        const ids = args.item_ids && args.item_ids.length > 0 ? args.item_ids : all.map((i) => i.id);
        if (ids.length === 0) return `Nothing to copy in ${args.from}.`;
        return { type: "copy_drawing_items", itemIds: ids, toOwnerId: to.id, offset: to.p({ x: args.dx ?? 0, y: args.dy ?? 0 }), idPrefix: stableId("cp", extra, { ...args, base_revision: undefined }) };
      }),
  );

  server.registerTool(
    "bim_set_detail_group",
    {
      title: "Group or ungroup drafting items",
      description: "Put drawing items in a detail group (they then select, move, copy and modify together), or take them out (group: null).",
      inputSchema: { ...target, ...baseRevision, owner: ownerRef, item_ids: z.array(z.string().min(1).max(200)).min(1).max(500), group: z.string().trim().min(1).max(120).nullable() },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_set_detail_group", extra, args, (model) => {
        const owner = resolveOwner(model, args.owner);
        if (typeof owner === "string") return owner;
        const items = (documentIndex(model).itemsByOwner.get(owner.id) ?? []).filter((i) => args.item_ids.includes(i.id) && !i.deleted);
        if (items.length !== args.item_ids.length) return "Some of those items aren't there. Read the view's annotations first.";
        const steps: ViewCommand[] = items.map((i) => ({ type: "update_drawing_item", itemId: i.id, detailGroup: args.group }));
        return steps.length === 1 && steps[0] ? steps[0] : { type: "batch_documents", label: args.group ? `Group ${steps.length} items as ${args.group}` : `Ungroup ${steps.length} items`, commands: steps };
      }),
  );
}
