import { z } from "zod";
import { guard, type ExecuteResult, executeSteps, builtinPartType, executePartCommand, type PartCommand, partTypeDefinitionSchema, type PartConnector, type PartTypeDefinition, elementsOfKind, type ModelState, type Room, executeServiceLinkCommand, type ServiceLinkCommand } from "@permitzip/bim-kernel";
import { distributionOf, hotConductors, voltageSystemLabel, type VoltageSystem } from "./systems";

/**
 * A starter service layout from a service size: the utility meter, an
 * optional main disconnect, the main distribution and the panels and
 * transformers the engineer lists, each fed from what the engineer named.
 *
 * Every piece is an ordinary part (a sized copy of a starter type, the way an
 * engineer duplicates a type and sets its rating) and every feeder an ordinary
 * served-from link, placed as one edit: one approval, one undo. The live
 * one-line then draws it from the model like anything else modeled
 * (DIAGRAMS.md). Nothing is chosen from loads or a catalog: the ratings,
 * systems, names and what feeds what are the engineer's (internal design note,
 * "Service layout").
 */

export const SERVICE_SYSTEMS = ["208Y/120", "480Y/277", "120/240"] as const;
export type ServiceSystem = (typeof SERVICE_SYSTEMS)[number];

const SYSTEM_OF: Record<ServiceSystem, VoltageSystem> = {
  "208Y/120": { lineToLine: 208, lineToNeutral: 120, phases: 3, wires: 4 },
  "480Y/277": { lineToLine: 480, lineToNeutral: 277, phases: 3, wires: 4 },
  "120/240": { lineToLine: 240, lineToNeutral: 120, phases: 1, wires: 3 },
};

export function serviceSystemOf(key: ServiceSystem): VoltageSystem {
  return SYSTEM_OF[key];
}

const MAX_ROWS = 40;
const IN = 25.4;
const GAP_MM = 36 * IN;
const NAME = z.string().trim().min(1).max(40);

const rowSchema = z
  .object({
    kind: z.enum(["panel", "transformer"]),
    name: NAME,
    /** What feeds it, by name: the main distribution, a transformer, or another row. */
    fedFrom: NAME,
    /** Panels: bus amps. */
    busA: z.number().int().min(30).max(6000).optional(),
    /** Panels: their system (a transformer's secondary, or the service's). Default: the service's. */
    system: z.enum(SERVICE_SYSTEMS).optional(),
    mains: z.enum(["MLO", "MCB"]).optional(),
    circuits: z.number().int().min(2).max(84).optional(),
    /** Transformers: kVA. */
    kva: z.number().positive().max(5000).optional(),
    /** The breaker feeding it in what feeds it; transformers need one, panels default to their main (else bus). */
    breakerA: z.number().int().min(15).max(6000).optional(),
  })
  .strict();

export const serviceLayoutRequestSchema = z
  .object({
    levelId: z.string().min(1).max(200),
    /** Where the lineup starts, plan mm (left end of the first piece, on its centreline). Wins over `roomId`. */
    origin: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
    /** The room it goes in (the electrical room): the lineup runs along the room's south wall, clear of it. */
    roomId: z.string().min(1).max(200).optional(),
    serviceA: z.number().int().min(30).max(6000),
    system: z.enum(SERVICE_SYSTEMS),
    /** A utility meter (CT cabinet) where the service enters. */
    meter: z.boolean().default(true),
    /** A fused main disconnect ahead of the main distribution, which is then main lugs only. */
    mainDisconnect: z.boolean().default(false),
    distribution: z
      .object({ name: NAME.default("MDP"), kind: z.enum(["switchboard", "panelboard"]).optional(), circuits: z.number().int().min(2).max(84).optional() })
      .strict()
      .default({ name: "MDP" }),
    equipment: z.array(rowSchema).max(MAX_ROWS).default([]),
    /** Plan only: the gear and its feeders exist (one-line, panel schedules) but nothing is drawn yet; place each later from Not placed yet. */
    planOnly: z.boolean().default(false),
  })
  .strict();

export type ServiceLayoutRequest = z.input<typeof serviceLayoutRequestSchema>;
type Request = z.output<typeof serviceLayoutRequestSchema>;
export type ServiceLayoutRow = z.output<typeof rowSchema>;

const idSchema = z.string().min(1).max(200);
const PARAM_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const valueSchema = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const serviceLayoutCommandSchemas = [
  z
    .object({
      type: z.literal("place_service_layout"),
      /** What the edit does, in words, for the approval card and history. */
      label: z.string().trim().min(1).max(160),
      levelId: idSchema,
      /** Plan only: the equipment is planned (not placed), for `levelId`; positions are ignored. */
      planOnly: z.literal(true).optional(),
      /** Sized types the model doesn't have yet, pinned on first use. */
      partTypes: z.array(z.object({ typeId: idSchema, definition: partTypeDefinitionSchema }).strict()).max(MAX_ROWS + 3),
      equipment: z
        .array(
          z
            .object({
              partId: idSchema,
              typeId: idSchema,
              position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
              values: z.record(z.string().regex(PARAM_NAME), valueSchema),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_ROWS + 3),
      feeders: z
        .array(
          z
            .object({
              linkId: idSchema,
              sourceId: idSchema,
              fedId: idSchema,
              ratingA: z.number().int().min(15).max(6000).optional(),
            })
            .strict(),
        )
        .max(MAX_ROWS + 2),
    })
    .strict(),
] as const;

export type ServiceLayoutCommand = z.infer<(typeof serviceLayoutCommandSchemas)[number]>;

// Callers build `place_service_layout` with its fields typed, as a `Command`; the kernel names no pack command itself.
declare module "@permitzip/bim-kernel/commands" {
  interface PackCommandTypes {
    place_service_layout: ServiceLayoutCommand;
  }
}

export function isServiceLayoutCommand(command: { readonly type: string }): command is ServiceLayoutCommand {
  return command.type === "place_service_layout";
}

/** One piece of the preview: what it is and what feeds it, in the engineer's words. */
export interface ServiceLayoutItem {
  readonly partId: string;
  readonly name: string;
  readonly what: string;
  readonly fedFrom: string | null;
  /** The breaker feeding it, when what feeds it has breakers. */
  readonly breakerA: number | null;
}

export interface ServiceLayoutPlan {
  readonly ok: true;
  readonly command: ServiceLayoutCommand;
  readonly items: readonly ServiceLayoutItem[];
  /** Things the engineer should look at; none of them stop the layout. */
  readonly notes: readonly string[];
  /** Where the lineup goes, in words ("in ELEC 104, along its south wall"). */
  readonly where: string;
}

export type ServiceLayoutResult = ServiceLayoutPlan | { readonly ok: false; readonly reason: string };

type Kind = "meter" | "disconnect" | "switchboard" | "panelboard" | "transformer";

interface Piece {
  readonly key: string;
  readonly name: string;
  readonly kind: Kind;
  readonly system: VoltageSystem;
  /** Transformers: what the primary needs. */
  readonly primary: VoltageSystem | null;
  readonly busA: number | null;
  readonly mains: string | null;
  readonly circuits: number | null;
  readonly kva: number | null;
  readonly fedFrom: string | null;
  readonly breakerA: number | null;
}

const BASE: Record<Kind, { three: string; one: string }> = {
  meter: { three: "builtin:ct-cabinet-meter-800-480@1", one: "builtin:ct-cabinet-meter-800-480@1" },
  disconnect: { three: "builtin:disconnect-fused-100-480@1", one: "builtin:disconnect-fused-100-480@1" },
  switchboard: { three: "builtin:switchboard-800-480@1", one: "builtin:panelboard-125-208-1ph@1" },
  panelboard: { three: "builtin:panelboard-225-mcb@1", one: "builtin:panelboard-125-208-1ph@1" },
  transformer: { three: "builtin:transformer-75kva@1", one: "builtin:transformer-75kva@1" },
};

const KIND_WORD: Record<Kind, string> = { meter: "meter and CT cabinet", disconnect: "fused main disconnect", switchboard: "switchboard", panelboard: "panelboard", transformer: "transformer" };

const sysText = (s: VoltageSystem) => (s.phases === 3 ? `${s.lineToLine}Y/${s.lineToNeutral ?? ""}V` : `${s.lineToNeutral ?? ""}/${s.lineToLine}V 1-phase`);
const sysKey = (s: VoltageSystem) => `${s.lineToLine}-${s.phases}`;
const sameSystem = (a: VoltageSystem, b: VoltageSystem) => a.lineToLine === b.lineToLine && a.phases === b.phases && a.lineToNeutral === b.lineToNeutral;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";
const kvaText = (k: number) => String(k).replace(".", "_");

function hash(value: unknown): string {
  let h = 5381;
  for (const ch of JSON.stringify(value)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** The electrical connectors of a type with as many poles as the system has hot conductors. */
function withPoles(connectors: readonly PartConnector[], poles: number): PartConnector[] {
  return connectors.map((c) => (c.domain === "electrical" ? { ...c, poles } : c));
}

/** A sized copy of the starter type for a piece: the engineer's rating and system, everything else as the starter. */
function sizedType(p: Piece): { typeId: string; definition: PartTypeDefinition } | string {
  const baseId = p.system.phases === 3 || p.kind === "transformer" ? BASE[p.kind].three : BASE[p.kind].one;
  const base = builtinPartType(baseId);
  if (!base) return `The starter library has no ${KIND_WORD[p.kind]} to size.`;
  const def = base.definition;
  const poles = hotConductors(p.kind === "transformer" && p.primary ? p.primary : p.system);
  const v = p.system.lineToLine;
  const ph = String(p.system.phases);
  const typeHas = (n: string) => def.typeParams.some((t) => t.name === n);
  const typeValues: Record<string, string | number | boolean> = { ...def.typeValues };
  const set = (n: string, value: string | number) => {
    if (typeHas(n)) typeValues[n] = value;
  };
  let typeName: string;
  let typeId: string;
  switch (p.kind) {
    case "meter":
      set("bus_rating", p.busA ?? 0);
      set("voltage", v);
      set("phases", ph);
      typeName = `${p.busA}A ${sysText(p.system)}`;
      typeId = `svc:meter-${p.busA}-${sysKey(p.system)}`;
      break;
    case "disconnect":
      set("bus_rating", p.busA ?? 0);
      set("fuse_rating", p.busA ?? 0);
      set("voltage", v);
      set("phases", ph);
      typeName = `${p.busA}A ${p.system.phases === 3 ? "3P" : "2P"}, ${p.busA}A fuses, ${sysText(p.system)}`;
      typeId = `svc:disconnect-fused-${p.busA}-${sysKey(p.system)}`;
      break;
    case "transformer":
      set("kva", p.kva ?? 0);
      set("primary_voltage", p.primary?.lineToLine ?? 480);
      set("secondary_voltage", v);
      typeName = `${p.kva} kVA ${p.primary?.lineToLine ?? 480}Δ-${sysText(p.system)}`;
      typeId = `svc:transformer-${kvaText(p.kva ?? 0)}kva-${p.primary?.lineToLine ?? 480}-${v}`;
      break;
    default: {
      set("voltage", v);
      set("phases", ph);
      if (p.circuits !== null) set("circuits", p.circuits);
      set("bus_rating", p.busA ?? 0);
      set("mains", p.mains ?? "MLO");
      const circuits = Number(typeValues.circuits ?? p.circuits ?? 0);
      typeName = `${p.busA}A ${sysText(p.system)} ${circuits} ${p.kind === "switchboard" ? "position" : "circuit"}, ${p.mains}`;
      typeId = `svc:${p.kind}-${p.busA}-${sysKey(p.system)}-${circuits}-${slug(p.mains ?? "mlo")}`;
    }
  }
  return { typeId, definition: { ...def, typeName, typeValues, connectors: withPoles(def.connectors, poles) } };
}

/** Values set on the placed part (instance parameters only). */
function instanceValues(def: PartTypeDefinition, p: Piece): Record<string, string | number | boolean> {
  const has = (n: string) => def.instanceParams.some((x) => x.name === n);
  const out: Record<string, string | number | boolean> = {};
  if (has("panel_name")) out.panel_name = p.name;
  if (has("bus_rating") && p.busA !== null) out.bus_rating = p.busA;
  if (has("mains") && p.mains !== null) out.mains = p.mains;
  return out;
}

const widthOf = (def: PartTypeDefinition) => {
  const w = def.typeValues.width;
  return typeof w === "number" && w > 0 ? w : 36 * IN;
};

const depthOf = (def: PartTypeDefinition) => {
  const d = def.typeValues.depth;
  return typeof d === "number" && d > 0 ? d : 12 * IN;
};

/** Clear of the wall behind the gear and of the room's corner. */
const WALL_CLEAR_MM = 6 * IN;
/** NEC 110.26(A)(1)'s least working-space depth (Condition 1, 0–150 V to ground). */
const WORKING_DEPTH_MM = 36 * IN;

const roomLabel = (r: Room) => [r.number, r.name].filter((s) => s.trim() !== "").join(" ") || r.id;
const ftText = (mm: number) => `${Math.round((mm / 304.8) * 10) / 10} ft`;

/**
 * Rooms the service could go in, electrical rooms first (by name: ELEC,
 * ELECTRICAL, MAIN ELEC, SWBD, SERVICE), then by number. For the Service
 * layout dialog's room picker and the agent's `room` option.
 */
export function serviceLayoutRooms(model: Pick<ModelState, "elements">): ReadonlyArray<{ readonly id: string; readonly label: string; readonly electrical: boolean }> {
  const ELECTRICAL_ROOM = /\belec|\bswbd\b|\bswitchgear\b|\bservice\b|\bmdp\b/i;
  return elementsOfKind(model.elements, "room")
    .filter((r) => r.outline.length >= 3)
    .map((r) => ({ id: r.id, label: roomLabel(r), electrical: ELECTRICAL_ROOM.test(`${r.name} ${r.number}`) }))
    .sort((a, b) => Number(b.electrical) - Number(a.electrical) || a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/** A room by id, number or name (exact, ignoring case), for the agent's `room` option. */
export function findServiceRoom(model: Pick<ModelState, "elements">, key: string): Room | null {
  const k = key.trim().toLowerCase();
  const rooms = elementsOfKind(model.elements, "room");
  return rooms.find((r) => r.id === key) ?? rooms.find((r) => r.number.trim().toLowerCase() === k || r.name.trim().toLowerCase() === k || roomLabel(r).toLowerCase() === k) ?? null;
}

function pieces(req: Request): Piece[] | string {
  const service = SYSTEM_OF[req.system];
  const out: Piece[] = [];
  let feeding: string | null = null;
  if (req.meter) {
    out.push({ key: "meter", name: "METER", kind: "meter", system: service, primary: null, busA: req.serviceA, mains: null, circuits: null, kva: null, fedFrom: null, breakerA: null });
    feeding = "METER";
  }
  if (req.mainDisconnect) {
    out.push({ key: "main-disconnect", name: "MAIN DISC", kind: "disconnect", system: service, primary: null, busA: req.serviceA, mains: null, circuits: null, kva: null, fedFrom: feeding, breakerA: null });
    feeding = "MAIN DISC";
  }
  // Single-phase gear is a panelboard (a load center); above 400 A three-phase the main distribution is a switchboard unless the engineer says otherwise.
  const mdpKind = service.phases === 1 ? "panelboard" : (req.distribution.kind ?? (req.serviceA > 400 ? "switchboard" : "panelboard"));
  out.push({
    key: "distribution",
    name: req.distribution.name,
    kind: mdpKind,
    system: service,
    primary: null,
    busA: req.serviceA,
    mains: req.mainDisconnect ? "MLO" : `${req.serviceA}A MCB`,
    circuits: req.distribution.circuits ?? null,
    kva: null,
    fedFrom: feeding,
    breakerA: null,
  });
  for (const [i, row] of req.equipment.entries()) {
    if (row.kind === "transformer") {
      if (row.kva === undefined) return `${row.name}: give the transformer's kVA.`;
      const secondary = SYSTEM_OF[row.system ?? "208Y/120"];
      if (secondary.phases !== 3) return `${row.name}: transformers here are 3-phase; give a 3-phase secondary.`;
      out.push({ key: `row-${i}`, name: row.name, kind: "transformer", system: secondary, primary: null, busA: null, mains: null, circuits: null, kva: row.kva, fedFrom: row.fedFrom, breakerA: row.breakerA ?? null });
    } else {
      if (row.busA === undefined) return `${row.name}: give the panel's bus rating in amps.`;
      const mains = row.mains === "MCB" ? `${row.busA}A MCB` : "MLO";
      out.push({ key: `row-${i}`, name: row.name, kind: "panelboard", system: SYSTEM_OF[row.system ?? req.system], primary: null, busA: row.busA, mains, circuits: row.circuits ?? null, kva: null, fedFrom: row.fedFrom, breakerA: row.breakerA ?? null });
    }
  }
  return out;
}

/**
 * The layout for a request against this model, or why not in words. The
 * Electrical tab's Service layout dialog and `bim_place_service_layout` both
 * build it here and send `command` unchanged.
 */
export function planServiceLayout(model: Pick<ModelState, "elements">, input: ServiceLayoutRequest): ServiceLayoutResult {
  const parsed = serviceLayoutRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ") };
  const req = parsed.data;
  const level = model.elements[req.levelId];
  if (level?.kind !== "level") return { ok: false, reason: "Choose the level the service equipment goes on." };
  const roomEl = req.roomId !== undefined && req.origin === undefined ? model.elements[req.roomId] : undefined;
  if (req.roomId !== undefined && req.origin === undefined && (roomEl?.kind !== "room" || roomEl.outline.length < 3)) return { ok: false, reason: `There is no room ${req.roomId} with an outline in this model; pick another room or a point in the plan.` };
  const room = roomEl?.kind === "room" && !req.planOnly ? roomEl : null;
  const list = pieces(req);
  if (typeof list === "string") return { ok: false, reason: list };

  const existing = new Set<string>();
  for (const part of elementsOfKind(model.elements, "part")) {
    const info = distributionOf(model.elements, part);
    if (info) existing.add(info.name.trim().toUpperCase());
  }
  const byName = new Map<string, Piece>();
  for (const p of list) {
    const key = p.name.trim().toUpperCase();
    if (byName.has(key)) return { ok: false, reason: `Two pieces are named ${p.name}; give each its own name.` };
    if (existing.has(key)) return { ok: false, reason: `The model already has equipment named ${p.name}; name the new one differently or feed the existing one with Feed panel.` };
    byName.set(key, p);
  }

  // Resolve each row's source and check it can feed it, in the order listed.
  const resolved: Piece[] = [];
  const notes: string[] = [];
  for (const p of list) {
    if (p.fedFrom === null) {
      resolved.push(p);
      continue;
    }
    const src = byName.get(p.fedFrom.trim().toUpperCase());
    if (!src) return { ok: false, reason: `${p.name} is fed from ${p.fedFrom}, which isn't in this layout; pick one of ${[...byName.values()].filter((x) => x !== p).map((x) => x.name).join(", ")}.` };
    if (src === p) return { ok: false, reason: `${p.name} can't feed itself.` };
    const supplies = src.system;
    if (p.kind === "transformer") {
      if (supplies.phases !== 3) return { ok: false, reason: `${p.name} needs a 3-phase primary; ${src.name} is ${voltageSystemLabel(supplies)}.` };
      if ((src.kind === "switchboard" || src.kind === "panelboard") && p.breakerA === null) return { ok: false, reason: `Give ${p.name}'s primary breaker in ${src.name}: a transformer has no main to take it from.` };
      resolved.push({ ...p, primary: supplies });
      continue;
    }
    if (!sameSystem(supplies, p.system)) return { ok: false, reason: `${p.name} is ${voltageSystemLabel(p.system)}; ${src.name} is ${voltageSystemLabel(supplies)}. Add a transformer and feed ${p.name} from it.` };
    if (src.busA !== null && p.busA !== null && p.busA > src.busA) notes.push(`${p.name}'s ${p.busA}A bus is larger than ${src.name}'s ${src.busA}A bus.`);
    resolved.push(p);
  }
  // A loop is impossible to state here only if every source comes first; check by walking.
  for (const p of resolved) {
    const seen = new Set<string>();
    let at: Piece | undefined = p;
    while (at?.fedFrom) {
      if (seen.has(at.name)) return { ok: false, reason: `${p.name} ends up feeding itself through ${[...seen].join(" → ")}.` };
      seen.add(at.name);
      at = byName.get(at.fedFrom.trim().toUpperCase());
    }
  }

  const prefix = `svc-${hash({ level: req.levelId, list: resolved.map((p) => [p.key, p.name]) })}`;
  const partIdOf = new Map(resolved.map((p) => [p.name.trim().toUpperCase(), `${prefix}-${slug(p.name)}`]));
  const partTypes: Array<{ typeId: string; definition: PartTypeDefinition }> = [];
  const equipment: ServiceLayoutCommand["equipment"] = [];
  const items: ServiceLayoutItem[] = [];
  const typed: Array<{ readonly p: Piece; readonly typeId: string; readonly definition: PartTypeDefinition }> = [];
  for (const p of resolved) {
    const sized = sizedType(p);
    if (typeof sized === "string") return { ok: false, reason: sized };
    const existingType = model.elements[sized.typeId];
    if (existingType && existingType.kind !== "part_type") return { ok: false, reason: `${sized.typeId} is already used by something that isn't a part type.` };
    if (!existingType && !partTypes.some((t) => t.typeId === sized.typeId)) partTypes.push(sized);
    typed.push({ p, typeId: sized.typeId, definition: existingType?.kind === "part_type" ? existingType.definition : sized.definition });
  }
  const lengthMm = typed.reduce((sum, t) => sum + widthOf(t.definition), 0) + GAP_MM * Math.max(0, typed.length - 1);
  const deepest = Math.max(0, ...typed.map((t) => depthOf(t.definition)));
  let origin = req.origin ?? { x: 0, y: 0 };
  let where = req.planOnly ? `not placed yet: each waits in Not placed yet until you place it on ${level.name}` : req.origin ? `in a row from the picked point (${ftText(req.origin.x)} east, ${ftText(req.origin.y)} north)` : "in a row from the level origin";
  if (room) {
    const xs = room.outline.map((v) => v.x);
    const ys = room.outline.map((v) => v.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const width = Math.max(...xs) - minX;
    const depth = Math.max(...ys) - minY;
    origin = { x: Math.round(minX + WALL_CLEAR_MM), y: Math.round(minY + WALL_CLEAR_MM + deepest / 2) };
    where = `in ${roomLabel(room)}, along its south wall`;
    if (lengthMm + 2 * WALL_CLEAR_MM > width) notes.push(`The lineup is ${ftText(lengthMm)} long and ${roomLabel(room)} is ${ftText(width)} wide; it runs past the east wall. Pick a bigger room or a point in the plan.`);
    if (depth - WALL_CLEAR_MM - deepest < WORKING_DEPTH_MM) notes.push(`${roomLabel(room)} leaves less than 3 ft of working space in front of the gear (NEC 110.26(A)(1)).`);
  }
  let x = origin.x;
  for (const { p, typeId, definition } of typed) {
    const w = widthOf(definition);
    const partId = partIdOf.get(p.name.trim().toUpperCase()) ?? `${prefix}-${slug(p.name)}`;
    equipment.push({ partId, typeId, position: { x: Math.round(x + w / 2), y: Math.round(origin.y) }, values: instanceValues(definition, p) });
    x += w + GAP_MM;
    const src = p.fedFrom ? byName.get(p.fedFrom.trim().toUpperCase()) : undefined;
    const breakered = src !== undefined && (src.kind === "switchboard" || src.kind === "panelboard");
    const mainA = p.mains && /MCB/.test(p.mains) ? p.busA : null;
    const breakerA = breakered ? (p.breakerA ?? mainA ?? p.busA) : null;
    const rating = p.kind === "transformer" ? `${p.kva} kVA, ${voltageSystemLabel(p.primary ?? p.system)} to ${voltageSystemLabel(p.system)}` : `${p.busA}A ${voltageSystemLabel(p.system)}${p.mains ? `, ${p.mains}` : ""}`;
    items.push({ partId, name: p.name, what: `${rating} ${KIND_WORD[p.kind]}`, fedFrom: src?.name ?? null, breakerA });
  }
  const feeders: ServiceLayoutCommand["feeders"] = [];
  for (const item of items) {
    if (!item.fedFrom) continue;
    const sourceId = partIdOf.get(item.fedFrom.trim().toUpperCase());
    if (!sourceId) continue;
    feeders.push({ linkId: `fdr-${item.partId}`, sourceId, fedId: item.partId, ...(item.breakerA !== null ? { ratingA: item.breakerA } : {}) });
  }
  const panels = resolved.filter((p) => p.kind === "panelboard" && p.key !== "distribution").length;
  const label = `Service layout: ${req.serviceA}A ${voltageSystemLabel(SYSTEM_OF[req.system])}, ${req.distribution.name}${panels > 0 ? ` and ${panels} panel${panels === 1 ? "" : "s"}` : ""}`;
  const command: ServiceLayoutCommand = { type: "place_service_layout", label: (req.planOnly ? `${label} (plan only)` : label).slice(0, 160), levelId: req.levelId, ...(req.planOnly ? { planOnly: true as const } : {}), partTypes, equipment, feeders };
  return { ok: true, command, items, notes, where };
}

type PlacePart = Extract<PartCommand, { type: "place_part" }>;
type PlanPart = Extract<PartCommand, { type: "plan_part" }>;
type CreateLink = Extract<ServiceLinkCommand, { type: "create_service_link" }>;
type Step = PlacePart | PlanPart | CreateLink;

export function executeServiceLayoutCommand(model: ModelState, command: ServiceLayoutCommand): ExecuteResult {
  const defs = new Map(command.partTypes.map((t) => [t.typeId, t.definition]));
  const pinned = new Set<string>();
  const steps: Step[] = command.equipment.map((e) => {
    const needsType = model.elements[e.typeId] === undefined && !pinned.has(e.typeId);
    const definition = needsType ? defs.get(e.typeId) : undefined;
    if (definition) pinned.add(e.typeId);
    const pinnedType = definition ? { partType: definition } : {};
    if (command.planOnly) return { type: "plan_part", partId: e.partId, typeId: e.typeId, ...pinnedType, levelHint: command.levelId, values: e.values };
    return { type: "place_part", partId: e.partId, typeId: e.typeId, ...pinnedType, levelId: command.levelId, position: e.position, values: e.values };
  });
  for (const f of command.feeders) {
    steps.push({ type: "create_service_link", linkId: f.linkId, sourceId: f.sourceId, members: [{ elementId: f.fedId }], ...(f.ratingA !== undefined ? { electrical: { ratingA: f.ratingA } } : {}) });
  }
  return executeSteps<Step>(model, steps, (m, step) => (step.type === "place_part" || step.type === "plan_part" ? guard(() => executePartCommand(m, step, {})) : executeServiceLinkCommand(m, step)), command.label);
}
