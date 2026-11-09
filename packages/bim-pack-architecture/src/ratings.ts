import { type RatingKindRow } from "@permitzip/bim-kernel/rated-routes";
import { SMOKE_BARRIER_KEY } from "./parameters";
import { valueOf } from "./values";

/**
 * Assembly ratings walls, floors, ceilings and doors carry, read from the
 * element, then its type. Every trade reads them through `ratingOf`.
 */

/** The AEC library's rating parameters (hours on walls and floors, text on doors). */
export const FIRE_RESISTANCE_KEY = "arch.fire_resistance";
export const DOOR_FIRE_RATING_KEY = "arch.fire_rating";

/** "90 min", "1-1/2 hr", "2 h", "1" (hours) as hours; null when it doesn't read as a time. */
export function ratingHours(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)(?:-(\d+)\/(\d+))?\s*(min|minutes?|h|hr|hrs|hours?)?\s*$/i.exec(text);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] && m[3] ? Number(m[2]) / Number(m[3]) : 0;
  const value = whole + frac;
  return /^min/i.test(m[4] ?? "") ? value / 60 : value;
}

export const FIRE_RESISTANCE_RATING: RatingKindRow = {
  id: "fire_resistance",
  label: "Fire resistance",
  unit: "hour",
  levels: [0.5, 0.75, 1, 1.5, 2, 3, 4],
  parameterKeys: [FIRE_RESISTANCE_KEY, DOOR_FIRE_RATING_KEY],
  read(el, elements) {
    const hours = valueOf(el, elements, FIRE_RESISTANCE_KEY);
    if (typeof hours === "number" && Number.isFinite(hours) && hours > 0) return hours;
    const text = valueOf(el, elements, DOOR_FIRE_RATING_KEY);
    const parsed = typeof text === "string" ? ratingHours(text) : null;
    return parsed !== null && parsed > 0 ? parsed : null;
  },
  format: (h) => (h < 1 ? `${Math.round(h * 60)}-minute` : `${h}-hour`),
};

export const SMOKE_BARRIER_RATING: RatingKindRow = {
  id: "smoke_barrier",
  label: "Smoke barrier",
  unit: "",
  parameterKeys: [SMOKE_BARRIER_KEY],
  read(el, elements) {
    const v = valueOf(el, elements, SMOKE_BARRIER_KEY);
    return typeof v === "boolean" ? (v ? 1 : 0) : null;
  },
  format: (v) => (v > 0 ? "Smoke barrier" : "Not a smoke barrier"),
};

export const ARCHITECTURE_RATINGS: readonly RatingKindRow[] = [FIRE_RESISTANCE_RATING, SMOKE_BARRIER_RATING];
