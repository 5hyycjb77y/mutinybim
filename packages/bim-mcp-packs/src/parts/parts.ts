import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveLevelRef } from "@permitzip/bim-mcp";
import { ARCHITECTURE_SHORT_FORM, architectureCommand } from "./architecture";
import { z } from "zod";
import {
  INTAKE_KINDS,
  PART_CATEGORIES,
  PART_MOUNTS,
  builtinPartType,
  definitionTypes,
  elementValues,
  partDefinition,
  partDefinitionFieldsSchema,
  partGroupName,
  partTypeIssues,
  ELEMENT_CORE_KINDS,
  KNOWN_LOCK_STATES,
  commandIssueMessage,
  commandSchema,
  activeClassRegistry,
  withPackParameters,
  type BimElement,
  type ModelState,
  type Registry,
  type ParamValue,
  type PartTypeDefinition,
} from "@permitzip/bim-kernel";
import { listLevels, listPartTypes, type AgentSession } from "@permitzip/bim-sync";
import { editIdempotencyKey } from "../runtime";
import { ADVERTISED_PART_DEFINITION, registerBimPartEditorTools } from "./part-editor";
import { BIM_PART_EDIT_TOOL_NAMES, type BimPartEditToolName } from "../support/tool-names";
import type { FirmPartEntry, FirmPartsSource } from "./capabilities";
import type { NecEdition } from "@permitzip/bim-calc";
import { checkDraft, plannedEquipmentBatch, proposedLoads, readDraft } from "@permitzip/bim-editor/editor/equipment-list/plan-equipment";
import { elementValuesIn, partValuesIn, quantityInput } from "./vocabulary";
import { withPinnedPacks } from "@permitzip/bim-editor/contracts/building-model/installed-packs";

/**
 * Part tools: place, move, rotate, copy, delete and set parameters on ANY
 * part (equipment, air terminals, devices, fixtures…), and add levels. They
 * build the same kernel commands the browser sends and go through the same
 * authority path as every other edit (the caller runtime): the person's own login,
 * their agent identity, the base revision they read, one idempotency key per
 * call. bim_preview_part_edit runs the same command without sending it.
 */

const MM_PER_FT = 304.8;
const ft = (v: number) => v * MM_PER_FT;

const idList = z.array(z.string().min(1).max(200)).min(1).max(200);
const mountArg = z.enum(["as_drawn", ...PART_MOUNTS]).describe("turned_over: neck down (floor register); on_side: faces rotation_deg (sidewall register).");
const intakesArg = z.record(z.string(), z.enum([...INTAKE_KINDS, "none"])).describe("Hood / louver / screen per outdoor-air connector id; none removes the type's.");
const paramValues = z
  .record(z.string().min(1).max(54), z.union([z.number(), z.string().max(400), z.boolean(), quantityInput]))
  .describe("Parameter values by name or param.<name> (bim_list_part_types). A bare length is feet, other numbers the unit listed; {value, unit} takes any unit of that kind.");

/** Edit-specific arguments of each tool (project, model, area and base revision are shared). */
export const PART_EDIT_ARGS = {
  bim_place_part: z.object({
    type_id: z.string().min(1).max(200).optional().describe("A type id from bim_list_part_types (the model's own or the starter library), or from bim_list_firm_parts with from_firm_library."),
    part_id: z.string().min(1).max(200).optional().describe("Instead of type_id: an existing part. Planned: draws it at level_id/x_ft/y_ft, keeping id, circuits and values. With unplace: takes a placed one off the drawing."),
    unplace: z.literal(true).optional(),
    from_firm_library: z.boolean().optional().describe("true: type_id is a size from the firm library (bim_list_firm_parts); the part's definition is added to this model with it."),
    level_id: z.string().min(1).max(200).optional().describe("Level id, or its name when unique (bim_list_levels). Leave out level_id, x_ft and y_ft to plan the part (Not placed yet)."),
    x_ft: z.number().min(-100_000).max(100_000).optional(),
    y_ft: z.number().min(-100_000).max(100_000).optional(),
    level_hint: z.string().min(1).max(200).optional().describe("Planned: the level it will probably go on."),
    space_hint: z.string().min(1).max(200).optional().describe("Planned: the space id it serves."),
    note: z.string().trim().min(1).max(200).optional(),
    height_above_level_ft: z.number().min(-300).max(300).optional().describe("Insertion height above the level (ceiling devices: the ceiling height)."),
    rotation_deg: z.number().min(-360).max(360).optional(),
    mark: z.string().max(40).optional(),
    values: paramValues.optional(),
    mount: mountArg.optional(),
    on_plane_id: z.string().optional().describe("Mounting plane id (bim_list_levels): at its height, instead of height_above_level_ft."),
    intakes: intakesArg.optional(),
    discipline: z.string().min(1).max(96).optional().describe("New part: a registered discipline id to file it under (e.g. an add-on's); default: its category's."),
    equipment_list: z.string().trim().min(1).max(30_000).optional().describe("Instead of type_id: a pasted vendor or mechanical schedule (tabs, CSV or PDF text, header row first). Every row becomes planned equipment with its load, gas and water values, plus the plumbing and gas loads it proposes, as Equipment list › Add does. Send it alone: each row brings its own mark, type and values, so add no type_id, part_id, level, location, mark, values or note (those are refused)."),
  }),
  bim_move_elements: z.object({
    element_ids: idList,
    dx_ft: z.number().min(-1000).max(1000),
    dy_ft: z.number().min(-1000).max(1000),
    dz_ft: z.number().min(-300).max(300).optional().describe("Parts only: raise (+) or lower (−) relative to their level."),
  }),
  bim_rotate_elements: z.object({
    element_ids: idList,
    angle_deg: z.number().min(-360).max(360).describe("Counter-clockwise, seen from above."),
    about_x_ft: z.number().optional(),
    about_y_ft: z.number().optional(),
  }),
  bim_copy_elements: z.object({ element_ids: idList, dx_ft: z.number().min(-1000).max(1000), dy_ft: z.number().min(-1000).max(1000) }),
  bim_delete_elements: z.object({
    element_ids: idList,
    if_dependents: z
      .enum(["refuse", "disconnect", "cascade"])
      .optional()
      .describe("refuse (default): delete nothing and list what depends on it. disconnect: cut connections (run ends are left open), keep other dependents refusing. cascade: delete tags, hosted parts, a trunk's branches and a type's, level's or system's parts and runs too, and cap run ends left open. The result's summary says which happened."),
  }),
  bim_set_parameters: z.object({
    element_id: z.string().min(1).max(200),
    scope: z.enum(["instance", "type"]).describe("instance: this part only. type: the part type, shared by every part of that type."),
    values: z.record(z.string().min(1).max(54), z.union([z.number(), z.string().max(400), z.boolean(), z.null(), quantityInput])).optional().describe("As bim_place_part's values; null clears a value back to the type's."),
    mark: z.string().max(40).optional(),
    mount: z.enum(["as_drawn", ...PART_MOUNTS]).optional().describe("Instance: as bim_place_part; disconnect its runs first."),
    intakes: z.record(z.string(), z.union([z.enum([...INTAKE_KINDS, "none"]), z.null()])).optional().describe("Instance: as bim_place_part; null = the type's."),
  }),
  bim_create_level: z.object({ name: z.string().min(1).max(40), elevation_ft: z.number().min(-3000).max(3000) }),
  bim_save_part_definition: z.object({
    part_name: z.string().trim().min(1).max(200).describe('What the part is called in the library, e.g. "Rooftop unit on curb". Each row of the types table becomes a size of it.'),
    definition: partDefinitionFieldsSchema.describe(
      "The part definition: parameters, connectors, symbol, tag fields, source and model (reference planes, sketches, features, types table). Lengths in MILLIMETRES (formulas accept 12in or 2ft). Get the shape from bim_part_definition_example and check it with bim_check_part_definition first.",
    ),
  }),
  bim_set_element: z.object({
    element_ids: idList.optional(),
    class: z.string().max(96).nullable().optional().describe("A class id (bim_schedule_fields); null clears it."),
    type_id: z.string().max(200).nullable().optional().describe("An element type; null clears it."),
    values: z
      .record(z.string().max(96), z.union([z.number(), z.string().max(400), z.boolean(), z.null(), quantityInput]))
      .optional()
      .describe("By parameter key; {value, unit} converts to the parameter's unit; null removes."),
    place: z
      .object({ kind: z.enum(["point", "line", "path", "area"]), level: z.string().max(200), points_ft: z.array(z.object({ x: z.number(), y: z.number() })).min(1).max(2000), z_ft: z.number().optional(), rotation_deg: z.number().optional() })
      .nullable()
      .optional()
      .describe("Plan feet: point 1, line 2, path 2+, area 3+ points; z_ft above the level; null clears."),
    lock: z.union([z.object({ state: z.enum(KNOWN_LOCK_STATES), reason: z.string().trim().min(1).max(300) }), z.literal(false)]).optional().describe("false unlocks."),
    new_type: z
      .object({ name: z.string().trim().min(1).max(120), class: z.string().max(96).optional(), for_kinds: z.array(z.enum(ELEMENT_CORE_KINDS)).min(1).max(8).optional() })
      .optional()
      .describe("Make a shared type (no element_ids)."),
    code: z
      .object({ id: z.string(), value: z.union([z.number(), z.string()]).optional(), reason: z.string(), withdraw: z.boolean().optional() })
      .optional()
      .describe("Requirement id (value overrides, withdraw) or decision key+value on element_ids[0]."),
    architecture: ARCHITECTURE_SHORT_FORM,
  }),
  bim_set_mounting_plane: z.object({
    plane_id: z.string().optional().describe("Change this plane; omit to make one (needs level_id, name, height, corners)."),
    level_id: z.string().optional(),
    name: z.string().trim().min(1).max(60).optional(),
    height_above_level_ft: z.number().optional(),
    corner1_x_ft: z.number().optional(),
    corner1_y_ft: z.number().optional(),
    corner2_x_ft: z.number().optional(),
    corner2_y_ft: z.number().optional(),
  }),
} as const satisfies Record<BimPartEditToolName, z.ZodTypeAny>;

function typeDefinition(model: ModelState, typeId: string, firm?: ReadonlyMap<string, PartTypeDefinition>): { definition: PartTypeDefinition; inModel: boolean } | null {
  // Already in the project library (placed before): that copy, so placed parts stay alike.
  const inModel = model.elements[typeId];
  if (inModel?.kind === "part_type") return { definition: inModel.definition, inModel: true };
  const fromFirm = firm?.get(typeId);
  if (fromFirm) return { definition: fromFirm, inModel: false };
  const library = builtinPartType(typeId);
  return library ? { definition: library.definition, inModel: false } : null;
}

/** Every size of a firm-library part by type id (what bim_place_part with from_firm_library resolves). */
export function firmTypeMap(definition: PartTypeDefinition): Map<string, PartTypeDefinition> {
  return new Map(definitionTypes(definition).map((t) => [t.typeId, t.definition]));
}

function entryTypeMap(entry: FirmPartEntry): Map<string, PartTypeDefinition> {
  return entry.typeId ? new Map([[entry.typeId, entry.definition]]) : firmTypeMap(entry.definition);
}

/**
 * The firm-library sizes bim_place_part may resolve `typeId` against: the
 * part whose model id is the type id's first segment (a drawn part, one type
 * per row of its types table), else the part saved under the whole type id
 * (a part type a script made, e.g. `acme.furn.desk.60x30`).
 */
export async function firmSizesFor(store: FirmPartsSource, typeId: string): Promise<Map<string, PartTypeDefinition>> {
  const byModel = await store.get(typeId.split(".")[0] ?? "");
  const sizes = byModel ? entryTypeMap(byModel) : new Map<string, PartTypeDefinition>();
  if (sizes.has(typeId) || !typeId.includes(".")) return sizes;
  const exact = await store.get(typeId);
  return exact ? new Map([...sizes, ...entryTypeMap(exact)]) : sizes;
}

/** Ids for new elements come from the call's key, so a retried call places the same part, not a second one. */
function newId(prefix: string, key: string, suffix = ""): string {
  return `${prefix}-${key.replace(/^agent-/, "").slice(0, 16)}${suffix}`;
}

export type { BuiltCommand, ToolResult } from "@permitzip/bim-mcp";
import type { BuiltCommand, ToolResult } from "@permitzip/bim-mcp";

type PlacePartArgs = z.infer<typeof PART_EDIT_ARGS.bim_place_part>;

const refusal = (message: string): BuiltCommand => ({ ok: false, message });

/** Placing and planning set values; clearing one (null) is bim_set_parameters' job, so a null there is dropped. */
function definedValues(values: Readonly<Record<string, ParamValue | null>>): Record<string, ParamValue> {
  return Object.fromEntries(Object.entries(values).flatMap(([k, v]) => (v === null ? [] : [[k, v]])));
}

/**
 * A pasted equipment list as planned equipment: the Building Model's
 * Equipment list dialog (the same reader, row checks and one batch of
 * plan_part), so the agent and the person get the same items from the same
 * paste. Any row with a problem refuses the whole list, naming each row, as
 * the dialog keeps Add off until none is left.
 */
export function buildEquipmentList(text: string, model: ModelState, key: string, nec: NecEdition | null): BuiltCommand {
  const rows = readDraft(nec, text);
  if (rows.length === 0) return refusal("No rows in that list. Paste the schedule with its header row (Mark, Description, Qty, Volts, Phase, Load, Gas MBH, CW, HW, Waste).");
  const checks = checkDraft(nec, model, rows);
  const bad = checks.flatMap((c, i) => (c.problems.length > 0 ? [`Row ${i + 1} (${rows[i]?.mark || "no mark"}): ${c.problems.join(" ")}`] : []));
  if (bad.length > 0) return refusal(`Nothing added: ${bad.length === 1 ? "1 row needs" : `${bad.length} rows need`} fixing first. ${bad.slice(0, 12).join(" ")}${bad.length > 12 ? ` And ${bad.length - 12} more.` : ""} Ask the person, then send the corrected list.`);
  let n = 0;
  // Every plumbing and gas load the rows propose, as the dialog has them all ticked until the person unticks one.
  const batch = plannedEquipmentBatch(model, rows, checks, (prefix) => newId(prefix, key, `-${++n}`), proposedLoads(rows, checks));
  if ("refused" in batch) return refusal(batch.refused);
  return { ok: true, command: batch.command };
}

/**
 * bim_place_part's five shapes: a new part drawn at a location (place_part),
 * a new part with no location (plan_part: it waits in Not placed yet), an
 * existing planned part drawn (place_planned_part, same id), a placed part
 * taken off the drawing (unplace_part), and a pasted equipment list (one
 * plan_part per item). Mixed shapes are refused by name.
 */
function buildPlacePart(a: PlacePartArgs, model: ModelState, key: string, firm?: ReadonlyMap<string, PartTypeDefinition>, nec: NecEdition | null = null): BuiltCommand {
  const given = [a.level_id, a.x_ft, a.y_ft].filter((v) => v !== undefined).length;
  const planning = [a.level_hint, a.space_hint].some((v) => v !== undefined);
  const located = [a.height_above_level_ft, a.rotation_deg, a.on_plane_id, a.mount, a.intakes].some((v) => v !== undefined);
  if (a.equipment_list !== undefined) {
    if (a.type_id !== undefined || a.part_id !== undefined || a.unplace || a.from_firm_library || given > 0 || planning || located || a.mark !== undefined || a.values || a.note !== undefined || a.discipline !== undefined) {
      return refusal("equipment_list takes only the pasted list: each row's mark, type and values come from it, and every item waits in Not placed yet. Plan or place a single item with type_id instead.");
    }
    return buildEquipmentList(a.equipment_list, model, key, nec);
  }
  if (a.part_id !== undefined && a.type_id !== undefined) return refusal("Give type_id for a new part or part_id for one that already exists, not both.");
  if (a.part_id !== undefined && a.discipline !== undefined) return refusal(`discipline is for a new part; ${a.part_id} keeps the discipline it was filed under.`);
  if (a.unplace) {
    if (a.part_id === undefined) return refusal("unplace takes part_id: the placed part to take off the drawing.");
    if (given > 0 || planning || located || a.mark !== undefined || a.values) return refusal("unplace takes only part_id (and a note): the part keeps its circuits, values and mark.");
    return { ok: true, command: { type: "unplace_part", partId: a.part_id, ...(a.note !== undefined ? { note: a.note } : {}) } };
  }
  if (a.part_id !== undefined) {
    if (given < 3) return refusal(`Drawing ${a.part_id} needs level_id, x_ft and y_ft.`);
    if (planning || a.note !== undefined || a.mark !== undefined || a.values || a.mount || a.intakes || a.from_firm_library) return refusal(`Placing ${a.part_id} takes only the location (level_id, x_ft, y_ft, height or plane, rotation); set its values with bim_set_parameters.`);
    if (a.on_plane_id !== undefined && a.height_above_level_ft !== undefined) return refusal(`A part on mounting plane ${a.on_plane_id} takes the plane's height; leave out height_above_level_ft.`);
    const level = resolveLevelRef(model, a.level_id ?? "");
    if (!level.ok) return refusal(level.message);
    return {
      ok: true,
      command: {
        type: "place_planned_part",
        partId: a.part_id,
        levelId: level.id,
        position: { x: ft(a.x_ft ?? 0), y: ft(a.y_ft ?? 0) },
        ...(a.height_above_level_ft !== undefined ? { offsetMm: ft(a.height_above_level_ft) } : {}),
        ...(a.rotation_deg !== undefined ? { rotationDeg: a.rotation_deg } : {}),
        ...(a.on_plane_id !== undefined ? { planeId: a.on_plane_id } : {}),
      },
    };
  }
  if (a.type_id === undefined) return refusal("Give type_id (a new part) or part_id (one that already exists).");
  if (a.from_firm_library && !firm?.has(a.type_id)) return refusal(`No size ${a.type_id} in the firm library. Call bim_list_firm_parts and use one of its type ids.`);
  const type = typeDefinition(model, a.type_id, a.from_firm_library ? firm : undefined);
  if (!type) return refusal(`No part type ${a.type_id} in this model or the starter library. Call bim_list_part_types and use one of its ids.`);
  const typed = a.values ? partValuesIn(type.definition, a.type_id, a.values) : null;
  if (typed && !typed.ok) return refusal(typed.message);
  const values = typed ? { values: definedValues(typed.values) } : {};
  if (given === 0) {
    if (located) return refusal("A planned part has no location yet: leave out height, rotation, plane, mount and intakes until you place it.");
    let levelHint: string | undefined;
    if (a.level_hint !== undefined) {
      const hint = resolveLevelRef(model, a.level_hint);
      if (!hint.ok) return refusal(hint.message);
      levelHint = hint.id;
    }
    return {
      ok: true,
      command: {
        type: "plan_part",
        partId: newId("p", key),
        typeId: a.type_id,
        ...(type.inModel ? {} : { partType: type.definition }),
        ...(a.mark !== undefined ? { mark: a.mark } : {}),
        ...values,
        ...(levelHint !== undefined ? { levelHint } : {}),
        ...(a.space_hint !== undefined ? { spaceHint: a.space_hint } : {}),
        ...(a.note !== undefined ? { note: a.note } : {}),
        ...(a.discipline !== undefined ? { discipline: a.discipline } : {}),
      },
    };
  }
  if (given < 3) return refusal("Give level_id, x_ft and y_ft to draw the part, or none of them to plan it (Not placed yet).");
  if (planning || a.note !== undefined) return refusal("level_hint, space_hint and note are for a planned part; a part drawn at a location has its level.");
  const level = resolveLevelRef(model, a.level_id ?? "");
  if (!level.ok) return refusal(level.message);
  if (a.on_plane_id !== undefined && a.height_above_level_ft !== undefined) return refusal(`A part on mounting plane ${a.on_plane_id} takes the plane's height; leave out height_above_level_ft.`);
  return {
    ok: true,
    command: {
      type: "place_part",
      partId: newId("p", key),
      typeId: a.type_id,
      ...(type.inModel ? {} : { partType: type.definition }),
      levelId: level.id,
      position: { x: ft(a.x_ft ?? 0), y: ft(a.y_ft ?? 0) },
      ...(a.height_above_level_ft !== undefined ? { offsetMm: ft(a.height_above_level_ft) } : {}),
      ...(a.rotation_deg !== undefined ? { rotationDeg: a.rotation_deg } : {}),
      ...(a.mark !== undefined ? { mark: a.mark } : {}),
      ...values,
      ...(a.mount && a.mount !== "as_drawn" ? { mount: a.mount } : {}),
      ...(a.on_plane_id !== undefined ? { planeId: a.on_plane_id } : {}),
      ...(a.intakes ? { intakes: a.intakes } : {}),
      ...(a.discipline !== undefined ? { discipline: a.discipline } : {}),
    },
  };
}

type SetElementArgs = z.infer<typeof PART_EDIT_ARGS.bim_set_element>;
type PlaceArgs = NonNullable<SetElementArgs["place"]>;

function elementWords(el: BimElement): string {
  const named = "mark" in el && typeof el.mark === "string" && el.mark ? el.mark : "name" in el && typeof el.name === "string" && el.name ? el.name : el.id;
  return `${el.kind.replace(/_/g, " ")} ${named}`;
}

/** Plan feet to the kernel's geometric placement (mm), justified as each kind is drawn: a beam hangs from its line, a slab's area is its top, the rest stand on theirs. */
/**
 * A line placement's top and base (a wall's): what the element has now, so
 * moving a wall never unties its top from a level or a surface. Scripts set
 * them (`building.walls` top / base); this tool's schema stays in its budget.
 */
function lineBoundsIn(el: BimElement): Record<string, unknown> {
  const now = "placement" in el && el.placement?.kind === "line" ? el.placement : null;
  const out: Record<string, unknown> = {};
  if (now?.topLevelId !== undefined) Object.assign(out, { topLevelId: now.topLevelId, ...(now.topOffsetMm ? { topOffsetMm: now.topOffsetMm } : {}) });
  if (now?.topSurface) out.topSurface = now.topSurface;
  if (now?.baseSurface) out.baseSurface = now.baseSurface;
  return out;
}

function placementIn(p: PlaceArgs, model: ModelState, el: BimElement): Record<string, unknown> | string {
  const level = resolveLevelRef(model, p.level);
  if (!level.ok) return level.message;
  const pts = p.points_ft.map((q) => ({ x: ft(q.x), y: ft(q.y) }));
  const z = ft(p.z_ft ?? 0);
  const need = { point: 1, line: 2, path: 2, area: 3 }[p.kind];
  if (pts.length < need || (p.kind === "point" && pts.length > 1) || (p.kind === "line" && pts.length > 2)) return `A ${p.kind} placement takes ${p.kind === "point" ? "one point" : p.kind === "line" ? "two points (start, end)" : `${need} or more points`}; got ${pts.length}`;
  const [first, second] = pts;
  if (!first) return "Give points_ft";
  switch (p.kind) {
    case "point":
      return { kind: "point", levelId: level.id, position: first, offsetMm: z, rotationDeg: p.rotation_deg ?? 0 };
    case "line": {
      const line = { kind: "line", levelId: level.id, start: first, end: second ?? first, startOffsetMm: z, endOffsetMm: z, lateral: "center", vertical: el.kind === "beam" ? "top" : "bottom" };
      return { ...line, ...lineBoundsIn(el) };
    }
    case "path":
      return { kind: "path", levelId: level.id, start: first, segments: pts.slice(1).map((to) => ({ kind: "line", to })), offsetMm: z, lateral: "center" };
    case "area":
      return { kind: "area", levelId: level.id, outline: pts, offsetMm: z, vertical: el.kind === "slab" ? "top" : "bottom" };
  }
}

/**
 * bim_set_element: one typed-element command per call (class, type, values,
 * placement, lock or unlock, or a new shared type), on the agent vocabulary.
 * Values with a unit convert through the parameter's definition in the
 * model's add-ons (pinned packs in scope) and the library; the model server
 * decides everything else (which kinds take what, older servers, locks).
 */
/** The command as the model server reads it, or a refusal naming the field it doesn't take (the model server drops a message it can't parse). */
function elementCommand(raw: Record<string, unknown>): BuiltCommand {
  const parsed = commandSchema.safeParse(raw);
  return parsed.success ? { ok: true, command: parsed.data } : refusal(commandIssueMessage(parsed.error, raw));
}

/** Who an agent's record names as deciding. */
const AGENT_DECIDER = "Agent (proposed; a person reviews it)";

type CodeArgs = NonNullable<SetElementArgs["code"]>;

/** A requirements-graph id is `<source>:<rule>:<key>:<anchor>`; anything else names a decision. */
const isRequirementId = (id: string): boolean => id.split(":").length >= 4;

/**
 * `code`: a requirement change (a value overrides it, withdraw takes it out,
 * neither puts it back to proposed) or a determination (`id` is its key,
 * on element_ids[0], else the model). A reason always. There is no way to
 * verify: only a person with code-study edit rights does (product decision 3).
 */
function codeCommand(c: CodeArgs, ids: readonly string[], model: ModelState, key: string): BuiltCommand {
  const reason = c.reason.trim();
  if (isRequirementId(c.id)) {
    const status = c.withdraw ? "withdrawn" : c.value !== undefined ? "overridden" : "proposed";
    if (status !== "proposed" && reason.length < 3) return refusal(`Say why: ${status === "overridden" ? "an override" : "withdrawing a requirement"} needs a reason the person will read.`);
    return elementCommand({ type: "set_requirement_state", requirementId: c.id, status, ...(c.value !== undefined ? { value: c.value } : {}), ...(reason ? { reason } : {}), by: AGENT_DECIDER });
  }
  if (c.value === undefined || reason.length < 3) return refusal("A code decision needs its key as id (occupancy), a value (A-3) and the reason in your own words.");
  if (ids.length > 1) return refusal("A decision is about one space, zone or element, or the model (no element_ids).");
  const [id] = ids;
  const el = id ? model.elements[id] : undefined;
  if (id && !el) return refusal(`No element ${id} in this model (or not in the area you loaded).`);
  const subject = !id ? { kind: "model" } : el?.kind === "space" || el?.kind === "zone" ? { kind: el.kind, id } : { kind: "element", id };
  return elementCommand({ type: "record_determination", determinationId: newId("det", key), subject, key: c.id, value: c.value, reasoning: reason, decidedBy: AGENT_DECIDER, decidedAt: new Date().toISOString(), confidence: "medium" });
}

export function buildSetElement(a: SetElementArgs, model: ModelState, key: string, library: Registry | null): BuiltCommand {
  const given = (["class", "type_id", "values", "place", "lock", "new_type", "code", "architecture"] as const).filter((k) => a[k] !== undefined);
  if (given.length !== 1) return refusal(given.length === 0 ? "Say what to set: one of class, type_id, values, place, lock, new_type, code or architecture." : `One change per call: ${given.join(" and ")} go in separate calls.`);
  if (a.architecture) {
    const built = architectureCommand(a.architecture);
    return built.ok ? elementCommand(built.command) : refusal(built.message);
  }
  if (a.code) return codeCommand(a.code, a.element_ids ?? [], model, key);
  const registries = (): Registry[] => [withPinnedPacks(model, () => withPackParameters(activeClassRegistry())), ...(library ? [library] : [])];
  if (a.new_type) {
    if (a.element_ids) return refusal("new_type makes a type on its own; then set it on elements with type_id.");
    return elementCommand({ type: "create_element_type", typeId: newId("et", key), name: a.new_type.name, ...(a.new_type.class !== undefined ? { classId: a.new_type.class } : {}), ...(a.new_type.for_kinds ? { forKinds: a.new_type.for_kinds } : {}) });
  }
  const ids = a.element_ids ?? [];
  if (ids.length === 0) return refusal("Give element_ids: the elements to change.");
  const missing = ids.filter((id) => !model.elements[id]);
  if (missing.length > 0) return refusal(`No element ${missing.slice(0, 5).join(", ")} in this model (or not in the area you loaded).`);
  const targets = ids.flatMap((id) => (model.elements[id] ? [model.elements[id]] : []));
  if (a.class !== undefined) return elementCommand({ type: "set_element_class", elementIds: ids, classId: a.class });
  if (a.type_id !== undefined) return elementCommand({ type: "set_element_type", elementIds: ids, typeId: a.type_id });
  if (a.lock !== undefined) return elementCommand(a.lock === false ? { type: "unlock_elements", elementIds: ids } : { type: "lock_elements", elementIds: ids, state: a.lock.state, reason: a.lock.reason });
  if (a.values) {
    if (Object.keys(a.values).length === 0) return refusal("Give at least one value.");
    const converted = elementValuesIn(registries(), model, targets, a.values, elementWords);
    if (!converted.ok) return refusal(converted.message);
    return elementCommand({ type: "set_element_values", elementIds: ids, values: converted.values });
  }
  const [only] = targets;
  if (ids.length !== 1 || !only) return refusal("place takes one element at a time.");
  if (a.place === null || a.place === undefined) return elementCommand({ type: "set_element_placement", elementId: only.id, placement: null });
  const placement = placementIn(a.place, model, only);
  if (typeof placement === "string") return refusal(placement);
  return elementCommand({ type: "set_element_placement", elementId: only.id, placement });
}

/** The kernel command a part tool sends, or the plain reason it can't be built. `raw` is checked against the tool's arguments. */
export function buildPartCommand(tool: BimPartEditToolName, raw: unknown, model: ModelState, key: string, firm?: ReadonlyMap<string, PartTypeDefinition>, nec: NecEdition | null = null, library: Registry | null = null): BuiltCommand {
  switch (tool) {
    case "bim_set_element":
      return buildSetElement(PART_EDIT_ARGS.bim_set_element.parse(raw), model, key, library);
    case "bim_place_part": {
      const a = PART_EDIT_ARGS.bim_place_part.parse(raw);
      return buildPlacePart(a, model, key, firm, nec);
    }
    case "bim_move_elements": {
      const a = PART_EDIT_ARGS.bim_move_elements.parse(raw);
      return { ok: true, command: { type: "move_elements", ids: a.element_ids, delta: { x: ft(a.dx_ft), y: ft(a.dy_ft) }, ...(a.dz_ft !== undefined ? { dzMm: ft(a.dz_ft) } : {}) } };
    }
    case "bim_rotate_elements": {
      const a = PART_EDIT_ARGS.bim_rotate_elements.parse(raw);
      const about = a.about_x_ft !== undefined && a.about_y_ft !== undefined ? { about: { x: ft(a.about_x_ft), y: ft(a.about_y_ft) } } : {};
      return { ok: true, command: { type: "rotate_elements", ids: a.element_ids, angleDeg: a.angle_deg, ...about } };
    }
    case "bim_copy_elements": {
      const a = PART_EDIT_ARGS.bim_copy_elements.parse(raw);
      return { ok: true, command: { type: "copy_elements", ids: a.element_ids, newIds: a.element_ids.map((_, i) => newId("p", key, `-${i + 1}`)), delta: { x: ft(a.dx_ft), y: ft(a.dy_ft) } } };
    }
    case "bim_delete_elements": {
      const a = PART_EDIT_ARGS.bim_delete_elements.parse(raw);
      return { ok: true, command: { type: "delete_elements", ids: a.element_ids, policy: a.if_dependents ?? "refuse" } };
    }
    case "bim_set_parameters": {
      const a = PART_EDIT_ARGS.bim_set_parameters.parse(raw);
      const el = model.elements[a.element_id];
      const typeId = el?.kind === "part" ? el.typeId : el?.kind === "part_type" ? el.id : null;
      const def = typeId ? typeDefinition(model, typeId)?.definition : undefined;
      const converted = a.values ? partValuesIn(def, typeId ?? a.element_id, a.values) : null;
      if (converted && !converted.ok) return { ok: false, message: converted.message };
      const values = converted?.values;
      return {
        ok: true,
        command: { type: "set_parameters", id: a.element_id, scope: a.scope, ...(values ? { values } : {}), ...(a.mark !== undefined ? { mark: a.mark } : {}), ...(a.mount !== undefined ? { mount: a.mount } : {}), ...(a.intakes !== undefined ? { intakes: a.intakes } : {}) },
      };
    }
    case "bim_set_mounting_plane": {
      const a = PART_EDIT_ARGS.bim_set_mounting_plane.parse(raw);
      const c1 = a.corner1_x_ft !== undefined && a.corner1_y_ft !== undefined ? { x: ft(a.corner1_x_ft), y: ft(a.corner1_y_ft) } : undefined;
      const c2 = a.corner2_x_ft !== undefined && a.corner2_y_ft !== undefined ? { x: ft(a.corner2_x_ft), y: ft(a.corner2_y_ft) } : undefined;
      if (a.plane_id !== undefined) {
        if (model.elements[a.plane_id]?.kind !== "mounting_plane") return { ok: false, message: `No mounting plane ${a.plane_id}. bim_list_levels lists each level's planes.` };
        if (a.level_id !== undefined) return { ok: false, message: "A plane stays on its level; make a new one on the other level instead." };
        return {
          ok: true,
          command: { type: "set_mounting_plane", planeId: a.plane_id, ...(a.name !== undefined ? { name: a.name } : {}), ...(a.height_above_level_ft !== undefined ? { heightMm: ft(a.height_above_level_ft) } : {}), ...(c1 ? { corner1: c1 } : {}), ...(c2 ? { corner2: c2 } : {}) },
        };
      }
      if (!a.level_id || !a.name || a.height_above_level_ft === undefined || !c1 || !c2) return { ok: false, message: "A new mounting plane needs level_id, name, height_above_level_ft and both corners (corner1_x_ft, corner1_y_ft, corner2_x_ft, corner2_y_ft)." };
      const level = resolveLevelRef(model, a.level_id);
      if (!level.ok) return { ok: false, message: level.message };
      return { ok: true, command: { type: "create_mounting_plane", planeId: newId("mp", key), levelId: level.id, name: a.name, heightMm: ft(a.height_above_level_ft), corner1: c1, corner2: c2 } };
    }
    case "bim_create_level": {
      const a = PART_EDIT_ARGS.bim_create_level.parse(raw);
      return { ok: true, command: { type: "create_level", levelId: newId("lvl", key), name: a.name, elevationMm: ft(a.elevation_ft) } };
    }
    case "bim_save_part_definition": {
      const a = PART_EDIT_ARGS.bim_save_part_definition.parse(raw);
      const def = partDefinition(a.part_name, a.definition);
      const issue = partTypeIssues(def)[0];
      if (issue) return { ok: false, message: `${a.part_name}: ${issue.message}. Check it with bim_check_part_definition.` };
      try {
        const types = definitionTypes(def);
        return { ok: true, command: { type: "save_part_types", label: `Save ${a.part_name} (${types.length} size${types.length === 1 ? "" : "s"}) to the project library`, types } };
      } catch (err) {
        console.error("[bim_save_part_definition] types table can't be expanded", err);
        return { ok: false, message: err instanceof Error ? err.message : "The types table can't be saved" };
      }
    }
  }
}

const common = z.object({
  project_id: z.string().uuid(),
  model_id: z.string().min(1).max(200),
  level: z.string().min(1).max(40).optional(),
  zone: z.string().min(1).max(40).optional(),
  base_revision: z.number().int().min(0).optional(),
});

export interface PartToolHelpers {
  readonly target: { readonly project_id: z.ZodString; readonly model_id: z.ZodString };
  readonly area: { readonly level: z.ZodOptional<z.ZodString>; readonly zone: z.ZodOptional<z.ZodString> };
  readonly baseRevision: { readonly base_revision: z.ZodOptional<z.ZodNumber> };
  /** Read the model as the caller (read permission) and answer from it. */
  read(tool: string, extra: unknown, args: { project_id: string; model_id: string; level?: string; zone?: string }, work: (session: AgentSession) => unknown): Promise<ToolResult>;
  /** Send a built command through the authority as the caller (write permission). */
  edit(
    tool: string,
    extra: unknown,
    args: { project_id: string; model_id: string; base_revision?: number; level?: string; zone?: string },
    /** The tool's own arguments: with the run, model and base revision they make the call's idempotency key. */
    editArgs: unknown,
    build: (model: ModelState, key: string) => BuiltCommand,
  ): Promise<ToolResult>;
  runId(extra: unknown): Promise<string>;
  /** The firm part library as the caller sees it (the host decides what they may read). */
  firmParts(extra: unknown): Promise<FirmPartsSource>;
  /** The project's adopted NEC edition (Code Study), for reading horsepower in a pasted equipment list; null when it has none. */
  necEdition?(extra: unknown, projectId: string): Promise<NecEdition | null>;
  /** The library's class and parameter registry as the caller reads it (built-in AEC and MEP plus the firm's), for bim_set_element's units. */
  parameterLibrary?(extra: unknown, projectId: string): Promise<Registry>;
}

/** bim_set_element's library registry; without it, values with units convert through the model's add-ons only. */
async function setElementLibrary(helpers: PartToolHelpers, tool: BimPartEditToolName, extra: unknown, projectId: string): Promise<Registry | null> {
  if (tool !== "bim_set_element" || !helpers.parameterLibrary) return null;
  try {
    return await helpers.parameterLibrary(extra, projectId);
  } catch (err) {
    console.error("[bim_set_element] the library couldn't be read; values with units convert through the model's add-ons only", { projectId, err });
    return null;
  }
}

/** The edition an equipment list's horsepower rows read; without one they say so row by row (kW, VA and amps read the same under any edition). */
async function equipmentListNec(helpers: PartToolHelpers, extra: unknown, projectId: string, wanted: { readonly equipment_list?: unknown }): Promise<NecEdition | null> {
  if (typeof wanted.equipment_list !== "string" || !helpers.necEdition) return null;
  try {
    return await helpers.necEdition(extra, projectId);
  } catch (err) {
    console.error("[bim_place_part] reading the project's NEC edition for an equipment list failed; horsepower rows will ask for it", { projectId, err });
    return null;
  }
}

const DESCRIPTIONS: Readonly<Record<BimPartEditToolName, { title: string; description: string }>> = {
  bim_place_part: {
    title: "Place a part",
    description:
      "Place any part (equipment, air terminal, receptacle, panel, light, plumbing fixture…) on a level at a plan position in feet. No location: the part is planned (exists for circuits, schedules and the one-line, waits in Not placed yet). part_id draws a planned part, or with unplace takes one off the drawing. A starter-library or firm-library type (from_firm_library) is added to the model with the part. Values are checked against the type's parameters; a bad value is refused with the reason.",
  },
  bim_move_elements: { title: "Move parts", description: "Move parts (and equipment with its connected ducts) by an offset in feet; parts can also move up or down. Tags follow." },
  bim_rotate_elements: { title: "Rotate parts", description: "Rotate parts about their insertion point (one part) or a pivot / their centre (several)." },
  bim_copy_elements: { title: "Copy parts", description: "Copy parts by an offset in feet. Copies keep the type and values but start without a mark." },
  bim_delete_elements: {
    title: "Delete elements",
    description:
      "Delete parts, levels or other elements. If anything depends on them (tags, connections, parts on a level), the default refuses and lists them; choose disconnect or cascade to say what happens. The result says exactly what was removed.",
  },
  bim_set_parameters: {
    title: "Set part parameters",
    description: "Set a part's own values (scope instance) or its type's values, shared by every part of that type (scope type). Values are validated; type values can't be set at instance scope.",
  },
  bim_create_level: { title: "Add a level", description: "Add a level (storey) with a name and floor elevation in feet. Parts are placed on levels." },
  bim_set_element: {
    title: "Set an element's class, type, values, placement or lock",
    description:
      "One change per call on walls, slabs, openings, rooms, grids, columns, beams and components: class, type_id, values (by parameter key; a part takes its add-on keys here), place (geometry in plan feet), lock (existing or issued, with a reason; false unlocks), new_type (a shared type to set with type_id) or code. Preview with bim_preview_part_edit.",
  },
  bim_set_mounting_plane: {
    title: "Make or change a mounting plane",
    description: "A level surface at a height over a plan rectangle (feet) to place air devices on where there's no ceiling. A new height moves its parts; their duct follows.",
  },
  bim_save_part_definition: {
    title: "Save a part definition",
    description:
      "Save a modeled part (made with the part editor's model: reference planes, sketches, extrudes and revolves, connectors, a types table) to the project library. Each row of its types table becomes a placeable type with id <model id>.<size>; placed parts of an existing type update at once. Refused, with the reason, if the definition doesn't check out or if a run is connected to a connector it would remove or move.",
  },
};

/**
 * A saved part's definition the way the part editor opens it (Edit part): the
 * same fields bim_check_part_definition and bim_save_part_definition take, so
 * an agent edits a part instead of drawing it again. Every size of a modeled
 * part carries the whole model and its types table, so any one of them opens
 * the part.
 */
export function readPartDefinition(model: ModelState, id: string) {
  const el = model.elements[id];
  const typeId = el?.kind === "part" ? el.typeId : id;
  const type = model.elements[typeId];
  const def: PartTypeDefinition | undefined = type?.kind === "part_type" ? type.definition : builtinPartType(typeId)?.definition;
  if (!def) return { status: "not_found" as const, revision: model.revision, message: `No part type or placed part ${id} in this model or the starter library. Read bim_list_part_types for type ids.` };
  const fields = partDefinitionFieldsSchema.safeParse(def);
  if (!fields.success) return { status: "not_editable" as const, revision: model.revision, message: `${typeId} can't be opened as a definition: ${fields.error.issues[0]?.message ?? "it doesn't fit the part editor"}.` };
  const sizes = new Set(definitionTypes(def).map((t) => t.typeId));
  const placed = elementValues(model.elements).filter((e) => e.kind === "part" && sizes.has(e.typeId)).length;
  return {
    status: "ok" as const,
    revision: model.revision,
    type_id: typeId,
    in_model: type?.kind === "part_type",
    modeled: def.model !== undefined,
    part_name: partGroupName(def),
    definition: fields.data,
    sizes: [...sizes],
    placed_count: placed,
    next: def.model
      ? "Change the definition, check it with bim_check_part_definition, then bim_save_part_definition with the same part_name: every size updates where it is placed."
      : "This type has no 3D model (reference planes, sketches, features) to edit. To model it, start from bim_part_definition_example and keep its parameters and connectors.",
  };
}

export function registerBimPartTools(server: McpServer, helpers: PartToolHelpers): void {
  const { target, area, baseRevision } = helpers;
  registerBimPartEditorTools(server);

  server.registerTool(
    "bim_list_part_types",
    {
      title: "List part types and levels",
      description:
        "Part types you can place, in every discipline: the model's own types first, then the starter library's. Each lists its type values, the instance parameters you can set (with units and choices) and its connectors. Also returns the model's levels. Read this before bim_place_part.",
      inputSchema: {
        ...target,
        category: z.enum(PART_CATEGORIES).optional(),
        search: z.string().max(80).optional().describe("Words in the family or type name."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args, extra) =>
      helpers.read("bim_list_part_types", extra, args, (s) => ({
        ...listPartTypes(s.model(), { category: args.category, search: args.search, limit: args.limit }),
        levels: listLevels(s.model()).levels,
      })),
  );

  server.registerTool(
    "bim_read_part_definition",
    {
      title: "Read a part's definition",
      description:
        "Open a part the way Edit part does: give a part type id (bim_list_part_types) or a placed part's id, get back part_name and definition in exactly the form bim_check_part_definition and bim_save_part_definition take (reference planes, sketches, features, connectors, parameters and the types table), its sizes and how many are placed. Change it, check, save with the same part_name.",
      inputSchema: { ...target, id: z.string().min(1).max(200).describe("A part type id or a placed part's id.") },
    },
    async (args, extra) => helpers.read("bim_read_part_definition", extra, args, (s) => readPartDefinition(s.model(), args.id)),
  );

  server.registerTool(
    "bim_preview_part_edit",
    {
      title: "Preview a part edit",
      description:
        "Dry run: what one of the part edit tools would change at the revision you read (elements changed, removed, connections cut), or the reason it would be refused. Saves nothing and needs no approval.",
      inputSchema: {
        ...target,
        ...area,
        tool: z.enum(BIM_PART_EDIT_TOOL_NAMES),
        args: z.record(z.string(), z.unknown()).describe("The same arguments the edit tool takes, without project_id / model_id / base_revision."),
      },
    },
    async (input, extra) => {
      const schema = PART_EDIT_ARGS[input.tool];
      const parsed = schema.safeParse(input.args);
      if (!parsed.success) return { content: [{ type: "text" as const, text: `Those arguments don't fit ${input.tool}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true };
      const runId = await helpers.runId(extra);
      const wanted: Record<string, unknown> = parsed.data;
      let firm: ReadonlyMap<string, PartTypeDefinition> | undefined;
      if (input.tool === "bim_place_part" && wanted.from_firm_library === true && typeof wanted.type_id === "string") {
        try {
          firm = await firmSizesFor(await helpers.firmParts(extra), wanted.type_id);
        } catch (err) {
          console.error("[bim_preview_part_edit] firm library read failed", err);
          return { content: [{ type: "text" as const, text: `The firm library couldn't be read: ${err instanceof Error ? err.message : String(err)}.` }], isError: true };
        }
      }
      const nec = input.tool === "bim_place_part" ? await equipmentListNec(helpers, extra, input.project_id, wanted) : null;
      const library = await setElementLibrary(helpers, input.tool, extra, input.project_id);
      return helpers.read("bim_preview_part_edit", extra, input, (s) => {
        const model = s.model();
        const key = editIdempotencyKey(runId, input.tool, { model_id: input.model_id, args: parsed.data }, model.revision);
        const built = buildPartCommand(input.tool, parsed.data, model, key, firm, nec, library);
        if (!built.ok) return { status: "would_refuse", revision: model.revision, message: built.message };
        return { ...s.preview(built.command), command: built.command };
      });
    },
  );

  for (const tool of BIM_PART_EDIT_TOOL_NAMES) {
    const schema: z.ZodObject<z.ZodRawShape> = PART_EDIT_ARGS[tool];
    const advertised: z.ZodRawShape =
      tool === "bim_save_part_definition" ? { ...schema.shape, definition: ADVERTISED_PART_DEFINITION } : schema.shape;
    const inputSchema: z.ZodRawShape = { ...target, ...area, ...baseRevision, ...advertised };
    server.registerTool(tool, { title: DESCRIPTIONS[tool].title, description: DESCRIPTIONS[tool].description, inputSchema }, async (args: unknown, extra: unknown) => {
      const where = common.safeParse(args);
      const own = schema.safeParse(args);
      if (!where.success || !own.success) {
        const issues = [...(where.success ? [] : where.error.issues), ...(own.success ? [] : own.error.issues)];
        return { content: [{ type: "text" as const, text: `Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` }], isError: true };
      }
      let firm: ReadonlyMap<string, PartTypeDefinition> | undefined;
      if (tool === "bim_place_part" && own.data.from_firm_library === true && typeof own.data.type_id === "string") {
        try {
          firm = await firmSizesFor(await helpers.firmParts(extra), own.data.type_id);
        } catch (err) {
          console.error("[bim_place_part] firm library read failed", err);
          return { content: [{ type: "text" as const, text: `The firm library couldn't be read: ${err instanceof Error ? err.message : String(err)}. Nothing was placed.` }], isError: true };
        }
      }
      const nec = tool === "bim_place_part" ? await equipmentListNec(helpers, extra, where.data.project_id, own.data) : null;
      const library = await setElementLibrary(helpers, tool, extra, where.data.project_id);
      return helpers.edit(tool, extra, where.data, own.data, (model, key) => buildPartCommand(tool, own.data, model, key, firm, nec, library));
    });
  }
}
