import { QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { electricalFieldsOf } from "./catalog/connection-fields";
import { QUANTITIES, quantityValueLabel, type ConnectionTypeEntry, type LoadSectionRow } from "@permitzip/bim-kernel";

/** The section's line, "120 V, 1 pole, 1,800 VA": the voltage as stored, the poles, and the load (VA, else a motor's horsepower). */
function electricalLine(entry: ConnectionTypeEntry, va: number): string {
  const poles = entry.poles === 1 ? "1 pole" : entry.poles === 2 ? "2 poles" : "3-phase";
  const load = va > 0 ? `${Math.round(va).toLocaleString("en-US")} VA` : entry.motorHp ? `${entry.motorHp} hp` : "no load";
  return `${entry.voltage} V, ${poles}, ${load}`;
}

/**
 * Electrical's load section (`LOAD_SECTION_POINT`, round 12): a load's VA
 * reads under "Electrical" and counts in the electrical trade. A connection
 * type's own `loadVa` stands in when its bag has no VA, and the section's
 * line says the voltage and poles ("120 V, 1 pole, 1,800 VA"); a motor given
 * only in horsepower still reads here.
 */
export const ELECTRICAL_LOAD_SECTION: LoadSectionRow = {
  id: "electrical",
  label: "Electrical",
  order: 10,
  quantities: ["va"],
  trade: "electrical",
  services: ["power"],
  connectionTotals: (entry, totals) => ({ ...totals, va: totals.va > 0 ? totals.va : electricalFieldsOf(entry).loadVa }),
  connectionView: (entry, totals) => {
    const va = totals.va;
    if (!(va > 0 || entry.motorHp !== undefined)) return null;
    const b = QUANTITY_BINDINGS.va;
    return {
      section: "electrical",
      label: "Electrical",
      quantities: va > 0 ? [{ key: "va", label: QUANTITIES.va.label, value: va, kind: b.kind, unit: b.unit, text: quantityValueLabel("va", va) }] : [],
      summary: electricalLine(entry, va),
    };
  },
};
