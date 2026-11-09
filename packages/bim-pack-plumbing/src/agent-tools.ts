/**
 * The agent tools the Plumbing and gas add-on declares (AGENT_TOOL_POINT)
 * and the model reads they run (PACK_READ_POINT). Data and pure model reads
 * only: a host adds `project_id` / `model_id` (and `base_revision` on
 * edits), checks permission, loads the model, and sends edits through its
 * edit spine behind an approval. Names, titles, descriptions and argument
 * schemas are frozen.
 */
import { z } from "zod";
import { IFGC_EDITIONS, IPC_EDITIONS } from "@permitzip/bim-calc";
import type { AgentToolDescriptor, JsonSchemaObject } from "@permitzip/bim-pack/runtime";
import {
  FITTING_SLOTS,
  PIPE_MATERIALS,
  PIPE_SIZING_MODES,
  PIPE_SPEC_IDS,
  SYSTEM_KINDS,
  SYSTEM_LINE_PATTERNS,
  SYSTEM_LINE_WEIGHTS,
  elementsOfKind,
  systemStyle,
  type ModelState,
} from "@permitzip/bim-kernel";
import { pipeTypeFittings, pipeTypeMismatch, pipeTypeSummary } from "./routing/pipe/pipe-types";
import { PLUMBING_BUILDING_TYPES, PLUMBING_DEMAND_CURVES } from "./routing/pipe/plumbing-settings";
import { stacksOf } from "./plumbing/stacks";
import { projectPipeTypes, projectPlumbingSettings } from "./routing/pipe/plumbing-catalog";

/** A read an agent tool runs (`kernel.pack_read` v1). A refusal is `{ refused: "<plain words>" }`. */
export interface PlumbingPackRead {
  readonly id: string;
  readonly label: string;
  run(model: ModelState, input: unknown): unknown;
}

function objectInput(shape: z.ZodRawShape): JsonSchemaObject {
  const { properties, required, additionalProperties } = z.toJSONSchema(z.object(shape));
  return { type: "object", properties: properties ?? {}, ...(required && required.length > 0 ? { required } : {}), ...(typeof additionalProperties === "boolean" ? { additionalProperties } : {}) };
}

const nullable = <T extends z.ZodType>(t: T) => t.nullable().optional();

/** Each tool's own arguments (no project_id / model_id / base_revision), the schema the host registers. */
export const PLUMBING_TOOL_ARGS = {
  bim_plumbing_catalog: {},
  bim_plumbing_design: {
    action: z.enum(["system_look", "system_sizing", "project", "save_pipe_type", "delete_pipe_type"]),
    system: z.string().trim().min(1).max(200).optional().describe("system_look / system_sizing: the system's id or name."),
    colour: nullable(z.string().trim().regex(/^#[0-9a-fA-F]{6}$/)).describe("#rrggbb; null: the kind's standard."),
    pattern: nullable(z.enum(SYSTEM_LINE_PATTERNS)),
    weight: nullable(z.enum(SYSTEM_LINE_WEIGHTS)),
    sizing_mode: nullable(z.enum(PIPE_SIZING_MODES)).describe("check: audit and suggest (default). auto: apply sizes. system_sizing null: the project's."),
    demand_curve: nullable(z.enum(PLUMBING_DEMAND_CURVES)).describe("null: the building type's (project) or the project's (system)."),
    building_type: nullable(z.enum(PLUMBING_BUILDING_TYPES)).describe("project only."),
    insulation_schedule: nullable(
      z
        .array(z.object({ system_kinds: z.array(z.enum(SYSTEM_KINDS)).min(1).max(SYSTEM_KINDS.length), below_in: z.number().positive().max(48), thickness_in: z.number().min(0).max(6), material: z.string().trim().min(1).max(60).optional() }))
        .max(80),
    ).describe("project only: pipe insulation by system kind and size band (pipes below below_in take thickness_in; 0 none). The energy code's table isn't in the code library: use the firm's spec. null clears it."),
    insulation_source: nullable(z.string().trim().min(1).max(200)).describe("project only: where the schedule's values come from."),
    pipe_type: z
      .object({
        name: z.string().trim().min(1).max(40),
        material: z.enum(PIPE_MATERIALS),
        description: z.string().trim().max(160).optional(),
        spec: z.enum(PIPE_SPEC_IDS).optional(),
        system_kinds: z.array(z.enum(SYSTEM_KINDS)).max(SYSTEM_KINDS.length).optional(),
        min_in: z.number().positive().max(48).optional(),
        max_in: z.number().positive().max(48).optional(),
        joint: z.string().trim().max(24).optional(),
        fittings: z.partialRecord(z.enum(FITTING_SLOTS), z.string().trim().min(1).max(80)).optional().describe("Slot → fitting id over the material's choice (bim_list_fitting_types)."),
        note: z.string().trim().max(200).optional(),
      })
      .optional(),
    replaces: z.string().trim().min(1).max(40).optional().describe("save_pipe_type: the name it had."),
    name: z.string().trim().min(1).max(40).optional().describe("delete_pipe_type."),
  },
  bim_size_pipes: {
    system_id: z.string().min(1).max(200).describe("A gas, water, sanitary, vent or storm system (bim_model_summary routedSystems)."),
    allow_smaller: z.boolean().default(false).describe("Also reduce pipe drawn larger than needed; default fixes undersized pipe only."),
    method: z.enum(["longest_length", "branch_length"]).optional().describe("Default: the system's."),
    // The same fields as every calc tool's code editions (packages/bim-mcp-packs/src/calc/code-editions.ts).
    fuel_gas_edition: z.enum(IFGC_EDITIONS).optional().describe("Fuel gas code (IFGC family) when Code Study names none."),
    plumbing_edition: z.enum(IPC_EDITIONS).optional().describe("Plumbing code (IPC family) when Code Study names none."),
    state: z.string().trim().length(2).optional().describe("Two-letter state, used when neither an edition nor the project's Code Study names the code."),
  },
} as const satisfies Record<string, z.ZodRawShape>;

export type PlumbingToolName = keyof typeof PLUMBING_TOOL_ARGS;

/** By the host file that serves them (packages/bim-mcp-packs/src/trades/plumbing-design.ts, calc/pipe-sizing.ts). */
export const PLUMBING_TOOL_GROUPS = {
  design: ["bim_plumbing_catalog", "bim_plumbing_design"],
  sizing: ["bim_size_pipes"],
} as const satisfies Record<string, readonly PlumbingToolName[]>;

export const PLUMBING_AGENT_TOOLS: readonly AgentToolDescriptor[] = [
  {
    name: "bim_plumbing_catalog",
    title: "Pipe types, pipe systems' looks and sizing",
    description:
      "Pipe types (material, spec, sizes, joint, systems, the fittings each slot takes: the material's unless picked), every pipe system's colour, line pattern, weight and own sizing, the project's auto-sizing, building type, demand curve and pipe insulation schedule, and the stacks (named or not: tag, size and DFU per floor, offsets). Read-only.",
    input: objectInput(PLUMBING_TOOL_ARGS.bim_plumbing_catalog),
    permission: "read",
    target: { kind: "read", read: "bim_plumbing_catalog" },
  },
  {
    name: "bim_plumbing_design",
    title: "Set a pipe system's look or sizing, the project's sizing, or a pipe type",
    description:
      "One change. system_look: colour/pattern/weight (null: standard). system_sizing / project: sizing_mode, demand_curve (project also building_type, insulation_schedule). save_pipe_type / delete_pipe_type. Turn auto-sizing on only when the person asks: on, edits resize that system's pipes as they land. Pauses for approval.",
    input: objectInput(PLUMBING_TOOL_ARGS.bim_plumbing_design),
    permission: "write",
    // Picks set_system_graphics, set_system_design, save_catalog_entry or delete_catalog_entry by action; the host builds it.
    target: { kind: "command", command: "set_system_design" },
  },
  {
    name: "bim_size_pipes",
    title: "Size a pipe system's pipes",
    description:
      "Apply the sizes the system's calc proposes, recomputed at this revision, as one edit; reducers go where sizes change. Gas: plumbing.gas_system (zones, fuel gas tables). Water, sanitary, vent, storm: plumbing.size_system (demand curve; DFU tables; 906; roof area at the system's rainfall rate). Run the calc first and show the person the changes.",
    input: objectInput(PLUMBING_TOOL_ARGS.bim_size_pipes),
    permission: "write",
    target: { kind: "command", command: "set_pipe_sizes" },
  },
];

const STACK_ROWS = 60;

function stackRows(stacks: ReturnType<typeof stacksOf>["stacks"]) {
  return stacks.slice(0, STACK_ROWS).map((s) => ({
    ...(s.record ? { stack_id: s.record.id } : {}),
    number: s.number ?? "not named yet",
    ...(s.name ? { name: s.name } : {}),
    tag: s.tag,
    system: s.systemName,
    pipe_id: s.key,
    size_in: s.sizeIn,
    ...(s.dfuAtBase !== null ? { dfu_at_base: s.dfuAtBase } : {}),
    serves: s.rooms,
    floors: s.floors.map((f) => ({ level: f.levelName, size_in: f.sizeIn, ...(f.dfu !== null ? { dfu: f.dfu } : {}), ...(f.offsets.length > 0 ? { offsets: f.offsets.map((o) => o.text) } : {}) })),
  }));
}

/** What `stacksRead` adds to the plumbing read; empty when the model has no stacks. */
export interface StacksRead {
  readonly stacks?: ReturnType<typeof stackRows>;
  readonly stacks_truncated?: number;
  readonly stacks_lost?: ReadonlyArray<ReturnType<typeof stacksOf>["lost"][number]["reason"]>;
}

/** Stacks as the Plumbing tab lists them (r4-plumbing P5): each named stack by number, then drawn runs tall enough to be one. */
export function stacksRead(model: Pick<ModelState, "elements">): StacksRead {
  const { stacks, lost } = stacksOf(model.elements);
  if (stacks.length === 0 && lost.length === 0) return {};
  return {
    stacks: stackRows(stacks),
    ...(stacks.length > STACK_ROWS ? { stacks_truncated: stacks.length - STACK_ROWS } : {}),
    ...(lost.length > 0 ? { stacks_lost: lost.map((l) => l.reason) } : {}),
  };
}

/** What bim_plumbing_catalog returns: every pipe type with its fittings, every pipe system's look and sizing, the project's settings. */
export function plumbingCatalog(model: ModelState) {
  const project = projectPlumbingSettings(model.elements);
  return {
    revision: model.revision,
    project: {
      sizing_mode: project.sizingMode,
      building_type: project.buildingType ?? null,
      demand_curve: project.demandCurve ?? null,
      insulation_schedule: (project.pipeInsulation ?? []).map((r) => ({ system_kinds: r.systemKinds, below_in: r.belowNominalIn, thickness_in: r.thicknessIn, ...(r.material ? { material: r.material } : {}) })),
      insulation_source: project.pipeInsulationSource ?? null,
    },
    systems: elementsOfKind(model.elements, "mep_system")
      .filter((s) => s.domain === "pipe")
      .map((s) => {
        const style = systemStyle(s);
        return { id: s.id, name: s.name, kind: s.systemKind, colour: style.colour, pattern: style.pattern, weight: style.weight ?? "standard", own_look: style.overridden, sizing_mode: s.design?.pipe?.sizingMode ?? null, demand_curve: s.design?.pipe?.demandCurve ?? null };
      }),
    pipe_types: projectPipeTypes(model).map((r) => {
      const kind = r.entry.systemKinds[0] ?? SYSTEM_KINDS.find((k) => pipeTypeMismatch(r.entry, k) === null);
      return {
        ...r.entry,
        from: r.saved ? "project" : "firm",
        summary: pipeTypeSummary(r.entry),
        ...(kind ? { fittings_on: kind, fittings: pipeTypeFittings(r.entry, kind).map((f) => ({ where: f.label, fitting: f.familyId, picked: f.picked })) } : {}),
      };
    }),
  };
}

export const PLUMBING_PACK_READS: readonly PlumbingPackRead[] = [{ id: "bim_plumbing_catalog", label: "Pipe types, pipe systems' looks and sizing", run: (model) => ({ ...plumbingCatalog(model), ...stacksRead(model) }) }];

/**
 * The pipe systems' command families a host tool advertises in short form
 * (bim_set_system_design pipe_design), read in full with
 * bim_describe_commands: their words, from this add-on (round 10).
 */
export const PIPE_COMMAND_FAMILY_COPY: ReadonlyArray<{ readonly tool: string; readonly field: string; readonly label: string }> = [
  { tool: "bim_set_system_design", field: "pipe_design", label: "A pipe system's design inputs (water, drainage or gas), merged field by field." },
];
