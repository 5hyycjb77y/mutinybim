import { sizeLabel, type MeasureRuleDef, type RunSize } from "@permitzip/bim-kernel";

/**
 * The Mechanical add-on's measure rule (`MEASURE_RULE_POINT`): duct length
 * and sheet-metal surface by size. Surface is the size's perimeter times its
 * centreline length (the sheet-metal size; a liner or wrap is not counted).
 */

const MM_PER_M = 1000;

/** Perimeter of a duct size, mm; null for a size that isn't a duct's. */
function perimeterMm(size: RunSize): number | null {
  switch (size.shape) {
    case "rect":
      return 2 * (size.width + size.height);
    case "round":
      return Math.PI * size.diameter;
    case "oval": {
      // Flat oval: two half-circles of the height joined by flat sides.
      const flat = Math.max(0, size.width - size.height);
      return Math.PI * size.height + 2 * flat;
    }
    default:
      return null;
  }
}

export const MECHANICAL_MEASURE_RULE: MeasureRuleDef = {
  id: "mechanical.duct",
  label: "Duct",
  classes: ["mep.duct"],
  appliesTo: (el) => el.kind === "run_segment" && el.domain === "duct",
  measures: [
    { key: "qto.length", kind: "length", unit: "m", from: "centreline length by size", label: "Length", primary: true },
    { key: "qto.area_surface", kind: "area", unit: "m2", from: "size perimeter × centreline length (sheet metal, no liner)", label: "Surface area" },
    { key: "qto.count", kind: "count", unit: "ea", from: "one per straight piece", label: "Pieces" },
  ],
  sizeGroup: (el) => (el.kind === "run_segment" && el.domain === "duct" ? sizeLabel(el.size) : null),
  measure(el) {
    if (el.kind !== "run_segment" || el.domain !== "duct") return {};
    const length = Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z) / MM_PER_M;
    const out: Record<string, number> = { "qto.length": length, "qto.count": 1 };
    const p = perimeterMm(el.size);
    if (p !== null) out["qto.area_surface"] = (p / MM_PER_M) * length;
    return out;
  },
};
