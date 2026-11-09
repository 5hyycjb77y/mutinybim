/**
 * Plumbing code tables from PermitZIP's code library (the host's database,
 * `codes.sections`, instrument `va_vpc`: Virginia Plumbing Code 2021, the
 * 2021 IPC as amended by Virginia, in force 2024-01-18), read 2026-10-23.
 * Numbers and the fixture names they key on only; the footnote letters are
 * kept as `note` where they change how a value is used.
 *
 * Not in the library (and so not here): IPC Appendix E (Table E103.3(2)
 * water supply fixture units, Table E103.3(3) demand, the friction charts).
 * Water supply fixture units come from the firm's fixture types / load
 * points; demand comes from a selectable Hunter curve (packs/hunter).
 */

export const IPC_TABLES_SOURCE = "PermitZIP code library: Virginia Plumbing Code 2021 (2021 IPC as amended by Virginia), read 2026-10-23";

/** Table 604.3: flow rate (gpm) and flow pressure (psi) required at fixture supply outlets. */
export const TABLE_604_3: ReadonlyArray<{ readonly fixture: string; readonly gpm: number; readonly psi: number; readonly note?: string }> = [
  { fixture: "Bathtub, balanced-pressure, thermostatic or combination mixing valve", gpm: 4, psi: 20 },
  { fixture: "Bidet, thermostatic mixing valve", gpm: 2, psi: 20 },
  { fixture: "Combination fixture", gpm: 4, psi: 8 },
  { fixture: "Dishwasher, residential", gpm: 2.75, psi: 8 },
  { fixture: "Drinking fountain", gpm: 0.75, psi: 8 },
  { fixture: "Laundry tray", gpm: 4, psi: 8 },
  { fixture: "Lavatory, private", gpm: 0.8, psi: 8 },
  { fixture: "Lavatory, private, mixing valve", gpm: 0.8, psi: 8 },
  { fixture: "Lavatory, public", gpm: 0.4, psi: 8 },
  { fixture: "Shower", gpm: 2.5, psi: 8 },
  { fixture: "Shower, balanced-pressure, thermostatic or combination mixing valve", gpm: 2.5, psi: 20, note: "b: a lower mixing-valve rating applies where the manufacturer gives one" },
  { fixture: "Sill cock, hose bibb", gpm: 5, psi: 8 },
  { fixture: "Sink, residential", gpm: 1.75, psi: 8 },
  { fixture: "Sink, service", gpm: 3, psi: 8 },
  { fixture: "Urinal, valve", gpm: 12, psi: 25 },
  { fixture: "Water closet, blow out, flushometer valve", gpm: 25, psi: 45 },
  { fixture: "Water closet, flushometer tank", gpm: 1.6, psi: 20 },
  { fixture: "Water closet, siphonic, flushometer valve", gpm: 25, psi: 35 },
  { fixture: "Water closet, tank, close coupled", gpm: 3, psi: 20 },
  { fixture: "Water closet, tank, one piece", gpm: 6, psi: 20 },
];

/** Table 604.5: minimum fixture supply pipe size (inches). */
export const TABLE_604_5: ReadonlyArray<{ readonly fixture: string; readonly minIn: number }> = [
  { fixture: "Bathtub (60 x 32 in. and smaller)", minIn: 0.5 },
  { fixture: "Bathtub (larger than 60 x 32 in.)", minIn: 0.5 },
  { fixture: "Bidet", minIn: 0.375 },
  { fixture: "Combination sink and tray", minIn: 0.5 },
  { fixture: "Dishwasher, domestic", minIn: 0.5 },
  { fixture: "Drinking fountain", minIn: 0.375 },
  { fixture: "Hose bibb", minIn: 0.5 },
  { fixture: "Kitchen sink", minIn: 0.5 },
  { fixture: "Laundry, 1, 2 or 3 compartments", minIn: 0.5 },
  { fixture: "Lavatory", minIn: 0.375 },
  { fixture: "Shower, single head", minIn: 0.5 },
  { fixture: "Sink, flushing rim", minIn: 0.75 },
  { fixture: "Sink, service", minIn: 0.5 },
  { fixture: "Urinal, flush tank", minIn: 0.5 },
  { fixture: "Urinal, flushometer valve", minIn: 0.75 },
  { fixture: "Wall hydrant", minIn: 0.5 },
  { fixture: "Water closet, flush tank", minIn: 0.375 },
  { fixture: "Water closet, flushometer tank", minIn: 0.375 },
  { fixture: "Water closet, flushometer valve", minIn: 1 },
  { fixture: "Water closet, one piece", minIn: 0.5 },
];

/** Table 704.1: minimum slope of horizontal drainage pipe by size band (largest size in the band, in/ft). */
export const TABLE_704_1: ReadonlyArray<{ readonly maxNominalIn: number; readonly inPerFt: number }> = [
  { maxNominalIn: 2.5, inPerFt: 0.25 },
  { maxNominalIn: 6, inPerFt: 0.125 },
  { maxNominalIn: 1000, inPerFt: 0.0625 },
];

/** Table 709.1: drainage fixture units and minimum trap size. `dfu` null: computed by 709.4 (floor sinks). */
export const TABLE_709_1: ReadonlyArray<{ readonly fixture: string; readonly dfu: number | null; readonly trapIn: number | null; readonly note?: string }> = [
  { fixture: "Automatic clothes washer, commercial", dfu: 3, trapIn: 2 },
  { fixture: "Automatic clothes washer, residential", dfu: 2, trapIn: 2 },
  { fixture: "Bathroom group (1.6 gpf water closet)", dfu: 5, trapIn: null },
  { fixture: "Bathroom group (water closet over 1.6 gpf)", dfu: 6, trapIn: null },
  { fixture: "Bathtub", dfu: 2, trapIn: 1.5 },
  { fixture: "Bidet", dfu: 1, trapIn: 1.25 },
  { fixture: "Combination sink and tray", dfu: 2, trapIn: 1.5 },
  { fixture: "Dental lavatory", dfu: 1, trapIn: 1.25 },
  { fixture: "Dental unit or cuspidor", dfu: 1, trapIn: 1.25 },
  { fixture: "Dishwashing machine, domestic", dfu: 2, trapIn: 1.5 },
  { fixture: "Drinking fountain", dfu: 0.5, trapIn: 1.25 },
  { fixture: "Emergency floor drain", dfu: 0, trapIn: 2 },
  { fixture: "Floor drain", dfu: 2, trapIn: 2, note: "h: see 709.4 / 709.4.1" },
  { fixture: "Floor sink", dfu: null, trapIn: 2, note: "h: see 709.4 / 709.4.1" },
  { fixture: "Kitchen sink, domestic", dfu: 2, trapIn: 1.5 },
  { fixture: "Kitchen sink, domestic with food waste disposer, dishwasher or both", dfu: 2, trapIn: 1.5 },
  { fixture: "Laundry tray (1 or 2 compartments)", dfu: 2, trapIn: 1.5 },
  { fixture: "Lavatory", dfu: 1, trapIn: 1.25 },
  { fixture: "Shower, 5.7 gpm or less", dfu: 2, trapIn: 1.5 },
  { fixture: "Shower, over 5.7 to 12.3 gpm", dfu: 3, trapIn: 2 },
  { fixture: "Shower, over 12.3 to 25.8 gpm", dfu: 5, trapIn: 3 },
  { fixture: "Shower, over 25.8 to 55.6 gpm", dfu: 6, trapIn: 4 },
  { fixture: "Service sink", dfu: 2, trapIn: 1.5 },
  { fixture: "Sink", dfu: 2, trapIn: 1.5 },
  { fixture: "Urinal", dfu: 4, trapIn: null },
  { fixture: "Urinal, 1 gallon per flush or less", dfu: 2, trapIn: null, note: "e" },
  { fixture: "Urinal, nonwater supplied", dfu: 0.5, trapIn: null },
  { fixture: "Wash sink (circular or multiple), each set of faucets", dfu: 2, trapIn: 1.5 },
  { fixture: "Water closet, flushometer tank, public or private", dfu: 4, trapIn: null, note: "e" },
  { fixture: "Water closet, private (1.6 gpf)", dfu: 3, trapIn: null, note: "e" },
  { fixture: "Water closet, private (over 1.6 gpf)", dfu: 4, trapIn: null, note: "e" },
  { fixture: "Water closet, public (1.6 gpf)", dfu: 4, trapIn: null, note: "e" },
  { fixture: "Water closet, public (over 1.6 gpf)", dfu: 6, trapIn: null, note: "e" },
];

/** Table 709.2: drainage fixture units by fixture drain or trap size (inches). */
export const TABLE_709_2: ReadonlyArray<{ readonly trapIn: number; readonly dfu: number }> = [
  { trapIn: 1.25, dfu: 1 },
  { trapIn: 1.5, dfu: 2 },
  { trapIn: 2, dfu: 3 },
  { trapIn: 2.5, dfu: 4 },
  { trapIn: 3, dfu: 5 },
  { trapIn: 4, dfu: 6 },
];

/** Table 710.1(1): building drains and sewers, maximum DFU by diameter and slope (in/ft). Null: not permitted at that slope. */
export const TABLE_710_1_1_SLOPES = [0.0625, 0.125, 0.25, 0.5] as const;
export const TABLE_710_1_1: ReadonlyArray<{ readonly nominalIn: number; readonly maxDfu: readonly [number | null, number | null, number | null, number | null] }> = [
  { nominalIn: 1.25, maxDfu: [null, null, 1, 1] },
  { nominalIn: 1.5, maxDfu: [null, null, 3, 3] },
  { nominalIn: 2, maxDfu: [null, null, 21, 26] },
  { nominalIn: 2.5, maxDfu: [null, null, 24, 31] },
  { nominalIn: 3, maxDfu: [null, 36, 42, 50] },
  { nominalIn: 4, maxDfu: [null, 180, 216, 250] },
  { nominalIn: 5, maxDfu: [null, 390, 480, 575] },
  { nominalIn: 6, maxDfu: [null, 700, 840, 1000] },
  { nominalIn: 8, maxDfu: [1400, 1600, 1920, 2300] },
  { nominalIn: 10, maxDfu: [2500, 2900, 3500, 4200] },
  { nominalIn: 12, maxDfu: [3900, 4600, 5600, 6700] },
  { nominalIn: 15, maxDfu: [7000, 8300, 10000, 12000] },
];

/** Table 710.1(1) note a: minimum building drain size serving a water closet (inches). */
export const BUILDING_DRAIN_MIN_WITH_WC_IN = 3;

/**
 * 704.2: drainage piping is not reduced in size in the direction of flow, and
 * a water closet discharges through a 3 in. connection, so no branch or stack
 * a water closet drains to is smaller than 3 in. (inches).
 */
export const DRAIN_MIN_WITH_WC_IN = 3;

/** Table 710.1(2): horizontal fixture branches and stacks, maximum DFU. Null: sized on design criteria (note c). */
export const TABLE_710_1_2: ReadonlyArray<{ readonly nominalIn: number; readonly branch: number; readonly oneInterval: number | null; readonly stackUpTo3: number | null; readonly stackOver3: number | null }> = [
  { nominalIn: 1.5, branch: 3, oneInterval: 2, stackUpTo3: 4, stackOver3: 8 },
  { nominalIn: 2, branch: 6, oneInterval: 6, stackUpTo3: 10, stackOver3: 24 },
  { nominalIn: 2.5, branch: 12, oneInterval: 9, stackUpTo3: 20, stackOver3: 42 },
  { nominalIn: 3, branch: 20, oneInterval: 20, stackUpTo3: 48, stackOver3: 72 },
  { nominalIn: 4, branch: 160, oneInterval: 90, stackUpTo3: 240, stackOver3: 500 },
  { nominalIn: 5, branch: 360, oneInterval: 200, stackUpTo3: 540, stackOver3: 1100 },
  { nominalIn: 6, branch: 620, oneInterval: 350, stackUpTo3: 960, stackOver3: 1900 },
  { nominalIn: 8, branch: 1400, oneInterval: 600, stackUpTo3: 2200, stackOver3: 3600 },
  { nominalIn: 10, branch: 2500, oneInterval: 1000, stackUpTo3: 3800, stackOver3: 5600 },
  { nominalIn: 12, branch: 3900, oneInterval: 1500, stackUpTo3: 6000, stackOver3: 8400 },
  { nominalIn: 15, branch: 7000, oneInterval: null, stackUpTo3: null, stackOver3: null },
];

/** Table 1003.3.5.1: grease interceptor flow-through rating (gpm) and grease retention capacity (lb). Over 100 gpm: twice the rating (note a). */
export const TABLE_1003_3_5_1: ReadonlyArray<{ readonly gpm: number; readonly lb: number }> = [
  { gpm: 4, lb: 8 },
  { gpm: 6, lb: 12 },
  { gpm: 7, lb: 14 },
  { gpm: 9, lb: 18 },
  { gpm: 10, lb: 20 },
  { gpm: 12, lb: 24 },
  { gpm: 14, lb: 28 },
  { gpm: 15, lb: 30 },
  { gpm: 18, lb: 36 },
  { gpm: 20, lb: 40 },
  { gpm: 25, lb: 50 },
  { gpm: 35, lb: 70 },
  { gpm: 50, lb: 100 },
  { gpm: 75, lb: 150 },
  { gpm: 100, lb: 200 },
];

/** Vent diameters Table 906.1 has columns for (inches). */
export const TABLE_906_1_VENT_IN = [1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12] as const;

/**
 * Table 906.1: size and developed length of stack vents and vent stacks.
 * Per row: the soil or waste stack diameter, the total DFU vented, and the
 * most developed length (ft, from the vent connection to the open air, note
 * a) for each vent diameter in `TABLE_906_1_VENT_IN` (null: not permitted).
 * The library stores this table column by column; the rows here are that
 * text re-assembled (read 2026-10-25).
 */
export const TABLE_906_1: ReadonlyArray<{ readonly stackIn: number; readonly dfu: number; readonly maxFt: readonly (number | null)[] }> = [
  { stackIn: 1.25, dfu: 2, maxFt: [30] },
  { stackIn: 1.5, dfu: 8, maxFt: [50, 150] },
  { stackIn: 1.5, dfu: 10, maxFt: [30, 100] },
  { stackIn: 2, dfu: 12, maxFt: [30, 75, 200] },
  { stackIn: 2, dfu: 20, maxFt: [26, 50, 150] },
  { stackIn: 2.5, dfu: 42, maxFt: [null, 30, 100, 300] },
  { stackIn: 3, dfu: 10, maxFt: [null, 42, 150, 360, 1040] },
  { stackIn: 3, dfu: 21, maxFt: [null, 32, 110, 270, 810] },
  { stackIn: 3, dfu: 53, maxFt: [null, 27, 94, 230, 680] },
  { stackIn: 3, dfu: 102, maxFt: [null, 25, 86, 210, 620] },
  { stackIn: 4, dfu: 43, maxFt: [null, null, 35, 85, 250, 980] },
  { stackIn: 4, dfu: 140, maxFt: [null, null, 27, 65, 200, 750] },
  { stackIn: 4, dfu: 320, maxFt: [null, null, 23, 55, 170, 640] },
  { stackIn: 4, dfu: 540, maxFt: [null, null, 21, 50, 150, 580] },
  { stackIn: 5, dfu: 190, maxFt: [null, null, null, 28, 82, 320, 990] },
  { stackIn: 5, dfu: 490, maxFt: [null, null, null, 21, 63, 250, 760] },
  { stackIn: 5, dfu: 940, maxFt: [null, null, null, 18, 53, 210, 670] },
  { stackIn: 5, dfu: 1400, maxFt: [null, null, null, 16, 49, 190, 590] },
  { stackIn: 6, dfu: 500, maxFt: [null, null, null, null, 33, 130, 400, 1000] },
  { stackIn: 6, dfu: 1100, maxFt: [null, null, null, null, 26, 100, 310, 780] },
  { stackIn: 6, dfu: 2000, maxFt: [null, null, null, null, 22, 84, 260, 660] },
  { stackIn: 6, dfu: 2900, maxFt: [null, null, null, null, 20, 77, 240, 600] },
  { stackIn: 8, dfu: 1800, maxFt: [null, null, null, null, null, 31, 95, 240, 940] },
  { stackIn: 8, dfu: 3400, maxFt: [null, null, null, null, null, 24, 73, 190, 729] },
  { stackIn: 8, dfu: 5600, maxFt: [null, null, null, null, null, 20, 62, 160, 610] },
  { stackIn: 8, dfu: 7600, maxFt: [null, null, null, null, null, 18, 56, 140, 560] },
  { stackIn: 10, dfu: 4000, maxFt: [null, null, null, null, null, null, 31, 78, 310, 960] },
  { stackIn: 10, dfu: 7200, maxFt: [null, null, null, null, null, null, 24, 60, 240, 740] },
  { stackIn: 10, dfu: 11000, maxFt: [null, null, null, null, null, null, 20, 51, 200, 630] },
  { stackIn: 10, dfu: 15000, maxFt: [null, null, null, null, null, null, 18, 46, 180, 571] },
  { stackIn: 12, dfu: 7300, maxFt: [null, null, null, null, null, null, null, 31, 120, 380, 940] },
  { stackIn: 12, dfu: 13000, maxFt: [null, null, null, null, null, null, null, 24, 94, 300, 720] },
  { stackIn: 12, dfu: 20000, maxFt: [null, null, null, null, null, null, null, 20, 79, 250, 610] },
  { stackIn: 12, dfu: 26000, maxFt: [null, null, null, null, null, null, null, 18, 72, 230, 500] },
  { stackIn: 15, dfu: 15000, maxFt: [null, null, null, null, null, null, null, null, 40, 130, 310] },
  { stackIn: 15, dfu: 25000, maxFt: [null, null, null, null, null, null, null, null, 31, 96, 240] },
  { stackIn: 15, dfu: 38000, maxFt: [null, null, null, null, null, null, null, null, 26, 81, 200] },
  { stackIn: 15, dfu: 50000, maxFt: [null, null, null, null, null, null, null, null, 24, 74, 180] },
];

/** 906.1 / 906.2: no vent smaller than 1-1/4 in. */
export const VENT_MIN_IN = 1.25;
/** 906.2: a vent over this developed length (ft) is one nominal size larger for its whole length. */
export const VENT_UPSIZE_OVER_FT = 40;

/**
 * Table 1106.2(1): circular vertical conductors and leaders, the most
 * horizontally projected roof area (sq ft) per leader diameter at each
 * rainfall rate, 1 to 12 in/h (columns). Interpolation between listed sizes
 * is permitted (note a); this pack uses the listed sizes only.
 */
export const TABLE_1106_2_1: ReadonlyArray<{ readonly nominalIn: number; readonly maxSqFt: readonly number[] }> = [
  { nominalIn: 2, maxSqFt: [2280, 1440, 960, 720, 575, 480, 410, 360, 320, 290, 260, 240] },
  { nominalIn: 3, maxSqFt: [8800, 4400, 2930, 2200, 1760, 1470, 1260, 1100, 980, 880, 800, 730] },
  { nominalIn: 4, maxSqFt: [18400, 9200, 6130, 4600, 3680, 3070, 2630, 2300, 2045, 1840, 1675, 1530] },
  { nominalIn: 5, maxSqFt: [34600, 17300, 11530, 8650, 6920, 5765, 4945, 4325, 3845, 3460, 3145, 2880] },
  { nominalIn: 6, maxSqFt: [54000, 27000, 17995, 13500, 10800, 9000, 7715, 6750, 6000, 5400, 4910, 4500] },
  { nominalIn: 8, maxSqFt: [116000, 58000, 38660, 29000, 23200, 19315, 16570, 14500, 12890, 11600, 10545, 9600] },
];

/** Table 1106.3's slopes (in/ft): 1/8, 1/4 and 1/2 unit in 12. */
export const TABLE_1106_3_SLOPES = [0.125, 0.25, 0.5] as const;

/**
 * Table 1106.3: horizontal storm drainage piping, the most horizontally
 * projected roof area (sq ft) per size, by slope (`TABLE_1106_3_SLOPES`)
 * then rainfall rate 1 to 6 in/h.
 */
export const TABLE_1106_3: ReadonlyArray<{ readonly nominalIn: number; readonly maxSqFt: readonly [readonly number[], readonly number[], readonly number[]] }> = [
  { nominalIn: 3, maxSqFt: [[3288, 1644, 1096, 822, 657, 548], [4640, 2320, 1546, 1160, 928, 773], [6576, 3288, 2295, 1644, 1310, 1096]] },
  { nominalIn: 4, maxSqFt: [[7520, 3760, 2506, 1800, 1504, 1253], [10600, 5300, 3533, 2650, 2120, 1766], [15040, 7520, 5010, 3760, 3010, 2500]] },
  { nominalIn: 5, maxSqFt: [[13360, 6680, 4453, 3340, 2672, 2227], [18880, 9440, 6293, 4720, 3776, 3146], [26720, 13360, 8900, 6680, 5320, 4450]] },
  { nominalIn: 6, maxSqFt: [[21400, 10700, 7133, 5350, 4280, 3566], [30200, 15100, 10066, 7550, 6040, 5033], [42800, 21400, 13700, 10700, 8580, 7140]] },
  { nominalIn: 8, maxSqFt: [[46000, 23000, 15330, 11500, 9200, 7600], [65200, 32600, 21733, 16300, 13040, 10866], [92000, 46000, 30650, 23000, 18400, 15320]] },
  { nominalIn: 10, maxSqFt: [[82800, 41400, 27600, 20700, 16580, 13800], [116800, 58400, 38950, 29200, 23350, 19450], [171600, 85800, 55200, 41400, 33150, 27600]] },
  { nominalIn: 12, maxSqFt: [[133200, 66600, 44400, 33300, 26650, 22200], [188000, 94000, 62600, 47000, 37600, 31350], [266400, 133200, 88800, 66600, 53200, 44400]] },
  { nominalIn: 15, maxSqFt: [[218000, 109000, 72800, 59500, 47600, 39650], [336000, 168000, 112000, 84000, 67250, 56000], [476000, 238000, 158800, 119000, 95300, 79250]] },
];

/** 1106.3: horizontal storm drains slope at least 1/8 in/ft unless approved. */
export const STORM_MIN_SLOPE_IN_PER_FT = 0.125;

/**
 * What the library does NOT hold as numbers, by name, so a calc that needs
 * it refuses instead of guessing. Figures 1106.1(1)–(5) (100-year, 1-hour
 * rainfall maps) are stored as images.
 */
export const NOT_IN_LIBRARY = {
  rainfall: "Figure 1106.1 (100-year, 1-hour rainfall maps) is only an image in the code library, not numbers",
} as const;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

/** A table row by fixture name: exact (ignoring case and punctuation), else the one row whose name contains every word given. */
export function findFixtureRow<T extends { readonly fixture: string }>(table: readonly T[], name: string): T | null {
  const n = norm(name);
  const exact = table.find((r) => norm(r.fixture) === n);
  if (exact) return exact;
  const words = n.split(" ").filter((w) => w.length > 0);
  const hits = table.filter((r) => words.every((w) => norm(r.fixture).split(" ").includes(w)));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}
