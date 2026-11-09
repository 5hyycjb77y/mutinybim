import {
  add,
  addMeasures,
  aggregate,
  aggregateMeasures,
  convert,
  findUnit,
  formatMeasure,
  formatQuantity,
  fromSI,
  KIND_IDS,
  KIND_UNITS,
  KINDS,
  measure,
  measureIn,
  parseQuantity,
  PROFILE_METRIC_MM,
  PROFILE_US_DECIMAL_FEET,
  PROFILE_US_FEET_INCHES,
  qty,
  sameDimension,
  subtractMeasures,
  to,
  toSI,
  UNIT_CODES,
  UnitError,
  unitLabel,
  UNITS,
  type Quantity,
} from "@permitzip/bim-units";

function refusal(fn: () => unknown): UnitError {
  try {
    fn();
  } catch (err) {
    if (err instanceof UnitError) return err;
    throw err;
  }
  throw new Error("expected a UnitError");
}

const ft = (v: number) => qty("length", v, "ft");

describe("registry", () => {
  it("defines every kind and unit code", () => {
    for (const k of KIND_IDS) expect(KINDS[k]?.id).toBe(k);
    for (const u of UNIT_CODES) expect(UNITS[u]?.code).toBe(u);
  });

  it("writes each kind only in units of its dimension", () => {
    for (const k of KIND_IDS) {
      for (const u of KIND_UNITS[k]) {
        expect({ kind: k, unit: u, same: sameDimension(KINDS[k].dimension, UNITS[u].dimension) }).toEqual({ kind: k, unit: u, same: true });
      }
    }
  });

  it("lets every kind total by its own default rule", () => {
    for (const k of KIND_IDS) expect(KINDS[k].aggregation.allowed).toContain(KINDS[k].aggregation.default);
  });

  it("round-trips every built-in unit within 1e-9", () => {
    for (const u of UNIT_CODES) {
      for (const v of [1, 123.456, -7.5, 0.001, 98765.4321]) {
        const back = fromSI(toSI(v, u), u);
        expect({ u, err: Math.abs(back - v) / Math.abs(v) <= 1e-9 }).toEqual({ u, err: true });
      }
    }
  });
});

describe("conversion", () => {
  it("199 MBH is 199,000 Btu/h is 58.32 kW", () => {
    const input = qty("flow_gas_energy", 199, "MBH");
    expect(to(input, "Btu/h")).toBeCloseTo(199_000, 6);
    expect(to(input, "kW")).toBeCloseTo(58.32, 2);
    expect(formatQuantity(input, "flow_gas_energy", PROFILE_US_DECIMAL_FEET, { unit: "Btu/h", precision: { kind: "decimals", digits: 0 } })).toBe("199,000 Btu/h");
    expect(formatQuantity(input, "flow_gas_energy", PROFILE_METRIC_MM, { precision: { kind: "decimals", digits: 2 } })).toBe("58.32 kW");
  });

  it("converts psi to inches of water column and back", () => {
    expect(convert(1, "psi", "in_wc")).toBeCloseTo(27.68, 2);
    expect(convert(27.679904, "in_wc", "psi")).toBeCloseTo(1, 6);
    expect(to(qty("pressure", 0.5, "in_wc"), "Pa")).toBeCloseTo(124.544, 3);
  });

  it("converts sprinkler K-factors between US and metric", () => {
    expect(convert(5.6, "gpm/psi^0.5", "L/min/bar^0.5")).toBeCloseTo(80.73, 2);
    expect(convert(80.73, "L/min/bar^0.5", "gpm/psi^0.5")).toBeCloseTo(5.6, 3);
  });

  it("converts temperatures with their offsets", () => {
    expect(to(qty("temperature", 72, "degF"), "degC")).toBeCloseTo(22.222, 3);
    expect(to(qty("temperature_delta", 20, "delta_degF"), "K")).toBeCloseTo(11.111, 3);
  });

  it("refuses conversions between units that share a dimension but not a meaning", () => {
    expect(refusal(() => convert(1, "WSFU", "DFU")).code).toBe("kind_mismatch");
    expect(refusal(() => convert(1, "J", "N.m")).code).toBe("kind_mismatch");
    expect(refusal(() => convert(70, "degF", "delta_degF")).code).toBe("kind_mismatch");
    expect(refusal(() => convert(1, "ft", "psi")).code).toBe("dimension_mismatch");
  });

  it("refuses a unit the kind can't be written in", () => {
    // @ts-expect-error psi is not an airflow unit
    const err = refusal(() => qty("flow_air", 5, "psi"));
    expect(err.code).toBe("unit_not_in_kind");
    expect(err.message).toContain("Airflow can't be written in pounds per square inch");
  });
});

describe("kinds keep meanings apart", () => {
  it("refuses WSFU + DFU at compile time and at runtime", () => {
    const supply = qty("fixture_units_supply", 2, "WSFU");
    const drainage = qty("fixture_units_drainage", 3, "DFU");
    expect(add(supply, supply)).toBe(4);
    const compileTimeOnly = (): number =>
      // @ts-expect-error supply and drainage fixture units never add
      add(supply, drainage);
    expect(typeof compileTimeOnly).toBe("function");

    const err = refusal(() => addMeasures(measure("fixture_units_supply", 2, "WSFU"), measure("fixture_units_drainage", 3, "DFU")));
    expect(err.code).toBe("kind_mismatch");
    expect(err.message).toBe("Water supply fixture units can't be added to drainage fixture units.");
  });

  it("refuses adding absolute temperatures but allows differences", () => {
    const supply = measure("temperature", 140, "degF");
    const returnT = measure("temperature", 120, "degF");
    expect(refusal(() => addMeasures(supply, returnT)).code).toBe("aggregation_refused");
    const delta = subtractMeasures(supply, returnT);
    expect(delta.kind).toBe("temperature_delta");
    expect(measureIn(delta, "delta_degF")).toBeCloseTo(20, 9);
    expect(measureIn(addMeasures(returnT, delta), "degF")).toBeCloseTo(140, 9);
    const t: Quantity<"temperature"> = qty("temperature", 70, "degF");
    // @ts-expect-error absolute temperatures don't add
    expect(() => add(t, t)).not.toThrow();
  });

  it("totals by each kind's rule", () => {
    const loads = [qty("fixture_units_supply", 1.5, "WSFU"), qty("fixture_units_supply", 2, "WSFU")];
    expect(aggregate("fixture_units_supply", loads)).toBe(3.5);
    expect(KINDS.fixture_units_supply.aggregation.demand).toBe("water_supply");
    const pressures = [qty("pressure", 5, "in_wc"), qty("pressure", 7, "in_wc")];
    expect(aggregate("pressure", pressures)).toBeNull();
    expect(to(aggregate("pressure", pressures, "max") as Quantity<"pressure">, "in_wc")).toBeCloseTo(7, 9);
    expect(refusal(() => aggregate("pressure", pressures, "sum")).code).toBe("aggregation_refused");
    expect(refusal(() => aggregateMeasures("flow_air", [measure("flow_air", 100, "cfm"), measure("flow_liquid", 5, "gpm")])).code).toBe("kind_mismatch");
  });
});

describe("display", () => {
  it("prints feet and inches to 1/16\"", () => {
    expect(formatQuantity(ft(10.5), "length", PROFILE_US_FEET_INCHES)).toBe(`10'-6"`);
    expect(formatQuantity(ft(10.52), "length", PROFILE_US_FEET_INCHES)).toBe(`10'-6 1/4"`);
    expect(formatQuantity(ft(11.999), "length", PROFILE_US_FEET_INCHES)).toBe(`12'-0"`);
    expect(formatQuantity(ft(0.5), "length", PROFILE_US_FEET_INCHES)).toBe(`0'-6"`);
    expect(formatQuantity(ft(-2.25), "length", PROFILE_US_FEET_INCHES)).toBe(`-2'-3"`);
    expect(formatQuantity(ft(1250), "length", PROFILE_US_FEET_INCHES)).toBe(`1,250'-0"`);
    expect(formatQuantity(ft(10.52), "length", PROFILE_US_DECIMAL_FEET)).toBe("10.52 ft");
    expect(formatQuantity(ft(10.5), "length", PROFILE_METRIC_MM)).toBe("3 200 mm");
  });

  it("prints inch fractions and stations", () => {
    const pipe = qty("length", 1.5, "in");
    expect(formatQuantity(pipe, "length", PROFILE_US_FEET_INCHES, { unit: "in", format: "inches_fraction", precision: { kind: "fraction", denominator: 8 } })).toBe(`1 1/2"`);
    expect(formatQuantity(qty("length", 0.75, "in"), "length", PROFILE_US_FEET_INCHES, { unit: "in", format: "inches_fraction", precision: { kind: "fraction", denominator: 8 } })).toBe(`3/4"`);
    const station = { unit: "ft", format: "station", precision: { kind: "decimals", digits: 2 } } as const;
    expect(formatQuantity(ft(1250), "length", PROFILE_US_DECIMAL_FEET, station)).toBe("12+50.00");
    expect(formatQuantity(ft(1205.5), "length", PROFILE_US_DECIMAL_FEET, station)).toBe("12+05.50");
    expect(formatQuantity(qty("length", 1250, "m"), "length", PROFILE_METRIC_MM, { unit: "m", format: "station", precision: { kind: "decimals", digits: 3 } })).toBe("1+250.000");
  });

  it("places labels per profile and kind", () => {
    expect(formatMeasure(measure("money", 1234.5, "USD"), PROFILE_US_DECIMAL_FEET)).toBe("$1,234.50");
    expect(formatMeasure(measure("money", -20, "USD"), PROFILE_US_DECIMAL_FEET)).toBe("-$20.00");
    expect(formatMeasure(measure("ratio", 45, "%"), PROFILE_US_DECIMAL_FEET)).toBe("45%");
    expect(formatMeasure(measure("temperature", 72, "degF"), PROFILE_US_DECIMAL_FEET)).toBe("72°F");
    expect(formatMeasure(measure("flow_air", 12500, "cfm"), PROFILE_US_DECIMAL_FEET)).toBe("12,500 CFM");
    expect(formatMeasure(measure("flow_air", 12500, "cfm"), PROFILE_US_DECIMAL_FEET, { label: "heading" })).toBe("12,500");
    expect(unitLabel("flow_air", PROFILE_US_DECIMAL_FEET)).toBe("CFM");
    expect(unitLabel("length", PROFILE_US_FEET_INCHES)).toBe("");
    expect(formatMeasure(measure("fixture_units_drainage", 3, "DFU"), PROFILE_US_DECIMAL_FEET)).toBe("3.0 DFU");
  });

  it("refuses a display unit the kind can't use", () => {
    expect(refusal(() => formatMeasure(measure("flow_air", 1, "cfm"), PROFILE_US_DECIMAL_FEET, { unit: "gpm" })).code).toBe("unit_not_in_kind");
    expect(refusal(() => formatMeasure(measure("flow_air", 1, "cfm"), PROFILE_US_DECIMAL_FEET, { format: "feet_inches" })).code).toBe("unit_not_in_kind");
  });
});

describe("parsing", () => {
  it("reads station 12+50.00 as 1,250 ft", () => {
    expect(to(parseQuantity("12+50.00", "length", PROFILE_US_DECIMAL_FEET), "ft")).toBeCloseTo(1250, 9);
    expect(to(parseQuantity("1+250.000", "length", PROFILE_METRIC_MM), "m")).toBeCloseTo(1250, 9);
  });

  it("reads feet-inches, inch fractions and plain numbers", () => {
    expect(to(parseQuantity(`10'-6 1/4"`, "length"), "ft")).toBeCloseTo(10.5208333, 6);
    expect(to(parseQuantity(`10' 6"`, "length"), "in")).toBeCloseTo(126, 9);
    expect(to(parseQuantity(`1 1/2"`, "length"), "in")).toBeCloseTo(1.5, 9);
    expect(to(parseQuantity("3 ft", "length"), "mm")).toBeCloseTo(914.4, 9);
    expect(to(parseQuantity("1200", "length", PROFILE_METRIC_MM), "mm")).toBeCloseTo(1200, 9);
    expect(to(parseQuantity("10.5", "length", PROFILE_US_DECIMAL_FEET), "ft")).toBeCloseTo(10.5, 9);
  });

  it("reads units by code, symbol or alias for the kind", () => {
    expect(to(parseQuantity("199 MBH", "flow_gas_energy"), "Btu/h")).toBeCloseTo(199_000, 6);
    expect(to(parseQuantity("1,250.5 CFM", "flow_air"), "cfm")).toBeCloseTo(1250.5, 9);
    expect(to(parseQuantity("2 in. w.c.", "pressure"), "in_wc")).toBeCloseTo(2, 9);
    expect(to(parseQuantity("$1,200", "money"), "USD")).toBe(1200);
    expect(findUnit("°F", "temperature_delta")).toBe("delta_degF");
    expect(findUnit("°F", "temperature")).toBe("degF");
  });

  it("names the fault in plain words", () => {
    expect(refusal(() => parseQuantity("5 psi", "flow_air")).message).toBe("Airflow can't be written in pounds per square inch.");
    expect(refusal(() => parseQuantity("3 bananas", "count")).code).toBe("unknown_unit");
    expect(refusal(() => parseQuantity("", "length")).code).toBe("parse");
    expect(refusal(() => parseQuantity("abc", "length")).message).toContain("Start with a number");
  });
});
