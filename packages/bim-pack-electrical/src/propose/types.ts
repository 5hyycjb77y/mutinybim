import type { RoomRule, DensityPreset } from "@permitzip/bim-calc";
import type { Vec2 } from "@permitzip/bim-kernel";

export type { ReceptacleRules, RoomRule, DensityPreset } from "@permitzip/bim-calc";
export { ROOM_RULES, DENSITY_PRESETS } from "@permitzip/bim-calc";

/**
 * The receptacle proposer's answer (moved out of the kernel in round 8; the
 * kernel keeps only the generic proposer shapes). Lengths are millimetres in
 * plan coordinates.
 */

export type ProposedKind = "wall" | "countertop" | "island" | "peninsula" | "bathroom" | "laundry" | "hallway" | "density";

/** One proposed device: where, which engineer-chosen type, and the rule that put it there. */
export interface ProposedDevice {
  /** Stable within a proposal: `<roomId>#<kind>-<n>`. */
  readonly key: string;
  readonly roomId: string;
  readonly kind: ProposedKind;
  readonly typeId: string;
  readonly position: Vec2;
  /** Faces into the room (the wall's direction, counter-clockwise from east). */
  readonly rotationDeg: number;
  readonly heightMm: number;
  /** Plain words: "Wall space 14' 2" from the door: 2 receptacles, none more than 6 ft from a point on the wall". */
  readonly reason: string;
  readonly cite: string;
}

/** One stretch of wall or countertop that a rule covers, and whether it is covered. */
export interface CoverageRun {
  readonly kind: "wall" | "countertop" | "density";
  readonly from: number;
  readonly to: number;
  /** The whole perimeter with no break (a closed run). */
  readonly closed: boolean;
  readonly lengthMm: number;
  /** Furthest any point of the run is from a receptacle already there, before the proposal (along the floor or wall line). Infinity with none. */
  readonly worstBeforeMm: number;
  /** The same with every proposed receptacle added. */
  readonly worstMm: number;
  readonly limitMm: number;
  readonly passes: boolean;
}

export interface RoomProposal {
  readonly roomId: string;
  readonly label: string;
  readonly rule: RoomRule;
  /** Why this rule: "name has 'kitchen'", or "you chose it". */
  readonly ruleBasis: string;
  readonly devices: readonly ProposedDevice[];
  /** Coverage with the existing receptacles and every proposed one. */
  readonly runs: readonly CoverageRun[];
  readonly passes: boolean;
  readonly notes: readonly string[];
}

export interface ReceptacleProposal {
  readonly mode: "dwelling" | "density";
  readonly preset: DensityPreset | null;
  readonly code: string;
  readonly rooms: readonly RoomProposal[];
  readonly devices: readonly ProposedDevice[];
  readonly passes: boolean;
  /** "12 receptacles in 3 rooms; every point of wall space within 6 ft: passes". */
  readonly summary: string;
}
