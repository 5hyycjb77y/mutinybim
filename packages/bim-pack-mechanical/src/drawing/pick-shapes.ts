import type { ElementKindItem, KindPickShapeFace } from "@permitzip/bim-kernel";

/**
 * Where a click picks the Mechanical add-on's point kinds in a plan
 * (`pickShape` on its kind rows): a diffuser anywhere on its 24" box, a tap
 * or an elbow within 150 mm of its point. They have no body, so sections
 * don't pick them. Ducts and units pick by their body (`solid`).
 */

const TERMINAL_HALF_MM = 12 * 25.4;
const POINT_HALF_MM = 150;

const terminalPick: KindPickShapeFace = (el) => (el.kind === "terminal" ? { form: "point", at: el.position, radiusMm: TERMINAL_HALF_MM } : null);
const pointPick: KindPickShapeFace = (el) => (el.kind === "tap" || el.kind === "elbow" ? { form: "point", at: el.position, radiusMm: POINT_HALF_MM } : null);

export const MECHANICAL_PICK_SHAPES: Readonly<Record<"terminal" | "tap" | "elbow", Pick<ElementKindItem, "pickShape">>> = {
  terminal: { pickShape: terminalPick },
  tap: { pickShape: pointPick },
  elbow: { pickShape: pointPick },
};
