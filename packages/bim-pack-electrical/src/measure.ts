import { catalogElementId, linkAdapterId, type BimElement, type MeasureRuleDef, type ServiceLink } from "@permitzip/bim-kernel";
import { linkConstruction } from "./catalog/feeder-types";

/**
 * The Electrical add-on's measure rule (`MEASURE_RULE_POINT`): conductor
 * length by size on every branch circuit and feeder, from its one-way length
 * and its conductors (its own, else its feeder type's). Phase and neutral
 * conductors count per set; the ground counts once per set. A link without a
 * length or conductors is counted but not measured, never guessed.
 */

type Elements = Readonly<Record<string, BimElement>>;

const M_PER_FT = 0.3048;

function isElectricalLink(el: BimElement): el is ServiceLink {
  return el.kind === "service_link" && linkAdapterId(el) === "electrical";
}

function hots(elements: Elements, link: ServiceLink): number {
  const built = linkConstruction(elements, link);
  return link.source.positions.length || built.feederType?.poles || 3;
}

export const ELECTRICAL_MEASURE_RULE: MeasureRuleDef = {
  id: "electrical.conductors",
  label: "Circuits and feeders",
  kinds: ["service_link"],
  appliesTo: (el) => isElectricalLink(el),
  measures: [
    { key: "qto.conductor_length", kind: "length", unit: "m", from: "one-way length × phase and neutral conductors × sets", label: "Conductor length", primary: true },
    { key: "qto.ground_length", kind: "length", unit: "m", from: "one-way length × sets", label: "Ground length" },
    { key: "qto.length", kind: "length", unit: "m", from: "one-way length as entered for voltage drop", label: "Run length" },
    { key: "qto.count", kind: "count", unit: "ea", from: "one per circuit or feeder", label: "Count" },
  ],
  sizeGroup(el, elements) {
    if (!isElectricalLink(el)) return null;
    const c = linkConstruction(elements, el).conductors;
    return c ? `#${c.phaseSize} ${c.material.toUpperCase()}` : null;
  },
  /** Its feeder type's catalog record, when it names one: editing the feeder type's conductors re-measures it. */
  reads(el) {
    const mark = isElectricalLink(el) ? el.electrical?.feederType?.trim() : undefined;
    return mark ? [catalogElementId("feeder_type", mark)] : [];
  },
  measure(el, elements) {
    if (!isElectricalLink(el)) return {};
    const out: Record<string, number> = { "qto.count": 1 };
    const lengthFt = el.electrical?.lengthFt;
    if (lengthFt === undefined || !Number.isFinite(lengthFt) || lengthFt <= 0) return out;
    const run = lengthFt * M_PER_FT;
    out["qto.length"] = run;
    const c = linkConstruction(elements, el).conductors;
    if (!c) return out;
    const sets = Math.max(1, c.sets);
    out["qto.conductor_length"] = run * sets * (hots(elements, el) + (c.neutralSize ? 1 : 0));
    if (c.groundSize) out["qto.ground_length"] = run * sets;
    return out;
  },
};
