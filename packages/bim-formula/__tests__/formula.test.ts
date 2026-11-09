import { qty, type Kind, type Quantity } from "@permitzip/bim-units";
import { findCycles, formulaEngine, inputsFromRows, rowFromRecord, type CompiledFormula, type FormulaSchema, type FormulaType, type NamedCalculationSignature, type RowValues } from "../src";

const T = {
  mbh: { type: "quantity", kind: "flow_gas_energy", unit: "MBH" },
  btuh: { type: "quantity", kind: "flow_gas_energy", unit: "Btu/h" },
  number: { type: "quantity", kind: "dimensionless", unit: "1" },
  ratio: { type: "quantity", kind: "ratio", unit: "1" },
  ft: { type: "quantity", kind: "length", unit: "ft" },
  amps: { type: "quantity", kind: "current", unit: "A" },
  volts: { type: "quantity", kind: "voltage", unit: "V" },
  degF: { type: "quantity", kind: "temperature", unit: "degF" },
  wsfu: { type: "quantity", kind: "fixture_units_supply", unit: "WSFU" },
  dfu: { type: "quantity", kind: "fixture_units_drainage", unit: "DFU" },
  count: { type: "quantity", kind: "count", unit: "ea" },
  text: { type: "text" },
} as const satisfies Record<string, FormulaType>;

const servedSchema: FormulaSchema = {
  field: (path) =>
    ({
      "load.wsfu_total": { type: T.wsfu },
      "load.dfu": { type: T.dfu },
      mark: { type: T.text },
      voltage: { type: T.volts },
      "source.developed_length": { type: T.ft },
    })[path],
  relationship: () => undefined,
};

const calculations: Record<string, NamedCalculationSignature> = {
  "PZ.GasDemandBtuh": {
    id: "PZ.GasDemandBtuh",
    params: [
      { name: "input", type: T.mbh },
      { name: "factor", type: T.number },
    ],
    result: T.btuh,
    expression: "{input} * factor",
  },
  "PZ.A": { id: "PZ.A", params: [], result: T.number, expression: "PZ.B() + 1" },
  "PZ.B": { id: "PZ.B", params: [], result: T.number, expression: "PZ.A() * 2" },
};

const schema: FormulaSchema = {
  field: (path) =>
    ({
      "own.mbh": { type: T.mbh, label: "gas input" },
      "own.mbh_raw": { type: T.number },
      length: { type: T.ft },
      load: { type: T.amps },
      capacity_a: { type: T.amps },
      load_class: { type: T.text },
      supply_temp: { type: T.degF },
      return_temp: { type: T.degF },
    })[path],
  relationship: (name) => (name === "serves" ? { label: "serves", target: servedSchema } : undefined),
  table: (name) =>
    name === "PZ.DemandFactor"
      ? {
          key: T.count,
          value: T.ratio,
          match: "floor",
          rows: [
            { key: qty("count", 1, "ea"), value: qty("ratio", 1, "1") },
            { key: qty("count", 4, "ea"), value: qty("ratio", 0.8, "1") },
            { key: qty("count", 10, "ea"), value: qty("ratio", 0.6, "1") },
          ],
        }
      : undefined,
  calculation: (id) => calculations[id],
};

function compile(source: string, expect?: FormulaType): CompiledFormula {
  const result = formulaEngine.compile(source, schema, expect ? { expect } : {});
  if (!result.ok) throw new Error(`Expected "${source}" to compile: ${result.errors.map((e) => e.message).join("; ")}`);
  return result.formula;
}

function refuse(source: string, expect?: FormulaType) {
  const result = formulaEngine.compile(source, schema, expect ? { expect } : {});
  if (result.ok) throw new Error(`Expected "${source}" to be refused`);
  return result.errors;
}

const served = (wsfu: number, mark: string): RowValues => rowFromRecord({ "load.wsfu_total": qty("fixture_units_supply", wsfu, "WSFU"), mark, voltage: qty("voltage", 120, "V") });

function quantityOf(value: ReturnType<typeof formulaEngine.evaluateRow>): number {
  if (value.type !== "quantity") throw new Error(`Expected a quantity, got ${value.type}`);
  return value.value;
}

describe("formula language", () => {
  it("199 MBH reads as 199,000 Btu/h, and ×1000 never converts units behind your back", () => {
    const row = rowFromRecord({ "own.mbh": qty("flow_gas_energy", 199, "MBH") });

    const asBtuh = compile("{own.mbh}", T.btuh);
    expect(quantityOf(formulaEngine.evaluateRow(asBtuh, row))).toBeCloseTo(qty("flow_gas_energy", 199_000, "Btu/h"), 9);
    expect(formulaEngine.explain(asBtuh, row).text).toBe("199 MBH = 199,000 Btu/h");

    const scaled = compile("{own.mbh} * 1000");
    expect(scaled.type).toEqual(T.mbh);
    expect(formulaEngine.explain(scaled, row).text).toBe("199 MBH × 1000 = 199,000 MBH");
  });

  it("{own.mbh} * 1000 Btu/h over a unitless legacy 199 gives 199,000 Btu/h", () => {
    const row = rowFromRecord({ "own.mbh_raw": 199 as Quantity<Kind> });
    const f = compile("{own.mbh_raw} * 1000 Btu/h", T.btuh);
    expect(quantityOf(formulaEngine.evaluateRow(f, row))).toBeCloseTo(qty("flow_gas_energy", 199_000, "Btu/h"), 9);
    expect(formulaEngine.explain(f, row).text).toBe("199 × 1000 Btu/h = 199,000 Btu/h");
    // Btu/h is both heating capacity and gas input: without a declared result the formula asks.
    expect(refuse("{own.mbh_raw} * 1000 Btu/h")[0]?.message).toMatch(/heating or cooling capacity or an? gas input: set the result unit/);
  });

  it("refuses {length} + {own.mbh} with the span of +", () => {
    const [error, ...rest] = refuse("{length} + {own.mbh}");
    expect(rest).toHaveLength(0);
    expect(error?.code).toBe("unit_mismatch");
    expect(error?.span).toEqual({ start: 9, end: 10 });
    expect(error?.message).toBe("Can't add a gas input (MBH) to a length (ft): they measure different things");
  });

  it("refuses supply and drainage fixture units added together (same dimension, different kind)", () => {
    const errors = formulaEngine.compile("{load.wsfu_total} + {load.dfu}", servedSchema);
    expect(errors.ok).toBe(false);
    if (!errors.ok) expect(errors.errors[0]?.span).toEqual({ start: 18, end: 19 });
  });

  it("refuses a unitless number added to a length, pointing at the number", () => {
    const [error] = refuse("{length} + 3");
    expect(error?.code).toBe("unitless_number");
    expect(error?.span).toEqual({ start: 11, end: 12 });
    expect(error?.message).toBe("Give 3 a unit: it is added to a length (ft), like 3 ft");
    expect(compile("{length} * 3").type).toEqual(T.ft);
    expect(compile("{length} + 3 in").type).toEqual(T.ft);
  });

  it("sum(serves, {load.wsfu_total}) totals the related rows", () => {
    const f = compile("sum(serves, {load.wsfu_total})");
    expect(f.type).toEqual(T.wsfu);
    const heater = rowFromRecord({}, { serves: [served(2, "L-1"), served(1.5, "S-1"), served(2.5, "WC-1")] });
    expect(quantityOf(formulaEngine.evaluateRow(f, heater))).toBeCloseTo(6, 12);
    expect(formulaEngine.explain(f, heater).text).toBe("sum(serves: 2 WSFU, 1.5 WSFU, 2.5 WSFU) = 6 WSFU");

    // Columnar: three heaters, the middle one serves nothing.
    const rows = [heater, rowFromRecord({}), rowFromRecord({}, { serves: [served(4, "P-1")] })];
    const col = formulaEngine.evaluateColumn(f, inputsFromRows(f, rows));
    expect(col.type === "quantity" && Array.from(col.values)).toEqual([6, 0, 4]);
  });

  it("count, list, min, max and avg over a relationship", () => {
    const heater = rowFromRecord({}, { serves: [served(2, "P-1"), served(1, "P-2"), served(3, "L-4")] });
    const value = (src: string) => formulaEngine.evaluateRow(compile(src), heater);
    expect(value("count(serves)")).toEqual({ type: "quantity", kind: "count", value: 3 });
    expect(value("count(serves, {load.wsfu_total} >= 2 WSFU)")).toEqual({ type: "quantity", kind: "count", value: 2 });
    expect(value("list(serves, {mark})")).toEqual({ type: "text", value: "P-1, P-2, L-4" });
    expect(quantityOf(value("max(serves, {load.wsfu_total})"))).toBe(3);
    expect(quantityOf(value("min(serves, {load.wsfu_total})"))).toBe(1);
    expect(quantityOf(value("avg(serves, {load.wsfu_total})"))).toBe(2);
    expect(refuse("sum(serves, {voltage})")[0]?.message).toBe("Voltage values don't add up; use max(), avg() or list() instead");
  });

  it('if({load_class} = "Motor", {load} * 1.25, {load})', () => {
    const f = compile('if({load_class} = "Motor", {load} * 1.25, {load})');
    expect(f.type).toEqual(T.amps);
    const rows = [
      rowFromRecord({ load_class: "Motor", load: qty("current", 10, "A") }),
      rowFromRecord({ load_class: "Lighting", load: qty("current", 10, "A") }),
      rowFromRecord({ load_class: null, load: qty("current", 10, "A") }),
    ];
    const col = formulaEngine.evaluateColumn(f, inputsFromRows(f, rows));
    expect(col.type === "quantity" && Array.from(col.values)).toEqual([12.5, 10, NaN]);
    expect(formulaEngine.explain(f, rows[0] as RowValues).text).toBe('if("Motor" = "Motor", 10 A × 1.25, 10 A) = 12.5 A');
  });

  it("explain keeps grouping and prints empty cells", () => {
    const f = compile("({load} + 2 A) * 3 > 0.8 * {capacity_a}");
    const row = rowFromRecord({ load: qty("current", 10, "A"), capacity_a: null });
    expect(formulaEngine.explain(f, row)).toEqual({ text: "(10 A + 2 A) × 3 > 0.8 × empty = empty", value: { type: "empty" } });
  });

  it("temperatures subtract to a difference and never add", () => {
    const row = rowFromRecord({ supply_temp: qty("temperature", 120, "degF"), return_temp: qty("temperature", 100, "degF") });
    const delta = compile("{supply_temp} - {return_temp}");
    expect(delta.type).toEqual({ type: "quantity", kind: "temperature_delta", unit: "delta_degF" });
    expect(quantityOf(formulaEngine.evaluateRow(delta, row))).toBeCloseTo(qty("temperature_delta", 20, "delta_degF"), 9);
    expect(refuse("{supply_temp} + {return_temp}")[0]?.message).toBe("Can't add two temperatures; subtract them to get a difference");
    // "70 °F" compared with a temperature is 70 °F; "20 °F" taken off a temperature is a 20 °F difference.
    expect(formulaEngine.evaluateRow(compile("{supply_temp} > 110 °F"), row)).toEqual({ type: "boolean", value: true });
    expect(formulaEngine.evaluateRow(compile("{return_temp} > 110 °F"), row)).toEqual({ type: "boolean", value: false });
    expect(quantityOf(formulaEngine.evaluateRow(compile("{supply_temp} - 20 °F"), row))).toBeCloseTo(qty("temperature", 100, "degF"), 9);
  });

  it("rounds a length to a step in its own units", () => {
    const f = compile("round({length}, 1 in)");
    expect(quantityOf(formulaEngine.evaluateRow(f, rowFromRecord({ length: qty("length", 10.52, "ft") })))).toBeCloseTo(qty("length", 10.5, "ft"), 12);
    expect(quantityOf(formulaEngine.evaluateRow(compile("ceil({length}, 1 in)"), rowFromRecord({ length: qty("length", 10, "ft") })))).toBeCloseTo(qty("length", 10, "ft"), 12);
    expect(refuse("round({length})")[0]?.message).toBe("Rounding a length (ft) needs a step, like round({length}, 1 in)");
  });

  it("calls named library calculations and refuses calculations that use themselves", () => {
    const f = compile("PZ.GasDemandBtuh({own.mbh}, 0.8)");
    expect(f.type).toEqual(T.btuh);
    expect(f.dependencies.calculations).toEqual(["PZ.GasDemandBtuh"]);
    const row = rowFromRecord({ "own.mbh": qty("flow_gas_energy", 199, "MBH") });
    expect(formulaEngine.explain(f, row).text).toBe("PZ.GasDemandBtuh(199 MBH, 0.8) = 159,200 Btu/h");

    const [cycle] = refuse("PZ.A()");
    expect(cycle?.code).toBe("cycle");
    expect(cycle?.message).toContain("PZ.A uses PZ.B uses PZ.A");
    expect(refuse("PZ.GasDemandBtuh({length}, 0.8)")[0]?.message).toBe("PZ.GasDemandBtuh expects a gas input (MBH) for input, not a length (ft)");
  });

  it("looks up step tables by the largest key at or below the value", () => {
    const f = compile("lookup(PZ.DemandFactor, count(serves))");
    const value = (n: number) => formulaEngine.evaluateRow(f, rowFromRecord({}, { serves: Array.from({ length: n }, (_, i) => served(1, `P-${i}`)) }));
    expect(quantityOf(value(3))).toBe(1);
    expect(quantityOf(value(4))).toBeCloseTo(0.8, 12);
    expect(quantityOf(value(25))).toBeCloseTo(0.6, 12);
    expect(value(0)).toEqual({ type: "empty" });
    expect(f.dependencies).toEqual({ fields: [], relationships: [{ name: "serves", dependencies: { fields: [], relationships: [], tables: [], calculations: [] } }], tables: ["PZ.DemandFactor"], calculations: [] });
  });

  it("reports syntax errors with plain words and the place they happen", () => {
    expect(refuse("{own.mbh} *")[0]).toEqual({ code: "syntax", message: "The formula ends before a value", span: { start: 11, end: 11 } });
    expect(refuse("({length} + 2 ft")[0]?.message).toBe("A ( has no closing )");
    expect(refuse("3 furlongs")[0]).toEqual({ code: "unknown_unit", message: '"furlongs" is not a unit this library knows', span: { start: 2, end: 10 } });
    expect(refuse("{nope}")[0]).toEqual({ code: "unknown_field", message: 'There is no field called "nope" here', span: { start: 0, end: 6 } });
    expect(refuse("1 < 2 < 3")[0]?.message).toBe("Comparisons can't be chained; join them with and");
  });

  it("lists dependencies from the text alone and finds cycles in a graph", () => {
    expect(formulaEngine.dependenciesOf("PZ.X({a}) + sum(serves, {b} * lookup(PZ.T, {c}))")).toEqual({ ok: true, fields: ["a"], calculations: ["PZ.X"], tables: ["PZ.T"], relationships: ["serves"] });
    const graph = new Map([
      ["b", ["a"]],
      ["a", ["b"]],
      ["c", ["c"]],
      ["d", ["a"]],
    ]);
    expect(findCycles(graph)).toEqual([["a", "b"], ["c"]]);
  });

  it("refuses input columns that disagree with the schema and handles it did not compile", () => {
    const f = compile("{length} * 2");
    expect(() => formulaEngine.evaluateColumn(f, { rowCount: 1, fields: new Map([["length", { type: "quantity", kind: "area", values: new Float64Array([1]) }]]), relations: new Map() })).toThrow("Formula input {length} should hold length quantities, got area");
    expect(() => formulaEngine.evaluateRow({ source: "{length}", type: T.ft, dependencies: f.dependencies }, rowFromRecord({}))).toThrow("not compiled by this formula engine");
  });

  it("is deterministic: the same bits across 1,000 runs", () => {
    const source = 'if({load_class} = "Motor", {load} * 1.25, {load}) / sqrt(3) + max({capacity_a}, 2 A) * 0.1';
    const rows = Array.from({ length: 257 }, (_, i) =>
      rowFromRecord({ load_class: i % 3 === 0 ? "Motor" : "Lighting", load: qty("current", 1 + i / 7, "A"), capacity_a: i % 5 === 0 ? null : qty("current", i / 3, "A") }),
    );
    const first = compile(source);
    const inputs = inputsFromRows(first, rows);
    const baseline = formulaEngine.evaluateColumn(first, inputs);
    if (baseline.type !== "quantity") throw new Error("expected quantities");
    const bytes = Buffer.from(baseline.values.buffer).toString("base64");
    for (let run = 0; run < 1000; run++) {
      const f = run % 2 === 0 ? first : compile(source);
      const col = formulaEngine.evaluateColumn(f, run % 3 === 0 ? inputsFromRows(f, rows) : inputs);
      if (col.type !== "quantity") throw new Error("expected quantities");
      expect(Buffer.from(col.values.buffer).toString("base64")).toBe(bytes);
    }
  });
});
