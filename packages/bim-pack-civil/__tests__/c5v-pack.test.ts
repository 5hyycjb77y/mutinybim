/**
 * @jest-environment node
 *
 * The civil pack on the add-on contract (1.1): it conforms, a set with the
 * first-party packs and it builds, and inside that set's scope its classes,
 * service, network, parameters, material, lint rules and calcs are what the
 * kernel and the engines read; outside the scope they are not (built-ins
 * unchanged). Its rules run through the real lint engine (`runPackLint`) and
 * flag the synthetic site's overloaded inlet and flat pipe; its calcs run
 * through the real calc registry (`runPackCalc`) with bim-units codes.
 */
import { CALC_POINT, CLASS_POINT, LINT_RULE_POINT, PackSet, activePackSet, networkForService, packFieldRegistry, runPackCalc, runPackConformance, runPackLint, withPackSet } from "@permitzip/bim-pack";
import { installedFirstPartyPacks } from "@permitzip/bim-pack";

/** The first-party add-ons every host installs (jest.setup.js installs them before this file loads). */
const FIRST_PARTY_PACKS = installedFirstPartyPacks();
import { pipeMaterialRow, type ModelState } from "@permitzip/bim-kernel";
import { activeClassRegistry } from "@permitzip/bim-kernel/registry";
import { isWalkedService, serviceById } from "@permitzip/bim-kernel/services";
import { CIVIL_PACK } from "../src/pack";
import { CIVIL_SET, syntheticSiteModel } from "./fixtures/synthetic-site";

const set = PackSet.create([...FIRST_PARTY_PACKS, CIVIL_PACK]);

describe("civil pack contract", () => {
  let model: ModelState;
  beforeAll(() => {
    model = syntheticSiteModel("c5v-pack");
  });

  it("passes the conformance suite", () => {
    const result = runPackConformance(CIVIL_PACK);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is seen inside its set's scope and not outside it", () => {
    const inside = withPackSet(set, () => ({
      manhole: activeClassRegistry().getClass("civil.manhole")?.ifc,
      storm: serviceById("civil.storm"),
      network: networkForService("civil.storm")?.aggregation?.quantities,
      rcp: pipeMaterialRow("civil.rcp")?.fallback,
      rules: activePackSet().items(LINT_RULE_POINT).map((r) => r.id).filter((id) => id.startsWith("civil.")),
      calcs: activePackSet().items(CALC_POINT).map((c) => c.info.id).filter((id) => id.startsWith("civil.")),
    }));
    expect(inside.manhole).toEqual({ entity: "IfcDistributionChamberElement", predefinedType: "MANHOLE" });
    expect(inside.storm && isWalkedService(inside.storm)).toBe(true);
    expect(inside.network).toEqual(["civil.runoff"]);
    expect(inside.rcp).toBe("pe");
    expect(inside.rules).toEqual(["civil.inlet_overloaded", "civil.slope_below_minimum"]);
    expect(inside.calcs).toEqual(["civil.rational_runoff", "civil.manning_full_capacity"]);

    expect(activeClassRegistry().getClass("civil.manhole")).toBeUndefined();
    expect(serviceById("civil.storm")).toBeNull();
    expect(networkForService("civil.storm")).toBeNull();
    expect(pipeMaterialRow("civil.rcp")).toBeNull();
    expect(activePackSet().items(LINT_RULE_POINT).some((r) => r.id.startsWith("civil."))).toBe(false);
    expect(withPackSet(set, () => serviceById("storm"))).toBe(serviceById("storm"));
    // The always-installed Architecture (round 13) and Structural (round 14) add-ons contribute their classes beside the civil pack's own.
    expect(set.contributors(CLASS_POINT)).toEqual([
      { packId: "architecture", packName: "Architecture", version: "1.0.0", count: 9 },
      { packId: "struct", packName: "Structural", version: "0.1.0", count: 9 },
      { packId: "civil", packName: "Civil", version: "0.1.0", count: 7 },
    ]);
  });

  it("puts its parameters in the field registry with kind, unit and IFC home", () => {
    const fields = packFieldRegistry(set);
    const intensity = fields.field("civil.storm_system", "civil.design_intensity");
    expect(intensity).toMatchObject({ kind: "rainfall_intensity", unit: "in/h", ifc: { pset: "MutinyBIM_StormSystem", property: "DesignIntensity" } });
    const capacity = fields.field("civil.storm_inlet", "civil.inlet_capacity");
    expect(capacity).toMatchObject({ kind: "flow_liquid", unit: "cfs", ifc: { pset: "MutinyBIM_StormStructure", property: "InletCapacity" } });
    const i1 = model.elements.I1;
    if (!i1) throw new Error("I1 exists");
    expect(capacity?.read?.(i1, { elements: model.elements })).toBe(2.5);
    expect(fields.field("civil.manhole", "civil.inlet_capacity")).toBeUndefined();
    const c3 = model.elements.C3;
    if (!c3) throw new Error("C3 exists");
    expect(fields.field("civil.catchment", "civil.runoff_coefficient")?.read?.(c3, { elements: model.elements })).toBeNull();
    expect(fields.field("civil.catchment", "civil.surface")?.read?.(c3, { elements: model.elements })).toBe("lawn_heavy_average");
  });

  it("its rules, run by the real lint engine, flag the overloaded inlet and the flat pipe", () => {
    const civil = runPackLint(model, CIVIL_SET).filter((f) => f.rule.startsWith("civil."));
    expect(civil.map((f) => `${f.rule}:${[...f.elementIds].sort().join(",")}`).sort()).toEqual(["civil.inlet_overloaded:C1,I1", "civil.slope_below_minimum:MH1,OF1,P103-s1"]);
    const inlet = civil.find((f) => f.rule === "civil.inlet_overloaded");
    expect(inlet?.at.x_ft).toBeCloseTo(350, 6);
    expect(inlet?.at.z_ft).toBeCloseTo(100, 6);
    expect(inlet?.message).toBe("I1 takes 2.64 cfs of runoff but can take 2.50 cfs");
    // Not loaded without the pack: the same model, built-ins only.
    expect(runPackLint(model, PackSet.create([])).filter((f) => f.rule.startsWith("civil."))).toEqual([]);
  });

  it("its calcs, run by the real calc registry, give the hand checks in real units", () => {
    // 0.95 × 4 × 30,000 / 43,200 = 2.638889 cfs over 0.688705 ac.
    const runoff = runPackCalc(set, { calc: "civil.rational_runoff", inputs: { area_ft2: 30000, surface: "paved", intensity_in_per_h: 4 } });
    if (!runoff.ok) throw new Error(runoff.reason);
    const peak = runoff.run.values.find((v) => v.key === "peak_runoff");
    expect(peak?.unit).toBe("cfs");
    expect(typeof peak?.value === "number" ? peak.value : Number.NaN).toBeCloseTo(2.638889, 5);
    expect(runoff.run.values.find((v) => v.key === "area")).toMatchObject({ unit: "acre" });
    expect(runoff.run.citations.map((c) => c.code)).toContain("FHWA HEC-22, Urban Drainage Design Manual");
    // 12 in at 0.5 %, n 0.013: 2.519 cfs at 3.21 ft/s.
    const pipe = runPackCalc(set, { calc: "civil.manning_full_capacity", inputs: { diameter_in: 12, slope_pct: 0.5, manning_n: 0.013 } });
    if (!pipe.ok) throw new Error(pipe.reason);
    expect(pipe.run.values.find((v) => v.key === "full_capacity")).toMatchObject({ unit: "cfs" });
    expect(pipe.run.values.find((v) => v.key === "full_velocity")).toMatchObject({ unit: "ft/s" });
    const outside = runPackCalc(PackSet.create([]), { calc: "civil.rational_runoff", inputs: { area_ft2: 1, surface: "paved", intensity_in_per_h: 1 } });
    expect(outside.ok).toBe(false);
  });
});
