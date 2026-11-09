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

  it("is offered in a model that pins nothing, Structural being first-party (round 14)", () => {
    expect(FIRST_PARTY_PACKS).toContain(STRUCTURAL_PACK);
    expect(runPackCalc(OTHERS, { calc: "struct.simple_beam", inputs: B2 }).ok).toBe(true);
  });
});
