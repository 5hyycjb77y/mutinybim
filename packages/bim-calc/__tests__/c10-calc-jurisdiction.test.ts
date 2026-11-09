/**
 * @jest-environment node
 *
 * Round 10 lane C10: calc requests name where the project is with the open
 * jurisdiction id (any country), and per-family editions as one map. US
 * projects compute identically: every listed calc's example gives the same
 * run (same values, steps, citations and run key) whether the request says
 * `state: "VA"` (the old field) or `jurisdiction: { country: "US",
 * subdivision: "US-VA" }`. A place with no adoption on file is refused in
 * words. Fails on round 9: `jurisdiction` and `editions` didn't exist.
 */
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { adoptionJurisdiction, adoptionTableKey, builtinCalcRegistry, codeBookFor, requestJurisdiction } from "../src";

installFirstPartyAddOns();
const registry = builtinCalcRegistry();
const FEEDER = { circuit: "feeder", system: "3ph_4w", voltage_v: 480, continuous_load_a: 100, length_ft: 250 };
const VA = { country: "US", subdivision: "US-VA" } as const;

describe("c10 calc jurisdiction", () => {
  it("every listed calc's example runs identically under state \"VA\" and the jurisdiction id", () => {
    for (const info of registry.list()) {
      if (!info.example) continue;
      const old = registry.run({ calc: info.id, inputs: info.example, state: "VA" });
      const next = registry.run({ calc: info.id, inputs: info.example, jurisdiction: VA });
      const key = registry.run({ calc: info.id, inputs: info.example, jurisdiction: "US/US-VA" });
      expect({ id: info.id, run: next }).toEqual({ id: info.id, run: old });
      expect({ id: info.id, run: key }).toEqual({ id: info.id, run: old });
    }
  });

  it("per-family editions: { nec: \"2023\" } is the old necEdition; { ipc: \"2021\" } the old plumbingEdition", () => {
    const old = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, state: "VA", necEdition: "2023" });
    const next = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, jurisdiction: VA, editions: { nec: "2023" } });
    expect(next).toEqual(old);
    expect(registry.run({ calc: "nec.size_circuit", inputs: FEEDER, editions: { nec: "2017" } })).toEqual({ ok: false, reason: "NEC 2017 isn't an edition the NEC pack covers (2020 or 2023)." });
  });

  it("a place outside the US is read, and refused in words when no adoption is on file", () => {
    const r = registry.run({ calc: "nec.size_circuit", inputs: FEEDER, jurisdiction: { country: "SE" } });
    expect(!r.ok && r.reason).toMatch(/^No NEC adoption is on file for Sweden \(on file: VA, MD, DC\)/);
    expect(requestJurisdiction({ jurisdiction: "CA-ON" })).toEqual({ country: "CA", subdivision: "CA-ON" });
    expect(adoptionTableKey({ country: "CA", subdivision: "CA-ON" })).toBeNull();
  });

  it("the adoption tables read through the open id and say which place each row is for", () => {
    expect(codeBookFor(VA, "plumbing")?.shortName).toBe("VPC");
    expect(codeBookFor("va", "plumbing")?.shortName).toBe("VPC");
    expect(adoptionJurisdiction({ state: "MD" })).toEqual({ country: "US", subdivision: "US-MD" });
  });
});
