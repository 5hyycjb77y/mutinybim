import { z } from "zod";
import { isRegistryIdShape } from "../ids";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import type { PackSet } from "../packs/set";
import { dimSchema, type Dim } from "../part-dim";

/**
 * Clearance volumes: the space a part needs kept free around it (service
 * access, distance to combustibles, economizer access, NEC 110.26 working
 * space, any other keep-out). They belong to the part type, move and turn
 * with each placed part, can be changed or switched off per placed part, draw
 * dashed, and are never solid: picking, footprints, clash bodies, quantities
 * and 3D solids ignore them. The coordination lint reports anything inside one.
 *
 * Every zone sits against one face of the part's box, in the part's local
 * frame (x along its facing, y to its left, z up from its insertion point;
 * millimetres), so "front" is the side the part faces. A zone is centred on
 * its face unless `offset` slides it (positive: toward the part's left for
 * front/back, toward its front for left/right and top/bottom).
 *
 * Most zones keep out anything solid. A dedicated zone (`excludes:
 * "foreign_systems"`) keeps out only systems foreign to the part's own
 * installation: the space above a panel (NEC 110.26(E)) may hold its own
 * conduit, never a duct or a pipe. It can stop at the structure above
 * (`toStructure`) and at a suspended ceiling inside it
 * (`endsAtSuspendedCeiling`); what the building has there the engineer states
 * on the placed part (`structureMm`, `suspendedCeilingMm`) or the lint finds.
 */

/** The six purposes the kernel ships, as rows of `CLEARANCE_PURPOSE_POINT` (stored ids unchanged since round 5). */
export const CLEARANCE_PURPOSES = ["service_access", "combustible", "economizer_access", "working_space", "keep_out", "dedicated_space"] as const;
export type ClearancePurpose = (typeof CLEARANCE_PURPOSES)[number];
/** Any purpose a stored zone may name: a built-in one or an add-on's row (`<pack>.<name>`). Readers keep one they don't know. */
export type ClearancePurposeId = ClearancePurpose | (string & {});

const BUILT_IN_PURPOSE_LABELS: Readonly<Record<ClearancePurpose, string>> = {
  service_access: "Service access",
  combustible: "Clearance to combustibles",
  economizer_access: "Economizer access",
  working_space: "Electrical working space",
  keep_out: "Keep clear",
  dedicated_space: "Dedicated equipment space",
};

/**
 * What a clearance purpose is (contract 1.9.0, `kernel.clearance_purpose` v1).
 * A zone names its purpose by id; the purpose says what a person calls it,
 * how serious something solid inside it is, and its IFC home when the zone
 * exports. An add-on registers its own (`<pack>.<name>`) and every reader
 * (derived zones, the clearance lint, the part editor) takes it with no
 * kernel edit.
 */
export interface ClearancePurposeDef {
  readonly id: string;
  readonly label: string;
  /** A finding for something solid inside: `error` for a code or safety matter, `warning` for access and keep-clear. */
  readonly severity: "error" | "warning";
  /** IfcSpatialZone PredefinedType when its derived zone exports. Absent: USERDEFINED. */
  readonly ifcPredefinedType?: "RESERVATION" | "CONSTRUCTION" | "USERDEFINED";
}

const HARD_BUILT_IN: ReadonlySet<string> = new Set(["working_space", "combustible"]);
const RESERVATION_BUILT_IN: ReadonlySet<string> = new Set(["dedicated_space", "working_space"]);

export const BUILT_IN_CLEARANCE_PURPOSES: readonly ClearancePurposeDef[] = Object.freeze(
  CLEARANCE_PURPOSES.map((id): ClearancePurposeDef => Object.freeze({ id, label: BUILT_IN_PURPOSE_LABELS[id], severity: HARD_BUILT_IN.has(id) ? "error" : "warning", ifcPredefinedType: RESERVATION_BUILT_IN.has(id) ? "RESERVATION" : "USERDEFINED" })),
);

export const CLEARANCE_PURPOSE_POINT = defineExtensionPoint<ClearancePurposeDef>({
  id: "kernel.clearance_purpose",
  version: 1,
  label: "Clearance purposes",
  idOf: (row) => row.id,
  builtins: () => BUILT_IN_CLEARANCE_PURPOSES,
});

const PURPOSE_TABLE_KEY = "kernel.clearance_purpose#table";

/** The purposes of the set in force (built in first), by id; built once per set. */
export function clearancePurposeTable(set: PackSet = activePackSet()): ReadonlyMap<string, ClearancePurposeDef> {
  return set.memo(PURPOSE_TABLE_KEY, () => new Map(set.items(CLEARANCE_PURPOSE_POINT).map((p) => [p.id, p])));
}

export function clearancePurpose(id: string, set?: PackSet): ClearancePurposeDef | null {
  return clearancePurposeTable(set).get(id) ?? null;
}

/** A purpose in words; one whose add-on isn't on this model is named as such, never guessed. */
export function clearancePurposeLabel(id: string, set?: PackSet): string {
  return clearancePurpose(id, set)?.label ?? `${id.replace(/_/g, " ")} (from an add-on this model doesn't have)`;
}

/** Problems with purpose rows, in words (pack conformance). */
export function clearancePurposeRowProblems(items: readonly ClearancePurposeDef[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!isRegistryIdShape(item.id)) out.push(`clearance purpose "${item.id}" isn't a registry id`);
    if (item.label.trim().length === 0) out.push(`clearance purpose ${item.id} has no label`);
    if (item.severity !== "error" && item.severity !== "warning") out.push(`clearance purpose ${item.id}: severity must be error or warning`);
  }
  return out;
}

/**
 * Labels by purpose id: the built-in six, and any other id read through the
 * purpose rows in force (an add-on's label, or "from an add-on this model
 * doesn't have"), so a screen that indexes it shows an add-on's purpose too.
 */
export const CLEARANCE_PURPOSE_LABELS: Readonly<Record<ClearancePurpose, string>> & Readonly<Record<string, string | undefined>> = new Proxy(BUILT_IN_PURPOSE_LABELS, {
  get: (target, key) => (typeof key !== "string" ? undefined : Object.hasOwn(target, key) ? Reflect.get(target, key) : clearancePurposeLabel(key)),
});

const purposeIdSchema = z.string().refine(isRegistryIdShape, "a clearance purpose such as service_access or working_space, or an add-on's (<pack>.<name>)");

/** What a zone keeps out: anything solid, or only systems foreign to the part's own trade (ducts and pipes over a panel). */
export const CLEARANCE_EXCLUDES = ["solid", "foreign_systems"] as const;
export type ClearanceExcludes = (typeof CLEARANCE_EXCLUDES)[number];

export const CLEARANCE_FACES = ["front", "back", "left", "right", "top", "bottom"] as const;
export type ClearanceFace = (typeof CLEARANCE_FACES)[number];

const ZONE_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const zoneIdSchema = z.string().regex(ZONE_ID, "lower case letters, digits, - and _, starting with a letter (40 at most)");

export const NEC_110_26_CONDITIONS = [1, 2, 3] as const;

/**
 * Where a zone's size came from, so a person can see it and recompute it.
 * The size itself is always stored on the zone: the kernel never applies a code.
 */
export const clearanceBasisSchema = z
  .object({
    code: z.literal("nec_110_26"),
    edition: z.enum(["2020", "2023"]),
    /** Nominal voltage to ground, volts. */
    voltageToGround: z.number().finite().positive().max(1000),
    condition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    /** The engineer's choice to draw more than the table depth (2 for "double clearance" as noted on a drawing). */
    depthMultiplier: z.number().finite().min(1).max(3).optional(),
  })
  .strict();
export type ClearanceBasis = z.infer<typeof clearanceBasisSchema>;

export const clearanceZoneSchema = z
  .object({
    id: zoneIdSchema,
    name: z.string().trim().min(1).max(60),
    purpose: purposeIdSchema,
    face: z.enum(CLEARANCE_FACES),
    /** How far the zone reaches out from the face. */
    depth: dimSchema,
    /** Along the face; default: the part's own size along that face. */
    width: dimSchema.optional(),
    /** Up the face (front/back/left/right) or across it (top/bottom); default: the part's own size. */
    height: dimSchema.optional(),
    /** Slide along the face from centred; default 0. */
    offset: dimSchema.optional(),
    /** Starts at the floor or roof the part stands on rather than at the part's base (working space is measured from the floor). */
    fromFloor: z.boolean().optional(),
    basis: clearanceBasisSchema.optional(),
    /** Absent: anything solid. */
    excludes: z.enum(CLEARANCE_EXCLUDES).optional(),
    /** An upward zone stops at the structure above when that is lower than its depth. */
    toStructure: z.boolean().optional(),
    /** A suspended ceiling with removable panels inside the zone ends it there; what is above the ceiling is allowed. */
    endsAtSuspendedCeiling: z.boolean().optional(),
    /** The clause the zone comes from, printed with a finding ("NEC 110.26(E)(1)(a)"). */
    cite: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type ClearanceZone = z.infer<typeof clearanceZoneSchema>;

export const clearanceZonesSchema = z.array(clearanceZoneSchema).max(12);

/**
 * A placed part's change to one zone, by id: numbers in millimetres. `off`
 * switches a type zone off for this part only. A full zone (name, purpose,
 * face and depth) with an id the type doesn't have adds a zone to this part.
 */
export const clearanceOverrideSchema = z
  .object({
    off: z.boolean().optional(),
    name: z.string().trim().min(1).max(60).optional(),
    purpose: purposeIdSchema.optional(),
    face: z.enum(CLEARANCE_FACES).optional(),
    depth: z.number().finite().min(0).max(30_000).optional(),
    width: z.number().finite().min(0).max(30_000).optional(),
    height: z.number().finite().min(0).max(30_000).optional(),
    offset: z.number().finite().min(-30_000).max(30_000).optional(),
    fromFloor: z.boolean().optional(),
    basis: clearanceBasisSchema.optional(),
    excludes: z.enum(CLEARANCE_EXCLUDES).optional(),
    toStructure: z.boolean().optional(),
    endsAtSuspendedCeiling: z.boolean().optional(),
    cite: z.string().trim().min(1).max(80).optional(),
    /** What the engineer says is over this part: the structural ceiling, mm above the floor it stands on. */
    structureMm: z.number().finite().min(0).max(30_000).optional(),
    /** A suspended ceiling with removable panels over this part, mm above the floor it stands on. */
    suspendedCeilingMm: z.number().finite().min(0).max(30_000).optional(),
  })
  .strict();
export type ClearanceOverride = z.infer<typeof clearanceOverrideSchema>;

export const clearanceOverridesSchema = z.record(zoneIdSchema, clearanceOverrideSchema);
export type ClearanceOverrides = Readonly<Record<string, ClearanceOverride>>;

type V3 = readonly [number, number, number];

/** A zone with every dimension resolved, as a local box. */
export interface ResolvedClearance {
  readonly id: string;
  readonly name: string;
  readonly purpose: ClearancePurposeId;
  readonly face: ClearanceFace;
  readonly fromFloor: boolean;
  readonly basis?: ClearanceBasis;
  /** Present only on dedicated zones and the like (absent: anything solid is kept out). */
  readonly excludes?: ClearanceExcludes;
  readonly toStructure?: boolean;
  readonly endsAtSuspendedCeiling?: boolean;
  readonly cite?: string;
  /** The engineer's statements about the building over this part, mm above its floor. */
  readonly structureMm?: number;
  readonly suspendedCeilingMm?: number;
  /** Local box (mm). When `fromFloor`, min[2] is the part's base and the world box extends down to the floor. */
  readonly min: V3;
  readonly max: V3;
  /** True when this placed part changed or added it. */
  readonly overridden: boolean;
}

interface PartBox {
  readonly min: V3;
  readonly max: V3;
}

/** Whether an override describes a whole zone (so it can add one the type doesn't have). */
function isWholeZone(o: ClearanceOverride): o is ClearanceOverride & { name: string; purpose: ClearancePurposeId; face: ClearanceFace; depth: number } {
  return o.name !== undefined && o.purpose !== undefined && o.face !== undefined && o.depth !== undefined;
}

/**
 * The part's clearance zones as local boxes: the type's zones with this
 * part's overrides applied, then any zones this part adds. Zones switched off
 * or with no depth are left out. `dim` resolves a type dimension against the
 * part's values (parts.ts resolveDim).
 */
export function resolveClearances(zones: readonly ClearanceZone[] | undefined, overrides: ClearanceOverrides | undefined, box: PartBox, dim: (d: Dim) => number): ResolvedClearance[] {
  const out: ResolvedClearance[] = [];
  const seen = new Set<string>();
  for (const z of zones ?? []) {
    seen.add(z.id);
    const o = overrides?.[z.id];
    if (o?.off) continue;
    const resolved = zoneBox(
      {
        face: o?.face ?? z.face,
        depth: o?.depth ?? dim(z.depth),
        width: o?.width ?? (z.width !== undefined ? dim(z.width) : undefined),
        height: o?.height ?? (z.height !== undefined ? dim(z.height) : undefined),
        offset: o?.offset ?? (z.offset !== undefined ? dim(z.offset) : 0),
      },
      box,
    );
    if (!resolved) continue;
    const basis = o?.basis ?? z.basis;
    out.push({
      id: z.id,
      name: o?.name ?? z.name,
      purpose: o?.purpose ?? z.purpose,
      face: o?.face ?? z.face,
      fromFloor: o?.fromFloor ?? z.fromFloor ?? false,
      ...(basis ? { basis } : {}),
      ...dedicatedFields(z, o),
      ...resolved,
      overridden: o !== undefined,
    });
  }
  for (const [id, o] of Object.entries(overrides ?? {})) {
    if (seen.has(id) || o.off || !isWholeZone(o)) continue;
    const resolved = zoneBox({ face: o.face, depth: o.depth, width: o.width, height: o.height, offset: o.offset ?? 0 }, box);
    if (!resolved) continue;
    out.push({ id, name: o.name, purpose: o.purpose, face: o.face, fromFloor: o.fromFloor ?? false, ...(o.basis ? { basis: o.basis } : {}), ...dedicatedFields(undefined, o), ...resolved, overridden: true });
  }
  return out;
}

/** The dedicated-zone fields a zone and its override set, only those present (zones without them resolve exactly as before). */
function dedicatedFields(z: ClearanceZone | undefined, o: ClearanceOverride | undefined): Pick<ResolvedClearance, "excludes" | "toStructure" | "endsAtSuspendedCeiling" | "cite" | "structureMm" | "suspendedCeilingMm"> {
  const excludes = o?.excludes ?? z?.excludes;
  const toStructure = o?.toStructure ?? z?.toStructure;
  const endsAtSuspendedCeiling = o?.endsAtSuspendedCeiling ?? z?.endsAtSuspendedCeiling;
  const cite = o?.cite ?? z?.cite;
  return {
    ...(excludes !== undefined ? { excludes } : {}),
    ...(toStructure !== undefined ? { toStructure } : {}),
    ...(endsAtSuspendedCeiling !== undefined ? { endsAtSuspendedCeiling } : {}),
    ...(cite !== undefined ? { cite } : {}),
    ...(o?.structureMm !== undefined ? { structureMm: o.structureMm } : {}),
    ...(o?.suspendedCeilingMm !== undefined ? { suspendedCeilingMm: o.suspendedCeilingMm } : {}),
  };
}

/** Where an upward dedicated zone ends, and why: the lowest of its own depth, the structure above and a suspended ceiling inside it. */
export interface ZoneTop {
  /** Model elevation, mm. */
  readonly topMm: number;
  readonly endsAt: "depth" | "structure" | "suspended_ceiling";
  /** The structure above was not known, so the zone ran its full depth (said in findings, never silently). */
  readonly structureAssumed: boolean;
}

/**
 * The top of a placed zone after the structure and a suspended ceiling cut it.
 * `structureMm` / `suspendedCeilingMm` are model elevations found in the
 * model (the lint's surfaces); the engineer's statements on the part win.
 */
export function dedicatedZoneTop(zone: PlacedClearance, floorMm: number, found: { readonly structureMm: number | null; readonly suspendedCeilingMm: number | null }): ZoneTop {
  let topMm = zone.topMm;
  let endsAt: ZoneTop["endsAt"] = "depth";
  const structure = zone.structureMm !== undefined ? floorMm + zone.structureMm : found.structureMm;
  if (zone.toStructure && structure !== null && structure > zone.bottomMm && structure < topMm) {
    topMm = structure;
    endsAt = "structure";
  }
  const ceiling = zone.suspendedCeilingMm !== undefined ? floorMm + zone.suspendedCeilingMm : found.suspendedCeilingMm;
  if (zone.endsAtSuspendedCeiling && ceiling !== null && ceiling > zone.bottomMm && ceiling < topMm) {
    topMm = ceiling;
    endsAt = "suspended_ceiling";
  }
  return { topMm, endsAt, structureAssumed: zone.toStructure === true && structure === null };
}

/** Overrides that name a zone the type doesn't have and aren't a whole zone: the plain reason for each. */
export function clearanceOverrideIssues(zones: readonly ClearanceZone[] | undefined, overrides: ClearanceOverrides | undefined): string[] {
  const ids = new Set((zones ?? []).map((z) => z.id));
  const issues: string[] = [];
  for (const [id, o] of Object.entries(overrides ?? {})) {
    if (o.purpose !== undefined) {
      const purpose = purposeIssue(o.purpose);
      if (purpose) issues.push(`Clearance "${id}": ${purpose}`);
    }
    if (ids.has(id) || o.off) continue;
    if (!isWholeZone(o)) issues.push(`The part type has no clearance "${id}"; to add one, give its name, purpose, face and depth`);
  }
  return issues;
}

/** Clearance problems in a type definition beyond its JSON shape. */
export function clearanceZoneIssues(zones: readonly ClearanceZone[] | undefined): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  const ids = new Set<string>();
  for (const z of zones ?? []) {
    if (ids.has(z.id)) issues.push({ field: `clearances.${z.id}`, message: `Clearance ${z.id} is defined twice` });
    ids.add(z.id);
    if (typeof z.depth === "number" && z.depth <= 0) issues.push({ field: `clearances.${z.id}`, message: `${z.name} needs a depth greater than 0` });
    const purpose = purposeIssue(z.purpose);
    if (purpose) issues.push({ field: `clearances.${z.id}`, message: `${z.name}: ${purpose}` });
  }
  return issues;
}

/** Why a zone's purpose can't be written on this model, or null (strict writer; readers keep any purpose). */
function purposeIssue(purpose: string): string | null {
  return clearancePurpose(purpose) ? null : `its purpose "${purpose}" comes from an add-on this model doesn't have`;
}

// ------------------------------------------------------------------ positions

/**
 * Named positions (the `positions` face of a part type): a part that moves
 * (a leaf that opens, a lid that lifts, a carriage that travels) takes more
 * space in one position than another. Each position lists the envelopes it
 * takes beyond the part's body, as clearance-shaped boxes against the part's
 * faces with a purpose, so derived zones and the clearance lint read them
 * exactly like clearances.
 *
 * Roles are open ids: `open`, `closed` and `travel` are the kernel's words.
 * A `travel` position's envelopes are the space swept moving between the
 * others; they are kept clear whatever position the part is in. Of the other
 * positions, the placed part's `positionId` names the one it is in (absent:
 * the first listed).
 */
export const PART_POSITION_ROLES = ["open", "closed", "travel"] as const;
export type PartPositionRole = (typeof PART_POSITION_ROLES)[number] | (string & {});

export const partPositionSchema = z
  .object({
    id: zoneIdSchema,
    name: z.string().trim().min(1).max(60),
    role: z.string().refine(isRegistryIdShape, "a position role such as open, closed or travel, or an add-on's (<pack>.<name>)"),
    /** The space it takes in this position beyond the part's body. A closed position often takes none. */
    envelopes: z.array(clearanceZoneSchema).max(8),
  })
  .strict();
export type PartPosition = z.infer<typeof partPositionSchema>;

export const partPositionsSchema = z.array(partPositionSchema).max(8);

/** The position a placed part is in: its own `positionId` when the type has it, else the first position that isn't travel. */
export function currentPosition(positions: readonly PartPosition[] | undefined, positionId: string | undefined): PartPosition | null {
  if (!positions?.length) return null;
  const own = positionId === undefined ? undefined : positions.find((p) => p.id === positionId && p.role !== "travel");
  return own ?? positions.find((p) => p.role !== "travel") ?? null;
}

/** A resolved envelope remembers the position it belongs to. */
export interface ResolvedEnvelope extends ResolvedClearance {
  readonly position: { readonly id: string; readonly name: string; readonly role: string };
}

/**
 * The envelopes a placed part keeps clear now, as local boxes: every travel
 * position's, and the current position's. Ids are `<position>.<envelope>` so
 * they never meet a clearance id.
 */
export function resolvePositionEnvelopes(positions: readonly PartPosition[] | undefined, positionId: string | undefined, box: PartBox, dim: (d: Dim) => number): ResolvedEnvelope[] {
  if (!positions?.length) return [];
  const current = currentPosition(positions, positionId);
  const out: ResolvedEnvelope[] = [];
  for (const p of positions) {
    if (p.role !== "travel" && p !== current) continue;
    for (const z of resolveClearances(p.envelopes, undefined, box, dim)) out.push({ ...z, id: `${p.id}.${z.id}`, position: { id: p.id, name: p.name, role: p.role } });
  }
  return out;
}

/** Problems with a type's positions beyond their JSON shape. */
export function partPositionIssues(positions: readonly PartPosition[] | undefined): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  if (!positions?.length) return issues;
  const ids = new Set<string>();
  for (const p of positions) {
    if (ids.has(p.id)) issues.push({ field: `positions.${p.id}`, message: `Position ${p.id} is defined twice` });
    ids.add(p.id);
    for (const i of clearanceZoneIssues(p.envelopes)) issues.push({ field: `positions.${p.id}.${i.field.replace(/^clearances\./, "")}`, message: `${p.name}: ${i.message}` });
  }
  if (positions.every((p) => p.role === "travel")) issues.push({ field: "positions", message: "Give at least one position the part can be in (open, closed…), not only travel" });
  return issues;
}

function zoneBox(z: { face: ClearanceFace; depth: number; width: number | undefined; height: number | undefined; offset: number }, b: PartBox): { min: V3; max: V3 } | null {
  if (!(z.depth > 0)) return null;
  const sx = b.max[0] - b.min[0];
  const sy = b.max[1] - b.min[1];
  const sz = b.max[2] - b.min[2];
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const span = (c: number, size: number): [number, number] => [c - size / 2, c + size / 2];
  switch (z.face) {
    case "front":
    case "back": {
      const [y0, y1] = span(cy + z.offset, z.width ?? sy);
      const h = z.height ?? sz;
      const x0 = z.face === "front" ? b.max[0] : b.min[0] - z.depth;
      return { min: [x0, y0, b.min[2]], max: [x0 + z.depth, y1, b.min[2] + h] };
    }
    case "left":
    case "right": {
      const [x0, x1] = span(cx + z.offset, z.width ?? sx);
      const h = z.height ?? sz;
      const y0 = z.face === "left" ? b.max[1] : b.min[1] - z.depth;
      return { min: [x0, y0, b.min[2]], max: [x1, y0 + z.depth, b.min[2] + h] };
    }
    case "top":
    case "bottom": {
      const [x0, x1] = span(cx + z.offset, z.height ?? sx);
      const [y0, y1] = span(cy, z.width ?? sy);
      const z0 = z.face === "top" ? b.max[2] : b.min[2] - z.depth;
      return { min: [x0, y0, z0], max: [x1, y1, z0 + z.depth] };
    }
  }
}

/** A clearance zone placed in the model: its plan corners (world, counter-clockwise) and its height band. */
export interface PlacedClearance extends ResolvedClearance {
  readonly partId: string;
  readonly corners: readonly [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  readonly bottomMm: number;
  readonly topMm: number;
}

/**
 * Local zone → world, given the part's insertion point, rotation and base
 * elevation, and the elevation of the floor or roof it stands on (for zones
 * measured from the floor).
 */
export function placeClearance(
  zone: ResolvedClearance,
  part: { readonly id: string; readonly position: { readonly x: number; readonly y: number }; readonly rotationDeg: number },
  baseMm: number,
  floorMm: number,
): PlacedClearance {
  const a = (part.rotationDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const w = (x: number, y: number) => ({ x: part.position.x + x * c - y * s, y: part.position.y + x * s + y * c });
  const [x0, y0, z0] = zone.min;
  const [x1, y1, z1] = zone.max;
  const bottomMm = zone.fromFloor ? floorMm : baseMm + z0;
  return { ...zone, partId: part.id, corners: [w(x0, y0), w(x1, y0), w(x1, y1), w(x0, y1)], bottomMm, topMm: bottomMm + (z1 - z0) };
}
