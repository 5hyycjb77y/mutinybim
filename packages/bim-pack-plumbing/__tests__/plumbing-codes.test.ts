/**
 * @jest-environment node
 *
 * The plumbing and fuel gas packs against the issued set for project
 * 7492 (Sample Market): the pressure loss report (7.41 psi), the
 * restaurant curve (43.25 WSFU → 48 gpm), the four ASHRAE curves as printed,
 * the propane Schedule 40 table from the code library and the 402.4 equation
 * beside it, longest vs branch length, the water heater check; plus edition
 * resolution from the Code Map and the kernel accepting the pack's design.
 */
import { pipeDesignSchema } from "@permitzip/bim-kernel";
import { builtinCalcRegistry, bundledGasTables, findGasTable, lowPressureCfh, ipcEdition, parseGasCapacityTable, proposeCodeTableFromCsv, VFGC_2021_GAS_TABLES, type CalcRun } from "@permitzip/bim-calc";
import { ASHRAE_CURVES, plumbingDesignFromPack, readCurve, resolveDemandCurve, resolveSizingMode } from "../src";

const registry = builtinCalcRegistry();

function run(calc: string, inputs: unknown, extra: Record<string, unknown> = { state: "VA" }): CalcRun {
  const r = registry.run({ calc, inputs, ...extra });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}
const value = (r: CalcRun, key: string) => r.values.find((v) => v.key === key)?.value;
const errors = (r: CalcRun) => r.issues.filter((i) => i.severity === "error");

describe("which plumbing / fuel gas edition", () => {
  it("a Virginia project resolves to the VPC 2021 (2021 IPC) with a cited step", () => {
    const r = run("plumbing.size_drain", { role: "building_drain", dfu: 20 });
    expect(r.code).toEqual({ family: "ipc", edition: "2021", packVersion: expect.any(String) });
    expect(r.steps[0]).toEqual(expect.objectContaining({ label: "Code edition", detail: "Virginia adopted the 2021 IPC as the Virginia Plumbing Code (2021 IPC as amended by Virginia)" }));
    expect(r.citations.map((c) => c.text)).toEqual(expect.arrayContaining(["Virginia Plumbing Code (VPC): 2021 IPC, effective 2024-01-18 (PermitZIP Code Map jurisdiction-codes.json (last updated 2026-02-18))"]));
    expect(r.citations.map((c) => c.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^VPC 2021 Table 710\.1\(1\) \(2021 IPC as amended by Virginia, PermitZIP code library\)$/)]));
  });

  it("a Virginia gas run resolves to the VFGC 2021", () => {
    const r = run("plumbing.size_gas", registry.get("plumbing.size_gas")?.info.example);
    expect(r.code?.family).toBe("ifgc");
    expect(r.steps[0]?.detail).toBe('Virginia adopted the 2021 IFGC as the Virginia Fuel Gas Code (Statewide only; use "VFGC" in deliverables, never "IFGC")');
  });

  it("a state not on file, or one with no fuel gas code listed, is told to say which edition applies", () => {
    expect(registry.run({ calc: "plumbing.size_drain", inputs: { role: "stack", dfu: 10 }, state: "TX" })).toEqual({ ok: false, reason: expect.stringMatching(/^No plumbing code adoption is on file for TX \(on file: VA, MD, DC\)\. Say which edition applies/) });
    expect(registry.run({ calc: "plumbing.size_gas", inputs: registry.get("plumbing.size_gas")?.info.example, state: "MD" })).toEqual({ ok: false, reason: expect.stringMatching(/^No fuel gas code adoption is on file for MD \(on file: VA\)/) });
    expect(registry.run({ calc: "plumbing.size_drain", inputs: { role: "stack", dfu: 10 } })).toEqual({ ok: false, reason: expect.stringMatching(/^Say which plumbing code edition applies/) });
  });

  it("an edition the library doesn't hold is refused by name, and a non-Virginia 2021 IPC says its values are Virginia's", () => {
    expect(registry.run({ calc: "plumbing.size_drain", inputs: { role: "stack", dfu: 10 }, projectAdoptions: { plumbing: { codeName: "IPC", edition: "2018", status: "confirmed" } } })).toEqual({ ok: false, reason: expect.stringMatching(/2018 IPC; the code library holds the 2021 edition only/) });
    const md = run("plumbing.size_drain", { role: "stack", dfu: 10 }, { state: "MD" });
    expect(md.citations.map((c) => c.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^MPC 2021 Table 710\.1\(2\) \(values from the Virginia adoption of the 2021 IPC .*check local amendments\)$/)]));
  });
});

describe("Example A pressure loss report (7492, sheet P1)", () => {
  const inputs = { supply: { kind: "design_minimum", psi: 50 }, meter_loss_psi: 4.5, critical_fixture_psi: 25, tap_loss_psi: 0.28, highest_fixture_height_ft: 7, static_head_psi_per_ft: 0.43, backflow_loss_psi: 9.8, backflow_device: "RPZ", total_wsfu: 43.25, design_gpm: 48 };

  it("50 − 4.5 − 25 − 0.28 − 3.01 − 9.8 leaves 7.41 psi for friction, each line cited", () => {
    const r = run("plumbing.pressure_report", inputs);
    expect(errors(r)).toEqual([]);
    expect(value(r, "static_head_psi")).toBe(3.01);
    expect(value(r, "available_psi")).toBe(7.41);
    for (const v of r.values) expect([v.key, v.cite.length > 0]).toEqual([v.key, true]);
    expect(r.values.find((v) => v.key === "fixture_psi")?.cite.map((c) => c.text)).toEqual(["VPC 2021 Table 604.3, highest pressure required at a fixture (2021 IPC as amended by Virginia, PermitZIP code library)"]);
    expect(r.issues).toEqual([expect.objectContaining({ severity: "info", message: expect.stringMatching(/^A flow test is required/) })]);
  });

  it("the critical fixture can be named from Table 604.3 instead", () => {
    const { critical_fixture_psi: _drop, ...rest } = inputs;
    const r = run("plumbing.pressure_report", { ...rest, critical_fixture: "Urinal, valve", developed_length_ft: 120 });
    expect(value(r, "fixture_psi")).toBe(25);
    expect(value(r, "allowable_psi_per_100ft")).toBe(6.175);
  });
});

describe("demand curves", () => {
  it("Curve A (restaurants) at 43.25 WSFU reads the sheet's 48 gpm; the old fit read 23.4", () => {
    const r = run("plumbing.hunter_demand", { wsfu: 43.25, wsfu_cold: 37, wsfu_hot: 15.75, building_type: "restaurant" }, {});
    expect(value(r, "design_gpm")).toBe(48);
    expect(value(r, "curve")).toBe("Curve A: restaurants");
    expect(value(r, "legacy_fit_gpm")).toBe(23.4);
    expect(r.steps.map((s) => s.label)).toEqual(["Curve", "Total", "Cold water", "Hot water", "Compared with the old fit"]);
    const chart = (r.detail as { chart: { curves: unknown[]; operatingPoint: unknown } }).chart;
    expect(chart.curves).toHaveLength(4);
    expect(chart.operatingPoint).toEqual({ wsfu: 43.25, gpm: 48 });
  });

  // Read off the printed chart (±1.5 gpm): the four curves the issued sheet shows.
  it.each([
    ["ashrae_a", 0, 21], ["ashrae_a", 100, 67], ["ashrae_a", 200, 90], ["ashrae_a", 250, 100],
    ["ashrae_b", 0, 10], ["ashrae_b", 100, 34], ["ashrae_b", 250, 50], ["ashrae_b", 400, 64.5],
    ["ashrae_c", 0, 7.5], ["ashrae_c", 100, 26], ["ashrae_c", 250, 39], ["ashrae_c", 400, 46.5],
    ["ashrae_d", 0, 5], ["ashrae_d", 100, 16.5], ["ashrae_d", 250, 26], ["ashrae_d", 400, 31],
  ] as const)("%s at %d WSFU reads about %d gpm, as printed", (id, wsfu, gpm) => {
    const g = wsfu === 0 ? ASHRAE_CURVES[id].points[0]?.gpm ?? NaN : readCurve(ASHRAE_CURVES[id], wsfu).gpm;
    expect(Math.abs(g - gpm)).toBeLessThanOrEqual(1.5);
  });

  it("every curve rises, and A > B > C > D across the chart", () => {
    for (const c of Object.values(ASHRAE_CURVES)) for (let i = 1; i < c.points.length; i++) expect((c.points[i]?.gpm ?? 0) >= (c.points[i - 1]?.gpm ?? 0)).toBe(true);
    for (const fu of [10, 50, 100, 200, 250]) {
      const [a, b, cc, d] = (["ashrae_a", "ashrae_b", "ashrae_c", "ashrae_d"] as const).map((id) => readCurve(ASHRAE_CURVES[id], fu).gpm);
      expect([(a ?? 0) > (b ?? 0), (b ?? 0) > (cc ?? 0), (cc ?? 0) > (d ?? 0)]).toEqual([true, true, true]);
    }
  });

  it("past a curve's printed range it warns; IPC Appendix E needs the firm's import", () => {
    expect(run("plumbing.hunter_demand", { wsfu: 300, curve: "ashrae_a" }, {}).issues).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringMatching(/past Curve A: restaurants's last point \(250 WSFU\)/) })]);
    expect(errors(run("plumbing.hunter_demand", { wsfu: 40, curve: "ipc_e_tank" }, {}))).toEqual([expect.objectContaining({ message: expect.stringMatching(/^IPC Appendix E \(Table E103\.3\(3\)\) is not in the code library/) })]);
    const firm = run("plumbing.hunter_demand", { wsfu: 45, curve: "ipc_e_tank", firm_curve_points: [{ wsfu: 40, gpm: 26 }, { wsfu: 50, gpm: 29 }], firm_curve_note: "firm import" }, {});
    expect(value(firm, "design_gpm")).toBe(27.5);
  });

  it("defaults by building type, editable per project and per system; a project with no type is asked", () => {
    expect(resolveDemandCurve({ sizing_mode: "check", building_type: "office" })).toEqual(expect.objectContaining({ from: "building_type", curve: expect.objectContaining({ id: "ashrae_d" }) }));
    expect(resolveDemandCurve({ sizing_mode: "check", building_type: "office", demand_curve: "ashrae_b" })).toEqual(expect.objectContaining({ from: "project", curve: expect.objectContaining({ id: "ashrae_b" }) }));
    expect(resolveDemandCurve({ sizing_mode: "check", building_type: "office" }, { demand_curve: "ashrae_c" })).toEqual(expect.objectContaining({ from: "system" }));
    expect(resolveDemandCurve({ sizing_mode: "check" })).toEqual({ reason: expect.stringMatching(/^Choose a demand curve/) });
  });
});

describe("auto-sizing setting", () => {
  it("is off (check and suggest) unless the project or the system turns it on", () => {
    expect(resolveSizingMode(null, null)).toEqual({ mode: "check", from: "default" });
    expect(resolveSizingMode({ sizing_mode: "auto" }, null)).toEqual({ mode: "auto", from: "project" });
    expect(resolveSizingMode({ sizing_mode: "auto" }, { sizing_mode: "check" })).toEqual({ mode: "check", from: "system" });
  });
});

describe("gas: the code library's tables and the 402.4 equation", () => {
  it("every bundled 402.4(n) table parses; the library's odd cell in 402.4(36) is reported, not fixed", () => {
    const tables = bundledGasTables();
    expect(tables.map((t) => t.tableId)).toEqual(VFGC_2021_GAS_TABLES.map((s) => s.citation.replace("TABLE", "Table")));
    const t36 = tables.find((t) => t.tableId === "Table 402.4(36)");
    expect(t36?.issues).toEqual([{ row: 17, column: 6, message: "At 400 ft, column 7 reads 12000, out of order with the lengths around it" }]);
    for (const t of tables.filter((x) => x.tableId !== "Table 402.4(36)")) expect([t.tableId, t.issues]).toEqual([t.tableId, []]);
  });

  // The natural gas tables sit within about 1% of the equation; the propane
  // tables sit a steady ~1.8% below it at 2,516 Btu/cf (as if drawn at about
  // 2,470 Btu/cf) plus up to 0.5% from three-figure rounding, so the widest
  // gap on the 100 ft row is 2.3% (1-1/2 in. and 4 in.). The calc sizes from
  // the table and reports the equation beside it.
  it("402.4(28) undiluted propane, Sch 40, 11 in. w.c., 0.5 in. drop: the 100 ft row, and the equation beside it (2% on the sizes used, 2.3% at most)", () => {
    const t = findGasTable(bundledGasTables(), "propane", "sch40", { value: 11, unit: "in_wc", lessThan: false }, { value: 0.5, unit: "in_wc", lessThan: false });
    expect(t?.tableId).toBe("Table 402.4(28)");
    const row = t?.rows.values.indexOf(100) ?? -1;
    expect(t?.cells[row]).toEqual([84, 175, 330, 677, 1010, 1950, 3110, 5500, 11200]);
    const gaps = (t?.sizes ?? []).map((s, k) => {
      const eqMbh = (lowPressureCfh(s.idIn ?? 0, 100, 0.5, "propane") * 2516) / 1000;
      return Math.abs(eqMbh / (t?.cells[row]?.[k] ?? 1) - 1) * 100;
    });
    expect(gaps.slice(0, 4).every((g) => g < 2)).toBe(true);
    expect(Math.max(...gaps)).toBeLessThan(2.4);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    expect(mean).toBeGreaterThan(1.5);
    expect(mean).toBeLessThan(2.1);
  });

  it("The issued cook line on 402.4(28) at 100 ft longest length: sizes from the table, the equation agreeing", () => {
    const r = run("plumbing.size_gas", {
      gas: "propane",
      material: "sch40",
      inlet: { value: 11, unit: "in_wc" },
      drop: { value: 0.5, unit: "in_wc" },
      method: "longest_length",
      segments: [
        { id: "manifold", parent: null, length_ft: 7 },
        { id: "K09a", parent: "manifold", length_ft: 93, load_mbh: 120, label: "K09 fryer" },
        { id: "K09b", parent: "manifold", length_ft: 90, load_mbh: 120, label: "K09 fryer" },
        { id: "K08", parent: "manifold", length_ft: 80, load_mbh: 220, label: "K08 range" },
        { id: "K07", parent: "manifold", length_ft: 70, load_mbh: 90, label: "K07 grill" },
      ],
    });
    expect(errors(r)).toEqual([]);
    expect(value(r, "longest_length_ft")).toBe(100);
    expect(value(r, "table")).toBe("VFGC 2021 Table 402.4(28)");
    expect(["manifold", "K09a", "K08", "K07"].map((id) => value(r, `size:${id}`))).toEqual(["1-1/4", "3/4", "1", "3/4"]);
    const segs = (r.detail as { segments: Array<{ id: string; table: { capacity: number; rowLengthFt: number } | null; equationVsTablePct: number | null }> }).segments;
    expect(segs.find((s) => s.id === "manifold")?.table).toEqual({ size: "1-1/4", rowLengthFt: 100, capacity: 677, unit: "mbh" });
    for (const s of segs) expect(Math.abs(s.equationVsTablePct ?? 0)).toBeLessThan(2);
  });

  it("longest length and branch length size a short branch differently, as 402.4.1 and 402.4.2 describe", () => {
    const base = { gas: "natural", material: "sch40", inlet: { value: 7, unit: "in_wc" }, drop: { value: 0.5, unit: "in_wc" }, segments: [
      { id: "main", parent: null, length_ft: 50 },
      { id: "far", parent: "main", length_ft: 50, load_mbh: 100 },
      { id: "near", parent: "main", length_ft: 10, load_mbh: 60 },
    ] };
    const longest = run("plumbing.size_gas", { ...base, method: "longest_length" });
    const branch = run("plumbing.size_gas", { ...base, method: "branch_length" });
    expect(value(longest, "table")).toBe("VFGC 2021 Table 402.4(2)");
    expect([value(longest, "size:near"), value(branch, "size:near")]).toEqual(["3/4", "1/2"]);
    expect([value(longest, "size:far"), value(branch, "size:far")]).toEqual(["3/4", "3/4"]);
    const near = (r: CalcRun) => (r.detail as { segments: Array<{ id: string; sizingLengthFt: number }> }).segments.find((s) => s.id === "near")?.sizingLengthFt;
    expect([near(longest), near(branch)]).toEqual([100, 60]);
  });

  it("a combination with no table loaded is sized by the equation and says so; a table passed in is used", () => {
    const seg = [{ id: "a", parent: null, length_ft: 100, load_mbh: 300 }];
    const eqOnly = run("plumbing.size_gas", { gas: "natural", material: "pe_tubing", inlet: { value: 7, unit: "in_wc" }, drop: { value: 0.5, unit: "in_wc" }, segments: seg });
    expect(eqOnly.issues[0]?.message).toMatch(/^No Table 402\.4\(n\) for natural gas, pe_tubing/);
    expect(value(eqOnly, "table")).toBeNull();
    // Natural gas PE pipe below 2 psi is loaded from the code library now (Table 402.4(21)).
    const pe = run("plumbing.size_gas", { gas: "natural", material: "pe_pipe", inlet: { value: 7, unit: "in_wc" }, drop: { value: 0.5, unit: "in_wc" }, segments: seg });
    expect(value(pe, "table")).toBe("VFGC 2021 Table 402.4(21)");
  });
});

describe("drains, heaters, interceptors, meters", () => {
  it("88 DFU on the building drain at 1/8 in/ft with water closets needs 4 in.", () => {
    const r = run("plumbing.size_drain", { role: "building_drain", dfu: 88, slope_in_per_ft: 0.125, serves_water_closet: true, actual_in: 3 });
    expect(value(r, "size_in")).toBe("4");
    expect(value(r, "pass")).toBe(false);
  });

  it("DFU from Table 709.1 names; a floor sink asks for its rating", () => {
    const r = run("plumbing.size_drain", { role: "horizontal_branch", fixtures: [{ fixture: "Lavatory", quantity: 2 }, { fixture: "Water closet, public (1.6 gpf)", quantity: 2 }] });
    expect([value(r, "dfu"), value(r, "size_in")]).toEqual([10, "2-1/2"]);
    expect(errors(run("plumbing.size_drain", { role: "horizontal_branch", fixtures: [{ fixture: "Floor sink" }] }))[0]?.message).toMatch(/709\.4/);
  });

  it("water heater: 198 gal/h demand against a 100 gal tank recovering 323 gph at 90 °F passes, and names no product", () => {
    const r = run("plumbing.water_heater", { demand_gph: 198, rise_f: 90, heater: { kind: "tank", storage_gal: 100, recovery_gph: 323, input_btuh: 250000 } }, {});
    expect([value(r, "demand_gph"), value(r, "recovery_gph"), value(r, "pass")]).toEqual([198, 323, true]);
    expect(JSON.stringify(r)).not.toMatch(/rheem|triton|GHE100/i);
    expect(registry.run({ calc: "plumbing.water_heater", inputs: { demand_gph: 198, heater: { kind: "tank", recovery_gph: 323, model: "GHE100SU" } } }).ok).toBe(false);
  });

  it("grease interceptor: PDI flow and the Table 1003.3.5.1 retention", () => {
    const r = run("plumbing.grease_interceptor", { fixtures: [{ label: "3-comp sink", length_in: 18, width_in: 18, depth_in: 12, compartments: 3 }], rated_gpm: 100 });
    expect([value(r, "required_gpm"), value(r, "required_lb"), value(r, "pass")]).toEqual([37.9, 100, true]);
  });

  it("meter loss by the square law", () => {
    expect(value(run("plumbing.water_meter", { demand_gpm: 48, meter: { max_flow_gpm: 100, loss_at_max_psi: 19.5 } }, {}), "meter_loss_psi")).toBe(4.49);
  });
});

describe("pack → kernel", () => {
  it("the restaurant design is a PipeDesign the kernel accepts, with Curve A, 704.1 slopes and 710.1 capacities", () => {
    const { design, demandCurve, sizingMode } = plumbingDesignFromPack({ ipc: ipcEdition("2021"), settings: { sizing_mode: "check", building_type: "restaurant" }, fixtures: [{ fixture: "Lavatory", wsfu: 1 }] });
    expect(pipeDesignSchema.safeParse(design).success).toBe(true);
    expect(demandCurve?.id).toBe("ashrae_a");
    expect(design.demandMethod).toBe("table");
    expect(design.slopes).toEqual([{ maxNominalIn: 2.5, inPerFt: 0.25 }, { maxNominalIn: 6, inPerFt: 0.125 }, { maxNominalIn: 1000, inPerFt: 0.0625 }]);
    expect(design.capacityTable).toEqual(expect.arrayContaining([{ nominalIn: 4, inPerFt: 0.125, maxDfu: 180 }, { nominalIn: 4, maxDfu: 500 }]));
    expect(design.fixtureTable).toEqual([{ fixture: "Lavatory", wsfu: 1, dfu: 1 }]);
    expect(sizingMode).toBe("check");
  });
});

describe("table import", () => {
  it("a CSV becomes a proposal for review; the library parser reads tab or bar rows the same", () => {
    const p = proposeCodeTableFromCsv("Length,1/2,3/4\n10,172,360\n20,118,NA", { code: "IFGC", edition: "2024", tableId: "Table 402.4(2)", title: "Sch 40", rowName: "length", rowUnit: "ft", columnName: "size", columnUnit: "in", cellUnit: "cfh", note: "firm paste" });
    expect("table" in p && p.table.cells).toEqual([[172, 360], [118, null]]);
    expect("needsReview" in p && p.needsReview).toBe(true);
    const tabbed = VFGC_2021_GAS_TABLES[5];
    if (!tabbed) throw new Error("missing");
    const a = parseGasCapacityTable(tabbed);
    const b = parseGasCapacityTable({ ...tabbed, text: tabbed.text.replace(/\|/g, "\t") });
    expect(a.ok && b.ok && a.table.cells).toEqual(b.ok ? b.table.cells : null);
  });
});

describe("determinism", () => {
  it("the same request gives the same run key", () => {
    const inputs = { supply: { kind: "design_minimum", psi: 50 }, meter_loss_psi: 4.5, critical_fixture_psi: 25, highest_fixture_height_ft: 7 };
    expect(run("plumbing.pressure_report", inputs).runKey).toBe(run("plumbing.pressure_report", inputs).runKey);
    expect(run("plumbing.pressure_report", inputs).runKey).not.toBe(run("plumbing.pressure_report", inputs, { state: "MD" }).runKey);
  });
});
