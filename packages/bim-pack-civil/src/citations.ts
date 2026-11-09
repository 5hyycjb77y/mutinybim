/**
 * Where each number the pack uses comes from. Same shape as the calc
 * contract's `Citation`, so a calc and a finding cite alike. A source whose
 * table or section number could not be checked against the document carries
 * "(?)" in its clause.
 */

export interface CivilCitation {
  /** "method": a published equation. "design_criteria": a default a firm sets, not a code requirement. */
  readonly source: "method" | "design_criteria" | "code";
  readonly code: string;
  readonly edition: string | null;
  readonly clause: string;
  readonly detail?: string;
  /** One line a person can read. */
  readonly text: string;
}

export const RATIONAL_METHOD: CivilCitation = {
  source: "method",
  code: "FHWA HEC-22, Urban Drainage Design Manual",
  edition: "3rd ed. (2009)",
  clause: "§3.2.1, Equation 3-1 (?)",
  detail: "Q = C·i·A (Kuichling 1889; Mulvaney 1851); US form Q = Ku·C·i·A with Ku = 1.0 for cfs from acres and in/h",
  text: "Rational method Q = C·i·A, FHWA HEC-22 (2009) §3.2.1 (?)",
};

export const RUNOFF_COEFFICIENT_TABLE: CivilCitation = {
  source: "method",
  code: "FHWA HEC-22, Urban Drainage Design Manual",
  edition: "3rd ed. (2009)",
  clause: "Table 3-1 (?)",
  detail: "Runoff coefficients for the rational formula by surface type (ranges after ASCE MOP 37); the pack's design value is stated per row",
  text: "Runoff coefficients, FHWA HEC-22 (2009) Table 3-1 (?)",
};

export const MANNING_EQUATION: CivilCitation = {
  source: "method",
  code: "FHWA HEC-22, Urban Drainage Design Manual",
  edition: "3rd ed. (2009)",
  clause: "§6.1.3, Equation 6-1 (?)",
  detail: "Manning (1891): Q = (Ku/n)·A·R^(2/3)·S^(1/2), Ku = 1 SI, 1.486 US customary; circular pipe flowing full: A = πD²/4, R = D/4",
  text: "Manning equation, pipe flowing full, FHWA HEC-22 (2009) §6.1.3 (?)",
};

export const MANNING_N_TABLE: CivilCitation = {
  source: "method",
  code: "FHWA HEC-22, Urban Drainage Design Manual",
  edition: "3rd ed. (2009)",
  clause: "Table 6-1 (?)",
  detail: "Manning's n for storm drain pipe by material; the pack's design value is stated per row",
  text: "Manning's n by pipe material, FHWA HEC-22 (2009) Table 6-1 (?)",
};

export const MIN_SLOPE_CRITERION: CivilCitation = {
  source: "design_criteria",
  code: "Civil pack design criteria",
  edition: null,
  clause: "minimum pipe slope",
  detail: "0.5 % unless the pipe or its system says otherwise; a firm or a local standard sets its own",
  text: "Minimum storm pipe slope 0.5 % (pack default; set per pipe system)",
};
