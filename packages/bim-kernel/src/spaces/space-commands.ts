import { z } from "zod";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { levelOf } from "../fields/providers/spatial";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { draftElements, elementsOfKind } from "../store";
import { connectorEndsTable } from "../kinds/ends";
import { asElementId, type BimElement, type ElementId, type ModelState, type Vec2 } from "../types";
import { spatialDesignFingerprint, SPATIAL_DESIGN_FIELD } from "./space-fingerprint";
import {
  CAD_UNIT_MM,
  calibrateTwoPoints,
  cleanOutline,
  isCalibrated,
  outlineAreaMm2,
  outlineProblem,
  parseDrawingScale,
  spaceLabel,
  spaceOutlines,
  statedScaleMmPerUnit,
  tracingRefusal,
  MM2_PER_M2,
} from "./space-geometry";
import { addCeilings, beginCeilingEdit, finishCeilingEdit } from "../ceilings/commands";
import { peerReadsServiceFeature } from "../services/write-gate";
import { pinnedSpaceUseSchema, SPACES_PARAMETER_RATES_FEATURE } from "./space-use";
import { ALLOCATION_POLICY_LABELS } from "../requirements/policy";
import { DEDICATED_SPACE_RULE, derivedZoneRule, resolveDerivedZone } from "./derived-zones";
import { activePackSet } from "../packs/scope";
import { ZONE_PURPOSE_POINT, type DrawingUnderlay, type Space, type SpaceBounds, type SpaceSeparator, type SpaceOrigin, type UnderlayCalibration, type Zone, type ZoneBounds, type ZonePurpose } from "./types";
import "./boundaries/follow";
import "./boundaries/open-findings";
import { roomAt } from "./boundaries/room-at";
import { previewRoomFromWalls } from "./boundaries/preview";
import { withBoundaryIndexAt } from "./boundaries/boundary-index";
import { splitRegions, SUB_ROOM_LETTERS } from "./split-preview";
import { loadPointFingerprint } from "../load-points/fingerprint";
import type { LoadRecord } from "../requirements/anchor";
import { childrenOf, SPACES_NESTED_FEATURE } from "./nesting";
import { SPACES_SEPARATORS_FEATURE } from "./separators";
import { SPACES_BOUNDED_FEATURE } from "./boundary-facts";
import { plannedSpaces, spaceAt, spacesOnLevel } from "./space-index";
import { loadIndexOf } from "../requirements/load-index";
import { isSpacesZone, KNOWN_ZONE_PURPOSES, withZoneSpaceIds, zoneBoundsOf, zoneBoundsWritable, zonePurposeWords, zoneSpaceIds, ZONE_BOUNDS_NOT_YET } from "./zone-bounds";

/**
 * Space, zone and drawing-underlay edits: the one path the Spaces panel, the
 * Draw space tool, the underlay calibration and the agent tools all use.
 * Every edit undoes as one step. Area is never typed: it comes from the
 * outline or the rooms.
 */

const id = z.string().trim().min(1).max(200);
const vec2 = z.object({ x: z.number().finite().min(-1e9).max(1e9), y: z.number().finite().min(-1e9).max(1e9) }).strict();
const outline = z.array(vec2).min(3).max(2000);
const text = (max: number) => z.string().trim().max(max);
const mm = z.number().finite().min(0).max(1_000_000);

const originInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drawn") }).strict(),
  z.object({ kind: z.literal("traced"), underlayId: id }).strict(),
  z.object({ kind: z.literal("from_linked_room"), linkId: id, roomRef: id }).strict(),
  z
    .object({
      kind: z.literal("detected"),
      detector: text(80).min(1),
      confidence: z.number().finite().min(0).max(1),
      underlayId: id.optional(),
      /** The engineer accepted the proposed outline as it is made (Propose rooms from this drawing). */
      accepted: z.literal(true).optional(),
    })
    .strict(),
]);

// A writer: commands set only purposes this version knows, a firm's, or one an add-on of this model defines. Readers keep any stored purpose (zone-bounds.ts).
const zonePurpose = z.union([
  z.enum(KNOWN_ZONE_PURPOSES),
  z.string().regex(/^firm:[a-z0-9_]{1,40}$/),
  z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,23}\.[a-z0-9][a-z0-9_]*$/)
    .refine((id) => activePackSet().items(ZONE_PURPOSE_POINT).some((p) => p.id === id), "No add-on this model uses defines that zone purpose"),
]);

const spaceInput = z
  .object({
    /** Chosen by the sender so a retried request makes the same space, not a second one. */
    spaceId: id,
    number: text(20),
    name: text(80),
    /** Absent: typed into the table, not on a level yet. */
    levelId: id.optional(),
    /** Model mm, in order around the space. Absent: typed, no area yet. */
    outline: outline.optional(),
    /** How the outline was made. Absent: drawn when there is an outline, typed when not. */
    origin: originInput.optional(),
    use: pinnedSpaceUseSchema.optional(),
    occupants: z.number().int().min(0).max(100_000).optional(),
    ceilingHeightMm: mm.optional(),
    slabToSlabMm: mm.optional(),
    block: z.boolean().optional(),
    note: text(400).optional(),
  })
  .strict();

const calibrationInput = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("two_points"),
      /** Picked on the underlay, in its own units (PDF points, pixels, CAD units). */
      a: vec2,
      b: vec2,
      /** The real distance between them. */
      distanceMm: z.number().finite().positive().max(10_000_000),
    })
    .strict(),
  z
    .object({
      method: z.literal("stated_scale"),
      /** As printed: `1/8" = 1'-0"`, `1:100`. */
      scale: text(40).min(1),
      /** Images only: pixels per inch of the original sheet. */
      pixelsPerInch: z.number().finite().positive().max(10_000).optional(),
    })
    .strict(),
  z.object({ method: z.literal("cad_units"), unit: z.enum(["mm", "cm", "m", "in", "ft"]) }).strict(),
]);

export const spaceCommandSchemas = [
  z.object({ type: z.literal("create_space"), spaces: z.array(spaceInput).min(1).max(500) }).strict(),
  z
    .object({
      type: z.literal("edit_space"),
      spaceId: id,
      number: text(20).optional(),
      name: text(80).optional(),
      levelId: id.optional(),
      /** Redraw it. With `tracedOver`, the new outline was traced over that underlay. */
      outline: outline.optional(),
      tracedOver: id.optional(),
      /** `null` clears the use. */
      use: pinnedSpaceUseSchema.nullable().optional(),
      /** `null`: back to the use's default density. */
      occupants: z.number().int().min(0).max(100_000).nullable().optional(),
      ceilingHeightMm: mm.nullable().optional(),
      slabToSlabMm: mm.nullable().optional(),
      block: z.boolean().nullable().optional(),
      note: text(400).nullable().optional(),
      /** How its estimates count once devices are placed in it; `null`: back to the model's setting. */
      estimateCounting: z.enum(["max", "actual_only", "allocation_only"]).nullable().optional(),
      /** Accept a detector's proposed outline: it becomes the engineer's own. */
      accept: z.literal(true).optional(),
    })
    .strict(),
  z.object({ type: z.literal("delete_spaces"), spaceIds: z.array(id).min(1).max(500) }).strict(),
  z
    .object({
      type: z.literal("make_spaces_from_rooms"),
      /** The rooms to make spaces from. Absent: every room on `levelId` (or in the model) without a space yet. */
      roomIds: z.array(id).min(1).max(2000).optional(),
      levelId: id.optional(),
      use: pinnedSpaceUseSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("create_zone"),
      zoneId: id,
      name: text(80).min(1),
      purpose: zonePurpose,
      spaceIds: z.array(id).max(2000).optional(),
      /** A region drawn on a level instead of spaces (a fire area across a corridor, a catchment). Heights in mm above the level's floor. */
      outline: z.object({ levelId: id, outline, topMm: mm.optional(), bottomMm: mm.optional() }).strict().optional(),
      servedBy: id.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("accept_derived_zone"),
      zoneId: id,
      /** The equipment the zone comes from (P1 for the space above it). */
      hostId: id,
      /** Absent: the dedicated space above electrical equipment (NEC 110.26(E)). */
      rule: text(80).min(1).optional(),
      name: text(80).min(1).optional(),
      purpose: zonePurpose.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("edit_zone"),
      zoneId: id,
      name: text(80).min(1).optional(),
      purpose: zonePurpose.optional(),
      addSpaceIds: z.array(id).max(2000).optional(),
      removeSpaceIds: z.array(id).max(2000).optional(),
      /** `null` clears it. */
      servedBy: id.nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("delete_zones"), zoneIds: z.array(id).min(1).max(500) }).strict(),
  z
    .object({
      type: z.literal("place_underlay"),
      underlayId: id,
      levelId: id,
      source: z
        .object({
          format: z.enum(["pdf", "image", "dxf", "dwg"]),
          provider: text(40).min(1),
          ref: text(400).min(1),
          page: z.number().int().min(1).max(10_000).optional(),
          name: text(200).min(1),
        })
        .strict(),
      opacityPct: z.number().finite().min(0).max(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("calibrate_underlay"),
      underlayId: id,
      calibration: calibrationInput,
      /** Where the calibration's first point (or the source origin) lands in the model, mm. Absent: kept, or the model origin. */
      modelAt: vec2.optional(),
      rotationDeg: z.number().finite().min(-360).max(360).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("edit_underlay"),
      underlayId: id,
      opacityPct: z.number().finite().min(0).max(100).optional(),
      locked: z.boolean().optional(),
      hidden: z.boolean().optional(),
      /** Slide a calibrated underlay so its anchor sits here (mm). */
      modelAt: vec2.optional(),
      rotationDeg: z.number().finite().min(-360).max(360).optional(),
    })
    .strict(),
  z.object({ type: z.literal("delete_underlays"), underlayIds: z.array(id).min(1).max(100) }).strict(),
  z
    .object({
      type: z.literal("place_space_in_walls"),
      /** Chosen by the sender so a retried click makes the same space, not a second one. */
      spaceId: id,
      levelId: id,
      /** Where the person clicked, model mm. The outline is found from the room-bounding elements around it. */
      seed: vec2,
      number: text(20).optional(),
      name: text(80).optional(),
      use: pinnedSpaceUseSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("split_space"),
      spaceId: id,
      /** The separation line, model mm, drawn from wall to wall across the room. */
      line: z.object({ start: vec2, end: vec2 }).strict(),
      /** Chosen by the sender so a retried split makes the same records. Absent: `<space>:line`. */
      separatorId: id.optional(),
      /** Ids for the sub-rooms, west to east (then south to north). Absent: `<space>-A`, `<space>-B`, … */
      childIds: z.array(id).min(2).max(26).optional(),
      /** The sub-room (its id, or its number such as 101A) that keeps the room's loads that aren't by area. Needed when it has any, unless `loadsTo` names one for each. */
      typedLoadsTo: text(200).min(1).optional(),
      /** One load's sub-room, over `typedLoadsTo` (the split dialog asks per load). */
      loadsTo: z.array(z.object({ loadId: id, to: text(200).min(1) }).strict()).max(500).optional(),
    })
    .strict(),
  /** Remove the separation lines inside a split room and merge its sub-rooms back into it, with their loads. */
  z.object({ type: z.literal("merge_space_children"), spaceId: id }).strict(),
  z
    .object({
      type: z.literal("make_ceiling_from_space_height"),
      spaceId: id,
      /** Absent: `ceiling:<spaceId>` (one per outline after the first), so two people making it at once conflict instead of doubling it. */
      ceilingId: id.optional(),
    })
    .strict(),
] as const;

export const spaceCommandSchema = z.discriminatedUnion("type", [...spaceCommandSchemas]);
export type SpaceDesignCommand = z.infer<typeof spaceCommandSchema>;
type SpaceInput = z.infer<typeof spaceInput>;

const SPACE_COMMANDS: ReadonlySet<string> = new Set(spaceCommandSchemas.map((s) => s.shape.type.value));

export function isSpaceDesignCommand(command: { readonly type: string }): command is SpaceDesignCommand {
  return SPACE_COMMANDS.has(command.type);
}

// ---------------------------------------------------------------- edit plumbing

type Spatial = Space | Zone | DrawingUnderlay | SpaceSeparator;

interface Edit {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: ElementId[];
  readonly authored: AuthoredWrite[];
  readonly removed: ElementId[];
  readonly summary: string[];
}

function begin(model: ModelState): Edit {
  return { reader: new TrackedReader(model), working: draftElements(model.elements), touched: [], authored: [], removed: [], summary: [] };
}

function done(e: Edit): ExecuteResult {
  return finish(e.reader, e.working, e.touched, e.authored, () => [], { removedIds: e.removed, summary: e.summary });
}

function put(e: Edit, el: Spatial): void {
  e.working[el.id] = el;
  e.touched.push(el.id);
  e.authored.push({ elementId: el.id, field: SPATIAL_DESIGN_FIELD, value: spatialDesignFingerprint(el) });
}

function drop(e: Edit, elId: ElementId): void {
  delete e.working[elId];
  e.removed.push(elId);
}

function current<K extends Spatial["kind"]>(e: Edit, elId: string, kind: K, noun: string): Extract<Spatial, { kind: K }> {
  const key = asElementId(elId);
  const read = e.reader.find(key);
  const el = e.working[key] ?? read;
  if (!el) refuse("element_not_found", `There is no ${noun} ${elId}`, [key]);
  if (el.kind !== kind) refuse("wrong_kind", `${elId} is a ${el.kind.replace(/_/g, " ")}, not a ${noun}`, [key]);
  return el as Extract<Spatial, { kind: K }>;
}

function requireLevel(e: Edit, levelId: string): ElementId {
  const lvl = e.reader.find(asElementId(levelId));
  if (lvl?.kind !== "level") refuse("element_not_found", `There is no level ${levelId}`, [asElementId(levelId)]);
  return lvl.id;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sqft(areaMm2: number): string {
  return `${Math.round((areaMm2 / MM2_PER_M2) * 10.7639)} sq ft`;
}

function cleaned(points: readonly Vec2[]): Vec2[] {
  const o = cleanOutline(points);
  const problem = outlineProblem(o);
  if (problem) refuse("invalid_value", problem);
  return o;
}

function requireTraceable(e: Edit, underlayId: string, levelId: ElementId | undefined): DrawingUnderlay {
  const u = current(e, underlayId, "drawing_underlay", "underlay");
  const why = tracingRefusal(u);
  if (why) refuse("invalid_value", why, [u.id]);
  if (levelId && u.levelId !== levelId) refuse("invalid_value", `${u.source.name} is on another level; trace over an underlay on the space's own level`, [u.id]);
  return u;
}

// ---------------------------------------------------------------- spaces

function originFor(e: Edit, input: SpaceInput, levelId: ElementId | undefined): SpaceOrigin {
  const o = input.origin;
  if (!o) return input.outline ? { kind: "drawn" } : { kind: "typed" };
  if (!input.outline && o.kind !== "detected") refuse("invalid_value", `A ${o.kind === "traced" ? "traced" : o.kind === "drawn" ? "drawn" : "linked-room"} space needs its outline`);
  switch (o.kind) {
    case "drawn":
      return o;
    case "traced":
      return { kind: "traced", underlayId: requireTraceable(e, o.underlayId, levelId).id };
    case "from_linked_room":
      return o;
    case "detected": {
      if (o.underlayId) current(e, o.underlayId, "drawing_underlay", "underlay");
      return { kind: "detected", detector: o.detector, confidence: o.confidence, accepted: o.accepted === true, ...(o.underlayId ? { underlayId: asElementId(o.underlayId) } : {}) };
    }
  }
}

function newSpace(e: Edit, input: SpaceInput): Space {
  const spaceId = asElementId(input.spaceId);
  if (e.working[spaceId] ?? e.reader.find(spaceId)) refuse("already_exists", `${input.spaceId} already exists; choose a new id for the space`, [spaceId]);
  const levelId = input.levelId !== undefined ? requireLevel(e, input.levelId) : undefined;
  if (input.outline && !levelId) refuse("invalid_value", "A drawn space needs its level");
  const bounds: SpaceBounds = input.outline ? { kind: "outline", outline: cleaned(input.outline) } : { kind: "none" };
  return {
    id: spaceId,
    kind: "space",
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    number: input.number,
    name: input.name,
    ...(levelId ? { levelId } : {}),
    bounds,
    origin: originFor(e, input, levelId),
    ...(input.use ? { use: input.use } : {}),
    ...(input.occupants !== undefined ? { occupants: input.occupants } : {}),
    ...(input.ceilingHeightMm !== undefined ? { ceilingHeightMm: input.ceilingHeightMm } : {}),
    ...(input.slabToSlabMm !== undefined ? { slabToSlabMm: input.slabToSlabMm } : {}),
    ...(input.block !== undefined ? { block: input.block } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}

function refuseDuplicateNumbers(e: Edit, made: readonly Space[]): void {
  const numbers = new Map<string, ElementId>();
  const madeIds = new Set<string>(made.map((m) => m.id));
  // Numbers are unique per level: read only the levels the new spaces sit on (indexed), plus the unplaced ones.
  const levels = new Set(made.map((m) => m.levelId));
  const existing = [...levels].flatMap((l) => (l === undefined ? plannedSpaces(e.reader.model.elements) : spacesOnLevel(e.reader.model.elements, l)));
  for (const s of existing) if (s.number.trim() !== "" && !madeIds.has(s.id)) numbers.set(`${s.levelId ?? ""}\u0000${s.number.trim().toLowerCase()}`, s.id);
  for (const s of made) {
    if (s.number.trim() === "") continue;
    const key = `${s.levelId ?? ""}\u0000${s.number.trim().toLowerCase()}`;
    const other = numbers.get(key);
    if (other && other !== s.id) refuse("already_exists", `Space ${s.number} already exists on this level (${other}). Give it another number`, [s.id, other]);
    numbers.set(key, s.id);
  }
}

function createSpaces(model: ModelState, command: Extract<SpaceDesignCommand, { type: "create_space" }>): ExecuteResult {
  const e = begin(model);
  const made = command.spaces.map((input) => {
    const s = newSpace(e, input);
    put(e, s);
    return s;
  });
  refuseDuplicateNumbers(e, made);
  const first = made[0] as Space;
  const area = first.bounds.kind === "outline" ? ` (${sqft(outlineAreaMm2(first.bounds.outline))})` : "";
  const verb = first.origin.kind === "traced" ? "Traced" : first.origin.kind === "typed" ? "Added" : first.origin.kind === "detected" ? (first.origin.accepted ? "Accepted" : "Proposed") : "Drew";
  e.summary.push(made.length === 1 ? `${verb} space ${spaceLabel(first)}${area}` : `${verb} ${plural(made.length, "space")}`);
  return done(e);
}

function editSpace(model: ModelState, command: Extract<SpaceDesignCommand, { type: "edit_space" }>): ExecuteResult {
  const e = begin(model);
  const s = current(e, command.spaceId, "space", "space");
  const levelId = command.levelId !== undefined ? requireLevel(e, command.levelId) : s.levelId;
  let bounds = s.bounds;
  let origin = s.origin;
  if (command.outline) {
    if (!levelId) refuse("invalid_value", "Put the space on a level before drawing it", [s.id]);
    bounds = { kind: "outline", outline: cleaned(command.outline) };
    origin = command.tracedOver ? { kind: "traced", underlayId: requireTraceable(e, command.tracedOver, levelId).id } : { kind: "drawn" };
  } else if (command.tracedOver) refuse("invalid_value", "Send the traced outline with tracedOver", [s.id]);
  if (command.accept) {
    if (origin.kind !== "detected") refuse("invalid_value", `${spaceLabel(s)} wasn't proposed by a detector; there is nothing to accept`, [s.id]);
    origin = { ...origin, accepted: true };
  }
  const { use: priorUse, occupants: priorOccupants, ceilingHeightMm: priorCeiling, slabToSlabMm: priorSlab, block: priorBlock, note: priorNote, estimateCounting: priorCounting, ...base } = s;
  const estimateCounting = keep(command.estimateCounting, priorCounting);
  const use = keep(command.use, priorUse);
  const occupants = keep(command.occupants, priorOccupants);
  const ceilingHeightMm = keep(command.ceilingHeightMm, priorCeiling);
  const slabToSlabMm = keep(command.slabToSlabMm, priorSlab);
  const block = keep(command.block, priorBlock);
  const note = keep(command.note, priorNote);
  const next: Space = {
    ...base,
    ...(command.number !== undefined ? { number: command.number } : {}),
    ...(command.name !== undefined ? { name: command.name } : {}),
    ...(levelId ? { levelId } : {}),
    bounds,
    origin,
    ...(use !== undefined ? { use } : {}),
    ...(occupants !== undefined ? { occupants } : {}),
    ...(ceilingHeightMm !== undefined ? { ceilingHeightMm } : {}),
    ...(slabToSlabMm !== undefined ? { slabToSlabMm } : {}),
    ...(block !== undefined ? { block } : {}),
    ...(note !== undefined && note !== "" ? { note } : {}),
    ...(estimateCounting !== undefined ? { estimateCounting } : {}),
  };
  if (spatialDesignFingerprint(next) === spatialDesignFingerprint(s)) refuse("invalid_value", `Nothing to change: ${spaceLabel(s)} already reads that way`, [s.id]);
  put(e, next);
  if (command.number !== undefined) refuseDuplicateNumbers(e, [next]);
  const what: string[] = [];
  if (command.outline) what.push(`outline (${bounds.kind === "outline" ? sqft(outlineAreaMm2(bounds.outline)) : "no area"})`);
  if (command.use !== undefined) what.push(command.use ? `use ${command.use.name}` : "use cleared");
  if (command.occupants !== undefined) what.push(command.occupants === null ? "occupants from the use" : `${plural(command.occupants, "occupant")}`);
  if (command.estimateCounting !== undefined) what.push(command.estimateCounting === null ? "estimates count as the model says" : `estimates count: ${ALLOCATION_POLICY_LABELS[command.estimateCounting].toLowerCase()}`);
  if (command.accept) what.push("accepted the proposed outline");
  e.summary.push(`Changed space ${spaceLabel(next)}${what.length > 0 ? `: ${what.join(", ")}` : ""}`);
  return done(e);
}

/** An edit's optional field: `null` clears it, absent keeps what was there. */
function keep<T>(sent: T | null | undefined, prior: T | undefined): T | undefined {
  return sent === null ? undefined : sent === undefined ? prior : sent;
}

/** Loads anchored to these spaces (k2's lifecycle loads). Read once, on delete only. */
function loadsOn(e: Edit, ids: ReadonlySet<string>): ElementId[] {
  return elementsOfKind(e.reader.model.elements, "load_point")
    .filter((lp) => lp.anchor?.kind === "space" && ids.has(lp.anchor.id))
    .map((lp) => lp.id);
}

function deleteSpaces(model: ModelState, command: Extract<SpaceDesignCommand, { type: "delete_spaces" }>): ExecuteResult {
  const e = begin(model);
  const ids = new Set(command.spaceIds.map((sid) => current(e, sid, "space", "space").id));
  const anchored = loadsOn(e, ids);
  if (anchored.length > 0) refuse("in_use", `${plural(anchored.length, "load is", "loads are")} spread over ${ids.size === 1 ? "this space" : "these spaces"}. Move or delete ${anchored.length === 1 ? "it" : "them"} first so the estimate isn't lost`, anchored);
  const labels: string[] = [];
  for (const sid of ids) {
    labels.push(spaceLabel(current(e, sid, "space", "space")));
    drop(e, sid);
  }
  for (const z of elementsOfKind(model.elements, "zone")) {
    const members = zoneSpaceIds(z);
    if (!members.some((s) => ids.has(s))) continue;
    e.reader.find(z.id);
    put(e, withZoneSpaceIds(z, members.filter((s) => !ids.has(s))));
  }
  e.summary.push(labels.length === 1 ? `Deleted space ${labels[0]}` : `Deleted ${plural(labels.length, "space")}`);
  return done(e);
}

/** The id a space made from a room gets: one room, one space, so two people making it at once conflict instead of doubling it. */
export function spaceIdForRoom(roomId: string): ElementId {
  return asElementId(`space:${roomId}`);
}

function makeFromRooms(model: ModelState, command: Extract<SpaceDesignCommand, { type: "make_spaces_from_rooms" }>): ExecuteResult {
  const e = begin(model);
  const levelFilter = command.levelId !== undefined ? requireLevel(e, command.levelId) : undefined;
  const followed = new Set<string>();
  for (const s of elementsOfKind(model.elements, "space")) if (s.bounds.kind === "rooms") for (const r of s.bounds.roomIds) followed.add(r);
  const rooms = command.roomIds
    ? command.roomIds.map((rid) => {
        const r = e.reader.find(asElementId(rid));
        if (r?.kind !== "room") refuse(r ? "wrong_kind" : "element_not_found", r ? `${rid} is not a room` : `There is no room ${rid}`, [asElementId(rid)]);
        return r;
      })
    : elementsOfKind(model.elements, "room").filter((r) => !levelFilter || levelOf(model.elements, r)?.id === levelFilter);
  let skipped = 0;
  let noLevel = 0;
  const made: Space[] = [];
  for (const room of rooms) {
    if (followed.has(room.id) || e.working[spaceIdForRoom(room.id)]) {
      skipped += 1;
      continue;
    }
    const lvl = levelOf(model.elements, room);
    if (!lvl) {
      noLevel += 1;
      continue;
    }
    const space: Space = {
      id: spaceIdForRoom(room.id),
      kind: "space",
      version: 0,
      authoredRev: {},
      partition: GLOBAL_PARTITION,
      number: room.number,
      name: room.name,
      levelId: lvl.id,
      bounds: { kind: "rooms", roomIds: [room.id] },
      origin: { kind: "from_room", roomId: room.id },
      ...(command.use ? { use: command.use } : {}),
    };
    put(e, space);
    made.push(space);
  }
  if (made.length === 0) {
    const why = rooms.length === 0 ? "There are no rooms to make spaces from" : skipped > 0 && noLevel === 0 ? "Every room already has a space" : `The rooms aren't on a level the model knows (${plural(noLevel, "room")})`;
    refuse("invalid_value", `${why}. Draw spaces instead, or trace them over a drawing`);
  }
  e.summary.push(`Made ${plural(made.length, "space")} from rooms${skipped > 0 ? `; ${plural(skipped, "room")} already had one` : ""}${noLevel > 0 ? `; ${plural(noLevel, "room")} skipped (not on a known level)` : ""}`);
  return done(e);
}

// ---------------------------------------------------------------- spaces from walls

/** Bounded spaces are written only to peers that store them. */
export const SPACES_BOUNDED_NOT_YET = "Rooms found from walls can't be saved on the model server this model is open on yet. Draw the room's outline instead, or try again once the server is updated";

/** Two outlines this close in area are the same room. */
const SAME_ROOM_AREA = 0.005;

function placeSpaceInWalls(model: ModelState, command: Extract<SpaceDesignCommand, { type: "place_space_in_walls" }>): ExecuteResult {
  const e = begin(model);
  if (!peerReadsServiceFeature(SPACES_BOUNDED_FEATURE)) refuse("invalid_value", SPACES_BOUNDED_NOT_YET);
  const spaceId = asElementId(command.spaceId);
  if (e.working[spaceId] ?? e.reader.find(spaceId)) refuse("already_exists", `${command.spaceId} already exists; choose a new id for the space`, [spaceId]);
  const levelId = requireLevel(e, command.levelId);
  const found = previewRoomFromWalls(model.elements, levelId, command.seed);
  if (!found.ok) refuse("invalid_value", found.message, found.gap ? [found.gap.elementId] : []);
  for (const ref of found.boundary) e.reader.find(ref.elementId);
  const area = outlineAreaMm2(found.outline);
  const there = spaceAt(model.elements, levelId, command.seed);
  if (there) {
    const thereArea = spaceOutlines(model.elements, there).reduce((sum, o) => sum + outlineAreaMm2(o), 0);
    if (Math.abs(thereArea - area) <= SAME_ROOM_AREA * area) refuse("already_exists", `${spaceLabel(there)} already fills this room`, [there.id]);
  }
  const space: Space = {
    id: spaceId,
    kind: "space",
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    number: command.number ?? "",
    name: command.name ?? "",
    levelId,
    bounds: { kind: "bounded", levelId, seed: { x: command.seed.x, y: command.seed.y }, outline: found.outline, boundary: found.boundary },
    origin: { kind: "drawn" },
    ...(command.use ? { use: command.use } : {}),
  };
  put(e, space);
  refuseDuplicateNumbers(e, [space]);
  e.summary.push(`Made space ${spaceLabel(space)} from the walls around it (${sqft(area)})`);
  return done(e);
}

// ---------------------------------------------------------------- sub-rooms (Product decision, Nov 3, decision 2)

export const SPACES_SPLIT_NOT_YET = "Splitting a room into sub-rooms can't be saved on the model server this model is open on yet. Try again once the server is updated";


function requireSplitWritable(): void {
  if (!peerReadsServiceFeature(SPACES_SEPARATORS_FEATURE) || !peerReadsServiceFeature(SPACES_NESTED_FEATURE)) refuse("invalid_value", SPACES_SPLIT_NOT_YET);
}

/** A room the way people say it: "Office 101". */
function roomWords(s: Space): string {
  return [s.name, s.number].filter((t) => t.trim() !== "").join(" ") || spaceLabel(s);
}

function shortWords(s: Space): string {
  return s.number.trim() !== "" ? s.number : roomWords(s);
}

function spaceKids(elements: Readonly<Record<string, BimElement>>, parentId: ElementId): Space[] {
  // Sub-rooms sit on their parent's level: read that level from the space index, not every space.
  const parent = elements[parentId];
  if (parent?.kind === "space" && parent.levelId !== undefined) return spacesOnLevel(elements, parent.levelId).filter((s) => s.parentId === parentId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return childrenOf(elements, parentId).flatMap((c) => (c.kind === "space" ? [c] : []));
}

function loadsAnchoredTo(e: Edit, ids: ReadonlySet<string>): LoadRecord[] {
  const elements = e.reader.model.elements;
  const index = loadIndexOf(elements);
  const out: LoadRecord[] = [];
  for (const id of ids) for (const lpId of index.inSpace(id)) {
    const lp = elements[lpId];
    if (lp?.kind === "load_point" && lp.anchor?.kind === "space" && ids.has(lp.anchor.id)) out.push(lp);
  }
  return out;
}

function writeLoad(e: Edit, lp: LoadRecord): void {
  e.working[lp.id] = lp;
  e.touched.push(lp.id);
  e.authored.push({ elementId: lp.id, field: "load_point", value: loadPointFingerprint(lp) });
}

/** The copy of a by-area load each sub-room gets: `<load>@<sub-room>`. */
function shareId(loadId: string, childId: string): ElementId {
  return asElementId(`${loadId}@${childId}`);
}

function splitSpace(model: ModelState, command: Extract<SpaceDesignCommand, { type: "split_space" }>): ExecuteResult {
  const e = begin(model);
  requireSplitWritable();
  const parent = current(e, command.spaceId, "space", "space");
  const room = roomWords(parent);
  if (parent.bounds.kind !== "bounded") refuse("invalid_value", `Split works on a room found from its walls. Make ${room} from its walls first (Room from walls), then split it`, [parent.id]);
  const b = parent.bounds;
  const kids = spaceKids(model.elements, parent.id);
  if (kids.length > 0) refuse("invalid_value", `${room} is already split into ${kids.map(shortWords).join(" and ")}. Split one of those, or remove the line first`, [parent.id, ...kids.map((k) => k.id)]);
  const sepId = asElementId(command.separatorId ?? `${parent.id}:line`);
  if (e.working[sepId] ?? e.reader.find(sepId)) refuse("already_exists", `${sepId} already exists; choose a new id for the separation line`, [sepId]);

  const regions = splitRegions(parent, command.line, sepId);
  if (regions.length < 2) refuse("invalid_value", `That line doesn't cross ${room} from one side to the other. Draw it from wall to wall`, [parent.id]);
  if (command.childIds && command.childIds.length !== regions.length) refuse("invalid_value", `The line makes ${plural(regions.length, "sub-room")}; send ${regions.length} ids, west to east`, [parent.id]);

  const separator: SpaceSeparator = { id: sepId, kind: "space_separator", version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, levelId: b.levelId, start: { x: command.line.start.x, y: command.line.start.y }, end: { x: command.line.end.x, y: command.line.end.y }, splits: parent.id };
  put(e, separator);

  const traced = withBoundaryIndexAt(model.elements, e.working, [sepId], () => regions.map((r) => roomAt(e.working, b.levelId, r.inside)));
  const { use, ceilingHeightMm, slabToSlabMm, block, estimateCounting } = parent;
  const children: Space[] = regions.map((r, i) => {
    const t = traced[i];
    if (!t?.ok) refuse("invalid_value", `Part of ${room} on the other side of the line isn't closed by its walls; check the walls there, then split again`, [parent.id]);
    const letter = SUB_ROOM_LETTERS[i] as string;
    const childId = asElementId(command.childIds?.[i] ?? `${parent.id}-${letter}`);
    if (e.working[childId] ?? e.reader.find(childId)) refuse("already_exists", `${childId} already exists; choose other ids for the sub-rooms`, [childId]);
    return {
      id: childId,
      kind: "space",
      version: 0,
      authoredRev: {},
      partition: GLOBAL_PARTITION,
      number: `${parent.number}${letter}`,
      name: parent.name,
      levelId: b.levelId,
      bounds: { kind: "bounded", levelId: b.levelId, seed: { x: Math.round(r.inside.x * 1000) / 1000, y: Math.round(r.inside.y * 1000) / 1000 }, outline: t.outline, boundary: t.boundary },
      origin: { kind: "drawn" },
      parentId: parent.id,
      ...(use ? { use } : {}),
      ...(ceilingHeightMm !== undefined ? { ceilingHeightMm } : {}),
      ...(slabToSlabMm !== undefined ? { slabToSlabMm } : {}),
      ...(block !== undefined ? { block } : {}),
      ...(estimateCounting !== undefined ? { estimateCounting } : {}),
    };
  });
  for (const c of children) put(e, c);
  refuseDuplicateNumbers(e, children);

  const loads = loadsAnchoredTo(e, new Set([parent.id]));
  const byArea = loads.filter((lp) => lp.basis === "density");
  const typed = loads.filter((lp) => lp.basis !== "density");
  const kept = new Map<string, number>();
  if (typed.length > 0) {
    const names = children.map(shortWords).join(" or ");
    const perLoad = new Map((command.loadsTo ?? []).map((l) => [l.loadId, l.to] as const));
    const unnamed = typed.filter((lp) => !perLoad.has(lp.id));
    if (unnamed.length > 0 && !command.typedLoadsTo) refuse("invalid_value", `${room} carries ${plural(unnamed.length, "load")} that ${unnamed.length === 1 ? "isn't" : "aren't"} by area. Say which sub-room keeps ${unnamed.length === 1 ? "it" : "them"}: ${names}`, [parent.id, ...unnamed.map((lp) => lp.id)]);
    for (const lp of typed) {
      const to = perLoad.get(lp.id) ?? command.typedLoadsTo ?? "";
      const want = to.trim().toLowerCase();
      const keeper = children.find((c) => c.id.toLowerCase() === want || c.number.toLowerCase() === want);
      if (!keeper) refuse("invalid_value", `${to} isn't one of the new sub-rooms (${names})`, [parent.id]);
      writeLoad(e, { ...lp, anchor: { kind: "space", id: keeper.id } });
      kept.set(shortWords(keeper), (kept.get(shortWords(keeper)) ?? 0) + 1);
    }
  }
  for (const lp of byArea) {
    for (const c of children) {
      const copyId = shareId(lp.id, c.id);
      if (e.working[copyId] ?? e.reader.find(copyId)) refuse("already_exists", `${copyId} already exists`, [copyId]);
      writeLoad(e, { ...lp, id: copyId, version: 0, authoredRev: {}, anchor: { kind: "space", id: c.id } });
    }
    drop(e, lp.id);
  }
  const parts = [`Split ${room} into ${children.map(shortWords).join(" and ")} with a separation line; ${room} keeps its name and total area`];
  if (byArea.length > 0) parts.push(`${plural(byArea.length, "load")} by area now ${byArea.length === 1 ? "shares" : "share"} by each sub-room's area`);
  for (const [to, n] of kept) parts.push(`${plural(n, "load")} went to ${to}`);
  e.summary.push(parts.join("; "));
  return done(e);
}

function mergeSpaceChildren(model: ModelState, command: Extract<SpaceDesignCommand, { type: "merge_space_children" }>): ExecuteResult {
  const e = begin(model);
  requireSplitWritable();
  const parent = current(e, command.spaceId, "space", "space");
  const room = roomWords(parent);
  const kids = spaceKids(model.elements, parent.id);
  const lines = elementsOfKind(model.elements, "space_separator").filter((l) => l.splits === parent.id);
  if (kids.length === 0 && lines.length === 0) refuse("invalid_value", `${room} isn't split; there is nothing to merge`, [parent.id]);
  for (const k of kids) {
    const grand = spaceKids(model.elements, k.id);
    if (grand.length > 0) refuse("invalid_value", `${roomWords(k)} is split again into ${grand.map(shortWords).join(" and ")}. Merge it first`, [k.id]);
  }
  const kidIds = new Set<string>(kids.map((k) => k.id));
  const restored = new Set<string>();
  for (const lp of loadsAnchoredTo(e, kidIds)) {
    const anchorId = lp.anchor?.kind === "space" ? lp.anchor.id : "";
    const at = lp.id.lastIndexOf("@");
    const original = lp.basis === "density" && at > 0 && lp.id.slice(at + 1) === anchorId ? asElementId(lp.id.slice(0, at)) : null;
    if (original === null) {
      writeLoad(e, { ...lp, anchor: { kind: "space", id: parent.id } });
      continue;
    }
    drop(e, lp.id);
    if (restored.has(original) || e.reader.find(original)) continue;
    restored.add(original);
    writeLoad(e, { ...lp, id: original, version: 0, authoredRev: {}, anchor: { kind: "space", id: parent.id } });
  }
  for (const z of elementsOfKind(model.elements, "zone")) {
    const members = zoneSpaceIds(z);
    if (!members.some((s) => kidIds.has(s))) continue;
    e.reader.find(z.id);
    put(e, withZoneSpaceIds(z, members.filter((s) => !kidIds.has(s))));
  }
  for (const k of kids) drop(e, k.id);
  for (const l of lines) drop(e, l.id);
  e.summary.push(`Merged ${kids.map(shortWords).join(" and ")} back into ${room}; their loads are on ${room} again`);
  return done(e);
}

// ---------------------------------------------------------------- zones

function purposeLabel(p: ZonePurpose): string {
  if (p.startsWith("firm:")) return p.slice(5).replace(/_/g, " ");
  const fromPack = p.includes(".") ? activePackSet().items(ZONE_PURPOSE_POINT).find((d) => d.id === p)?.label : undefined;
  return (fromPack ?? zonePurposeWords(p)).toLowerCase();
}

function requireServer(e: Edit, serverId: string): ElementId {
  const el = e.reader.find(asElementId(serverId));
  if (el?.kind !== "part" && !(el !== undefined && connectorEndsTable().isRoot(el.kind))) refuse(el ? "wrong_kind" : "element_not_found", el ? `${serverId} is a ${el.kind.replace(/_/g, " ")}; a zone is served by equipment (a rooftop unit, an air handler, a panel)` : `There is no equipment ${serverId}`, [asElementId(serverId)]);
  return el.id;
}

/** Adds spaces to a zone, taking each out of any other spaces zone of the same purpose (a space is in one thermal zone). */
function withSpaces(e: Edit, zone: Zone, add: readonly string[]): Zone {
  const ids = new Set(zoneSpaceIds(zone));
  const moved: string[] = [];
  for (const sid of add) {
    const s = current(e, sid, "space", "space");
    ids.add(s.id);
  }
  for (const other of elementsOfKind(e.reader.model.elements, "zone")) {
    if (other.id === zone.id || other.purpose !== zone.purpose) continue;
    const members = zoneSpaceIds(other);
    const kept = members.filter((s) => !add.includes(s));
    if (kept.length === members.length) continue;
    e.reader.find(other.id);
    const fresh = e.working[other.id];
    put(e, withZoneSpaceIds(fresh?.kind === "zone" ? fresh : other, kept));
    moved.push(other.name);
  }
  if (moved.length > 0) e.summary.push(`Moved spaces out of ${moved.join(", ")} (a space is in one ${purposeLabel(zone.purpose)} zone)`);
  return withZoneSpaceIds(zone, [...ids]);
}

function zoneBase(e: Edit, command: { zoneId: string; name: string; purpose: string; servedBy?: string }, bounds: ZoneBounds | undefined): Zone {
  const zoneId = asElementId(command.zoneId);
  if (e.reader.find(zoneId)) refuse("already_exists", `${command.zoneId} already exists; choose a new id for the zone`, [zoneId]);
  return {
    id: zoneId,
    kind: "zone",
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    name: command.name,
    purpose: command.purpose as ZonePurpose,
    spaceIds: [],
    ...(bounds ? { bounds } : {}),
    ...(command.servedBy ? { servedBy: requireServer(e, command.servedBy) } : {}),
  };
}

/** Outlined and derived zones are `zone@2`: written only when every peer reads them. */
function requireZoneBoundsWritable(): void {
  if (!zoneBoundsWritable()) refuse("invalid_value", ZONE_BOUNDS_NOT_YET);
}

function zoneOutline(points: readonly Vec2[]): Vec2[] {
  const o = cleanOutline(points);
  const problem = outlineProblem(o);
  if (problem) refuse("invalid_value", problem.replace(/^A space needs/, "A zone needs").replace("around the space", "around the zone"));
  return o;
}

function createZone(model: ModelState, command: Extract<SpaceDesignCommand, { type: "create_zone" }>): ExecuteResult {
  const e = begin(model);
  if (command.outline) {
    if (command.spaceIds?.length) refuse("invalid_value", "A zone is either drawn as an outline or made of spaces, not both. Leave out the spaces, or the outline");
    requireZoneBoundsWritable();
    const o = command.outline;
    const levelId = requireLevel(e, o.levelId);
    if (o.topMm !== undefined && o.bottomMm !== undefined && o.topMm <= o.bottomMm) refuse("invalid_value", "The zone's top must be above its bottom");
    const zone = zoneBase(e, command, {
      kind: "outline",
      levelId,
      outline: zoneOutline(o.outline),
      ...(o.topMm !== undefined ? { top: o.topMm } : {}),
      ...(o.bottomMm !== undefined ? { bottom: o.bottomMm } : {}),
    });
    put(e, zone);
    const b = zone.bounds;
    e.summary.unshift(`Drew ${purposeLabel(zone.purpose)} zone ${zone.name} (${b?.kind === "outline" ? sqft(outlineAreaMm2(b.outline)) : "outline"})${zone.servedBy ? `, served by ${serverLabel(e, zone.servedBy)}` : ""}`);
    return done(e);
  }
  const zone = withSpaces(e, zoneBase(e, command, undefined), command.spaceIds ?? []);
  put(e, zone);
  e.summary.unshift(`Made ${purposeLabel(zone.purpose)} zone ${zone.name} with ${plural(zone.spaceIds.length, "space")}${zone.servedBy ? `, served by ${serverLabel(e, zone.servedBy)}` : ""}`);
  return done(e);
}

/** Keep a code zone the equipment derives (the dedicated space above P1) as a zone: only its host and rule are stored. */
function acceptDerivedZone(model: ModelState, command: Extract<SpaceDesignCommand, { type: "accept_derived_zone" }>): ExecuteResult {
  const e = begin(model);
  const rule = command.rule ?? DEDICATED_SPACE_RULE;
  const def = derivedZoneRule(rule);
  if (!def) refuse("invalid_value", `There is no code zone rule "${rule}"`);
  const hostId = asElementId(command.hostId);
  e.reader.find(hostId);
  const resolved = resolveDerivedZone(model, hostId, rule);
  if (!resolved.ok) refuse("invalid_value", resolved.reason, [hostId]);
  for (const z of elementsOfKind(model.elements, "zone")) {
    const b = zoneBoundsOf(z);
    if (b.kind === "derived" && b.hostId === hostId && b.rule === rule) refuse("already_exists", `${z.name} is already that zone`, [z.id]);
  }
  requireZoneBoundsWritable();
  const host = model.elements[hostId];
  const hostLabel = host?.kind === "part" && host.mark.trim() !== "" ? host.mark : hostId;
  const first = resolved.regions[0];
  const name = command.name ?? `${first?.name ?? def.label} ${hostLabel}`.trim();
  const zone = zoneBase(e, { zoneId: command.zoneId, name, purpose: command.purpose ?? "code_clearance" }, { kind: "derived", hostId, rule });
  put(e, zone);
  e.summary.push(`Kept ${name} as a zone; it follows ${hostLabel} when it moves or changes${first?.cite ? ` (${first.cite})` : ""}`);
  return done(e);
}

function serverLabel(e: Edit, serverId: ElementId): string {
  const el = e.working[serverId];
  return el && "mark" in el && typeof el.mark === "string" && el.mark.trim() !== "" ? el.mark : serverId;
}

function editZone(model: ModelState, command: Extract<SpaceDesignCommand, { type: "edit_zone" }>): ExecuteResult {
  const e = begin(model);
  const z = current(e, command.zoneId, "zone", "zone");
  let next: Zone = { ...z, ...(command.name !== undefined ? { name: command.name } : {}), ...(command.purpose !== undefined ? { purpose: command.purpose as ZonePurpose } : {}) };
  if ((command.removeSpaceIds?.length || command.addSpaceIds?.length) && !isSpacesZone(z)) {
    const b = zoneBoundsOf(z);
    refuse("invalid_value", `${z.name} ${b.kind === "outline" ? "is drawn as an outline" : b.kind === "derived" ? "comes from its equipment's code clearance" : "is a kind of zone this version can't change"}, so it has no spaces to add or take out. Make a zone from spaces instead`, [z.id]);
  }
  if (command.removeSpaceIds) next = withZoneSpaceIds(next, zoneSpaceIds(next).filter((s) => !command.removeSpaceIds?.includes(s)));
  if (command.addSpaceIds?.length) next = withSpaces(e, next, command.addSpaceIds);
  if (command.servedBy === null) {
    const { servedBy: _gone, ...rest } = next;
    next = rest;
  } else if (command.servedBy !== undefined) next = { ...next, servedBy: requireServer(e, command.servedBy) };
  if (spatialDesignFingerprint(next) === spatialDesignFingerprint(z)) refuse("invalid_value", `Nothing to change: zone ${z.name} already reads that way`, [z.id]);
  put(e, next);
  e.summary.unshift(`Changed zone ${next.name}: ${isSpacesZone(next) ? plural(zoneSpaceIds(next).length, "space") : zoneBoundsOf(next).kind === "outline" ? "drawn outline" : "code zone"}${next.servedBy ? `, served by ${serverLabel(e, next.servedBy)}` : command.servedBy === null ? ", no longer served by anything" : ""}`);
  return done(e);
}

function deleteZones(model: ModelState, command: Extract<SpaceDesignCommand, { type: "delete_zones" }>): ExecuteResult {
  const e = begin(model);
  const ids = new Set(command.zoneIds.map((zid) => current(e, zid, "zone", "zone").id));
  const anchored = elementsOfKind(model.elements, "load_point").filter((lp) => lp.anchor?.kind === "zone" && ids.has(lp.anchor.id)).map((lp) => lp.id);
  if (anchored.length > 0) refuse("in_use", `${plural(anchored.length, "load is", "loads are")} spread over ${ids.size === 1 ? "this zone" : "these zones"}. Move or delete ${anchored.length === 1 ? "it" : "them"} first`, anchored);
  const names = [...ids].map((zid) => current(e, zid, "zone", "zone").name);
  for (const zid of ids) drop(e, zid);
  e.summary.push(names.length === 1 ? `Deleted zone ${names[0]}; its spaces stay` : `Deleted ${plural(names.length, "zone")}; their spaces stay`);
  return done(e);
}

// ---------------------------------------------------------------- underlays

function placeUnderlay(model: ModelState, command: Extract<SpaceDesignCommand, { type: "place_underlay" }>): ExecuteResult {
  const e = begin(model);
  const uid = asElementId(command.underlayId);
  if (e.reader.find(uid)) refuse("already_exists", `${command.underlayId} already exists; choose a new id for the underlay`, [uid]);
  const levelId = requireLevel(e, command.levelId);
  const { page, ...source } = command.source;
  if (source.format === "pdf" && page === undefined) refuse("invalid_value", "Say which page of the PDF to place");
  const u: DrawingUnderlay = {
    id: uid,
    kind: "drawing_underlay",
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    levelId,
    source: { ...source, ...(page !== undefined ? { page } : {}) },
    ...(command.opacityPct !== undefined ? { opacityPct: command.opacityPct } : {}),
  };
  put(e, u);
  e.summary.push(`Placed ${source.name}${page !== undefined ? ` page ${page}` : ""} as an underlay. It isn't calibrated yet, so tracing over it is off until you set its scale`);
  return done(e);
}

function calibration(u: DrawingUnderlay, c: Extract<SpaceDesignCommand, { type: "calibrate_underlay" }>): UnderlayCalibration {
  const keepAt = u.calibration?.modelOrigin;
  const rotationDeg = c.rotationDeg ?? u.calibration?.rotationDeg ?? 0;
  const cal = c.calibration;
  if (cal.method === "two_points") {
    const got = calibrateTwoPoints(cal.a, cal.b, cal.distanceMm, { modelAt: c.modelAt ?? keepAt, rotationDeg });
    if (typeof got === "string") refuse("invalid_value", got, [u.id]);
    return got;
  }
  if (cal.method === "stated_scale") {
    const ratio = parseDrawingScale(cal.scale);
    if (ratio === null) refuse("invalid_value", `"${cal.scale}" isn't a scale this can read. Write it as printed on the sheet, such as 1/8" = 1'-0" or 1:100`, [u.id]);
    const mmPerUnit = statedScaleMmPerUnit(u.source.format, ratio, cal.pixelsPerInch);
    if (typeof mmPerUnit === "string") refuse("invalid_value", mmPerUnit, [u.id]);
    return { sourceOrigin: u.calibration?.sourceOrigin ?? { x: 0, y: 0 }, modelOrigin: c.modelAt ?? keepAt ?? { x: 0, y: 0 }, mmPerUnit, rotationDeg, method: "stated_scale" };
  }
  if (u.source.format !== "dxf" && u.source.format !== "dwg") refuse("invalid_value", "Drawing units are for CAD files; a PDF or image takes a printed scale or two points", [u.id]);
  return { sourceOrigin: u.calibration?.sourceOrigin ?? { x: 0, y: 0 }, modelOrigin: c.modelAt ?? keepAt ?? { x: 0, y: 0 }, mmPerUnit: CAD_UNIT_MM[cal.unit], rotationDeg, method: "cad_units" };
}

function lockedRefusal(u: DrawingUnderlay): never {
  return refuse("locked", `${u.source.name} is locked so it can't slide while you trace. Unlock it first`, [u.id]);
}

function calibrateUnderlay(model: ModelState, command: Extract<SpaceDesignCommand, { type: "calibrate_underlay" }>): ExecuteResult {
  const e = begin(model);
  const u = current(e, command.underlayId, "drawing_underlay", "underlay");
  if (u.locked) lockedRefusal(u);
  const cal = calibration(u, command);
  put(e, { ...u, calibration: cal });
  const how = command.calibration.method === "stated_scale" ? `at ${command.calibration.scale}` : command.calibration.method === "two_points" ? "from two points" : `in ${command.calibration.unit}`;
  e.summary.push(`Calibrated ${u.source.name} ${how}; tracing over it is on`);
  return done(e);
}

function editUnderlay(model: ModelState, command: Extract<SpaceDesignCommand, { type: "edit_underlay" }>): ExecuteResult {
  const e = begin(model);
  const u = current(e, command.underlayId, "drawing_underlay", "underlay");
  const moving = command.modelAt !== undefined || command.rotationDeg !== undefined;
  if (moving && (command.locked ?? u.locked)) lockedRefusal(u);
  if (moving && !isCalibrated(u)) refuse("invalid_value", `Calibrate ${u.source.name} before moving it, so it moves at the right size`, [u.id]);
  const next: DrawingUnderlay = {
    ...u,
    ...(command.opacityPct !== undefined ? { opacityPct: command.opacityPct } : {}),
    ...(command.locked !== undefined ? { locked: command.locked } : {}),
    ...(command.hidden !== undefined ? { hidden: command.hidden } : {}),
    ...(moving && u.calibration ? { calibration: { ...u.calibration, ...(command.modelAt ? { modelOrigin: command.modelAt } : {}), ...(command.rotationDeg !== undefined ? { rotationDeg: command.rotationDeg } : {}) } } : {}),
  };
  if (spatialDesignFingerprint(next) === spatialDesignFingerprint(u)) refuse("invalid_value", `Nothing to change on ${u.source.name}`, [u.id]);
  put(e, next);
  const what = [
    command.opacityPct !== undefined ? `opacity ${Math.round(command.opacityPct)}%` : null,
    command.locked !== undefined ? (command.locked ? "locked" : "unlocked") : null,
    command.hidden !== undefined ? (command.hidden ? "hidden" : "shown") : null,
    moving ? "moved" : null,
  ].filter((w): w is string => w !== null);
  e.summary.push(`${u.source.name}: ${what.join(", ")}`);
  return done(e);
}

function deleteUnderlays(model: ModelState, command: Extract<SpaceDesignCommand, { type: "delete_underlays" }>): ExecuteResult {
  const e = begin(model);
  const names: string[] = [];
  for (const uid of command.underlayIds) {
    const u = current(e, uid, "drawing_underlay", "underlay");
    names.push(u.source.name);
    drop(e, u.id);
  }
  e.summary.push(`Removed ${names.length === 1 ? `underlay ${names[0]}` : plural(names.length, "underlay")}; spaces traced over ${names.length === 1 ? "it" : "them"} keep their outlines`);
  return done(e);
}

// ---------------------------------------------------------------- ceilings from a stated height

/** The id a ceiling made from a space's stated height gets (the space's nth outline after the first adds `:n`). */
export function ceilingIdForSpace(spaceId: string, n = 1): ElementId {
  return asElementId(n === 1 ? `ceiling:${spaceId}` : `ceiling:${spaceId}:${n}`);
}

/** Why a space's stated height can't become a ceiling, in words; null when it can. The Spaces list shows it on the disabled action. */
export function makeCeilingFromHeightRefusal(elements: Readonly<Record<string, BimElement>>, space: Space): string | null {
  if (space.ceilingHeightMm === undefined) return `${spaceLabel(space)} has no ceiling height stated. Type one in its row first, or draw the ceiling on a ceiling plan`;
  if (!space.levelId) return `${spaceLabel(space)} isn't on a level yet. Draw it on a plan first`;
  if (spaceOutlines(elements, space).filter((o) => o.length >= 3).length === 0) return `${spaceLabel(space)} has no outline yet. Draw it on a plan first`;
  return null;
}

/** One flat ceiling over the space's outline (one per outline for a space made of several rooms) at its stated height, hosted in it. */
function makeCeilingFromSpaceHeight(model: ModelState, command: Extract<SpaceDesignCommand, { type: "make_ceiling_from_space_height" }>): ExecuteResult {
  const e = beginCeilingEdit(model);
  const key = asElementId(command.spaceId);
  const space = e.reader.find(key);
  if (!space) refuse("element_not_found", `There is no space ${command.spaceId}`, [key]);
  if (space.kind !== "space") refuse("wrong_kind", `${command.spaceId} is a ${space.kind.replace(/_/g, " ")}, not a space`, [key]);
  const why = makeCeilingFromHeightRefusal(model.elements, space);
  if (why) refuse("invalid_value", why, [space.id]);
  const heightMm = space.ceilingHeightMm;
  const levelId = space.levelId;
  if (heightMm === undefined || !levelId) refuse("invalid_value", `${spaceLabel(space)} has no height or level`, [space.id]);
  const outlines = spaceOutlines(model.elements, space).filter((o) => o.length >= 3);
  addCeilings(
    e,
    outlines.map((o, i) => ({
      ceilingId: command.ceilingId && i === 0 ? command.ceilingId : command.ceilingId ? `${command.ceilingId}:${i + 1}` : ceilingIdForSpace(space.id, i + 1),
      levelId,
      spaceId: space.id,
      outline: o.map((p) => ({ x: p.x, y: p.y })),
      form: "flat" as const,
      heightMm,
    })),
  );
  e.summary.push(`Made from ${spaceLabel(space)}'s stated ceiling height; the space keeps its height, and the ceiling now answers for it`);
  return finishCeilingEdit(e);
}

/** A use with add-on parameter rates is written only to peers that store them. */
function requireParameterRatesWritable(command: SpaceDesignCommand): void {
  const uses = command.type === "create_space" ? command.spaces.map((s) => s.use) : command.type === "edit_space" || command.type === "make_spaces_from_rooms" || command.type === "place_space_in_walls" ? [command.use] : [];
  if (!uses.some((u) => (u?.parameterRates?.length ?? 0) > 0)) return;
  if (!peerReadsServiceFeature(SPACES_PARAMETER_RATES_FEATURE)) refuse("invalid_value", "This use carries an add-on's rates (a live load), which the model server this model is open on can't store yet; set the use again once the server is updated");
}

export function executeSpaceDesignCommand(model: ModelState, command: SpaceDesignCommand): ExecuteResult {
  return guard(() => {
    requireParameterRatesWritable(command);
    switch (command.type) {
      case "create_space":
        return createSpaces(model, command);
      case "edit_space":
        return editSpace(model, command);
      case "delete_spaces":
        return deleteSpaces(model, command);
      case "make_spaces_from_rooms":
        return makeFromRooms(model, command);
      case "create_zone":
        return createZone(model, command);
      case "edit_zone":
        return editZone(model, command);
      case "accept_derived_zone":
        return acceptDerivedZone(model, command);
      case "delete_zones":
        return deleteZones(model, command);
      case "place_underlay":
        return placeUnderlay(model, command);
      case "calibrate_underlay":
        return calibrateUnderlay(model, command);
      case "edit_underlay":
        return editUnderlay(model, command);
      case "delete_underlays":
        return deleteUnderlays(model, command);
      case "make_ceiling_from_space_height":
        return makeCeilingFromSpaceHeight(model, command);
      case "place_space_in_walls":
        return placeSpaceInWalls(model, command);
      case "split_space":
        return splitSpace(model, command);
      case "merge_space_children":
        return mergeSpaceChildren(model, command);
    }
  });
}
