/**
 * @jest-environment node
 *
 * Round 3, lane B: pack parameters on parts (civil gap B) and part parameter
 * units opened to unit codes (civil gap C). Fails on the code before: a
 * part's `values` held only its type's parameter names (set_element_values
 * refused parts), and `paramDefSchema.unit` took only the v1 unit names, so a
 * structure's inlet capacity couldn't be cfs.
 */
import { LEGACY_PARAM_UNIT_SUFFIXES, PARAM_UNIT_BINDINGS, isLegacyParamUnit } from "@permitzip/bim-units";
import { builtinPartTypes, canonicalJson, formatParam, paramUnitBinding, partTypeDefinitionSchema, partTypeIssues, PARTS_PACK_VALUES_FEATURE, PARTS_UNIT_CODES_FEATURE, type PartTypeDefinition } from "../src";
import { plumbingStarterTypes } from "@permitzip/bim-pack-plumbing";
import { electricalStarterTypes } from "@permitzip/bim-pack-electrical";
import { builtinRegistry } from "../src/registry/builtin";
import { withPackParameters } from "../src/fields/pack-parameters";
import { bindModelPacks, unbindModelPacks } from "../src/packs";
import { CIVTEST_SET, STRUCTURE, commit, site, tryCommit } from "./c5e-r3-fixtures";

const MODEL = "c5e-r3-values";
beforeAll(() => bindModelPacks(MODEL, CIVTEST_SET));
afterAll(() => unbindModelPacks(MODEL));

describe("part parameter units: unit codes beside the v1 names", () => {
  const capacity = STRUCTURE.instanceParams[0];

  it("a structure's inlet capacity is in cfs, read and shown in cfs", () => {
    expect(capacity).toMatchObject({ unit: "cfs" });
    expect(paramUnitBinding(capacity?.unit)).toMatchObject({ unit: "cfs" });
    expect(capacity && formatParam(capacity, 2.5)).toBe("2.5 cfs");
  });

  it("every built-in part type reads exactly as before: same definition, same unit binding, same display", () => {
    const all: PartTypeDefinition[] = [...builtinPartTypes(), ...plumbingStarterTypes("test"), ...electricalStarterTypes("test")].map((e) => e.definition);
    expect(all.length).toBeGreaterThan(100);
    let numbers = 0;
    for (const def of all) {
      expect(canonicalJson(partTypeDefinitionSchema.parse(def))).toBe(canonicalJson(def));
      for (const p of [...def.typeParams, ...def.instanceParams]) {
        const unit = p.unit ?? "none";
        expect(isLegacyParamUnit(unit)).toBe(true);
        if (!isLegacyParamUnit(unit)) continue;
        expect(paramUnitBinding(p.unit)).toEqual(PARAM_UNIT_BINDINGS[unit]);
        if (p.kind === "number") {
          numbers += 1;
          expect(formatParam(p, 12.34)).toBe(`12.34${LEGACY_PARAM_UNIT_SUFFIXES[unit]}`);
        }
      }
    }
    expect(numbers).toBeGreaterThan(0);
  });

  it("refuses a unit that is neither, and a unit code on a length", () => {
    expect(partTypeDefinitionSchema.safeParse({ ...STRUCTURE, instanceParams: [{ name: "q", label: "Q", kind: "number", unit: "furlongs" }] }).success).toBe(false);
    const onLength = { ...STRUCTURE, instanceParams: [{ name: "depth", label: "Depth", kind: "length" as const, unit: "ft" as const }] };
    expect(partTypeIssues(onLength).map((i) => i.message)).toContain("Depth is a length parameter, so it can't take the unit ft: only number parameters carry a unit (lengths are millimetres, angles degrees)");
  });

  it("a part type newly carrying a unit code is written only to peers that read them", () => {
    const m = commit(site(MODEL), { type: "create_level", levelId: "lvl-2", name: "Two", elevationMm: 3000 });
    const r = tryCommit(m, { type: "place_part", partId: "mh9", typeId: "pt-mh9", partType: STRUCTURE, levelId: "lvl-site", position: { x: 5000, y: 5000 } }, (f) => f !== PARTS_UNIT_CODES_FEATURE);
    expect(r.ok ? "" : r.message).toBe("Storm structure 48 in.'s inlet_capacity in cfs can't be saved yet: the model server this model is open on is an older version that reads only the original part unit names. Try again once the server is updated");
  });
});

describe("pack parameters on parts", () => {
  it("a structure takes its class's pack parameters beside its type's, and the field registry reads them", () => {
    const m = commit(site(MODEL), { type: "set_element_values", elementIds: ["mh1"], values: { "civtest.invert_elevation": 600, "civtest.cover": "grate" } });
    const mh1 = m.elements["mh1"];
    if (mh1?.kind !== "part") throw new Error("a part");
    expect(mh1.values).toEqual({ inlet_capacity: 2.5, "civtest.invert_elevation": 600, "civtest.cover": "grate" });
    const field = withPackParameters(builtinRegistry(), CIVTEST_SET).field("civtest.manhole", "civtest.invert_elevation");
    expect(field?.read?.(mh1, m)).toBe(600);
    // Its type's own parameters still edit, with the pack values beside them.
    const again = commit(m, { type: "set_parameters", id: "mh1", scope: "instance", values: { inlet_capacity: 3 } });
    expect(again.elements["mh1"]).toMatchObject({ values: { inlet_capacity: 3, "civtest.invert_elevation": 600 } });
  });

  it("checks each value against its definition, and points each path at the other", () => {
    const m = site(MODEL);
    const tries: [unknown, string][] = [
      [{ type: "set_element_values", elementIds: ["mh1"], values: { "civtest.cover": "plastic" } }, "Cover is one of solid, grate"],
      [{ type: "set_element_values", elementIds: ["mh1"], values: { "civtest.invert_elevation": "low" } }, "Invert is a number in mm"],
      [{ type: "set_element_values", elementIds: ["mh1"], values: { inlet_capacity: 3 } }, "inlet_capacity is a parameter of Part MH-1's type; set it with set_parameters"],
      [{ type: "set_parameters", id: "mh1", scope: "instance", values: { "civtest.cover": "grate" } }, "civtest.cover is a pack parameter, not one of the part type's; set it with set_element_values"],
    ];
    for (const [cmd, why] of tries) {
      const r = tryCommit(m, cmd);
      expect(r.ok ? "" : r.message).toBe(why);
    }
  });

  it("refuses a pack parameter the part's class doesn't have, and an older peer", () => {
    const m = commit(site(MODEL), { type: "set_element_class", elementIds: ["mh2"], classId: null });
    const r = tryCommit(m, { type: "set_element_values", elementIds: ["mh2"], values: { "civtest.cover": "grate" } });
    expect(r.ok ? "" : r.message).toMatch(/^civtest\.cover isn't a parameter of Part MH-2's class/);
    const older = tryCommit(site(MODEL), { type: "set_element_values", elementIds: ["mh1"], values: { "civtest.cover": "grate" } }, (f) => f !== PARTS_PACK_VALUES_FEATURE);
    expect(older.ok ? "" : older.message).toBe("Part MH-1 can't take pack parameters yet: the model server this model is open on is an older version that doesn't store them. Try again once the server is updated");
  });
});
