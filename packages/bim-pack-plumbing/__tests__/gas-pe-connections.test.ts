/**
 * @jest-environment node
 *
 * Polyethylene gas pipe sized from the fuel gas code's PE tables (Virginia
 * Fuel Gas Code 2021, from the code library): propane at 11 in. w.c. reads
 * Table 402.4(35), natural gas below 2 psi at 0.5 in. drop reads Table
 * 402.4(21). Before this, PE wasn't a kernel material, so a PE zone had no
 * table and came back unsized with a "no table for this material" finding.
 *
 * The sizing's connection rows carry each outlet's developed length from the
 * source and the code table its pipe is sized on (the issued 7492 gas sheets).
 */
import { type ModelState } from "@permitzip/bim-kernel";
import { buildGasLine, GAS_LINE_SYSTEM } from "../../bim-kernel/__tests__/fixtures/gas-pe-line";
import { buildSampleMarketGas, SAMPLE_MARKET_GAS_SYSTEM } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { builtinCalcRegistry, bundledGasTables, findGasTable } from "@permitzip/bim-calc";
import { gasTableMaterial, type GasSystemSizing } from "../src";

const registry = builtinCalcRegistry();

function size(model: ModelState, systemId: string): GasSystemSizing {
  const r = registry.run({ calc: "plumbing.gas_system", inputs: { system_id: systemId }, model, state: "VA" });
  if (!r.ok) throw new Error(r.reason);
  return r.run.detail as GasSystemSizing;
}

describe("polyethylene gas pipe on the code library's PE tables", () => {
  it("a PE pipe reads the PE table family", () => {
    expect(gasTableMaterial("pe")).toBe("pe_pipe");
  });

  it("propane, 11 in. w.c.: the DOAS's 224 MBH at 40 ft needs 3/4\" PE (Table 402.4(35): 1/2\" carries 160, 3/4\" 321)", () => {
    const s = size(buildGasLine({ fuel: "propane", end: "doas" }), GAS_LINE_SYSTEM);
    expect(s.zones[0]).toMatchObject({ material: "pe_pipe", table: "VFGC 2021 Table 402.4(35)", longestFt: 40 });
    expect(s.proposals).toEqual([expect.objectContaining({ segmentId: "line-s1", current: "1/2", proposed: "3/4", change: "up" })]);
    expect(s.findings.map((f) => f.code)).toEqual(["undersized_gas_pipe"]);
  });

  it("natural gas below 2 psi, 0.5 in. drop: 224 cfh at 40 ft needs 1\" PE (Table 402.4(21): 3/4\" carries 190, 1\" 343)", () => {
    const s = size(buildGasLine({ fuel: "natural", end: "doas" }), GAS_LINE_SYSTEM);
    expect(s.zones[0]).toMatchObject({ material: "pe_pipe", table: "VFGC 2021 Table 402.4(21)" });
    expect(s.proposals[0]).toMatchObject({ proposed: "1" });
  });

  it("the natural gas PE tables come from the code library", () => {
    const t = findGasTable(bundledGasTables(), "natural", "pe_pipe", { value: 2, unit: "psi", lessThan: false }, { value: 1, unit: "psi", lessThan: false });
    expect(t?.tableId).toBe("Table 402.4(22)");
  });
});

describe("connection rows on the sizing", () => {
  it("name each outlet's developed length from the source and the table its zone is sized on", () => {
    const s = size(buildSampleMarketGas(), SAMPLE_MARKET_GAS_SYSTEM);
    const k08 = s.connections.find((c) => c.elementId === "k08");
    expect(k08).toMatchObject({ developedLengthFt: 129, zoneLengthFt: 78, table: "VFGC 2021 Table 402.4(28)", basisText: "Longest length, 97 ft, VFGC 2021 Table 402.4(28)", requiredSize: "1" });
    expect(s.connections).toHaveLength(6);
  });

  it("a load point on a PE line is sized like an appliance", () => {
    const s = size(buildGasLine({ fuel: "propane", end: { loadPointMbh: 150 } }), GAS_LINE_SYSTEM);
    expect(s.connections.map((c) => [c.mark, c.source, c.developedLengthFt, c.requiredSize])).toEqual([["K10", "load_point", 40, "1/2"]]);
    expect(s.totalMbh).toBe(150);
  });
});
