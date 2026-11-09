import { FITTING_SLOTS, type FittingChoice, type FittingFamily, type FittingFamilyRow, type FittingSlot, type NumberParam } from "@permitzip/bim-kernel";
import { tapFaceRule } from "../connections/taps-faces";

/**
 * The duct fitting families (`FITTING_FAMILY_POINT` rows of the Mechanical
 * add-on; moved out of the kernel's static list in round 13, ids and data
 * unchanged): every elbow, transition, offset, tap, tee, wye and cap a duct
 * run can be made with, and the family each duct slot gets by default.
 *
 * Names follow the generic fitting TYPE names of the SMACNA HVAC Duct
 * Construction Standards. No figure numbers or coefficient tables are copied
 * from SMACNA or ASHRAE; losses come from the kernel's coefficient sources.
 */

const rOverW = (d: number): NumberParam => ({ key: "r_over_w", label: "Centreline radius / width (r/W)", kind: "number", unit: "ratio", default: d, min: 0.5, max: 3 });
const wallAngle: NumberParam = { key: "wall_angle_deg", label: "Wall angle (each side)", kind: "number", unit: "deg", default: 30, min: 5, max: 45 };

export const DUCT_FITTING_FAMILIES: readonly FittingFamily[] = [
  // ---------------------------------------------------------------- elbows
  {
    id: "duct.elbow.radius",
    name: "Smooth radius elbow",
    smacnaType: "Radius elbow",
    domain: "duct",
    fittingTypes: ["elbow"],
    shapes: ["rect", "oval"],
    angles: "any",
    params: [rOverW(1)],
    geometry: "radius_elbow",
    loss: "radius_elbow",
    description: "Curved throat and heel, no vanes. r/W is centreline radius over the duct dimension in the plane of the turn.",
  },
  {
    id: "duct.elbow.round_smooth",
    name: "Smooth round elbow",
    smacnaType: "Round elbow, smooth (pleated or stamped)",
    domain: "duct",
    fittingTypes: ["elbow"],
    shapes: ["round"],
    angles: "any",
    params: [{ ...rOverW(1.5), label: "Centreline radius / diameter (r/D)" }],
    geometry: "radius_elbow",
    loss: "stamped_elbow",
    description: "Die-formed or pleated round elbow with a continuous radius.",
  },
  {
    id: "duct.elbow.gored",
    name: "Gored round elbow",
    smacnaType: "Round elbow, segmented (gored)",
    domain: "duct",
    fittingTypes: ["elbow"],
    shapes: ["round"],
    angles: "any",
    params: [
      { key: "gores", label: "Gores", kind: "choice", options: ["3", "4", "5"], default: "5" },
      { ...rOverW(1.5), label: "Centreline radius / diameter (r/D)" },
    ],
    geometry: "gored_elbow",
    loss: "gored_elbow",
    description: "Built from straight gores; the end pieces are half-gores.",
  },
  {
    id: "duct.elbow.mitred",
    name: "Mitred elbow, no vanes",
    smacnaType: "Square-throat (mitred) elbow without vanes",
    domain: "duct",
    fittingTypes: ["elbow"],
    shapes: ["rect", "round", "oval"],
    angles: "any",
    params: [],
    geometry: "mitred_elbow",
    loss: "mitred_elbow",
    description: "Sharp throat and heel. Highest loss of the elbows; use where space forces it.",
  },
  {
    id: "duct.elbow.mitred_vanes",
    name: "Mitred elbow with turning vanes",
    smacnaType: "Square-throat elbow with turning vanes",
    domain: "duct",
    fittingTypes: ["elbow"],
    shapes: ["rect"],
    angles: "45_90",
    params: [
      { key: "vanes", label: "Vanes", kind: "choice", options: ["single", "double"], default: "single" },
      { key: "vane_radius_mm", label: "Vane radius", kind: "number", unit: "mm", default: 50.8, min: 25, max: 150 },
    ],
    geometry: "mitred_elbow",
    loss: "vaned_elbow",
    description: "Square throat and heel with a rail of curved vanes across the diagonal.",
  },
  // ---------------------------------------------------------------- transitions
  {
    id: "duct.transition.concentric",
    name: "Concentric transition",
    smacnaType: "Transition, concentric",
    domain: "duct",
    fittingTypes: ["transition"],
    shapes: ["rect", "round", "oval"],
    shapeChange: "same",
    params: [wallAngle],
    geometry: "transition",
    loss: "transition",
    description: "Both ends on one centreline; every side slopes. Length follows from the largest side change and the wall angle.",
  },
  {
    id: "duct.transition.eccentric",
    name: "Eccentric transition",
    smacnaType: "Transition, eccentric (flat on one side)",
    domain: "duct",
    fittingTypes: ["transition"],
    shapes: ["rect", "round", "oval"],
    shapeChange: "any",
    params: [{ key: "flat", label: "Flat side", kind: "choice", options: ["top", "bottom", "left", "right"], default: "top" }, wallAngle],
    geometry: "transition",
    loss: "transition",
    description: "One side stays flat (flat top keeps the top of duct level under structure); the opposite side takes the whole change.",
  },
  {
    id: "duct.transition.rect_round",
    name: "Rectangular-to-round transition",
    smacnaType: "Transition, rectangular to round",
    domain: "duct",
    fittingTypes: ["transition"],
    shapes: ["rect", "round", "oval"],
    shapeChange: "different",
    params: [wallAngle],
    geometry: "transition",
    loss: "transition",
    description: "Square-to-round (or oval) lofted transition.",
  },
  // ---------------------------------------------------------------- offsets
  {
    id: "duct.offset.ogee",
    name: "Ogee offset",
    smacnaType: "Offset, ogee (S)",
    domain: "duct",
    fittingTypes: ["offset"],
    shapes: ["rect", "round", "oval"],
    params: [{ key: "bend_angle_deg", label: "Bend angle", kind: "number", unit: "deg", default: 45, min: 15, max: 60 }],
    geometry: "ogee_offset",
    loss: "ogee_offset",
    description: "Two reverse curves in one piece; length is the offset times cot(bend angle / 2).",
  },
  // ---------------------------------------------------------------- branch takeoffs
  {
    id: "duct.tap.straight",
    name: "Straight tap",
    smacnaType: "Straight (90°) tap",
    domain: "duct",
    fittingTypes: ["tap"],
    shapes: ["rect", "round", "oval"],
    mainShapes: ["rect", "round", "oval"],
    params: [{ key: "collar_mm", label: "Collar length", kind: "number", unit: "mm", default: 50.8, min: 25, max: 300 }],
    geometry: "collar_tap",
    loss: "branch_takeoff",
    takeoff: { angleDeg: 90, entryFactor: 1 },
    description: "Square-edged collar cut into the trunk.",
  },
  {
    id: "duct.tap.45_entry",
    name: "45° entry tap",
    smacnaType: "45° entry (shoe) tap",
    domain: "duct",
    fittingTypes: ["tap"],
    shapes: ["rect"],
    mainShapes: ["rect", "oval"],
    params: [],
    geometry: "shoe_tap",
    loss: "branch_takeoff",
    takeoff: { angleDeg: 45, entryFactor: 1 },
    description: "Rectangular branch with a 45° shoe on the upstream side, so air turns into it gradually.",
  },
  {
    id: "duct.tap.conical",
    name: "Conical tap",
    smacnaType: "Conical (spin-in) tap",
    domain: "duct",
    fittingTypes: ["tap"],
    shapes: ["round"],
    mainShapes: ["rect", "round", "oval"],
    params: [],
    geometry: "conical_tap",
    loss: "branch_takeoff",
    takeoff: { angleDeg: 90, entryFactor: 0.65 },
    description: "Round spin-in fitting that flares to a larger opening at the trunk.",
  },
  {
    id: "duct.tap.bellmouth",
    name: "Bellmouth tap",
    smacnaType: "Bellmouth tap",
    domain: "duct",
    fittingTypes: ["tap"],
    shapes: ["round"],
    mainShapes: ["rect", "round", "oval"],
    params: [],
    geometry: "bellmouth_tap",
    loss: "branch_takeoff",
    takeoff: { angleDeg: 90, entryFactor: 0.5 },
    description: "Round takeoff with a rounded (bellmouth) entry.",
  },
  {
    id: "duct.tap.boot",
    name: "Boot tap",
    smacnaType: "Boot tap (rectangular boot to round)",
    domain: "duct",
    fittingTypes: ["tap"],
    shapes: ["round"],
    mainShapes: ["rect", "oval"],
    params: [],
    geometry: "boot_tap",
    loss: "branch_takeoff",
    takeoff: { angleDeg: 45, entryFactor: 0.85 },
    description: "Rectangular 45° boot on the trunk with a round neck.",
  },
  {
    id: "duct.tee.rect",
    name: "Rectangular tee",
    smacnaType: "Tee, rectangular main and branch",
    domain: "duct",
    fittingTypes: ["tap"],
    shapes: ["rect"],
    mainShapes: ["rect"],
    params: [{ key: "collar_mm", label: "Collar length", kind: "number", unit: "mm", default: 101.6, min: 25, max: 300 }],
    geometry: "collar_tap",
    loss: "branch_takeoff",
    takeoff: { angleDeg: 90, entryFactor: 1 },
    description: "Full rectangular branch off a rectangular main.",
  },
  {
    id: "duct.wye.lateral",
    name: "45° lateral (wye)",
    smacnaType: "Wye / lateral, 45°",
    domain: "duct",
    fittingTypes: ["tap"],
    shapes: ["round"],
    mainShapes: ["round"],
    params: [],
    geometry: "lateral_tap",
    loss: "branch_takeoff",
    takeoff: { angleDeg: 45, entryFactor: 1 },
    description: "Round branch leaving the main at 45°.",
  },
  // ---------------------------------------------------------------- caps
  {
    id: "duct.cap.flat",
    name: "End cap",
    smacnaType: "End cap",
    domain: "duct",
    fittingTypes: ["cap"],
    shapes: ["rect", "round", "oval"],
    params: [],
    geometry: "flat_cap",
    loss: "cap",
    description: "Closes an open end.",
  },
];

/** The default fitting per slot for duct systems. Systems override any slot. */
export const DUCT_FITTING_DEFAULTS: Readonly<Partial<Record<FittingSlot, FittingChoice>>> = {
  elbow_rect: { family: "duct.elbow.radius", params: { r_over_w: 1 } },
  elbow_round: { family: "duct.elbow.gored", params: { gores: "5", r_over_w: 1.5 } },
  elbow_oval: { family: "duct.elbow.radius", params: { r_over_w: 1 } },
  transition: { family: "duct.transition.concentric" },
  transition_shape_change: { family: "duct.transition.rect_round" },
  branch_rect: { family: "duct.tap.straight" },
  branch_round: { family: "duct.tap.conical" },
  cap: { family: "duct.cap.flat" },
  offset: { family: "duct.offset.ogee" },
};

/** The scope duct slot defaults are registered under: the run domain. */
const DUCT_SCOPE = "duct";

/** A tap off a duct's top rises from it, one off its bottom drops (`connections/taps-faces.ts`). */
const tapFaceWords = (face: string): string | null => tapFaceRule(face)?.words ?? null;

export const DUCT_FITTING_FAMILY_ROWS: readonly FittingFamilyRow[] = DUCT_FITTING_FAMILIES.map((family): FittingFamilyRow => {
  const defaults = FITTING_SLOTS.flatMap((slot) => {
    const choice = DUCT_FITTING_DEFAULTS[slot];
    return choice && choice.family === family.id ? [{ scope: DUCT_SCOPE, slot, choice }] : [];
  });
  const faces = family.fittingTypes.includes("tap") ? { faceWords: tapFaceWords } : {};
  return defaults.length > 0 ? { family, defaults, ...faces } : { family, ...faces };
});
