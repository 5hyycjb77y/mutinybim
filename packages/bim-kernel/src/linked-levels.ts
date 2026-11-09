import { normalizeLevelName } from "./levels";

/**
 * Which storey of a linked model a view's level means. Names rarely agree
 * between the architect's model and ours ("ROOF" here, "ROOF LOW POINT" and
 * "ROOF HIGH POINT" there), so the match runs, in order: the storey the level
 * was told to use for that link (a person's choice, kept on the level), the
 * same name, the same name ignoring case and punctuation, the same floor
 * (within 5 mm), then the one storey near enough in elevation. Two storeys
 * near enough is a question for the person, never a silent pick, and no
 * storey near enough is a question listing them all, never a dead end.
 */

export interface LinkedStorey {
  readonly name: string;
  /** Elevation in the host model's frame, mm (link placement applied). */
  readonly elevationMm: number;
}

/** Floors closer than this are the same floor (levels.ts uses the same). */
const SAME_FLOOR_MM = 5;

/** A storey this near the view's level is taken as it when it is the only one: just under 3 ft, so a grade a step below a floor stays its own level. */
export const LINKED_LEVEL_TOLERANCE_MM = 900;

/** The nearest storey is taken only when the next one is at least this much farther (2 ft); closer than that, the person chooses. */
export const LINKED_LEVEL_CLEAR_MM = 600;

export type LinkedStoreyMatch =
  | { readonly ok: true; readonly storey: LinkedStorey; readonly how: "chosen" | "name" | "elevation" | "nearest" }
  | {
      readonly ok: false;
      /** ambiguous: more than one storey is near enough. none: no storey is near enough (or the view's elevation is unknown). */
      readonly reason: "ambiguous" | "none";
      /** The storeys to choose from, nearest first. */
      readonly candidates: readonly LinkedStorey[];
      /** Plain words for the person ("Which level of the architect's model is ROOF?"). */
      readonly question: string;
    };

export interface LinkedStoreyQuery {
  readonly level: string;
  readonly levelElevationMm?: number;
  /** The storey name the host level keeps for this link, when a person chose one. */
  readonly chosen?: string;
  /** The linked model's name, for the question. */
  readonly linkLabel: string;
}

export function matchLinkedStorey(storeys: readonly LinkedStorey[], q: LinkedStoreyQuery): LinkedStoreyMatch {
  const chosen = q.chosen === undefined ? undefined : storeys.find((s) => s.name === q.chosen);
  if (chosen) return { ok: true, storey: chosen, how: "chosen" };
  const exact = storeys.find((s) => s.name === q.level);
  if (exact) return { ok: true, storey: exact, how: "name" };
  const wanted = normalizeLevelName(q.level);
  const named = storeys.filter((s) => normalizeLevelName(s.name) === wanted);
  if (named.length === 1 && named[0]) return { ok: true, storey: named[0], how: "name" };
  const at = q.levelElevationMm;
  const byDistance = at === undefined ? [...storeys].sort((a, b) => a.elevationMm - b.elevationMm) : [...storeys].sort((a, b) => Math.abs(a.elevationMm - at) - Math.abs(b.elevationMm - at));
  if (at !== undefined) {
    const same = storeys.filter((s) => Math.abs(s.elevationMm - at) < SAME_FLOOR_MM);
    if (same.length === 1 && same[0]) return { ok: true, storey: same[0], how: "elevation" };
    const near = byDistance.filter((s) => Math.abs(s.elevationMm - at) <= LINKED_LEVEL_TOLERANCE_MM);
    const [first, second] = near;
    const clearlyNearest = first !== undefined && (second === undefined || Math.abs(second.elevationMm - at) - Math.abs(first.elevationMm - at) >= LINKED_LEVEL_CLEAR_MM);
    if (first && clearlyNearest) return { ok: true, storey: first, how: "nearest" };
    if (near.length > 1) return { ok: false, reason: "ambiguous", candidates: near, question: `Which level of ${q.linkLabel} is ${q.level}? ${near.map((s) => s.name).join(" or ")} are both near its height.` };
  }
  const question =
    storeys.length === 0
      ? `${q.linkLabel} has no levels, so it can't be drawn on ${q.level}.`
      : `Which level of ${q.linkLabel} is ${q.level}? None has its name${at === undefined ? "" : " or sits near its height"}.`;
  return { ok: false, reason: "none", candidates: byDistance, question };
}
