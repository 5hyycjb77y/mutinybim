import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DUCT_MATERIALS,
  fittingFamilies,
  FITTING_SLOTS,
  SYSTEM_KINDS,
  dragLimit,
  executeCommand,
  fittingFamily,
  inheritedDuctDesign,
  insulationLabel,
  pipeDesignSchema,
  pipeJointLabel,
  runLabel,
  sizeLabel,
  type Command,
  type FittingFamily,
  type ModelState,
  type RunSize,
} from "@permitzip/bim-kernel";
import {
  PA_PER_IN_WC,
  PressureEngine,
  ductPerformance,
  sizingCriteriaFor,
  suggestDuctSize,
  type SystemPressureReport,
} from "@permitzip/bim-pack-mechanical";
import { PipeHydraulicsEngine, type PipeSystemReport, PIPE_COMMAND_FAMILY_COPY, pipeInsulationPlan } from "@permitzip/bim-pack-plumbing";
import { BIM_FITTING_EDIT_TOOL_NAMES, type BimFittingEditToolName } from "../support/tool-names";
import type { BuiltCommand, PartToolHelpers } from "../parts/parts";
import { insulationArg, insulationFrom, runSizeArgs, runSizeFrom } from "../parts/run-size";
import { commandFamilies, commandFamily } from "../parts/describe-commands";

/**
 * Fitting types, offsets, height changes, coefficients and pressure for
 * routed duct. The edits build the same kernel commands the browser sends
 * and go through the authority like every other edit; the reads compute on
 * the model the agent read.
 */

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;
const ft = (v: number) => Math.round(v * MM_PER_FT * 1000) / 1000;
const inch = (v: number) => Math.round(v * MM_PER_IN * 1000) / 1000;

const id = z.string().min(1).max(200);
const params = z.record(z.string().min(1).max(40), z.union([z.number(), z.string().max(40)])).optional().describe("Family parameters by key (bim_list_fitting_types lists them), e.g. { r_over_w: 1.5 } or { gores: \"5\" }.");
const SIDES = ["left", "right", "up", "down"] as const;

export const FITTING_EDIT_ARGS = {
  bim_swap_fitting: z.object({
    fitting_id: id,
    family: z.string().min(1).max(80).describe("Library family id from bim_list_fitting_types, e.g. duct.elbow.mitred_vanes."),
    params,
  }),
  bim_offset_run: z.object({
    segment_id: id,
    at_ft: z.number().positive().max(5000).describe("Where the offset starts, in feet from the segment's start."),
    side: z.enum(SIDES).describe("Which way the run goes, seen travelling from the segment's start to its end."),
    distance_in: z.number().positive().max(600).describe("How far, in inches."),
    length_ft: z.number().positive().max(5000).optional().describe("How long the displaced run is before it comes back in line. Leave out to move everything beyond the offset with it."),
    style: z.enum(["45", "90", "ogee"]).describe("Two 45° elbows, two 90° elbows, or one ogee (S) offset fitting."),
  }),
  bim_change_elevation: z.object({
    segment_id: id,
    from_ft: z.number().positive().max(5000).describe("Where the new height starts, feet from the segment's start."),
    to_ft: z.number().positive().max(5000).optional().describe("Where the run is back at its old height. Leave out to keep the new height to the end of the run (what is connected follows)."),
    elevation_ft: z.number().min(-100).max(100).describe("New centreline height above the level floor, in feet."),
    style: z.enum(["45", "90"]),
  }),
  bim_set_fitting_coefficient_override: z.object({
    fitting_id: id,
    path: z.enum(["body", "branch", "main"]).describe("body for elbows, transitions, offsets; branch or main for a takeoff."),
    c: z.number().min(0).max(100).nullable().describe("Loss coefficient C, on the same velocity pressure the report shows; null clears it."),
    set_by: z.string().trim().min(1).max(120).describe("Name of the engineer responsible for this value."),
    note: z.string().max(200).optional().describe("Where the value comes from (manufacturer data, test report)."),
  }),
  bim_set_system_design: z.object({
    system_id: id,
    name: z.string().trim().min(1).max(80).optional().describe("Rename the system (unique in the model), e.g. DCW-1."),
    altitude_ft: z.number().min(-1500).max(20_000).optional(),
    temperature_f: z.number().min(-40).max(250).optional(),
    material: z.enum(DUCT_MATERIALS).optional(),
    fittings: z
      .partialRecord(z.enum(FITTING_SLOTS), z.object({ family: z.string().min(1).max(80), params }).nullable())
      .optional()
      .describe(
        "Fitting routing places on this system per slot; null goes back to the library default. Duct: elbow_rect, elbow_round, branch_rect, … Pipe: pipe_elbow_90, pipe_elbow_45, pipe_tee, pipe_reducer, pipe_cap; drainage by direction change: drain_turn_hv / drain_turn_vh / drain_turn_hh / drain_turn_45, drain_branch_hv / drain_branch_hh.",
      ),
    default_insulation: insulationArg.optional().describe("Duct and pipe systems (pipe: a wrap): the insulation new runs on this system get when a route doesn't say (kind none clears it)."),
    sizing: z
      .object({
        friction_in_per_100ft: z.number().min(0.01).max(1).optional(),
        max_velocity_fpm: z.number().min(100).max(6000).optional(),
        max_aspect_ratio: z.number().min(1).max(10).optional(),
      })
      .nullable()
      .optional()
      .describe("Duct systems: what bim_suggest_duct_size aims for (merged field by field); null goes back to the typical values (0.08\" per 100 ft; 2,000 fpm supply, 1,500 fpm other; 4:1)."),
    pipe_design: pipeDesignSchema
      .optional()
      .describe(
        "Pipe systems, merged field by field. Water: supplyPressurePsi, fixedLossesPsi, minFixturePressurePsi, frictionMethod (hazen_williams | darcy), fittingMethod (k | equivalent_length), hazenC, waterTempF, maxVelocityFps, demandMethod (table | hunter_formula | flow_is_gpm), demandTable [{fu, gpm}], fixtureTable [{fixture, wsfu, dfu, mbh}]. Drainage: slopes [{maxNominalIn, inPerFt}], fillRatio, manningN, drainFlowTable [{dfu, gpm}], capacityTable [{nominalIn, inPerFt?, maxDfu}], directionRules [{family, hv, vh, hh}]. Gas: gasType (natural | propane), gasEquation, specificGravity, heatingValueBtuPerCf, inletPressureInWc, allowableDropInWc, gasSizing (longest_run | actual_length | branch_length). sizingMode (check | auto).",
      ),
  }),
  bim_set_slope: z.object({
    segment_id: id,
    in_per_ft: z.number().min(0).max(1).optional().describe("Fall in inches per foot of run. Leave out for the system's minimum for the pipe's size (1/4\" per ft up to 3\", 1/8\" per ft larger, unless the project changed it)."),
    flow: z.enum(["toward_start", "toward_end"]).optional().describe("Which end it drains to. Leave out to keep the way it already slopes (or into the run it branches into)."),
    keep: z.enum(["upstream", "downstream"]).optional().describe("Which end stays where it is. Leave out to keep the end that meets a trunk or fixture."),
  }),
  bim_place_pipe_accessory: z.object({
    segment_id: id,
    at_ft: z.number().positive().max(5000).describe("Centre of the item, in feet from the segment's start."),
    family: z.string().min(1).max(80).describe("Accessory family id from bim_list_fitting_types (fits: accessory), e.g. pipe.valve.ball, dwv.cleanout_tee, dwv.p_trap, pipe.gas.cock, pipe.gas.regulator."),
    params,
  }),
  bim_split_run: z.object({
    segment_id: id,
    at_ft: z.number().positive().max(5000).describe("Where to split, in feet from the segment's start."),
  }),
  bim_resize_stretch: z.object({
    segment_ids: z.array(id).min(1).max(500).describe("Routed segments that take the new size (a run, a branch, a selection). With from_ft / to_ft, exactly one."),
    from_ft: z.number().min(0).max(5000).optional().describe("Only the stretch of the one segment from here (feet from its start)."),
    to_ft: z.number().positive().max(5000).optional().describe("…to here."),
    ...runSizeArgs,
    transition: z
      .enum(["default", "concentric", "eccentric_flat_top", "eccentric_flat_bottom", "eccentric_flat_left", "eccentric_flat_right", "rect_to_round"])
      .optional()
      .describe("Transition placed where a neighbour keeps its size; default is each system's choice. Eccentric keeps one side flat (top keeps the top of duct level under structure); left and right are as seen looking from the end that keeps its size into the resized duct. Mirror one afterwards with bim_swap_fitting params { flat: \"bottom\" }."),
  }),
  bim_drag_run: z.object({
    element_id: id.describe("A straight routed segment, or an in-line elbow / transition (not a takeoff: slide those with bim_slide_branch)."),
    east_ft: z.number().min(-5000).max(5000).default(0),
    north_ft: z.number().min(-5000).max(5000).default(0),
    up_ft: z.number().min(-500).max(500).default(0).describe("Negative lowers."),
    end: z.enum(["start", "end"]).optional().describe("Move only this end of a segment (the elbow there, or an open end), e.g. the top of a rise to make it taller."),
    strict: z.boolean().optional().describe("Don't flip elbows: a leg that would be pulled back past its elbow stops at the elbow's limit instead (as holding Alt does in the view)."),
    stop_at_limit: z.boolean().optional().describe("Kept for older callers: a move that can't go all the way always stops at the limit now, as dragging does."),
  }),
  bim_set_duct_insulation: z.object({
    element_id: id.describe("A routed duct or pipe segment or fitting."),
    insulation: insulationArg.optional().describe("Pipe takes a wrap only. Leave out with from_schedule."),
    scope: z.enum(["piece", "run", "system"]).default("run").describe("piece: the segment and the fittings at its ends. run: same-size segments and elbows joined to it, stopping at transitions, branches and parts. system: every duct or pipe of its system."),
    from_schedule: z.boolean().optional().describe("Pipe: give every pipe of the element's system the project's pipe insulation schedule thickness for its size (bim_plumbing_design action project, insulation_schedule)."),
  }),
} as const satisfies Record<BimFittingEditToolName, z.ZodTypeAny>;

const SYSTEM_DESIGN = FITTING_EDIT_ARGS.bim_set_system_design.shape;
/** A pipe system's design inputs and a system's fittings per slot, read in full with bim_describe_commands. */
commandFamily({ tool: "bim_set_system_design", field: "pipe_design", label: PIPE_COMMAND_FAMILY_COPY.find((f) => f.tool === "bim_set_system_design" && f.field === "pipe_design")?.label ?? "pipe_design", schema: SYSTEM_DESIGN.pipe_design });
commandFamily({ tool: "bim_set_system_design", field: "fittings", label: "The fitting routing places per slot; null goes back to the library default.", schema: SYSTEM_DESIGN.fittings });

/**
 * What a tool advertises where it differs from its full schema. The handler
 * parses with the full schema (FITTING_EDIT_ARGS) either way, so a misfit is
 * answered with the field and what is wrong.
 */
const ADVERTISED_FITTING_ARGS: Partial<Record<BimFittingEditToolName, z.ZodRawShape>> = {
  bim_set_system_design: {
    fittings: z.record(z.string(), z.unknown()).optional().describe(`${SYSTEM_DESIGN.fittings.description ?? ""} Each slot: { family, params } or null. Exact fields: bim_describe_commands field fittings.`),
    pipe_design: z.record(z.string(), z.unknown()).optional().describe(`${SYSTEM_DESIGN.pipe_design.description ?? ""} Exact fields: bim_describe_commands field pipe_design.`),
  },
};

/** The misfit of a tool's arguments against its full schema, naming each field's exact form when it has a family. */
function fittingArgsIssue(tool: BimFittingEditToolName, issues: readonly z.core.$ZodIssue[]): string {
  const fields = [...new Set(issues.map((i) => String(i.path[0] ?? "")))].filter((f) => commandFamilies(tool).some((fam) => fam.field === f));
  const hint = fields.length > 0 ? ` Exact fields: bim_describe_commands({ tool: "${tool}", field: "${fields[0]}" }).` : "";
  return `Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}.${hint}`;
}

const TRANSITION_FAMILY = {
  default: null,
  concentric: { family: "duct.transition.concentric" },
  eccentric_flat_top: { family: "duct.transition.eccentric", params: { flat: "top" } },
  eccentric_flat_bottom: { family: "duct.transition.eccentric", params: { flat: "bottom" } },
  eccentric_flat_left: { family: "duct.transition.eccentric", params: { flat: "left" } },
  eccentric_flat_right: { family: "duct.transition.eccentric", params: { flat: "right" } },
  rect_to_round: { family: "duct.transition.rect_round" },
} as const;

function sideVector(model: ModelState, segmentId: string, side: (typeof SIDES)[number], distanceMm: number): { x: number; y: number; z: number } | string {
  const seg = model.elements[segmentId];
  if (seg?.kind !== "run_segment") return `No routed segment ${segmentId} in this model.`;
  const dx = seg.end.x - seg.start.x;
  const dy = seg.end.y - seg.start.y;
  const plan = Math.hypot(dx, dy);
  if (side === "up" || side === "down") return { x: 0, y: 0, z: side === "up" ? distanceMm : -distanceMm };
  if (plan < 0.01) return "This segment runs straight up and down, so left and right aren't defined for it; offset the level run beside it instead.";
  const left = { x: -dy / plan, y: dx / plan };
  const k = side === "left" ? distanceMm : -distanceMm;
  return { x: Math.round(left.x * k * 1000) / 1000, y: Math.round(left.y * k * 1000) / 1000, z: 0 };
}

function newPrefix(key: string): string {
  return `jog-${key.replace(/^agent-/, "").slice(0, 16)}`;
}

export function buildFittingCommand(tool: BimFittingEditToolName, raw: unknown, model: ModelState, key: string, now: () => string = () => new Date().toISOString()): BuiltCommand {
  switch (tool) {
    case "bim_swap_fitting": {
      const a = FITTING_EDIT_ARGS.bim_swap_fitting.parse(raw);
      if (!fittingFamily(a.family)) return { ok: false, message: `There is no fitting type ${a.family}; bim_list_fitting_types lists them.` };
      return { ok: true, command: { type: "swap_fitting", fittingId: a.fitting_id, family: a.family, ...(a.params ? { params: a.params } : {}) } };
    }
    case "bim_offset_run": {
      const a = FITTING_EDIT_ARGS.bim_offset_run.parse(raw);
      const offset = sideVector(model, a.segment_id, a.side, inch(a.distance_in));
      if (typeof offset === "string") return { ok: false, message: offset };
      return { ok: true, command: { type: "offset_run", idPrefix: newPrefix(key), segmentId: a.segment_id, atMm: ft(a.at_ft), offset, style: a.style, ...(a.length_ft !== undefined ? { lengthMm: ft(a.length_ft) } : {}) } };
    }
    case "bim_change_elevation": {
      const a = FITTING_EDIT_ARGS.bim_change_elevation.parse(raw);
      return { ok: true, command: { type: "change_elevation", idPrefix: newPrefix(key), segmentId: a.segment_id, fromMm: ft(a.from_ft), elevationMm: ft(a.elevation_ft), style: a.style, ...(a.to_ft !== undefined ? { toMm: ft(a.to_ft) } : {}) } };
    }
    case "bim_set_fitting_coefficient_override": {
      const a = FITTING_EDIT_ARGS.bim_set_fitting_coefficient_override.parse(raw);
      return { ok: true, command: { type: "set_fitting_coefficient", fittingId: a.fitting_id, role: a.path, c: a.c, by: a.set_by, at: now(), ...(a.note ? { note: a.note } : {}) } };
    }
    case "bim_split_run": {
      const a = FITTING_EDIT_ARGS.bim_split_run.parse(raw);
      return { ok: true, command: { type: "split_run", idPrefix: `split-${key.replace(/^agent-/, "").slice(0, 16)}`, segmentId: a.segment_id, atMm: ft(a.at_ft) } };
    }
    case "bim_resize_stretch": {
      const a = FITTING_EDIT_ARGS.bim_resize_stretch.parse(raw);
      const size = runSizeFrom(a);
      if (typeof size === "string") return { ok: false, message: size };
      const transition = TRANSITION_FAMILY[a.transition ?? "default"];
      return {
        ok: true,
        command: {
          type: "resize_stretch",
          idPrefix: `rs-${key.replace(/^agent-/, "").slice(0, 16)}`,
          segmentIds: a.segment_ids,
          size,
          ...(a.from_ft !== undefined ? { fromMm: ft(a.from_ft) } : {}),
          ...(a.to_ft !== undefined ? { toMm: ft(a.to_ft) } : {}),
          ...(transition ? { transition: { family: transition.family, ...("params" in transition ? { params: { ...transition.params } } : {}) } } : {}),
        },
      };
    }
    case "bim_drag_run": {
      const a = FITTING_EDIT_ARGS.bim_drag_run.parse(raw);
      const plain = { type: "drag_run" as const, elementId: a.element_id, delta: { x: ft(a.east_ft), y: ft(a.north_ft), z: ft(a.up_ft) }, ...(a.end ? { grip: a.end } : {}) };
      // As in the view: past an elbow it flips by default, and where it can't move all the way it stops at the limit; strict never flips.
      const command = a.strict ? plain : { ...plain, reroute: true };
      const tried = executeCommand(model, command);
      if (tried.ok) return { ok: true, command };
      const limit = dragLimit(model, plain);
      if (!limit.accepted) {
        if (!limit.binding) return { ok: false, message: "It can't move that way at all." };
        const why = limit.binding.message.replace(/^./, (c) => c.toUpperCase());
        return { ok: false, message: why.endsWith(".") ? `${why} It can't move that way at all.` : `${why}; it can't move that way at all.`, code: limit.binding.code, elementIds: tried.error.elementIds };
      }
      return { ok: true, command: { ...plain, delta: limit.accepted } };
    }
    case "bim_set_system_design": {
      const a = FITTING_EDIT_ARGS.bim_set_system_design.parse(raw);
      const insulation = a.default_insulation ? insulationFrom(a.default_insulation) : undefined;
      if (typeof insulation === "string") return { ok: false, message: insulation };
      const sizing =
        a.sizing === undefined
          ? undefined
          : a.sizing === null
            ? null
            : {
                ...(a.sizing.friction_in_per_100ft !== undefined ? { frictionInPer100Ft: a.sizing.friction_in_per_100ft } : {}),
                ...(a.sizing.max_velocity_fpm !== undefined ? { maxVelocityFpm: a.sizing.max_velocity_fpm } : {}),
                ...(a.sizing.max_aspect_ratio !== undefined ? { maxAspectRatio: a.sizing.max_aspect_ratio } : {}),
              };
      const design = {
        ...(a.altitude_ft !== undefined ? { altitudeM: Math.round(a.altitude_ft * 0.3048 * 100) / 100 } : {}),
        ...(a.temperature_f !== undefined ? { temperatureC: Math.round(((a.temperature_f - 32) * 5) / 9 * 100) / 100 } : {}),
        ...(a.material ? { material: a.material } : {}),
        ...(a.pipe_design ? { pipe: a.pipe_design } : {}),
        ...(insulation !== undefined ? { insulation } : {}),
        ...(sizing !== undefined ? { sizing } : {}),
      };
      const command: Command = { type: "set_system_design", systemId: a.system_id, ...(a.name ? { name: a.name } : {}), ...(Object.keys(design).length > 0 ? { design } : {}), ...(a.fittings ? { fittingDefaults: a.fittings } : {}) };
      return { ok: true, command };
    }
    case "bim_set_slope": {
      const a = FITTING_EDIT_ARGS.bim_set_slope.parse(raw);
      return { ok: true, command: { type: "set_slope", segmentId: a.segment_id, ...(a.in_per_ft !== undefined ? { inPerFt: a.in_per_ft } : {}), ...(a.flow ? { flow: a.flow } : {}), ...(a.keep ? { keep: a.keep } : {}) } };
    }
    case "bim_set_duct_insulation": {
      const a = FITTING_EDIT_ARGS.bim_set_duct_insulation.parse(raw);
      if (a.from_schedule) {
        const el = model.elements[a.element_id];
        if ((el?.kind !== "run_segment" && el?.kind !== "run_fitting") || el.domain !== "pipe") return { ok: false, message: "from_schedule applies to pipe: give a pipe segment or fitting of the system." };
        const plan = pipeInsulationPlan(model, el.systemId);
        if ("reason" in plan) return { ok: false, message: plan.reason };
        if (plan.pieces.length === 0) return { ok: false, message: `Every pipe of ${plan.systemName} already has its scheduled insulation${plan.unscheduled > 0 ? ` (${plan.unscheduled} size${plan.unscheduled === 1 ? " has" : "s have"} no row)` : ""}.` };
        return { ok: true, command: { type: "set_pipe_insulation", systemId: plan.systemId, label: `Pipe insulation from the project's schedule on ${plan.pieces.length} pipe${plan.pieces.length === 1 ? "" : "s"} of ${plan.systemName}`.slice(0, 160), pieces: plan.pieces.map((p) => ({ segmentId: p.segmentId, insulation: p.insulation })) } };
      }
      if (!a.insulation) return { ok: false, message: "Give insulation ({ kind, thickness_in }), or from_schedule: true for pipe." };
      const insulation = insulationFrom(a.insulation);
      if (typeof insulation === "string") return { ok: false, message: insulation };
      return { ok: true, command: { type: "set_run_insulation", elementId: a.element_id, insulation, scope: a.scope } };
    }
    case "bim_place_pipe_accessory": {
      const a = FITTING_EDIT_ARGS.bim_place_pipe_accessory.parse(raw);
      const family = fittingFamily(a.family);
      if (!family) return { ok: false, message: `There is no fitting type ${a.family}; bim_list_fitting_types lists them.` };
      if (!family.fittingTypes.includes("accessory")) return { ok: false, message: `${family.name} isn't an inline accessory; bim_list_fitting_types with fits "accessory" lists valves, unions, cleanouts, traps and drip legs.` };
      return { ok: true, command: { type: "place_run_accessory", accessoryId: `acc-${key.replace(/^agent-/, "").slice(0, 16)}`, segmentId: a.segment_id, atMm: ft(a.at_ft), family: a.family, ...(a.params ? { params: a.params } : {}) } };
    }
  }
}

export const SUGGEST_DUCT_SIZE_ARGS = z.object({
  airflow_cfm: z.number().positive().max(200_000).optional().describe("Air to carry. Leave out with element_id to use what that segment carries."),
  shape: z.enum(["rect", "round"]).optional().describe("Leave out for the element's shape, else rectangular."),
  element_id: id.optional().describe("A routed duct segment: its system, insulation, depth and airflow are used unless given here."),
  system_id: id.optional().describe("The system whose criteria and design air apply (or system_kind for a new one)."),
  system_kind: z.enum(SYSTEM_KINDS).optional(),
  height_in: z.number().positive().max(240).optional().describe("Rectangular: also give the narrowest width at this depth (what the ceiling allows)."),
  insulation: insulationArg.optional().describe("Leave out for the element's own, else the system's default."),
  friction_in_per_100ft: z.number().min(0.01).max(1).optional().describe("Overrides the system's friction rate for this suggestion."),
  max_velocity_fpm: z.number().min(100).max(6000).optional(),
  max_aspect_ratio: z.number().min(1).max(10).optional(),
  check_width_in: z.number().positive().max(240).optional().describe("A rectangular size to check (with check_height_in)."),
  check_height_in: z.number().positive().max(240).optional(),
  check_diameter_in: z.number().positive().max(240).optional().describe("A round size to check."),
});

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function optionTable(o: { size: RunSize; velocityFpm: number; frictionInPer100Ft: number; airway: RunSize; limitedBy?: string }) {
  const s = o.size;
  return {
    size: sizeLabel(s),
    ...(s.shape === "rect" ? { width_in: r3(s.width / MM_PER_IN), height_in: r3(s.height / MM_PER_IN) } : s.shape === "round" ? { diameter_in: r3(s.diameter / MM_PER_IN) } : {}),
    inside: sizeLabel(o.airway),
    velocity_fpm: Math.round(o.velocityFpm),
    friction_in_per_100ft: r3(o.frictionInPer100Ft),
    ...(o.limitedBy ? { limited_by: o.limitedBy } : {}),
  };
}

/** What bim_suggest_duct_size answers, on the model the agent read. */
export function ductSizeAdvice(model: ModelState, a: z.infer<typeof SUGGEST_DUCT_SIZE_ARGS>) {
  const el = a.element_id ? model.elements[a.element_id] : undefined;
  if (a.element_id && el?.kind !== "run_segment") return { revision: model.revision, message: `${a.element_id} isn't a routed duct segment in the area you loaded.` };
  const seg = el?.kind === "run_segment" ? el : null;
  if (seg && seg.domain !== "duct") return { revision: model.revision, message: `${a.element_id} is ${seg.domain}; this sizes duct.` };
  const systemEl = model.elements[a.system_id ?? seg?.systemId ?? ""];
  const system = systemEl?.kind === "mep_system" ? systemEl : null;
  const kind = system?.systemKind ?? a.system_kind ?? "supply_air";
  const design = system?.design ?? (a.system_kind ? inheritedDuctDesign(model, { systemKind: a.system_kind }) : undefined);
  const asked = a.insulation ? insulationFrom(a.insulation) : undefined;
  if (typeof asked === "string") return { revision: model.revision, message: asked };
  const insulation = asked === undefined ? (seg ? seg.insulation : design?.insulation) : (asked ?? undefined);
  const cfm = a.airflow_cfm ?? (seg && seg.flow > 0 ? seg.flow : undefined);
  if (cfm === undefined) return { revision: model.revision, message: seg ? `${runLabel(model.elements, seg)} carries no air yet (it reaches no air device); give airflow_cfm.` : "Give airflow_cfm, or element_id of a segment that carries air." };
  const base = sizingCriteriaFor(kind, design);
  const criteria = { frictionInPer100Ft: a.friction_in_per_100ft ?? base.frictionInPer100Ft, maxVelocityFpm: a.max_velocity_fpm ?? base.maxVelocityFpm, maxAspectRatio: a.max_aspect_ratio ?? base.maxAspectRatio };
  const shape = a.shape ?? (seg?.size.shape === "round" ? "round" : "rect");
  const holdHeightMm = a.height_in !== undefined ? inch(a.height_in) : seg?.size.shape === "rect" && shape === "rect" ? seg.size.height : undefined;
  const s = suggestDuctSize({ cfm, shape, criteria, ...(insulation ? { insulation } : {}), ...(design ? { design } : {}), ...(holdHeightMm !== undefined ? { holdHeightMm } : {}) });
  const check: RunSize | null = a.check_diameter_in !== undefined ? { shape: "round", diameter: inch(a.check_diameter_in) } : a.check_width_in !== undefined && a.check_height_in !== undefined ? { shape: "rect", width: inch(a.check_width_in), height: inch(a.check_height_in) } : null;
  const checked = check ? ductPerformance(cfm, check, insulation, design) : null;
  return {
    revision: model.revision,
    airflow_cfm: Math.round(cfm),
    shape,
    insulation: insulationLabel(insulation),
    criteria: {
      friction_in_per_100ft: criteria.frictionInPer100Ft,
      max_velocity_fpm: criteria.maxVelocityFpm,
      max_aspect_ratio: criteria.maxAspectRatio,
      ...(base.typical.length > 0 ? { typical_values_used_for: base.typical } : {}),
    },
    ...(s.ok
      ? { suggested: optionTable(s.atHeight ?? s.best), ...(s.atHeight && sizeLabel(s.atHeight.size) !== sizeLabel(s.best.size) ? { least_sheet_metal: optionTable(s.best) } : {}) }
      : { refused: s.reason }),
    ...(check && checked ? { checked: optionTable({ size: check, ...checked }) } : {}),
    ...(seg ? { current: sizeLabel(seg.size) } : {}),
    note: "A suggestion only: nothing changed. Typical criteria are general engineering values; verify for the project.",
  };
}

const psi = (v: number) => Math.round(v * 1000) / 1000;

/** The pipe report as an agent and the properties panel read it: psi or in. w.c., gpm, cfh, ft/s, fixture units. */
export function pipeTable(model: ModelState, report: PipeSystemReport) {
  const common = { revision: model.revision, system: report.systemName, from: report.rootLabel || null, basis: report.basis, warnings: report.warnings.map((w) => w.message) };
  switch (report.kind) {
    case "not_calculated":
      return { ...common, calculable: false, reason: report.reason };
    case "water":
      return {
        ...common,
        calculable: true,
        kind: "domestic water",
        supply_psi: report.supplyPsi,
        friction: report.method.friction,
        fittings_as: report.method.fittings,
        demand: report.method.demand,
        total_fixture_units: report.totalFixtureUnits,
        peak_gpm: report.peakGpm,
        critical_fixture: report.critical ? { element_id: report.critical.elementId, what: report.critical.label, psi: psi(report.critical.pressure), elevation_ft: report.critical.elevationFt } : null,
        required_psi: report.minFixturePsi,
        pass: report.pass,
        pipes: report.segments.map((s) => ({ element_id: s.elementId, what: s.label, fixture_units: s.fixtureUnits, gpm: s.gpm, bore_in: s.idIn, velocity_fps: s.velocityFps, friction_psi_per_100ft: s.frictionPsiPer100Ft, length_ft: s.lengthFt, friction_psi: s.frictionPsi, static_psi: s.elevationPsi, over_velocity: s.overVelocity })),
        fittings: report.fittings.map((f) => ({ element_id: f.elementId, what: f.label, type: f.family, paths: f.paths.map((p) => ({ path: p.role, k: p.k, equivalent_ft: p.equivalentLengthFt, loss_psi: psi(p.loss), source: p.source })) })),
        ends: report.ends.map((e) => ({ element_id: e.elementId, what: e.label, psi: psi(e.pressure) })),
      };
    case "drainage":
      return {
        ...common,
        calculable: true,
        kind: "drainage",
        total_fixture_units: report.totalFixtureUnits,
        fill_ratio: report.fillRatio,
        pass: report.pass,
        stacks: report.stacks.map((s) => ({ element_id: s.elementId, what: s.label, fixture_units: s.fixtureUnits })),
        pipes: report.segments.map((s) => ({ element_id: s.elementId, what: s.label, role: s.role, fixture_units: s.fixtureUnits, design_gpm: s.designGpm, slope_in_per_ft: s.slopeInPerFt, capacity_gpm: s.capacityGpm, utilisation: s.utilisation, velocity_fps: s.velocityFps, table_max_dfu: s.tableMaxDfu, ok: s.ok })),
      };
    case "gas":
      return {
        ...common,
        calculable: true,
        kind: "fuel gas",
        equation: report.equation,
        specific_gravity: report.specificGravity,
        inlet_in_wc: report.inletInWc,
        allowable_drop_in_wc: report.allowableDropInWc,
        sizing: report.sizing,
        longest_run_ft: report.longestRunFt,
        total_mbh: report.totalMbh,
        critical_outlet: report.critical ? { element_id: report.critical.elementId, what: report.critical.label, in_wc: psi(report.critical.pressure) } : null,
        pass: report.pass,
        ...(report.zones ? { zones: report.zones.map((z) => ({ zone_id: z.id, what: z.label, inlet_in_wc: z.inletInWc, allowable_drop_in_wc: z.allowableDropInWc, longest_ft: z.longestFt, mbh: z.totalMbh, pass: z.pass })) } : {}),
        pipes: report.segments.map((s) => ({ element_id: s.elementId, what: s.label, mbh: s.mbh, cfh: s.cfh, bore_in: s.idIn, length_ft: s.lengthFt, drop_in_wc: s.dropInWc, design_drop_in_wc: s.designDropInWc, ok: s.ok })),
        fittings: report.fittings.map((f) => ({ element_id: f.elementId, what: f.label, type: f.family, paths: f.paths.map((p) => ({ path: p.role, k: p.k, equivalent_ft: p.equivalentLengthFt, source: p.source })) })),
      };
  }
}

/** The report as an agent and the approval card read it: inches of water, feet, CFM, fpm. */
export function pressureTable(model: ModelState, report: SystemPressureReport) {
  const wc = (pa: number) => Math.round((pa / PA_PER_IN_WC) * 10_000) / 10_000;
  const label = (elementId: string) => {
    const el = model.elements[elementId];
    return el?.kind === "run_segment" || el?.kind === "run_fitting" ? runLabel(model.elements, el) : elementId;
  };
  return {
    revision: model.revision,
    system: report.systemName,
    calculable: report.calculable,
    ...(report.reason ? { reason: report.reason } : {}),
    fan: report.hasFan ? report.rootLabel : null,
    air: { density_kg_m3: Math.round(report.air.densityKgM3 * 10_000) / 10_000, altitude_ft: Math.round(report.air.altitudeM / 0.3048), temperature_f: Math.round(report.air.temperatureC * 1.8 + 32), material: report.air.material, friction: report.air.frictionMethod },
    ...(report.calculable ? { required_esp_in_wc: report.requiredEspInWc } : {}),
    critical_path: report.criticalPath.map((s) => ({ element_id: s.elementId, what: s.label, loss_in_wc: wc(s.lossPa), cumulative_in_wc: wc(s.cumulativePa) })),
    elements: Object.values(report.elements).map((e) =>
      e.kind === "segment"
        ? { element_id: e.elementId, what: label(e.elementId), cfm: e.flowCfm, velocity_fpm: e.velocityFpm, friction_in_per_100ft: e.frictionRateInPer100Ft, straight_ft: Math.round((e.straightLengthMm / MM_PER_FT) * 100) / 100, loss_in_wc: wc(e.lossPa) }
        : {
            element_id: e.elementId,
            what: label(e.elementId),
            type: e.familyName,
            paths: e.paths.map((p) => ({ path: p.role, cfm: p.flowCfm, velocity_fpm: p.velocityFpm, c: p.c, on_vp: p.reference, loss_in_wc: wc(p.lossPa), source: p.source.label })),
            loss_in_wc: wc(e.lossPa),
          },
    ),
    ends: report.ends.map((e) => ({ element_id: e.elementId, what: e.label, from_fan_in_wc: wc(e.pathPa) })),
    warnings: report.warnings,
    note: "Built-in coefficients are published-correlation formulas: verify for permit work, or enter the firm's table / an override.",
  };
}

const DESCRIPTIONS: Readonly<Record<BimFittingEditToolName, { title: string; description: string }>> = {
  bim_swap_fitting: {
    title: "Change a fitting's type",
    description:
      "Change a routed fitting to another library type (radius elbow r/W, mitred with turning vanes, 3/4/5-gore round, concentric / eccentric / rect-to-round transition, straight / 45° entry / conical / bellmouth / boot tap, lateral…). Same fitting, same connections. On the same type, params given change and the rest stay: an eccentric transition's flat side moves with params { flat: top | bottom | left | right } (Mirror = the opposite side) and keeps its wall angle. A type that can't be that fitting, or doesn't fit the duct beside it, is refused with the reason. Resizing a run to another shape swaps fittings not made in it (a smooth radius elbow on round duct becomes the system's round elbow) and says so.",
  },
  bim_offset_run: {
    title: "Offset a run",
    description:
      "Jog a routed duct or pipe run left, right, up or down at a point, with two 45° elbows, two 90° elbows or one ogee offset. With length_ft the run comes back in line and both ends stay; without it everything beyond moves with it (connected parts that can't follow refuse).",
  },
  bim_change_elevation: {
    title: "Change a run's height",
    description: "Raise or drop a stretch of a level run to a new height with 45° or 90° rises, back to the old height at to_ft, or to the end of the run (what is connected follows).",
  },
  bim_set_fitting_coefficient_override: {
    title: "Set an engineer's loss coefficient",
    description: "Record an engineer's own C on one fitting (body, or the branch / main path of a takeoff or pipe tee), with their name and the time; it wins over tables and formulas. On pipe it is the K the hydraulics report uses (water, gas; drains take none). c = null clears it.",
  },
  bim_split_run: {
    title: "Split a run",
    description: "Cut a routed duct or pipe segment in two at a point (a plain joint). Both pieces keep its size, system and connections; branches stay on the piece they sit on. A cut on a takeoff, or one leaving a piece too short for its fittings, is refused with the reason.",
  },
  bim_resize_stretch: {
    title: "Resize or reshape a stretch",
    description:
      "Give routed segments a new size or shape in one atomic edit (rectangular, round, flat oval, or pipe), optionally only between from_ft and to_ft on one segment. Elbows between resized pieces follow; where a neighbour keeps its size a transition is placed (the system's default, or concentric / eccentric flat top, bottom, left or right / rect-to-round), with the insulation of the duct it joins. Elbows, transitions and taps not made in the new shape take the system's choice for it (round duct gets the round elbow) and the result says which. Refused with the reason when a transition doesn't fit the straight duct beside it, or a branch would be as wide as its trunk.",
  },
  bim_drag_run: {
    title: "Drag a run piece",
    description:
      "Move one straight routed segment or in-line elbow by east_ft / north_ft / up_ft, as dragging it in the view does; what it meets follows (legs along the move stretch, legs square to it move, fixed parts refuse). A segment moves square to itself or along itself; a 45° or sloped piece between legs at an angle slides so those legs only stretch. With end, only that end moves (raise the top of a rise to make it taller). As dragging does, a leg pulled back past its elbow turns the other way (its 90° elbows flip), and a move that can't go all the way (a leg shorter than its elbows need, an elbow that can't flip) stops at the limit; the result says how far it moved and why. strict: true never flips and stops at the elbow limit instead. Refused only when it can't move that way at all.",
  },
  bim_set_duct_insulation: {
    title: "Set duct or pipe insulation",
    description:
      "Put an external wrap or internal liner (thickness in inches, optional material and R-value) on routed duct, or a wrap on pipe, or take it off: one piece, the run (stopping at transitions, branches and parts), or every duct or pipe of the system; from_schedule gives a pipe system the project's thickness by size. The size stays the sheet-metal size; a liner narrows the airway the pressure report uses (faced liner by default; surface spray_coated is rougher), a wrap grows the outside size. Fittings take the insulation of the duct they join. A liner that leaves less than 2\" clear inside is refused with the reason.",
  },
  bim_set_system_design: {
    title: "Set a system's fittings and design inputs",
    description:
      "Rename a system, or choose the fittings routing places on a system (per slot), and its design inputs: for duct, altitude, air temperature, duct material, the default insulation new runs get, and the sizing criteria bim_suggest_duct_size aims for; for pipe, pipe_design (water supply pressure, friction method, demand table, velocity limit; drain slopes, capacity table, direction-rule overrides; gas equation, specific gravity, allowable drop). No code tables are bundled: tables are the firm's own values.",
  },
  bim_set_slope: {
    title: "Set a drain's slope",
    description:
      "Pitch one level pipe segment (a drain) to a fall in inches per foot: one end stays, the other rises or drops, and what is connected beyond it follows (level runs move, vertical runs stretch, fixed fixtures refuse). Flatter than the system's minimum, or sloping a branch away from the run it drains into, is refused with the reason.",
  },
  bim_place_pipe_accessory: {
    title: "Put an inline accessory on a pipe",
    description:
      "Place a valve, union, coupling, cleanout, test tee, P-trap, gas cock, drip leg or gas regulator (params role, outlet_in_wc, zone_drop_in_wc: starts a pressure zone) inline on a pipe segment, at a distance from its start. Checked for service, material, joint, pipe direction and room.",
  },
};

export function registerBimFittingTools(server: McpServer, helpers: PartToolHelpers): void {
  const { target, area, baseRevision } = helpers;
  const engine = new PressureEngine();
  const hydraulics = new PipeHydraulicsEngine();

  const pipeInfo = (f: FittingFamily) =>
    f.pipe
      ? {
          services: f.pipe.services,
          materials: f.pipe.materials,
          joints: f.pipe.joints.map((j) => ({ id: j, label: pipeJointLabel(j) ?? j })),
          ...(f.pipe.direction ? { direction_changes: { horizontal_to_vertical: f.pipe.direction.hv, vertical_to_horizontal: f.pipe.direction.vh, horizontal_to_horizontal: f.pipe.direction.hh } } : {}),
          ...(f.pipe.placement ? { goes_on: `${f.pipe.placement} pipe` } : {}),
          ...(f.pipe.lOverD ? { typical_l_over_d: f.pipe.lOverD } : {}),
        }
      : {};

  server.registerTool(
    "bim_list_fitting_types",
    {
      title: "List fitting types",
      description:
        "The fitting library: every family routing can place, what it fits, and its parameters. Duct: elbows, transitions, offsets, takeoffs, caps. Pipe: domestic water, drainage / waste / vent and fuel gas fittings with their joints, materials, take-out, and for drainage which direction changes each may make (rules to check against the adopted code). Use the id with bim_swap_fitting, bim_set_system_design or bim_place_pipe_accessory.",
      inputSchema: { domain: z.enum(["duct", "pipe"]).optional(), service: z.enum(["water", "drainage", "vent", "gas"]).optional().describe("Pipe only: families for this service.") },
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            fittingFamilies().filter((f) => (!args.domain || f.domain === args.domain) && (!args.service || (f.pipe?.services ?? []).includes(args.service))).map((f) => ({
              id: f.id,
              name: f.name,
              construction_type: f.smacnaType,
              fits: f.fittingTypes,
              shapes: f.shapes,
              ...(f.mainShapes ? { trunk_shapes: f.mainShapes } : {}),
              params: f.params.map((p) => (p.kind === "number" ? { key: p.key, label: p.label, default: p.default, min: p.min, max: p.max, unit: p.unit } : { key: p.key, label: p.label, options: p.options, default: p.default })),
              ...pipeInfo(f),
              description: f.description,
            })),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "bim_pipe_report",
    {
      title: "Pipe hydraulics report",
      description:
        "Hydraulics for one pipe system. Domestic water: gpm, velocity, friction (Hazen-Williams or Darcy), fitting K or equivalent length, static head, pressure at every fixture and the critical one against the required pressure. Drainage: fixture units on every pipe and stack, design flow, capacity at its slope (Manning, partly full) and stack capacity. Fuel gas: cfh, drop by Spitzglass or Mueller, the longest run, the pressure at each outlet. Built-in values are labelled verify for permit work; firm tables apply when entered. Give system_id, or element_id of any pipe in it.",
      inputSchema: { ...target, ...area, system_id: id.optional(), element_id: id.optional() },
    },
    async (input, extra) =>
      helpers.read("bim_pipe_report", extra, input, (s) => {
        const model = s.model();
        const el = input.element_id ? model.elements[input.element_id] : undefined;
        const systemId = input.system_id ?? (el?.kind === "run_segment" || el?.kind === "run_fitting" ? el.systemId : undefined);
        if (!systemId) return { revision: model.revision, message: input.element_id ? `${input.element_id} isn't a routed pipe in the area you loaded.` : "Give system_id (bim_model_summary lists routedSystems) or element_id." };
        const report = hydraulics.report(model, systemId, el?.id);
        if (!report) return { revision: model.revision, message: `No system ${systemId} in this model.` };
        return pipeTable(model, report);
      }),
  );

  server.registerTool(
    "bim_pressure_report",
    {
      title: "Duct pressure report",
      description:
        "Static pressure for one duct system: each segment's CFM, velocity, friction rate and loss, each fitting's C (with its source), the critical path to the fan and the external static pressure the fan needs, in inches of water. Give system_id, or element_id of any run in it.",
      inputSchema: { ...target, ...area, system_id: id.optional(), element_id: id.optional() },
    },
    async (input, extra) =>
      helpers.read("bim_pressure_report", extra, input, (s) => {
        const model = s.model();
        const el = input.element_id ? model.elements[input.element_id] : undefined;
        const systemId = input.system_id ?? (el?.kind === "run_segment" || el?.kind === "run_fitting" ? el.systemId : undefined);
        if (!systemId) return { revision: model.revision, message: input.element_id ? `${input.element_id} isn't a routed run in the area you loaded.` : "Give system_id (bim_model_summary lists routedSystems) or element_id." };
        const report = engine.report(model, systemId, el?.id);
        if (!report) return { revision: model.revision, message: `No system ${systemId} in this model.` };
        return pressureTable(model, report);
      }),
  );

  server.registerTool(
    "bim_suggest_duct_size",
    {
      title: "Suggest a duct size from airflow",
      description:
        "The smallest standard duct for an airflow at the system's friction rate and velocity limit (equal friction, Darcy-Weisbach with the system's design air and material, through the airway a liner leaves), with its velocity and friction; for rectangular duct also the narrowest width at a given depth. Give airflow_cfm, or element_id of a segment to use what it carries. check_* sizes report velocity and friction for a size you have in mind. Nothing changes: apply a size with bim_resize_run, bim_resize_stretch or bim_route_run.",
      inputSchema: { ...target, ...area, ...SUGGEST_DUCT_SIZE_ARGS.shape, system_kind: z.string().min(1).max(60).optional().describe("For a new system (supply_air, return_air, exhaust_air, …).") },
    },
    async (input, extra) => {
      const own = SUGGEST_DUCT_SIZE_ARGS.safeParse(input);
      if (!own.success) return { content: [{ type: "text" as const, text: `Those arguments don't fit bim_suggest_duct_size: ${own.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true };
      return helpers.read("bim_suggest_duct_size", extra, input, (s) => ductSizeAdvice(s.model(), own.data));
    },
  );

  for (const tool of BIM_FITTING_EDIT_TOOL_NAMES) {
    const schema: z.ZodObject<z.ZodRawShape> = FITTING_EDIT_ARGS[tool];
    const inputSchema: z.ZodRawShape = { ...target, ...area, ...baseRevision, ...schema.shape, ...(ADVERTISED_FITTING_ARGS[tool] ?? {}) };
    server.registerTool(tool, { title: DESCRIPTIONS[tool].title, description: DESCRIPTIONS[tool].description, inputSchema }, async (args: unknown, extra: unknown) => {
      const where = z.object({ project_id: z.string().uuid(), model_id: z.string().min(1).max(200), level: z.string().min(1).max(40).optional(), zone: z.string().min(1).max(40).optional(), base_revision: z.number().int().min(0).optional() }).safeParse(args);
      const own = schema.safeParse(args);
      if (!where.success || !own.success) {
        const issues = [...(where.success ? [] : where.error.issues), ...(own.success ? [] : own.error.issues)];
        return { content: [{ type: "text" as const, text: fittingArgsIssue(tool, issues) }], isError: true };
      }
      return helpers.edit(tool, extra, where.data, own.data, (model, key) => buildFittingCommand(tool, own.data, model, key));
    });
  }
}
