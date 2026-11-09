import type { Citation, CodeEdition } from "../../types";
import * as tables from "./tables";

/**
 * The NEC pack: one entry per edition. The tables are shared (their values
 * did not change between 2020 and 2023); the clause numbering is not, so
 * every citation goes through `necCite(edition, clause)` and a 2023 project
 * reads "Table 220.45" where a 2020 project reads "Table 220.42".
 */

export const NEC_EDITIONS = ["2020", "2023"] as const;
export type NecEditionYear = (typeof NEC_EDITIONS)[number];

export const NEC_PACK_VERSION = "2026.10.26";

export type NecClause =
  | "ampacity_table"
  | "ambient_correction"
  | "ccc_adjustment"
  | "neutral_not_counted"
  | "terminal_rating"
  | "terminal_le_100"
  | "terminal_gt_100"
  | "terminal_listed_75"
  | "small_conductor"
  | "next_size_up"
  | "standard_ratings"
  | "branch_conductor"
  | "branch_ocpd"
  | "feeder_conductor"
  | "feeder_ocpd"
  | "egc_table"
  | "egc_not_larger"
  | "egc_upsize"
  | "fill_percent"
  | "conduit_areas"
  | "conductor_areas"
  | "circular_mils"
  | "ac_impedance"
  | "branch_vd_note"
  | "feeder_vd_note"
  | "calculated_load"
  | "lighting_demand"
  | "receptacle_demand"
  | "kitchen_demand"
  | "motor_load"
  | "largest_motor"
  | "noncoincident"
  | "motor_table_use"
  | "motor_flc_1ph"
  | "motor_flc_3ph"
  | "motor_conductor"
  | "motor_ocpd"
  | "motor_ocpd_next"
  | "motor_conductor_protection"
  | "parallel"
  | "egc_parallel"
  | "service_conductors"
  | "service_rating"
  | "feeder_continuous"
  | "service_continuous"
  | "space_heating_load"
  | "space_heating_continuous"
  | "working_space_depth"
  | "working_space_width"
  | "working_space_height"
  | "dedicated_space"
  | "dedicated_space_ceiling"
  | "ignitable_material"
  | "interrupting_rating";

const COMMON: Readonly<Record<NecClause, string>> = {
  ampacity_table: "Table 310.16",
  ambient_correction: "Table 310.15(B)(1)",
  ccc_adjustment: "Table 310.15(C)(1)",
  neutral_not_counted: "310.15(E)",
  terminal_rating: "110.14(C)(1)",
  terminal_le_100: "110.14(C)(1)(a)",
  terminal_gt_100: "110.14(C)(1)(b)",
  terminal_listed_75: "110.14(C)(1)(a)(3)",
  small_conductor: "240.4(D)",
  next_size_up: "240.4(B)",
  standard_ratings: "240.6(A)",
  branch_conductor: "210.19(A)",
  branch_ocpd: "210.20(A)",
  feeder_conductor: "215.2(A)(1)",
  feeder_ocpd: "215.3",
  egc_table: "Table 250.122",
  egc_not_larger: "250.122(A)",
  egc_upsize: "250.122(B)",
  fill_percent: "Chapter 9, Table 1",
  conduit_areas: "Chapter 9, Table 4",
  conductor_areas: "Chapter 9, Table 5",
  circular_mils: "Chapter 9, Table 8",
  ac_impedance: "Chapter 9, Table 9",
  branch_vd_note: "210.19 Informational Note",
  feeder_vd_note: "215.2 Informational Note",
  calculated_load: "220.40",
  lighting_demand: "Table 220.42",
  receptacle_demand: "Table 220.44",
  kitchen_demand: "Table 220.56",
  motor_load: "220.50",
  largest_motor: "430.24",
  noncoincident: "220.60",
  motor_table_use: "430.6(A)(1)",
  motor_flc_1ph: "Table 430.248",
  motor_flc_3ph: "Table 430.250",
  motor_conductor: "430.22",
  motor_ocpd: "Table 430.52",
  motor_ocpd_next: "430.52(C)(1) Exception No. 1",
  motor_conductor_protection: "240.4(G)",
  parallel: "310.10(G)",
  egc_parallel: "250.122(F)",
  service_conductors: "230.42(A)",
  service_rating: "230.79",
  feeder_continuous: "215.2(A)(1)(a)",
  service_continuous: "230.42(A)(1)",
  space_heating_load: "220.51",
  space_heating_continuous: "424.4(B)",
  working_space_depth: "Table 110.26(A)(1)",
  working_space_width: "110.26(A)(2)",
  working_space_height: "110.26(A)(3)",
  dedicated_space: "110.26(E)(1)(a)",
  dedicated_space_ceiling: "110.26(E)(1)(a) Exception",
  ignitable_material: "240.24(D)",
  interrupting_rating: "110.9",
};

/**
 * NEC rules that read the model as configuration, the same in 2020 and 2023.
 * Firms may extend the lists; the lint rules only read them.
 */
export const NEC_DEDICATED_SPACE = {
  /** 1.8 m (6 ft) above the equipment, or to the structural ceiling if lower. */
  heightMm: 1828.8,
  clause: "NEC 110.26(E)(1)(a)",
  /** Suspended ceilings with removable panels are permitted in the zone; what is above them is taken as outside it. */
  ceilingClause: "NEC 110.26(E)(1)(a) Exception",
} as const;

export const NEC_IGNITABLE_MATERIAL = {
  clause: "NEC 240.24(D)",
  /** Space uses (library ids) where clothes and similar easily ignitable material are kept. */
  useIds: ["clothes_closet", "laundry", "linen_storage"],
  /** Words in a use's or a space's name that mean the same, whole phrases, any case ("Laundry", "Coat closet"). */
  words: ["clothes closet", "coat closet", "walk-in closet", "linen closet", "wardrobe", "laundry", "linen"],
  /** A panel this close to such a space (plan, mm) is in its vicinity. */
  vicinityMm: 304.8,
} as const;

const CLAUSES: Readonly<Record<NecEditionYear, Readonly<Record<NecClause, string>>>> = {
  "2020": COMMON,
  "2023": {
    ...COMMON,
    ambient_correction: "Table 310.15(B)(1)(1)",
    lighting_demand: "Table 220.45",
    receptacle_demand: "Table 220.47",
  },
};

/**
 * A load class the edition counts as continuous (3 hours or more) when the
 * load doesn't say. `clause` null marks a design default rather than a code
 * rule. Continuous loads are sized at 125% (215.2(A)(1)(a), 230.42(A)(1)).
 */
export interface ContinuousClassRule {
  readonly loadClass: string;
  readonly clause: NecClause | null;
  readonly basis: string;
}

const CONTINUOUS_COMMON: readonly ContinuousClassRule[] = [
  { loadClass: "lighting", clause: null, basis: "general lighting taken to run 3 hours or more (design default)" },
  { loadClass: "heating", clause: "space_heating_continuous", basis: "fixed electric space-heating equipment is a continuous load" },
];

const CONTINUOUS_CLASSES: Readonly<Record<NecEditionYear, readonly ContinuousClassRule[]>> = {
  "2020": CONTINUOUS_COMMON,
  "2023": CONTINUOUS_COMMON,
};

export type NecTables = typeof tables;

export type NecEdition = CodeEdition<NecClause, NecTables> & { readonly family: "nec"; readonly edition: NecEditionYear; readonly continuousClasses: readonly ContinuousClassRule[] };

export function necEdition(edition: NecEditionYear): NecEdition {
  return { family: "nec", code: "NEC", edition, packVersion: NEC_PACK_VERSION, clauses: CLAUSES[edition], tables, continuousClasses: CONTINUOUS_CLASSES[edition] };
}

/** The rule that makes `loadClass` continuous by default in this edition, or null. */
export function continuousClassRule(nec: NecEdition, loadClass: string): ContinuousClassRule | null {
  return nec.continuousClasses.find((r) => r.loadClass === loadClass) ?? null;
}

export function isNecEdition(value: CodeEdition | null): value is NecEdition {
  return value !== null && value.family === "nec" && (NEC_EDITIONS as readonly string[]).includes(value.edition);
}

/** "NEC 2023 Table 310.16, 75°C column". */
export function necCite(nec: NecEdition, clause: NecClause, detail?: string): Citation {
  const number = nec.clauses[clause];
  return { source: "code", code: "NEC", edition: nec.edition, clause: number, ...(detail ? { detail } : {}), text: `NEC ${nec.edition} ${number}${detail ? `, ${detail}` : ""}` };
}
