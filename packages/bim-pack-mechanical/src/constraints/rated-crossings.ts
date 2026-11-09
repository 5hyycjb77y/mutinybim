import { elementsOfKind, paramValue, type ElementId, type ModelState } from "@permitzip/bim-kernel";
import type { PackRefusal } from "@permitzip/bim-kernel/packs";
import { DUCT_CEILING_CLEARANCE_LIMIT_ID } from "../design-limits";
import { type ClearanceRule, type CrossingPlacement, type CrossingRule, type RouteConstraintHit, type RouteConstraintRow, type RouteSpan } from "@permitzip/bim-kernel/rated-routes";

/**
 * Mechanical's route rules (`kernel.route_constraint`): a duct crossing a
 * fire-rated wall needs a fire damper there, one crossing a smoke barrier a
 * smoke damper, and a duct keeps 2 in under a ceiling, soffit or step
 * ceiling that reaches above its bottom (the round 12 proposed default
 * `mechanical.duct_ceiling_clearance`; common coordination practice, firm to
 * confirm). Ratings come from whichever add-on rates walls (`ratingOf`).
 *
 * Round 14 (M14): Finish places the damper (`place`): the model's damper
 * part type of the right kind, at the crossing. With none in the model, the
 * crossing stays on the Checklist saying what to add.
 */

const AIR_SERVICES: ReadonlySet<string> = new Set(["supply_air", "return_air", "exhaust_air", "outside_air"]);
const IN = 25.4;

/** A damper part's type value: `fire`, `smoke` or `fire_smoke`. Part parameter names are lower_snake_case (`place_part` refuses others). */
export const DAMPER_KIND_PARAM = "damper_kind";
/** Round 13's name, which no command could store; still read from a record written another way. */
const LEGACY_DAMPER_KIND_PARAM = "mechanical.damper_kind";
/** How far from the crossing a damper still counts as at it, mm. */
const AT_CROSSING_MM = 600;

const carriesAir = (span: RouteSpan): boolean => span.serviceId !== undefined && AIR_SERVICES.has(span.serviceId);

/** The model's damper part types by damper kind (types are few: this never walks placed parts). */
function damperTypes(model: ModelState): ReadonlyMap<ElementId, string> {
  const out = new Map<ElementId, string>();
  for (const type of elementsOfKind(model.elements, "part_type")) {
    const kind = type.definition.typeValues[DAMPER_KIND_PARAM] ?? type.definition.typeValues[LEGACY_DAMPER_KIND_PARAM];
    if (typeof kind === "string") out.set(type.id, kind);
  }
  return out;
}

function damperAt(model: ModelState, hit: RouteConstraintHit, kinds: readonly string[]): boolean {
  const types = damperTypes(model);
  if (types.size === 0) return false;
  const levelId = hit.levelId;
  for (const part of elementsOfKind(model.elements, "part")) {
    if (!types.has(part.typeId)) continue;
    if (levelId !== undefined && part.levelId !== levelId) continue;
    if (Math.hypot(part.position.x - hit.at.x, part.position.y - hit.at.y) > AT_CROSSING_MM) continue;
    const type = model.elements[part.typeId];
    if (type?.kind !== "part_type") continue;
    const kind = paramValue(type.definition, part.values, DAMPER_KIND_PARAM) ?? paramValue(type.definition, part.values, LEGACY_DAMPER_KIND_PARAM);
    if (typeof kind === "string" && kinds.includes(kind)) return true;
  }
  return false;
}

/** The damper type Finish places: the first (by id) of the preferred kind, else of an accepted one. */
function placeDamper(model: ModelState, kinds: readonly string[], words: string): CrossingPlacement | PackRefusal {
  const types = [...damperTypes(model)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const want of kinds) {
    const hit = types.find(([, kind]) => kind === want);
    if (hit) return { typeId: hit[0] };
  }
  return { refused: `There's no ${words} type in this model yet: add one from the firm library (Parts), then Fix places it here` };
}

export const FIRE_DAMPER_AT_RATED_WALL: CrossingRule = {
  id: "mechanical.fire_damper_at_rated_wall",
  label: "Fire damper at rated walls",
  form: "crossing",
  routes: ["run_segment"],
  appliesTo: carriesAir,
  ratingKind: "fire_resistance",
  atLeast: Number.EPSILON,
  requires: { id: "mechanical.fire_damper", label: "fire damper" },
  satisfied: (model, hit) => damperAt(model, hit, ["fire", "fire_smoke"]),
  place: (model) => placeDamper(model, ["fire", "fire_smoke"], "fire damper"),
};

export const SMOKE_DAMPER_AT_SMOKE_BARRIER: CrossingRule = {
  id: "mechanical.smoke_damper_at_smoke_barrier",
  label: "Smoke damper at smoke barriers",
  form: "crossing",
  routes: ["run_segment"],
  appliesTo: carriesAir,
  ratingKind: "smoke_barrier",
  atLeast: 1,
  requires: { id: "mechanical.smoke_damper", label: "smoke damper" },
  satisfied: (model, hit) => damperAt(model, hit, ["smoke", "fire_smoke"]),
  place: (model) => placeDamper(model, ["smoke", "fire_smoke"], "smoke damper"),
};

export const DUCT_CEILING_CLEARANCE: ClearanceRule = {
  id: "mechanical.duct_ceiling_clearance",
  label: "Duct clearance under ceilings",
  form: "clearance",
  routes: ["run_segment"],
  appliesTo: carriesAir,
  clearanceMm: 2 * IN,
  limit: { id: DUCT_CEILING_CLEARANCE_LIMIT_ID, selector: (span) => ({ quantity: "length", discipline: "mechanical", ...(span.serviceId ? { system: span.serviceId } : {}) }) },
};

export const MECHANICAL_ROUTE_RULES: readonly RouteConstraintRow[] = [FIRE_DAMPER_AT_RATED_WALL, SMOKE_DAMPER_AT_SMOKE_BARRIER, DUCT_CEILING_CLEARANCE];
