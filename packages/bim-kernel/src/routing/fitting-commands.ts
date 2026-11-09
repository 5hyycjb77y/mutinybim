import { z } from "zod";
import { finish, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { TrackedReader, requireKind } from "../model";
import { draftElements, elementsOfKind } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { chooseFitting, roomForFittings } from "./commands";
import { coefficientTableSchema, entryIssue } from "./fittings/coefficients";
import { ogeeLength, straightPiece } from "./fittings/geometry";
import { familyMismatch, fittingFamily, missingFittingFamilyWords, paramIssue, resolveFitting, resolveParams } from "./fittings/library";
import { add3, dir3, dot3, len3, p3, round3, scale3, segmentAxis, sub3, unit3, withLink } from "./geometry";
import { RunPropagator } from "./propagate";
import { branchClearance, runLabel } from "./validate";
import { executePipeCommand, pipeCommandSchemas } from "./pipe/commands";
import { pipeDesignSchema, serviceOf } from "./pipe/design";
import { jointIssue, pipeFittingLabel, pipeParams } from "./pipe/families";
import { runInsulationSchema, runSizingCriteriaSchema } from "./run-insulation";
import { DUCT_MATERIALS, FITTING_SLOTS, type CoefficientTable, type FittingChoice, type FittingSlot, type MepSystem, type RunFitting, type RunPoint, type RunPort, type RunSegment, type RunSize, type SystemDesign } from "./types";

/**
 * Fitting types, coefficients, system fitting choices, offsets and height changes.
 *
 * - `swap_fitting` changes a fitting's family (and parameters) in place: same
 *   id, same connections, same ports. Refused when the family can't be that
 *   fitting (a gored elbow on rectangular duct, a rect-to-round on two round
 *   ends) or its body doesn't fit the straight duct beside it.
 * - `set_fitting_coefficient` records an engineer's C on one fitting, with who and when.
 * - `set_system_design` sets a system's fitting choices, design air, duct
 *   material and coefficient table.
 * - `offset_run` jogs a run sideways, up or down at a point (45°, 90° or ogee);
 *   with a length it comes back, without one everything beyond moves with it.
 * - `change_elevation` is the same jog, given as a new height for a stretch.
 */

const idSchema = z.string().min(1).max(200);
const paramsSchema = z.record(z.string().min(1).max(40), z.union([z.number().finite(), z.string().max(40)]));
const choiceSchema = z.object({ family: z.string().min(1).max(80), params: paramsSchema.optional() });

export const OFFSET_STYLES = ["45", "90", "ogee"] as const;
export type OffsetStyle = (typeof OFFSET_STYLES)[number];

export const fittingCommandSchemas = [
  z.object({ type: z.literal("swap_fitting"), fittingId: idSchema, family: z.string().min(1).max(80), params: paramsSchema.optional() }),
  z.object({
    type: z.literal("set_fitting_coefficient"),
    fittingId: idSchema,
    role: z.enum(["body", "branch", "main"]),
    /** Null clears the override; the coefficient sources apply again. */
    c: z.number().finite().min(0).max(100).nullable(),
    by: z.string().trim().min(1).max(120),
    at: z.string().datetime(),
    note: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("set_system_design"),
    systemId: idSchema,
    /** A new name for the system (unique in the model, any case). */
    name: z.string().trim().min(1).max(80).optional(),
    design: z
      .object({
        altitudeM: z.number().finite().min(-500).max(6000).optional(),
        temperatureC: z.number().finite().min(-40).max(120).optional(),
        material: z.enum(DUCT_MATERIALS).optional(),
        frictionMethod: z.enum(["colebrook", "altshul_tsal"]).optional(),
        /** Pipe systems: water, drainage and gas design inputs; merged field by field over what the system has. */
        pipe: pipeDesignSchema.optional(),
        /** Duct and pipe systems: the insulation new runs get by default (pipe: a wrap); null for none. */
        insulation: runInsulationSchema.nullable().optional(),
        /** Duct systems: friction rate, velocity limit and aspect ratio size suggestions aim for; null for the typical values. */
        sizing: runSizingCriteriaSchema.nullable().optional(),
      })
      .optional(),
    /** Per slot: the fitting to place, or null to go back to the library default. */
    fittingDefaults: z.partialRecord(z.enum(FITTING_SLOTS), choiceSchema.nullable()).optional(),
    coefficientTable: coefficientTableSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("offset_run"),
    idPrefix: z.string().min(1).max(80),
    segmentId: idSchema,
    /** Where the offset starts, along the segment from its start (mm). */
    atMm: z.number().finite().positive(),
    /** Where the run goes: square to it (sideways, up or down), mm. */
    offset: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
    /** Length of displaced run before it comes back; absent: everything beyond the offset moves with it. */
    lengthMm: z.number().finite().positive().optional(),
    style: z.enum(OFFSET_STYLES),
  }),
  z.object({
    type: z.literal("change_elevation"),
    idPrefix: z.string().min(1).max(80),
    segmentId: idSchema,
    /** Stretch of the segment, from its start (mm), that goes to the new height. Absent `toMm`: from `fromMm` to the end of the run. */
    fromMm: z.number().finite().positive(),
    toMm: z.number().finite().positive().optional(),
    /** New centreline height above the level floor (mm). */
    elevationMm: z.number().finite().min(-30_000).max(30_000),
    style: z.enum(["45", "90"]),
  }),
  ...pipeCommandSchemas,
] as const;

export const fittingCommandSchema = z.discriminatedUnion("type", [...fittingCommandSchemas]);
export type FittingCommand = z.infer<typeof fittingCommandSchema>;

const FITTING_COMMAND_TYPES: ReadonlySet<string> = new Set(fittingCommandSchemas.map((s) => s.shape.type.value));

export function isFittingCommand(command: { type: string }): command is FittingCommand {
  return FITTING_COMMAND_TYPES.has(command.type);
}

const MM_PER_FT = 304.8;
const feet = (mm: number) => `${Math.round((mm / MM_PER_FT) * 100) / 100} ft`;

function systemOf(working: Readonly<Record<string, BimElement>>, el: RunFitting | RunSegment): MepSystem {
  const s = working[el.systemId];
  if (s?.kind !== "mep_system") refuse("element_not_found", `${el.id} belongs to system ${el.systemId}, which does not exist`, [el.id]);
  return s;
}

function mainSizeOf(working: Readonly<Record<string, BimElement>>, f: RunFitting): RunSize | undefined {
  const host = f.host ? working[f.host.segmentId] : undefined;
  return host?.kind === "run_segment" ? host.size : undefined;
}

/** Refuse when the new fitting leaves a segment beside it too short for the fittings at its ends, and shorter than it was. */
function requireRoom(before: Readonly<Record<string, BimElement>>, working: Readonly<Record<string, BimElement>>, f: RunFitting, what: string): void {
  for (const p of f.ports) {
    const seg = p.link ? working[p.link.elementId] : undefined;
    if (seg?.kind !== "run_segment") continue;
    const room = roomForFittings(working, seg);
    if (!room) continue;
    const worse = straightPiece(working, seg).lengthMm < straightPiece(before, seg).lengthMm - 0.5;
    if (worse) refuse("min_straight_length", `${what} needs more room: the ${runLabel(working, seg)} ${room}`, [f.id, seg.id]);
  }
}

// ------------------------------------------------------------------ swap

function swapFitting(model: ModelState, cmd: Extract<FittingCommand, { type: "swap_fitting" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const f = requireKind(reader.get(asElementId(cmd.fittingId)), "run_fitting");
  const working = draftElements(model.elements);
  for (const p of f.ports) if (p.link) reader.get(p.link.elementId);
  const family = fittingFamily(cmd.family);
  if (!family) refuse("element_not_found", missingFittingFamilyWords(cmd.family), [f.id]);
  const name = runLabel(working, f);
  const main = mainSizeOf(working, f);
  const system = systemOf(working, f);
  const sizes = f.fittingType === "accessory" && main ? [main] : f.ports.map((p) => p.size);
  const why = familyMismatch(family, { fittingType: f.fittingType, domain: f.domain, sizes, systemKind: system.systemKind, ...(f.angleDeg !== undefined ? { angleDeg: f.angleDeg } : {}), ...(main ? { main } : {}) });
  if (why) refuse("profile_incompatible", `The ${name} can't be a ${family.name}: ${why}`, [f.id]);
  const bad = paramIssue(family, cmd.params);
  if (bad) refuse("invalid_value", `${family.name}: ${bad}`, [f.id]);
  // Same type: the parameters given change, the rest stay (Mirror changes only the flat side).
  const given = f.family === family.id ? { ...(f.params ?? {}), ...(cmd.params ?? {}) } : cmd.params;
  const params = resolveParams(family, f.domain === "pipe" ? pipeParams(family, sizes[0], given) : given);
  const joint = jointIssue(family, params, sizes[0]);
  if (joint) refuse("profile_incompatible", `The ${name} can't be a ${family.name}: ${joint}`, [f.id]);
  if (f.family === family.id && JSON.stringify(resolveParams(family, f.params)) === JSON.stringify(params)) refuse("invalid_value", `The ${name} is already a ${family.name} with those settings`, [f.id]);
  const isBranch = f.fittingType === "tap" || f.fittingType === "tee" || f.fittingType === "wye";
  const { coefficientOverride: cleared, ...rest } = f;
  const label = f.domain === "pipe" ? { label: pipeFittingLabel(family, sizes, main) } : isBranch ? { label: family.name } : {};
  const next: RunFitting = { ...rest, family: family.id, ...(Object.keys(params).length > 0 ? { params } : { params: {} }), ...label };
  working[f.id] = next;
  requireRoom(model.elements, working, next, family.name);
  const summary = [`Now a ${family.name}; its connections are unchanged`];
  if (cleared) summary.push(`The engineer's coefficient (${cleared.c}) was for the old type and was cleared`);
  const authored: AuthoredWrite[] = [{ elementId: f.id, field: "family", value: family.id }];
  return finish(reader, working, [f.id], authored, () => [{ kind: "field_equals", elementId: f.id, field: "family", value: family.id }], { summary });
}

// ------------------------------------------------------------------ coefficient override

function setCoefficient(model: ModelState, cmd: Extract<FittingCommand, { type: "set_fitting_coefficient" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const f = requireKind(reader.get(asElementId(cmd.fittingId)), "run_fitting");
  const working = draftElements(model.elements);
  const name = runLabel(working, f);
  const owner = systemOf(working, f);
  const effective = resolveFitting(owner, f);
  if (f.domain === "conduit" || !effective) refuse("unsupported_geometry", `Pressure drop isn't calculated for ${f.domain} fittings, so the ${name} takes no coefficient`, [f.id]);
  if (effective.family.loss === "not_calculated") {
    refuse(
      "unsupported_geometry",
      serviceOf(owner.systemKind) === "drainage" || serviceOf(owner.systemKind) === "vent"
        ? `Drains are sized by fixture units and Manning capacity at their slope, not fitting losses, so the ${name} takes no coefficient`
        : `The ${name} (${effective.family.name}) has no loss calculation; ${effective.family.description}`,
      [f.id],
    );
  }
  const isBranch = f.host !== undefined && f.fittingType !== "accessory";
  if (isBranch && cmd.role === "body") refuse("invalid_value", `The ${name} has two paths, branch and main; say which the coefficient is for`, [f.id]);
  if (!isBranch && cmd.role !== "body") refuse("invalid_value", `The ${name} has one path; its coefficient is the body coefficient`, [f.id]);
  if (cmd.c === null) {
    if (!f.coefficientOverride) refuse("invalid_value", `The ${name} has no coefficient of its own to clear`, [f.id]);
    const { coefficientOverride: _gone, ...rest } = f;
    working[f.id] = rest;
  } else {
    working[f.id] = { ...f, coefficientOverride: { c: cmd.c, role: cmd.role, by: cmd.by, at: cmd.at, ...(cmd.note ? { note: cmd.note } : {}) } };
  }
  const value = cmd.c ?? "none";
  const authored: AuthoredWrite[] = [{ elementId: f.id, field: "coefficientOverride.c", value }];
  const summary = [cmd.c === null ? `The ${name} uses its coefficient source again` : `The ${name} uses C = ${cmd.c} (${cmd.role}), set by ${cmd.by}`];
  return finish(reader, working, [f.id], authored, () => [{ kind: "field_equals", elementId: f.id, field: "coefficientOverride.c", value }], { summary });
}

// ------------------------------------------------------------------ system design

const SLOT_SAMPLE: Readonly<Record<FittingSlot, { type: RunFitting["fittingType"]; duct: RunSize[]; main?: RunSize; angleDeg?: number; reducer?: boolean }>> = {
  elbow_rect: { type: "elbow", duct: [{ shape: "rect", width: 300, height: 200 }] },
  elbow_round: { type: "elbow", duct: [{ shape: "round", diameter: 250 }] },
  elbow_oval: { type: "elbow", duct: [{ shape: "oval", width: 300, height: 200 }] },
  transition: { type: "transition", duct: [{ shape: "rect", width: 300, height: 200 }, { shape: "rect", width: 250, height: 200 }] },
  transition_shape_change: { type: "transition", duct: [{ shape: "rect", width: 300, height: 200 }, { shape: "round", diameter: 250 }] },
  branch_rect: { type: "tap", duct: [{ shape: "rect", width: 200, height: 150 }], main: { shape: "rect", width: 500, height: 300 } },
  branch_round: { type: "tap", duct: [{ shape: "round", diameter: 200 }], main: { shape: "rect", width: 500, height: 300 } },
  cap: { type: "cap", duct: [{ shape: "rect", width: 300, height: 200 }] },
  offset: { type: "offset", duct: [{ shape: "rect", width: 300, height: 200 }, { shape: "rect", width: 300, height: 200 }] },
  pipe_elbow_90: { type: "elbow", duct: [], angleDeg: 90 },
  pipe_elbow_45: { type: "elbow", duct: [], angleDeg: 45 },
  pipe_tee: { type: "tee", duct: [] },
  pipe_reducer: { type: "transition", duct: [], reducer: true },
  pipe_cap: { type: "cap", duct: [] },
  drain_turn_hv: { type: "elbow", duct: [], angleDeg: 90 },
  drain_turn_vh: { type: "elbow", duct: [], angleDeg: 90 },
  drain_turn_hh: { type: "elbow", duct: [], angleDeg: 90 },
  drain_turn_45: { type: "elbow", duct: [], angleDeg: 45 },
  drain_branch_hv: { type: "tee", duct: [] },
  drain_branch_hh: { type: "tee", duct: [] },
};

/** A pipe size a system of this kind could carry, to check a slot choice against. */
function samplePipe(kind: MepSystem["systemKind"], material?: RunSize): Extract<RunSize, { shape: "pipe" }> {
  if (material?.shape === "pipe") return material;
  const service = serviceOf(kind);
  if (service === "drainage" || service === "vent") return { shape: "pipe", nominalMm: 76.2, material: "pvc" };
  if (service === "gas") return { shape: "pipe", nominalMm: 25.4, material: "black_steel" };
  return { shape: "pipe", nominalMm: 25.4, material: "copper" };
}

const SLOT_LABEL: Readonly<Record<FittingSlot, string>> = {
  elbow_rect: "rectangular elbows",
  elbow_round: "round elbows",
  elbow_oval: "oval elbows",
  transition: "transitions",
  transition_shape_change: "rectangular-to-round transitions",
  branch_rect: "rectangular branches",
  branch_round: "round branches",
  cap: "end caps",
  offset: "offsets",
  pipe_elbow_90: "90° elbows",
  pipe_elbow_45: "45° elbows",
  pipe_tee: "tees",
  pipe_reducer: "reducers",
  pipe_cap: "caps",
  drain_turn_hv: "turns from horizontal to vertical",
  drain_turn_vh: "turns from vertical to horizontal",
  drain_turn_hh: "horizontal turns",
  drain_turn_45: "45° turns",
  drain_branch_hv: "branches into a stack",
  drain_branch_hh: "branches into a horizontal drain",
};

/** The design with its duct defaults replaced: null takes one off, undefined leaves it. */
function withDuctDefaults(design: SystemDesign, insulation: SystemDesign["insulation"] | null | undefined, sizing: SystemDesign["sizing"] | null | undefined): SystemDesign {
  const { insulation: oldInsulation, sizing: oldSizing, ...rest } = design;
  const nextInsulation = insulation === undefined ? oldInsulation : (insulation ?? undefined);
  const nextSizing = sizing === undefined ? oldSizing : sizing === null ? undefined : { ...(oldSizing ?? {}), ...sizing };
  return { ...rest, ...(nextInsulation ? { insulation: nextInsulation } : {}), ...(nextSizing ? { sizing: nextSizing } : {}) };
}

function setSystemDesign(model: ModelState, cmd: Extract<FittingCommand, { type: "set_system_design" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const system = requireKind(reader.get(asElementId(cmd.systemId)), "mep_system");
  const working = draftElements(model.elements);
  const defaults: Partial<Record<FittingSlot, FittingChoice>> = { ...(system.fittingDefaults ?? {}) };
  for (const [slot, choice] of Object.entries(cmd.fittingDefaults ?? {}) as Array<[FittingSlot, FittingChoice | null]>) {
    if (choice === null) {
      delete defaults[slot];
      continue;
    }
    const family = fittingFamily(choice.family);
    if (!family) refuse("element_not_found", `There is no fitting type ${choice.family} in the library`, [system.id]);
    const sample = SLOT_SAMPLE[slot];
    if ((system.domain === "duct") !== (sample.duct.length > 0)) refuse("invalid_value", `${SLOT_LABEL[slot]} is a ${sample.duct.length > 0 ? "duct" : "pipe"} slot; ${system.name} is ${system.domain}`, [system.id]);
    // Pipe: checked in the material the family is made in when it fits this system's service.
    const pipeSize = samplePipe(system.systemKind, family.pipe?.materials[0] ? { shape: "pipe", nominalMm: family.pipe.sizesIn?.min ? family.pipe.sizesIn.min * 25.4 : 76.2, material: family.pipe.materials[0] } : undefined);
    const sizes = system.domain === "duct" ? sample.duct : sample.reducer ? [pipeSize, { ...pipeSize, nominalMm: pipeSize.nominalMm / 2 }] : [pipeSize];
    const main = system.domain === "duct" ? sample.main : sizes[0];
    const why = familyMismatch(family, { fittingType: sample.type, domain: system.domain, sizes, systemKind: system.systemKind, ...(sample.angleDeg !== undefined ? { angleDeg: sample.angleDeg } : {}), ...(main ? { main } : {}) });
    if (why) refuse("profile_incompatible", `${family.name} can't be ${system.name}'s choice for ${SLOT_LABEL[slot]}: ${why}`, [system.id]);
    const bad = paramIssue(family, choice.params);
    if (bad) refuse("invalid_value", `${family.name}: ${bad}`, [system.id]);
    defaults[slot] = { family: family.id, ...(choice.params ? { params: resolveParams(family, choice.params) } : {}) };
  }
  let table: CoefficientTable | undefined = system.coefficientTable;
  if (cmd.coefficientTable === null) table = undefined;
  else if (cmd.coefficientTable) {
    for (const e of cmd.coefficientTable.entries) {
      if (!fittingFamily(e.family)) refuse("element_not_found", `The coefficient table names ${e.family}, which isn't in the fitting library`, [system.id]);
      const why = entryIssue(e);
      if (why) refuse("invalid_value", why, [system.id]);
    }
    table = cmd.coefficientTable;
  }
  const { insulation: newInsulation, sizing: newSizing, ...rest } = cmd.design ?? {};
  if (newSizing && system.domain !== "duct") refuse("invalid_value", `${system.name} is ${system.domain}; duct sizing defaults go on duct systems`, [system.id]);
  if (newInsulation && system.domain !== "duct" && system.domain !== "pipe") refuse("invalid_value", `${system.name} is ${system.domain}; insulation defaults go on duct and pipe systems`, [system.id]);
  if (newInsulation?.kind === "liner" && system.domain === "pipe") refuse("invalid_value", `${system.name} is pipe; pipe takes insulation outside (a wrap), not a liner`, [system.id]);
  const merged: SystemDesign | undefined = cmd.design
    ? { ...(system.design ?? {}), ...rest, ...(rest.pipe ? { pipe: { ...(system.design?.pipe ?? {}), ...rest.pipe } } : {}) }
    : system.design;
  const design: SystemDesign | undefined = merged && (newInsulation !== undefined || newSizing !== undefined) ? withDuctDefaults(merged, newInsulation, newSizing) : merged;
  if (cmd.design?.pipe && system.domain !== "pipe") refuse("invalid_value", `${system.name} is ${system.domain}; pipe design inputs go on pipe systems`, [system.id]);
  const name = cmd.name?.trim();
  if (name && name.toLowerCase() !== system.name.toLowerCase()) {
    const taken = elementsOfKind(model.elements, "mep_system").find((e) => e.id !== system.id && e.name.toLowerCase() === name.toLowerCase());
    if (taken) refuse("already_exists", `There is already a system called ${taken.name}; pick another name`, [system.id, taken.id]);
  }
  const { fittingDefaults: _d, design: _g, coefficientTable: _t, ...base } = system;
  const next: MepSystem = {
    ...base,
    ...(name ? { name } : {}),
    ...(Object.keys(defaults).length > 0 ? { fittingDefaults: defaults } : {}),
    ...(design ? { design } : {}),
    ...(table ? { coefficientTable: table } : {}),
  };
  working[system.id] = next;
  const renamedTo = name !== undefined && name !== system.name ? name : null;
  const designChanged = cmd.design !== undefined || cmd.fittingDefaults !== undefined || cmd.coefficientTable !== undefined;
  const authored: AuthoredWrite[] = [];
  const summary: string[] = [];
  if (renamedTo !== null) {
    authored.push({ elementId: system.id, field: "name", value: renamedTo });
    summary.push(`${system.name} is now called ${renamedTo}`);
  }
  if (designChanged || renamedTo === null) {
    authored.push({ elementId: system.id, field: "design", value: "set" });
    summary.push(`${renamedTo ?? system.name}'s fittings and design air are updated; existing fittings keep their types until swapped`);
  }
  return finish(reader, working, [system.id], authored, () => [], { summary });
}

// ------------------------------------------------------------------ offsets and height changes

interface JogContext {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: Set<ElementId>;
  readonly model: ModelState;
  readonly prefix: string;
  segCount: number;
  fitCount: number;
}

function put(ctx: JogContext, el: BimElement): void {
  ctx.working[el.id] = el;
  ctx.touched.add(el.id);
}

function newId(ctx: JogContext, kind: "s" | "f"): ElementId {
  const id = asElementId(`${ctx.prefix}-${kind}${kind === "s" ? ++ctx.segCount : ++ctx.fitCount}`);
  if (ctx.reader.find(id) || ctx.working[id]) refuse("already_exists", `${id} already exists; choose a new id prefix`, [id]);
  return id;
}

function planOk(v: RunPoint): boolean {
  const deg = (((Math.atan2(v.y, v.x) * 180) / Math.PI) + 360) % 45;
  return deg < 0.01 || deg > 44.99;
}

/**
 * Split `seg` at `s` and send the rest of it `d` away (square to it): a
 * 90° jog (two elbows and a piece along `d`), a 45° jog (two 45° elbows and
 * a sloped piece) or one ogee offset fitting. Branches past the jog move with
 * the rest; a branch where the jog goes refuses. Returns the moved remainder.
 */
function jog(ctx: JogContext, seg: RunSegment, s: number, d: RunPoint, style: OffsetStyle): RunSegment {
  const { working, model } = ctx;
  const name = runLabel(working, seg);
  const u = segmentAxis(seg);
  const total = len3(sub3(seg.end, seg.start));
  const dl = len3(d);
  const tol = model.settings.connectorToleranceMm;
  const minStraight = model.settings.minStraightMm;
  if (dl < tol) refuse("invalid_value", "An offset needs a distance");
  const dh = unit3(d);
  if (Math.abs(dot3(dh, u)) > 1e-6) refuse("unsupported_geometry", `An offset moves ${name} sideways, up or down, square to it; this one runs along it`, [seg.id]);
  const level = Math.abs(u.z) < 1e-6;
  const pure = level ? Math.abs(dh.z) < 1e-6 || Math.hypot(dh.x, dh.y) < 1e-6 : Math.abs(dh.z) < 1e-6 && planOk(dh);
  if (!pure) refuse("unsupported_geometry", level ? `Offset ${name} either sideways or up / down, one at a time` : `A riser offsets level, east-west, north-south or at 45°`, [seg.id]);
  const system = systemOf(working, seg);
  const offsetChoice = style === "ogee" ? chooseFitting(system, "offset", seg.domain, [seg.size, seg.size], undefined, undefined) : null;
  const bend = typeof offsetChoice?.fields.params?.bend_angle_deg === "number" ? offsetChoice.fields.params.bend_angle_deg : 45;
  const along = style === "90" ? 0 : style === "45" ? dl : Math.round(ogeeLength(dl, bend) * 1000) / 1000;
  if (s < minStraight) refuse("min_straight_length", `The offset starts ${feet(s)} into ${name}; leave at least ${minStraight} mm of straight duct before it`, [seg.id]);
  const remaining = total - s - along;
  if (remaining < minStraight) refuse("min_straight_length", `The offset needs ${feet(along + minStraight)} of ${name} past ${feet(s)}; there is ${feet(total - s)}`, [seg.id]);
  const P = round3(add3(seg.start, scale3(u, s)));
  const Q = round3(add3(add3(P, scale3(u, along)), d));
  const tailEnd = round3(add3(seg.end, d));
  const base = { version: 0, authoredRev: {}, ...(seg.partition ? { partition: seg.partition } : {}), domain: seg.domain, systemId: seg.systemId, levelId: seg.levelId, ...(seg.insulation ? { insulation: seg.insulation } : {}) } as const;

  // Branches: before the jog stay, after it move with the rest, on it refuse.
  const clear = branchClearance(seg.domain, model.settings).end;
  const staying: ElementId[] = [];
  const moving: RunFitting[] = [];
  for (const id of seg.branches) {
    ctx.reader.find(id);
    const b = working[id];
    if (b?.kind !== "run_fitting" || !b.host) continue;
    if (b.host.s <= s - clear) staying.push(b.id);
    else if (b.host.s >= s + along + clear) moving.push(b);
    else refuse("outside_host", `The ${runLabel(working, b)} at ${feet(b.host.s)} is where the offset goes; slide it clear first`, [b.id, seg.id]);
  }

  const tailId = newId(ctx, "s");
  const port = (id: string, position: RunPoint, direction: RunPoint, link: { elementId: ElementId; port: string }): RunPort => ({ id, position: round3(position), direction: dir3(direction), size: seg.size, link });
  let headLink: { elementId: ElementId; port: string };
  let tailStartLink: { elementId: ElementId; port: string };
  if (style === "ogee" && offsetChoice) {
    const fid = newId(ctx, "f");
    put(ctx, { ...base, id: fid, kind: "run_fitting", fittingType: "offset", label: "Offset", position: P, ports: [port("a", P, scale3(u, -1), { elementId: seg.id, port: "end" }), port("b", Q, u, { elementId: tailId, port: "start" })], ...offsetChoice.fields });
    headLink = { elementId: fid, port: "a" };
    tailStartLink = { elementId: fid, port: "b" };
  } else {
    const legVec = style === "90" ? d : add3(scale3(u, dl), d);
    const leg = unit3(legVec);
    const angle = style === "90" ? 90 : 45;
    const e1 = newId(ctx, "f");
    const midId = newId(ctx, "s");
    const e2 = newId(ctx, "f");
    const elbow = (id: ElementId, at: RunPoint, a: RunPort, b: RunPort): RunFitting => ({
      ...base,
      id,
      kind: "run_fitting",
      fittingType: "elbow",
      label: `${angle}° elbow`,
      position: round3(at),
      angleDeg: angle,
      ports: [a, b],
      ...chooseFitting(system, "elbow", seg.domain, [seg.size], angle, undefined).fields,
    });
    put(ctx, elbow(e1, P, port("a", P, scale3(u, -1), { elementId: seg.id, port: "end" }), port("b", P, leg, { elementId: midId, port: "start" })));
    put(ctx, { ...base, id: midId, kind: "run_segment", start: P, end: Q, size: seg.size, links: { start: { elementId: e1, port: "b" }, end: { elementId: e2, port: "a" } }, branches: [], flow: 0 });
    put(ctx, elbow(e2, Q, port("a", Q, scale3(leg, -1), { elementId: midId, port: "end" }), port("b", Q, u, { elementId: tailId, port: "start" })));
    headLink = { elementId: e1, port: "a" };
    tailStartLink = { elementId: e2, port: "b" };
  }
  const shift = along + s;
  const tail: RunSegment = {
    ...base,
    id: tailId,
    kind: "run_segment",
    start: Q,
    end: tailEnd,
    size: seg.size,
    links: { start: tailStartLink, ...(seg.links.end ? { end: seg.links.end } : {}) },
    branches: moving.map((b) => b.id),
    flow: 0,
  };
  put(ctx, tail);
  put(ctx, { ...seg, end: P, links: { ...seg.links, end: headLink }, branches: staying });
  // Whatever met the old end now meets the moved remainder.
  if (seg.links.end) {
    const far = ctx.working[seg.links.end.elementId];
    const relinked = far ? withLink(far, seg.links.end.port, { elementId: tailId, port: "end" }) : null;
    if (relinked) put(ctx, relinked);
  }
  // Branches past the jog: re-hosted on the remainder, moved by `d` with what hangs off them.
  const prop = new RunPropagator(ctx.reader, ctx.working, ctx.touched);
  prop.markFixed(seg.id);
  prop.markFixed(tailId);
  for (const b of moving) {
    const host = b.host;
    if (!host) continue;
    const moved: RunFitting = { ...b, host: { ...host, segmentId: tailId, s: Math.round((host.s - shift) * 1000) / 1000 }, position: round3(add3(b.position, d)), ports: b.ports.map((p) => ({ ...p, position: round3(add3(p.position, d)) })) };
    put(ctx, moved);
    prop.markFixed(b.id);
    const link = b.ports[0]?.link;
    if (link) prop.translateInto(link, d);
  }
  for (const id of [seg.id, tailId]) {
    const el = ctx.working[id];
    if (el?.kind !== "run_segment") continue;
    const room = roomForFittings(ctx.working, el);
    if (room) refuse("min_straight_length", `The offset doesn't fit: the ${runLabel(ctx.working, el)} ${room}`, [seg.id]);
  }
  return tail;
}

function offsetCore(model: ModelState, prefix: string, segmentId: string, at: number, d: RunPoint, lengthMm: number | undefined, style: OffsetStyle, what: string): ExecuteResult {
  const reader = new TrackedReader(model);
  const seg = requireKind(reader.get(asElementId(segmentId)), "run_segment");
  if (seg.domain !== "duct" && style === "ogee") refuse("unsupported_geometry", "Ogee offsets are duct fittings; offset pipe with 45° or 90° elbows", [seg.id]);
  if (seg.links.end) reader.get(seg.links.end.elementId);
  const ctx: JogContext = { reader, working: draftElements(model.elements), touched: new Set(), model, prefix, segCount: 0, fitCount: 0 };
  const tail = jog(ctx, seg, at, round3(d), style);
  const summary: string[] = [];
  if (lengthMm !== undefined) {
    jog(ctx, tail, lengthMm, round3(scale3(d, -1)), style);
    summary.push(`${what} for ${feet(lengthMm)}, then back in line; the ends stay where they were`);
  } else if (tail.links.end) {
    // Everything beyond moves with it, as a move would: square runs translate, runs along it stretch, fixed parts refuse.
    const prop = new RunPropagator(reader, ctx.working, ctx.touched);
    prop.markFixed(tail.id);
    prop.translateInto(tail.links.end, round3(d));
    summary.push(`${what} from ${feet(at)} on; what is connected beyond follows`);
  } else {
    summary.push(`${what} from ${feet(at)} to the open end`);
  }
  return finish(reader, ctx.working, ctx.touched, [], () => [], { summary });
}

function offsetRun(model: ModelState, cmd: Extract<FittingCommand, { type: "offset_run" }>): ExecuteResult {
  const d = p3(cmd.offset.x, cmd.offset.y, cmd.offset.z);
  const where = Math.abs(d.z) > 0.5 ? (d.z > 0 ? "Rises" : "Drops") : "Offsets sideways";
  return offsetCore(model, cmd.idPrefix, cmd.segmentId, cmd.atMm, d, cmd.lengthMm, cmd.style, `${where} ${feet(len3(d))}`);
}

function changeElevation(model: ModelState, cmd: Extract<FittingCommand, { type: "change_elevation" }>): ExecuteResult {
  const seg = requireKind(new TrackedReader(model).get(asElementId(cmd.segmentId)), "run_segment");
  if (Math.abs(seg.start.z - seg.end.z) > 0.5) refuse("unsupported_geometry", `${runLabel(model.elements, seg)} isn't level; change the height of a level run`, [seg.id]);
  const dz = cmd.elevationMm - seg.start.z;
  if (Math.abs(dz) <= model.settings.connectorToleranceMm) refuse("invalid_value", `${runLabel(model.elements, seg)} is already at ${feet(cmd.elevationMm)}`, [seg.id]);
  const along = cmd.style === "45" ? Math.abs(dz) : 0;
  if (cmd.toMm !== undefined && cmd.toMm <= cmd.fromMm + 2 * along) refuse("invalid_value", `The stretch from ${feet(cmd.fromMm)} to ${feet(cmd.toMm)} is too short to rise or drop ${feet(Math.abs(dz))} and come back`, [seg.id]);
  // The run is back at its old height by `toMm`: the return jog starts `along` before it.
  const lengthMm = cmd.toMm !== undefined ? cmd.toMm - cmd.fromMm - 2 * along : undefined;
  return offsetCore(model, cmd.idPrefix, cmd.segmentId, cmd.fromMm, p3(0, 0, dz), lengthMm, cmd.style, `${dz > 0 ? "Rises" : "Drops"} to ${feet(cmd.elevationMm)}`);
}

export function executeFittingCommand(model: ModelState, command: FittingCommand): ExecuteResult {
  switch (command.type) {
    case "swap_fitting":
      return swapFitting(model, command);
    case "set_fitting_coefficient":
      return setCoefficient(model, command);
    case "set_system_design":
      return setSystemDesign(model, command);
    case "offset_run":
      return offsetRun(model, command);
    case "change_elevation":
      return changeElevation(model, command);
    case "set_slope":
    case "place_run_accessory":
      return executePipeCommand(model, command);
  }
}
