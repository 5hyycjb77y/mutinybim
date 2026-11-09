/**
 * @jest-environment node
 *
 * Round 7 lane Q, product owner decision 4: prices are private to the company that
 * owns them. In one process holding both price lists, a subcontractor's
 * session can't list, read or price with the contractor's private list (and
 * isn't told it exists), the contractor's own session can, and a list the
 * subcontractor shares with the contractor reads from the contractor's
 * session only.
 *
 * Fails on the old code: there was no reader of `COST_SOURCE_POINT`, so
 * nothing filtered by party.
 */
import { CostAccessError, costSourcesFor, priceTakeoff } from "../src";
import { withPackSet } from "../src/packs";
import { COST_TEST_SET, gcRatesRead } from "./q7-cost-fixtures";
import { commit, threeOffices } from "./q7-fixtures";

const model = commit(threeOffices(), { type: "set_classification", elementIds: ["t-1hr"], system: "firm:cost_codes", code: "TEST-0100" });

describe("q7 party privacy", () => {
  it("a sub's session doesn't see the GC's private list", () => {
    expect(costSourcesFor(COST_TEST_SET, "sub-drywall").map((s) => s.id)).toEqual(["zz.sub_quote"]);
    expect(costSourcesFor(COST_TEST_SET, "gc-acme").map((s) => s.id)).toEqual(["zz.gc_estimate", "zz.sub_quote"]);
    expect(costSourcesFor(COST_TEST_SET, "lender-x")).toEqual([]);
    expect(costSourcesFor(COST_TEST_SET, "")).toEqual([]);
  });

  it("pricing with the GC's list from a sub's session is refused before any rate is read, in words that reveal nothing", () => {
    const readsBefore = gcRatesRead.count;
    let refused: unknown = null;
    try {
      withPackSet(COST_TEST_SET, () => priceTakeoff(model, "zz.gc_estimate", "sub-drywall"));
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(CostAccessError);
    const missing = (() => {
      try {
        withPackSet(COST_TEST_SET, () => priceTakeoff(model, "zz.no_such_list", "sub-drywall"));
        return "";
      } catch (err) {
        return err instanceof Error ? err.message.replace("zz.no_such_list", "zz.gc_estimate") : "";
      }
    })();
    expect(refused instanceof Error ? refused.message : "").toBe(missing);
    expect(gcRatesRead.count).toBe(readsBefore);
  });

  it("the GC prices with its own list and with the sub's shared one", () => {
    const own = withPackSet(COST_TEST_SET, () => priceTakeoff(model, "zz.gc_estimate", "gc-acme"));
    expect(own.total.minor).toBeGreaterThan(0);
    const shared = withPackSet(COST_TEST_SET, () => priceTakeoff(model, "zz.sub_quote", "gc-acme"));
    expect(shared.source.party.id).toBe("sub-drywall");
    expect(shared.lines.every((l) => l.provenance.ownedBy.party === "sub-drywall")).toBe(true);
  });
});
