import { activePackSet, defineExtensionPoint } from "@permitzip/bim-kernel/packs";
import { loadPointLabel, loadPointTotals, placementOf, loadAnchorOf, elementsOfKind, recordsOfKinds, drainSystemKinds, serviceById, systemKindsWithAdapter, zoneBoundsOf, zoneSpaceIds } from "@permitzip/bim-kernel";
import type { LoadPointElement, BimElement, ElementId, ParamValue, PartInstance } from "@permitzip/bim-kernel";
import { DRAINAGE_PARAMS, DRAINAGE_ROLES, ELEVATION_CONFIDENCES, type DrainageFloor, type DrainageProtection, type DrainageRole, type ElevationConfidence, type SewagePump, type SewerConnection } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Reads for the drainage checks. Every read is by id or from an index built once
 * per model state (WeakMap on the record), never a scan per call: the parts that
 * play a drainage role are found through the few part types that declare
 * `drainage_role`, and the drainage loads by level through the `load_point` kind
 * index.
 */

/** An instance value, else the type's value, else the parameter's default. */
export function drainageParam(elements: Elements, part: PartInstance, name: string): ParamValue | undefined {
  const own = part.values[name];
  if (own !== undefined) return own;
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return undefined;
  const typed = type.definition.typeValues[name];
  if (typed !== undefined) return typed;
  return [...type.definition.instanceParams, ...type.definition.typeParams].find((p) => p.name === name)?.default;
}

const num = (v: ParamValue | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function isRole(v: ParamValue | undefined): v is DrainageRole {
  return typeof v === "string" && (DRAINAGE_ROLES as readonly string[]).includes(v);
}

function isConfidence(v: ParamValue | undefined): v is ElevationConfidence {
  return typeof v === "string" && (ELEVATION_CONFIDENCES as readonly string[]).includes(v);
}

export function drainageRoleOf(elements: Elements, el: BimElement | undefined): DrainageRole | null {
  if (el?.kind !== "part") return null;
  const role = drainageParam(elements, el, DRAINAGE_PARAMS.role);
  return isRole(role) ? role : null;
}

function partLabel(part: PartInstance): string {
  return part.mark.trim() || part.id;
}

/**
 * Sewer connections (round 12 P12, `plumbing.sewer_node` v1): where a
 * building drain meets the sewer (a manhole, a tap on the main, a lateral
 * stub), with its rim, invert and how sure we are of them. The built-in row
 * reads a part whose type carries `drainage_role: sewer_connection`; another
 * add-on (a civil add-on's manhole) registers its own row and every check
 * here (gravity, backwater valve, drain capacity) reads it the same way.
 */
export interface SewerNodeRow {
  /** `<pack>.<name>`; the built-in row is `drainage_role`. */
  readonly id: string;
  /** What a person calls it ("Manhole"). */
  readonly label: string;
  /** The element kinds it reads (so the model is never scanned whole). */
  readonly kinds: readonly string[];
  /** The element as a sewer connection, or null when it isn't one. Every value may be missing. */
  read(elements: Elements, el: BimElement): SewerConnection | null;
}

/** Problems with sewer node rows (pack conformance), in words. */
export function sewerNodeRowProblems(rows: readonly SewerNodeRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.label.trim().length === 0) out.push(`sewer connection kind ${r.id} has no label`);
    if (r.kinds.length === 0) out.push(`sewer connection kind ${r.id} reads no element kind`);
  }
  return out;
}

const BUILTIN_SEWER_NODE: SewerNodeRow = { id: "drainage_role", label: "Sewer connection", kinds: ["part"], read: (elements, el) => partSewerConnectionOf(elements, el.id) };

export const SEWER_NODE_POINT = defineExtensionPoint<SewerNodeRow>({
  id: "plumbing.sewer_node",
  version: 1,
  label: "Sewer connections",
  idOf: (row) => row.id,
  builtins: () => [BUILTIN_SEWER_NODE],
});

function sewerNodeRows(): readonly SewerNodeRow[] {
  return activePackSet().items(SEWER_NODE_POINT);
}

/** The element as a sewer connection through any registered kind, or null. */
export function sewerConnectionOf(elements: Elements, id: string): SewerConnection | null {
  const el = elements[id];
  if (!el) return null;
  for (const row of sewerNodeRows()) {
    if (!row.kinds.includes(el.kind)) continue;
    const c = row.read(elements, el);
    if (c) return c;
  }
  return null;
}

function partSewerConnectionOf(elements: Elements, id: string): SewerConnection | null {
  const part = elements[id];
  if (part?.kind !== "part" || drainageRoleOf(elements, part) !== "sewer_connection") return null;
  const p = (name: string) => drainageParam(elements, part, name);
  const confidence = p(DRAINAGE_PARAMS.confidence);
  return {
    id: part.id,
    label: partLabel(part),
    invertMm: num(p(DRAINAGE_PARAMS.sewerInvert)),
    rimMm: num(p(DRAINAGE_PARAMS.sewerRim)),
    confidence: isConfidence(confidence) ? confidence : "assumed",
    confidenceTyped: isConfidence(confidence),
    drain: { nominalIn: num(p(DRAINAGE_PARAMS.drainSize)), slopeInPerFt: num(p(DRAINAGE_PARAMS.drainSlope)), lengthMm: num(p(DRAINAGE_PARAMS.drainLength)) },
    depthBelowFloorMm: Math.max(0, num(p(DRAINAGE_PARAMS.depthBelowFloor)) ?? 0),
  };
}

export function sewagePumpOf(elements: Elements, id: string): SewagePump | null {
  const part = elements[id];
  if (part?.kind !== "part" || drainageRoleOf(elements, part) !== "sewage_pump") return null;
  const p = (name: string) => drainageParam(elements, part, name);
  return {
    id: part.id,
    label: partLabel(part),
    ratedGpm: num(p(DRAINAGE_PARAMS.pumpRatedFlow)),
    ratedHeadFt: num(p(DRAINAGE_PARAMS.pumpRatedHead)),
    inflowGpm: num(p(DRAINAGE_PARAMS.pumpInflow)),
    headFt: num(p(DRAINAGE_PARAMS.pumpHead)),
    backwaterValve: p(DRAINAGE_PARAMS.backwaterValve) === true,
  };
}

// ------------------------------------------------------------ parts by role

export interface DrainageParts {
  readonly sewerConnections: readonly ElementId[];
  readonly pumps: readonly ElementId[];
  readonly valves: readonly ElementId[];
}

const partsCache = new WeakMap<object, DrainageParts>();

/** Placed and planned parts that play a drainage role, once per model state. */
export function drainageParts(elements: Elements): DrainageParts {
  const hit = partsCache.get(elements);
  if (hit) return hit;
  const declaring = new Set<string>();
  for (const t of elementsOfKind(elements, "part_type")) {
    const d = t.definition;
    if (d.typeValues[DRAINAGE_PARAMS.role] !== undefined || [...d.instanceParams, ...d.typeParams].some((p) => p.name === DRAINAGE_PARAMS.role)) declaring.add(t.id);
  }
  const out = { sewerConnections: [] as ElementId[], pumps: [] as ElementId[], valves: [] as ElementId[] };
  if (declaring.size > 0) {
    for (const part of elementsOfKind(elements, "part")) {
      if (!declaring.has(part.typeId)) continue;
      const role = drainageRoleOf(elements, part);
      if (role === "sewer_connection") out.sewerConnections.push(part.id);
      else if (role === "sewage_pump") out.pumps.push(part.id);
      else if (role === "backwater_valve") out.valves.push(part.id);
    }
  }
  const seen = new Set(out.sewerConnections);
  for (const row of sewerNodeRows()) {
    if (row === BUILTIN_SEWER_NODE) continue;
    for (const el of recordsOfKinds(elements, row.kinds)) if (!seen.has(el.id) && row.read(elements, el)) {
      seen.add(el.id);
      out.sewerConnections.push(el.id);
    }
  }
  for (const list of Object.values(out)) list.sort();
  partsCache.set(elements, out);
  return out;
}

// ------------------------------------------------------------ loads by floor

const DRAIN_SERVICES = new WeakMap<readonly string[], ReadonlySet<string>>();

/** A load service that is a drain a fixture connects to (sanitary, grease waste), from the service registry in force. */
function isDrainService(service: string): boolean {
  const piped = systemKindsWithAdapter("plumbing");
  let drains = DRAIN_SERVICES.get(piped);
  if (!drains) DRAIN_SERVICES.set(piped, (drains = new Set(piped.filter((k) => drainSystemKinds().has(k) && serviceById(k)?.asLoad === true))));
  return drains.has(service);
}

/** A load that adds drainage: it carries drainage fixture units, or says it needs a sanitary or grease waste connection. */
export function isDrainageLoad(elements: Elements, lp: LoadPointElement): boolean {
  if (lp.service !== undefined && isDrainService(lp.service)) return true;
  return loadPointTotals(elements, lp).dfu > 0;
}

/** The level a load is on: its point, its space or zone, its part, or its pipe. Null for a row typed in a table. */
export function levelOfLoad(elements: Elements, lp: LoadPointElement): ElementId | null {
  const a = loadAnchorOf(lp);
  switch (a.kind) {
    case "point":
      return a.levelId;
    case "space": {
      const s = elements[a.id];
      return s?.kind === "space" && s.levelId ? s.levelId : null;
    }
    case "zone": {
      // A zone spans its spaces' levels; the lowest floor is the one gravity and backwater flow decide.
      const z = elements[a.id];
      if (z?.kind !== "zone") return null;
      const bounds = zoneBoundsOf(z);
      if (bounds.kind === "outline") return bounds.levelId;
      let lowest: { readonly id: ElementId; readonly mm: number } | null = null;
      for (const sid of zoneSpaceIds(z)) {
        const s = elements[sid];
        const level = s?.kind === "space" && s.levelId ? elements[s.levelId] : undefined;
        if (level?.kind === "level" && (lowest === null || level.elevationMm < lowest.mm)) lowest = { id: level.id, mm: level.elevationMm };
      }
      return lowest?.id ?? null;
    }
    case "part": {
      const part = elements[a.partId];
      return part?.kind === "part" && placementOf(part).state === "placed" ? part.levelId : null;
    }
    case "run_end": {
      const host = elements[a.hostId];
      return host?.kind === "run_segment" || host?.kind === "run_fitting" ? host.levelId : null;
    }
    case "none": {
      const part = lp.attachedPartId ? elements[lp.attachedPartId] : undefined;
      return part?.kind === "part" && placementOf(part).state === "placed" ? part.levelId : null;
    }
  }
}

export interface DrainageLoadsByFloor {
  readonly floors: readonly DrainageFloor[];
  /** Drainage loads typed in a table, on no level yet: no elevation, so no gravity or backwater verdict. */
  readonly unplaced: readonly ElementId[];
}

const floorsCache = new WeakMap<object, DrainageLoadsByFloor>();

/** Every drainage load grouped by the floor it is on, lowest floor first, once per model state. */
export function drainageLoadsByFloor(elements: Elements): DrainageLoadsByFloor {
  const hit = floorsCache.get(elements);
  if (hit) return hit;
  const byLevel = new Map<ElementId, ElementId[]>();
  const unplaced: ElementId[] = [];
  for (const lp of elementsOfKind(elements, "load_point")) {
    if (!isDrainageLoad(elements, lp)) continue;
    const levelId = levelOfLoad(elements, lp);
    const level = levelId ? elements[levelId] : undefined;
    if (!levelId || level?.kind !== "level") {
      unplaced.push(lp.id);
      continue;
    }
    const list = byLevel.get(levelId);
    if (list) list.push(lp.id);
    else byLevel.set(levelId, [lp.id]);
  }
  const floors: DrainageFloor[] = [];
  for (const [levelId, ids] of byLevel) {
    const level = elements[levelId];
    if (level?.kind !== "level") continue;
    floors.push({ levelId, levelName: level.name, floorMm: level.elevationMm, loadIds: ids.sort() });
  }
  floors.sort((a, b) => a.floorMm - b.floorMm || a.levelName.localeCompare(b.levelName));
  const out = { floors, unplaced: unplaced.sort() };
  floorsCache.set(elements, out);
  return out;
}

/** What protects a drainage load, from the part it names (`servedBy`). */
export function drainageProtectionOf(elements: Elements, lp: LoadPointElement): DrainageProtection {
  const sourceId = lp.servedBy ?? null;
  const role = sourceId ? drainageRoleOf(elements, elements[sourceId]) : null;
  if (role === "sewage_pump" && sourceId) return { pumped: true, backwaterValve: sewagePumpOf(elements, sourceId)?.backwaterValve ?? false, sourceId };
  if (role === "backwater_valve") return { pumped: false, backwaterValve: true, sourceId };
  return { pumped: false, backwaterValve: false, sourceId };
}

/** "WC-1 (Water closet)" style label for messages. */
export function drainageLoadLabel(elements: Elements, lp: LoadPointElement): string {
  return loadPointLabel(elements, lp);
}
