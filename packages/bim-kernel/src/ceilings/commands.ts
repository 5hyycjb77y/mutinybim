import { z } from "zod";
import { canonicalJson } from "../canonical";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { REGISTRY_ID_MAX_LENGTH, REGISTRY_ID_PATTERN } from "../ids";
import { TrackedReader } from "../model";
import { activeClassRegistry } from "../registry";
import { cleanOutline, containsPoint, outlineAreaMm2, outlineProblem, MM2_PER_M2 } from "../spaces/space-geometry";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type Level, type ModelState, type Partition, type Vec2 } from "../types";
import { CEILING_CLASS_ID, CEILINGS_NOT_YET, ceilingsWritable } from "./feature";
import { ceilingForm, ceilingLabel, ceilingSlope, defaultRoleForForm, isCeiling, surfaceRoles } from "./read";
import { ceilingStructureProblem, ftIn } from "./structure";
import { KNOWN_CEILING_FORMS, type Ceiling, type CeilingForm, type CeilingSlope } from "./types";

/**
 * Ceiling edits: the one path the ceiling plan's Ceiling tool, "Make a
 * ceiling from this height" and the agent tools use. Every edit undoes as
 * one step. A ceiling is a generic typed surface: what it is made of is its
 * element type (an acoustic tile, gypsum board, a rated assembly), never a
 * field of one trade. Writes need peers that store ceilings
 * (`elements:ceilings`); otherwise the command refuses in words and nothing
 * changes.
 */

const id = z.string().trim().min(1).max(200);
const vec2 = z.object({ x: z.number().finite().min(-1e9).max(1e9), y: z.number().finite().min(-1e9).max(1e9) }).strict();
const outline = z.array(vec2).min(3).max(2000);
/** Heights above the level, mm (up to about 330 ft). */
const heightMm = z.number().finite().positive().max(100_000);
const slope = z
  .object({
    /** Degrees counter-clockwise from east: the direction the plane rises toward. */
    directionDeg: z.number().finite().min(-3600).max(3600),
    /** Rise over run (0.25 is 3 in 12). */
    pitch: z.number().finite().min(-10).max(10).refine((p) => p !== 0, "A slope needs a pitch; a flat ceiling has no slope"),
  })
  .strict();
const registryId = z.string().max(REGISTRY_ID_MAX_LENGTH).regex(REGISTRY_ID_PATTERN, "an id such as ceiling or zz.baffle");
// Writers set only the forms this release knows; readers keep any stored form (read.ts).
const form = z.enum(KNOWN_CEILING_FORMS);

const ceilingInput = z
  .object({
    /** Chosen by the sender so a retried request makes the same ceiling, not a second one. */
    ceilingId: id,
    levelId: id,
    /** The space it is hosted in. Absent: in none (a canopy, an open area). */
    spaceId: id.optional(),
    outline,
    holes: z.array(outline).max(200).optional(),
    /** Absent: sloped when a slope is given, else flat. */
    form: form.optional(),
    heightMm,
    /** Where the height is measured on a sloped plane. Absent: the outline's first corner. */
    reference: vec2.optional(),
    slope: slope.optional(),
    /** A surface role in force (built-in or an add-on's). Absent: the form's own. */
    role: registryId.optional(),
    classId: registryId.optional(),
    /** An element type (what it is made of). */
    typeId: id.optional(),
  })
  .strict();

export const ceilingCommandSchemas = [
  z.object({ type: z.literal("create_ceiling"), ceilings: z.array(ceilingInput).min(1).max(500) }).strict(),
  z
    .object({
      type: z.literal("edit_ceiling"),
      ceilingId: id,
      levelId: id.optional(),
      /** `null` takes it out of its space. */
      spaceId: id.nullable().optional(),
      outline: outline.optional(),
      /** `null` (or an empty list) removes every hole. */
      holes: z.array(outline).max(200).nullable().optional(),
      form: form.optional(),
      heightMm: heightMm.optional(),
      reference: vec2.nullable().optional(),
      /** `null` makes it flat. */
      slope: slope.nullable().optional(),
      /** `null`: back to the form's own role. */
      role: registryId.nullable().optional(),
      classId: registryId.optional(),
      /** `null` clears the type. */
      typeId: id.nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("delete_ceilings"), ceilingIds: z.array(id).min(1).max(500) }).strict(),
] as const;

export const ceilingCommandSchema = z.discriminatedUnion("type", [...ceilingCommandSchemas]);
export type CeilingCommand = z.infer<typeof ceilingCommandSchema>;
export type CeilingInput = z.infer<typeof ceilingInput>;

const CEILING_COMMANDS: ReadonlySet<string> = new Set(ceilingCommandSchemas.map((s) => s.shape.type.value));

export function isCeilingCommand(command: { readonly type: string }): command is CeilingCommand {
  return CEILING_COMMANDS.has(command.type);
}

/** What undo and conflict checks compare on a ceiling (authored field "ceiling"): everything a person set, without the bookkeeping. */
export const CEILING_FIELD = "ceiling";

export function ceilingFingerprint(c: Ceiling): string {
  const { id: _id, version: _version, authoredRev: _rev, ...rest } = c;
  return canonicalJson(rest);
}

// ---------------------------------------------------------------- edit helpers

/** One open ceiling edit: what it read, wrote and will say. */
export interface CeilingEdit {
  readonly reader: TrackedReader;
  readonly working: Record<string, BimElement>;
  readonly touched: ElementId[];
  readonly authored: AuthoredWrite[];
  readonly removed: ElementId[];
  readonly summary: string[];
}

type Edit = CeilingEdit;

function begin(model: ModelState): Edit {
  return { reader: new TrackedReader(model), working: draftElements(model.elements), touched: [], authored: [], removed: [], summary: [] };
}

function put(e: Edit, c: Ceiling): void {
  e.working[c.id] = c;
  e.touched.push(c.id);
  e.authored.push({ elementId: c.id, field: CEILING_FIELD, value: ceilingFingerprint(c) });
}

/** The edit's result, with a plain warning for each written ceiling that rises above the structure over it. */
function done(e: Edit): ExecuteResult {
  const result = finish(e.reader, e.working, e.touched, e.authored, () => [], { removedIds: e.removed, summary: e.summary });
  if (!result.ok) return result;
  const warnings: string[] = [];
  for (const cid of e.touched) {
    const c = result.model.elements[cid];
    if (!isCeiling(c)) continue;
    const problem = ceilingStructureProblem(result.model, c);
    if (problem) warnings.push(problem);
  }
  return warnings.length === 0 ? result : { ...result, summary: [...(result.summary ?? []), ...warnings] };
}

function requireWritable(): void {
  if (!ceilingsWritable()) refuse("invalid_value", CEILINGS_NOT_YET);
}

function current(e: Edit, cid: string): Ceiling {
  const key = asElementId(cid);
  const el: BimElement | undefined = e.working[key] ?? e.reader.find(key);
  if (!el) refuse("element_not_found", `There is no ceiling ${cid}`, [key]);
  if (!isCeiling(el)) refuse("wrong_kind", `${cid} is a ${el.kind.replace(/_/g, " ")}, not a ceiling`, [key]);
  return el;
}

function requireLevel(e: Edit, levelId: string): Level {
  const lvl = e.reader.find(asElementId(levelId));
  if (lvl?.kind !== "level") refuse("element_not_found", `There is no level ${levelId}`, [asElementId(levelId)]);
  return lvl;
}

function requireSpaceOn(e: Edit, spaceId: string, levelId: ElementId): ElementId {
  const key = asElementId(spaceId);
  const s = e.working[key] ?? e.reader.find(key);
  if (s?.kind !== "space") refuse(s ? "wrong_kind" : "element_not_found", s ? `${spaceId} is a ${s.kind.replace(/_/g, " ")}, not a space` : `There is no space ${spaceId}`, [key]);
  if (s.levelId !== levelId) refuse("invalid_value", `Space ${s.number || s.id} is on another level; host the ceiling in a space on its own level, or leave the space out`, [key]);
  return s.id;
}

function cleanedOutline(points: readonly Vec2[], what: string): Vec2[] {
  const o = cleanOutline(points);
  const problem = outlineProblem(o);
  if (problem) refuse("invalid_value", problem.replace(/^A space needs/, `A ${what} needs`).replace("around the space", `around the ${what}`).replace("encloses almost no floor", "covers almost nothing"));
  return o;
}

function cleanedHoles(holes: readonly (readonly Vec2[])[] | null | undefined, around: readonly Vec2[]): Vec2[][] {
  const out: Vec2[][] = [];
  for (const h of holes ?? []) {
    const hole = cleanedOutline(h, "hole");
    if (!hole.every((p) => containsPoint(around, p))) refuse("invalid_value", "A hole must sit inside the ceiling's outline. Draw the opening within it, or redraw the outline around it");
    out.push(hole);
  }
  return out;
}

/** Forms whose plane may slope: a sloped ceiling, a cloud hung at an angle, exposed structure that slopes. */
const SLOPING_FORMS: ReadonlySet<string> = new Set(["sloped", "cloud", "open_to_structure"]);

function checkFormAndSlope(f: CeilingForm, s: CeilingSlope | null): void {
  if (f === "sloped" && !s) refuse("invalid_value", "A sloped ceiling needs its slope: which way it rises and how steeply. Give a slope, or make it flat");
  if (s && !SLOPING_FORMS.has(f)) refuse("invalid_value", `A ${f.replace(/_/g, " ")} ceiling has no slope. Choose sloped, or leave the slope out`);
}

function requireRole(role: string): string {
  const roles = surfaceRoles();
  if (!roles.some((r) => r.id === role)) refuse("invalid_value", `"${role}" isn't a surface role this model knows. Choose one of: ${roles.map((r) => r.label).join(", ")}`);
  return role;
}

function requireClass(classId: string): string {
  if (classId.startsWith("firm:")) return classId;
  const cls = activeClassRegistry().getClass(classId);
  if (!cls) refuse("invalid_value", `"${classId}" isn't a class this model knows; ceilings are ${CEILING_CLASS_ID} or a class an add-on adds for them`);
  if (cls.abstract) refuse("invalid_value", `${cls.label} is a grouping of classes, not one to give a ceiling; choose one of its classes`);
  const kinds = cls.recognize?.elementKinds ?? [];
  if (kinds.length > 0 && !kinds.includes("ceiling")) refuse("invalid_value", `${cls.label} is a class of ${kinds.map((k) => `${k.replace(/_/g, " ")}s`).join(" and ")}, not of ceilings`);
  return classId;
}

function requireType(e: Edit, typeId: string): ElementId {
  const key = asElementId(typeId);
  const t = e.working[key] ?? e.reader.find(key);
  if (t?.kind !== "element_type") refuse(t ? "wrong_kind" : "element_not_found", t ? `${typeId} is a ${t.kind.replace(/_/g, " ")}, not an element type` : `There is no element type ${typeId}. Make the type first (an acoustic tile, gypsum board, a rated assembly)`, [key]);
  if (t.forKinds && !t.forKinds.includes("ceiling")) refuse("invalid_value", `${t.name} is a type for ${t.forKinds.map((k) => `${k}s`).join(" and ")}, not ceilings`, [key]);
  return t.id;
}

function partitionOn(level: Level): Partition {
  return { level: level.name, zone: "Z1", discipline: "architecture" };
}

function sqft(areaMm2: number): string {
  return `${Math.round((areaMm2 / MM2_PER_M2) * 10.7639)} sq ft`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A ceiling as written: its plan area and height in words ("flat, 9'-0", 320 sq ft"). */
function describe(c: Ceiling): string {
  const f = ceilingForm(c);
  const s = ceilingSlope(c);
  const rise = s ? `, rising ${Math.round(Math.abs(s.pitch) * 12 * 10) / 10} in 12` : "";
  const holes = c.holes?.length ? ` less ${plural(c.holes.length, "opening")}` : "";
  return `${f.replace(/_/g, " ")}, ${ftIn(c.heightMm)}${rise}, ${sqft(outlineAreaMm2(c.outline))}${holes}`;
}

/** The ceiling a create input makes (shared with "Make a ceiling from this height"). */
export function newCeiling(e: Edit, input: CeilingInput): Ceiling {
  const cid = asElementId(input.ceilingId);
  if (e.working[cid] ?? e.reader.find(cid)) refuse("already_exists", `${input.ceilingId} already exists; choose a new id for the ceiling`, [cid]);
  const level = requireLevel(e, input.levelId);
  const spaceId = input.spaceId !== undefined ? requireSpaceOn(e, input.spaceId, level.id) : undefined;
  const o = cleanedOutline(input.outline, "ceiling");
  const holes = cleanedHoles(input.holes, o);
  const s = input.slope ?? null;
  const f: CeilingForm = input.form ?? (s ? "sloped" : "flat");
  checkFormAndSlope(f, s);
  const role = input.role !== undefined ? requireRole(input.role) : undefined;
  return {
    id: cid,
    kind: "ceiling",
    version: 0,
    authoredRev: {},
    partition: partitionOn(level),
    classId: input.classId !== undefined ? requireClass(input.classId) : CEILING_CLASS_ID,
    ...(input.typeId !== undefined ? { typeId: requireType(e, input.typeId) } : {}),
    levelId: level.id,
    ...(spaceId ? { spaceId } : {}),
    outline: o,
    ...(holes.length > 0 ? { holes } : {}),
    form: f,
    heightMm: input.heightMm,
    ...(input.reference ? { reference: input.reference } : {}),
    ...(s ? { slope: s } : {}),
    ...(role !== undefined && role !== defaultRoleForForm(f) ? { role } : {}),
  };
}

// ---------------------------------------------------------------- commands

function spaceWords(e: Edit, spaceId: ElementId | undefined): string {
  if (!spaceId) return "";
  const s = e.working[spaceId] ?? e.reader.find(spaceId);
  return s?.kind === "space" ? ` in ${[s.number, s.name].filter(Boolean).join(" ") || s.id}` : "";
}

/** Create ceilings in an edit that is already open (the space command "Make a ceiling from this height" uses it too). */
export function addCeilings(e: Edit, inputs: readonly CeilingInput[]): Ceiling[] {
  requireWritable();
  const made = inputs.map((input) => {
    const c = newCeiling(e, input);
    put(e, c);
    return c;
  });
  const first = made[0];
  e.summary.push(made.length === 1 && first ? `Drew ${ceilingLabel(first).toLowerCase()}${spaceWords(e, first.spaceId)} (${describe(first)})` : `Drew ${plural(made.length, "ceiling")}`);
  return made;
}

function createCeilings(model: ModelState, command: Extract<CeilingCommand, { type: "create_ceiling" }>): ExecuteResult {
  const e = begin(model);
  addCeilings(e, command.ceilings);
  return done(e);
}

/** An edit's optional field: `null` clears it, absent keeps what was there. */
function keep<T>(sent: T | null | undefined, prior: T | undefined): T | undefined {
  return sent === null ? undefined : sent === undefined ? prior : sent;
}

function editCeiling(model: ModelState, command: Extract<CeilingCommand, { type: "edit_ceiling" }>): ExecuteResult {
  requireWritable();
  const e = begin(model);
  const c = current(e, command.ceilingId);
  const level = command.levelId !== undefined ? requireLevel(e, command.levelId) : null;
  const levelId = level?.id ?? c.levelId;
  const o = command.outline ? cleanedOutline(command.outline, "ceiling") : [...c.outline];
  const holes = command.holes !== undefined ? cleanedHoles(command.holes, o) : command.outline ? cleanedHoles(c.holes, o) : (c.holes ?? []).map((h) => [...h]);
  // A named space (or the kept one, when the ceiling moves level) must be on the ceiling's level.
  const spaceId: ElementId | undefined =
    command.spaceId === null ? undefined : command.spaceId !== undefined ? requireSpaceOn(e, command.spaceId, levelId) : c.spaceId && level ? requireSpaceOn(e, c.spaceId, levelId) : c.spaceId;
  const s = command.slope === null ? null : (command.slope ?? ceilingSlope(c));
  // A stored form this release doesn't know is kept until the person picks one.
  const f: CeilingForm = command.form ?? (command.slope && ceilingForm(c) === "flat" ? "sloped" : command.slope === null && ceilingForm(c) === "sloped" ? "flat" : ceilingForm(c));
  if (command.form !== undefined || command.slope !== undefined) checkFormAndSlope(f, s);
  const role = command.role === null ? undefined : command.role !== undefined ? requireRole(command.role) : c.role;
  const reference = keep(command.reference, c.reference);
  const typeId = command.typeId === null ? undefined : command.typeId !== undefined ? requireType(e, command.typeId) : c.typeId;
  const { spaceId: _s, holes: _h, slope: _sl, role: _r, reference: _ref, typeId: _t, classSource: priorClassSource, ...base } = c;
  // A class set by hand is the person's own, no longer the recognised one.
  const classSource = command.classId !== undefined ? undefined : priorClassSource;
  const next: Ceiling = {
    ...base,
    ...(level ? { levelId: level.id, partition: partitionOn(level) } : {}),
    ...(command.classId !== undefined ? { classId: requireClass(command.classId) } : {}),
    ...(classSource ? { classSource } : {}),
    ...(typeId ? { typeId } : {}),
    ...(spaceId ? { spaceId } : {}),
    outline: o,
    ...(holes.length > 0 ? { holes } : {}),
    form: f,
    heightMm: command.heightMm ?? c.heightMm,
    ...(reference ? { reference } : {}),
    ...(s ? { slope: s } : {}),
    ...(role !== undefined && role !== defaultRoleForForm(f) ? { role } : {}),
  };
  if (ceilingFingerprint(next) === ceilingFingerprint(c)) refuse("invalid_value", `Nothing to change: ${ceilingLabel(c)} already reads that way`, [c.id]);
  put(e, next);
  e.summary.push(`Changed ${ceilingLabel(next).toLowerCase()} (${describe(next)})`);
  return done(e);
}

function deleteCeilings(model: ModelState, command: Extract<CeilingCommand, { type: "delete_ceilings" }>): ExecuteResult {
  requireWritable();
  const e = begin(model);
  const labels: string[] = [];
  for (const cid of new Set(command.ceilingIds)) {
    const c = current(e, cid);
    labels.push(ceilingLabel(c).toLowerCase());
    delete e.working[c.id];
    e.removed.push(c.id);
  }
  e.summary.push(labels.length === 1 ? `Deleted ${labels[0]}` : `Deleted ${plural(labels.length, "ceiling")}`);
  return done(e);
}

export function executeCeilingCommand(model: ModelState, command: CeilingCommand): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "create_ceiling":
        return createCeilings(model, command);
      case "edit_ceiling":
        return editCeiling(model, command);
      case "delete_ceilings":
        return deleteCeilings(model, command);
    }
  });
}

// ---------------------------------------------------------------- for other edits

/** Open a ceiling edit inside another command (the space command that makes a ceiling from a space's height). */
export function beginCeilingEdit(model: ModelState): Edit {
  return begin(model);
}

/** Finish an edit opened with `beginCeilingEdit`. */
export function finishCeilingEdit(e: Edit): ExecuteResult {
  return done(e);
}
