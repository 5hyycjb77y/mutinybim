import { z } from "zod";
import { canonicalJson } from "./canonical";
import { round, roundVec } from "./geometry";
import { TrackedReader, requireKind } from "./model";
import { networkOf } from "./network";
import { TranslateWorkingCopy } from "./solver";
import { carryJoinedEndsOfMove } from "./joins/carry";
import { translatedFlatLine } from "./placement/line-face";
import { draftElements, elementValues, elementsOfKind } from "./store";
import type { PlannedPlacement } from "./placement/types";
import {
  disciplineOfCategory,
  instanceValueIssues,
  paramValueSchema,
  partTypeDefinitionSchema,
  partTypeIssues,
} from "./parts";
import { GLOBAL_PARTITION, disciplineSchema } from "./partition";
import { authoredFieldValue, finish, refuse, type AuthoredWrite, type ExecuteResult, type IntentPredicate } from "./command-core";
import { elementKindTable, type ElementKindItem, type ElementKindValue } from "./registry/element-kind-point";
import { kindRowOf, storedField, writeKindValue } from "./kinds";
import { isEmptyStarterLevel } from "./commands/levels";
import {
  asElementId,
  type BimElement,
  type Connection,
  type ElementId,
  type Level,
  type ModelState,
  type ParamValue,
  type PartInstance,
  type PartTypeElement,
  type Vec2,
} from "./types";
import type { Changeset } from "./changeset";
import type { MergeWrite } from "./branches/merge-types";
import { RunPropagator, carryConnectedRuns } from "./routing/propagate";
import { applyRunDelete, planRunDelete, runDependents, runsReferencing } from "./routing/delete";
import { runLabel } from "./routing/validate";
import { organizationUsers } from "./organization/commands";
import { applyServiceDelete, planServiceDelete } from "./connections/delete";
import { serviceDependents } from "./connections/validate";
import { serviceLinkName, translateThroughNetworks } from "./connections/model";
import { catalogEntryName } from "./catalog/model";
import { adoptPartStarterConnectionType } from "./load-points/adopt-starter";
import { isKernelElementKind } from "./registry/element-kinds";
import { MAX_CURB_MM, partHostSchema, partsHostedOn } from "./spatial";
import { documentIndex } from "./commands/views";
import { PART_MOUNTS, type PartMount } from "./part-mount";
import { INTAKE_KINDS, INTAKE_LABELS, takesIntake, type IntakeChoice } from "./part-model/intake-hood";
import { onMountingPlane } from "./mounting-plane";
import { PACK_PARAMETER_KEY, resolveConnectors } from "./parts";

const idSchema = z.string().min(1).max(200);
const vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() });
const PARAM_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/** Commands that work on any part, in any discipline. */
export const partCommandSchemas = [
  z.object({
    type: z.literal("place_part"),
    /** Chosen by the sender so a retried request places the same part, not a second one. */
    partId: idSchema,
    typeId: idSchema,
    /** The type's definition, when the model does not have this type yet (it is pinned into the model). */
    partType: partTypeDefinitionSchema.optional(),
    levelId: idSchema,
    /** The discipline it is filed under (a registered id, e.g. an add-on's); default: its category's. */
    discipline: disciplineSchema.optional(),
    /** The area of the level it belongs to, for area loading (default Z1). */
    zone: z.string().min(1).max(40).optional(),
    position: vec2Schema,
    offsetMm: z.number().finite().min(-100_000).max(100_000).optional(),
    rotationDeg: z.number().finite().min(-3600).max(3600).optional(),
    mark: z.string().max(40).optional(),
    values: z.record(z.string().regex(PARAM_NAME), paramValueSchema).optional(),
    /** The slab or roof it stands on (spatial.ts); its height is still offsetMm. */
    host: partHostSchema.optional(),
    /** Curb or rail height between the host and its base, mm. */
    curbMm: z.number().finite().min(0).max(MAX_CURB_MM).optional(),
    /** Turned over or on its side relative to how the type is drawn (part-mount.ts). Absent: as drawn. */
    mount: z.enum(PART_MOUNTS).optional(),
    /** Hood, louver or screen per duct opening, over the type's ("none" takes the type's off). */
    intakes: z.record(z.string().min(1).max(40), z.enum([...INTAKE_KINDS, "none"])).optional(),
    /** Place it on this mounting plane: its height is the plane's, and it moves with the plane. Not with offsetMm. */
    planeId: idSchema.optional(),
  }),
  z.object({
    type: z.literal("move_elements"),
    ids: z.array(idSchema).min(1).max(500),
    delta: vec2Schema,
    /** Vertical move of parts relative to their level. */
    dzMm: z.number().finite().min(-100_000).max(100_000).optional(),
    /** Leave walls (any joined line) joined to what moves where they are (Revit's Disjoin); absent: their joined ends follow. */
    disjoin: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("rotate_elements"),
    ids: z.array(idSchema).min(1).max(500),
    angleDeg: z.number().finite().min(-3600).max(3600),
    /** Pivot in plan; default: the part's own insertion point (one part) or the parts' centroid. */
    about: vec2Schema.optional(),
  }),
  z.object({
    type: z.literal("copy_elements"),
    ids: z.array(idSchema).min(1).max(200),
    /** Ids for the copies, one per source, chosen by the sender (idempotent retries). */
    newIds: z.array(idSchema).min(1).max(200),
    delta: vec2Schema,
  }),
  z.object({
    type: z.literal("delete_elements"),
    ids: z.array(idSchema).min(1).max(500),
    /**
     * What happens to things that depend on what you delete:
     * refuse: nothing is deleted and the dependents are listed;
     * disconnect: connections are cut, other dependents still refuse;
     * cascade: dependents (tags, hosted parts, a type's parts) are deleted too and connections cut.
     */
    policy: z.enum(["refuse", "disconnect", "cascade"]),
  }),
  z.object({
    type: z.literal("set_parameters"),
    id: idSchema,
    /** instance: this part's own values. type: the part type's values, which every instance of it shares. */
    scope: z.enum(["instance", "type"]),
    /** null clears a value back to the type's value or default. */
    /** Type parameter names. A pack parameter (`civil.invert_elevation`) is refused with a pointer: it is set with set_element_values. */
    values: z.record(z.union([z.string().regex(PARAM_NAME), z.string().regex(PACK_PARAMETER_KEY)]), z.union([paramValueSchema, z.null()])).optional(),
    mark: z.string().max(40).optional(),
    /** Instance scope: turn the part over or onto its side ("as_drawn" puts it back). Disconnect its runs first. */
    mount: z.enum(["as_drawn", ...PART_MOUNTS]).optional(),
    /** Instance scope: hood, louver or screen per duct opening ("none" takes the type's off, null goes back to the type's). */
    intakes: z.record(z.string().min(1).max(40), z.union([z.enum([...INTAKE_KINDS, "none"]), z.null()])).optional(),
  }),
  z.object({
    type: z.literal("plan_part"),
    /** Chosen by the sender so a retried request plans the same part, not a second one. */
    partId: idSchema,
    typeId: idSchema,
    /** The type's definition, when the model does not have this type yet (it is pinned into the model). */
    partType: partTypeDefinitionSchema.optional(),
    mark: z.string().max(40).optional(),
    values: z.record(z.string().regex(PARAM_NAME), paramValueSchema).optional(),
    /** The area of the level it belongs to, for area loading (default Z1). */
    zone: z.string().min(1).max(40).optional(),
    /** The level it will probably go on. Not a location: it is not drawn there. */
    levelHint: idSchema.optional(),
    /** The space it serves or will sit in. */
    spaceHint: idSchema.optional(),
    /** The discipline it is filed under (a registered id, e.g. an add-on's); default: its category's. */
    discipline: disciplineSchema.optional(),
    note: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal("place_planned_part"),
    partId: idSchema,
    levelId: idSchema,
    position: vec2Schema,
    offsetMm: z.number().finite().min(-100_000).max(100_000).optional(),
    rotationDeg: z.number().finite().min(-3600).max(3600).optional(),
    zone: z.string().min(1).max(40).optional(),
    host: partHostSchema.optional(),
    curbMm: z.number().finite().min(0).max(MAX_CURB_MM).optional(),
    planeId: idSchema.optional(),
  }),
  z.object({
    type: z.literal("unplace_part"),
    partId: idSchema,
    note: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal("create_level"),
    levelId: idSchema,
    name: z.string().trim().min(1).max(40),
    elevationMm: z.number().finite().min(-1_000_000).max(1_000_000),
  }),
  z.object({
    type: z.literal("undo"),
    /** The revision to undo: one of your own changes. Undoing an undo is redo. */
    revision: z.number().int().min(1),
  }),
] as const;

export const partCommandSchema = z.discriminatedUnion("type", [...partCommandSchemas]);
export type PartCommand = z.infer<typeof partCommandSchema>;

export interface CommandContext {
  /** Committed changesets from the undo target revision onward (undo only). */
  readonly history?: readonly Changeset[];
  /** Who is asking (undo only: you may undo only your own changes). */
  readonly actorId?: string;
  /** The checked actor deciding the command (questions record who asked, answered and replied). */
  readonly actor?: { readonly id: string; readonly name: string; readonly kind: "human" | "agent" };
  /** Now, ISO 8601, from the deciding host (questions stamp their thread records with it). */
  readonly at?: string;
  /**
   * `merge_branch_part` only: the part's records and connections, supplied by
   * the model server after it recomputed the merge. A client can't send them.
   */
  readonly mergeLanding?: MergeLanding;
  /** `import_elements` only: one chunk of a linked model's converted records, from the model server's own conversion (import/apply.ts). */
  readonly importLanding?: { readonly records: readonly BimElement[] };
}

/** What one merged part writes on Main (the model server's `MainLander`). */
export interface MergeLanding {
  readonly writes: readonly MergeWrite[];
  readonly add: readonly Connection[];
  readonly remove: readonly Connection[];
}

const NO_INTENTS = (): IntentPredicate[] => [];

function fieldIntents(authored: readonly AuthoredWrite[]): () => IntentPredicate[] {
  return () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value }));
}

function uniqueIds(ids: readonly string[], what: string): ElementId[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) refuse("invalid_value", `${id} is listed twice in the ${what}`, [asElementId(id)]);
    seen.add(id);
  }
  return ids.map(asElementId);
}

function normalizeDeg(deg: number): number {
  const r = round(((deg % 360) + 360) % 360, 6);
  return r === 360 ? 0 : r;
}

function rotateAbout(p: Vec2, about: Vec2, deg: number): Vec2 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return roundVec({ x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c });
}

function label(el: BimElement): string {
  switch (el.kind) {
    case "part":
      return el.mark ? `${el.mark}` : el.id;
    case "part_type":
      return el.definition.typeName;
    case "level":
      return `level ${el.name}`;
    case "tag":
      return `tag ${el.id}`;
    case "dimension":
      return `dimension ${el.id}`;
    case "run_segment":
    case "run_fitting":
      return `the ${runLabel({}, el)}`;
    case "mep_system":
      return `system ${el.name}`;
    case "service_link":
      return serviceLinkName({}, el);
    case "service_catalog":
      return `${el.entry.type.replace(/_/g, " ")} ${catalogEntryName(el.entry)}`;
    default: {
      // An add-on's kind by what its row calls it ("unit RTU-1"); one no add-on here registers, by its stored kind.
      const row = elementKindTable().row(el.kind);
      return `${row ? row.label.toLowerCase() : el.kind.replace(/_/g, " ")} ${el.id}`;
    }
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Parts using a level or a type. Scans the model: only deletes and undo of a level or type need it. */
function partsReferencing(model: ModelState, ids: ReadonlySet<string>): PartInstance[] {
  const out: PartInstance[] = [];
  for (const el of elementValues(model.elements)) {
    if (el.kind === "part" && (ids.has(el.typeId) || ids.has(el.levelId))) out.push(el);
  }
  return out;
}

/** Everything held by a level, type or system: its parts and its runs. One pass over the model. */
function membersOf(model: ModelState, ids: ReadonlySet<string>): ElementId[] {
  const all = elementValues(model.elements);
  return [...partsReferencing(model, ids).map((p) => p.id), ...runsReferencing(ids, all)];
}

/** A part's hood / louver / screen choices, checked against its type's duct openings. */
function intakeChoices(type: PartTypeElement, asked: Readonly<Record<string, IntakeChoice | null>>, partId: ElementId, current: Readonly<Record<string, IntakeChoice>> = {}): Record<string, IntakeChoice> {
  const connectors = resolveConnectors(type.definition);
  const next: Record<string, IntakeChoice> = { ...current };
  for (const [id, choice] of Object.entries(asked)) {
    const c = connectors.find((x) => x.id === id);
    if (!c) refuse("element_not_found", `${type.definition.typeName} has no connector ${id}; its connectors are ${connectors.map((x) => x.id).join(", ") || "none"}`, [partId]);
    if (choice !== null && choice !== "none" && !takesIntake(c)) refuse("invalid_value", `${c.label} isn't a duct opening to outdoors (outdoor air or exhaust), so it takes no ${INTAKE_LABELS[choice].toLowerCase()}`, [partId]);
    if (choice === null || (choice === "none" && !c.intake)) delete next[id];
    else next[id] = choice;
  }
  return next;
}

/** The part type a new part uses: the model's, or the sent definition pinned into the model. */
function partTypeFor(reader: TrackedReader, working: Record<string, BimElement>, touched: ElementId[], command: { readonly typeId: string; readonly partType?: Extract<PartCommand, { type: "place_part" }>["partType"] }, verb: string): PartTypeElement {
  const typeId = asElementId(command.typeId);
  const existing = reader.find(typeId);
  if (existing) {
    const type = requireKind(existing, "part_type");
    if (command.partType && canonicalJson(command.partType) !== canonicalJson(type.definition)) {
      refuse("already_exists", `This model already has a different part type with id ${command.typeId}; ${verb} that one or use a new type id`, [typeId]);
    }
    return type;
  }
  if (!command.partType) {
    refuse("element_not_found", `Part type ${command.typeId} isn't in this model yet; send its definition with the ${verb === "place" ? "placement" : "plan"} to add it`, [typeId]);
  }
  const first = partTypeIssues(command.partType)[0];
  if (first) refuse("invalid_value", `${command.partType.typeName}: ${first.message}`, [typeId]);
  const type: PartTypeElement = { id: typeId, kind: "part_type", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, definition: command.partType };
  working[typeId] = type;
  touched.push(typeId);
  return type;
}

/** The height a part placed at `position` on `level` takes: its own, or its mounting plane's. */
function placedHeight(reader: TrackedReader, level: Level, position: Vec2, offsetMm: number | undefined, planeId: string | undefined): number {
  if (planeId === undefined) return offsetMm ?? 0;
  const plane = requireKind(reader.get(asElementId(planeId)), "mounting_plane");
  if (offsetMm !== undefined) refuse("invalid_value", `A part on ${plane.name} takes the plane's height; leave out the height`, [plane.id]);
  if (plane.levelId !== level.id) refuse("invalid_value", `${plane.name} is on another level; place the part on that level`, [plane.id]);
  if (!onMountingPlane(plane, position)) refuse("outside_host", `That point isn't on ${plane.name}; place the part inside its rectangle, or make the plane bigger`, [plane.id]);
  return plane.heightMm;
}

function placePart(model: ModelState, command: Extract<PartCommand, { type: "place_part" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const partId = asElementId(command.partId);
  const typeId = asElementId(command.typeId);
  if (reader.find(partId)) refuse("already_exists", `${command.partId} already exists; choose a new id`, [partId]);
  const working = draftElements(model.elements);
  const touched: ElementId[] = [partId];
  const type = partTypeFor(reader, working, touched, command, "place");
  const level = requireKind(reader.get(asElementId(command.levelId)), "level");
  const values = command.values ?? {};
  const bad = instanceValueIssues(type.definition, values)[0];
  if (bad) refuse("invalid_value", `${type.definition.typeName}: ${bad.message}`, [partId]);
  const offsetMm = placedHeight(reader, level, command.position, command.offsetMm, command.planeId);
  const intakes = intakeChoices(type, command.intakes ?? {}, partId);
  const part: PartInstance = {
    id: partId,
    kind: "part",
    version: 0,
    authoredRev: {},
    partition: { level: level.name, zone: command.zone ?? "Z1", discipline: command.discipline ?? disciplineOfCategory(type.definition.category) },
    typeId,
    levelId: level.id,
    position: roundVec(command.position),
    offsetMm: round(offsetMm),
    rotationDeg: normalizeDeg(command.rotationDeg ?? 0),
    mark: command.mark ?? "",
    values,
    ...(command.host ? { host: command.host } : {}),
    ...(command.curbMm ? { curbMm: round(command.curbMm) } : {}),
    ...(command.mount ? { mount: command.mount } : {}),
    ...(Object.keys(intakes).length > 0 ? { intakes } : {}),
    ...(command.planeId !== undefined ? { planeId: asElementId(command.planeId) } : {}),
  };
  if (command.host?.kind === "slab" && reader.find(asElementId(command.host.elementId))?.kind !== "slab") refuse("element_not_found", `There is no slab ${command.host.elementId} to stand ${command.mark || "the part"} on`, [partId]);
  working[partId] = part;
  const authored: AuthoredWrite[] = [{ elementId: partId, field: "position", value: part.position }];
  const adopted = adoptPartStarterConnectionType(reader, working, touched, authored, type.definition.typeValues, values);
  return finish(reader, working, touched, authored, NO_INTENTS, adopted ? { summary: [adopted] } : {});
}

function moveElements(model: ModelState, command: Extract<PartCommand, { type: "move_elements" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const ids = uniqueIds(command.ids, "move");
  const d = roundVec(command.delta);
  const dz = round(command.dzMm ?? 0);
  const authored: AuthoredWrite[] = [];
  const p = new TranslateWorkingCopy(reader, authored);
  const runs = new RunPropagator(reader, p.working, p.touched, new Set(ids));
  // Selected run pieces move whole first, so the parts and runs pushed afterwards find them already moved.
  const runIds = ids.filter((id) => {
    const kind = p.current(id).kind;
    return kind === "run_segment" || kind === "run_fitting";
  });
  if (runIds.length > 0) {
    if (dz !== 0) refuse("unsupported_geometry", "Runs have no height of their own to change here; use Change height on the run, or move only parts up and down", runIds);
    const d3 = { x: d.x, y: d.y, z: 0 };
    for (const id of runIds) runs.moveWhole(id, d3);
    for (const id of runIds) runs.pushOutOf(id, d3);
  }
  for (const id of ids) {
    const el = p.current(id);
    if (el.kind === "run_segment" || el.kind === "run_fitting") continue;
    if (dz !== 0 && el.kind !== "part") refuse("unsupported_geometry", `${label(el)} has no height of its own to change; only parts move up and down`, [id]);
    switch (el.kind) {
      case "part": {
        refusePlanned(el, "moved");
        const position = roundVec({ x: el.position.x + d.x, y: el.position.y + d.y });
        const offsetMm = round(el.offsetMm + dz);
        p.set({ ...el, position, offsetMm });
        authored.push({ elementId: id, field: "position", value: position });
        if (dz !== 0) authored.push({ elementId: id, field: "offsetMm", value: offsetMm });
        carryConnectedRuns(runs, el, { x: d.x, y: d.y, z: dz });
        break;
      }
      case "wall": {
        const next = translatedFlatLine(el, d, el.thickness);
        p.set(next);
        for (const dep of networkOf(model).dependents(el.id)) reader.get(dep);
        authored.push({ elementId: id, field: "start", value: next.start }, { elementId: id, field: "end", value: next.end });
        break;
      }
      case "component":
        p.set({ ...el, position: roundVec({ x: el.position.x + d.x, y: el.position.y + d.y }) });
        break;
      default:
        // An add-on's network moves its own elements and what follows them (`translate`, contract 1.10.0).
        if (translateThroughNetworks(p, id, d)) break;
        if (!isKernelElementKind(el.kind) && kindRowOf(el.kind) === undefined) refuse("wrong_kind", `${label(el)} belongs to an add-on that isn't loaded here, so it can't be moved`, [id]);
        refuse("wrong_kind", `${label(el)} can't be moved on its own; it moves with what it is connected to or hosted on`, [id]);
    }
  }
  // Walls (any joined line) carry the ends joined to them, so corners and tees stay closed.
  if ((d.x !== 0 || d.y !== 0) && command.disjoin !== true) carryJoinedEndsOfMove(model, reader, p.working, p.touched, authored, new Map(ids.map((id) => [id as string, d] as const)));
  return finish(reader, p.working, p.touched, authored, fieldIntents(authored));
}


function rotateElements(model: ModelState, command: Extract<PartCommand, { type: "rotate_elements" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const ids = uniqueIds(command.ids, "rotation");
  const parts = ids.map((id) => {
    const el = reader.get(id);
    if (el.kind !== "part") refuse("wrong_kind", `${label(el)} can't be rotated yet; rotation works on placed parts`, [id]);
    refusePlanned(el, "rotated");
    if (el.links && Object.keys(el.links).length > 0) refuse("anchored_would_move", `${label(el)} has runs connected to it; disconnect them before rotating it`, [id]);
    return el;
  });
  const about =
    command.about ??
    (parts.length === 1 && parts[0]
      ? parts[0].position
      : { x: parts.reduce((s, q) => s + q.position.x, 0) / parts.length, y: parts.reduce((s, q) => s + q.position.y, 0) / parts.length });
  const working = draftElements(model.elements);
  const authored: AuthoredWrite[] = [];
  for (const part of parts) {
    const position = rotateAbout(part.position, about, command.angleDeg);
    const rotationDeg = normalizeDeg(part.rotationDeg + command.angleDeg);
    working[part.id] = { ...part, position, rotationDeg };
    authored.push({ elementId: part.id, field: "position", value: position }, { elementId: part.id, field: "rotationDeg", value: rotationDeg });
  }
  return finish(reader, working, ids, authored, fieldIntents(authored));
}

function copyElements(model: ModelState, command: Extract<PartCommand, { type: "copy_elements" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const ids = uniqueIds(command.ids, "copy");
  const newIds = uniqueIds(command.newIds, "copy's new ids");
  if (newIds.length !== ids.length) refuse("invalid_value", `Give one new id per part copied (${ids.length} parts, ${newIds.length} ids)`);
  const d = roundVec(command.delta);
  const working = draftElements(model.elements);
  ids.forEach((id, i) => {
    const src = reader.get(id);
    if (src.kind !== "part") refuse("wrong_kind", `${label(src)} can't be copied yet; copy works on placed parts`, [id]);
    const newId = newIds[i] ?? refuse("invalid_value", "Missing new id");
    if (reader.find(newId) || ids.includes(newId)) refuse("already_exists", `${newId} already exists; choose a new id for the copy`, [newId]);
    // A copy is connected to nothing and on no circuit, so it also drops the typed text that stands in for those links.
    const { links: _connected, served: _served, feeds: _feeds, ...unconnected } = src;
    const { circuit: _circuit, fed_from: _fedFrom, ...values } = src.values;
    working[newId] = {
      ...unconnected,
      values,
      id: newId,
      version: 0,
      authoredRev: {},
      position: roundVec({ x: src.position.x + d.x, y: src.position.y + d.y }),
      // Marks identify one part on drawings and schedules; a copy starts without one.
      mark: "",
    };
  });
  return finish(reader, working, newIds, [], NO_INTENTS);
}

interface DeletePlan {
  readonly removed: Set<ElementId>;
  readonly connections: Connection[];
  /** Dependents outside the deleted set (refuse / disconnect). */
  readonly blocking: ElementId[];
}

function planDelete(reader: TrackedReader, requested: readonly ElementId[], policy: "refuse" | "disconnect" | "cascade"): DeletePlan {
  const model = reader.model;
  const net = networkOf(model);
  const removed = new Set<ElementId>(requested);
  for (const id of requested) reader.get(id);
  const dependentsOf = (id: ElementId): ElementId[] => {
    const el = model.elements[id];
    const out: ElementId[] = [...net.dependents(id)];
    // Records hosted on it (a branch takeoff on its run) go with it.
    out.push(...net.hostedTaps(id));
    out.push(...runDependents(el));
    out.push(...serviceDependents(el));
    // A sheet's viewports and notes, and a view's viewport and notes, point at it. (A load point outlives its pipe: it is flagged, not deleted.)
    if (el?.kind === "sheet" || el?.kind === "view") {
      const docs = documentIndex(model);
      if (el.kind === "sheet") for (const vp of docs.viewportsBySheet.get(id) ?? []) out.push(vp.id);
      else {
        const vp = docs.viewportByView.get(id);
        if (vp) out.push(vp.id);
      }
      for (const item of docs.itemsByOwner.get(id) ?? []) out.push(item.id);
    }
    return out;
  };
  // Levels, types and systems hold parts and runs; finding those needs one pass over the model.
  const holders = (set: ReadonlySet<ElementId>): Set<string> =>
    new Set([...set].filter((id) => {
      const k = model.elements[id]?.kind;
      return k === "level" || k === "part_type" || k === "mep_system";
    }));
  const blocking = new Set<ElementId>();
  if (policy === "cascade") {
    let frontier = [...removed];
    let scannedHolders = new Set<string>();
    while (frontier.length > 0) {
      const next: ElementId[] = [];
      for (const id of frontier) {
        for (const dep of dependentsOf(id)) {
          if (!removed.has(dep)) {
            removed.add(dep);
            reader.get(dep);
            next.push(dep);
          }
        }
      }
      const newHolders = new Set([...holders(removed)].filter((h) => !scannedHolders.has(h)));
      if (newHolders.size > 0) {
        for (const member of membersOf(model, newHolders)) {
          if (!removed.has(member)) {
            removed.add(member);
            reader.get(member);
            next.push(member);
          }
        }
        scannedHolders = new Set([...scannedHolders, ...newHolders]);
      }
      frontier = next;
    }
  } else {
    for (const id of removed) for (const dep of dependentsOf(id)) if (!removed.has(dep)) blocking.add(dep);
    const h = holders(removed);
    if (h.size > 0) for (const member of membersOf(model, h)) if (!removed.has(member)) blocking.add(member);
  }
  const connections = new Map<string, Connection>();
  for (const id of removed) for (const c of net.connectionsOf(id)) connections.set(c.id, c);
  return { removed, connections: [...connections.values()], blocking: [...blocking] };
}

function deleteElements(model: ModelState, command: Extract<PartCommand, { type: "delete_elements" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const ids = uniqueIds(command.ids, "delete");
  const plan = planDelete(reader, ids, command.policy);
  // The starter Level 1 is the empty model's only floor: it goes once there is another level to draw on.
  for (const id of plan.removed) {
    const el = model.elements[id];
    if (el?.kind !== "level" || !el.starter) continue;
    if (!elementValues(model.elements).some((other) => other.kind === "level" && !plan.removed.has(other.id))) {
      refuse("invalid_value", `${el.name} is the model's only level, and everything is drawn on a level. Add another level first, then delete this one (or rename it)`, [el.id]);
    }
  }
  const runPlan = planRunDelete(reader, plan.removed);
  const servicePlan = planServiceDelete(reader, plan.removed);
  const cutsOutside = [
    ...plan.connections.filter((c) => !plan.removed.has(c.a.elementId) || !plan.removed.has(c.b.elementId)),
    ...runPlan.cuts,
    ...servicePlan.cuts,
  ];
  if (plan.blocking.length > 0 || (command.policy === "refuse" && cutsOutside.length > 0)) {
    const what: string[] = [];
    if (plan.blocking.length > 0) {
      const names = plan.blocking.slice(0, 5).map((id) => label(reader.get(id)));
      what.push(`${plural(plan.blocking.length, "item")} that depend on it (${names.join(", ")}${plan.blocking.length > 5 ? ", …" : ""})`);
    }
    if (command.policy === "refuse" && cutsOutside.length > 0) what.push(plural(cutsOutside.length, "connection"));
    const options = command.policy === "refuse" ? "Delete them too, or cut the connections and keep the rest" : "Delete them too";
    refuse("has_dependents", `Nothing deleted: this would leave ${what.join(" and ")} pointing at nothing. ${options}.`, [...plan.blocking, ...ids]);
  }
  const working = draftElements(model.elements);
  for (const id of plan.removed) delete working[id];
  // A sheet that stays no longer lists a deleted view.
  const sheetsTouched: ElementId[] = [];
  for (const id of plan.removed) {
    if (model.elements[id]?.kind !== "view") continue;
    const vp = documentIndex(model).viewportByView.get(id);
    const sheet = vp ? working[vp.sheetId] : undefined;
    if (sheet?.kind !== "sheet" || !sheet.viewIds.includes(id)) continue;
    reader.get(sheet.id);
    working[sheet.id] = { ...sheet, viewIds: sheet.viewIds.filter((v) => !plan.removed.has(v as ElementId)) };
    sheetsTouched.push(sheet.id);
  }
  // Runs: cut links to what stays; cascade caps the run ends it leaves open. Trunks stay whole when a branch goes.
  const runs = applyRunDelete(working, runPlan, command.policy === "cascade");
  const served = applyServiceDelete(reader, working, plan.removed, servicePlan);
  // Parts that stood on a deleted slab stay where they are; their host now names a slab that is gone.
  const stranded = partsHostedOn(model, plan.removed);
  const summary = [...runs.summary, ...(stranded.length > 0 ? [`${plural(stranded.length, "part")} stood on it and now ${stranded.length === 1 ? "has" : "have"} nothing under ${stranded.length === 1 ? "it" : "them"}`] : [])];
  return finish(reader, working, [...runs.touched, ...served, ...sheetsTouched], [], NO_INTENTS, { removedIds: [...plan.removed], removedConnections: plan.connections, ...(summary.length > 0 ? { summary } : {}) });
}

function mergeValues(
  current: Readonly<Record<string, ParamValue>>,
  changes: Readonly<Record<string, ParamValue | null>>,
): Record<string, ParamValue> {
  const next: Record<string, ParamValue> = { ...current };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next;
}

function setParameters(model: ModelState, command: Extract<PartCommand, { type: "set_parameters" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const el = reader.get(asElementId(command.id));
  const changes = command.values ?? {};
  const packKey = Object.keys(changes).find((k) => PACK_PARAMETER_KEY.test(k));
  if (packKey !== undefined) refuse("invalid_value", `${packKey} is a pack parameter, not one of the part type's; set it with set_element_values`, [el.id]);
  if (Object.keys(changes).length === 0 && command.mark === undefined && command.mount === undefined && command.intakes === undefined) refuse("invalid_value", "Nothing to change: give at least one value");
  const working = draftElements(model.elements);
  const authored: AuthoredWrite[] = [];
  if (command.scope === "type") {
    if (command.mark !== undefined) refuse("invalid_value", "Mark belongs to each part, not its type; change it on the part");
    if (command.mount !== undefined || command.intakes !== undefined) refuse("invalid_value", "Mount and hoods are set on each part, not its type; change them with scope instance");
    const type = el.kind === "part" ? requireKind(reader.get(el.typeId), "part_type") : requireKind(el, "part_type");
    const typeValues = mergeValues(type.definition.typeValues, changes);
    const known = new Set(type.definition.typeParams.map((p) => p.name));
    for (const name of Object.keys(changes)) {
      if (!known.has(name)) {
        const isInstance = type.definition.instanceParams.some((p) => p.name === name);
        refuse("invalid_value", isInstance ? `${name} is set on each part, not on the type` : `${type.definition.typeName} has no type parameter ${name}`, [type.id]);
      }
    }
    const definition = { ...type.definition, typeValues };
    const first = partTypeIssues(definition)[0];
    if (first) refuse("invalid_value", `${definition.typeName}: ${first.message}`, [type.id]);
    working[type.id] = { ...type, definition };
    for (const name of Object.keys(changes)) {
      const v = typeValues[name];
      if (v !== undefined) authored.push({ elementId: type.id, field: `typeValues.${name}`, value: v });
    }
    return finish(reader, working, [type.id], authored, fieldIntents(authored));
  }
  if ((command.mount !== undefined || command.intakes !== undefined) && el.kind !== "part") refuse("wrong_kind", `${label(el)} isn't a placed part, so it has no mount or hood to set`, [el.id]);
  switch (el.kind) {
    case "part": {
      const type = requireKind(reader.get(el.typeId), "part_type");
      const values = mergeValues(el.values, changes);
      const bad = instanceValueIssues(type.definition, values)[0];
      if (bad) refuse("invalid_value", `${el.mark || type.definition.typeName}: ${bad.message}`, [el.id]);
      let next: PartInstance = { ...el, values, ...(command.mark !== undefined ? { mark: command.mark } : {}) };
      const mount: PartMount | undefined = command.mount === "as_drawn" ? undefined : (command.mount ?? el.mount);
      if (command.mount !== undefined && mount !== el.mount) {
        if (el.links && Object.keys(el.links).length > 0) refuse("anchored_would_move", `${label(el)} has runs connected to it; turning it moves its connectors, so disconnect them first`, [el.id]);
        const { mount: _was, ...rest } = next;
        next = mount ? { ...rest, mount } : rest;
        authored.push({ elementId: el.id, field: "mount", value: mount ?? "as_drawn" });
      }
      if (command.intakes !== undefined) {
        const intakes = intakeChoices(type, command.intakes, el.id, el.intakes);
        const { intakes: _was, ...rest } = next;
        next = Object.keys(intakes).length > 0 ? { ...rest, intakes } : rest;
        authored.push({ elementId: el.id, field: "intakes", value: canonicalJson(next.intakes ?? null) });
      }
      working[el.id] = next;
      for (const name of Object.keys(changes)) {
        const v = values[name];
        if (v !== undefined) authored.push({ elementId: el.id, field: `values.${name}`, value: v });
      }
      if (command.mark !== undefined) authored.push({ elementId: el.id, field: "mark", value: command.mark });
      return finish(reader, working, [el.id], authored, fieldIntents(authored));
    }
    default: {
      // A kind an add-on owns (a leaf or a unit of the original connected network): its own values and a mark, through the same command as any part.
      const row = elementKindTable().row(el.kind);
      if (!row?.values?.length || !("mark" in el) || typeof el.mark !== "string") return refuse("wrong_kind", `${label(el)} has no parameters to set here`, [el.id]);
      return setKindValues(reader, working, el, row, changes, command.mark, authored);
    }
  }
}

function withArticle(words: string): string {
  return `${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}`;
}

/** Set an add-on-owned kind's own values (by their stored name or key) and its mark, refused in words when the kind keeps no such value or a person doesn't set it. */
function setKindValues(reader: TrackedReader, working: Record<string, BimElement>, el: BimElement, row: ElementKindItem, changes: Readonly<Record<string, ParamValue | null>>, mark: string | undefined, authored: AuthoredWrite[]): ExecuteResult {
  const values = row.values ?? [];
  const settable = values.filter((v) => v.authored);
  const kindWords = row.label.toLowerCase();
  const nameOf = (v: ElementKindValue) => v.stored ?? v.key;
  if (settable.length === 0) {
    if (Object.keys(changes).length > 0) refuse("invalid_value", `This ${kindWords}'s ${(values[0]?.label ?? "value").toLowerCase()} comes from what it serves; only its mark can be set`, [el.id]);
    const current = storedField(el, "mark");
    const next = mark ?? (typeof current === "string" ? current : "");
    working[el.id] = Object.assign({}, el, { mark: next });
    authored.push({ elementId: el.id, field: "mark", value: next });
    return finish(reader, working, [el.id], authored, fieldIntents(authored));
  }
  const byName = new Map<string, ElementKindValue>(settable.flatMap((v) => [[nameOf(v), v] as const, [v.key, v] as const]));
  const extra = Object.keys(changes).filter((k) => !byName.has(k));
  if (extra.length > 0) refuse("invalid_value", `This ${kindWords} has only ${settable.map((v) => `${withArticle(v.label.toLowerCase())} (${nameOf(v)})`).join(", ")} value and a mark; ${extra.join(", ")} can't be set`, [el.id]);
  let next: BimElement = el;
  for (const [name, value] of Object.entries(changes)) {
    const spec = byName.get(name);
    if (!spec) continue;
    const inRange = typeof value === "number" && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max);
    if (!inRange) refuse("invalid_value", spec.min !== undefined && spec.max !== undefined ? `${spec.label} must be a number from ${spec.min} to ${spec.max} ${spec.unit}` : `${spec.label} must be a number`, [el.id]);
    if (typeof value !== "number") continue;
    next = writeKindValue(next, spec, value);
    authored.push({ elementId: el.id, field: nameOf(spec), value });
  }
  if (mark !== undefined) {
    next = Object.assign({}, next, { mark });
    authored.push({ elementId: el.id, field: "mark", value: mark });
  }
  working[el.id] = next;
  return finish(reader, working, [el.id], authored, fieldIntents(authored));
}

/** The level a planned part's placeholder fields name: its hint, else the lowest level. Old readers then see a real level. */
function placeholderLevel(reader: TrackedReader, hint: string | undefined): Level {
  if (hint !== undefined) {
    const el = reader.find(asElementId(hint));
    if (el?.kind !== "level") refuse("element_not_found", `There is no level ${hint} to plan it for; pick one of the model's levels or leave the level out`, [asElementId(hint)]);
    return el;
  }
  let lowest: Level | undefined;
  for (const level of elementsOfKind(reader.model.elements, "level")) if (!lowest || level.elevationMm < lowest.elevationMm) lowest = level;
  if (!lowest) refuse("element_not_found", "This model has no levels yet; add a level first so the planned part has a floor to go on later");
  reader.get(lowest.id);
  return lowest;
}

function planPart(model: ModelState, command: Extract<PartCommand, { type: "plan_part" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const partId = asElementId(command.partId);
  if (reader.find(partId)) refuse("already_exists", `${command.partId} already exists; choose a new id`, [partId]);
  const working = draftElements(model.elements);
  const touched: ElementId[] = [partId];
  const type = partTypeFor(reader, working, touched, command, "plan");
  const values = command.values ?? {};
  const bad = instanceValueIssues(type.definition, values)[0];
  if (bad) refuse("invalid_value", `${type.definition.typeName}: ${bad.message}`, [partId]);
  const level = placeholderLevel(reader, command.levelHint);
  if (command.spaceHint !== undefined && reader.find(asElementId(command.spaceHint))?.kind !== "space") {
    refuse("element_not_found", `There is no space ${command.spaceHint}; pick one of the model's spaces or leave the space out`, [asElementId(command.spaceHint)]);
  }
  const planned: PlannedPlacement = {
    ...(command.levelHint !== undefined ? { levelHint: level.id } : {}),
    ...(command.spaceHint !== undefined ? { spaceHint: asElementId(command.spaceHint) } : {}),
    ...(command.note !== undefined ? { note: command.note } : {}),
  };
  const part: PartInstance = {
    id: partId,
    kind: "part",
    version: 0,
    authoredRev: {},
    partition: { level: level.name, zone: command.zone ?? "Z1", discipline: command.discipline ?? disciplineOfCategory(type.definition.category) },
    typeId: type.id,
    // Placeholders (placement/types.ts): no geometry consumer reads these while `planned` is set.
    levelId: level.id,
    position: { x: 0, y: 0 },
    offsetMm: 0,
    rotationDeg: 0,
    mark: command.mark ?? "",
    values,
    planned,
  };
  working[partId] = part;
  const authored: AuthoredWrite[] = [];
  const adopted = adoptPartStarterConnectionType(reader, working, touched, authored, type.definition.typeValues, values);
  return finish(reader, working, touched, authored, NO_INTENTS, adopted ? { summary: [adopted] } : {});
}

function placePlannedPart(model: ModelState, command: Extract<PartCommand, { type: "place_planned_part" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const part = requireKind(reader.get(asElementId(command.partId)), "part");
  if (part.planned === undefined) refuse("invalid_value", `${label(part)} is already placed; move it instead`, [part.id]);
  const level = requireKind(reader.get(asElementId(command.levelId)), "level");
  const offsetMm = placedHeight(reader, level, command.position, command.offsetMm, command.planeId);
  if (command.host?.kind === "slab" && reader.find(asElementId(command.host.elementId))?.kind !== "slab") refuse("element_not_found", `There is no slab ${command.host.elementId} to stand ${part.mark || "the part"} on`, [part.id]);
  // Everything that points at it (circuits, served-from links, schedules) keeps working: same id, same links.
  const { planned: _planned, host: _host, planeId: _plane, curbMm: _curb, ...kept } = part;
  const curbMm = command.curbMm ?? part.curbMm;
  const placed: PartInstance = {
    ...kept,
    partition: { level: level.name, zone: command.zone ?? part.partition?.zone ?? "Z1", discipline: part.partition?.discipline ?? disciplineOfCategory(requireKind(reader.get(part.typeId), "part_type").definition.category) },
    levelId: level.id,
    position: roundVec(command.position),
    offsetMm: round(offsetMm),
    rotationDeg: normalizeDeg(command.rotationDeg ?? 0),
    ...(command.host ? { host: command.host } : {}),
    ...(curbMm ? { curbMm: round(curbMm) } : {}),
    ...(command.planeId !== undefined ? { planeId: asElementId(command.planeId) } : {}),
  };
  const working = draftElements(model.elements);
  working[part.id] = placed;
  const authored: AuthoredWrite[] = [{ elementId: part.id, field: "position", value: placed.position }];
  return finish(reader, working, [part.id], authored, NO_INTENTS);
}

function unplacePart(model: ModelState, command: Extract<PartCommand, { type: "unplace_part" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const part = requireKind(reader.get(asElementId(command.partId)), "part");
  if (part.planned !== undefined) refuse("invalid_value", `${label(part)} isn't placed yet, so there is nothing to take off the drawing`, [part.id]);
  const runs = Object.keys(part.links ?? {}).length;
  if (runs > 0) refuse("anchored_would_move", `${label(part)} has ${plural(runs, "run")} connected to it; disconnect ${runs === 1 ? "it" : "them"} first. Its circuits and served-from links stay either way`, [part.id]);
  // Placement-only facts go; circuits, served-from links, values and mark stay.
  const { host: _host, planeId: _plane, links: _links, ...kept } = part;
  const planned: PlannedPlacement = { levelHint: part.levelId, ...(command.note !== undefined ? { note: command.note } : {}) };
  const working = draftElements(model.elements);
  working[part.id] = { ...kept, position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0, planned };
  return finish(reader, working, [part.id], [], NO_INTENTS);
}

/** Moving, turning or copying needs a location; a planned part has none yet. */
function refusePlanned(el: BimElement, verb: string): void {
  if (el.kind === "part" && el.planned !== undefined) refuse("invalid_value", `${label(el)} isn't placed yet, so it can't be ${verb}; place it first (Not placed yet › Place)`, [el.id]);
}

function createLevel(model: ModelState, command: Extract<PartCommand, { type: "create_level" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const levelId = asElementId(command.levelId);
  if (reader.find(levelId)) refuse("already_exists", `${command.levelId} already exists; choose a new id`, [levelId]);
  // An empty starter level is a stand-in: a level made with its name replaces it, as the architect's levels do.
  let replaced: ElementId | null = null;
  for (const el of elementValues(model.elements)) {
    if (el.kind === "level" && el.name.toLowerCase() === command.name.toLowerCase()) {
      reader.get(el.id);
      if (isEmptyStarterLevel(model, el)) {
        replaced = el.id;
        continue;
      }
      refuse("already_exists", `There is already a level named ${el.name}`, [el.id]);
    }
  }
  const level: Level = {
    id: levelId,
    kind: "level",
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    name: command.name,
    elevationMm: round(command.elevationMm),
  };
  const working = draftElements(model.elements);
  working[levelId] = level;
  if (replaced === null) return finish(reader, working, [levelId], [], NO_INTENTS);
  delete working[replaced];
  return finish(reader, working, [levelId], [], NO_INTENTS, { removedIds: [replaced], summary: [`${command.name} replaces the empty starter level`] });
}

function touchedBy(cs: Changeset): ElementId[] {
  return [...cs.elements.map((el) => el.id), ...(cs.removedIds ?? [])];
}

/**
 * The changesets after `revision` whose effect still stands. A later change
 * that a standing undo has since undone, and that undo itself, cancel out
 * (undo, undo walks back in order); a redo (an undo of an undo) stands again.
 * An undo of `revision` itself or of anything before it is never cancelled.
 */
function standingSince(history: readonly Changeset[], revision: number): Changeset[] {
  const later = history.filter((cs) => cs.revision > revision).sort((a, b) => b.revision - a.revision);
  const cancelled = new Set<number>();
  const standing: Changeset[] = [];
  for (const cs of later) {
    if (cancelled.has(cs.revision)) continue;
    if (cs.command.type === "undo" && cs.command.revision > revision) {
      cancelled.add(cs.command.revision);
      continue;
    }
    standing.push(cs);
  }
  return standing;
}

/**
 * Collaborative undo: apply the inverse of one of your own changes against the
 * current revision. Refused, and nothing changes, when anyone has changed any
 * of the same elements since.
 */
function undo(model: ModelState, command: Extract<PartCommand, { type: "undo" }>, context: CommandContext): ExecuteResult {
  const reader = new TrackedReader(model);
  const history = context.history ?? [];
  const target = history.find((cs) => cs.revision === command.revision);
  if (!target) refuse("undo_refused", `Revision ${command.revision} is not in the recent history, so it can't be undone here`);
  if (context.actorId !== undefined && target.actor.id !== context.actorId) {
    refuse("undo_refused", `You can only undo your own changes; ${target.actor.name} made revision ${target.revision}`);
  }
  const before = target.before;
  if (!before) refuse("undo_refused", `Revision ${target.revision} was saved before undo was available, so it can't be undone`);
  const affected = new Set(Object.keys(before));
  for (const cs of standingSince(history, target.revision)) {
    const overlap = touchedBy(cs).filter((id) => affected.has(id));
    if (overlap.length === 0) continue;
    const message =
      cs.actor.id === target.actor.id
        ? `You changed this again in revision ${cs.revision}; undo that first`
        : `${cs.actor.name} changed this since (revision ${cs.revision}); undo would overwrite their work`;
    refuse("undo_refused", message, overlap);
  }
  const working = draftElements(model.elements);
  const removed: ElementId[] = [];
  const restored: ElementId[] = [];
  for (const [rawId, prior] of Object.entries(before)) {
    const id = asElementId(rawId);
    if (prior === null) {
      if (reader.find(id)) {
        delete working[id];
        removed.push(id);
      }
      continue;
    }
    reader.find(id);
    working[id] = prior;
    restored.push(id);
  }
  // A type or level this change created may since be used by someone else's part.
  const holders = new Set(removed.filter((id) => {
    const k = model.elements[id]?.kind;
    return k === "level" || k === "part_type" || k === "mep_system";
  }));
  if (holders.size > 0) {
    const users = membersOf(model, holders).filter((id) => !removed.includes(id));
    if (users.length > 0) {
      const parts = users.filter((id) => model.elements[id]?.kind === "part").length;
      const runs = users.length - parts;
      const who = [parts > 0 ? plural(parts, "other part") : "", runs > 0 ? plural(runs, "run piece") : ""].filter(Boolean).join(" and ");
      refuse("undo_refused", `${who} now ${users.length === 1 ? "uses" : "use"} what this change added; undo would leave them without it`, users);
    }
  }
  const organizationHolders = organizationUsers(model, removed);
  if (organizationHolders.length > 0) {
    refuse("undo_refused", `${plural(organizationHolders.length, "element or view", "elements or views")} now use${organizationHolders.length === 1 ? "s" : ""} the group, phase or filter this change added; undo would leave them without it`, organizationHolders.slice(0, 50));
  }
  const authored: AuthoredWrite[] = [];
  for (const w of target.authored) {
    const el = working[w.elementId];
    const value = el ? authoredFieldValue(el, w.field) : undefined;
    if (el && value !== undefined) authored.push({ elementId: w.elementId, field: w.field, value });
  }
  return finish(reader, working, restored, authored, fieldIntents(authored), {
    removedIds: removed,
    removedConnections: target.addedConnections ?? [],
    addedConnections: target.removedConnections ?? [],
  });
}

export function executePartCommand(model: ModelState, command: PartCommand, context: CommandContext): ExecuteResult {
  switch (command.type) {
    case "place_part":
      return placePart(model, command);
    case "move_elements":
      return moveElements(model, command);
    case "rotate_elements":
      return rotateElements(model, command);
    case "copy_elements":
      return copyElements(model, command);
    case "delete_elements":
      return deleteElements(model, command);
    case "set_parameters":
      return setParameters(model, command);
    case "plan_part":
      return planPart(model, command);
    case "place_planned_part":
      return placePlannedPart(model, command);
    case "unplace_part":
      return unplacePart(model, command);
    case "create_level":
      return createLevel(model, command);
    case "undo":
      return undo(model, command, context);
  }
}
