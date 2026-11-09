import type { ReceptacleRules } from "./receptacle-rules";
import type { NecEdition } from "./pack";

/**
 * NEC 210.52 dwelling receptacle spacing, as data for the kernel's proposer
 * (packages/bim-kernel/src/propose). The distances did not change between
 * 2020 and 2023; islands and peninsulas did: 2020 asks for one per island or
 * peninsula, 2023 counts by area (one for the first 9 sq ft, one more per
 * 18 sq ft or fraction).
 *
 * The density presets are firm defaults for commercial open areas
 * (V4@3:07: light ≈ 25 ft, medium ≈ 15 ft, heavy ≈ 6 ft apart). They are not
 * code minimums and say so wherever they are shown, so density needs no code
 * edition (densityReceptacleRules). A firm or project can override any number
 * here; the engineer always picks the preset.
 */

const FT = 304.8;
const IN = 25.4;

export interface ReceptacleRuleOverrides {
  readonly wallMaxDistanceFt?: number;
  readonly countertopMaxDistanceIn?: number;
  readonly countersBreakWallSpace?: boolean;
  readonly presetSpacingFt?: Partial<Record<"light" | "medium" | "heavy", number>>;
  readonly heightsIn?: Partial<Record<"wall" | "countertop" | "island", number>>;
}

/** Firm defaults that are not code: density spacing, mounting heights, and the narrowest wall a density preset fills. */
const FIRM_DEFAULTS = {
  presetSpacingFt: { light: 25, medium: 15, heavy: 6 },
  heightsIn: { wall: 18, countertop: 42, island: 30 },
  densityMinWallFt: 2,
  /** Appliance receptacle marks that never count toward spacing. */
  applianceMarks: ["R.F", "R.DW", "R.GD", "R.M", "R.OV", "R.W", "R.D", "R.R"],
} as const;

function presetsAndHeights(overrides: ReceptacleRuleOverrides): Pick<ReceptacleRules, "presets" | "heights"> {
  const spacing = (k: "light" | "medium" | "heavy") => (overrides.presetSpacingFt?.[k] ?? FIRM_DEFAULTS.presetSpacingFt[k]) * FT;
  return {
    presets: {
      light: { spacingMm: spacing("light"), label: "Light (about 25 ft apart)" },
      medium: { spacingMm: spacing("medium"), label: "Medium (about 15 ft apart)" },
      heavy: { spacingMm: spacing("heavy"), label: "Heavy (about 6 ft apart)" },
    },
    heights: {
      wallMm: (overrides.heightsIn?.wall ?? FIRM_DEFAULTS.heightsIn.wall) * IN,
      countertopMm: (overrides.heightsIn?.countertop ?? FIRM_DEFAULTS.heightsIn.countertop) * IN,
      islandMm: (overrides.heightsIn?.island ?? FIRM_DEFAULTS.heightsIn.island) * IN,
    },
  };
}

export const NO_CODE_DENSITY = "Firm density preset; no code edition applied";

/**
 * Rules for density mode alone, with no code edition: the firm presets and
 * heights. The proposer reads only `presets`, `heights` and
 * `wall.minSpaceMm` in density mode; the 210.52 fields are filled so the
 * shape is whole and each says it was not applied.
 */
export function densityReceptacleRules(overrides: ReceptacleRuleOverrides = {}): ReceptacleRules {
  const notApplied = "NEC 210.52 not applied (density preset)";
  return {
    code: NO_CODE_DENSITY,
    wall: { maxDistanceMm: 0, minSpaceMm: FIRM_DEFAULTS.densityMinWallFt * FT, countersBreak: overrides.countersBreakWallSpace ?? true, cite: notApplied },
    countertop: { maxDistanceMm: 0, minSpaceMm: 0, cite: notApplied },
    island: { count: "one", firstAreaSqFt: 0, eachSqFt: 0, minLongMm: 0, minShortMm: 0, islandCite: notApplied, peninsulaCite: notApplied },
    bathroom: { maxFromBasinMm: 0, cite: notApplied },
    laundry: { cite: notApplied },
    hallway: { minLengthMm: 0, cite: notApplied },
    ...presetsAndHeights(overrides),
    roomWords: [],
    applianceMarks: FIRM_DEFAULTS.applianceMarks,
  };
}

export function receptaclePlacementRules(nec: NecEdition, overrides: ReceptacleRuleOverrides = {}): ReceptacleRules {
  const y = nec.edition;
  const c = (clause: string) => `NEC ${y} ${clause}`;
  const is2023 = y === "2023";
  const { presets, heights } = presetsAndHeights(overrides);
  return {
    code: `NEC ${y}`,
    wall: {
      maxDistanceMm: (overrides.wallMaxDistanceFt ?? 6) * FT,
      minSpaceMm: 2 * FT,
      countersBreak: overrides.countersBreakWallSpace ?? true,
      cite: c("210.52(A)(1)"),
    },
    countertop: { maxDistanceMm: (overrides.countertopMaxDistanceIn ?? 24) * IN, minSpaceMm: 12 * IN, cite: c("210.52(C)(1)") },
    island: is2023
      ? { count: "area", firstAreaSqFt: 9, eachSqFt: 18, minLongMm: 24 * IN, minShortMm: 12 * IN, islandCite: c("210.52(C)(2)"), peninsulaCite: c("210.52(C)(2)") }
      : { count: "one", firstAreaSqFt: 9, eachSqFt: 18, minLongMm: 24 * IN, minShortMm: 12 * IN, islandCite: c("210.52(C)(2)"), peninsulaCite: c("210.52(C)(3)") },
    bathroom: { maxFromBasinMm: 3 * FT, cite: c("210.52(D)") },
    laundry: { cite: c("210.52(F)") },
    hallway: { minLengthMm: 10 * FT, cite: c("210.52(H)") },
    presets,
    roomWords: [
      { rule: "bathroom", words: ["bath", "bathroom", "toilet", "powder", "wc", "restroom", "ensuite"] },
      { rule: "laundry", words: ["laundry", "washer", "w/d"] },
      { rule: "hallway", words: ["hall", "hallway", "corridor"] },
      { rule: "kitchen", words: ["kitchen", "kitchenette"] },
      { rule: "none", words: ["closet", "wic", "storage", "mech", "mechanical", "electrical", "pantry", "shaft", "chase", "stair"] },
      { rule: "general", words: ["living", "family", "dining", "bedroom", "bed", "den", "parlor", "library", "sunroom", "recreation", "office", "study", "great room", "foyer", "entry"] },
    ],
    applianceMarks: FIRM_DEFAULTS.applianceMarks,
    heights,
  };
}
