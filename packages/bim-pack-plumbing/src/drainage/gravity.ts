import type { LoadPointElement, BimElement, ElementId } from "@permitzip/bim-kernel";
import { loadIndexOf, requirementsEngineOf, sourceFiguresOf } from "@permitzip/bim-kernel";
import { coversDemand, type BalanceTolerance, type DemandCoverage } from "./balance";
import { drainageLoadsByFloor, drainageParts, drainageProtectionOf, sewagePumpOf } from "./read";
import type { BackwaterVerdict, FloorAgainstSewer, GravityVerdict, SewerConnection } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

const MM_PER_IN = 25.4;
const MM_PER_FT = 304.8;

/**
 * Gravity against a fixed sewer elevation. Code-neutral arithmetic: the code
 * packs (bim-calc) supply the slope bands and the drain capacity tables and cite
 * them; the kernel only compares elevations and looks values up in a table it is
 * handed, so the same reads serve a building sewer, a storm connection or a
 * civil lateral.
 */

// ------------------------------------------------------------ invert limit

export interface GravityLimitInput {
  /** Invert of the sewer or manhole outlet, mm above project zero. */
  readonly sewerInvertMm: number;
  /** Slope of the building drain, in/ft. Null: unknown, so no fall is added. */
  readonly slopeInPerFt: number | null;
  /** Developed length from the farthest floor to the connection, mm. Null: unknown, so no fall is added. */
  readonly lengthMm: number | null;
}

export interface GravityLimit {
  /** The lowest drain invert that still reaches the sewer by gravity, mm above project zero. */
  readonly limitMm: number;
  /** The fall the building drain needs over its length, mm (0 when slope or length is unknown). */
  readonly fallMm: number;
  readonly fallKnown: boolean;
}

/** The sewer invert plus the fall the building drain needs to reach it: slope (in/ft) × length (ft) inches. */
export function gravityLimit(input: GravityLimitInput): GravityLimit {
  const known = input.slopeInPerFt !== null && input.lengthMm !== null && input.slopeInPerFt >= 0 && input.lengthMm >= 0;
  const fallMm = known ? (input.slopeInPerFt ?? 0) * ((input.lengthMm ?? 0) / MM_PER_FT) * MM_PER_IN : 0;
  return { limitMm: input.sewerInvertMm + fallMm, fallMm, fallKnown: known };
}

/** A floor's drain invert against the limit: it drains by gravity when its drain sits at or above it. */
export function gravityVerdict(drainInvertMm: number, limitMm: number | null): GravityVerdict {
  if (limitMm === null) return "unknown";
  return drainInvertMm >= limitMm - 0.5 ? "gravity" : "needs_pump";
}

/**
 * A floor below the next upstream manhole cover (or the sewer's overflow level)
 * floods back through its fixtures when the sewer surcharges. The floor is used
 * as the flood-level rim: exact for floor drains and floor sinks, conservative
 * for a lavatory.
 */
export function backwaterVerdict(floorMm: number, rimMm: number | null): BackwaterVerdict {
  if (rimMm === null) return "unknown";
  return floorMm < rimMm - 0.5 ? "below_rim" : "above_rim";
}

/** Every floor with drainage loads against one sewer connection, lowest first. */
export function floorsAgainstSewer(elements: Elements, connection: SewerConnection): FloorAgainstSewer[] {
  const limit = connection.invertMm === null ? null : gravityLimit({ sewerInvertMm: connection.invertMm, slopeInPerFt: connection.drain.slopeInPerFt, lengthMm: connection.drain.lengthMm }).limitMm;
  return drainageLoadsByFloor(elements).floors.map((floor) => {
    const drainInvertMm = floor.floorMm - connection.depthBelowFloorMm;
    const gravity = gravityVerdict(drainInvertMm, limit);
    const backwater = backwaterVerdict(floor.floorMm, connection.rimMm);
    const needPump: ElementId[] = [];
    const needValve: ElementId[] = [];
    const throughValveAboveRim: ElementId[] = [];
    for (const id of floor.loadIds) {
      const lp = elements[id];
      if (lp?.kind !== "load_point") continue;
      const p = drainageProtectionOf(elements, lp);
      if (gravity === "needs_pump" && !p.pumped) needPump.push(id);
      if (backwater === "below_rim" && !p.backwaterValve) needValve.push(id);
      if (backwater === "above_rim" && p.backwaterValve && !p.pumped) throughValveAboveRim.push(id);
    }
    return { ...floor, drainInvertMm, gravityLimitMm: limit, gravity, backwater, needPump, needValve, throughValveAboveRim };
  });
}

// ------------------------------------------------------------ drain capacity

/** One row of a drain capacity table: the most fixture units a size carries at each slope (null: not permitted at that slope). */
export interface GravityCapacityRow {
  readonly nominalIn: number;
  readonly maxDfu: readonly (number | null)[];
}

export interface GravityCapacityTable {
  readonly rows: readonly GravityCapacityRow[];
  /** The slopes the columns are for, in/ft, ascending. */
  readonly slopes: readonly number[];
}

export interface GravityCapacity {
  /** Null: the size is not in the table, or not permitted at any column at or below the slope. */
  readonly maxDfu: number | null;
  /** The table column used: the steepest one not steeper than the pipe. */
  readonly tableSlope: number | null;
}

/** What a drain of this size carries at this slope, from the table (no interpolation: the column at or below the slope). */
export function gravityDrainCapacity(table: GravityCapacityTable, nominalIn: number, slopeInPerFt: number): GravityCapacity {
  const row = table.rows.find((r) => Math.abs(r.nominalIn - nominalIn) < 1e-6);
  let col = -1;
  table.slopes.forEach((s, i) => {
    if (s <= slopeInPerFt + 1e-9) col = i;
  });
  if (!row || col < 0) return { maxDfu: null, tableSlope: col < 0 ? null : (table.slopes[col] ?? null) };
  return { maxDfu: row.maxDfu[col] ?? null, tableSlope: table.slopes[col] ?? null };
}

/** The smallest size in the table that carries `dfu` at this slope, never under `minIn`; null when none does. */
export function smallestGravityDrain(table: GravityCapacityTable, dfu: number, slopeInPerFt: number, minIn = 0): { readonly nominalIn: number; readonly maxDfu: number } | null {
  for (const row of table.rows) {
    if (row.nominalIn < minIn - 1e-9) continue;
    const c = gravityDrainCapacity(table, row.nominalIn, slopeInPerFt);
    if (c.maxDfu !== null && c.maxDfu >= dfu - 1e-9) return { nominalIn: row.nominalIn, maxDfu: c.maxDfu };
  }
  return null;
}

// ------------------------------------------------------------ what drains to a connection

export interface SewerDfu {
  readonly dfu: number;
  /**
   * whole_building: the only sewer connection in the model, so every drainage load
   * drains here (the requirements engine's counted total: no estimate and the
   * devices inside it counted twice). named: several connections, so only the
   * loads that name this one as their source.
   */
  readonly basis: "whole_building" | "named";
  readonly loads: number;
}

/** Fixture units arriving at a sewer connection, read through the load lifecycle (indexed; never a pipe walk). */
export function dfuAtSewerConnection(elements: Elements, connectionId: ElementId): SewerDfu {
  if (drainageParts(elements).sewerConnections.length <= 1) {
    const byFloor = drainageLoadsByFloor(elements);
    const loads = byFloor.floors.reduce((n, f) => n + f.loadIds.length, 0) + byFloor.unplaced.length;
    return { dfu: requirementsEngineOf(elements).counted({ elements }).dfu, basis: "whole_building", loads };
  }
  return { dfu: sourceFiguresOf(elements, connectionId).counted.dfu, basis: "named", loads: loadIndexOf(elements).servedBy(connectionId).length };
}

// ------------------------------------------------------------ sewage pumps

export interface PumpInputs {
  readonly inflowGpm: number | null;
  readonly headFt: number | null;
  readonly ratedGpm: number | null;
  readonly ratedHeadFt: number | null;
}

export type PumpVerdict =
  /** Fixture units drain to it but no flow is typed. Never converted (product decision 7). */
  | { readonly kind: "inflow_unknown" }
  | { readonly kind: "head_unknown" }
  | { readonly kind: "rating_unknown"; readonly missing: readonly ("flow" | "head")[] }
  | { readonly kind: "ok"; readonly flow: DemandCoverage; readonly head: DemandCoverage }
  | { readonly kind: "undersized"; readonly flow: DemandCoverage; readonly head: DemandCoverage };

/**
 * The engineer's inflow and head against the pump's rating point. A pump that
 * delivers its rated flow at its rated head delivers at least that flow at any
 * lower head, so both must be covered: inflow ≤ rated flow and head ≤ rated head.
 */
export function pumpAgainstInflow(input: PumpInputs, tolerance: BalanceTolerance = {}): PumpVerdict {
  if (input.inflowGpm === null) return { kind: "inflow_unknown" };
  if (input.headFt === null) return { kind: "head_unknown" };
  const missing: ("flow" | "head")[] = [];
  if (input.ratedGpm === null) missing.push("flow");
  if (input.ratedHeadFt === null) missing.push("head");
  if (missing.length > 0 || input.ratedGpm === null || input.ratedHeadFt === null) return { kind: "rating_unknown", missing };
  const flow = coversDemand(input.inflowGpm, input.ratedGpm, tolerance);
  const head = coversDemand(input.headFt, input.ratedHeadFt, tolerance);
  return flow.ok && head.ok ? { kind: "ok", flow, head } : { kind: "undersized", flow, head };
}

export interface SewagePumpCheck {
  readonly pumpId: ElementId;
  readonly label: string;
  /** Fixture units of the loads that name the pump (shown, never converted to a flow). */
  readonly dfu: number;
  readonly loads: number;
  readonly verdict: PumpVerdict;
}

/** A sewage pump in the model against what drains to it. Null when the id is not a sewage pump. */
export function sewagePumpCheck(elements: Elements, pumpId: ElementId, tolerance: BalanceTolerance = {}): SewagePumpCheck | null {
  const pump = sewagePumpOf(elements, pumpId);
  if (!pump) return null;
  const served = loadIndexOf(elements).servedBy(pumpId).filter((id) => elements[id]?.kind === "load_point");
  return {
    pumpId,
    label: pump.label,
    dfu: served.length > 0 ? sourceFiguresOf(elements, pumpId).counted.dfu : 0,
    loads: served.length,
    verdict: pumpAgainstInflow({ inflowGpm: pump.inflowGpm, headFt: pump.headFt, ratedGpm: pump.ratedGpm, ratedHeadFt: pump.ratedHeadFt }, tolerance),
  };
}

/** The drainage loads (by id) a pump serves, for messages that list them. */
export function loadsDrainingTo(elements: Elements, sourceId: ElementId): LoadPointElement[] {
  const out: LoadPointElement[] = [];
  for (const id of loadIndexOf(elements).servedBy(sourceId)) {
    const el = elements[id];
    if (el?.kind === "load_point") out.push(el);
  }
  return out;
}
