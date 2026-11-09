/**
 * The shape of a room-spacing rule set (moved out of the kernel in round 8:
 * it is code data, not a kernel concept). The NEC 210.52 numbers that fill it
 * are in `receptacle-placement.ts`; firm overrides go on top. The Electrical
 * add-on's proposer applies it.
 */

/** How a room is treated. The proposer guesses from the name; the engineer can change it per room. */
export const ROOM_RULES = ["general", "kitchen", "bathroom", "laundry", "hallway", "none"] as const;
export type RoomRule = (typeof ROOM_RULES)[number];

export const DENSITY_PRESETS = ["light", "medium", "heavy"] as const;
export type DensityPreset = (typeof DENSITY_PRESETS)[number];

/**
 * The spacing rules a proposal runs on. The numbers live in a code pack
 * (`@permitzip/bim-calc` NEC 210.52 data, firm overrides on top); the kernel
 * only applies them.
 */
export interface ReceptacleRules {
  /** "NEC 2023". */
  readonly code: string;
  readonly wall: {
    /** No point along the floor line more than this from a receptacle (6 ft). */
    readonly maxDistanceMm: number;
    /** Wall space narrower than this needs none (2 ft). */
    readonly minSpaceMm: number;
    /** Fixed cabinets, counters and fixed appliances against a wall (range, refrigerator, washer, dryer) break wall space: the firm's reading; NEC text names only cabinets without a work surface. */
    readonly countersBreak: boolean;
    readonly cite: string;
  };
  readonly countertop: {
    /** No point along the wall line more than this from a receptacle (24 in). */
    readonly maxDistanceMm: number;
    /** Countertop space narrower than this needs none (12 in). */
    readonly minSpaceMm: number;
    readonly cite: string;
  };
  readonly island: {
    /** "one": one per island (2020). "area": one for the first `firstAreaSqFt`, one more per `eachSqFt` (2023). */
    readonly count: "one" | "area";
    readonly firstAreaSqFt: number;
    readonly eachSqFt: number;
    /** Smallest island or peninsula that needs one: long × short side (24 × 12 in). */
    readonly minLongMm: number;
    readonly minShortMm: number;
    readonly islandCite: string;
    readonly peninsulaCite: string;
  };
  readonly bathroom: { readonly maxFromBasinMm: number; readonly cite: string };
  readonly laundry: { readonly cite: string };
  readonly hallway: { readonly minLengthMm: number; readonly cite: string };
  /** Commercial open-area spacing the engineer picks ("medium" ≈ 15 ft apart). Not a code minimum. */
  readonly presets: Readonly<Record<DensityPreset, { readonly spacingMm: number; readonly label: string }>>;
  /** Room names → rule, first match wins (whole words, case-insensitive). */
  readonly roomWords: readonly { readonly rule: RoomRule; readonly words: readonly string[] }[];
  /** Marks of appliance receptacles that never count ("R.F", "R.DW"). */
  readonly applianceMarks: readonly string[];
  /** Default mounting heights above the floor. */
  readonly heights: { readonly wallMm: number; readonly countertopMm: number; readonly islandMm: number };
}
