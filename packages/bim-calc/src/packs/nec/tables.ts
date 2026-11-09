import type { ConductorSize } from "./sizes";

/**
 * NEC table values as data. Numbers and table numbers only; no code prose
 * (NFPA 70 text is copyrighted). Every table carries a source note saying
 * where it was transcribed from and what it was cross-checked against.
 * These values are identical in the 2020 and 2023 editions (the editions
 * differ in some clause and table numbers, which live in pack.ts).
 *
 * Never fill a gap by estimate: a size or row the table doesn't list is
 * absent here, and calculations report it as not tabulated.
 */

export interface TableSource {
  readonly table: string;
  readonly note: string;
}

const TRANSCRIBED = "Transcribed 2026-10-21";

// ------------------------------------------------------------------ Table 310.16

/** [60°C, 75°C, 90°C] allowable ampacity; null where the table has a dash. */
export type TempColumns = readonly [number | null, number | null, number | null];

export interface AmpacityRow {
  readonly copper: TempColumns;
  readonly aluminum: TempColumns;
}

export const AMPACITY_310_16: Readonly<Record<ConductorSize, AmpacityRow>> = {
  "14": { copper: [15, 20, 25], aluminum: [null, null, null] },
  "12": { copper: [20, 25, 30], aluminum: [15, 20, 25] },
  "10": { copper: [30, 35, 40], aluminum: [25, 30, 35] },
  "8": { copper: [40, 50, 55], aluminum: [35, 40, 45] },
  "6": { copper: [55, 65, 75], aluminum: [40, 50, 55] },
  "4": { copper: [70, 85, 95], aluminum: [55, 65, 75] },
  "3": { copper: [85, 100, 115], aluminum: [65, 75, 85] },
  "2": { copper: [95, 115, 130], aluminum: [75, 90, 100] },
  "1": { copper: [110, 130, 145], aluminum: [85, 100, 115] },
  "1/0": { copper: [125, 150, 170], aluminum: [100, 120, 135] },
  "2/0": { copper: [145, 175, 195], aluminum: [115, 135, 150] },
  "3/0": { copper: [165, 200, 225], aluminum: [130, 155, 175] },
  "4/0": { copper: [195, 230, 260], aluminum: [150, 180, 205] },
  "250": { copper: [215, 255, 290], aluminum: [170, 205, 230] },
  "300": { copper: [240, 285, 320], aluminum: [195, 230, 260] },
  "350": { copper: [260, 310, 350], aluminum: [210, 250, 280] },
  "400": { copper: [280, 335, 380], aluminum: [225, 270, 305] },
  "500": { copper: [320, 380, 430], aluminum: [260, 310, 350] },
  "600": { copper: [350, 420, 475], aluminum: [285, 340, 385] },
  "700": { copper: [385, 460, 520], aluminum: [315, 375, 425] },
  "750": { copper: [400, 475, 535], aluminum: [320, 385, 435] },
  "800": { copper: [410, 490, 555], aluminum: [330, 395, 445] },
  "900": { copper: [435, 520, 585], aluminum: [355, 425, 480] },
  "1000": { copper: [455, 545, 615], aluminum: [375, 445, 500] },
  "1250": { copper: [495, 590, 665], aluminum: [405, 485, 545] },
  "1500": { copper: [525, 625, 705], aluminum: [435, 520, 585] },
  "1750": { copper: [545, 650, 735], aluminum: [455, 545, 615] },
  "2000": { copper: [555, 665, 750], aluminum: [470, 560, 630] },
};

// ------------------------------------------------------------------ ambient correction (30°C base) and more than three CCCs

export interface AmbientRow {
  /** Upper end of the row's range, °C (rows are 10 or less, 11–15, …, 81–85). */
  readonly maxC: number;
  readonly factors: TempColumns;
}

export const AMBIENT_CORRECTION_30C: readonly AmbientRow[] = [
  { maxC: 10, factors: [1.29, 1.2, 1.15] },
  { maxC: 15, factors: [1.22, 1.15, 1.12] },
  { maxC: 20, factors: [1.15, 1.11, 1.08] },
  { maxC: 25, factors: [1.08, 1.05, 1.04] },
  { maxC: 30, factors: [1.0, 1.0, 1.0] },
  { maxC: 35, factors: [0.91, 0.94, 0.96] },
  { maxC: 40, factors: [0.82, 0.88, 0.91] },
  { maxC: 45, factors: [0.71, 0.82, 0.87] },
  { maxC: 50, factors: [0.58, 0.75, 0.82] },
  { maxC: 55, factors: [0.41, 0.67, 0.76] },
  { maxC: 60, factors: [null, 0.58, 0.71] },
  { maxC: 65, factors: [null, 0.47, 0.65] },
  { maxC: 70, factors: [null, 0.33, 0.58] },
  { maxC: 75, factors: [null, null, 0.5] },
  { maxC: 80, factors: [null, null, 0.41] },
  { maxC: 85, factors: [null, null, 0.29] },
];

export const CCC_ADJUSTMENT: ReadonlyArray<{ readonly maxConductors: number; readonly pct: number }> = [
  { maxConductors: 3, pct: 100 },
  { maxConductors: 6, pct: 80 },
  { maxConductors: 9, pct: 70 },
  { maxConductors: 20, pct: 50 },
  { maxConductors: 30, pct: 45 },
  { maxConductors: 40, pct: 40 },
  { maxConductors: Number.POSITIVE_INFINITY, pct: 35 },
];

// ------------------------------------------------------------------ overcurrent protection

/** 240.4(D): the most overcurrent protection the small conductors may have. */
export const SMALL_CONDUCTOR_MAX_OCPD: Readonly<Record<"copper" | "aluminum", Readonly<Partial<Record<ConductorSize, number>>>>> = {
  copper: { "14": 15, "12": 20, "10": 30 },
  aluminum: { "12": 15, "10": 25 },
};

/** 240.6(A) standard ampere ratings for fuses and inverse time circuit breakers. */
export const STANDARD_OCPD_RATINGS: readonly number[] = [
  15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500, 600, 700, 800, 1000, 1200, 1600, 2000, 2500, 3000, 4000,
  5000, 6000,
];

/** 240.6(A): the additional standard ratings for fuses only. */
export const ADDITIONAL_FUSE_RATINGS: readonly number[] = [1, 3, 6, 10, 601];

/** 240.4(B): the next-higher-rating allowance stops at 800 A. */
export const NEXT_SIZE_UP_MAX_A = 800;

// ------------------------------------------------------------------ Table 250.122

export interface EgcRow {
  /** Rating or setting of the overcurrent device ahead of the equipment, not exceeding. */
  readonly ocpdMaxA: number;
  readonly copper: ConductorSize;
  readonly aluminum: ConductorSize;
}

export const EGC_250_122: readonly EgcRow[] = [
  { ocpdMaxA: 15, copper: "14", aluminum: "12" },
  { ocpdMaxA: 20, copper: "12", aluminum: "10" },
  { ocpdMaxA: 60, copper: "10", aluminum: "8" },
  { ocpdMaxA: 100, copper: "8", aluminum: "6" },
  { ocpdMaxA: 200, copper: "6", aluminum: "4" },
  { ocpdMaxA: 300, copper: "4", aluminum: "2" },
  { ocpdMaxA: 400, copper: "3", aluminum: "1" },
  { ocpdMaxA: 500, copper: "2", aluminum: "1/0" },
  { ocpdMaxA: 600, copper: "1", aluminum: "2/0" },
  { ocpdMaxA: 800, copper: "1/0", aluminum: "3/0" },
  { ocpdMaxA: 1000, copper: "2/0", aluminum: "4/0" },
  { ocpdMaxA: 1200, copper: "3/0", aluminum: "250" },
  { ocpdMaxA: 1600, copper: "4/0", aluminum: "350" },
  { ocpdMaxA: 2000, copper: "250", aluminum: "400" },
  { ocpdMaxA: 2500, copper: "350", aluminum: "600" },
  { ocpdMaxA: 3000, copper: "400", aluminum: "600" },
  { ocpdMaxA: 4000, copper: "500", aluminum: "750" },
  { ocpdMaxA: 5000, copper: "700", aluminum: "1250" },
  { ocpdMaxA: 6000, copper: "800", aluminum: "1250" },
];

// ------------------------------------------------------------------ Chapter 9, Table 8 (circular mils)

export const CIRCULAR_MILS: Readonly<Record<ConductorSize, number>> = {
  "14": 4110,
  "12": 6530,
  "10": 10380,
  "8": 16510,
  "6": 26240,
  "4": 41740,
  "3": 52620,
  "2": 66360,
  "1": 83690,
  "1/0": 105600,
  "2/0": 133100,
  "3/0": 167800,
  "4/0": 211600,
  "250": 250000,
  "300": 300000,
  "350": 350000,
  "400": 400000,
  "500": 500000,
  "600": 600000,
  "700": 700000,
  "750": 750000,
  "800": 800000,
  "900": 900000,
  "1000": 1000000,
  "1250": 1250000,
  "1500": 1500000,
  "1750": 1750000,
  "2000": 2000000,
};

// ------------------------------------------------------------------ Chapter 9, Table 9 (AC resistance and reactance, Ω to neutral per 1000 ft)

/** Table 9 groups raceways as PVC, aluminum, and steel (EMT, IMC, RMC are steel). */
export type Table9Raceway = "pvc" | "aluminum" | "steel";

export interface Table9Row {
  /** XL: [PVC and aluminum conduit, steel conduit]. */
  readonly xl: readonly [number, number];
  /** AC resistance, uncoated copper: [PVC, aluminum, steel]. */
  readonly rCopper: readonly [number, number, number];
  /** AC resistance, aluminum: [PVC, aluminum, steel]; null where the table has a dash. */
  readonly rAluminum: readonly [number, number, number] | null;
}

/** 700, 800 and 900 kcmil, and sizes over 1000 kcmil, are not in Table 9. */
export const TABLE_9: Readonly<Partial<Record<ConductorSize, Table9Row>>> = {
  "14": { xl: [0.058, 0.073], rCopper: [3.1, 3.1, 3.1], rAluminum: null },
  "12": { xl: [0.054, 0.068], rCopper: [2.0, 2.0, 2.0], rAluminum: [3.2, 3.2, 3.2] },
  "10": { xl: [0.05, 0.063], rCopper: [1.2, 1.2, 1.2], rAluminum: [2.0, 2.0, 2.0] },
  "8": { xl: [0.052, 0.065], rCopper: [0.78, 0.78, 0.78], rAluminum: [1.3, 1.3, 1.3] },
  "6": { xl: [0.051, 0.064], rCopper: [0.49, 0.49, 0.49], rAluminum: [0.81, 0.81, 0.81] },
  "4": { xl: [0.048, 0.06], rCopper: [0.31, 0.31, 0.31], rAluminum: [0.51, 0.51, 0.51] },
  "3": { xl: [0.047, 0.059], rCopper: [0.25, 0.25, 0.25], rAluminum: [0.4, 0.41, 0.4] },
  "2": { xl: [0.045, 0.057], rCopper: [0.19, 0.2, 0.2], rAluminum: [0.32, 0.32, 0.32] },
  "1": { xl: [0.046, 0.057], rCopper: [0.15, 0.16, 0.16], rAluminum: [0.25, 0.26, 0.25] },
  "1/0": { xl: [0.044, 0.055], rCopper: [0.12, 0.13, 0.12], rAluminum: [0.2, 0.21, 0.2] },
  "2/0": { xl: [0.043, 0.054], rCopper: [0.1, 0.1, 0.1], rAluminum: [0.16, 0.16, 0.16] },
  "3/0": { xl: [0.042, 0.052], rCopper: [0.077, 0.082, 0.079], rAluminum: [0.13, 0.13, 0.13] },
  "4/0": { xl: [0.041, 0.051], rCopper: [0.062, 0.067, 0.063], rAluminum: [0.1, 0.11, 0.1] },
  "250": { xl: [0.041, 0.052], rCopper: [0.052, 0.057, 0.054], rAluminum: [0.085, 0.09, 0.086] },
  "300": { xl: [0.041, 0.051], rCopper: [0.044, 0.049, 0.045], rAluminum: [0.071, 0.076, 0.072] },
  "350": { xl: [0.04, 0.05], rCopper: [0.038, 0.043, 0.039], rAluminum: [0.061, 0.066, 0.063] },
  "400": { xl: [0.04, 0.049], rCopper: [0.033, 0.038, 0.035], rAluminum: [0.054, 0.059, 0.055] },
  "500": { xl: [0.039, 0.048], rCopper: [0.027, 0.032, 0.029], rAluminum: [0.043, 0.048, 0.045] },
  "600": { xl: [0.039, 0.048], rCopper: [0.023, 0.028, 0.025], rAluminum: [0.036, 0.041, 0.038] },
  "750": { xl: [0.038, 0.048], rCopper: [0.019, 0.024, 0.021], rAluminum: [0.029, 0.034, 0.031] },
  "1000": { xl: [0.037, 0.046], rCopper: [0.015, 0.019, 0.018], rAluminum: [0.023, 0.027, 0.025] },
};

// ------------------------------------------------------------------ Chapter 9, Tables 1, 4 and 5 (conduit fill)

export type ConduitType = "emt" | "pvc40" | "pvc80";

export interface ConduitSize {
  readonly tradeSize: string;
  readonly metric: number;
  /** Total internal area (100%), in². */
  readonly totalIn2: number;
  /** The table's printed 40% column, in². */
  readonly fill40In2: number;
}

export const CONDUIT_AREAS: Readonly<Record<ConduitType, readonly ConduitSize[]>> = {
  emt: [
    { tradeSize: "1/2", metric: 16, totalIn2: 0.304, fill40In2: 0.122 },
    { tradeSize: "3/4", metric: 21, totalIn2: 0.533, fill40In2: 0.213 },
    { tradeSize: "1", metric: 27, totalIn2: 0.864, fill40In2: 0.346 },
    { tradeSize: "1-1/4", metric: 35, totalIn2: 1.496, fill40In2: 0.598 },
    { tradeSize: "1-1/2", metric: 41, totalIn2: 2.036, fill40In2: 0.814 },
    { tradeSize: "2", metric: 53, totalIn2: 3.356, fill40In2: 1.342 },
    { tradeSize: "2-1/2", metric: 63, totalIn2: 5.858, fill40In2: 2.343 },
    { tradeSize: "3", metric: 78, totalIn2: 8.846, fill40In2: 3.538 },
    { tradeSize: "3-1/2", metric: 91, totalIn2: 11.545, fill40In2: 4.618 },
    { tradeSize: "4", metric: 103, totalIn2: 14.753, fill40In2: 5.901 },
  ],
  pvc40: [
    { tradeSize: "1/2", metric: 16, totalIn2: 0.285, fill40In2: 0.114 },
    { tradeSize: "3/4", metric: 21, totalIn2: 0.508, fill40In2: 0.203 },
    { tradeSize: "1", metric: 27, totalIn2: 0.832, fill40In2: 0.333 },
    { tradeSize: "1-1/4", metric: 35, totalIn2: 1.453, fill40In2: 0.581 },
    { tradeSize: "1-1/2", metric: 41, totalIn2: 1.986, fill40In2: 0.794 },
    { tradeSize: "2", metric: 53, totalIn2: 3.291, fill40In2: 1.316 },
    { tradeSize: "2-1/2", metric: 63, totalIn2: 4.695, fill40In2: 1.878 },
    { tradeSize: "3", metric: 78, totalIn2: 7.268, fill40In2: 2.907 },
    { tradeSize: "3-1/2", metric: 91, totalIn2: 9.737, fill40In2: 3.895 },
    { tradeSize: "4", metric: 103, totalIn2: 12.554, fill40In2: 5.022 },
    { tradeSize: "5", metric: 129, totalIn2: 19.761, fill40In2: 7.904 },
    { tradeSize: "6", metric: 155, totalIn2: 28.567, fill40In2: 11.427 },
  ],
  pvc80: [
    { tradeSize: "1/2", metric: 16, totalIn2: 0.217, fill40In2: 0.087 },
    { tradeSize: "3/4", metric: 21, totalIn2: 0.409, fill40In2: 0.164 },
    { tradeSize: "1", metric: 27, totalIn2: 0.688, fill40In2: 0.275 },
    { tradeSize: "1-1/4", metric: 35, totalIn2: 1.237, fill40In2: 0.495 },
    { tradeSize: "1-1/2", metric: 41, totalIn2: 1.711, fill40In2: 0.684 },
    { tradeSize: "2", metric: 53, totalIn2: 2.874, fill40In2: 1.15 },
    { tradeSize: "2-1/2", metric: 63, totalIn2: 4.119, fill40In2: 1.647 },
    { tradeSize: "3", metric: 78, totalIn2: 6.442, fill40In2: 2.577 },
    { tradeSize: "3-1/2", metric: 91, totalIn2: 8.688, fill40In2: 3.475 },
    { tradeSize: "4", metric: 103, totalIn2: 11.258, fill40In2: 4.503 },
    { tradeSize: "5", metric: 129, totalIn2: 17.855, fill40In2: 7.142 },
    { tradeSize: "6", metric: 155, totalIn2: 25.598, fill40In2: 10.239 },
  ],
};

/** Raceway material group Table 9 reads for each conduit type. */
export const CONDUIT_TABLE9_RACEWAY: Readonly<Record<ConduitType, Table9Raceway>> = { emt: "steel", pvc40: "pvc", pvc80: "pvc" };

/** Chapter 9, Table 1: percent of cross section for 1, 2, and over 2 conductors. */
export const FILL_PERCENT = { one: 53, two: 31, overTwo: 40 } as const;

export type InsulationType = "THHN" | "XHHW-2";

/** Chapter 9, Table 5 approximate areas, in². THHN covers THHN, THWN and THWN-2. */
export const CONDUCTOR_AREAS: Readonly<Record<InsulationType, Readonly<Partial<Record<ConductorSize, number>>>>> = {
  THHN: {
    "14": 0.0097,
    "12": 0.0133,
    "10": 0.0211,
    "8": 0.0366,
    "6": 0.0507,
    "4": 0.0824,
    "3": 0.0973,
    "2": 0.1158,
    "1": 0.1562,
    "1/0": 0.1855,
    "2/0": 0.2223,
    "3/0": 0.2679,
    "4/0": 0.3237,
    "250": 0.397,
    "300": 0.4608,
    "350": 0.5242,
    "400": 0.5863,
    "500": 0.7073,
    "600": 0.8676,
    "700": 0.9887,
    "750": 1.0496,
    "800": 1.1085,
    "900": 1.2311,
    "1000": 1.3478,
  },
  "XHHW-2": {
    "14": 0.0139,
    "12": 0.0181,
    "10": 0.0243,
    "8": 0.0437,
    "6": 0.059,
    "4": 0.0814,
    "3": 0.0962,
    "2": 0.1146,
    "1": 0.1534,
    "1/0": 0.1825,
    "2/0": 0.219,
    "3/0": 0.2642,
    "4/0": 0.3197,
    "250": 0.3904,
    "300": 0.4536,
    "350": 0.5166,
    "400": 0.5782,
    "500": 0.6984,
    "600": 0.8709,
    "700": 0.9923,
    "750": 1.0532,
    "800": 1.1122,
    "900": 1.2351,
    "1000": 1.3519,
    "1250": 1.718,
    "1500": 2.0156,
    "1750": 2.3127,
    "2000": 2.6073,
  },
};

/** Temperature rating of each insulation type (Table 310.4(1)): THHN and XHHW-2 are 90°C dry (THWN-2 and XHHW-2 also wet). */
export const INSULATION_TEMP_C: Readonly<Record<InsulationType, 90>> = { THHN: 90, "XHHW-2": 90 };

// ------------------------------------------------------------------ Article 220 demand factors

export interface DemandStep {
  /** Applies to the portion of the load up to this many VA (cumulative). */
  readonly upToVa: number;
  readonly factor: number;
}

export type LightingOccupancy = "dwelling" | "hospital" | "hotel" | "warehouse" | "other";

/** General lighting demand factors (2020 Table 220.42 / 2023 Table 220.45). Hotels and motels include apartment houses without provision for cooking by tenants. */
export const LIGHTING_DEMAND: Readonly<Record<LightingOccupancy, readonly DemandStep[]>> = {
  dwelling: [
    { upToVa: 3000, factor: 1 },
    { upToVa: 120000, factor: 0.35 },
    { upToVa: Number.POSITIVE_INFINITY, factor: 0.25 },
  ],
  hospital: [
    { upToVa: 50000, factor: 0.4 },
    { upToVa: Number.POSITIVE_INFINITY, factor: 0.2 },
  ],
  hotel: [
    { upToVa: 20000, factor: 0.5 },
    { upToVa: 100000, factor: 0.4 },
    { upToVa: Number.POSITIVE_INFINITY, factor: 0.3 },
  ],
  warehouse: [
    { upToVa: 12500, factor: 1 },
    { upToVa: Number.POSITIVE_INFINITY, factor: 0.5 },
  ],
  other: [{ upToVa: Number.POSITIVE_INFINITY, factor: 1 }],
};

/** Non-dwelling receptacle demand factors (2020 Table 220.44 / 2023 Table 220.47). */
export const RECEPTACLE_DEMAND: readonly DemandStep[] = [
  { upToVa: 10000, factor: 1 },
  { upToVa: Number.POSITIVE_INFINITY, factor: 0.5 },
];

/** Table 220.56: kitchen equipment other than dwelling units, by number of units. */
export const KITCHEN_DEMAND: ReadonlyArray<{ readonly minUnits: number; readonly factor: number }> = [
  { minUnits: 6, factor: 0.65 },
  { minUnits: 5, factor: 0.7 },
  { minUnits: 4, factor: 0.8 },
  { minUnits: 3, factor: 0.9 },
  { minUnits: 1, factor: 1 },
];

/** 430.24: the largest motor's full-load current counts at 125%. */
export const LARGEST_MOTOR_EXTRA = 0.25;
/** 210.19(A), 210.20(A), 215.2(A)(1), 215.3: continuous load at 125%. */
export const CONTINUOUS_FACTOR = 1.25;

// ------------------------------------------------------------------ motors (Article 430)

/** Horsepower as written in the motor tables, and its value. */
export interface MotorHpRow {
  readonly hp: string;
  readonly value: number;
}

/** Table 430.248: full-load current, single-phase AC motors, at 115, 200, 208 and 230 V. */
export const MOTOR_FLC_1PH_VOLTS = [115, 200, 208, 230] as const;
export const MOTOR_FLC_1PH: ReadonlyArray<MotorHpRow & { readonly amps: readonly [number, number, number, number] }> = [
  { hp: "1/6", value: 1 / 6, amps: [4.4, 2.5, 2.4, 2.2] },
  { hp: "1/4", value: 0.25, amps: [5.8, 3.3, 3.2, 2.9] },
  { hp: "1/3", value: 1 / 3, amps: [7.2, 4.1, 4.0, 3.6] },
  { hp: "1/2", value: 0.5, amps: [9.8, 5.6, 5.4, 4.9] },
  { hp: "3/4", value: 0.75, amps: [13.8, 7.9, 7.6, 6.9] },
  { hp: "1", value: 1, amps: [16, 9.2, 8.8, 8] },
  { hp: "1-1/2", value: 1.5, amps: [20, 11.5, 11, 10] },
  { hp: "2", value: 2, amps: [24, 13.8, 13.2, 12] },
  { hp: "3", value: 3, amps: [34, 19.6, 18.7, 17] },
  { hp: "5", value: 5, amps: [56, 32.2, 30.8, 28] },
  { hp: "7-1/2", value: 7.5, amps: [80, 46, 44, 40] },
  { hp: "10", value: 10, amps: [100, 57.5, 55, 50] },
];

/** Table 430.250: full-load current, three-phase induction motors (squirrel cage and wound rotor), at 200, 208, 230, 460 and 575 V. Null: not listed. */
export const MOTOR_FLC_3PH_VOLTS = [200, 208, 230, 460, 575] as const;
export const MOTOR_FLC_3PH: ReadonlyArray<MotorHpRow & { readonly amps: readonly [number | null, number | null, number | null, number, number] }> = [
  { hp: "1/2", value: 0.5, amps: [2.5, 2.4, 2.2, 1.1, 0.9] },
  { hp: "3/4", value: 0.75, amps: [3.7, 3.5, 3.2, 1.6, 1.3] },
  { hp: "1", value: 1, amps: [4.8, 4.6, 4.2, 2.1, 1.7] },
  { hp: "1-1/2", value: 1.5, amps: [6.9, 6.6, 6, 3, 2.4] },
  { hp: "2", value: 2, amps: [7.8, 7.5, 6.8, 3.4, 2.7] },
  { hp: "3", value: 3, amps: [11, 10.6, 9.6, 4.8, 3.9] },
  { hp: "5", value: 5, amps: [17.5, 16.7, 15.2, 7.6, 6.1] },
  { hp: "7-1/2", value: 7.5, amps: [25.3, 24.2, 22, 11, 9] },
  { hp: "10", value: 10, amps: [32.2, 30.8, 28, 14, 11] },
  { hp: "15", value: 15, amps: [48.3, 46.2, 42, 21, 17] },
  { hp: "20", value: 20, amps: [62.1, 59.4, 54, 27, 22] },
  { hp: "25", value: 25, amps: [78.2, 74.8, 68, 34, 27] },
  { hp: "30", value: 30, amps: [92, 88, 80, 40, 32] },
  { hp: "40", value: 40, amps: [120, 114, 104, 52, 41] },
  { hp: "50", value: 50, amps: [150, 143, 130, 65, 52] },
  { hp: "60", value: 60, amps: [177, 169, 154, 77, 62] },
  { hp: "75", value: 75, amps: [221, 211, 192, 96, 77] },
  { hp: "100", value: 100, amps: [285, 273, 248, 124, 99] },
  { hp: "125", value: 125, amps: [359, 343, 312, 156, 125] },
  { hp: "150", value: 150, amps: [414, 396, 360, 180, 144] },
  { hp: "200", value: 200, amps: [552, 528, 480, 240, 192] },
  { hp: "250", value: 250, amps: [null, null, null, 302, 242] },
  { hp: "300", value: 300, amps: [null, null, null, 361, 289] },
  { hp: "350", value: 350, amps: [null, null, null, 414, 336] },
  { hp: "400", value: 400, amps: [null, null, null, 477, 382] },
  { hp: "450", value: 450, amps: [null, null, null, 515, 412] },
  { hp: "500", value: 500, amps: [null, null, null, 590, 472] },
];

/** Table 430.52: maximum branch-circuit short-circuit and ground-fault protective device, percent of full-load current (squirrel-cage motors other than Design B energy-efficient). */
export const MOTOR_OCPD_PERCENT = { inverse_time_breaker: 250, dual_element_fuse: 175, nontime_delay_fuse: 300, instantaneous_breaker: 800 } as const;
export type MotorOcpdDevice = keyof typeof MOTOR_OCPD_PERCENT;

/** 430.22: a single motor's branch-circuit conductors carry at least 125% of its full-load current. */
export const MOTOR_CONDUCTOR_FACTOR = 1.25;

/** 310.10(G)(1): conductors 1/0 AWG and larger may be run in parallel. */
export const PARALLEL_MIN_SIZE = "1/0";

// ------------------------------------------------------------------ sources

export const SOURCES: Readonly<Record<string, TableSource>> = {
  ampacity: {
    table: "310.16",
    note: `${TRANSCRIBED} from NFPA 70 (2023) Table 310.16 as extracted in NFPA's "Using the NEC Ampacity Charts" fact sheet; cross-checked cell by cell against an independent NEC 2023 transcription (loomi.fyi). Table 310.16 values are the same in the 2020 edition.`,
  },
  ambient: {
    table: "310.15(B)(1) (2020) / 310.15(B)(1)(1) (2023)",
    note: `${TRANSCRIBED} from the same NFPA fact sheet (2023 Table 310.15(B)(1)(1)); 2020 Table 310.15(B)(1) has the same factors (2023 renamed it). Rows are integer °C ranges; a fractional ambient takes the next row up.`,
  },
  ccc: { table: "310.15(C)(1)", note: `${TRANSCRIBED} from the NFPA fact sheet; same in 2020 and 2023.` },
  smallConductor: { table: "240.4(D)", note: `${TRANSCRIBED}; 14/12/10 AWG copper at 15/20/30 A, 12/10 AWG aluminum at 15/25 A.` },
  standardRatings: { table: "240.6(A)", note: `${TRANSCRIBED}; fixed-trip breaker and fuse standard ratings, plus 1, 3, 6, 10 and 601 A fuses.` },
  egc: {
    table: "250.122",
    note: `${TRANSCRIBED}; cross-checked against the NFPA Research Foundation EGC literature review (tables for the 2011–2023 editions) and two independent transcriptions. Since 2020 the aluminum EGC for 5000 A and 6000 A is 1250 kcmil (was 1200 kcmil); several web copies still show 1200.`,
  },
  circularMils: { table: "Chapter 9, Table 8", note: `${TRANSCRIBED}; AWG areas in circular mils, kcmil sizes at their nominal area.` },
  table9: {
    table: "Chapter 9, Table 9",
    note: `${TRANSCRIBED} from an NEC 2023 transcription (loomi.fyi) and cross-checked against a scan of the printed table (lorisweb.com). Ω to neutral per 1000 ft, 75°C, three single conductors in conduit, 60 Hz. Ze = R x PF + XL x sin(arccos PF) per Note 2. 700, 800, 900 and over 1000 kcmil are not in the table.`,
  },
  conduit: {
    table: "Chapter 9, Table 4",
    note: `${TRANSCRIBED}: EMT and PVC Schedule 40 to 2 in from an NEC 2023 transcription (loomi.fyi), PVC 40 above 2 in and PVC 80 from two independent transcriptions that agree (tradesmanmath.com, concretecalculate.com), all matching the 2017 printed table scan (lorisweb.com) where it overlaps.`,
  },
  conductorArea: { table: "Chapter 9, Table 5", note: `${TRANSCRIBED} from an NEC 2023 transcription (loomi.fyi); THHN, THWN, THWN-2 and XHHW, XHHW-2.` },
  fill: { table: "Chapter 9, Table 1", note: `${TRANSCRIBED}; 53% one conductor, 31% two, 40% over two.` },
  lighting: {
    table: "220.42 (2020) / 220.45 (2023)",
    note: `${TRANSCRIBED}; the 2023 edition moved the general lighting demand table from 220.42 to 220.45 with the same factors (crosswalk: OpenExamPrep NEC 2020/2023 Article 220 table, electricallicenserenewal.com 2023 change summary).`,
  },
  receptacle: { table: "220.44 (2020) / 220.47 (2023)", note: `${TRANSCRIBED}; first 10 kVA at 100%, remainder at 50%; moved from 220.44 to 220.47 in 2023 (UpCodes 2023 text).` },
  kitchen: { table: "220.56", note: `${TRANSCRIBED}; same in 2017, 2020 and 2023 (2023 table checked in the NFPA free-access text); not less than the sum of the two largest kitchen equipment loads.` },
  motorFlc: {
    table: "430.248 / 430.250",
    note: "Transcribed 2026-10-22 from the NFPA 70 (2023) free-access text; the same values in 2017 and 2020. Single-phase at 115/200/208/230 V; three-phase induction at 200/208/230/460/575 V (the 115 V and 2300 V columns and synchronous motors are not carried). 430.6(A)(1): 110–120 V uses 115, 220–240 V uses 230, 440–480 V uses 460, 550–600 V uses 575.",
  },
  motorOcpd: { table: "430.52", note: "Transcribed 2026-10-22; percent of full-load current for squirrel-cage motors other than Design B energy-efficient. Where the percentage is not a standard rating, the next standard rating up is allowed (430.52(C)(1) Exception No. 1)." },
  workingSpace: {
    table: "110.26(A)(1), (A)(2), (A)(3)",
    note: "Transcribed 2026-10-23; same in 2020 and 2023 (cross-check against the adopted edition before issuing). Depth by nominal voltage to ground and condition: 0–150 V 3 ft in every condition; 151–600 V 3, 3½ and 4 ft; 601–1000 V 3, 4 and 5 ft. Width: the equipment's width or 30 in., whichever is greater. Height: 6½ ft or the equipment's height, whichever is greater. Feet values (the code's metric values are 900 mm, 1.0 m, 1.2 m, 1.5 m, 750 mm and 2.0 m).",
  },
  parallel: { table: "310.10(G)", note: "Transcribed 2026-10-22; 1/0 AWG and larger in parallel, same length, material, size, insulation and termination in each set, each set in its own raceway with a full-size equipment grounding conductor (250.122(F))." },
};

// ------------------------------------------------------------------ 110.26 working space

const FT_MM = 304.8;

export interface WorkingSpaceRow {
  /** Highest nominal voltage to ground the row covers, volts. */
  readonly maxVoltsToGround: number;
  /** Minimum clear depth for conditions 1, 2 and 3, mm. */
  readonly depthMm: readonly [number, number, number];
}

/** Table 110.26(A)(1), in feet as US drawings note it. */
export const WORKING_SPACE_110_26: readonly WorkingSpaceRow[] = [
  { maxVoltsToGround: 150, depthMm: [3 * FT_MM, 3 * FT_MM, 3 * FT_MM] },
  { maxVoltsToGround: 600, depthMm: [3 * FT_MM, 3.5 * FT_MM, 4 * FT_MM] },
  { maxVoltsToGround: 1000, depthMm: [3 * FT_MM, 4 * FT_MM, 5 * FT_MM] },
];

/** 110.26(A)(2) and (A)(3) minimums, mm. */
export const WORKING_SPACE_MIN_WIDTH_MM = 30 * 25.4;
export const WORKING_SPACE_MIN_HEIGHT_MM = 6.5 * FT_MM;
