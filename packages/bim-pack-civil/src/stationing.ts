import { qty, to, type Quantity } from "@permitzip/bim-units";
import { pathLength, pointAtStation, profileElevationAt, stationOfPoint, type PathPlacement } from "@permitzip/bim-pack/runtime";

/**
 * Stationing along an alignment (a `PathPlacement`): the station of a point,
 * the point at a station, and stations written the way plans write them,
 * `10+00.00` (hundreds of feet + feet) or `1+000.000` (kilometres + metres).
 * The geometry is the kernel's published placement math (arcs by bulge);
 * this file only converts units and writes the label.
 */

type Vec2 = { readonly x: number; readonly y: number };

const mm = (q: Quantity<"length">): number => to(q, "mm");
const len = (valueMm: number): Quantity<"length"> => qty("length", valueMm, "mm");

export type StationStyle = "us_feet" | "metric";

/** `10+00.00` for 1,000 ft, `-0+12.50` for −12.5 ft, `1+250.000` for 1,250 m. Rounds first, so 99.996 ft is `1+00.00`, never `0+100.00`. */
export function formatStation(station: Quantity<"length">, style: StationStyle = "us_feet"): string {
  const unitsPerStation = style === "us_feet" ? 100 : 1000;
  const places = style === "us_feet" ? 2 : 3;
  const value = style === "us_feet" ? to(station, "ft") : to(station, "m");
  const scale = 10 ** places;
  const rounded = Math.round(Math.abs(value) * scale) / scale;
  const whole = Math.floor(rounded / unitsPerStation + 1e-12);
  const rest = rounded - whole * unitsPerStation;
  const width = String(unitsPerStation).length - 1 + 1 + places;
  const sign = value < 0 && rounded > 0 ? "-" : "";
  return `${sign}${whole}+${rest.toFixed(places).padStart(width, "0")}`;
}

/** Reads `10+00.00` / `1+000.000` back; null when the text isn't a station. */
export function parseStation(text: string, style: StationStyle = "us_feet"): Quantity<"length"> | null {
  const m = /^\s*(-)?(\d+)\+(\d+(?:\.\d*)?)\s*$/.exec(text);
  if (!m) return null;
  const unitsPerStation = style === "us_feet" ? 100 : 1000;
  const rest = Number(m[3]);
  if (rest >= unitsPerStation) return null;
  const value = (Number(m[2]) * unitsPerStation + rest) * (m[1] ? -1 : 1);
  return style === "us_feet" ? qty("length", value, "ft") : qty("length", value, "m");
}

/** Horizontal length of the alignment. */
export function alignmentLength(path: PathPlacement): Quantity<"length"> {
  return len(pathLength(path));
}

/** The station of the alignment point nearest `point`, and the offset (+ left of travel). */
export function stationOf(path: PathPlacement, point: Vec2): { readonly station: Quantity<"length">; readonly offset: Quantity<"length"> } {
  const r = stationOfPoint(path, point);
  return { station: len(r.stationMm), offset: len(r.offsetMm) };
}

/** The plan point and direction of travel (degrees counter-clockwise from east) at a station; null off the alignment. */
export function pointAt(path: PathPlacement, station: Quantity<"length">): { readonly point: Vec2; readonly directionDeg: number } | null {
  return pointAtStation(path, mm(station));
}

/** The profile elevation above the level at a station (held flat past the profile's ends). */
export function profileElevation(path: PathPlacement, station: Quantity<"length">): Quantity<"length"> {
  return len(profileElevationAt(path, mm(station)));
}
