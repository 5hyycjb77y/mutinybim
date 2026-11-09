/**
 * @jest-environment node
 *
 * Round 16 (product decision, 7607: "Sanitary" drew 1" copper with sweat elbows; saved
 * Pipe types were never used). A system now picks its pipe type: the
 * project's saved type for that system first, else the firm's built-in one,
 * keeping an existing system's material. None of this existed before, so
 * every case fails on the old code (nothing to import).
 */
import { pipeTypeSchema, BUILTIN_PIPE_TYPES, type PipeTypeEntry, type PipeTypeInput } from "../src/routing/pipe/pipe-types";
import type { PipeTypeRecord } from "../src/routing/pipe/plumbing-catalog";
import { pipeTypeBendAngles, pipeTypeForSystem, pipeTypeRouteFittings, pipeTypesForSystem, startSizeFor } from "../src/routing/pipe/system-pipe-type";

const builtins: PipeTypeRecord[] = BUILTIN_PIPE_TYPES.map((entry) => ({ entry, saved: false, overridesBuiltin: false }));
const saved = (input: Omit<PipeTypeInput, "type">): PipeTypeRecord => ({ entry: pipeTypeSchema.parse({ ...input, type: "pipe_type" }), saved: true, overridesBuiltin: false });

describe("the pipe type a system draws with", () => {
  it("sanitary draws PVC DWV (the firm's first sanitary type), never copper", () => {
    const t = pipeTypeForSystem(builtins, "sanitary");
    expect(t?.name).toBe("SAN-PVC");
    expect(t?.material).toBe("pvc");
    expect(startSizeFor(t as PipeTypeEntry, "sanitary")).toBe(3);
  });

  it("storm and vent take a DWV type too; gas takes Schedule 40; cold water takes the firm's first water type", () => {
    expect(pipeTypeForSystem(builtins, "storm")?.material).toBe("pvc");
    expect(pipeTypeForSystem(builtins, "vent")?.material).toBe("pvc");
    expect(pipeTypeForSystem(builtins, "natural_gas")?.name).toBe("GAS-SCH40");
    expect(pipeTypeForSystem(builtins, "domestic_cold_water")?.name).toBe("DW-PEX");
  });

  it("a type saved for the system wins over the built-in one (Plumbing › Pipe types is used when drawing)", () => {
    const mine = saved({ name: "SAN-CI-HUB", material: "cast_iron", spec: "no_hub", systemKinds: ["sanitary"], fittings: { drain_branch_hh: "dwv.combo_wye_eighth" } });
    const t = pipeTypeForSystem([...builtins, mine], "sanitary");
    expect(t?.name).toBe("SAN-CI-HUB");
    expect(pipeTypeRouteFittings(t as PipeTypeEntry)).toEqual({ drain_branch_hh: { family: "dwv.combo_wye_eighth" } });
  });

  it("an existing system keeps its material (a cast iron sanitary system stays cast iron)", () => {
    expect(pipeTypeForSystem(builtins, "sanitary", { material: "cast_iron", nominalIn: 4 })?.name).toBe("SAN-CI");
  });

  it("a size the first type doesn't come in picks one that does (1-1/2\" cold water is not PEX here)", () => {
    expect(pipeTypeForSystem(builtins, "domestic_cold_water", { material: "copper", nominalIn: 1.5 })?.name).toBe("DW-CU-L");
    const water = pipeTypesForSystem(builtins, "domestic_cold_water").map((t) => t.name);
    expect(water.slice(0, 3)).toEqual(["DW-PEX", "DW-CPVC", "DW-CU-L"]);
  });

  it("the start size stays inside the type's range (PEX 1/2\"–1\")", () => {
    const pex = BUILTIN_PIPE_TYPES.find((t) => t.name === "DW-PEX") as PipeTypeEntry;
    expect(startSizeFor(pex, "domestic_cold_water")).toBe(0.75);
    const cpvc = BUILTIN_PIPE_TYPES.find((t) => t.name === "DW-CPVC") as PipeTypeEntry;
    expect(startSizeFor(cpvc, "domestic_cold_water")).toBe(1.25);
  });

  it("bend angles come from the catalog for the type's material: PVC DWV has 22-1/2°, 45°, 60° and 90°", () => {
    const pvc = BUILTIN_PIPE_TYPES.find((t) => t.name === "SAN-PVC") as PipeTypeEntry;
    expect(pipeTypeBendAngles(pvc, "sanitary")).toEqual([22.5, 45, 60, 90]);
    const pex = BUILTIN_PIPE_TYPES.find((t) => t.name === "DW-PEX") as PipeTypeEntry;
    expect(pipeTypeBendAngles(pex, "domestic_cold_water")).toEqual([45, 90]);
  });
});
