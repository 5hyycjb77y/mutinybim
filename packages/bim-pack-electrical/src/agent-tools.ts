/**
 * The agent tools the Electrical add-on declares (AGENT_TOOL_POINT) and the
 * model reads they run (PACK_READ_POINT). Data and pure model reads only: a
 * host adds `project_id` / `model_id` (and `base_revision` on edits), checks
 * the person's permission, loads the model, and sends edits through its edit
 * spine behind an approval. Names, titles, descriptions and argument schemas
 * are frozen (models and skills have used them since round 3).
 */
import { z } from "zod";
import type { AgentToolDescriptor, JsonSchemaObject } from "@permitzip/bim-pack/runtime";
// Wave 2 moves these out of the kernel into this package: switch to local imports then.
import { type ModelState } from "@permitzip/bim-kernel";
import { electricalCatalogEntrySchema } from "./catalog";
import { DENSITY_PRESETS, ROOM_RULES } from "./propose/types";
import { SERVICE_SYSTEMS } from "./connections/service-layout";
import { distributionEquipment, electricalConnections, isCircuitableLoad, memberName, panelSchedule } from "./connections/panel";
import { proposeLinksFromText } from "./connections/proposals";
import { NEC_EDITIONS } from "@permitzip/bim-calc";
import { LOAD_CLASSES } from "./calc/demand";
import { faultCurrentAt, faultCurrentSummary } from "./calc/fault-current";

/** A read an agent tool runs (`kernel.pack_read` v1). A refusal is `{ refused: "<plain words>" }`. */
export interface ElectricalPackRead {
  readonly id: string;
  readonly label: string;
  run(model: ModelState, input: unknown): unknown;
}

/** The JSON Schema of a tool's own arguments (the host adds where the model is). */
export function objectInput(shape: z.ZodRawShape): JsonSchemaObject {
  const { properties, required, additionalProperties } = z.toJSONSchema(z.object(shape));
  return { type: "object", properties: properties ?? {}, ...(required && required.length > 0 ? { required } : {}), ...(typeof additionalProperties === "boolean" ? { additionalProperties } : {}) };
}

export const OCCUPANCIES = ["other", "dwelling", "hospital", "hotel", "warehouse"] as const;

export const ELECTRICAL_CODE_ARGS = {
  nec_edition: z.enum(NEC_EDITIONS).optional().describe("Run the demand under this NEC edition instead of the project's adopted one."),
  state: z.string().trim().length(2).optional().describe("Two-letter state, used when neither nec_edition nor the project's Code Study names the edition."),
  occupancy: z.enum(OCCUPANCIES).default("other").describe("For the general lighting demand table. Default: all other occupancies (100%)."),
};

export const conductorArgs = z
  .object({
    sets: z.number().int().min(1).max(20).default(1),
    phase_size: z.string().trim().min(1).max(12).describe('As written on drawings: "12", "1/0", "250".'),
    neutral_size: z.string().trim().min(1).max(12).optional(),
    ground_size: z.string().trim().min(1).max(12).optional(),
    material: z.enum(["cu", "al"]).default("cu"),
  })
  .describe("Conductors chosen for this circuit or feeder (a voltage-drop upsize, parallel sets), instead of the default for the breaker.");

const memberArgs = z
  .array(
    z.object({
      element_id: z.string().min(1).max(200).describe("A device or piece of equipment (bim_query_elements), or a panel / transformer for a feeder."),
      connector: z.string().min(1).max(40).optional().describe("Its power connector, when it has more than one."),
    }),
  )
  .max(200);

const idArg = z.string().min(1).max(200);
const positionsArg = z.array(z.number().int().min(1).max(999)).max(12);

export const CIRCUIT_EDIT_TOOL_NAMES = ["bim_create_circuit", "bim_edit_circuit", "bim_add_to_circuit", "bim_remove_from_circuit", "bim_feed_panel"] as const;
export type CircuitEditToolName = (typeof CIRCUIT_EDIT_TOOL_NAMES)[number];
export const ELECTRICAL_DESIGN_EDIT_TOOL_NAMES = ["bim_rebalance_panel", "bim_save_electrical_type", "bim_apply_circuit_template"] as const;

/** Arguments of each circuit edit, shared by the edit tools and bim_preview_circuit_edit. */
export const CIRCUIT_EDIT_ARGS = {
  bim_create_circuit: {
    source_id: idArg.describe("The panel, switchboard or transformer it comes from (its id from bim_electrical_report)."),
    members: memberArgs.describe("What it serves. Empty makes a spare."),
    positions: positionsArg.optional(),
    description: z.string().trim().max(120).optional().describe('Shown in schedules ("Office 101 receptacles").'),
    breaker_a: z.number().positive().max(10_000).optional(),
    frame_a: z.number().positive().max(10_000).optional(),
    load_class: z.string().trim().min(1).max(40).optional().describe("Load class for every member, overriding theirs: lighting, receptacle, kitchen, motor, hvac, heating, cooling, other."),
    conductors: conductorArgs.optional(),
    length_ft: z.number().positive().max(100_000).optional(),
    feeder_type: z.string().trim().min(1).max(40).optional().describe('Feeder type mark ("F225").'),
    circuit_id: idArg.optional().describe("Id for the new circuit (from a proposal). Default: derived from the request."),
    one_circuit_each: z.boolean().optional().describe("Each member on a circuit of its own, breaker sized for its load; planned items too. members [] = every Not placed yet item waiting for a circuit (Circuit all)."),
  },
  bim_edit_circuit: {
    circuit_id: idArg.describe("From bim_electrical_report (circuits) or a feeder's feeder_id."),
    source_id: idArg.optional().describe("Move it to this panel."),
    positions: positionsArg.optional(),
    description: z.string().trim().max(120).optional(),
    breaker_a: z.number().positive().max(10_000).nullable().optional(),
    frame_a: z.number().positive().max(10_000).nullable().optional(),
    load_class: z.string().trim().min(1).max(40).nullable().optional(),
    conductors: conductorArgs.nullable().optional(),
    length_ft: z.number().positive().max(100_000).nullable().optional(),
    feeder_type: z.string().trim().min(1).max(40).nullable().optional(),
  },
  bim_add_to_circuit: { circuit_id: idArg, members: memberArgs.min(1) },
  bim_remove_from_circuit: { circuit_id: idArg, element_ids: z.array(idArg).min(1).max(200) },
  bim_feed_panel: {
    panel_id: idArg.describe("The panel or transformer to feed."),
    source_id: idArg.describe("What feeds it: a board or panel (a breaker in its positions) or a transformer (its secondary)."),
    positions: positionsArg.optional(),
    breaker_a: z.number().positive().max(10_000).optional().describe("Default: the fed panel's main, else its bus. A transformer has neither: give it."),
    feeder_type: z.string().trim().min(1).max(40).optional(),
  },
} as const satisfies Record<CircuitEditToolName, z.ZodRawShape>;

const panelArg = z.string().trim().min(1).max(200).describe('A panel\'s id or name ("L1").');

/** Arguments of the catalog edits and whole-panel actions, shared by the edit tools and bim_preview_circuit_edit. */
export const DESIGN_EDIT_ARGS = {
  bim_rebalance_panel: {
    panel: panelArg,
    keep_circuits: z.array(z.string().min(1).max(200)).max(200).optional().describe("Circuit ids to leave where they are."),
    max_moves: z.number().int().min(1).max(84).optional().describe("Move at most this many circuits (default 12)."),
  },
  bim_save_electrical_type: {
    entry: electricalCatalogEntrySchema.optional().describe(
      'The record to save. connection_type: { designator "E.05", description, connection, loadVa, voltage, poles, loadClass, continuous, motorHp?, comments }. feeder_type: { mark "F225", ratingA, poles, conductors { sets, phaseSize, neutralSize?, groundSize?, material cu|al }, insulation, conduit { type, tradeSize } | null, conduitBelowGrade, description }. circuit_template: { name, description, rules [{ room, devices receptacles|lighting|all, circuit?, description?, breakerA? }] }.',
    ),
    replaces: z.string().trim().min(1).max(80).optional().describe("The name it had, to rename it (what names the old one follows)."),
    delete: z.object({ type: z.enum(["connection_type", "feeder_type", "circuit_template"]), name: z.string().trim().min(1).max(80) }).optional().describe("Delete this record instead (refused while something uses it)."),
  },
  bim_apply_circuit_template: {
    template: z.string().trim().min(1).max(80).describe("The room template's name."),
    units: z
      .array(
        z.object({
          panel: panelArg.describe("The unit's panel, as the person names it."),
          rooms: z.array(z.string().trim().min(1).max(200)).min(1).max(60).describe("The unit's rooms: ids or room numbers, as the person chose them."),
          label: z.string().trim().max(60).optional(),
        }),
      )
      .min(1)
      .max(200),
  },
} as const satisfies Record<(typeof ELECTRICAL_DESIGN_EDIT_TOOL_NAMES)[number], z.ZodRawShape>;

export const PROPOSE_ARGS = {
  rooms: z.array(z.string().trim().min(1).max(200)).min(1).max(200).describe("Room ids or numbers the person picked."),
  mode: z.enum(["dwelling", "density"]).default("dwelling").describe("dwelling: NEC 210.52 (needs the NEC edition). density: open commercial areas, a firm preset (no code edition)."),
  preset: z.enum(DENSITY_PRESETS).optional().describe("density only: light ≈25, medium ≈15, heavy ≈6 ft apart (firm presets, not code)."),
  wall_type: z.string().trim().min(1).max(200).describe("Wall receptacle part type id (builtin:duplex-receptacle@1)."),
  countertop_type: z.string().trim().min(1).max(200).optional().describe("For counters (builtin:countertop-receptacle@1)."),
  bathroom_type: z.string().trim().min(1).max(200).optional().describe("For bathrooms (builtin:gfci-receptacle@1)."),
  room_rules: z.record(z.string(), z.enum(ROOM_RULES)).optional().describe("Per-room treatment override, by id or number."),
  nec_edition: z.enum(NEC_EDITIONS).optional().describe("dwelling only; density ignores it."),
  apply_to_similar: z.boolean().optional().describe("Also every room like each one listed (same name, area within 25%; a typical's copies once): one proposal, one edit."),
};

/** bim_service_from_equipment_list reads no model: it takes the project (for its Code Study) and the pasted list. */
export const EQUIPMENT_LIST_ARGS = {
  project_id: z.string().uuid(),
  text: z.string().min(1).max(200_000).describe("The equipment list: spreadsheet paste, CSV or PDF text."),
  voltage_v: z.number().positive().max(1000).describe("Service voltage (208, 480; 240 for 120/240 V)."),
  phases: z.union([z.literal(1), z.literal(3)]),
  classes: z.array(z.object({ line: z.number().int().min(1), class: z.enum(LOAD_CLASSES) }).strict()).max(2000).optional().describe("Classes the person confirmed, by each row's line (non-blank lines from 1, the header counted); others keep the suggestion. A line with no equipment row refuses."),
  occupancy: z.enum(["dwelling", "hospital", "hotel", "warehouse", "other"]).default("other"),
  spare_pct: z.number().min(0).max(100).default(0),
  nec_edition: z.enum(NEC_EDITIONS).optional(),
};

const layoutName = z.string().trim().min(1).max(40);

export const SERVICE_LAYOUT_ARGS = {
  level: z.string().trim().min(1).max(200).describe("Level id or name"),
  origin_ft: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional().describe("Left end of the lineup."),
  room: layoutName.optional().describe("Or a room (id, number, name): its south wall."),
  service_a: z.number().int().min(30).max(6000),
  system: z.enum(SERVICE_SYSTEMS),
  meter: z.boolean().default(true),
  main_disconnect: z.boolean().default(false).describe("Fused disconnect ahead of the MDP (then main lugs)."),
  plan_only: z.boolean().optional().describe("Nothing drawn: the gear and feeders exist (one-line, panel schedules) and wait in Not placed yet; level is where they will go."),
  distribution: z.object({ name: layoutName.default("MDP"), kind: z.enum(["switchboard", "panelboard"]).optional() }).strict().optional(),
  equipment: z
    .array(
      z
        .object({
          kind: z.enum(["panel", "transformer"]),
          name: layoutName,
          fed_from: layoutName,
          bus_a: z.number().int().min(30).max(6000).optional(),
          system: z.enum(SERVICE_SYSTEMS).optional(),
          mains: z.enum(["MLO", "MCB"]).optional(),
          kva: z.number().positive().max(5000).optional(),
          breaker_a: z.number().int().min(15).max(6000).optional().describe("Needed for a transformer on breakers."),
        })
        .strict(),
    )
    .max(40)
    .default([]),
};

/** Each tool's own arguments (no project_id / model_id / base_revision), the schema the host registers. */
export const ELECTRICAL_TOOL_ARGS = {
  bim_electrical_catalog: {
    kind: z.enum(["all", "connection_types", "feeder_types", "templates"]).default("all"),
    size_feeder_for: panelArg.optional(),
    length_ft: z.number().positive().max(10000).optional().describe("Feeder one-way length, for voltage drop."),
    material: z.enum(["copper", "aluminum"]).optional(),
    conduit: z.enum(["emt", "pvc40", "pvc80"]).optional(),
    check: z.boolean().optional(),
    nec_edition: z.enum(NEC_EDITIONS).optional(),
  },
  ...DESIGN_EDIT_ARGS,
  bim_propose_receptacles: PROPOSE_ARGS,
  bim_accept_receptacles: { ...PROPOSE_ARGS, keep: z.array(z.string().min(1).max(260)).min(1).max(500).optional().describe("Keys the person kept (default: all).") },
  bim_service_from_equipment_list: EQUIPMENT_LIST_ARGS,
  bim_place_service_layout: SERVICE_LAYOUT_ARGS,
  bim_electrical_report: {
    panel: z.string().trim().min(1).max(200).optional().describe("A panel's id or name (\"L1\"). Default: every piece of distribution equipment, sources first."),
    include_circuits: z.boolean().optional().describe("List circuits and members (default: only for one panel)."),
    ...ELECTRICAL_CODE_ARGS,
  },
  bim_propose_links_from_text: {},
  ...CIRCUIT_EDIT_ARGS,
  bim_preview_circuit_edit: { tool: z.enum([...CIRCUIT_EDIT_TOOL_NAMES, ...ELECTRICAL_DESIGN_EDIT_TOOL_NAMES]), args: z.record(z.string(), z.unknown()).describe("That tool's arguments, without project_id / model_id / base_revision.") },
  bim_read_panel: { panel: z.string().trim().min(1).max(200).optional().describe('Panel id or name ("L1").') },
} as const satisfies Record<string, z.ZodRawShape>;

export type ElectricalToolName = keyof typeof ELECTRICAL_TOOL_ARGS;

const COPY: Record<ElectricalToolName, { readonly title: string; readonly description: string }> = {
  bim_electrical_catalog: {
    title: "Connection types, feeder types, room templates, check list",
    description:
      "The project's connection types (designator → load, voltage, poles, class), feeder types (mark → breaker, conductor sets, ground, conduit) and room templates. size_feeder_for: propose a feeder type for that panel from its NEC calculated load (breaker, conductors with voltage drop, parallel sets, EGC, conduit, with clauses) to save with bim_save_electrical_type. check: the Electrical tab's check list (overloads, unbalance, voltage mismatch, breakers vs nameplate, loads on no circuit). Read-only.",
  },
  bim_rebalance_panel: {
    title: "Rebalance a panel's phases",
    description:
      "Move or swap circuits on one panel so its phases carry more even load (deterministic: the same model gives the same moves; three-pole breakers and keep_circuits stay; what is on each circuit never changes). Preview the moves with bim_preview_circuit_edit first and show them. Pauses for approval.",
  },
  bim_save_electrical_type: {
    title: "Save a connection type, feeder type or room template",
    description:
      "Add or change one catalog record; replaces renames it and what names it follows (devices' connection_type, feeders' feeder type). delete removes one nothing uses. Devices take a connection type through bim_set_parameters values.connection_type. Pauses for approval.",
  },
  bim_apply_circuit_template: {
    title: "Apply a room template to units",
    description:
      "Circuit the devices in each unit's rooms by the firm's room template (bedroom → 1…). The person names each unit's rooms and panel; never choose a panel or rooms yourself. Devices already on a circuit are left alone; a refused circuit is reported, the rest are made. Preview with bim_preview_circuit_edit. Pauses for approval.",
  },
  bim_propose_receptacles: {
    title: "Propose receptacles (NEC 210.52 or density)",
    description:
      "Where receptacles of the chosen type would go in the picked rooms: 210.52 wall space, countertops, islands, bathrooms, laundry, hallways (needs the NEC edition), or a density preset (firm spacing, no code edition; code says so). Wall devices sit with their back on the wall face. Each device has a key, reason and clause; coverage says if every point is in reach. Read-only; accept with bim_accept_receptacles.",
  },
  bim_accept_receptacles: { title: "Place the receptacles the person kept", description: "Re-runs the proposal at the revision you read and places the kept devices as one edit, uncircuited. Send the proposal's arguments. Pauses for approval." },
  bim_service_from_equipment_list: {
    title: "Early service size from an equipment list",
    description:
      "Reads an equipment schedule (paste, CSV or PDF text) into rows (line = non-blank line, header counted) with VA and a suggested NEC load class, then sizes the service by Article 220 with the trail: required_a is the minimum ampacity (noncontinuous + 125% of continuous; lighting and fixed space heating are continuous), service is the next standard rating at or above it. Show the suggestions; send the person's corrections in classes. Read-only.",
  },
  bim_place_service_layout: {
    title: "Place a starter service layout",
    description:
      "From a service size (yours or bim_service_from_equipment_list's): meter, optional main disconnect, MDP and the listed panels and transformers, each fed from what's named, as one edit. Ask for every rating; nothing is sized. Pauses for approval.",
  },
  bim_electrical_report: {
    title: "Panel totals, true capacity and findings",
    description:
      "Every panel, switchboard and transformer (or one, by id or name) with what it supplies and is fed from: connected load, NEC Article 220 demand by load class from the raw loads below it (220.56 kitchen equipment counted at each panel, so the MDP and the serving panel differ), the sizing load with continuous loads at 125% and the largest motor +25%, per-phase VA and amps, the true capacity with its limiting reason (bus, main, transformer kVA, feeding breaker, feeder conductors, what is left upstream), and findings (overloaded, unbalanced phases, a member whose voltage no longer matches, a bus bigger than its breaker, a load with nothing to count). One panel also lists its circuits and their members. The NEC edition is nec_edition, else the project's Code Study, else the state; with none of those the totals are connected loads only and say so. Read-only; no approval.",
  },
  bim_propose_links_from_text: {
    title: "Propose circuits from typed circuit numbers",
    description:
      'Read the circuit numbers people typed on devices ("L1-3", "HP1-43,45") and the "Fed from" typed on panels ("MDP"), and return, for each circuit or feeder, what would be made, whether the model allows it (with the reason when not), and the exact arguments for bim_create_circuit or bim_add_to_circuit. Devices are grouped only when their own text names the same panel and circuit numbers. Nothing is changed: show the person the proposals and make only the ones they confirm, one approval each. Read-only; no approval.',
  },
  bim_create_circuit: {
    title: "Make a circuit or feeder",
    description:
      "Serve the listed devices or equipment from a panel's breaker (a branch circuit), or another panel or transformer from a breaker in this one (a feeder; a transformer's secondary feeds its panel with no breaker). Members are exactly what the person asked for. Positions are the panel's circuit numbers (one per pole: 1,3,5 for three poles); leave them out to take the lowest free ones that fit. The breaker defaults to one piece of equipment's MOCP, else 20 A; a feeder's to the fed panel's main, else its bus. Refused in plain words when voltage, poles, phases or free positions don't allow it (e.g. a 480 V unit on a 120/208 V panel): say the reason as written. A retried identical call is refused as already made. Pauses for the person's approval.",
  },
  bim_edit_circuit: {
    title: "Change a circuit or feeder",
    description:
      "Move a circuit or feeder to other positions or another panel (its members are checked again), or change its breaker, frame, load class, conductors, length, feeder type or description. null clears a value. Members don't change here (bim_add_to_circuit, bim_remove_from_circuit). An existing circuit on a renovation (built in the Existing phase: bim_set_element_phases on its id) keeps its panel and slots. Refused in plain words when the move isn't allowed. Pauses for the person's approval.",
  },
  bim_add_to_circuit: { title: "Add devices to a circuit", description: "Put the listed devices or equipment on an existing circuit (exactly those). Each is checked against the panel's voltage and the circuit's poles; refused in plain words otherwise, and a device already on a circuit is refused. Pauses for the person's approval." },
  bim_remove_from_circuit: { title: "Take devices off a circuit", description: "Take the listed devices or equipment off a circuit. The circuit stays, even empty (a spare); delete it with bim_delete_elements. Pauses for the person's approval." },
  bim_feed_panel: {
    title: "Feed a panel or transformer",
    description:
      "Feed a panel or transformer from a breaker in another board or panel, or from a transformer's secondary; a feeder it already has moves instead of a second one being made. Refused in plain words on a mismatch (a 120/208 V panel off a 480 V board needs a transformer between; never add one yourself, ask). Pauses for the person's approval.",
  },
  bim_preview_circuit_edit: {
    title: "Preview a circuit edit",
    description: "Dry run of a circuit, rebalance, catalog or room-template edit tool at the revision you read: what it changes (a rebalance's moves, a template's circuits per unit), or the plain reason it would be refused. Saves nothing; no approval.",
  },
  bim_read_panel: {
    title: "Read a panel's slots",
    description: "One panel as the Building Model's panel view draws it: every used slot with its circuit, breaker, poles and members, the free slots, and what feeds it. No panel: the devices on no circuit yet. Totals and capacity are in bim_electrical_report. Read-only.",
  },
};

/**
 * The command each edit sends. The host builds it from the model (sizes,
 * slots, plans), so these are what the edit is, not a field-for-field map of
 * its input.
 */
const COMMAND_OF: Partial<Record<ElectricalToolName, string>> = {
  bim_create_circuit: "create_service_link",
  bim_edit_circuit: "edit_service_link",
  bim_add_to_circuit: "add_link_members",
  bim_remove_from_circuit: "remove_link_members",
  bim_feed_panel: "create_service_link",
  bim_rebalance_panel: "reposition_service_links",
  bim_save_electrical_type: "save_catalog_entry",
  bim_apply_circuit_template: "batch_service_links",
  bim_accept_receptacles: "place_devices",
  bim_place_service_layout: "place_service_layout",
};

/** By the host file that serves them (packages/bim-mcp-packs/src/trades/electrical*.ts, service-layout.ts), in registration order. */
export const ELECTRICAL_TOOL_GROUPS = {
  design: ["bim_electrical_catalog", ...ELECTRICAL_DESIGN_EDIT_TOOL_NAMES],
  propose: ["bim_propose_receptacles", "bim_accept_receptacles", "bim_service_from_equipment_list"],
  serviceLayout: ["bim_place_service_layout"],
  circuits: ["bim_electrical_report", "bim_propose_links_from_text", ...CIRCUIT_EDIT_TOOL_NAMES, "bim_preview_circuit_edit", "bim_read_panel"],
} as const satisfies Record<string, readonly ElectricalToolName[]>;

const ORDER: readonly ElectricalToolName[] = [...ELECTRICAL_TOOL_GROUPS.design, ...ELECTRICAL_TOOL_GROUPS.serviceLayout, ...ELECTRICAL_TOOL_GROUPS.propose, ...ELECTRICAL_TOOL_GROUPS.circuits];

export const ELECTRICAL_AGENT_TOOLS: readonly AgentToolDescriptor[] = ORDER.map((name): AgentToolDescriptor => {
  const command = COMMAND_OF[name];
  return { name, ...COPY[name], input: objectInput(ELECTRICAL_TOOL_ARGS[name]), permission: command ? "write" : "read", target: command ? { kind: "command", command } : { kind: "read", read: name } };
});

export function faultCurrentOut(model: ModelState, partId: string) {
  const node = faultCurrentAt(model.elements, partId);
  return node ? { fault_current: { says: faultCurrentSummary(node), available_a: node.availableA, rating_a: node.ratingA, passes: node.passes, trail: node.trail } } : {};
}

const memberCall = (m: { elementId: string; connector?: string }) => ({ element_id: m.elementId, ...(m.connector ? { connector: m.connector } : {}) });

/** bim_propose_links_from_text: what typed circuit numbers would make, and the call that makes each. */
export function proposeLinksRead(model: ModelState) {
  const proposals = proposeLinksFromText(model).map((p) => {
    const c = p.command;
    const call =
      c?.type === "create_service_link"
        ? { tool: "bim_create_circuit", arguments: { circuit_id: c.linkId, source_id: c.sourceId, ...(c.positions ? { positions: c.positions } : {}), members: c.members.map(memberCall) } }
        : c?.type === "add_link_members"
          ? { tool: "bim_add_to_circuit", arguments: { circuit_id: c.linkId, members: c.members.map(memberCall) } }
          : null;
    return { proposal: p.id, role: p.role, status: p.status, says: p.reason, source: p.sourceName, positions: p.positions, members: p.members.map((m) => ({ element_id: m.elementId, name: m.name, text: m.text })), ...(call ? { to_make_it: call } : {}) };
  });
  return { revision: model.revision, ready: proposals.filter((p) => p.status === "ready").length, proposals };
}

/** Built once: building a zod object schema costs about a hundred times what parsing with it does. */
const READ_PANEL_ARGS = z.object(ELECTRICAL_TOOL_ARGS.bim_read_panel);

/** bim_read_panel: one panel's slots, or the devices on no circuit yet. */
export function readPanel(model: ModelState, input: unknown) {
  const args = READ_PANEL_ARGS.parse(input);
  const els = model.elements;
  if (!args.panel) {
    const open = Object.values(els).flatMap((el) => (el.kind === "part" && isCircuitableLoad(els, el) && electricalConnections(els, el.id).every((c) => c.circuit === null) ? [{ id: el.id, name: memberName(els, el) }] : []));
    return { revision: model.revision, uncircuited_devices: { count: open.length, first: open.slice(0, 100) } };
  }
  const key = args.panel.toLowerCase();
  const hit = distributionEquipment(els).find((d) => d.id === args.panel || d.name.toLowerCase() === key);
  const sched = hit ? panelSchedule(els, hit.id) : null;
  if (!sched) return { refused: `No panel "${args.panel}". Distribution equipment here: ${distributionEquipment(els).map((d) => d.name).join(", ") || "none yet"}.` };
  return {
    revision: model.revision,
    id: sched.id,
    name: sched.name,
    system: sched.system,
    spaces: sched.spaces,
    free_slots: sched.freeSlots,
    supply_from: sched.fedBy ? { source: sched.fedBy.sourceName, feeder_id: sched.fedBy.linkId, positions: sched.fedBy.positions, breaker_a: sched.fedBy.ratingA } : null,
    circuits: sched.circuits.map((c) => ({ circuit_id: c.linkId, name: c.name, role: c.role, slots: c.positions, phases: c.phases, breaker_a: c.ratingA, poles: c.poles, description: c.description, ...(c.existing ? { existing: `existing (${c.existing.phase}): stays on its panel and slots` } : {}), ...(c.typicalCount ? { typical_count: c.typicalCount } : {}), ...(c.feeds ? { feeds: c.feeds.name } : { members: c.members.map((m) => ({ element_id: m.elementId, name: m.name })) }) })),
    ...faultCurrentOut(model, sched.id),
  };
}

export const ELECTRICAL_PACK_READS: readonly ElectricalPackRead[] = [
  { id: "bim_propose_links_from_text", label: "Circuits proposed from typed circuit numbers", run: (model) => proposeLinksRead(model) },
  { id: "bim_read_panel", label: "A panel's slots", run: readPanel },
];
