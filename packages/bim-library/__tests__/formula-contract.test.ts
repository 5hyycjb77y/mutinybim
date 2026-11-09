/**
 * @jest-environment node
 *
 * Library validation over the real formula engine: parameters are bare names
 * (the engine's syntax), `{path}` is a field, and relationships reach library
 * validation so `sum(serves, …)` type-checks as it will evaluate.
 */
import { fieldProviderRegistry } from "@permitzip/bim-kernel";
import { MEP_LIBRARY, loadBundle, type CalculationItem, type LibraryBundleInput, type LibraryEnvironment } from "../src";
import { bimFormulaEngine, bimUnitsCatalog } from "../src/bim-formula";

const env: LibraryEnvironment = { formula: bimFormulaEngine, units: bimUnitsCatalog, registry: fieldProviderRegistry() };

const diversity: CalculationItem = {
  id: "calc-diversity",
  revision: 1,
  key: "PZ.Diversified",
  name: "Gas demand at a diversity factor",
  expression: "mbh * factor",
  params: [
    { name: "mbh", type: { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH" } },
    { name: "factor", type: { valueType: "quantity", kind: "dimensionless", unit: "1" } },
  ],
  result: { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH" },
  appliesTo: ["mep.equipment"],
  examples: [
    { inputs: { mbh: { value: 199, unit: "MBH" }, factor: 0.8 }, expected: { value: 159.2, unit: "MBH" } },
    { inputs: { mbh: { value: 199, unit: "MBH" }, factor: 0.8 }, expected: { value: 159_200, unit: "Btu/h" } },
  ],
};

function bundle(formulas: CalculationItem[]): LibraryBundleInput {
  return { format: "mutinybim-library", version: 1, id: "contract", name: "Contract", publisher: "PermitZIP", revision: 1, formulas };
}

const messages = (r: ReturnType<typeof loadBundle>) => (r.ok ? [] : r.problems.map((p) => p.message));

describe("library ↔ formula engine contract", () => {
  it("loads the built-in MEP calculations, PZ.PumpServedGpm's sum over serves included", () => {
    const r = loadBundle(MEP_LIBRARY, env);
    expect(messages(r)).toEqual([]);
  });

  it("validates a calculation with bare parameters and runs its examples", () => {
    expect(messages(loadBundle(bundle([diversity]), env))).toEqual([]);
  });

  it("refuses a parameter written in braces, naming the input", () => {
    const braced = { ...diversity, expression: "{mbh} * factor" };
    const [message] = messages(loadBundle(bundle([braced]), env));
    expect(message).toContain("Write the input mbh without braces, as mbh");
    expect(message).toContain('characters 1–5 of "{mbh} * factor"');
  });

  it("calls a parameter calculation from a field calculation", () => {
    const caller: CalculationItem = { id: "calc-caller", revision: 1, key: "PZ.EquipmentDemand", name: "Equipment demand", expression: "PZ.Diversified({own.mbh}, 0.8)", result: { valueType: "quantity", kind: "flow_gas_energy", unit: "Btu/h" }, appliesTo: ["mep.equipment"], examples: [{ inputs: { "own.mbh": { value: 100, unit: "MBH" } }, expected: { value: 80_000, unit: "Btu/h" } }] };
    expect(messages(loadBundle(bundle([diversity, caller]), env))).toEqual([]);
  });

  it("refuses a relationship the classes can't walk and a field the far side lacks", () => {
    const unknownRel = { ...diversity, id: "calc-a", key: "PZ.A", params: [], examples: [], expression: "sum(feeds_nothing, {load.gpm_fixed})", result: { valueType: "quantity", kind: "flow_liquid", unit: "gpm" } } satisfies CalculationItem;
    const unknownField = { ...unknownRel, id: "calc-b", key: "PZ.B", expression: "sum(serves, {no_such_field})" } satisfies CalculationItem;
    const out = messages(loadBundle(bundle([unknownRel, unknownField]), env));
    expect(out).toEqual(
      expect.arrayContaining([expect.stringContaining('There is no relationship called "feeds_nothing" here'), expect.stringContaining('There is no field called "no_such_field" here')]),
    );
  });

  it("refuses adding a length to a gas input in plain words", () => {
    const wrong = { ...diversity, expression: "mbh + 1 ft", examples: [] };
    expect(messages(loadBundle(bundle([wrong]), env))[0]).toMatch(/Can't add .* length .* gas|different things/i);
  });
});
