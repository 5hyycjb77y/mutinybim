import { z } from "zod";
import { canonicalJson } from "../canonical";
import { round } from "../geometry";
import { TrackedReader, requireKind } from "../model";
import { draftElements } from "../store";
import { partTypeIssues, type PartTypeDefinition } from "../parts";
import { clearanceOverrideIssues, clearanceOverrideSchema, clearanceZoneSchema, type ClearanceOverride } from "../part-model/clearance";
import { MAX_CURB_MM, hostName, hostTopMm, partHostSchema } from "../spatial";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { RunPropagator, carryConnectedRuns } from "../routing/propagate";
import { partLabelOf } from "../routing/validate";
import { asElementId, type BimElement, type ElementId, type ModelState, type PartInstance } from "../types";

/**
 * Spatial commands:
 *
 * - set_part_host: say which slab or roof parts stand on (ours or linked) and
 *   the curb height; by default each part drops or rises onto it (base = top
 *   of the host + curb), carrying its connected runs the way Move does, or
 *   refusing with the run that can't follow. Sending host null removes the
 *   host; the part stays where it is.
 * - set_part_clearances: a placed part's own changes to its type's clearance
 *   zones (scope instance), or the type's zones themselves (scope type, every
 *   placed part of the type follows).
 */

const idSchema = z.string().min(1).max(200);

export const spatialCommandSchemas = [
  z
    .object({
      type: z.literal("set_part_host"),
      ids: z.array(idSchema).min(1).max(200),
      host: partHostSchema.nullable(),
      /** Curb or rail height, mm; null removes it. Absent: unchanged. */
      curbMm: z.number().finite().min(0).max(MAX_CURB_MM).nullable().optional(),
      /** Move each part onto its host plus curb (default true). */
      seat: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_part_clearances"),
      /** A placed part, or (scope type) a placed part or part type. */
      id: idSchema,
      scope: z.enum(["instance", "type"]),
      /** Scope type: the type's zones, replacing all of them ([] removes every zone). */
      zones: z.array(clearanceZoneSchema).max(12).optional(),
      /** Scope instance: changes by zone id; null clears that zone back to the type's. */
      overrides: z.record(z.string().min(1).max(40), clearanceOverrideSchema.nullable()).optional(),
    })
    .strict(),
] as const;

export type SpatialCommand = z.infer<(typeof spatialCommandSchemas)[number]>;

const TYPES: ReadonlySet<string> = new Set(spatialCommandSchemas.map((s) => s.shape.type.value));

export function isSpatialCommand(command: { readonly type: string }): command is SpatialCommand {
  return TYPES.has(command.type);
}

export function executeSpatialCommand(model: ModelState, command: SpatialCommand): ExecuteResult {
  return guard(() => (command.type === "set_part_host" ? setPartHost(model, command) : setPartClearances(model, command)));
}

function partName(p: PartInstance): string {
  return p.mark || p.id;
}

function setPartHost(model: ModelState, command: Extract<SpatialCommand, { type: "set_part_host" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const host = command.host;
  if (host?.kind === "slab") {
    const slab = reader.find(asElementId(host.elementId));
    if (!slab) refuse("element_not_found", `There is no slab ${host.elementId}`, [asElementId(host.elementId)]);
    requireKind(slab, "slab");
  }
  const seen = new Set<string>();
  const working = draftElements(model.elements);
  const touched = new Set<ElementId>();
  const authored: AuthoredWrite[] = [];
  const runs = new RunPropagator(reader, working, touched, new Set(command.ids));
  // The run pieces each seated part carried, to name them when the result is refused.
  const carried: Array<{ part: PartInstance; dz: number; ids: ReadonlySet<ElementId> }> = [];
  for (const raw of command.ids) {
    if (seen.has(raw)) refuse("invalid_value", `${raw} is listed twice`, [asElementId(raw)]);
    seen.add(raw);
    const part = requireKind(reader.get(asElementId(raw)), "part");
    const curbMm = command.curbMm === undefined ? part.curbMm : command.curbMm === null ? undefined : round(command.curbMm);
    let offsetMm = part.offsetMm;
    if (host && command.seat !== false) {
      const top = hostTopMm(model, host);
      if (top === null) refuse("element_not_found", `${hostName(model, host)} isn't there to stand on`, [part.id]);
      const level = requireKind(reader.get(part.levelId), "level");
      offsetMm = round(top + (curbMm ?? 0) - level.elevationMm);
    }
    const { host: _oldHost, curbMm: _oldCurb, ...rest } = part;
    const next: PartInstance = { ...rest, offsetMm, ...(host ? { host } : {}), ...(curbMm !== undefined && curbMm > 0 ? { curbMm } : {}) };
    working[part.id] = next;
    touched.add(part.id);
    authored.push({ elementId: part.id, field: "host", value: canonicalJson(next.host ?? null) + canonicalJson(next.curbMm ?? null) });
    if (offsetMm !== part.offsetMm) authored.push({ elementId: part.id, field: "offsetMm", value: offsetMm });
    const dz = round(offsetMm - part.offsetMm);
    if (dz !== 0 && part.links) {
      const before = new Set(touched);
      carryConnectedRuns(runs, part, { x: 0, y: 0, z: dz }, (link, why) => {
        const stuck = why.elementIds.find((id) => working[id]?.kind === "run_segment" || working[id]?.kind === "run_fitting") ?? link.elementId;
        return refuse(why.code, seatRefusal(working, part, dz, stuck, why.message), [part.id, ...why.elementIds]);
      });
      carried.push({ part, dz, ids: new Set([...touched].filter((id) => !before.has(id))) });
    }
  }
  const result = finish(reader, working, touched, authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })));
  if (result.ok) return result;
  // A carried run that followed but no longer checks out (a piece now too short): say which seat did it.
  for (const c of carried) {
    const runId = result.error.elementIds.find((id) => c.ids.has(id));
    if (runId) return { ok: false, error: { ...result.error, message: seatRefusal(working, c.part, c.dz, runId, result.error.message) } };
  }
  return result;
}

/** Why a seat was refused, in terms of the seat: the part, how far it moved, the run that couldn't follow, and what to do instead. */
function seatRefusal(elements: Readonly<Record<string, BimElement>>, part: PartInstance, dz: number, runId: string, why: string): string {
  const name = partLabelOf(elements, part);
  const how = `${dz > 0 ? "up" : "down"} ${Math.round(Math.abs(dz))} mm (${Math.round(Math.abs(dz) / 25.4)}")`;
  return `Seating ${name} moves it ${how}, and its connected run ${runId} can't follow: ${why}. Instead, move ${name} and the run together (then set the host with seat off), disconnect the run, or re-route it`;
}

function setPartClearances(model: ModelState, command: Extract<SpatialCommand, { type: "set_part_clearances" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const el = reader.get(asElementId(command.id));
  const working = draftElements(model.elements);
  if (command.scope === "type") {
    if (command.overrides !== undefined) refuse("invalid_value", "Changes by zone id are for one placed part (scope instance); for the type, send its zones");
    if (command.zones === undefined) refuse("invalid_value", "Send the type's zones ([] removes them all)");
    const type = el.kind === "part" ? requireKind(reader.get(el.typeId), "part_type") : requireKind(el, "part_type");
    const { clearances: _old, ...rest } = type.definition;
    const definition: PartTypeDefinition = command.zones.length > 0 ? { ...rest, clearances: command.zones } : rest;
    const first = partTypeIssues(definition)[0];
    if (first) refuse("invalid_value", `${definition.typeName}: ${first.message}`, [type.id]);
    working[type.id] = { ...type, definition };
    const authored: AuthoredWrite[] = [{ elementId: type.id, field: "clearances", value: canonicalJson(definition.clearances ?? null) }];
    return finish(reader, working, [type.id], authored, () => [{ kind: "field_equals" as const, elementId: type.id, field: "clearances", value: authored[0]?.value ?? "" }]);
  }
  if (command.zones !== undefined) refuse("invalid_value", "Whole zones belong to the part type (scope type); for one part, send overrides by zone id");
  if (!command.overrides || Object.keys(command.overrides).length === 0) refuse("invalid_value", "Nothing to change: give at least one zone override");
  const part = requireKind(el, "part");
  const type = requireKind(reader.get(part.typeId), "part_type");
  const merged: Record<string, ClearanceOverride> = { ...(part.clearances ?? {}) };
  for (const [id, o] of Object.entries(command.overrides)) {
    if (o === null) delete merged[id];
    else merged[id] = o;
  }
  const issue = clearanceOverrideIssues(type.definition.clearances, merged)[0];
  if (issue) refuse("invalid_value", `${partName(part)}: ${issue}`, [part.id]);
  const { clearances: _old, ...rest } = part;
  const next: PartInstance = Object.keys(merged).length > 0 ? { ...rest, clearances: merged } : rest;
  working[part.id] = next;
  const value = canonicalJson(next.clearances ?? null);
  return finish(reader, working, [part.id], [{ elementId: part.id, field: "clearances", value }], () => [{ kind: "field_equals" as const, elementId: part.id, field: "clearances", value }]);
}
