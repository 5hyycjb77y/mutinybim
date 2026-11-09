/**
 * @jest-environment node
 *
 * Round 5a f-params: one unit vocabulary (bim-units), one parameter
 * definition (the field system's FieldDef), with every stored name, printed
 * string and resolved value unchanged.
 */
import {
  PARAM_UNITS,
  QUANTITIES,
  QUANTITY_KEYS,
  evaluateFormula,
  fieldProviderRegistry,
  formatParam,
  paramNamed,
  paramStorageConversion,
  paramUnitBinding,
  paramValue,
  parameterOfParamDef,
  parseFormula,
  partParameters,
  quantityParameterKey,
  type ParamDef,
  type ParamUnit,
  type ParamValue,
  type PartTypeDefinition,
} from "..";
import * as registryUnits from "../registry/units";
import * as bimUnits from "@permitzip/bim-units";
import { convert, PARAM_UNIT_BINDINGS, QUANTITY_BINDINGS, toSI, unitAllowed, UNITS } from "@permitzip/bim-units";

/** SI factor of every v1 part-parameter unit, from its physical definition (not from bim-units). */
const PHYSICAL_SI: Readonly<Record<ParamUnit, number>> = {
  none: 1,
  mm: 0.001,
  cfm: 0.3048 ** 3 / 60,
  gpm: 0.003785411784 / 60,
  w: 1,
  kw: 1000,
  va: 1,
  v: 1,
  a: 1,
  hp: 550 * 0.3048 * 0.45359237 * 9.80665,
  btuh: 1055.05585262 / 3600,
  tons: (12000 * 1055.05585262) / 3600,
  in_wc: 249.0889,
  psi: (0.45359237 * 9.80665) / 0.0254 ** 2,
  lb: 0.45359237,
  percent: 0.01,
  lumens: 1,
  count: 1,
};

/** v1 `formatParam` suffixes, as printed before the table moved into bim-units. */
const V1_SUFFIX: Readonly<Record<ParamUnit, string>> = { none: "", mm: " mm", cfm: " CFM", gpm: " GPM", w: " W", kw: " kW", va: " VA", v: " V", a: " A", hp: " HP", btuh: " Btu/h", tons: " tons", in_wc: " in. w.c.", psi: " psi", lb: " lb", percent: "%", lumens: " lm", count: "" };

/** v1 `QUANTITIES`, verbatim, before it read units and adding rules from bim-units. */
const V1_QUANTITIES = {
  wsfu_cold: { key: "wsfu_cold", label: "Cold water fixture units", unit: "WSFU", add: "sum", demand: "water_supply" },
  wsfu_hot: { key: "wsfu_hot", label: "Hot water fixture units", unit: "WSFU", add: "sum", demand: "water_supply" },
  wsfu_total: { key: "wsfu_total", label: "Total water fixture units", unit: "WSFU", add: "sum", demand: "water_supply" },
  dfu: { key: "dfu", label: "Drainage fixture units", unit: "DFU", add: "sum", demand: "drainage" },
  gpm_fixed: { key: "gpm_fixed", label: "Fixed flow", unit: "gpm", add: "sum", demand: null },
  gph_demand: { key: "gph_demand", label: "Hot water demand", unit: "gal/h", add: "sum", demand: null },
  mbh: { key: "mbh", label: "Gas input", unit: "MBH", add: "sum", demand: null },
  min_inlet_pressure: { key: "min_inlet_pressure", label: "Minimum inlet pressure", unit: "psi", add: "max", demand: null },
  cfm: { key: "cfm", label: "Airflow", unit: "CFM", add: "sum", demand: null },
  va: { key: "va", label: "Electrical load", unit: "VA", add: "sum", demand: null },
};

/** v1 `paramValue`'s lookup: instance parameters first, then type, linear. */
function v1ParamValue(def: PartTypeDefinition, values: Readonly<Record<string, ParamValue>>, name: string): ParamValue | undefined {
  const p = def.instanceParams.find((x) => x.name === name) ?? def.typeParams.find((x) => x.name === name);
  if (p?.formula) return paramValue(def, values, name);
  if (values[name] !== undefined) return values[name];
  if (def.typeValues[name] !== undefined) return def.typeValues[name];
  return p?.default;
}

const typeDef = (typeParams: ParamDef[], instanceParams: ParamDef[], typeValues: Record<string, ParamValue> = {}): PartTypeDefinition =>
  ({ familyName: "F", typeName: "T", category: "generic", typeParams, instanceParams, typeValues, connectors: [], geometry: [], symbol: [], tagFields: [] }) as unknown as PartTypeDefinition;

describe("r5p bim-units is the only unit list", () => {
  it("the kernel's registry units are bim-units' own lists, not a copy (fails on the stand-in: a separate array)", () => {
    expect(registryUnits.KIND_IDS).toBe(bimUnits.KIND_IDS);
    expect(registryUnits.UNIT_CODES).toBe(bimUnits.UNIT_CODES);
  });

  it("PARAM_UNITS is bim-units' legacy list, unchanged in content and order", () => {
    expect(PARAM_UNITS).toBe(bimUnits.LEGACY_PARAM_UNITS);
    expect([...PARAM_UNITS]).toEqual(["none", "mm", "cfm", "gpm", "w", "kw", "va", "v", "a", "hp", "btuh", "tons", "in_wc", "psi", "lb", "percent", "lumens", "count"]);
  });

  it("1:1 unit table: every old part-parameter unit maps to one bim-units unit with the identical SI factor", () => {
    const mapped = PARAM_UNITS.map((u) => {
      const b = PARAM_UNIT_BINDINGS[u];
      const factor = UNITS[b.unit].factor;
      return { u, code: b.unit, kindOk: unitAllowed(b.kind, b.unit), offset: UNITS[b.unit].offset, sameFactor: Math.abs(factor - PHYSICAL_SI[u]) <= 1e-12 * PHYSICAL_SI[u] };
    });
    for (const m of mapped) expect(m).toEqual({ u: m.u, code: m.code, kindOk: true, offset: 0, sameFactor: true });
    expect(new Set(mapped.map((m) => m.code)).size).toBe(PARAM_UNITS.length);
  });

  it("every old quantity-bag unit maps to its bim-units unit, and its printed label reads back as that unit", () => {
    for (const k of QUANTITY_KEYS) {
      const b = QUANTITY_BINDINGS[k];
      expect({ k, ok: unitAllowed(b.kind, b.unit), reads: bimUnits.findUnit(QUANTITIES[k].unit, b.kind) }).toEqual({ k, ok: true, reads: b.unit });
    }
  });

  it("part-formula length literals are bim-units conversions, bit for bit 1, 25.4 and 304.8", () => {
    expect([convert(1, "mm", "mm"), convert(1, "in", "mm"), convert(1, "ft", "mm")]).toEqual([1, 25.4, 304.8]);
    expect(evaluateFormula(parseFormula("2in + 1ft + 3mm"), () => 0)).toBe(2 * 25.4 + 304.8 + 3);
    expect(evaluateFormula(parseFormula("if(height > 36in, 4in, 2in)"), () => 1000)).toBe(101.6);
  });
});

describe("r5p equivalence: printed values and quantity definitions are unchanged", () => {
  it("formatParam prints exactly the v1 strings for every unit", () => {
    for (const unit of PARAM_UNITS) {
      const def: ParamDef = { name: "x", label: "X", kind: "number", unit };
      for (const v of [0, 1, 12.345, 99.999, 150.4, 1234.5]) {
        const rounded = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
        expect(formatParam(def, v)).toBe(`${rounded}${V1_SUFFIX[unit]}`);
      }
    }
  });

  it("QUANTITIES is the v1 table, field for field", () => {
    expect(QUANTITIES).toEqual(V1_QUANTITIES);
    for (const k of QUANTITY_KEYS) expect([QUANTITIES[k].add, QUANTITIES[k].demand]).toEqual([QUANTITY_BINDINGS[k].aggregation, QUANTITY_BINDINGS[k].demand]);
  });
});

describe("r5p one parameter definition", () => {
  it("a part parameter resolves to a ParameterDef with the v2 schedule column's kind and unit", () => {
    for (const unit of PARAM_UNITS) {
      const q = parameterOfParamDef({ name: "rating", label: "Rating", kind: "number", unit, min: 0 }, "type", ["mep.equipment"]);
      expect(q).toMatchObject({ path: "param.rating", key: "param.rating", binding: "type", valueType: "quantity", kind: PARAM_UNIT_BINDINGS[unit].kind, unit: PARAM_UNIT_BINDINGS[unit].unit, storedUnit: PARAM_UNIT_BINDINGS[unit].unit, constraint: { min: 0 }, writer: { kind: "parameter", scope: "type", name: "rating" }, classes: ["mep.equipment"] });
    }
    expect(parameterOfParamDef({ name: "width", label: "Width", kind: "length" }, "instance")).toMatchObject({ valueType: "quantity", kind: "length", unit: "mm", storedUnit: "mm", binding: "instance" });
    expect(parameterOfParamDef({ name: "tilt", label: "Tilt", kind: "angle" }, "instance")).toMatchObject({ kind: "angle", unit: "deg" });
    expect(parameterOfParamDef({ name: "on", label: "On", kind: "boolean" }, "instance").valueType).toBe("boolean");
    expect(parameterOfParamDef({ name: "c", label: "C", kind: "choice", choices: ["a", "b"] }, "instance")).toMatchObject({ valueType: "choice", choices: ["a", "b"], constraint: { choices: ["a", "b"] } });
    expect(parameterOfParamDef({ name: "half", label: "Half", kind: "length", formula: "width / 2" }, "type")).toMatchObject({ binding: "formula", writer: { kind: "none", reason: "Calculated by the part: width / 2" } });
  });

  it("every ParameterDef from a part type registers cleanly in the field system (unit allowed for its kind)", () => {
    const params: ParamDef[] = PARAM_UNITS.map((unit, i) => ({ name: `p${i}`, label: `P${i}`, kind: "number", unit }));
    const defs = partParameters(typeDef(params.slice(0, 9), params.slice(9)), ["mep.equipment"]);
    expect(defs).toHaveLength(PARAM_UNITS.length);
    for (const d of defs) expect({ path: d.path, ok: d.kind !== undefined && d.unit !== undefined && unitAllowed(d.kind, d.unit) }).toEqual({ path: d.path, ok: true });
  });

  it("reads a unit spelled either way: the stored v1 name or the bim-units code (expand before any writer emits codes)", () => {
    expect(paramUnitBinding("kw")).toEqual({ kind: "power_real", unit: "kW" });
    expect(paramUnitBinding("kW")).toEqual({ kind: "power_real", unit: "kW" });
    expect(paramUnitBinding("tons")).toEqual({ kind: "thermal_power", unit: "ton_r" });
    expect(paramUnitBinding(undefined)).toEqual({ kind: "dimensionless", unit: "1" });
    expect(paramUnitBinding("furlongs")).toBeNull();
  });

  it("load quantities are parameters keyed load.<key>, the same key the field system registers", () => {
    const reg = fieldProviderRegistry();
    for (const k of QUANTITY_KEYS) {
      const f = reg.field("mep.load_point", quantityParameterKey(k));
      expect({ k, key: f?.key, binding: f?.binding, kind: f?.kind, unit: f?.unit }).toEqual({ k, key: `load.${k}`, binding: "instance", kind: QUANTITY_BINDINGS[k].kind, unit: QUANTITY_BINDINGS[k].unit });
    }
  });

  it("the part@2 storage conversion is 1:1 both ways, and nothing here rewrites a stored value", () => {
    const tons = paramStorageConversion({ name: "cooling_tons", label: "Cooling", kind: "number", unit: "tons" });
    expect(tons?.storedUnit).toBe("ton_r");
    expect(tons?.toSI(10)).toBeCloseTo(35168.528, 3);
    expect(tons?.fromSI(tons.toSI(7.5))).toBeCloseTo(7.5, 12);
    for (const unit of PARAM_UNITS) {
      const c = paramStorageConversion({ name: "x", label: "X", kind: "number", unit });
      expect(c?.toSI(3)).toBeCloseTo(toSI(3, PARAM_UNIT_BINDINGS[unit].unit), 12);
    }
    expect(paramStorageConversion({ name: "t", label: "T", kind: "text" })).toBeNull();
  });
});

describe("r5p equivalence: parameter resolution", () => {
  it("indexed lookup returns exactly what the v1 linear lookup returned, including duplicate names and instance-over-type", () => {
    const shared: ParamDef = { name: "rating", label: "Instance rating", kind: "number", unit: "a", default: 20 };
    const def = typeDef(
      [{ name: "rating", label: "Type rating", kind: "number", unit: "a", default: 30 }, { name: "width", label: "W", kind: "length", default: 600 }, { name: "width", label: "W2", kind: "length", default: 900 }, { name: "half", label: "Half", kind: "length", formula: "width / 2" }],
      [shared, { name: "rating", label: "Second", kind: "number", unit: "a", default: 99 }, { name: "on", label: "On", kind: "boolean", default: true }],
      { width: 750 },
    );
    const names = ["rating", "width", "half", "on", "missing"];
    const cases: Readonly<Record<string, ParamValue>>[] = [{}, { rating: 15 }, { width: 100, on: false }];
    for (const values of cases) for (const n of names) expect([n, paramValue(def, values, n)]).toEqual([n, v1ParamValue(def, values, n)]);
    expect(paramNamed(def, "rating")).toBe(shared);
  });

  it("a definition drafted in place (the cut-sheet builder pushes parameters) never reads a stale index", () => {
    const typeParams: ParamDef[] = [{ name: "a", label: "A", kind: "number", default: 1 }];
    const def = typeDef(typeParams, []);
    expect(paramValue(def, {}, "b")).toBeUndefined();
    typeParams.push({ name: "b", label: "B", kind: "number", default: 2 });
    expect(paramValue(def, {}, "b")).toBe(2);
    const replaced = { ...def, instanceParams: [{ name: "a", label: "A", kind: "number", default: 5 } as ParamDef] };
    expect(paramValue(replaced, {}, "a")).toBe(5);
    expect(paramValue(def, {}, "a")).toBe(1);
  });
});
