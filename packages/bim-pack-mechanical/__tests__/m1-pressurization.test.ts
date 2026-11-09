/**
 * @jest-environment node
 *
 * The pressurization and makeup-air calcs on the plugin interface (ROADMAP M1
 * on F9). Before this change bim-calc had no `mechanical/pressurization.ts` or
 * `mechanical/makeup-air.ts`, the registry listed neither id, and the
 * space-use library carried no design pressure, so every test here fails on
 * the old tree (imports missing; `builtinCalcRegistry().run` answered
 * `No calc "mech.pressurization"`).
 */
import type { Space } from "@permitzip/bim-kernel";
import { spaceUseCatalog, spaceUsePressureTarget } from "@permitzip/bim-library";
import { builtinCalcRegistry } from "@permitzip/bim-calc";
import { makeupAirHeatCalc, pressurizationCalc } from "../src";
import { sampleGrill, withTargets } from "../../bim-kernel/__tests__/m1-fixtures";

const catalog = spaceUseCatalog().catalog;
const fromLibrary = (space: Space) => (space.use && space.use.libraryId === catalog.libraryId ? spaceUsePressureTarget(catalog, space.use.useId) : null);


describe("mech.makeup_air_heat", () => {
  it("7303's hand calc: 2,400 × 1.08 × (92 − 80) = 31,104 Btu/h (31.104 MBH) heating, cited", () => {
    const r = builtinCalcRegistry().run({ calc: "mech.makeup_air_heat", inputs: { cfm: 2400, from_f: 80, to_f: 92 } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.run.values.find((v) => v.key === "load_mbh")).toMatchObject({ value: 31.104, unit: "mbh" });
    expect(r.run.values.find((v) => v.key === "direction")?.value).toBe("heating");
    expect(r.run.steps[0]?.detail).toBe("2,400 × 1.08 × (92 − 80) = 31,104 Btu/h");
    expect(r.run.citations.map((c) => c.text)).toEqual([expect.stringContaining("Q = 1.08 × cfm × ΔT")]);
    expect(makeupAirHeatCalc.info.id).toBe("mech.makeup_air_heat");
  });

  it("air brought down to the room is a cooling load; equal temperatures add none and say so", () => {
    const cool = builtinCalcRegistry().run({ calc: "mech.makeup_air_heat", inputs: { cfm: 1000, from_f: 95, to_f: 75 } });
    if (!cool.ok) throw new Error(cool.reason);
    expect(cool.run.values.find((v) => v.key === "load_mbh")?.value).toBe(21.6);
    expect(cool.run.values.find((v) => v.key === "direction")?.value).toBe("cooling");
    const none = builtinCalcRegistry().run({ calc: "mech.makeup_air_heat", inputs: { cfm: 1000, from_f: 72, to_f: 72 } });
    if (!none.ok) throw new Error(none.reason);
    expect(none.run.issues.map((i) => i.message)).toEqual(["The air arrives at the temperature it must be brought to, so it adds no load."]);
  });
});

describe("mech.pressurization", () => {
  it("7303 balances from the model: building +100 cfm positive, kitchen −220 negative against the library's kitchen target", () =>
    withTargets(fromLibrary, () => {
      const model = sampleGrill().head;
      const r = builtinCalcRegistry().run({ calc: "mech.pressurization", inputs: { scope: "model" }, model });
      if (!r.ok) throw new Error(r.reason);
      const value = (key: string) => r.run.values.find((v) => v.key === key)?.value;
      expect(value("building_net_cfm")).toBe(100);
      expect(value("building_exhaust_cfm")).toBe(3000);
      expect(value("building_makeup_cfm")).toBe(2400);
      expect(value("building_outdoor_cfm")).toBe(700);
      expect(value("building_state")).toBe("positive");
      expect(value("zone:z-kitchen:net_cfm")).toBe(-220);
      expect(value("zone:z-kitchen:state")).toBe("negative");
      expect(r.run.steps.map((s) => s.detail)).toEqual(expect.arrayContaining(["Exhaust −3,000 cfm (from exhaust_cfm)", "2,400 × 1.08 × (92 − 80) = 31,104 Btu/h heating, carried by RTU-2"]));
      expect(r.run.issues).toEqual([]);
    }));

  it("the library says why kitchens are negative, and a positive kitchen is flagged in those words", () => {
    expect(spaceUsePressureTarget(catalog, "kitchen_cooking")).toEqual({ target: "negative", why: expect.stringMatching(/^kitchens are kept negative to the dining room .*\(ASHRAE Handbook—HVAC Applications 2019 Ch\. 34, Kitchen Ventilation, not verified\)$/) });
    expect(spaceUsePressureTarget(catalog, "office_space")).toBeNull();
    const b = sampleGrill();
    b.ok({ type: "set_parameters", id: "mua1", scope: "instance", values: { makeup_air_cfm: 3200 } });
    const run = withTargets(fromLibrary, () => builtinCalcRegistry().run({ calc: pressurizationCalc.info.id, inputs: { scope: "zone", zone_id: "z-kitchen" }, model: b.head }));
    if (!run.ok) throw new Error(run.reason);
    const r = run.run;
    expect(r.values.find((v) => v.key === "zone:z-kitchen:net_cfm")?.value).toBe(580);
    expect(r.issues.map((i) => i.message)).toEqual([expect.stringMatching(/^Zone 2 Kitchen is positive \(\+580 cfm\); 102 Kitchen: kitchens are kept negative/)]);
    expect(r.values.some((v) => v.key.startsWith("building_"))).toBe(false);
  });

  it("an exhaust fan with no airflow: no building net, the issue names it", () => {
    const r = builtinCalcRegistry().run({ calc: "mech.pressurization", inputs: {}, model: sampleGrill({ kefCfm: null }).head });
    if (!r.ok) throw new Error(r.reason);
    expect(r.run.values.find((v) => v.key === "building_net_cfm")?.value).toBeNull();
    expect(r.run.issues.map((i) => i.message)).toContain("KEF-1 has no exhaust airflow (exhaust_cfm). Type it in Properties.");
  });

  it("needs a model", () => {
    const r = builtinCalcRegistry().run({ calc: "mech.pressurization", inputs: {} });
    expect(r.ok).toBe(false);
  });
});
