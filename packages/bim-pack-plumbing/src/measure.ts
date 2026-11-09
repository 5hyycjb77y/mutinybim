import { sizeLabel, type BimElement, type MeasureRuleDef } from "@permitzip/bim-kernel";

/**
 * The Plumbing and gas add-on's measure rule (`MEASURE_RULE_POINT`): pipe
 * length by size and material, along the centreline with the slope
 * included, grouped as people say it ("2\" copper", "4\" cast iron").
 */

const MM_PER_M = 1000;

function length3d(el: BimElement): number | null {
  if (el.kind !== "run_segment" || el.size.shape !== "pipe") return null;
  return Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y, el.end.z - el.start.z) / MM_PER_M;
}

export const PLUMBING_MEASURE_RULE: MeasureRuleDef = {
  id: "plumbing_gas.pipe",
  label: "Pipe",
  classes: ["mep.pipe"],
  appliesTo: (el) => el.kind === "run_segment" && el.size.shape === "pipe",
  measures: [
    { key: "qto.length", kind: "length", unit: "m", from: "centreline length, slope included, by size and material", label: "Length", primary: true },
    { key: "qto.count", kind: "count", unit: "ea", from: "one per straight piece", label: "Pieces" },
  ],
  sizeGroup: (el) => (el.kind === "run_segment" && el.size.shape === "pipe" ? sizeLabel(el.size) : null),
  measure(el): Readonly<Record<string, number>> {
    const length = length3d(el);
    return length === null ? {} : { "qto.length": length, "qto.count": 1 };
  },
};
