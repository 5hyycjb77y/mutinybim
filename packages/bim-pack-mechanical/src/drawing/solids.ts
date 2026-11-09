import { planWidth, type ElementKindItem, type KindSolidFace, type RunSize } from "@permitzip/bim-kernel";

/**
 * The bodies of the Mechanical add-on's kinds (`solid` on its kind rows), for
 * sections, 3D views and plan hiding: a duct is its cross-section run end to
 * end, a unit a 3 ft box. Records of these kinds carry no elevation, so they
 * sit at a fixed height above the drawing's floor, as before routing carried
 * heights. Exactly what round 12's kernel built.
 */

const FT = 304.8;
/** Where a duct with no elevation of its own runs, above its floor. */
export const LEGACY_DUCT_ELEVATION_MM = 9 * FT;

const ductSolid: KindSolidFace = (el, ctx) => {
  if (el.kind !== "duct_segment") return null;
  const z = ctx.floorMm + LEGACY_DUCT_ELEVATION_MM;
  const size: RunSize = el.profile.shape === "rect" ? { shape: "rect", width: el.profile.width, height: el.profile.height } : { shape: "round", diameter: el.profile.diameter };
  return { form: "run", a: { x: el.start.x, y: el.start.y, z }, b: { x: el.end.x, y: el.end.y, z }, size, sizeMm: planWidth(el.profile), category: "duct", role: "mep" };
};

const unitSolid: KindSolidFace = (el, ctx) => {
  if (el.kind !== "equipment") return null;
  const hx = el.size.x / 2;
  const hy = el.size.y / 2;
  const c = el.position;
  const top = ctx.floorMm + LEGACY_DUCT_ELEVATION_MM + 2 * FT;
  return {
    form: "prism",
    outline: [{ x: c.x - hx, y: c.y - hy }, { x: c.x + hx, y: c.y - hy }, { x: c.x + hx, y: c.y + hy }, { x: c.x - hx, y: c.y + hy }],
    z0: top - 3 * FT,
    z1: top,
    category: "equipment",
    role: "equipment",
  };
};

/** The `solid` face of each owned kind with a body (taps, elbows and terminals have none). */
export const MECHANICAL_SOLIDS: Readonly<Record<"equipment" | "duct_segment", Pick<ElementKindItem, "solid">>> = {
  equipment: { solid: unitSolid },
  duct_segment: { solid: ductSolid },
};
