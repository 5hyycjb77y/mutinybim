/**
 * @jest-environment node
 *
 * `struct.simple_beam` through the real calc registry (`runPackCalc`), with
 * the Structural pack's set in force. Since round 14 Structural is
 * first-party, so every set has it.
 */
import { PackSet, runPackCalc } from "@permitzip/bim-pack";
import { installedFirstPartyPacks } from "@permitzip/bim-pack";

/** The first-party add-ons every host installs (jest.setup.js installs them before this file loads). */
const FIRST_PARTY_PACKS = installedFirstPartyPacks();
import { SIMPLE_BEAM_CALC, STRUCTURAL_PACK } from "../src";

const SET = PackSet.create([...FIRST_PARTY_PACKS]);
const OTHERS = PackSet.create([]);
const B2 = { span_ft: 30, uniform_plf: 526, point_loads: [{ p_lbf: 2000, a_ft: 10, label: "RTU-1" }], allowable_moment_kip_ft: 100 };

function run(inputs: unknown, set = SET) {
  const r = runPackCalc(set, { calc: "struct.simple_beam", inputs });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}

describe("c5x struct.simple_beam on the calc point", () => {
  it("is a defineCalc plugin in the pack's own domain, with a JSON schema", () => {
    expect(SIMPLE_BEAM_CALC.info).toMatchObject({ id: "struct.simple_beam", domain: "struct", codeFamily: null, needsModel: false });
    expect(SIMPLE_BEAM_CALC.info.inputSchema).toMatchObject({ type: "object" });
  });

  it("runs through the registry with values in lbf, lbf·ft and ft, each citing the method", () => {
    // Hand check in c5x-simple-beam: R1 = 9,223.33 lbf, R2 = 8,556.67 lbf, M = 69,597.5 lb-ft at 13.73 ft; 69.6 / 100 kip-ft.
    const out = run(B2);
    expect(out.values.map((v) => [v.key, v.value, v.unit])).toEqual([
      ["start_reaction", 9223.3, "lbf"],
      ["end_reaction", 8556.7, "lbf"],
      ["max_moment", 69597, "lbf.ft"],
      ["max_moment_at", 13.73, "ft"],
      ["utilisation", 0.696, "ratio"],
    ]);
    expect(out.values.filter((v) => v.key !== "utilisation").every((v) => v.cite[0]?.clause === "Table 3-23, cases 1 and 8")).toBe(true);
    expect(out.issues.map((i) => i.message)).toContain("One service-level load case (dead + live + equipment, unfactored). Load combinations are not applied.");
  });

  it("an overstressed beam is an error issue; bad inputs are refused in words", () => {
    expect(run({ ...B2, point_loads: [], allowable_moment_kip_ft: 50 }).issues.some((i) => i.severity === "error" && i.message.includes("of the allowable"))).toBe(true);
    const bad = runPackCalc(SET, { calc: "struct.simple_beam", inputs: { span_ft: -1 } });
    expect(bad.ok).toBe(false);
  });

  it("without E and I: the same five values, steps and issues as before, and no new inputs in the run (so its runKey holds)", () => {
    const out = run(B2);
    expect(out.values.map((v) => v.key)).toEqual(["start_reaction", "end_reaction", "max_moment", "max_moment_at", "utilisation"]);
    expect(out.steps.map((s) => s.label)).toEqual(["Reactions", "Largest moment"]);
    expect(out.issues).toHaveLength(1);
    expect(Object.keys(out.inputs as object).sort()).toEqual(["allowable_moment_kip_ft", "point_loads", "span_ft", "uniform_plf"]);
  });

  it("with E (ksi) and I (in⁴): the largest deflection in inches and where it is in feet, citing the deflection method", () => {
    // B2 with E = 29,000 ksi, I = 510 in⁴. Numerical double integration of EI·v″ = −M (independent of this code):
    // Δ = 0.760294649 in at 14.799405 ft. Rounded: 0.76 in at 14.8 ft.
    const out = run({ ...B2, elastic_modulus_ksi: 29000, moment_inertia_in4: 510 });
    expect(out.values.map((v) => [v.key, v.value, v.unit])).toEqual([
      ["start_reaction", 9223.3, "lbf"],
      ["end_reaction", 8556.7, "lbf"],
      ["max_moment", 69597, "lbf.ft"],
      ["max_moment_at", 13.73, "ft"],
      ["utilisation", 0.696, "ratio"],
      ["max_deflection", 0.76, "in"],
      ["max_deflection_at", 14.8, "ft"],
    ]);
    const d = out.values.filter((v) => v.key.startsWith("max_deflection"));
    expect(d.every((v) => v.cite[0]?.clause === "Table 3-23, cases 1 and 8 (deflection)")).toBe(true);
    expect(out.steps.map((s) => s.label)).toContain("Largest deflection");
    expect(out.issues.some((i) => i.severity === "info" && i.message.includes("no shear deformation") && i.message.includes("No deflection limit is checked"))).toBe(true);
    expect(out.issues.some((i) => i.severity === "error")).toBe(false);
  });

  it("the benchmark: 20 ft, 500 plf, E = 29,000 ksi, I = 100 in⁴ deflects 5wL⁴/384EI = 0.621 in at 10 ft; 2,000 lbf at midspan alone, PL³/48EI = 0.199 in", () => {
    const u = run({ span_ft: 20, uniform_plf: 500, elastic_modulus_ksi: 29000, moment_inertia_in4: 100 });
    expect(u.values.find((v) => v.key === "max_deflection")?.value).toBe(0.621);
    expect(u.values.find((v) => v.key === "max_deflection_at")?.value).toBe(10);
    const p = run({ span_ft: 20, uniform_plf: 0, point_loads: [{ p_lbf: 2000, a_ft: 10 }], elastic_modulus_ksi: 29000, moment_inertia_in4: 100 });
    expect(p.values.find((v) => v.key === "max_deflection")?.value).toBe(0.199);
    expect((p.detail as { maxDeflection: number } | null)?.maxDeflection).toBeCloseTo(((2000 * 240 ** 3) / (48 * 29e6 * 100)) * 0.0254, 12); // PL³/48EI in inches, as metres (canonical)
  });

  it("half a stiffness is an error issue in words; zero, negative or non-finite E or I is refused", () => {
    const half = run({ ...B2, elastic_modulus_ksi: 29000 });
    expect(half.values).toEqual([]);
    expect(half.issues).toEqual([expect.objectContaining({ severity: "error", message: expect.stringContaining("Deflection needs the moment of inertia (I) as well as the modulus of elasticity (E)") })]);
    expect(run({ ...B2, moment_inertia_in4: 100 }).issues[0]?.message).toContain("Deflection needs the modulus of elasticity (E)");
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(runPackCalc(SET, { calc: "struct.simple_beam", inputs: { ...B2, elastic_modulus_ksi: bad, moment_inertia_in4: 100 } }).ok).toBe(false);
      expect(runPackCalc(SET, { calc: "struct.simple_beam", inputs: { ...B2, elastic_modulus_ksi: 29000, moment_inertia_in4: bad } }).ok).toBe(false);
    }
  });

  it("publishes E and I in its JSON schema with the unit in the name", () => {
    const props = (SIMPLE_BEAM_CALC.info.inputSchema as { properties: Record<string, unknown>; required?: string[] }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["elastic_modulus_ksi", "moment_inertia_in4"]));
    expect((SIMPLE_BEAM_CALC.info.inputSchema as { required?: string[] }).required ?? []).not.toContain("elastic_modulus_ksi");
  });

  it("is offered in a model that pins nothing, Structural being first-party (round 14)", () => {
    expect(FIRST_PARTY_PACKS).toContain(STRUCTURAL_PACK);
    expect(runPackCalc(OTHERS, { calc: "struct.simple_beam", inputs: B2 }).ok).toBe(true);
  });
});
