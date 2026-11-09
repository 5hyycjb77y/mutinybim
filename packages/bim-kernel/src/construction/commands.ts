import { z } from "zod";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { elementName, isClassifiedElement, isCoreElement } from "../elements/feature";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { currentSchemaVersion } from "../schema-version/registry";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { constructionStagesWritable, OLDER_PEER } from "../qto/feature";
import { constructionStageIdOf } from "../qto/group";
import type { ConstructionStageBody, ConstructionStageElement } from "../qto/types";
import { constructionStages, isConstructionStage, stageMembersOf } from "./members";

/**
 * Construction stages (KERNEL-FOUNDATION §3.9): add, edit, reorder and delete
 * stages, and set the stage an element is built in. A stage says when and
 * where something is built; it never changes a design value. Every edit is
 * one undo step. Refused while the model server doesn't store stages yet.
 */

const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(80);
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.+\-Z]{0,30})?$/, "a date as YYYY-MM-DD");
const MAX_IDS = 500;
const MAX_STAGES = 200;

export const constructionCommandSchemas = [
  z
    .object({
      type: z.literal("add_construction_stage"),
      /** Chosen by the sender so a retried request makes the same stage, not a second one. */
      stageId: id,
      name,
      /** Absent: after the last stage. */
      order: z.number().int().min(0).max(100_000).optional(),
      zoneIds: z.array(id).max(MAX_IDS).optional(),
      classIds: z.array(id).max(MAX_IDS).optional(),
      plannedStart: isoDate.optional(),
      plannedFinish: isoDate.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("edit_construction_stage"),
      stageId: id,
      name: name.optional(),
      zoneIds: z.array(id).max(MAX_IDS).optional(),
      classIds: z.array(id).max(MAX_IDS).optional(),
      /** `null` clears it. */
      plannedStart: isoDate.nullable().optional(),
      plannedFinish: isoDate.nullable().optional(),
    })
    .strict(),
  /** Every stage of the model, in the new order. */
  z.object({ type: z.literal("reorder_construction_stages"), stageIds: z.array(id).min(1).max(MAX_STAGES) }).strict(),
  /** Elements in it are left with no stage, in the same undo step. */
  z.object({ type: z.literal("delete_construction_stage"), stageId: id }).strict(),
  /** `null` takes the elements out of any stage. */
  z.object({ type: z.literal("set_construction_stage"), elementIds: z.array(id).min(1).max(MAX_IDS), stageId: id.nullable() }).strict(),
] as const;

export const constructionCommandSchema = z.discriminatedUnion("type", [...constructionCommandSchemas]);
export type ConstructionCommand = z.infer<typeof constructionCommandSchema>;

const TYPES: ReadonlySet<string> = new Set(constructionCommandSchemas.map((s) => s.shape.type.value));

export function isConstructionCommand(command: { readonly type: string }): command is ConstructionCommand {
  return TYPES.has(command.type);
}

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

function stageOf(e: Edit, raw: string): ConstructionStageElement {
  const key = asElementId(raw);
  const el = e.working[key] ?? e.reader.find(key);
  if (!el) refuse("element_not_found", `There is no construction stage ${raw}. Open Manage › Construction stages to see the model's stages`, [key]);
  if (!isConstructionStage(el)) refuse("wrong_kind", `${raw} is a ${el.kind.replace(/_/g, " ")}, not a construction stage`, [key]);
  return el;
}

function fingerprint(s: ConstructionStageBody): string {
  return JSON.stringify([s.name, s.order, s.zoneIds ?? [], s.classIds ?? [], s.plannedStart ?? "", s.plannedFinish ?? ""]);
}

function putStage(e: Edit, el: ConstructionStageElement): void {
  e.working[el.id] = el;
  e.touched.push(el.id);
  e.authored.push({ elementId: el.id, field: "stage", value: fingerprint(el.stage) });
}

function checkDates(start: string | undefined, finish: string | undefined, stageName: string): void {
  if (start && finish && finish.slice(0, 10) < start.slice(0, 10)) refuse("invalid_value", `${stageName} would finish (${finish.slice(0, 10)}) before it starts (${start.slice(0, 10)}). Change one of the dates`);
}

function nameTaken(e: Edit, stageName: string, self: string): void {
  const want = stageName.trim().toLowerCase();
  for (const s of constructionStages(e.reader.model.elements)) {
    const now = e.working[s.id];
    if (s.id !== self && isConstructionStage(now) && now.stage.name.trim().toLowerCase() === want) refuse("already_exists", `There is already a stage called ${now.stage.name}. Give this one another name`, [s.id]);
  }
}

function body(fields: { name: string; order: number; zoneIds?: readonly string[]; classIds?: readonly string[]; plannedStart?: string; plannedFinish?: string }): ConstructionStageBody {
  return {
    name: fields.name,
    order: fields.order,
    ...(fields.zoneIds && fields.zoneIds.length > 0 ? { zoneIds: [...new Set(fields.zoneIds)] } : {}),
    ...(fields.classIds && fields.classIds.length > 0 ? { classIds: [...new Set(fields.classIds)] } : {}),
    ...(fields.plannedStart ? { plannedStart: fields.plannedStart } : {}),
    ...(fields.plannedFinish ? { plannedFinish: fields.plannedFinish } : {}),
  };
}

function checkZones(e: Edit, zoneIds: readonly string[] | undefined): void {
  for (const z of zoneIds ?? []) {
    const el = e.reader.find(asElementId(z));
    if (el?.kind !== "zone") refuse("element_not_found", `There is no zone ${z} to use as a work area. Pick the zone again`, [asElementId(z)]);
  }
}

/** Kinds that carry a stage: the building and structure kinds, ceilings, and the classed kinds (spaces, runs, parts). */
function takesStage(el: BimElement): boolean {
  return isCoreElement(el) || isClassifiedElement(el) || el.kind === "ceiling";
}

/** A record that may carry a stage (every kind `takesStage` accepts). */
type Staged = BimElement & { readonly constructionStageId?: string };

/** The same record with only `constructionStageId` changed. */
function withStage(el: Staged, stageId: string | null): Staged {
  if (stageId !== null) return { ...el, constructionStageId: stageId };
  const next = { ...el };
  delete next.constructionStageId;
  return next;
}

function labelOf(el: BimElement): string {
  if (isCoreElement(el) || isClassifiedElement(el)) return elementName(el);
  return `${el.kind.replace(/_/g, " ")} ${el.id}`;
}

export function executeConstructionCommand(model: ModelState, command: ConstructionCommand): ExecuteResult {
  return guard(() => {
    if (!constructionStagesWritable()) refuse("invalid_value", `Construction stages ${OLDER_PEER}`);
    const e = begin(model);
    switch (command.type) {
      case "add_construction_stage": {
        const key = asElementId(command.stageId);
        if (e.reader.find(key)) refuse("already_exists", `${command.stageId} already exists; choose a new id for the stage`, [key]);
        nameTaken(e, command.name, command.stageId);
        checkDates(command.plannedStart, command.plannedFinish, command.name);
        checkZones(e, command.zoneIds);
        const existing = constructionStages(model.elements);
        const order = command.order ?? (existing.length === 0 ? 0 : Math.max(...existing.map((s) => s.stage.order)) + 1);
        putStage(e, {
          id: key,
          kind: "construction_stage",
          version: 0,
          authoredRev: {},
          partition: GLOBAL_PARTITION,
          schemaVersion: currentSchemaVersion("construction_stage"),
          stage: body({ name: command.name, order, zoneIds: command.zoneIds, classIds: command.classIds, plannedStart: command.plannedStart, plannedFinish: command.plannedFinish }),
        });
        e.summary.push(`Added stage ${command.name}`);
        return done(e);
      }
      case "edit_construction_stage": {
        const prior = stageOf(e, command.stageId);
        const nextName = command.name ?? prior.stage.name;
        if (command.name !== undefined) nameTaken(e, command.name, prior.id);
        const start = command.plannedStart === null ? undefined : (command.plannedStart ?? prior.stage.plannedStart);
        const end = command.plannedFinish === null ? undefined : (command.plannedFinish ?? prior.stage.plannedFinish);
        checkDates(start, end, nextName);
        checkZones(e, command.zoneIds);
        const stage = body({ name: nextName, order: prior.stage.order, zoneIds: command.zoneIds ?? prior.stage.zoneIds, classIds: command.classIds ?? prior.stage.classIds, plannedStart: start, plannedFinish: end });
        if (fingerprint(stage) === fingerprint(prior.stage)) return done(e);
        putStage(e, { ...prior, stage });
        e.summary.push(prior.stage.name === nextName ? `Changed stage ${nextName}` : `Renamed stage ${prior.stage.name} to ${nextName}`);
        return done(e);
      }
      case "reorder_construction_stages": {
        const all = constructionStages(model.elements);
        const sent = [...new Set(command.stageIds)];
        if (sent.length !== command.stageIds.length) refuse("invalid_value", "A stage is listed twice in the new order. List each stage once");
        const missing = all.filter((s) => !sent.includes(s.id));
        if (missing.length > 0) refuse("invalid_value", `The new order leaves out ${missing.map((s) => s.stage.name).join(", ")}. List every stage`, missing.map((s) => s.id));
        sent.forEach((sid, order) => {
          const s = stageOf(e, sid);
          if (s.stage.order !== order) putStage(e, { ...s, stage: { ...s.stage, order } });
        });
        if (e.touched.length > 0) e.summary.push(`Reordered ${all.length} construction stages`);
        return done(e);
      }
      case "delete_construction_stage": {
        const s = stageOf(e, command.stageId);
        const members = [...(stageMembersOf(model.elements).byStage.get(s.id) ?? [])];
        for (const mid of members) {
          const el = e.reader.find(asElementId(mid));
          if (!el || constructionStageIdOf(el) !== s.id) continue;
          e.working[el.id] = withStage(el, null);
          e.touched.push(el.id);
          e.authored.push({ elementId: el.id, field: "constructionStageId", value: "" });
        }
        delete e.working[s.id];
        e.removed.push(s.id);
        e.summary.push(members.length > 0 ? `Deleted stage ${s.stage.name}; ${members.length} element${members.length === 1 ? " is" : "s are"} now in no stage` : `Deleted stage ${s.stage.name}`);
        return done(e);
      }
      case "set_construction_stage": {
        const stage = command.stageId === null ? null : stageOf(e, command.stageId);
        let changed = 0;
        for (const raw of new Set(command.elementIds)) {
          const key = asElementId(raw);
          const el = e.reader.find(key);
          if (!el) refuse("element_not_found", `There is no element ${raw}. Pick it again`, [key]);
          if (!takesStage(el)) refuse("wrong_kind", `${labelOf(el)} isn't built, so it has no construction stage`, [key]);
          const want = stage?.id ?? null;
          if (constructionStageIdOf(el) === want) continue;
          e.working[key] = withStage(el, want);
          e.touched.push(key);
          e.authored.push({ elementId: key, field: "constructionStageId", value: want ?? "" });
          changed++;
        }
        if (changed > 0) e.summary.push(stage ? `${changed} element${changed === 1 ? "" : "s"} now in ${stage.stage.name}` : `${changed} element${changed === 1 ? "" : "s"} taken out of their stage`);
        return done(e);
      }
    }
  });
}
