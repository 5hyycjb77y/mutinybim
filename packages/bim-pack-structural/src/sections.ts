import { qty, type Quantity } from "@permitzip/bim-units";

/**
 * A small wide-flange catalogue as type data. Values are the AISC Steel
 * Construction Manual, 16th Edition, Table 1-1 (W-shapes) dimensions and
 * properties, transcribed and not yet checked against the printed table
 * (`verified: false`, like an unverified space-use row).
 */

export interface WideFlangeSection {
  /** Catalogue key, as drawings write it ("W16X26"). */
  readonly id: string;
  readonly label: string;
  readonly depth: Quantity<"length">;
  /** Nominal weight per length. Under standard gravity lb/ft of steel is lbf/ft of load, so it is a line load. */
  readonly weight: Quantity<"line_load">;
  readonly area: Quantity<"area">;
  /** Strong-axis second moment of area. */
  readonly ix: Quantity<"second_moment_of_area">;
  /** Strong-axis elastic section modulus. */
  readonly sx: Quantity<"section_modulus">;
  readonly source: string;
  readonly verified: boolean;
}

const AISC_TABLE_1_1 = "AISC Steel Construction Manual, 16th Ed., Table 1-1";

function w(id: string, depthIn: number, weightPlf: number, areaIn2: number, ixIn4: number, sxIn3: number): WideFlangeSection {
  return Object.freeze({
    id,
    label: id.replace("X", "×"),
    depth: qty("length", depthIn, "in"),
    weight: qty("line_load", weightPlf, "plf"),
    area: qty("area", areaIn2, "in2"),
    ix: qty("second_moment_of_area", ixIn4, "in4"),
    sx: qty("section_modulus", sxIn3, "in3"),
    source: AISC_TABLE_1_1,
    verified: false,
  });
}

export const WIDE_FLANGE_SECTIONS: readonly WideFlangeSection[] = Object.freeze([
  w("W8X31", 8.0, 31, 9.13, 110, 27.5),
  w("W10X33", 9.73, 33, 9.71, 171, 35.0),
  w("W12X26", 12.2, 26, 7.65, 204, 33.4),
  w("W14X22", 13.7, 22, 6.49, 199, 29.0),
  w("W16X26", 15.7, 26, 7.68, 301, 38.4),
  w("W18X35", 17.7, 35, 10.3, 510, 57.6),
  w("W21X44", 20.7, 44, 13.0, 843, 81.6),
  w("W24X55", 23.6, 55, 16.2, 1350, 114),
]);

const BY_ID = new Map(WIDE_FLANGE_SECTIONS.map((s) => [s.id, s]));

/** "w16x26", "W16×26", " W16X26 " → the catalogue row; null for a section this catalogue lacks. */
export function sectionById(name: string): WideFlangeSection | null {
  const key = name.trim().toUpperCase().replace(/[×\s]/g, (c) => (c === "×" ? "X" : ""));
  return BY_ID.get(key) ?? null;
}
