/**
 * @jest-environment node
 *
 * Round 12 lane P12 step 2: gas sizing as a live sheet. A synthetic,
 * 7329-shaped gas main (a meter, one Schedule 40 run, 1,950 MBH at its far
 * end) and a firm sizing table built in the test (made-up numbers, no code
 * table text). The sheet reads the run's sizing length and the flow it
 * carries from the model, marks the table cell that decided the size
 * (250 ft × 1-1/4 in = 2,140 CFH), and checks the margin over the load
 * against the firm's 20 % main margin: 1-1/4 in carries the load but fails
 * the margin. Shortening the run moves the marked cell. With no table set,
 * the sheet says to add one instead of guessing.
 *
 * Fails on round 11's code: there was no calc sheet point, no gas sizing
 * template and no `gas.zone_longest` / `gas.carries_cfh` fields.
 */
import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState, type PartTypeDefinition, type RunSize } from "@permitzip/bim-kernel";
import { placeCalcSheet, renderCalcSheet, type CalcTable, type CalcTableSource } from "@permitzip/bim-kernel/calc-sheets";
import { GAS_SIZING_TABLE_SLOT, GAS_SIZING_TEMPLATE_ID, gasMeterNote } from "../src";

const FT = 304.8;
const IN = 25.4;
const builtin = { kind: "builtin", libraryVersion: "test" } as const;
const box = { geometry: [{ kind: "box" as const, center: [0, 0, 100] as [number, number, number], size: [200, 200, 200] as [number, number, number] }], symbol: [{ kind: "rect" as const, center: [0, 0] as [number, number], size: [200, 200] as [number, number] }] };

const meter: PartTypeDefinition = {
  familyName: "Gas meter",
  typeName: "Outlet",
  category: "mechanical_equipment",
  typeParams: [],
  typeValues: {},
  instanceParams: [],
  connectors: [{ id: "g", label: "Gas", domain: "pipe", systemKind: "natural_gas", position: [0, 0, 0], direction: [1, 0, 0], shape: "round", diameter: 0.5 * IN, flowDirection: "out" }],
  ...box,
  tagFields: ["mark"],
  source: builtin,
};

function gasMain(lengthFt: number): ModelState {
  const size: RunSize = { shape: "pipe", nominalMm: 1.25 * IN, material: "black_steel", spec: "sch40" };
  const cmds: Command[] = [
    { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
    { type: "place_part", partId: "gm", typeId: "t:gm", partType: meter, levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 3000, mark: "GM-1" },
    { type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size, elevationMm: 3000, system: { id: "sys-gas", kind: "natural_gas", name: "Gas" }, points: [{ x: lengthFt * FT, y: 0 }], from: { kind: "part", partId: "gm", connectorId: "g" } },
    { type: "create_load_point", points: [{ hostId: "main-s1", port: "end", values: { mbh: 1950 }, mark: "K1" }] },
    { type: "set_system_design", systemId: "sys-gas", design: { pipe: { gasType: "natural", inletPressureInWc: 7, allowableDropInWc: 0.5 } } },
  ];
  let m: ModelState = { modelId: "p12-gas", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  for (const command of cmds) {
    const d = planCommit(m, [], { idempotencyKey: `p12-gas-${lengthFt}-${m.revision}`, baseRevision: m.revision, actor: { id: "quinn", name: "Quinn", kind: "human" }, command }, () => "2026-11-03T00:00:00.000Z");
    if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
    m = d.model;
  }
  return m;
}

/** A firm's table (synthetic numbers): CFH by length row and size column. */
const TABLE: CalcTable = {
  id: "firm-gas-low-pressure",
  label: "Firm gas table, 0.5 in. w.c. drop",
  rowHeading: { label: "Length", unit: "ft" },
  columnHeading: { label: "Size", unit: "in" },
  rows: [100, 150, 200, 250, 300],
  columns: ["1", "1-1/4", "1-1/2", "2"],
  values: [
    [1400, 2900, 4300, 8300],
    [1100, 2300, 3500, 6700],
    [950, 2000, 3000, 5700],
    [840, 2140, 2700, 5100],
    [760, 1600, 2400, 4600],
  ],
  citation: { section: "Firm table", edition: "test" },
};
const tables = (t: CalcTable | null): CalcTableSource => ({ table: (slot) => (slot === GAS_SIZING_TABLE_SLOT ? t : null) });

function place(m: ModelState, t: CalcTable | null) {
  const r = placeCalcSheet(m, GAS_SIZING_TEMPLATE_ID, { subjectId: "main-s1" as never }, { tables: tables(t), limits: {} });
  if ("refused" in r) throw new Error(r.refused);
  return r;
}

describe("p12-gas-sheet-governing-cell", () => {
  it("marks 250 ft × 1-1/4 in = 2,140 CFH and fails the firm's 20 % margin", () => {
    const { spec, evaluation } = place(gasMain(250), TABLE);
    expect(evaluation.values.length).toBe(250);
    expect(evaluation.values.load).toBe(1950);
    expect(evaluation.governing).toEqual([expect.objectContaining({ lookup: "capacity", rowLabel: "250 ft", columnLabel: "1-1/4", value: 2140 })]);
    expect(evaluation.values.size).toBe(1.25);
    const margin = evaluation.checks.find((c) => c.key === "margin_check");
    expect(margin?.pass).toBe(false);
    expect(margin?.limitId).toBe("plumbing_gas.gas_main_margin");
    expect(gasMeterNote(evaluation)).toBe("Gas meter: 1,950 CFH (1,950 MBH) at 7 in. w.c.");
    const text = renderCalcSheet(spec, evaluation).text;
    expect(text).toMatch(/FAIL: Capacity over the load 9\.7\d* % under/);
    expect(text).toContain("250 ft");
    expect(text).toContain("1-1/4");
  });

  it("shortening the run moves the marked cell", () => {
    const long = place(gasMain(250), TABLE).evaluation.governing[0];
    const short = place(gasMain(140), TABLE).evaluation.governing[0];
    expect(long?.rowIndex).toBe(3);
    expect(short?.rowIndex).toBe(1);
    expect(short?.rowLabel).toBe("150 ft");
    expect(short?.value).toBe(2300);
  });

  it("with no table set, says to add one and never guesses a size", () => {
    const { evaluation } = place(gasMain(250), null);
    expect(evaluation.values.size).toBeNull();
    expect(evaluation.governing).toEqual([]);
    expect(evaluation.missing.join(" ")).toMatch(/add the table this sheet reads \(gas_sizing_table\)/);
  });

  it("refuses a subject that isn't a gas pipe, in words", () => {
    const m = gasMain(100);
    expect(placeCalcSheet(m, GAS_SIZING_TEMPLATE_ID, {}, { tables: tables(TABLE), limits: {} })).toEqual({ refused: "Pick the gas pipe this sheet sizes" });
  });
});
