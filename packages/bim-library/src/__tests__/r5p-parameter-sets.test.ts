/**
 * @jest-environment node
 *
 * Round 5a f-params: the built-in baseline parameter sets are valid library
 * fields on bim-units kinds, read today's stored part parameters with no
 * conversion, and reference provider fields that exist without redefining them.
 */
import { builtinPartTypes, fieldProviderRegistry, paramUnitBinding, supersededBuiltinPartTypes, type ParamDef } from "@permitzip/bim-kernel";
import { KIND_IDS, UNIT_CODES, unitAllowed } from "@permitzip/bim-units";
import { BASELINE_PARAMETER_SETS } from "../builtin/aec";
import { sharedFieldItemSchema } from "../schema";

const STANDARD_PSETS = new Set(["Pset_ManufacturerTypeInformation", "Pset_ElectricalDeviceCommon"]);

const builtinParams = (): ParamDef[] =>
  [...builtinPartTypes(), ...supersededBuiltinPartTypes()].flatMap((e) => [...e.definition.typeParams, ...e.definition.instanceParams]);

describe("r5p baseline parameter sets", () => {
  it("covers identity, electrical, gas, water, drainage, mechanical and structural", () => {
    expect(BASELINE_PARAMETER_SETS.map((s) => s.id)).toEqual(["identity", "electrical", "gas", "water", "drainage", "mechanical", "structural"]);
  });

  it("every parameter is a valid library field on a bim-units kind and unit, with a namespaced key", () => {
    for (const set of BASELINE_PARAMETER_SETS) {
      for (const { field } of set.parameters) {
        const parsed = sharedFieldItemSchema.safeParse(field);
        expect({ id: field.id, ok: parsed.success, error: parsed.success ? null : parsed.error.message }).toEqual({ id: field.id, ok: true, error: null });
        // Round 5b (FOUNDATION adjustments D2): a namespaced key; `param.<name>` is its alias (apply.ts `parameterAliases`).
        expect({ id: field.id, key: field.key, namespaced: /^(core|elec|gas|plumb|mech|struct)\.[a-z][a-z0-9_]*$/.test(field.key), stored: field.storage.kind }).toEqual({ id: field.id, key: field.key, namespaced: true, stored: "parameter" });
        if (field.valueType === "quantity") expect({ id: field.id, ok: field.kind !== undefined && field.unit !== undefined && unitAllowed(field.kind, field.unit) }).toEqual({ id: field.id, ok: true });
      }
    }
  });

  it("a set's parameter reads the unit the built-in parts already store it in (no conversion, no data change)", () => {
    const byName = new Map<string, ParamDef[]>();
    for (const p of builtinParams()) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
    let matched = 0;
    for (const set of BASELINE_PARAMETER_SETS) {
      for (const { field } of set.parameters) {
        if (field.storage.kind !== "parameter" || field.valueType !== "quantity") continue;
        for (const p of byName.get(field.storage.name) ?? []) {
          if (p.kind !== "number") continue;
          matched++;
          expect({ name: p.name, unit: paramUnitBinding(p.unit)?.unit, kind: paramUnitBinding(p.unit)?.kind }).toEqual({ name: p.name, unit: field.unit, kind: field.kind });
        }
      }
    }
    expect(matched).toBeGreaterThan(5);
  });

  it("provided keys exist in the kernel's field registry for the set's classes, and set parameters never shadow a provider field", () => {
    const reg = fieldProviderRegistry();
    for (const set of BASELINE_PARAMETER_SETS) {
      for (const p of set.provided) expect({ set: set.id, key: p.key, found: set.classes.some((c) => reg.field(c, p.key) !== undefined) }).toEqual({ set: set.id, key: p.key, found: true });
      for (const { field } of set.parameters) for (const c of field.appliesTo) expect({ key: field.key, c, shadow: reg.field(c, field.key) !== undefined }).toEqual({ key: field.key, c, shadow: false });
    }
  });

  it("IFC homes use standard sets only by name, and our own sets the MutinyBIM_ prefix (never a reserved Pset_/Qto_ name)", () => {
    for (const set of BASELINE_PARAMETER_SETS) {
      for (const entry of [...set.parameters, ...set.provided]) {
        const name = "pset" in entry.ifc ? entry.ifc.pset : entry.ifc.qto;
        expect({ name, ok: STANDARD_PSETS.has(name) || name.startsWith("MutinyBIM_") }).toEqual({ name, ok: true });
      }
    }
  });

  it("the library schema reads the bim-units vocabulary (every kind and unit code is accepted)", () => {
    const base = { id: "t:f", revision: 1, key: "param.x", label: "X", appliesTo: ["mep.equipment"], valueType: "quantity" as const, group: "G", editable: true, storage: { kind: "parameter" as const, scope: "type" as const, name: "x" } };
    expect(KIND_IDS.every((kind) => sharedFieldItemSchema.safeParse({ ...base, kind, unit: "1" }).success)).toBe(true);
    expect(UNIT_CODES.every((unit) => sharedFieldItemSchema.safeParse({ ...base, kind: "length", unit }).success)).toBe(true);
  });
});
