import { qty } from "@permitzip/bim-units";
import { formulaEngine, type ColumnarInputs, type FieldSignature, type FormulaSchema, type ValueColumn } from "../src";

/**
 * `schedule.formula.column.10k` (SCHEDULES-PLAN §11): one compiled formula over
 * a 10,000-row column, three variants. Here: each variant compiles once and
 * answers every row of the column in one call, the same as the rule written
 * out row by row. The 2 / 5 ms budget is Perf Gate (BIM) row
 * schedule.formula.column.10k (scripts/perf/mutinybim/schedules.ts), measured
 * in plain Node and not multiplied on CI; never raise it to get green.
 */
const ROWS = 10_000;

const FIELDS: Readonly<Record<string, FieldSignature>> = {
  "own.mbh": { type: { type: "quantity", kind: "flow_gas_energy", unit: "MBH" } },
  load: { type: { type: "quantity", kind: "current", unit: "A" } },
  capacity_a: { type: { type: "quantity", kind: "current", unit: "A" } },
  load_class: { type: { type: "text" } },
};

const schema: FormulaSchema = { field: (path) => FIELDS[path], relationship: () => undefined };

const mbh = new Float64Array(ROWS);
const load = new Float64Array(ROWS);
const capacity = new Float64Array(ROWS);
const classes: (string | null)[] = [];
for (let i = 0; i < ROWS; i++) {
  mbh[i] = qty("flow_gas_energy", 40 + (i % 160), "MBH");
  load[i] = qty("current", 5 + (i % 40), "A");
  capacity[i] = i % 97 === 0 ? NaN : qty("current", 20 + (i % 30), "A");
  classes.push(i % 4 === 0 ? "Motor" : "Lighting");
}
const data: ColumnarInputs = {
  rowCount: ROWS,
  fields: new Map<string, ValueColumn>([
    ["own.mbh", { type: "quantity", kind: "flow_gas_energy", values: mbh }],
    ["load", { type: "quantity", kind: "current", values: load }],
    ["capacity_a", { type: "quantity", kind: "current", values: capacity }],
    ["load_class", { type: "text", values: classes }],
  ]),
  relations: new Map(),
};

const hundredAmps = qty("current", 100, "A");

describe("schedule.formula.column.10k", () => {
  it.each([
    ["scale", "{own.mbh} * 1000", (i: number) => (mbh[i] as number) * 1000],
    ["motor 125%", 'if({load_class} = "Motor", {load} * 1.25, {load})', (i: number) => (classes[i] === "Motor" ? (load[i] as number) * 1.25 : (load[i] as number))],
    [
      "highlight",
      "{load} > 0.8 * coalesce({capacity_a}, 100 A) and not ({load_class} = \"Spare\")",
      (i: number) => ((load[i] as number) > 0.8 * (Number.isNaN(capacity[i]) ? hundredAmps : (capacity[i] as number)) && classes[i] !== "Spare" ? 1 : 0),
    ],
  ])("%s answers all 10,000 rows in one call, as the rule written out row by row", (_label, source, expected) => {
    const compiled = formulaEngine.compile(source, schema);
    if (!compiled.ok) throw new Error(compiled.errors.map((e) => e.message).join("; "));
    const column = formulaEngine.evaluateColumn(compiled.formula, data);
    expect(column.values).toHaveLength(ROWS);
    let wrong = 0;
    for (let i = 0; i < ROWS; i++) {
      const got = column.values[i] as number;
      const want = expected(i);
      if (Math.abs(got - want) > 1e-9 * Math.max(1, Math.abs(want))) wrong += 1;
    }
    expect(wrong).toBe(0);
  });
});
