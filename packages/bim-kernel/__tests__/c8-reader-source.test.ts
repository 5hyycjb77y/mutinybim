/**
 * @jest-environment node
 *
 * Round 8b lane C: a company's price book lives only in the reader's process
 * (fetched for that reader under the host's access rules), never in the
 * model's pack set, which the host binds for every reader. Pricing must
 * still find it, still apply `canReadCostSource`, and say which codes it has
 * no rate for instead of dropping them.
 *
 * Fails on round 8's code: `priceTakeoff` only looked in the bound set, so a
 * reader's own source was "no price list you can read" once the model's set
 * was bound, and a code the source lacked vanished from the result.
 */
import { CostAccessError, priceTakeoff, type CostRate, type CostSourceDef } from "../src";
import { bindModelPacks, PackSet, unbindModelPacks } from "../src/packs";
import { commit, threeOffices } from "./q7-fixtures";

const rate = (code: string, minor: number, stageId?: string): CostRate => ({
  classification: { system: "firm:cost_codes", code },
  ...(stageId ? { stageId } : {}),
  unitRate: { minor, currency: "USD" },
  measure: "qto.length",
  per: "ft",
  provenance: { ownedBy: { party: "co-a" }, source: "Company A book", date: "2026-11-01" },
});

let reads = 0;
const book = (rates: readonly CostRate[]): CostSourceDef => ({
  id: "host.book.a",
  party: { kind: "company", id: "co-a", label: "Company A (test)" },
  basis: "estimate",
  currency: "USD",
  effectiveDate: "2026-11-01",
  visibility: { kind: "party_only" },
  rates: () => {
    reads += 1;
    return rates;
  },
});

function staged() {
  let m = threeOffices();
  m = commit(m, { type: "set_classification", elementIds: ["t-1hr"], system: "firm:cost_codes", code: "TEST-0100" });
  m = commit(m, { type: "add_construction_stage", stageId: "st-a", name: "Stage A" });
  m = commit(m, { type: "add_construction_stage", stageId: "st-b", name: "Stage B" });
  m = commit(m, { type: "set_construction_stage", elementIds: ["W-11", "W-12", "W-13"], stageId: "st-a" });
  return commit(m, { type: "set_construction_stage", elementIds: ["W-14", "W-15"], stageId: "st-b" });
}

describe("c8 reader source", () => {
  const model = staged();
  beforeAll(() => bindModelPacks(model.modelId, PackSet.create([])));
  afterAll(() => unbindModelPacks(model.modelId));

  it("prices with the reader's own source while the model's set is bound", () => {
    const source = book([rate("TEST-0100", 4_250), rate("TEST-0100", 5_000, "st-b")]);
    expect(() => priceTakeoff(model, source.id, "co-a")).toThrow(CostAccessError);
    const p = priceTakeoff(model, source.id, "co-a", { sources: [source] });
    expect(p.total).toEqual({ minor: 45 * 4_250 + 30 * 5_000, currency: "USD" });
    expect(p.source.party.id).toBe("co-a");
    expect(p.noRate).toEqual([]);
  });

  it("still refuses another company before reading a rate", () => {
    const source = book([rate("TEST-0100", 4_250)]);
    const before = reads;
    expect(() => priceTakeoff(model, source.id, "co-b", { sources: [source] })).toThrow(CostAccessError);
    expect(reads).toBe(before);
  });

  it("names the codes the source has no rate for, once per code and stage, and adds nothing for them", () => {
    const source = book([rate("TEST-0999", 100)]);
    const p = priceTakeoff(model, source.id, "co-a", { sources: [source] });
    expect(p.lines).toEqual([]);
    expect(p.total).toEqual({ minor: 0, currency: "USD" });
    expect(p.noRate.map((l) => `${l.code}/${l.stageId}/${l.elementCount}`)).toEqual(["TEST-0100/st-a/3", "TEST-0100/st-b/2"]);
  });
});
