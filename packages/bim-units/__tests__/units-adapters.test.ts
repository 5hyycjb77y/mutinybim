import { q, type Quantity as CalcQuantity } from "@permitzip/bim-calc";
import { PARAM_UNITS, QUANTITIES, QUANTITY_KEYS } from "@permitzip/bim-kernel";
import { BIM_CALC_UNIT_CODES, convert, KINDS, PARAM_UNIT_BINDINGS, QUANTITY_BINDINGS, unitAllowed, UNITS, type InUnit } from "@permitzip/bim-units";

describe("adapters from the older unit vocabularies", () => {
  it("maps every PARAM_UNITS entry to a kind and a unit that kind accepts", () => {
    expect(Object.keys(PARAM_UNIT_BINDINGS).sort()).toEqual([...PARAM_UNITS].sort());
    for (const [legacy, b] of Object.entries(PARAM_UNIT_BINDINGS)) expect({ legacy, ok: unitAllowed(b.kind, b.unit) }).toEqual({ legacy, ok: true });
  });

  it("maps every QUANTITIES entry to a kind, unit and allowed total rule", () => {
    expect(Object.keys(QUANTITY_BINDINGS).sort()).toEqual([...QUANTITY_KEYS].sort());
    for (const key of QUANTITY_KEYS) {
      const b = QUANTITY_BINDINGS[key];
      const legacy = QUANTITIES[key];
      expect({ key, unitOk: unitAllowed(b.kind, b.unit), rule: b.aggregation, demand: b.demand }).toEqual({ key, unitOk: true, rule: legacy.add, demand: legacy.demand });
      expect(KINDS[b.kind].aggregation.allowed).toContain(b.aggregation);
      expect(UNITS[b.unit].symbol.toLowerCase()).toBe(legacy.unit.toLowerCase());
    }
  });

  it("maps every bim-calc unit name to a code, and calc quantities cross without a cast", () => {
    for (const code of Object.values(BIM_CALC_UNIT_CODES)) expect(UNITS[code]).toBeDefined();
    const fromCalc: CalcQuantity<"mbh"> = q(199, "mbh");
    const inUnits: InUnit<"MBH"> = fromCalc;
    expect(convert(inUnits, "MBH", "kW")).toBeCloseTo(58.32, 2);
  });
});
