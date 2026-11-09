/**
 * @jest-environment node
 *
 * Round 6 lane P: moving Plumbing and gas into its add-on changed no number
 * and no stored name.
 *
 * - The riser and isometric goldens the moved suites compare against are the
 *   bytes they were before the move (sha-256 of each file at the round's base).
 * - 7492 Sample Market gas golden: 1,024,407 Btu/h and the 1-1/4" manifold, read
 *   through the built-in calc registry (what agents and the Plumbing tab run)
 *   and through this add-on's own calc row in a set holding only it: the
 *   same answer both ways.
 * - Stack commands parse back to the bytes they were sent as.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { builtinCalcRegistry, CalcRegistry, CALC_POINT } from "@permitzip/bim-calc";
import { canonicalJson, commandSchema } from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { buildSampleMarketGas, SAMPLE_MARKET_GAS_SYSTEM, SAMPLE_MARKET_GAS_TOTAL_MBH } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { PLUMBING_GAS_PACK, type GasSystemSizing } from "../src";

const GOLDEN_SHA256: Readonly<Record<string, string>> = {
  "isometric-stack.svg": "7dbe17313cc64e7357bdd636849d79c5b7bc2b1afce8ab6c72565ff09e57f970",
  "riser-gas-propane.svg": "54facae6cbd775191117315fefd92160bfbfef122f1d57f6ae5e1c89115cb711",
  "riser-stack-sanitary.svg": "561aaa78344eea448ab28052746ea0b6118088fc938d593d5faf4a47628dc87a",
  "riser-sample-market-dcw.svg": "15c6120e1b0360b2b64587a8cd913f1b579ad4206ff3c84b99aa7cc1d2f0c150",
  "riser-sample-market-dhw.svg": "7b26412b42f66d8eae6297ded1f734964e7f19c8d60e7553624b8b729b7f756f",
  "riser-sample-market-gas.svg": "daf8736c4e85506d96650494890f564962098cdbe668e54fef1e7e1a1108d269",
  "riser-sample-market-sanitary.svg": "cf9c8e827fa8706f5b90b5eb68787cb85f914a5172b23ee6f522309b919071cb",
};

function gasSizing(registry: CalcRegistry): GasSystemSizing {
  const r = registry.run({ calc: "plumbing.gas_system", inputs: { system_id: SAMPLE_MARKET_GAS_SYSTEM }, model: buildSampleMarketGas(), state: "VA" });
  if (!r.ok) throw new Error(r.reason);
  const sizing = r.run.detail as GasSystemSizing | undefined;
  if (!sizing) throw new Error("gas sizing returned no detail");
  return sizing;
}

const manifold = (s: GasSystemSizing) => s.proposals.find((p) => p.segmentId === "main-s3")?.proposed;

describe("Plumbing and gas numbers are unchanged by the move", () => {
  it("the moved goldens are byte-identical", () => {
    for (const [name, sha] of Object.entries(GOLDEN_SHA256)) {
      expect([name, createHash("sha256").update(readFileSync(path.join(__dirname, "golden", name))).digest("hex")]).toEqual([name, sha]);
    }
  });

  it("7492 Sample Market gas: 1,024,407 Btu/h and a 1-1/4\" manifold, through the registry and through the add-on alone", () => {
    const viaRegistry = gasSizing(builtinCalcRegistry());
    const alone = withPackSet(PackSet.create([PLUMBING_GAS_PACK]), () => gasSizing(new CalcRegistry({ packPoint: CALC_POINT })));
    expect(viaRegistry.totalMbh).toBe(SAMPLE_MARKET_GAS_TOTAL_MBH);
    expect(viaRegistry.totalMbh).toBe(1024.407);
    expect(manifold(viaRegistry)).toBe("1-1/4");
    expect(canonicalJson(alone)).toBe(canonicalJson(viaRegistry));
  });

  it("stack commands keep their stored bytes", () => {
    for (const sent of [
      { type: "name_stacks", stacks: [{ stackId: "stack-1", pipeId: "seg-1", number: "1" }] },
      { type: "edit_stack", stackId: "stack-1", name: null },
      { type: "delete_stacks", stackIds: ["stack-1"] },
      { type: "set_stack_checks", baseClearanceDiameters: 3 },
    ]) {
      const parsed = commandSchema.safeParse(sent);
      expect(parsed.success ? canonicalJson(parsed.data) : parsed.error.issues.map((i) => i.message).join("; ")).toBe(canonicalJson(sent));
    }
  });
});
