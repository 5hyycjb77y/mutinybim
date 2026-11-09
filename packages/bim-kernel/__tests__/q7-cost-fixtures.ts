/**
 * Round 7 lane Q cost fixtures: two test price lists for the three-office
 * model, one a contractor's (private to it), one a subcontractor's (shared
 * with the contractor). Synthetic codes and rates only.
 */
import { COST_SOURCE_POINT, type CostRate, type CostSourceDef } from "../src";
import { contribute, definePack, PackSet } from "../src/packs";

const rate = (party: string, code: string, measure: string, per: string, minor: number, stageId?: string): CostRate => ({
  classification: { system: "firm:cost_codes", code },
  ...(stageId ? { stageId } : {}),
  unitRate: { minor, currency: "USD" },
  measure,
  per,
  provenance: { ownedBy: { party, person: "estimator@example.test" }, source: `${party} test rates`, date: "2026-10-01" },
});

/** How many times the GC's rates were read (a refused reader must never trigger one). */
export const gcRatesRead = { count: 0 };

export const GC_SOURCE: CostSourceDef = {
  id: "zz.gc_estimate",
  party: { kind: "gc", id: "gc-acme", label: "Acme Builders (test)" },
  basis: "estimate",
  currency: "USD",
  effectiveDate: "2026-10-01",
  visibility: { kind: "party_only" },
  rates: () => {
    gcRatesRead.count += 1;
    return [rate("gc-acme", "TEST-0100", "qto.length", "ft", 4_250), rate("gc-acme", "TEST-0100", "qto.length", "ft", 5_000, "st-b")];
  },
};

export const SUB_SOURCE: CostSourceDef = {
  id: "zz.sub_quote",
  party: { kind: "sub", id: "sub-drywall", label: "Drywall sub (test)" },
  basis: "contract",
  currency: "USD",
  effectiveDate: "2026-10-15",
  visibility: { kind: "shared_with", parties: ["gc-acme"] },
  rates: () => [rate("sub-drywall", "TEST-0100", "qto.area_net", "ft2", 375)],
};

export const COST_TEST_PACK = definePack({ id: "zz", name: "Test price lists", version: "1.0.0", kernel: "^1.0.0" }, [contribute(COST_SOURCE_POINT, [GC_SOURCE, SUB_SOURCE])]);
export const COST_TEST_SET = PackSet.create([COST_TEST_PACK]);
