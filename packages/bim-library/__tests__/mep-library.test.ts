/**
 * @jest-environment node
 *
 * The built-in MEP calculations (Stream F): each one parses as a library
 * item, compiles with `@permitzip/bim-formula` against the fields the
 * kernel's MEP providers register on the classes it applies to, returns the
 * kind it declares, and its examples come out right.
 */
import { fieldProviderRegistry, type Registry } from "@permitzip/bim-kernel";
import { formulaEngine, type CellValue, type FormulaSchema, type FormulaType, type RowValues } from "@permitzip/bim-formula";
import { fromCanonical, fromSI, toSI, type UnitCode } from "@permitzip/bim-units";
import { MEP_LIBRARY, libraryBundleSchema, type CalculationItem } from "../src";

const registry = fieldProviderRegistry();

function schemaFor(reg: Registry, classes: readonly string[], depth = 0): FormulaSchema {
  return {
    field: (path) => {
      for (const c of classes) {
        const f = reg.field(c, path);
        if (!f) continue;
        if (f.valueType === "quantity" && f.kind && f.unit) return { type: { type: "quantity", kind: f.kind, unit: f.unit } };
        return { type: f.valueType === "boolean" ? { type: "boolean" } : { type: "text" } };
      }
      return undefined;
    },
    relationship: (name) => {
      const rel = reg.relationship(name);
      if (!rel?.resolve || depth > 1) return undefined;
      const to = rel.to === "any" ? reg.listClasses({ includeAbstract: true }).map((c) => c.id) : rel.to;
      return { label: rel.label, target: schemaFor(reg, to, depth + 1) };
    },
  };
}

const resultType = (item: CalculationItem): FormulaType =>
  item.result.valueType === "quantity" ? { type: "quantity", kind: item.result.kind, unit: item.result.unit } : { type: item.result.valueType };

describe("built-in MEP calculations", () => {
  const bundle = libraryBundleSchema.parse(MEP_LIBRARY);

  it("covers gas demand, connected and demand load, and pump served flow", () => {
    expect(bundle.formulas.map((f) => f.key)).toEqual(["PZ.GasDemandBtuh", "PZ.ConnectedLoadKva", "PZ.DemandLoadVa", "PZ.PumpServedGpm"]);
  });

  it.each(libraryBundleSchema.parse(MEP_LIBRARY).formulas.map((f) => [f.key, f] as const))("%s compiles over the provider fields and its examples hold", (_key, item) => {
    const compiled = formulaEngine.compile(item.expression, schemaFor(registry, item.appliesTo), { expect: resultType(item) });
    if (!compiled.ok) throw new Error(compiled.errors.map((e) => e.message).join("; "));
    for (const ex of item.examples ?? []) {
      const row: RowValues = {
        field: (path): CellValue => {
          const v = ex.inputs[path];
          if (v === undefined) return null;
          if (typeof v === "object") {
            const t = schemaFor(registry, item.appliesTo).field(path)?.type;
            return t?.type === "quantity" ? fromCanonical(t.kind, toSI(v.value, v.unit)) : null;
          }
          return typeof v === "number" ? null : v;
        },
        related: () => [],
      };
      const out = formulaEngine.evaluateRow(compiled.formula, row);
      const expected = ex.expected;
      if (typeof expected !== "object") throw new Error("examples here are quantities");
      expect(out.type).toBe("quantity");
      if (out.type === "quantity") expect(fromSI(out.value, expected.unit as UnitCode)).toBeCloseTo(expected.value, 6);
    }
  });
});
