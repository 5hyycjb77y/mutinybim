/**
 * @jest-environment node
 *
 * Round 8b lane O (with lane C's price books behind COST_SOURCE_POINT): two
 * companies price the same quantity change privately. The change itself
 * (and its digest) carries no money; each company's amount comes only from
 * its own list, in its own process; neither can price with the other's; a
 * code with no general rate says so, never $0.
 *
 * Fails on round 8's code: there is no `priceQuantityDeltas` and no delta
 * between two versions to price.
 */
import { CostAccessError, asElementId, changedBetween, deltaDigest, priceQuantityDeltas, quantityDeltaFromReads, readForQuantityDelta, stateAt, type CostRate, type CostSourceDef } from "../src";
import { PackSet } from "../src/packs";
import { historyOf } from "./o8-fixtures";
import { FT, commit, threeOffices, wallRecord } from "./q7-fixtures";

const rate = (party: string, minor: number, extra: Partial<CostRate> = {}): CostRate => ({
  classification: { system: "firm:cost_codes", code: "TEST-0100" },
  unitRate: { minor, currency: "USD" },
  measure: "qto.length",
  per: "ft",
  provenance: { ownedBy: { party }, source: `${party} test rates`, date: "2026-10-01" },
  ...extra,
});

const source = (id: string, party: string, rates: readonly CostRate[]): CostSourceDef => ({
  id,
  party: { kind: party.startsWith("gc") ? "gc" : "developer", id: party, label: party },
  basis: "estimate",
  currency: "USD",
  effectiveDate: "2026-10-01",
  visibility: { kind: "party_only" },
  rates: () => rates,
});

const GC = source("book.gc", "gc-acme", [rate("gc-acme", 4_250), rate("gc-acme", 9_999, { stageId: "st-a" })]);
const OWNER = source("book.owner", "owner-dev", [rate("owner-dev", 6_000)]);
const EMPTY_SET = PackSet.create([]);

describe("o8-priced-by-party", () => {
  const base = commit(threeOffices(), { type: "set_classification", elementIds: ["t-1hr"], system: "firm:cost_codes", code: "TEST-0100" });
  const h = historyOf(base, [{ written: [wallRecord("W-20", { x: 0, y: 30 * FT }, { x: 20 * FT, y: 30 * FT }, { typeId: asElementId("t-1hr") })] }]);

  async function delta() {
    const ids = changedBetween(h.changesets, base.revision, h.head.revision);
    const reads = await readForQuantityDelta(ids, async (end, want) => stateAt(h.head, end === "from" ? base.revision : h.head.revision, h.changesets, want.map(asElementId)));
    return quantityDeltaFromReads(reads, ids, { system: "firm:cost_codes" });
  }

  it("each company prices the same change with its own book, privately", async () => {
    const deltas = await delta();
    expect(deltas.map((d) => d.group)).toEqual(["code:firm:cost_codes:TEST-0100"]);
    expect(JSON.stringify(deltas)).not.toMatch(/minor|currency|price|amount/);
    expect(deltaDigest(deltas)).toMatch(/^sha256:/);

    const gc = priceQuantityDeltas(deltas, EMPTY_SET, "book.gc", "gc-acme", [GC, OWNER]);
    const owner = priceQuantityDeltas(deltas, EMPTY_SET, "book.owner", "owner-dev", [GC, OWNER]);
    // 20 ft at the general rate; the stage-only rate is not used for a change summed across stages.
    expect(gc.total).toEqual({ minor: 85_000, currency: "USD" });
    expect(owner.total).toEqual({ minor: 120_000, currency: "USD" });
    expect(gc.source.party.id).toBe("gc-acme");
    expect(owner.lines[0]?.quantity).toBeCloseTo(20, 6);
  });

  it("neither company can price with the other's book", async () => {
    const deltas = await delta();
    expect(() => priceQuantityDeltas(deltas, EMPTY_SET, "book.owner", "gc-acme", [GC, OWNER])).toThrow(CostAccessError);
    expect(() => priceQuantityDeltas(deltas, EMPTY_SET, "book.gc", "owner-dev", [GC, OWNER])).toThrow(CostAccessError);
  });

  it("a change grouped without a code has no price, never $0", async () => {
    const ids = changedBetween(h.changesets, base.revision, h.head.revision);
    const reads = await readForQuantityDelta(ids, async (end, want) => stateAt(h.head, end === "from" ? base.revision : h.head.revision, h.changesets, want.map(asElementId)));
    const byType = quantityDeltaFromReads(reads, ids, { system: "other:codes" });
    const priced = priceQuantityDeltas(byType, EMPTY_SET, "book.gc", "gc-acme", [GC]);
    expect(priced.lines).toEqual([]);
    expect(priced.noRate.length).toBe(byType.length);
    expect(priced.total).toEqual({ minor: 0, currency: "USD" });
  });
});
