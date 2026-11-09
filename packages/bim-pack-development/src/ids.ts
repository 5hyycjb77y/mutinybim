/** The Development add-on's namespace: every id it contributes is `development.<name>`. Stored forever. */
export const DEVELOPMENT_PACK_ID = "development";

export const DEVELOPMENT_KIND = {
  programArea: "development.program_area",
  dealAssumption: "development.deal_assumption",
} as const;

export const DEVELOPMENT_VALUE = {
  /** A program area's use, as the owner names it ("Residential", "Retail"). Text. */
  use: "development.use",
  /** Gross area, square metres. Also the measure a per-area price in a cost source names. */
  area: "development.area",
  /** The share of the area that earns rent, 0 to 1. Absent: 1. */
  rentableFraction: "development.rentable_fraction",
  /** Which assumption (`DEAL_ASSUMPTIONS`). Text. */
  assumption: "development.assumption",
  /** A fraction assumption's amount (vacancy, cap rate, soft cost), 0 to 1. Money is never stored here. */
  fraction: "development.fraction",
} as const;

/**
 * The assumptions the pro forma reads. Open: a stored assumption it doesn't
 * know is kept and listed as not used.
 *
 * Fractions are stored on the record (`development.fraction`):
 *   vacancy             share of rent not collected
 *   cap_rate            net operating income ÷ value
 *   soft_cost_fraction  soft cost as a share of hard cost
 *
 * Money is never stored in the model (product decision 4): the money
 * assumptions are rates in the reader's own cost source, under the code
 * system `DEAL_COST_SYSTEM`, code = the assumption, measure
 * `development.area`, per `m2`. The record says only that the assumption
 * applies, and its basis.
 *   rent_per_area_year            per m² of rentable area per year
 *   operating_cost_per_area_year  per m² of gross area per year
 *   cost_per_area                 hard cost per m² of gross area, used when the model has no priced quantities
 */
export const FRACTION_ASSUMPTIONS = ["vacancy", "cap_rate", "soft_cost_fraction"] as const;
export const MONEY_ASSUMPTIONS = ["rent_per_area_year", "operating_cost_per_area_year", "cost_per_area"] as const;
export const DEAL_ASSUMPTIONS = [...FRACTION_ASSUMPTIONS, ...MONEY_ASSUMPTIONS] as const;
export type DealAssumption = (typeof DEAL_ASSUMPTIONS)[number];

/** The code system a cost source prices money assumptions under. */
export const DEAL_COST_SYSTEM = "development.deal";
