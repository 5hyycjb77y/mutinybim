import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { schemaOnce, schemaOnce2 } from "../support/edit-schemas";
import { createHash } from "node:crypto";
import { ALLOCATION_POLICIES, CATALOG_TRADES, ELECTRICAL_LOAD_CLASSES, LOAD_SERVICES, QUANTITY_KEYS, canonicalJson, connectionTypeQuantityWarnings, loadAnchorSchema, loadPointId, loadPointPlacementRows, loadPointSystemFit, quantityBagInputSchema, readQuantityBag, type Command, type ModelState, type QuantityBag, type QuantityBagInput } from "@permitzip/bim-kernel";
import { tradeBaseRevision as baseRevision, failure, runEdit, tradeTarget as target, type Extra, type ResolveBimCaller } from "../runtime";
import { BIM_PLUMBING_EDIT_TOOL_NAMES, type BimPlumbingEditToolName } from "../support/tool-names";

/**
 * Plumbing load points and connection types for agents (plumbing wave 1).
 * Each tool sends the kernel command the Building Model's "Place load point"
 * action and Properties panel send, and pauses for approval. Reads go through
 * bim_query_elements (kind load_point), bim_pipe_report and bim_electrical_catalog
 * (it lists connection types of every trade). Membership is drawn or chosen:
 * a point goes on the pipe end the person names, and a fixture is attached
 * only to the point the person names (a product design rule).
 */

const pipeEnd = {
  pipe_id: z.string().trim().min(1).max(200).describe("Pipe or duct segment, or a tap/tee/wye fitting."),
  end: z.string().trim().min(1).max(40).describe('"start" or "end" of a segment, or a fitting port ("branch"). Must be open.'),
};

/** A number is in the quantity's unit; text carries its own. */
const quantities = quantityBagInputSchema.describe('Numbers in each quantity\'s unit (mbh MBH, min_inlet_pressure psi, cfm CFM, WSFU, DFU), or text with a unit: "7 in. w.c.", "199,000 Btu/h".');

const pointArgs = z.object({
  ...pipeEnd,
  connection_type: z.string().trim().max(20).optional().describe('Designator in the catalog ("P01"), or a starter one (WC-FT, LAV, FD…), added with it.'),
  values: quantities.optional().describe("Values that differ from the connection type's (units as in quantities)."),
  mark: z.string().trim().max(40).optional().describe('The fixture this point is ("K01-2"); a fixture\'s cold and hot points share it.'),
  schematic: z.boolean().optional().describe("A lump to break out later."),
  note: z.string().trim().max(200).optional(),
});

export const PLUMBING_EDIT_ARGS = {
  bim_place_load_points: {
    points: z.array(pointArgs).min(1).max(500),
  },
  bim_edit_load_point: {
    action: z.enum(["edit", "attach", "detach", "split", "delete", "create", "move", "policy"]),
    load_point_id: z.string().trim().min(1).max(200).optional().describe("Any load id (lp:<pipe>:<end> or a newer one) from bim_query_elements kind load_point."),
    part_id: z.string().trim().min(1).max(200).optional().describe("attach: the fixture the person named. edit: a fixture's id edits every point attached to it."),
    connection_type: z.string().trim().max(20).optional(),
    values: quantities.optional().describe("edit: merged onto the point's own values."),
    reset: z.array(z.enum(QUANTITY_KEYS)).max(QUANTITY_KEYS.length).optional().describe("edit: own values to drop."),
    mark: z.string().trim().max(40).optional(),
    into: z
      .array(z.object({ ...pipeEnd, values: quantities, mark: z.string().trim().max(40).optional(), connection_type: z.string().trim().max(20).optional() }))
      .min(1)
      .max(100)
      .optional()
      .describe("split: new points and what each takes from the lump; the rest stays on it."),
    load_point_ids: z.array(z.string().trim().min(1).max(200)).min(1).max(500).optional().describe("delete"),
    served_by: z.string().trim().min(1).max(200).optional().describe("edit/create: the source before anything is drawn (panel P1, WH-1, the gas meter), by id."),
    clear_served_by: z.literal(true).optional(),
    loads: z
      .array(
        z.object({
          anchor: z.record(z.string(), z.unknown()).optional().describe('{kind:"space",id} / "zone" (an area estimate), {kind:"part",partId}, {kind:"run_end",hostId,port}, {kind:"point",levelId,position (mm)}; absent: a row, placed nowhere yet.'),
          connection_type: z.string().trim().max(20).optional(),
          values: quantities.optional(),
          service: z.enum(LOAD_SERVICES).optional(),
          mark: z.string().trim().max(40).optional(),
          note: z.string().trim().max(200).optional(),
        }),
      )
      .min(1)
      .max(500)
      .optional()
      .describe("create: new loads (estimate 5 kW on the kitchen: anchor space, values { va: 5000 })."),
    to: z.record(z.string(), z.unknown()).optional().describe("move: the new anchor (as loads[].anchor); the id stays."),
    policy: z.enum(ALLOCATION_POLICIES).optional().describe("policy: how estimates count once devices exist (max: the larger)."),
  },
  bim_save_connection_type: {
    entry: z
      .object({
        designator: z.string().trim().min(1).max(20),
        trade: z.enum(CATALOG_TRADES),
        description: z.string().trim().max(120).optional(),
        quantities: quantities.optional(),
        loadVa: z.number().min(0).max(5_000_000).optional(),
        voltage: z.number().positive().max(1000).optional(),
        poles: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        loadClass: z.enum(ELECTRICAL_LOAD_CLASSES).optional(),
        continuous: z.boolean().optional(),
        connection: z.string().trim().max(60).optional(),
        comments: z.string().trim().max(200).optional(),
      })
      .optional()
      .describe("Plumbing/gas/air values in quantities; electrical fields only when it has a power connection."),
    replaces: z.string().trim().min(1).max(20).optional().describe("Rename: the designator it had (points and fixtures naming it follow)."),
    delete: z.string().trim().min(1).max(20).optional().describe("Delete this designator instead (refused while anything uses it)."),
  },
} as const satisfies Record<BimPlumbingEditToolName, z.ZodRawShape>;

const bad = (tool: string, issues: readonly z.core.$ZodIssue[]) => `Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;

type Point = z.infer<typeof pointArgs>;

/** What a plumbing tool sends: the kernel command, what was read from text with units, and warnings about the values. */
export interface PlumbingEdit {
  readonly command: Command;
  readonly read: readonly string[];
  readonly warnings: readonly string[];
}

/** Reads every quantity bag in the arguments into each quantity's unit; the first value that can't be read refuses the call. */
class Bags {
  readonly read: string[] = [];
  bad: string | null = null;
  take(input: QuantityBagInput, where: string): QuantityBag {
    const r = readQuantityBag(input);
    if (!r.ok) {
      this.bad ??= `${where}: ${r.reason}`;
      return {};
    }
    for (const line of r.read) this.read.push(`${where}: ${line}`);
    return r.bag;
  }
}

const placement = (p: Pick<Point, "pipe_id" | "end" | "connection_type" | "mark" | "schematic" | "note">, values: QuantityBag | undefined) => ({
  hostId: p.pipe_id,
  port: p.end,
  ...(p.connection_type !== undefined ? { connectionType: p.connection_type } : {}),
  ...(values ? { values } : {}),
  ...(p.mark ? { mark: p.mark } : {}),
  ...(p.schematic ? { schematic: true } : {}),
  ...(p.note ? { note: p.note } : {}),
});

/** The kernel command a plumbing tool sends, or why not (in words the agent can act on). */
export function plumbingCommand(tool: BimPlumbingEditToolName, raw: unknown): PlumbingEdit | string {
  const bags = new Bags();
  const built = buildCommand(tool, raw, bags);
  if (typeof built === "string") return built;
  if (bags.bad) return bags.bad;
  const warnings = built.type === "save_connection_type" && built.entry.quantities ? connectionTypeQuantityWarnings({ designator: built.entry.designator, ...(built.entry.trade ? { trade: built.entry.trade } : {}), quantities: built.entry.quantities }) : [];
  return { command: built, read: bags.read, warnings };
}

function buildCommand(tool: BimPlumbingEditToolName, raw: unknown, bags: Bags): Command | string {
  switch (tool) {
    case "bim_place_load_points": {
      const parsed = schemaOnce(PLUMBING_EDIT_ARGS.bim_place_load_points).safeParse(raw);
      if (!parsed.success) return bad(tool, parsed.error.issues);
      return { type: "create_load_point", points: parsed.data.points.map((p, i) => placement(p, p.values ? bags.take(p.values, `points[${i}] ${p.mark ?? p.pipe_id}`) : undefined)) };
    }
    case "bim_edit_load_point": {
      const parsed = schemaOnce(PLUMBING_EDIT_ARGS.bim_edit_load_point).safeParse(raw);
      if (!parsed.success) return bad(tool, parsed.error.issues);
      const a = parsed.data;
      const lp = a.load_point_id;
      switch (a.action) {
        case "edit":
          if (!lp && !a.part_id) return "edit needs load_point_id, or part_id of an attached fixture.";
          if (a.served_by !== undefined && a.clear_served_by) return "Give served_by or clear_served_by, not both.";
          return {
            type: "edit_load_point",
            ...(lp ? { loadId: lp } : { partId: a.part_id as string }),
            ...(a.connection_type !== undefined ? { connectionType: a.connection_type } : {}),
            ...(a.values ? { values: bags.take(a.values, "values") } : {}),
            ...(a.reset ? { reset: a.reset } : {}),
            ...(a.mark !== undefined ? { mark: a.mark } : {}),
            ...(a.served_by !== undefined ? { servedBy: a.served_by } : {}),
            ...(a.clear_served_by ? { clearServedBy: true } : {}),
          };
        case "create": {
          if (!a.loads) return "create needs loads.";
          const loads = [];
          for (const [i, l] of a.loads.entries()) {
            const anchor = l.anchor === undefined ? undefined : loadAnchorSchema.safeParse(l.anchor);
            if (anchor && !anchor.success) return `loads[${i}].anchor: ${anchor.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`;
            loads.push({
              id: `ld-${createHash("sha256").update(canonicalJson({ i, l, served_by: a.served_by ?? null })).digest("hex").slice(0, 16)}`,
              ...(anchor ? { anchor: anchor.data } : {}),
              ...(l.connection_type !== undefined ? { connectionType: l.connection_type } : {}),
              ...(l.values ? { values: bags.take(l.values, `loads[${i}] ${l.mark ?? ""}`.trim()) } : {}),
              ...(l.service ? { service: l.service } : {}),
              ...(l.mark ? { mark: l.mark } : {}),
              ...(l.note ? { note: l.note } : {}),
              ...(a.served_by !== undefined ? { servedBy: a.served_by } : {}),
            });
          }
          return { type: "create_load", loads };
        }
        case "move": {
          if (!lp || !a.to) return "move needs load_point_id and to (the new anchor).";
          const to = loadAnchorSchema.safeParse(a.to);
          if (!to.success) return `to: ${to.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`;
          return { type: "move_load", loadId: lp, to: to.data };
        }
        case "policy":
          if (!a.policy) return "policy needs policy (max, actual_only or allocation_only).";
          return { type: "set_load_allocation_policy", policy: a.policy };
        case "attach":
          if (!lp || !a.part_id) return "attach needs load_point_id and the part_id of the fixture the person named.";
          return { type: "attach_part_to_load_point", loadPointId: lp, partId: a.part_id };
        case "detach":
          if (!lp) return "detach needs load_point_id.";
          return { type: "detach_part_from_load_point", loadPointId: lp };
        case "split":
          if (!lp || !a.into) return "split needs load_point_id (the lump) and into (the new points).";
          return { type: "split_load_point", loadPointId: lp, into: a.into.map((p, i) => ({ ...placement(p, undefined), values: bags.take(p.values, `into[${i}] ${p.mark ?? p.pipe_id}`) })) };
        case "delete": {
          const ids = a.load_point_ids ?? (lp ? [lp] : []);
          if (ids.length === 0) return "delete needs load_point_ids (or load_point_id).";
          return { type: "delete_load_points", loadPointIds: ids };
        }
      }
      return "Unknown action.";
    }
    case "bim_save_connection_type": {
      const parsed = schemaOnce(PLUMBING_EDIT_ARGS.bim_save_connection_type).safeParse(raw);
      if (!parsed.success) return bad(tool, parsed.error.issues);
      const a = parsed.data;
      if (a.delete && a.entry) return "Give entry to save or delete to remove, not both.";
      if (a.delete) return { type: "delete_catalog_entry", entryType: "connection_type", name: a.delete };
      if (!a.entry) return "Give the connection type to save (entry), or delete.";
      const { quantities: q, ...entry } = a.entry;
      return { type: "save_connection_type", entry: { ...entry, ...(q ? { quantities: bags.take(q, `${a.entry.designator} quantities`) } : {}) }, ...(a.replaces ? { replaces: a.replaces } : {}) };
    }
  }
}

const DESCRIPTIONS: Record<BimPlumbingEditToolName, { title: string; description: string }> = {
  bim_place_load_points: {
    title: "Place load points on pipe ends",
    description:
      "Put loads on open pipe ends or taps without fixtures (one batch, up to 500). Each names a connection type (WSFU/DFU/MBH/CFM come from it) or gives values; one point per end, per system (a sink: cold, hot and waste points sharing a mark). A type with no connection of the pipe's system is refused; points returns each point's pipe, system and loads, with warnings. Then read totals with bim_pipe_report. Pauses for approval.",
  },
  bim_edit_load_point: {
    title: "Edit, attach, split or delete load points",
    description:
      "Any trade's loads. edit: type, values or source (served_by; part_id edits every point of an attached fixture). attach: the fixture the person named takes the point's connection type; totals unchanged. detach keeps the point. split: break a lump onto new points, totals preserved. delete. create: loads on a space/zone (an estimate), a part, a point or nowhere yet. move: same id to a new anchor (estimate → point → device). policy: how estimates count once devices exist. Pauses for approval.",
  },
  bim_save_connection_type: {
    title: "Save a connection type (any trade)",
    description:
      "Add or change a connection type: trade plumbing/gas/mechanical/electrical, quantities (wsfu_cold, wsfu_hot, wsfu_total = the code's combined value, dfu, gph_demand, mbh, min_inlet_pressure in psi, cfm, sizes, custom; text with a unit like '7 in. w.c.' is converted). replaces renames it; delete removes one nothing uses. Pauses for approval.",
  },
};

/** The load points an edit placed or changed. */
function pointsOf(command: Command): string[] {
  if (command.type === "create_load_point") return command.points.map((p) => loadPointId(p.hostId, p.port));
  if (command.type === "split_load_point") return [command.loadPointId, ...command.into.map((p) => loadPointId(p.hostId, p.port))];
  if (command.type === "edit_load_point") {
    const id = command.loadId ?? command.loadPointId;
    return id ? [id] : [];
  }
  return [];
}

/** Beside a saved edit: what was read from units, warnings, and for a batch each point's pipe, mark, type, system and loads. */
export function editNotes(edit: PlumbingEdit, saved: ModelState): Record<string, unknown> {
  const ids = pointsOf(edit.command);
  const rows = edit.command.type === "create_load_point" ? loadPointPlacementRows(saved.elements, ids) : [];
  const pointWarnings = edit.command.type === "create_load_point" ? [] : ids.flatMap((id) => {
    const lp = saved.elements[id];
    return lp?.kind === "load_point" ? loadPointSystemFit(saved.elements, lp).warnings : [];
  });
  const warnings = [...edit.warnings, ...pointWarnings];
  return { ...(edit.read.length > 0 ? { read: edit.read } : {}), ...(warnings.length > 0 ? { warnings } : {}), ...(rows.length > 0 ? { points: rows } : {}) };
}

export function registerBimPlumbingTools(server: McpServer, caller: ResolveBimCaller) {
  for (const tool of BIM_PLUMBING_EDIT_TOOL_NAMES) {
    server.registerTool(tool, { ...DESCRIPTIONS[tool], inputSchema: { ...target, ...baseRevision, ...PLUMBING_EDIT_ARGS[tool] } }, async (raw: Record<string, unknown>, extra: Extra) => {
      const where = schemaOnce2(target, baseRevision).safeParse(raw);
      if (!where.success) return failure(`Those arguments don't fit ${tool}: ${where.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      const built = plumbingCommand(tool, raw);
      if (typeof built === "string") return failure(built);
      return runEdit(caller, tool, extra, where.data, built.command, undefined, (saved) => editNotes(built, saved));
    });
  }
}
