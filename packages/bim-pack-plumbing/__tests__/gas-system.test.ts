/**
 * @jest-environment node
 *
 * The drawn 7492 (Sample Market) propane system sized by the
 * Virginia Fuel Gas Code 2021, zone by zone, against the stamped sheet:
 * the cook line behind line regulator LR-1 (11 in. w.c., 0.5 in. drop,
 * Table 402.4(28), 100 ft column) needs a 1-1/4" manifold, 1" to the K08
 * range and 3/4" to the K09 fryers and the K07 grill; the 2 psi zone reads
 * Table 402.4(27). Total input 1,024.407 MBH. Lowering the range to 120 MBH
 * re-proposes 3/4" to it. A water heater fed straight off the 2 psi zone is
 * a finding. The proposal applied with set_pipe_sizes leaves nothing to
 * resize. Before this, sizing took a hand-typed segment list; the model's
 * own pipe and regulators weren't read at all.
 */
import { planCommit, type ModelState } from "@permitzip/bim-kernel";
import { buildSampleMarketGas, SAMPLE_MARKET_GAS_SYSTEM } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { builtinCalcRegistry, type CalcRun } from "@permitzip/bim-calc";
import { fuelGasAdoptionFrom, inchesOfLabel, type GasSystemSizing } from "../src";

const registry = builtinCalcRegistry();

function size(model: ModelState, extra: Record<string, unknown> = { state: "VA" }): { run: CalcRun; sizing: GasSystemSizing } {
  const r = registry.run({ calc: "plumbing.gas_system", inputs: { system_id: SAMPLE_MARKET_GAS_SYSTEM }, model, ...extra });
  if (!r.ok) throw new Error(r.reason);
  return { run: r.run, sizing: r.run.detail as GasSystemSizing };
}
const proposed = (s: GasSystemSizing, id: string) => s.proposals.find((p) => p.segmentId === id)?.proposed;

describe("plumbing.gas_system on the 7492 propane system", () => {
  const { run, sizing } = size(buildSampleMarketGas());

  it("sizes the cook line as the sheet does: 1-1/4\" manifold, 1\" range, 3/4\" fryers and grill (Table 402.4(28), 100 ft)", () => {
    const kitchen = sizing.zones.find((z) => z.id === "zone-LR-1");
    expect(kitchen).toMatchObject({ inlet: "11 in. w.c.", allowableDrop: "0.5 in. w.c.", longestFt: 97, totalMbh: 550, material: "sch40", table: "VFGC 2021 Table 402.4(28)" });
    expect(["main-s3", "k08-b-s1", "k08-b-s2", "k09b-b-s1", "k09b-b-s2", "main-s4", "main-s5", "k07-b-s1", "k07-b-s2"].map((id) => proposed(sizing, id))).toEqual(["1-1/4", "1", "1", "3/4", "3/4", "3/4", "3/4", "3/4", "3/4"]);
    expect(kitchen?.segments.find((s) => s.id === "main-s3@0")).toMatchObject({ loadMbh: 550, sizingLengthFt: 97, size: "1-1/4" });
  });

  it("sizes the 2 psi zone from Table 402.4(27) at 2 psi / 1 psi drop, each regulator a load on it", () => {
    const service = sizing.zones.find((z) => z.id === "zone-source");
    expect(service).toMatchObject({ inlet: "2 psi", allowableDrop: "1 psi", highPressure: true, totalMbh: 1024.407, table: "VFGC 2021 Table 402.4(27)" });
    expect(service?.segments.find((s) => s.id === "main-s1@0")?.loadMbh).toBe(1024.407);
    // The jog LR-1 sits on carries the 2 psi side and the cook line's start: the larger size wins.
    const jog = sizing.proposals.find((p) => p.segmentId === "main-s2");
    expect(jog?.zoneIds).toEqual(["zone-source", "zone-LR-1"]);
    expect(inchesOfLabel(jog?.proposed ?? null)).toBeGreaterThanOrEqual(1.25);
  });

  it("totals the gas equipment schedule: 1,024,407 Btu/h, two K09 fryers on one row, each row with its regulator", () => {
    expect(sizing.totalMbh).toBe(1024.407);
    expect(sizing.equipment.map((e) => [e.mark, e.quantity, e.inputMbh, e.totalMbh, e.regulator])).toEqual([
      ["DOAS-1", 1, 224.407, 224.407, "Appliance regulator AR-DOAS, 11 in. w.c."],
      ["GWH", 1, 250, 250, "Appliance regulator AR-GWH, 11 in. w.c."],
      ["K07", 1, 90, 90, "Line regulator LR-1, 11 in. w.c."],
      ["K08", 1, 220, 220, "Line regulator LR-1, 11 in. w.c."],
      ["K09", 2, 120, 240, "Line regulator LR-1, 11 in. w.c."],
    ]);
    expect(sizing.equipment.reduce((s, e) => s + e.totalMbh, 0)).toBeCloseTo(1024.407, 6);
  });

  it("says what is undersized as drawn (everything 3/4\") and cites the code", () => {
    const under = sizing.findings.filter((f) => f.code === "undersized_gas_pipe").map((f) => f.elementId);
    expect(under).toEqual(expect.arrayContaining(["main-s3", "k08-b-s1", "k08-b-s2"]));
    expect(under).not.toContain("k07-b-s1");
    expect(run.values.find((v) => v.key === "size:main-s3")?.value).toBe("1-1/4");
    expect(run.citations.map((c) => c.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^VFGC 2021 402\.4\.3/), "VFGC 2021 Table 402.4(28) (PermitZIP code library)", "VFGC 2021 Table 402.4(27) (PermitZIP code library)"]));
    expect(sizing.sizingMode).toBe("check");
  });

  it("lowering the range to 120 MBH re-proposes 3/4\" to it", () => {
    const lower = size(buildSampleMarketGas({ rangeMbh: 120 })).sizing;
    expect([proposed(lower, "k08-b-s1"), proposed(lower, "main-s3")]).toEqual(["3/4", "1-1/4"]);
  });

  it("a heater fed straight off the 2 psi zone is a finding (regulator missing between zones)", () => {
    const bare = size(buildSampleMarketGas({ withoutHeaterRegulator: true })).sizing;
    expect(bare.findings.filter((f) => f.code === "regulator_missing").map((f) => f.elementId)).toEqual(["gwh"]);
  });

  it("applied with set_pipe_sizes, the next run has nothing to resize", () => {
    const m = buildSampleMarketGas();
    const changes = sizing.proposals.filter((p) => p.change !== "same").map((p) => ({ segmentId: p.segmentId, nominalIn: p.proposedIn }));
    const d = planCommit(m, [], { idempotencyKey: "apply-gas", baseRevision: m.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command: { type: "set_pipe_sizes", idPrefix: "gas-size", systemId: SAMPLE_MARKET_GAS_SYSTEM, sizes: changes } }, () => "2026-10-23T00:00:00.000Z");
    if (!d.ok) throw new Error(d.error.message);
    const again = size(d.model).sizing;
    expect(again.proposals.filter((p) => p.change === "up")).toEqual([]);
    expect(again.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("finds the project's fuel gas code in Code Study whatever discipline it was filed under, and asks when there is none", () => {
    expect(fuelGasAdoptionFrom([{ code_name: "Virginia Plumbing Code (VPC)", edition: "2021", status: "confirmed" }, { code_name: "Virginia Fuel Gas Code (VFGC)", edition: "2021", status: "confirmed" }])).toEqual({ codeName: "Virginia Fuel Gas Code (VFGC)", edition: "2021", status: "confirmed" });
    expect(fuelGasAdoptionFrom([{ code_name: "Virginia Plumbing Code", edition: "2021", status: "confirmed" }])).toBeNull();
    const asked = registry.run({ calc: "plumbing.gas_system", inputs: { system_id: SAMPLE_MARKET_GAS_SYSTEM }, model: buildSampleMarketGas() });
    expect(asked.ok).toBe(false);
    if (!asked.ok) expect(asked.reason).toMatch(/^Say which fuel gas code edition applies/);
    const viaStudy = registry.run({ calc: "plumbing.gas_system", inputs: { system_id: SAMPLE_MARKET_GAS_SYSTEM }, model: buildSampleMarketGas(), projectAdoptions: { fuel_gas: { codeName: "Virginia Fuel Gas Code (VFGC)", edition: "2021", status: "confirmed" } } });
    expect(viaStudy.ok).toBe(true);
  });
});
