import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveLevelRef } from "@permitzip/bim-mcp";
import { z } from "zod";
import { fittingFamilies, SYSTEM_KINDS, systemRules, inheritedDuctDesign, type Command, type DuctInsulation, type FittingSlot, type MepSystem, type ModelState, type RouteEndpoint, type RunSize, type SystemKind } from "@permitzip/bim-kernel";
import { sizingCriteriaFor, suggestDuctSize } from "@permitzip/bim-pack-mechanical";
import { editIdempotencyKey } from "../runtime";
import { BIM_FITTING_EDIT_TOOL_NAMES, BIM_ROUTE_EDIT_TOOL_NAMES, withElementIdArg, type BimFittingEditToolName, type BimRouteEditToolName } from "../support/tool-names";
import { FITTING_EDIT_ARGS, buildFittingCommand } from "./fittings";
import { insulationArg, insulationFrom, runSizeArgs, runSizeFrom } from "../parts/run-size";
import type { BuiltCommand, PartToolHelpers } from "../parts/parts";
import { withRouteDefaults } from "../models/route-defaults";
import type { RouteDefaultsStore } from "../models/capabilities";
import { commandFamily } from "../parts/describe-commands";

/**
 * Routing tools: route duct and pipe between parts and runs, connect and
 * disconnect run ends. They build the same kernel commands the browser's
 * Route tool sends and go through the same authority path as every other
 * edit (person's login, agent identity, base revision, one idempotency key
 * per call). bim_preview_route_edit runs one without sending it, and also
 * previews the generalized resize and slide.
 */

const MM_PER_FT = 304.8;
const ft = (v: number) => v * MM_PER_FT;

/** What the host gives the routing tools: the person's saved Route defaults, for bim_route_run's use_my_defaults. */
export interface BimRoutingToolOptions {
  readonly routeDefaults: RouteDefaultsStore;
}

const endpoint = z
  .object({
    part_id: z.string().min(1).max(200).optional().describe("A placed part; with connector."),
    connector: z.string().min(1).max(40).optional().describe("Connector id on that part (bim_query_elements lists them as connector_<id>)."),
    run_id: z.string().min(1).max(200).optional().describe("A run segment or fitting with an open end; with end."),
    end: z.string().min(1).max(40).optional().describe("Which end of run_id: start / end for a segment, the port id for a fitting."),
    branch_from: z.string().min(1).max(200).optional().describe("A level trunk segment: the first (or last) point is on it, and a tap / tee / wye is placed there."),
  })
  .describe("Where the route starts or ends. Leave out for a free end.");

type EndpointArgs = z.infer<typeof endpoint>;

function endpointFrom(e: EndpointArgs | undefined): RouteEndpoint | undefined | string {
  if (!e) return undefined;
  if (e.part_id) return e.connector ? { kind: "part", partId: e.part_id, connectorId: e.connector } : `Name the connector on ${e.part_id}.`;
  if (e.run_id) return e.end ? { kind: "run_end", elementId: e.run_id, port: e.end } : `Say which end of ${e.run_id} (start or end).`;
  if (e.branch_from) return { kind: "run_branch", segmentId: e.branch_from };
  return "An endpoint needs part_id + connector, run_id + end, or branch_from.";
}

/**
 * What bim_route_run advertises where it differs from its full schema: one
 * description for both ends, and the system kind as a word. The handler
 * parses with ROUTE_EDIT_ARGS either way; a misfit names the field.
 */
const ADVERTISED_ENDPOINT = z
  .object({ part_id: z.string().optional(), connector: z.string().optional(), run_id: z.string().optional(), end: z.string().optional(), branch_from: z.string().optional() })
  .describe("Leave out for a free end. part_id + connector (connector_<id> in bim_query_elements); run_id + end (start / end, or a fitting port); or branch_from, a level trunk the first (or last) point is on, where a tap / tee / wye goes.");
commandFamily({ tool: "bim_route_run", field: "system_kind", label: "What a new system carries.", schema: z.enum(SYSTEM_KINDS) });
commandFamily({ tool: "bim_route_run", field: "from", label: "Where the route starts (to: where it ends).", schema: endpoint });

const ADVERTISED_ROUTE_ARGS: Partial<Record<BimRouteEditToolName, z.ZodRawShape>> = {
  bim_route_run: {
    from: ADVERTISED_ENDPOINT.optional(),
    to: ADVERTISED_ENDPOINT.optional(),
    system_kind: z.string().min(1).max(60).optional().describe("For a new system: what it carries (supply_air, return_air, exhaust_air, domestic_cold_water, sanitary, …; every kind: bim_describe_commands field system_kind)."),
  },
};

export const ROUTE_EDIT_ARGS = {
  bim_route_run: z.object({
    level_id: z.string().min(1).max(200).describe("Level id, or its name when unique (bim_list_levels)."),
    kind: z.enum(["duct", "pipe"]).describe("What is routed. Conduit routing isn't available yet."),
    ...runSizeArgs,
    elevation_ft: z.number().min(-100).max(100).optional().describe("Centreline height above level_id's floor. Omit to take the height of the trunk, open end or connector it starts (else finishes) on; a height off a trunk's is refused with the trunk's."),
    points_ft: z
      .array(
        z.object({
          x_ft: z.number().min(-100_000).max(100_000),
          y_ft: z.number().min(-100_000).max(100_000),
          elevation_ft: z.number().min(-100).max(100).optional().describe("Rise or drop to this height from this point on (rise_style)."),
        }),
      )
      .max(200)
      .describe("Plan points in order, in feet. A part or run end supplies its own point; with branch_from, the first point is on the trunk."),
    rise_style: z.enum(["vertical", "45"]).optional().describe("vertical: two 90° elbows (default); 45: two 45° elbows."),
    elbow_family: z.string().min(1).max(80).optional().describe("Duct: this route's elbow instead of the system's, e.g. duct.elbow.mitred_vanes (bim_list_fitting_types)."),
    takeoff_family: z.string().min(1).max(80).optional().describe("Duct: a branch_from route's tap / tee / wye instead of the system's."),
    from: endpoint.optional(),
    to: endpoint.optional(),
    system_id: z.string().min(1).max(200).optional().describe("An existing system (bim_model_summary lists routedSystems). Leave out to continue the system of the run you start or end on, or to start a new one with system_kind."),
    system_kind: z.enum(SYSTEM_KINDS).optional().describe("For a new system: what it carries (supply_air, return_air, exhaust_air, domestic_cold_water, sanitary, …)."),
    system_name: z.string().min(1).max(80).optional(),
    cap_end: z.boolean().optional().describe("Cap a free end."),
    slope_in_per_ft: z.number().min(0).max(1).optional().describe("Drains: fall in inches per foot on level legs. Leave out for the system's minimum for the size."),
    drain_flow: z.enum(["with_points", "against_points"]).optional().describe("Drains: which way the water runs. Leave out: into the trunk for branch_from, else from the first point to the last."),
    insulation: insulationArg.optional().describe("Duct: wrap or liner on every piece routed (kind none for bare duct). Leave out for the system's default; a new system keeps this as its default."),
    airflow_cfm: z.number().positive().max(200_000).optional().describe("Duct with no size: sized from this airflow at the system's friction rate and velocity limit (as bim_suggest_duct_size); with height_in alone, the width at that depth."),
    duct_shape: z.enum(["rect", "round"]).optional().describe("With airflow_cfm: rectangular (default) or round."),
    use_my_defaults: z
      .boolean()
      .optional()
      .describe("Fill what you leave out (size, shape, insulation, elbows, takeoffs, rise style) from the person's saved Route defaults (this project's, else every project's); what you give wins."),
  }),
  bim_connect_runs: z.object({
    a_id: z.string().min(1).max(200).describe("A segment, fitting or part; with tee_at_elbow, the elbow."),
    a_end: z.string().min(1).max(40).describe("start / end of a segment, a fitting port id, or a part's connector id. With tee_at_elbow: the elbow port whose leg runs straight on through the corner."),
    b_id: z.string().min(1).max(200).optional().describe("The other end's segment or fitting; with tap_into_side, the level straight run to tap into. Not used with tee_at_elbow."),
    b_end: z.string().min(1).max(40).optional().describe("The other end. Leave out with tap_into_side."),
    mode: z
      .enum(["face_to_face", "auto_route", "tap_into_side", "tee_at_elbow"])
      .optional()
      .describe(
        "face_to_face (default with b_end): the ends already meet. auto_route: two open ends that don't meet are joined by a route out of each end with square turns and one rise or drop, or refused with the reason. tap_into_side (default without b_end): a's open end continues straight into b's side with a tap at b's height. tee_at_elbow: the elbow becomes a tee; a_end's leg runs on through the corner and ends open there (route on from it with bim_route_run from run_id + end).",
      ),
  }),
  bim_disconnect_run: z.object({ element_id: z.string().min(1).max(200), end: z.string().min(1).max(40).describe("start / end, a fitting port, or a part connector id.") }),
  bim_route_flex: z.object({
    from_run_id: z.string().describe("Duct with the open end (a tap's branch)."),
    from_end: z.string().describe("start / end, or a fitting port."),
    to_part_id: z.string(),
    to_connector: z.string().optional().describe("Default neck."),
  }),
} as const satisfies Record<BimRouteEditToolName, z.ZodTypeAny>;

/** The generalized resize and slide, previewable here too (their edit tools live with the duct tools). */
const PREVIEW_ONLY_ARGS = {
  bim_resize_run: z.object({ segment_id: z.string().min(1).max(200), ...runSizeArgs }),
  bim_slide_branch: z.object({ tap_id: z.string().min(1).max(200), distance_ft: z.number().min(0).max(5000) }),
} as const;

const PREVIEWABLE = [...BIM_ROUTE_EDIT_TOOL_NAMES, "bim_resize_run", "bim_slide_branch", ...BIM_FITTING_EDIT_TOOL_NAMES] as const;
type Previewable = (typeof PREVIEWABLE)[number];

function newId(prefix: string, key: string): string {
  return `${prefix}-${key.replace(/^agent-/, "").slice(0, 16)}`;
}

/** The system a route continues: the run it starts or ends on. */
function systemOfEndpoint(model: ModelState, e: RouteEndpoint | undefined): string | null {
  if (!e || e.kind === "part") return null;
  const el = model.elements[e.kind === "run_end" ? e.elementId : e.segmentId];
  return el?.kind === "run_segment" || el?.kind === "run_fitting" ? el.systemId : null;
}

/**
 * The elbow and takeoff a route asks for over its system's defaults, in the
 * slots the Route panel fills (routeFittings in RoutePanel.tsx), or why a
 * family can't go there.
 */
export function routeFittingChoices(size: RunSize, elbow: string | undefined, takeoff: string | undefined): Partial<Record<FittingSlot, { family: string }>> | string {
  if (!elbow && !takeoff) return {};
  if (size.shape === "pipe") return "Pipe fittings follow the system's rules. Change them with bim_set_system_design, or swap one after routing with bim_swap_fitting.";
  const out: Partial<Record<FittingSlot, { family: string }>> = {};
  if (elbow) {
    const fits = fittingFamilies().filter((f) => f.domain === "duct" && f.fittingTypes.includes("elbow") && f.shapes.includes(size.shape));
    if (!fits.some((f) => f.id === elbow)) return `${elbow} isn't a ${size.shape} duct elbow. Use one of: ${fits.map((f) => f.id).join(", ")}.`;
    out[size.shape === "round" ? "elbow_round" : size.shape === "oval" ? "elbow_oval" : "elbow_rect"] = { family: elbow };
  }
  if (takeoff) {
    const fits = fittingFamilies().filter((f) => f.domain === "duct" && (f.fittingTypes.includes("tap") || f.fittingTypes.includes("tee") || f.fittingTypes.includes("wye")) && f.shapes.includes(size.shape));
    if (!fits.some((f) => f.id === takeoff)) return `${takeoff} isn't a takeoff for a ${size.shape} branch. Use one of: ${fits.map((f) => f.id).join(", ")}.`;
    out[size.shape === "round" ? "branch_round" : "branch_rect"] = { family: takeoff };
  }
  return out;
}

/** The size bim_suggest_duct_size would give, for a route that names an airflow instead of a size. */
function sizeFromAirflow(model: ModelState, system: MepSystem | null, kind: SystemKind, a: z.infer<(typeof ROUTE_EDIT_ARGS)["bim_route_run"]>, asked: DuctInsulation | null | undefined): RunSize | string {
  const design = system?.design ?? inheritedDuctDesign(model, { systemKind: kind });
  const insulation = asked === undefined ? design.insulation : (asked ?? undefined);
  const shape = a.duct_shape ?? (a.diameter_in !== undefined ? "round" : "rect");
  const s = suggestDuctSize({ cfm: a.airflow_cfm ?? 0, shape, criteria: sizingCriteriaFor(kind, design), ...(insulation ? { insulation } : {}), design, ...(shape === "rect" && a.height_in !== undefined ? { holdHeightMm: Math.round(a.height_in * 25.4 * 1000) / 1000 } : {}) });
  if (!s.ok) return `${s.reason}.`;
  return (s.atHeight ?? s.best).size;
}

function isFittingTool(tool: Previewable): tool is BimFittingEditToolName {
  return (BIM_FITTING_EDIT_TOOL_NAMES as readonly string[]).includes(tool);
}

export function buildRouteCommand(tool: Previewable, raw: unknown, model: ModelState, key: string): BuiltCommand {
  if (isFittingTool(tool)) return buildFittingCommand(tool, raw, model, key);
  switch (tool) {
    case "bim_route_run": {
      const a = ROUTE_EDIT_ARGS.bim_route_run.parse(raw);
      const from = endpointFrom(a.from);
      const to = endpointFrom(a.to);
      if (typeof from === "string") return { ok: false, message: from };
      if (typeof to === "string") return { ok: false, message: to };
      const continued = systemOfEndpoint(model, from) ?? systemOfEndpoint(model, to);
      const systemId = a.system_id ?? continued ?? (a.system_kind ? newId("sys", key) : null);
      if (!systemId) return { ok: false, message: "Say which system this is: system_id of an existing one, or system_kind (and system_name) for a new one." };
      const existing = model.elements[systemId];
      const kind = existing?.kind === "mep_system" ? existing.systemKind : a.system_kind;
      if (!kind) return { ok: false, message: `No system ${systemId} in this model. Give system_kind to start a new one.` };
      const insulation = a.insulation ? insulationFrom(a.insulation) : undefined;
      if (typeof insulation === "string") return { ok: false, message: insulation };
      const given = runSizeFrom(a);
      const size = typeof given === "string" && a.kind === "duct" && a.airflow_cfm !== undefined ? sizeFromAirflow(model, existing?.kind === "mep_system" ? existing : null, kind, a, insulation) : given;
      if (typeof size === "string") return { ok: false, message: size };
      const fittings = routeFittingChoices(size, a.elbow_family, a.takeoff_family);
      if (typeof fittings === "string") return { ok: false, message: fittings };
      const level = resolveLevelRef(model, a.level_id);
      if (!level.ok) return { ok: false, message: level.message };
      const command: Command = {
        type: "route_run",
        idPrefix: newId("run", key),
        levelId: level.id,
        domain: a.kind,
        size,
        ...(a.elevation_ft !== undefined ? { elevationMm: ft(a.elevation_ft) } : {}),
        system: { id: systemId, kind, ...(a.system_name ? { name: a.system_name } : existing?.kind === "mep_system" ? {} : { name: `${systemRules(kind).label} ${systemId.slice(-4)}` }) },
        points: a.points_ft.map((p) => ({ x: ft(p.x_ft), y: ft(p.y_ft), ...(p.elevation_ft !== undefined ? { elevationMm: ft(p.elevation_ft) } : {}) })),
        ...(a.rise_style ? { riseStyle: a.rise_style } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(Object.keys(fittings).length > 0 ? { fittings } : {}),
        ...(a.cap_end ? { capEnd: true } : {}),
        ...(a.slope_in_per_ft !== undefined ? { slopeInPerFt: a.slope_in_per_ft } : {}),
        ...(a.drain_flow ? { flow: a.drain_flow } : {}),
        ...(insulation !== undefined ? { insulation } : {}),
      };
      return { ok: true, command };
    }
    case "bim_connect_runs": {
      const a = ROUTE_EDIT_ARGS.bim_connect_runs.parse(raw);
      const mode = a.mode ?? (a.b_end ? "face_to_face" : "tap_into_side");
      if (mode === "tee_at_elbow") return { ok: true, command: { type: "elbow_to_tee", fittingId: a.a_id, through: a.a_end, idPrefix: newId("tee", key) } };
      if (!a.b_id) return { ok: false, message: `Name the other run (b_id) for ${mode}.` };
      if (mode === "tap_into_side") return { ok: true, command: { type: "stretch_to_side", from: { elementId: a.a_id, port: a.a_end }, onto: a.b_id, idPrefix: newId("tap", key) } };
      if (!a.b_end) return { ok: false, message: `Say which end of ${a.b_id} (b_end) to connect to.` };
      const ends = { a: { elementId: a.a_id, port: a.a_end }, b: { elementId: a.b_id, port: a.b_end } };
      return { ok: true, command: mode === "auto_route" ? { type: "auto_connect_runs", ...ends, idPrefix: newId("join", key) } : { type: "connect_runs", ...ends } };
    }
    case "bim_disconnect_run": {
      const a = ROUTE_EDIT_ARGS.bim_disconnect_run.parse(raw);
      return { ok: true, command: { type: "disconnect_run", elementId: a.element_id, port: a.end } };
    }
    case "bim_route_flex": {
      const a = ROUTE_EDIT_ARGS.bim_route_flex.parse(raw);
      return { ok: true, command: { type: "route_flex", segmentId: newId("flex", key), from: { elementId: a.from_run_id, port: a.from_end }, to: { partId: a.to_part_id, connectorId: a.to_connector ?? "neck" } } };
    }
    case "bim_resize_run": {
      const a = PREVIEW_ONLY_ARGS.bim_resize_run.parse(raw);
      const size = runSizeFrom(a);
      if (typeof size === "string") return { ok: false, message: size };
      return { ok: true, command: { type: "resize_run", segmentId: a.segment_id, profile: size } };
    }
    case "bim_slide_branch": {
      const a = PREVIEW_ONLY_ARGS.bim_slide_branch.parse(raw);
      return { ok: true, command: { type: "slide_branch", tapId: a.tap_id, s: ft(a.distance_ft) } };
    }
  }
}

const DESCRIPTIONS: Readonly<Record<BimRouteEditToolName, { title: string; description: string }>> = {
  bim_route_run: {
    title: "Route duct or pipe",
    description:
      "Route a duct or pipe run through plan points (feet), from / to a part's connector, an open run end, or the side of a trunk (a new tap, tee or wye by the system's rules); from / to may be on another level, heights staying from level_id's floor. Drops, elbows, transitions and the branch fitting are created with it, all or nothing, and the connectors are linked. Duct legs run level at any plan angle (the Route tool snaps; give any angle), plumb, or at a 45° slope, each elbow made to its turn (up to 135°) with that angle's loss; elbow types made only for 45° / 90° (mitred with vanes) refuse other turns. Pipe legs run E-W, N-S or 45° and turn 45° or 90°. Rises, fitting choices, insulation, sizing from airflow and the person's saved defaults: see the fields.",
  },
  bim_connect_runs: {
    title: "Connect runs",
    description:
      "Connect existing duct or pipe, as one edit: two open ends that meet face to face (or an end to a part's connector, or two parts' connectors end to end); mode auto_route joins two open ends that don't meet with a square route (one rise or drop) worked out between them; tap_into_side continues an open end straight into another level run's side with a tap at that run's height (the Select tool's drag of an end onto a duct); tee_at_elbow turns a level elbow into a tee so a branch can continue from the corner (the + on an elbow). Run sizes and systems must match (two parts join anyway, mismatches reported); anything that can't be made is refused with the reason and nothing changes.",
  },
  bim_disconnect_run: { title: "Disconnect a run end", description: "Cut one connection; both sides are left open. Nothing is deleted." },
  bim_route_flex: {
    title: "Run flex duct",
    description: "Flex from an open duct end into an air device's neck: round, sized to the neck, linked both ends. Refused if the end isn't the neck's size; warns past 6 ft.",
  },
};

export function registerBimRoutingTools(server: McpServer, helpers: PartToolHelpers, options: BimRoutingToolOptions): void {
  const { target, area, baseRevision } = helpers;
  const routeArgsWithDefaults = (tool: string, args: unknown, extra: unknown, projectId: string) => argsWithRouteDefaults(options.routeDefaults, tool, args, extra, projectId);

  server.registerTool(
    "bim_preview_route_edit",
    {
      title: "Preview a routing edit",
      description:
        "Dry run of bim_route_run, bim_connect_runs, bim_disconnect_run, bim_route_flex, bim_resize_run, bim_slide_branch, bim_swap_fitting, bim_offset_run, bim_change_elevation, bim_set_fitting_coefficient_override, bim_set_system_design, bim_set_slope, bim_place_pipe_accessory, bim_split_run, bim_resize_stretch, bim_drag_run or bim_set_duct_insulation at the revision you read: the elements it would create or change, or the plain reason it would be refused. Saves nothing and needs no approval.",
      inputSchema: {
        ...target,
        ...area,
        tool: z.enum(PREVIEWABLE),
        args: z.record(z.string(), z.unknown()).describe("The same arguments the edit tool takes, without project_id / model_id / base_revision."),
      },
    },
    async (input, extra) => {
      const tool = input.tool;
      const schema = tool === "bim_resize_run" || tool === "bim_slide_branch" ? PREVIEW_ONLY_ARGS[tool] : isFittingTool(tool) ? FITTING_EDIT_ARGS[tool] : ROUTE_EDIT_ARGS[tool];
      const parsed = schema.safeParse(withElementIdArg(tool, input.args));
      if (!parsed.success) return { content: [{ type: "text" as const, text: `Those arguments don't fit ${input.tool}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true };
      const runId = await helpers.runId(extra);
      const args = await routeArgsWithDefaults(input.tool, parsed.data, extra, input.project_id);
      if (typeof args === "string") return { content: [{ type: "text" as const, text: args }], isError: true };
      return helpers.read("bim_preview_route_edit", extra, input, (s) => {
        const model = s.model();
        const key = editIdempotencyKey(runId, input.tool, { model_id: input.model_id, args }, model.revision);
        const built = buildRouteCommand(input.tool, args, model, key);
        if (!built.ok) return { status: "would_refuse", revision: model.revision, message: built.message };
        return { ...s.preview(built.command), command: built.command };
      });
    },
  );

  for (const tool of BIM_ROUTE_EDIT_TOOL_NAMES) {
    const schema: z.ZodObject<z.ZodRawShape> = ROUTE_EDIT_ARGS[tool];
    const inputSchema: z.ZodRawShape = { ...target, ...area, ...baseRevision, ...schema.shape, ...(ADVERTISED_ROUTE_ARGS[tool] ?? {}) };
    server.registerTool(tool, { title: DESCRIPTIONS[tool].title, description: DESCRIPTIONS[tool].description, inputSchema }, async (args: unknown, extra: unknown) => {
      const where = z.object({ project_id: z.string().uuid(), model_id: z.string().min(1).max(200), level: z.string().min(1).max(40).optional(), zone: z.string().min(1).max(40).optional(), base_revision: z.number().int().min(0).optional() }).safeParse(args);
      const own = schema.safeParse(args);
      if (!where.success || !own.success) {
        const issues = [...(where.success ? [] : where.error.issues), ...(own.success ? [] : own.error.issues)];
        return { content: [{ type: "text" as const, text: `Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true };
      }
      const filled = await routeArgsWithDefaults(tool, own.data, extra, where.data.project_id);
      if (typeof filled === "string") return { content: [{ type: "text" as const, text: filled }], isError: true };
      return helpers.edit(tool, extra, where.data, filled, (model, key) => buildRouteCommand(tool, filled, model, key));
    });
  }
}

/** bim_route_run with use_my_defaults: the person's saved Route defaults fill what the agent left out; any other tool's arguments pass through. */
async function argsWithRouteDefaults(routeDefaults: RouteDefaultsStore, tool: string, args: unknown, extra: unknown, projectId: string): Promise<unknown> {
  if (tool !== "bim_route_run") return args;
  const a = ROUTE_EDIT_ARGS.bim_route_run.safeParse(args);
  if (!a.success || !a.data.use_my_defaults) return args;
  try {
    return withRouteDefaults(a.data, await routeDefaults(extra, projectId, a.data.kind));
  } catch (err) {
    console.error("[mcp:bim_route_run] reading the person's route defaults failed", { projectId, err });
    return `Couldn't read your saved route defaults: ${err instanceof Error ? err.message : String(err)}. Give the size and fittings instead, or try again.`;
  }
}
