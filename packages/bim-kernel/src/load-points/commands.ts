import { z } from "zod";
import { canonicalJson } from "../canonical";
import { catalogElementId, connectionTypeOf } from "../catalog/model";
import type { ServiceCatalogElement } from "../catalog/types";
import { finish, guard, refuse, type AuthoredWrite, type ExecuteResult, type IntentPredicate } from "../command-core";
import { sourceTradeOf } from "../connections/model";
import { starterConnectionType } from "./starter-types";
import { TrackedReader } from "../model";
import { canNameConnectionType, resolveConnectors } from "../parts";
import { GLOBAL_PARTITION } from "../partition";
import { bagFromTotals, bagSummary, QUANTITIES, QUANTITY_KEYS, quantityBagSchema, subtractTotals, addTotals, ZERO_TOTALS, totalsOf, mergeBags, type QuantityBag, type QuantityTotals } from "../quantities";
import { anchorWords, loadAnchorOf, runEndOf, sameAnchor, type LoadRecord } from "../requirements/anchor";
import { LOAD_POLICY_NAME, loadPolicyRecord } from "../requirements/policy";
import type { DensityRate, LoadAnchor, LoadService, LoadSource } from "../requirements/types";
import { BUILTIN_LOAD_SERVICE_IDS } from "../services/builtin";
// Load and system writes are checked against the service registry in every command's finish (registers the edit hook).
import "../services/write-gate";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ElementId, type ModelState } from "../types";
import { loadPointFingerprint } from "./fingerprint";
import { hostPorts, loadPointAt, loadPointId, loadPointLabel, loadPointQuantities, loadPointsOfPart, loadPointTotals } from "./model";
import { loadPointSystemFit } from "./system-fit";
import type { LoadPointElement } from "./types";

/**
 * Load edits: the one path the Properties panel, the "Place load point"
 * action, the load table and the agent tools (`bim_place_load_points`,
 * `bim_edit_load_point`) all use. Every edit undoes as one step.
 *
 * A load is one record through its whole life (requirements/types.ts): a row
 * or an estimate on a space, a concentrated load on a pipe end or a point, a
 * device's load on a part. `move_load` changes where it is and keeps its id,
 * so schedules, circuits and questions pointing at it keep working. Today's
 * `lp:<host>:<port>` ids stay valid forever; `create_load` takes the new ids
 * from the sender, like every other create.
 *
 * The old command names keep `loadPointId`, which takes any load id; the new
 * ones (`create_load`, `move_load`, `split_load`) and `edit_load_point` take
 * `loadId`, with `loadPointId` accepted as its old name for one release.
 */

const id = z.string().trim().min(1).max(200);
const mark = z.string().trim().max(40);
const designator = z.string().trim().max(20);
const port = z.string().trim().min(1).max(40);

const placement = z.object({
  /** The pipe or duct segment, or the tap/tee/wye fitting. */
  hostId: id,
  /** "start" / "end" of a segment, or the fitting's port ("branch"). */
  port,
  /** A connection type in the project catalog, or a starter one ("WC-FT"), which is added with it. "" for a point with only its own values. */
  connectionType: designator.optional(),
  /** Values that differ from the connection type's. */
  values: quantityBagSchema.optional(),
  mark: mark.optional(),
  schematic: z.boolean().optional(),
  note: z.string().trim().max(200).optional(),
});

/** Where a load is (requirements/types.ts `LoadAnchor`). */
export const loadAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("space"), id }).strict(),
  z.object({ kind: z.literal("zone"), id }).strict(),
  z.object({ kind: z.literal("run_end"), hostId: id, port }).strict(),
  z.object({ kind: z.literal("point"), levelId: id, position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict() }).strict(),
  z.object({ kind: z.literal("part"), partId: id, connector: port.optional() }).strict(),
]);
type AnchorInput = z.infer<typeof loadAnchorSchema>;

/** The load service view of the service registry (services/registry.ts), in its original order. */
export const LOAD_SERVICES = BUILTIN_LOAD_SERVICE_IDS satisfies readonly LoadService[];
export const ALLOCATION_POLICIES = ["max", "actual_only", "allocation_only"] as const;

const densityRate = z.object({ key: z.enum(QUANTITY_KEYS), per: z.enum(["area", "occupant"]), value: z.number().finite().min(0).max(1_000_000) }).strict();
const loadSource = z.object({ kind: z.enum(["code", "calc", "engineer", "client", "vendor_doc"]), ref: z.string().trim().min(1).max(200) }).strict();

/** What a load says about itself besides where it is. */
const lifecycle = {
  service: z.enum(LOAD_SERVICES).optional(),
  basis: z.enum(["lump", "density", "count", "calc"]).optional(),
  rates: z.array(densityRate).min(1).max(12).optional(),
  count: z.number().int().min(1).max(100_000).optional(),
  /** The source before anything is drawn: WH-1, the gas meter, panel P1, the grease interceptor. */
  servedBy: id.optional(),
  source: loadSource.optional(),
  future: z.boolean().optional(),
};

const loadSpec = z
  .object({
    /** The new load's id, chosen by the sender (as every create). */
    id,
    /** Absent: a row, not placed anywhere yet. */
    anchor: loadAnchorSchema.optional(),
    connectionType: designator.optional(),
    values: quantityBagSchema.optional(),
    mark: mark.optional(),
    schematic: z.boolean().optional(),
    note: z.string().trim().max(200).optional(),
    ...lifecycle,
  })
  .strict();
type LoadSpec = z.infer<typeof loadSpec>;

export const loadPointCommandSchemas = [
  z.object({ type: z.literal("create_load_point"), points: z.array(placement).min(1).max(500) }),
  z.object({
    type: z.literal("edit_load_point"),
    /** The load (any id, `lp:` ones included), or the attached fixture (every load it stands for: its cold, hot and waste). */
    loadId: id.optional(),
    /** Old name of `loadId`, kept for one release. */
    loadPointId: id.optional(),
    partId: id.optional(),
    connectionType: designator.optional(),
    /** Merged onto the point's own values. */
    values: quantityBagSchema.optional(),
    /** Own values to drop, so the connection type's apply again. */
    reset: z.array(z.enum(QUANTITY_KEYS)).max(QUANTITY_KEYS.length).optional(),
    mark: mark.optional(),
    schematic: z.boolean().optional(),
    note: z.string().trim().max(200).optional(),
    ...lifecycle,
    /** Drop the named source (servedBy) so the load is unassigned again. */
    clearServedBy: z.boolean().optional(),
  }),
  /** `loadPointId` takes any load id (`lp:` or generated). */
  z.object({ type: z.literal("attach_part_to_load_point"), loadPointId: id, partId: id }),
  z.object({ type: z.literal("detach_part_from_load_point"), loadPointId: id }),
  z.object({
    type: z.literal("split_load_point"),
    loadPointId: id,
    /** New points and what each takes from the lump. What's left stays on the lump; a lump left with nothing is removed. */
    into: z.array(placement.extend({ values: quantityBagSchema })).min(1).max(100),
  }),
  z.object({ type: z.literal("delete_load_points"), loadPointIds: z.array(id).min(1).max(500) }),
  /** Loads with any anchor, before anything is drawn: "35 fixtures", "kitchen ≈ 50 kW", "lighting 1.1 W/sf over Dining". */
  z.object({ type: z.literal("create_load"), loads: z.array(loadSpec).min(1).max(500) }),
  /** Move a load to another anchor and keep its id: estimate → concentrated (a point, a pipe end) → device (a part). */
  z.object({ type: z.literal("move_load"), loadId: id.optional(), loadPointId: id.optional(), to: loadAnchorSchema }),
  /** Break a lump into several loads, each anywhere. Totals are unchanged. */
  z.object({
    type: z.literal("split_load"),
    loadId: id.optional(),
    loadPointId: id.optional(),
    into: z.array(loadSpec.extend({ values: quantityBagSchema })).min(1).max(100),
  }),
  /** How estimates count once real loads exist inside them (model setting; absent: the firm default, max). */
  z.object({ type: z.literal("set_load_allocation_policy"), policy: z.enum(ALLOCATION_POLICIES) }),
] as const;

export const loadPointCommandSchema = z.discriminatedUnion("type", [...loadPointCommandSchemas]);
export type LoadPointCommand = z.infer<typeof loadPointCommandSchema>;
type Placement = z.infer<typeof placement>;

const LOAD_POINT_COMMANDS: ReadonlySet<string> = new Set(loadPointCommandSchemas.map((s) => s.shape.type.value));

export function isLoadPointCommand(command: { readonly type: string }): command is LoadPointCommand {
  return LOAD_POINT_COMMANDS.has(command.type);
}

export { loadPointFingerprint };

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

function done(e: Edit, intentIds: readonly ElementId[]): ExecuteResult {
  const intents = (m: ModelState): IntentPredicate[] =>
    intentIds.flatMap((lpId) => {
      const lp = m.elements[lpId];
      return lp?.kind === "load_point" ? [{ kind: "field_equals" as const, elementId: lp.id, field: "load_point", value: loadPointFingerprint(lp) }] : [];
    });
  return finish(e.reader, e.working, e.touched, e.authored, intents, { removedIds: e.removed, summary: e.summary });
}

function put(e: Edit, lp: LoadPointElement): void {
  e.working[lp.id] = lp;
  e.touched.push(lp.id);
  e.authored.push({ elementId: lp.id, field: "load_point", value: loadPointFingerprint(lp) });
}

/** `loadId`, else the old `loadPointId`. */
function loadIdOf(command: { readonly loadId?: string; readonly loadPointId?: string }): string {
  if (command.loadId !== undefined && command.loadPointId !== undefined && command.loadId !== command.loadPointId) refuse("invalid_value", "Say which load once: loadId (loadPointId is its old name)");
  const v = command.loadId ?? command.loadPointId;
  if (v === undefined) refuse("invalid_value", "Say which load (loadId)");
  return v;
}

function requireLoadPoint(e: Edit, lpId: string): LoadPointElement {
  const el = e.working[lpId] ?? e.reader.find(asElementId(lpId));
  if (el?.kind !== "load_point") refuse("element_not_found", `There is no load ${lpId}`, [asElementId(lpId)]);
  e.reader.find(asElementId(lpId));
  return el;
}

function nameOf(e: Edit, elId: ElementId): string {
  const el = e.working[elId];
  if (el?.kind === "part") return el.mark || el.id;
  if (el?.kind === "space") return el.number ? `${el.number} ${el.name}`.trim() : el.name || el.id;
  if (el?.kind === "zone") return el.name || el.id;
  return elId;
}

/** The connection type a point names, adding a starter one (with the point) when the project doesn't have it yet. */
function resolveConnectionType(e: Edit, name: string | undefined): string {
  const d = name?.trim() ?? "";
  if (d === "") return "";
  const existing = connectionTypeOf(e.working, d);
  if (existing) {
    e.reader.find(catalogElementId("connection_type", d));
    return existing.designator;
  }
  const starter = starterConnectionType(d);
  if (!starter) refuse("element_not_found", `There is no connection type ${d}. Save it first (Connection types), or pick a starter one such as WC-FT, LAV or FD`, [catalogElementId("connection_type", d)]);
  const ctId = catalogElementId("connection_type", starter.designator);
  const record: ServiceCatalogElement = { id: ctId, version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, kind: "service_catalog", trade: starter.trade ?? "plumbing", entry: starter };
  e.working[ctId] = record;
  e.touched.push(ctId);
  e.authored.push({ elementId: ctId, field: "catalog", value: canonicalJson(starter) });
  e.summary.push(`Added connection type ${starter.designator} (${starter.description}) from the starter list`);
  return starter.designator;
}

/**
 * The load on a run end as this edit sees it: the edit's own writes first, then
 * the model's load index for the rest. Never the index of `e.working` (it is
 * still being written).
 */
function loadAtEnd(e: Edit, hostId: string, portId: string): LoadPointElement | null {
  for (const tid of e.touched) {
    const el = e.working[tid];
    const at = el?.kind === "load_point" ? runEndOf(el) : null;
    if (el?.kind === "load_point" && at && at.elementId === hostId && at.port === portId) return el;
  }
  const base = loadPointAt(e.reader.model.elements, hostId, portId);
  if (!base) return null;
  e.reader.find(base.id);
  const now = e.working[base.id];
  const at = now?.kind === "load_point" ? runEndOf(now) : null;
  return now?.kind === "load_point" && at && at.elementId === hostId && at.port === portId ? now : null;
}

/** An open run end a load can go on, refusing in plain words otherwise (the one-per-open-end rule lives here). */
function openEnd(e: Edit, p: { readonly hostId: string; readonly port: string }, movingId?: string): BimElement {
  const host = e.reader.find(asElementId(p.hostId));
  if (host?.kind !== "run_segment" && host?.kind !== "run_fitting") refuse(host ? "wrong_kind" : "element_not_found", host ? `${p.hostId} is not a pipe, duct or tap; a load point goes on a run's open end or a tap` : `There is no pipe or duct ${p.hostId}`, [asElementId(p.hostId)]);
  const ports = hostPorts(host);
  if (!ports.includes(p.port)) refuse("invalid_value", `${p.hostId} has no end or port "${p.port}"; it has ${ports.join(", ")}`, [host.id]);
  const linked = host.kind === "run_segment" ? host.links[p.port as "start" | "end"] : host.ports.find((x) => x.id === p.port)?.link;
  if (linked) refuse("in_use", `That ${host.kind === "run_segment" ? "end" : "port"} already connects to ${linked.elementId}; a load point goes on an open end`, [host.id, linked.elementId]);
  const there = loadAtEnd(e, host.id, p.port);
  if (there && there.id !== movingId) refuse("already_exists", `That end already has a load point (${there.mark || there.connectionType || there.id}); edit it instead`, [there.id]);
  return host;
}

function newPoint(e: Edit, p: Placement, values: QuantityBag | undefined): LoadPointElement {
  const host = openEnd(e, p);
  const lpId = loadPointId(host.id, p.port);
  // The id this end would have had before Oct 2026 may still name a load that moved elsewhere: give the new one the next free id.
  const freeId = e.working[lpId] ? nextFreeId(e, lpId) : lpId;
  const connectionType = resolveConnectionType(e, p.connectionType);
  return {
    id: freeId,
    kind: "load_point",
    version: 0,
    authoredRev: {},
    partition: host.partition ?? GLOBAL_PARTITION,
    ...(host.groupId ? { groupId: host.groupId } : {}),
    host: { elementId: host.id, port: p.port },
    connectionType,
    values: values ?? {},
    ...(p.mark ? { mark: p.mark } : {}),
    ...(p.schematic ? { schematic: true } : {}),
    ...(p.note ? { note: p.note } : {}),
  };
}

function nextFreeId(e: Edit, base: ElementId): ElementId {
  for (let n = 2; n < 10_000; n++) {
    const candidate = asElementId(`${base}#${n}`);
    if (!e.working[candidate]) return candidate;
  }
  return refuse("already_exists", `No free id near ${base}`, [base]);
}

function toAnchor(input: AnchorInput | undefined): LoadAnchor {
  if (!input) return { kind: "none" };
  switch (input.kind) {
    case "none":
      return { kind: "none" };
    case "space":
    case "zone":
      return { kind: input.kind, id: asElementId(input.id) };
    case "run_end":
      return { kind: "run_end", hostId: asElementId(input.hostId), port: input.port };
    case "point":
      return { kind: "point", levelId: asElementId(input.levelId), position: { x: input.position.x, y: input.position.y } };
    case "part":
      return { kind: "part", partId: asElementId(input.partId), ...(input.connector ? { connector: input.connector } : {}) };
  }
}

/** Checks an anchor against the model; returns the partition and group a load there takes. */
function checkAnchor(e: Edit, anchor: LoadAnchor, movingId?: string): { readonly partition: BimElement["partition"]; readonly groupId?: string } {
  switch (anchor.kind) {
    case "none":
      return { partition: GLOBAL_PARTITION };
    case "space":
    case "zone": {
      const el = e.reader.find(anchor.id);
      if (el?.kind !== anchor.kind) refuse(el ? "wrong_kind" : "element_not_found", el ? `${anchor.id} is not a ${anchor.kind}` : `There is no ${anchor.kind} ${anchor.id}; draw or type it first`, [anchor.id]);
      return { partition: el.partition ?? GLOBAL_PARTITION };
    }
    case "run_end": {
      const host = openEnd(e, { hostId: anchor.hostId, port: anchor.port }, movingId);
      return { partition: host.partition ?? GLOBAL_PARTITION, ...(host.groupId ? { groupId: host.groupId } : {}) };
    }
    case "point": {
      const level = e.reader.find(anchor.levelId);
      if (level?.kind !== "level") refuse(level ? "wrong_kind" : "element_not_found", level ? `${anchor.levelId} is not a level` : `There is no level ${anchor.levelId}`, [anchor.levelId]);
      return { partition: GLOBAL_PARTITION };
    }
    case "part": {
      const part = e.reader.find(anchor.partId);
      if (part?.kind !== "part") refuse(part ? "wrong_kind" : "element_not_found", part ? `${anchor.partId} is not a fixture, device or piece of equipment` : `There is no part ${anchor.partId}`, [anchor.partId]);
      if (anchor.connector) {
        const type = e.reader.find(part.typeId);
        const connectors = type?.kind === "part_type" ? resolveConnectors(type.definition, part.values).map((c) => c.id) : [];
        if (!connectors.includes(anchor.connector)) refuse("invalid_value", `${part.mark || part.id} has no connector "${anchor.connector}"; it has ${connectors.join(", ") || "none"}`, [part.id]);
      }
      return { partition: part.partition ?? GLOBAL_PARTITION, ...(part.groupId ? { groupId: part.groupId } : {}) };
    }
  }
}

/** A source must be a part that serves something in some trade (a panel, a water heater, a meter, an interceptor). */
function checkSource(e: Edit, sourceId: string): ElementId {
  const sid = asElementId(sourceId);
  const part = e.reader.find(sid);
  if (part?.kind !== "part") refuse(part ? "wrong_kind" : "element_not_found", part ? `${sourceId} can't serve loads: it is not a piece of equipment` : `There is no source ${sourceId}`, [sid]);
  if (!sourceTradeOf(e.working, part)) refuse("wrong_kind", `${part.mark || part.id} doesn't serve anything: a load's source is a panel, a water heater, a meter, a grease interceptor or other equipment that supplies its service`, [sid]);
  return sid;
}

/** The anchor written as the record stores it: a run end as `host` (exactly as before anchors existed), anything else as `anchor`. */
function placeAt(lp: LoadRecord, anchor: LoadAnchor): LoadRecord {
  const { host: _host, anchor: _anchor, ...rest } = lp;
  if (anchor.kind === "run_end") return { ...rest, host: { elementId: anchor.hostId, port: anchor.port } };
  return { ...rest, anchor };
}

function checkBasis(spec: { readonly basis?: LoadSpec["basis"]; readonly rates?: readonly unknown[]; readonly count?: number }, anchor: LoadAnchor, label: string): void {
  if (spec.basis === "density") {
    if (!spec.rates || spec.rates.length === 0) refuse("invalid_value", `${label}: a density load needs its rates (1.1 VA per square foot is { key: "va", per: "area", value: 11.84 } per square metre)`);
    if (anchor.kind !== "space" && anchor.kind !== "zone") refuse("invalid_value", `${label}: a density load multiplies its rates by a space's or zone's area or occupants; anchor it to a space or zone`);
  } else if (spec.rates) refuse("invalid_value", `${label}: rates are for basis "density"`);
  if (spec.count !== undefined && spec.basis !== "count") refuse("invalid_value", `${label}: count is for basis "count" (n × the connection type's values)`);
}

function lifecycleFields(e: Edit, spec: Pick<LoadSpec, "service" | "basis" | "rates" | "count" | "servedBy" | "source" | "future">): Partial<LoadRecord> {
  const rates: readonly DensityRate[] | undefined = spec.rates?.map((r) => ({ key: r.key, per: r.per, value: r.value }));
  const source: LoadSource | undefined = spec.source ? { kind: spec.source.kind, ref: spec.source.ref } : undefined;
  return {
    ...(spec.service ? { service: spec.service } : {}),
    ...(spec.basis && spec.basis !== "lump" ? { basis: spec.basis } : {}),
    ...(rates ? { rates } : {}),
    ...(spec.count !== undefined ? { count: spec.count } : {}),
    ...(spec.servedBy ? { servedBy: checkSource(e, spec.servedBy) } : {}),
    ...(source ? { source } : {}),
    ...(spec.future ? { future: true } : {}),
  };
}

function newLoad(e: Edit, spec: LoadSpec, values: QuantityBag | undefined): LoadRecord {
  const lid = asElementId(spec.id);
  if (e.working[lid] || e.reader.find(lid)) refuse("already_exists", `${spec.id} already exists; choose a new id for the load`, [lid]);
  const anchor = toAnchor(spec.anchor);
  const label = spec.mark || spec.connectionType || spec.id;
  checkBasis(spec, anchor, label);
  const where = checkAnchor(e, anchor);
  const connectionType = resolveConnectionType(e, spec.connectionType);
  const base: LoadRecord = {
    id: lid,
    kind: "load_point",
    version: 0,
    authoredRev: {},
    partition: where.partition ?? GLOBAL_PARTITION,
    ...(where.groupId ? { groupId: where.groupId } : {}),
    connectionType,
    values: values ?? {},
    ...(spec.mark ? { mark: spec.mark } : {}),
    ...(spec.schematic ? { schematic: true } : {}),
    ...(spec.note ? { note: spec.note } : {}),
    ...lifecycleFields(e, spec),
  };
  return placeAt(base, anchor);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Refuses, naming every point, when a type has no connection of its pipe's system (a floor drain on cold water). */
function refuseMisfits(e: Edit, ids: readonly ElementId[]): void {
  const misfits = ids.flatMap((lid) => {
    const lp = e.working[lid];
    const why = lp?.kind === "load_point" ? loadPointSystemFit(e.working, lp).refusal : null;
    return why ? [{ id: lid, why }] : [];
  });
  if (misfits.length === 0) return;
  const hosts = misfits.flatMap((m) => {
    const lp = e.working[m.id];
    const at = lp?.kind === "load_point" ? runEndOf(lp) : null;
    return at ? [at.elementId] : [];
  });
  refuse("profile_incompatible", `${misfits.length === 1 ? "1 point doesn't" : `${misfits.length} points don't`} fit their pipe's system: ${misfits.map((m) => m.why).join("; ")}. Put each on a pipe of a system its type connects to, or pick another type`, hosts.map(asElementId));
}

function create(model: ModelState, command: Extract<LoadPointCommand, { type: "create_load_point" }>): ExecuteResult {
  const e = begin(model);
  const made: ElementId[] = [];
  for (const p of command.points) {
    const lp = newPoint(e, p, p.values);
    put(e, lp);
    made.push(lp.id);
  }
  refuseMisfits(e, made);
  const names = [...new Set(command.points.map((p) => p.connectionType?.trim()).filter((d): d is string => !!d))];
  e.summary.unshift(made.length === 1 ? `Placed ${loadPointLabel(e.working, written(e, made[0]))}` : `Placed ${plural(made.length, "load point")}${names.length > 0 ? ` (${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more types` : ""})` : ""}`);
  return done(e, made);
}

function createLoads(model: ModelState, command: Extract<LoadPointCommand, { type: "create_load" }>): ExecuteResult {
  const e = begin(model);
  const made: ElementId[] = [];
  const seen = new Set<string>();
  for (const spec of command.loads) {
    if (seen.has(spec.id)) refuse("invalid_value", `${spec.id} is given twice; one id per load`);
    seen.add(spec.id);
    const lp = newLoad(e, spec, spec.values);
    put(e, lp);
    made.push(lp.id);
  }
  refuseMisfits(e, made);
  const first = written(e, made[0]);
  const placed = made.filter((m) => {
    const el = e.working[m];
    return el?.kind === "load_point" && loadAnchorOf(el).kind !== "none";
  }).length;
  e.summary.unshift(
    made.length === 1
      ? `Added ${loadPointLabel(e.working, first).replace(/^Load point/, "load")} ${anchorWords(loadAnchorOf(first), (x) => nameOf(e, x))}: ${bagSummary(loadPointQuantities(e.working, first))}`
      : `Added ${plural(made.length, "load")}${placed < made.length ? ` (${made.length - placed} not placed anywhere yet)` : ""}`,
  );
  return done(e, made);
}

function dropKeys(bag: QuantityBag, keys: readonly string[]): QuantityBag {
  const out: Record<string, unknown> = { ...bag };
  for (const k of keys) delete out[k];
  return out as QuantityBag;
}

function edit(model: ModelState, command: Extract<LoadPointCommand, { type: "edit_load_point" }>): ExecuteResult {
  const e = begin(model);
  const named = command.loadId ?? command.loadPointId;
  if ((named === undefined) === (command.partId === undefined)) refuse("invalid_value", "Say which load (loadId) or which attached fixture (partId), not both");
  let targets: LoadPointElement[];
  if (command.partId !== undefined) {
    const part = e.reader.find(asElementId(command.partId));
    if (part?.kind !== "part") refuse("element_not_found", `There is no fixture ${command.partId}`, [asElementId(command.partId)]);
    targets = [...loadPointsOfPart(model.elements, part.id)];
    if (targets.length === 0) refuse("invalid_value", `${part.mark || part.id} isn't attached to a load point; attach it first, or edit its part values`, [part.id]);
    for (const t of targets) e.reader.find(t.id);
  } else targets = [requireLoadPoint(e, loadIdOf(command))];
  const connectionType = command.connectionType !== undefined ? resolveConnectionType(e, command.connectionType) : undefined;
  if (command.servedBy && command.clearServedBy) refuse("invalid_value", "Name a source (servedBy) or clear it (clearServedBy), not both");
  const life = lifecycleFields(e, command);
  const changed: ElementId[] = [];
  for (const lp of targets) {
    let values = command.reset ? dropKeys(lp.values, command.reset) : lp.values;
    if (command.values) values = mergeBags(values, command.values);
    const basis = command.basis ?? lp.basis;
    if ((command.basis !== undefined || command.rates !== undefined || command.count !== undefined) && command.basis !== "lump") checkBasis({ basis, rates: command.rates ?? lp.rates, count: command.count ?? lp.count }, loadAnchorOf(lp), lp.mark || lp.connectionType || lp.id);
    const merged: LoadRecord = {
      ...lp,
      ...(connectionType !== undefined ? { connectionType } : {}),
      values,
      ...(command.mark !== undefined ? { mark: command.mark } : {}),
      ...(command.schematic !== undefined ? { schematic: command.schematic } : {}),
      ...(command.note !== undefined ? { note: command.note } : {}),
      ...life,
    };
    const { servedBy: _cleared, ...unserved } = merged;
    const lumped = command.basis === "lump" ? asLump(command.clearServedBy ? unserved : merged) : command.clearServedBy ? unserved : merged;
    const next = lumped;
    if (loadPointFingerprint(next) === loadPointFingerprint(lp)) continue;
    put(e, next);
    changed.push(lp.id);
    // An attached fixture names the same connection type: one record, two views.
    if (connectionType !== undefined && next.attachedPartId) {
      const part = e.working[next.attachedPartId];
      if (part?.kind === "part" && part.values.connection_type !== connectionType) {
        e.working[part.id] = { ...part, values: { ...part.values, connection_type: connectionType } };
        e.touched.push(part.id);
        e.authored.push({ elementId: part.id, field: "values.connection_type", value: connectionType });
      }
    }
  }
  if (changed.length === 0) refuse("invalid_value", "Nothing to change: the load point already has those values", targets.map((t) => t.id));
  const first = written(e, changed[0]);
  e.summary.unshift(`${command.partId ? `Changed ${first.mark || first.connectionType || "the fixture"} (fixture and its ${plural(changed.length, "load point")})` : `Changed ${loadPointLabel(e.working, first)}`}: ${bagSummary(loadPointQuantities(e.working, first))}`);
  return done(e, changed);
}

/** A lump again: no basis, rates or count. */
function asLump(lp: LoadRecord): LoadRecord {
  const { basis: _basis, rates: _rates, count: _count, ...rest } = lp;
  return rest;
}

/** A load this edit wrote. */
function written(e: Edit, lid: ElementId | undefined): LoadPointElement {
  const el = lid ? e.working[lid] : undefined;
  if (el?.kind !== "load_point") refuse("element_not_found", `The edit lost track of load ${lid ?? ""}`);
  return el;
}

function attach(model: ModelState, command: Extract<LoadPointCommand, { type: "attach_part_to_load_point" }>): ExecuteResult {
  const e = begin(model);
  const lp = requireLoadPoint(e, command.loadPointId);
  const part = e.reader.find(asElementId(command.partId));
  if (part?.kind !== "part") refuse("element_not_found", `There is no fixture ${command.partId}`, [asElementId(command.partId)]);
  if (lp.attachedPartId === part.id) refuse("invalid_value", `${part.mark || part.id} is already attached to this load point`, [lp.id, part.id]);
  if (lp.attachedPartId) refuse("in_use", `This load point already stands for ${lp.attachedPartId}; detach it first`, [lp.id, lp.attachedPartId]);
  const type = e.reader.find(part.typeId);
  if (type?.kind !== "part_type") refuse("element_not_found", `${part.mark || part.id} has no part type`, [part.id]);
  if (lp.connectionType && !canNameConnectionType(type.definition)) refuse("wrong_kind", `${type.definition.familyName} parts can't take a connection type; attach a fixture or piece of equipment`, [part.id]);
  const next: LoadPointElement = { ...lp, attachedPartId: part.id, ...(lp.mark || !part.mark ? {} : { mark: part.mark }) };
  put(e, next);
  if (lp.connectionType && part.values.connection_type !== lp.connectionType) {
    e.working[part.id] = { ...part, values: { ...part.values, connection_type: lp.connectionType } };
    e.touched.push(part.id);
    e.authored.push({ elementId: part.id, field: "values.connection_type", value: lp.connectionType });
  }
  e.summary.push(`Attached ${part.mark || type.definition.familyName} to ${loadPointLabel(e.working, next)}; it takes the point's connection type and loads (totals unchanged)`);
  return done(e, [lp.id]);
}

function detach(model: ModelState, command: Extract<LoadPointCommand, { type: "detach_part_from_load_point" }>): ExecuteResult {
  const e = begin(model);
  const lp = requireLoadPoint(e, command.loadPointId);
  if (!lp.attachedPartId) refuse("invalid_value", `${loadPointLabel(model.elements, lp)} has no fixture attached`, [lp.id]);
  const { attachedPartId: partId, ...rest } = lp;
  const next: LoadPointElement = rest;
  put(e, next);
  e.summary.push(`Detached ${partId} from ${loadPointLabel(e.working, next)}; the point keeps its loads, the fixture keeps its connection type`);
  return done(e, [lp.id]);
}

function move(model: ModelState, command: Extract<LoadPointCommand, { type: "move_load" }>): ExecuteResult {
  const e = begin(model);
  const lp = requireLoadPoint(e, loadIdOf(command));
  const to = toAnchor(command.to);
  const from = loadAnchorOf(lp);
  if (sameAnchor(from, to)) refuse("invalid_value", `${loadPointLabel(model.elements, lp)} is already there`, [lp.id]);
  if (lp.basis === "density" && to.kind !== "space" && to.kind !== "zone") refuse("invalid_value", `${loadPointLabel(model.elements, lp)} is a density estimate (rates × area); give it a value (basis lump) before moving it off its ${from.kind}, or break it up with split_load`, [lp.id]);
  const where = checkAnchor(e, to, lp.id);
  // A device load is the part's: moving it onto a part drops an earlier attachment to a different part.
  const kept = to.kind === "part" && lp.attachedPartId && lp.attachedPartId !== to.partId ? withoutAttachment(lp) : lp;
  // It takes the partition and group of where it now is, as a new load there would.
  const { groupId: _group, ...ungrouped } = kept;
  const next = placeAt({ ...ungrouped, partition: where.partition ?? GLOBAL_PARTITION, ...(where.groupId ? { groupId: where.groupId } : {}) }, to);
  put(e, next);
  refuseMisfits(e, [next.id]);
  const name = (x: ElementId) => nameOf(e, x);
  e.summary.push(`Moved ${loadPointLabel(e.working, next).replace(/^Load point/, "load")} from ${anchorWords(from, name).replace(/^on the /, "the ")} to ${anchorWords(to, name).replace(/^on the /, "the ")}; same load, same id`);
  return done(e, [next.id]);
}

function withoutAttachment(lp: LoadPointElement): LoadPointElement {
  const { attachedPartId: _part, ...rest } = lp;
  return rest;
}

function summedOnly(t: QuantityTotals): QuantityTotals {
  const out = { ...ZERO_TOTALS } as Record<keyof QuantityTotals, number>;
  for (const k of QUANTITY_KEYS) if (QUANTITIES[k].add === "sum") out[k] = t[k];
  return out;
}

/** Takes `made` out of `lump`: what's left stays on it, a lump left with nothing is removed. Totals are unchanged. */
function takeFromLump(e: Edit, model: ModelState, lump: LoadPointElement, made: readonly ElementId[], noun: string): boolean {
  const before = summedOnly(loadPointTotals(e.working, lump));
  let taken: QuantityTotals = ZERO_TOTALS;
  for (const m of made) taken = addTotals(taken, summedOnly(loadPointTotals(e.working, written(e, m))));
  const left = subtractTotals(before, taken);
  const over = QUANTITY_KEYS.filter((k) => QUANTITIES[k].add === "sum" && left[k] < -1e-9);
  if (over.length > 0) refuse("invalid_value", `The new points take more than the lump has: ${over.map((k) => `${QUANTITIES[k].label.toLowerCase()} ${taken[k]} of ${before[k]}`).join(", ")}`, [lump.id, ...made]);
  const empty = QUANTITY_KEYS.every((k) => QUANTITIES[k].add !== "sum" || Math.abs(left[k]) < 1e-9);
  if (empty) {
    delete e.working[lump.id];
    e.removed.push(lump.id);
  } else {
    // Own values for every summed quantity: what's left, so the lump's connection type can't add it back.
    const own: Record<string, unknown> = { ...lump.values };
    const ct = totalsOf(loadPointQuantities(e.working, { ...lump, values: {} }));
    for (const k of QUANTITY_KEYS) if (QUANTITIES[k].add === "sum" && (before[k] !== 0 || ct[k] !== 0)) own[k] = Math.max(0, Math.round(left[k] * 1e6) / 1e6);
    put(e, { ...lump, values: own as QuantityBag });
  }
  const kept = bagSummary(bagFromTotals(left));
  e.summary.push(`Broke ${loadPointLabel(model.elements, lump)} out onto ${plural(made.length, `new ${noun}`)}; totals unchanged${empty ? " (the lump is used up and removed)" : ` (the lump keeps ${kept})`}`);
  return empty;
}

function split(model: ModelState, command: Extract<LoadPointCommand, { type: "split_load_point" }>): ExecuteResult {
  const e = begin(model);
  const lump = requireLoadPoint(e, command.loadPointId);
  if (lump.basis === "density" || lump.basis === "count") refuse("invalid_value", `${loadPointLabel(model.elements, lump)} is a ${lump.basis} load; split_load breaks up lumps (give it a value first)`, [lump.id]);
  const made: ElementId[] = [];
  for (const p of command.into) {
    const lp = newPoint(e, p, p.values);
    put(e, lp);
    made.push(lp.id);
  }
  refuseMisfits(e, made);
  const empty = takeFromLump(e, model, lump, made, "load point");
  return done(e, empty ? made : [lump.id, ...made]);
}

function splitLoad(model: ModelState, command: Extract<LoadPointCommand, { type: "split_load" }>): ExecuteResult {
  const e = begin(model);
  const lump = requireLoadPoint(e, loadIdOf(command));
  if (lump.basis === "density" || lump.basis === "count") refuse("invalid_value", `${loadPointLabel(model.elements, lump)} is a ${lump.basis} load; split_load breaks up lumps (give it a value first)`, [lump.id]);
  const made: ElementId[] = [];
  for (const spec of command.into) {
    if (spec.basis && spec.basis !== "lump") refuse("invalid_value", `${spec.id}: a piece of a lump is a lump (its own values)`);
    // A piece keeps the lump's source and service unless it says otherwise.
    const piece = newLoad(e, { ...spec, ...(spec.servedBy || !lump.servedBy ? {} : { servedBy: lump.servedBy }), ...(spec.service || !lump.service ? {} : { service: lump.service }) }, spec.values);
    put(e, piece);
    made.push(piece.id);
  }
  refuseMisfits(e, made);
  const empty = takeFromLump(e, model, lump, made, "load");
  return done(e, empty ? made : [lump.id, ...made]);
}

function remove(model: ModelState, command: Extract<LoadPointCommand, { type: "delete_load_points" }>): ExecuteResult {
  const e = begin(model);
  const labels: string[] = [];
  for (const lpId of command.loadPointIds) {
    const lp = requireLoadPoint(e, lpId);
    labels.push(lp.mark || lp.connectionType || lp.id);
    delete e.working[lp.id];
    e.removed.push(lp.id);
  }
  e.summary.push(`Deleted ${labels.length === 1 ? `load point ${labels[0]}` : `${labels.length} load points`}; attached fixtures stay, with their connection types`);
  return done(e, []);
}

function setPolicy(model: ModelState, command: Extract<LoadPointCommand, { type: "set_load_allocation_policy" }>): ExecuteResult {
  const e = begin(model);
  const record = loadPolicyRecord(e.reader, command.policy);
  if (!record) refuse("invalid_value", `Estimates already count by "${command.policy}"`);
  e.working[record.id] = record;
  e.touched.push(record.id);
  e.authored.push({ elementId: record.id, field: "catalog", value: canonicalJson(record.entry) });
  const words = { max: "an estimate counts until the real loads inside it add up to more", actual_only: "only real loads count once any exist inside an estimate", allocation_only: "only estimates count (schematic studies)" } as const;
  e.summary.push(`Load allocation: ${words[command.policy]} (${LOAD_POLICY_NAME})`);
  return done(e, []);
}

export function executeLoadPointCommand(model: ModelState, command: LoadPointCommand): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "create_load_point":
        return create(model, command);
      case "edit_load_point":
        return edit(model, command);
      case "attach_part_to_load_point":
        return attach(model, command);
      case "detach_part_from_load_point":
        return detach(model, command);
      case "split_load_point":
        return split(model, command);
      case "delete_load_points":
        return remove(model, command);
      case "create_load":
        return createLoads(model, command);
      case "move_load":
        return move(model, command);
      case "split_load":
        return splitLoad(model, command);
      case "set_load_allocation_policy":
        return setPolicy(model, command);
    }
  });
}

/** Ids a command will create or touch, for tools that report them (one place, so aliases and generated ids agree). */
export function loadCommandTargets(command: LoadPointCommand): readonly string[] {
  switch (command.type) {
    case "create_load_point":
      return command.points.map((p) => loadPointId(p.hostId, p.port));
    case "split_load_point":
      return [command.loadPointId, ...command.into.map((p) => loadPointId(p.hostId, p.port))];
    case "create_load":
      return command.loads.map((l) => l.id);
    case "split_load":
      return [command.loadId ?? command.loadPointId ?? "", ...command.into.map((l) => l.id)].filter((x) => x !== "");
    case "edit_load_point":
    case "move_load":
      return [command.loadId ?? command.loadPointId ?? ""].filter((x) => x !== "");
    case "attach_part_to_load_point":
    case "detach_part_from_load_point":
      return [command.loadPointId];
    case "delete_load_points":
      return command.loadPointIds;
    case "set_load_allocation_policy":
      return [];
  }
}

