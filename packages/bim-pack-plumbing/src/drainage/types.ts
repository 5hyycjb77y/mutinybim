import type { ElementId } from "@permitzip/bim-kernel";

/**
 * Gravity drainage below grade (ROADMAP P4): where the building drain meets the
 * public sewer or an existing manhole, the sewage pumps that lift what gravity
 * can't reach, and the backwater valves that protect fixtures below the next
 * upstream manhole cover.
 *
 * None of this is a new element kind. Each is an ordinary part whose type (or
 * instance) carries the instance values below, so a firm's own manhole, tie-in,
 * ejector or valve type works as soon as it has them, and a model with none
 * reads exactly as before. The same shape serves a civil sewer, a storm
 * connection or a lift station: only the values differ.
 *
 * Elevations are millimetres above the project's zero (the same datum as
 * `Level.elevationMm` and the `pipe.invert_*` fields). They are `length`
 * parameters, so the Properties panel already shows them in feet and inches.
 */

export type DrainageRole = "sewer_connection" | "sewage_pump" | "backwater_valve";
export const DRAINAGE_ROLES = ["sewer_connection", "sewage_pump", "backwater_valve"] as const satisfies readonly DrainageRole[];

/** How an elevation is known: measured, taken from records, or to be checked in the field before rough-in. */
export type ElevationConfidence = "verified" | "assumed" | "field_verify";
export const ELEVATION_CONFIDENCES = ["verified", "assumed", "field_verify"] as const satisfies readonly ElevationConfidence[];

/** The parameter names a part type uses to take part in the drainage checks. */
export const DRAINAGE_PARAMS = {
  /** choice: one of `DRAINAGE_ROLES`. */
  role: "drainage_role",
  /** length (mm above project zero): invert of the sewer or manhole outlet the building drain discharges into. */
  sewerInvert: "sewer_invert",
  /** length (mm above project zero): cover of the next upstream manhole, or the public sewer's overflow level (IPC 715.1). */
  sewerRim: "sewer_rim",
  /** choice: one of `ELEVATION_CONFIDENCES`. Absent: assumed. */
  confidence: "elevation_confidence",
  /** number (inches, nominal): the building drain / sewer size discharging here. */
  drainSize: "building_drain_size_in",
  /** number (in/ft): its slope. */
  drainSlope: "building_drain_slope_in_per_ft",
  /** length (mm): developed length of the building drain from the farthest floor it serves to this connection. */
  drainLength: "building_drain_length",
  /** length (mm): from a floor down to the drain invert under it (trap, fitting and cover). Absent: 0. */
  depthBelowFloor: "drain_depth_below_floor",
  /** number (gpm): the pump's rated flow at its rated head. */
  pumpRatedFlow: "pump_rated_gpm",
  /** number (ft of head): the head at which `pump_rated_gpm` is rated. */
  pumpRatedHead: "pump_rated_head_ft",
  /** number (gpm): the inflow the engineer designs for. Never derived from fixture units. */
  pumpInflow: "pump_inflow_gpm",
  /** number (ft of head): the total head the pump must lift against. */
  pumpHead: "pump_head_ft",
  /** boolean: a backwater valve protects what drains to this pump (6144: SGP-1 with a valve ahead of it). */
  backwaterValve: "backwater_valve",
} as const;

export interface BuildingDrainAtConnection {
  readonly nominalIn: number | null;
  readonly slopeInPerFt: number | null;
  readonly lengthMm: number | null;
}

/** A part whose role is `sewer_connection`, read. Every value may be missing; checks say which one they need. */
export interface SewerConnection {
  readonly id: ElementId;
  readonly label: string;
  readonly invertMm: number | null;
  readonly rimMm: number | null;
  /** Absent in the values: "assumed" (an elevation nobody said was measured is not verified). */
  readonly confidence: ElevationConfidence;
  /** True when the confidence was typed, false when it is the default. */
  readonly confidenceTyped: boolean;
  readonly drain: BuildingDrainAtConnection;
  readonly depthBelowFloorMm: number;
}

/** A part whose role is `sewage_pump` (ejector, grinder pump, lift station), read. */
export interface SewagePump {
  readonly id: ElementId;
  readonly label: string;
  readonly ratedGpm: number | null;
  readonly ratedHeadFt: number | null;
  readonly inflowGpm: number | null;
  readonly headFt: number | null;
  readonly backwaterValve: boolean;
}

/** What protects a drainage load, from the part it names as its source (`servedBy`). */
export interface DrainageProtection {
  /** It drains to a sewage pump (so it does not need gravity to reach the sewer). */
  readonly pumped: boolean;
  /** A backwater valve protects it (its source is a valve, or a pump with one). */
  readonly backwaterValve: boolean;
  readonly sourceId: ElementId | null;
}

/** The drainage loads on one floor. */
export interface DrainageFloor {
  readonly levelId: ElementId;
  readonly levelName: string;
  readonly floorMm: number;
  readonly loadIds: readonly ElementId[];
}

export type GravityVerdict = "gravity" | "needs_pump" | "unknown";
export type BackwaterVerdict = "below_rim" | "above_rim" | "unknown";

/** One floor against one sewer connection. */
export interface FloorAgainstSewer extends DrainageFloor {
  /** The highest drain invert this floor can have: floor less the depth to the drain. */
  readonly drainInvertMm: number;
  /** The lowest drain invert that still reaches the sewer by gravity, or null when the sewer invert is unknown. */
  readonly gravityLimitMm: number | null;
  readonly gravity: GravityVerdict;
  readonly backwater: BackwaterVerdict;
  /** Loads on this floor that need a pump and don't drain to one. */
  readonly needPump: readonly ElementId[];
  /** Loads on this floor below the rim with no backwater valve. */
  readonly needValve: readonly ElementId[];
  /** Loads above the rim that discharge through a backwater valve (IPC 715.1 says they must not). */
  readonly throughValveAboveRim: readonly ElementId[];
}
