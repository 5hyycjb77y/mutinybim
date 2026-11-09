/**
 * @jest-environment node
 *
 * Round 7 lane Q, product owner decision 4: the shared model never holds money.
 * Pricing a takeoff through a test price list multiplies the model's
 * quantities in this process only: the model state, the next changeset and
 * what the model server would store are byte-identical with and without the
 * pricing, and no model command takes money.
 *
 * Fails on the old code: there was no `priceTakeoff`, so the reserved cost
 * slots had no engine at all.
 */
import { canonicalJson, commandSchema, priceTakeoff, type ModelState } from "../src";
import { withPackSet } from "../src/packs";
import { COST_TEST_SET } from "./q7-cost-fixtures";
import { commit, threeOffices, tryCommit } from "./q7-fixtures";

function priced(): ModelState {
  let m = threeOffices();
  m = commit(m, { type: "set_classification", elementIds: ["t-1hr"], system: "firm:cost_codes", code: "TEST-0100" });
  m = commit(m, { type: "add_construction_stage", stageId: "st-a", name: "Stage A" });
  m = commit(m, { type: "add_construction_stage", stageId: "st-b", name: "Stage B" });
  m = commit(m, { type: "set_construction_stage", elementIds: ["W-11", "W-12", "W-13"], stageId: "st-a" });
  return commit(m, { type: "set_construction_stage", elementIds: ["W-14", "W-15"], stageId: "st-b" });
}

describe("q7 cost never stored", () => {
  it("prices with the most specific rate and says where every number came from", () => {
    const m = priced();
    const p = withPackSet(COST_TEST_SET, () => priceTakeoff(m, "zz.gc_estimate", "gc-acme"));
    // Stage A: 45 ft at $42.50; Stage B: 30 ft at its own $50.00 rate.
    const a = p.lines.find((l) => l.stageId === "st-a");
    const b = p.lines.find((l) => l.stageId === "st-b");
    expect(a?.quantity).toBeCloseTo(45, 6);
    expect(a?.amount).toEqual({ minor: 191_250, currency: "USD" });
    expect(b?.unitRate.minor).toBe(5_000);
    expect(b?.amount).toEqual({ minor: 150_000, currency: "USD" });
    expect(p.total).toEqual({ minor: 341_250, currency: "USD" });
    expect(a?.provenance.ownedBy.party).toBe("gc-acme");
    expect(a?.quantityFrom).toEqual({ from: "centreline length", elementCount: 3 });
    expect(p.totalProvenance).toMatchObject({ ownedBy: { party: "gc-acme" }, source: "zz.gc_estimate", lines: expect.arrayContaining([a?.takeoffKey, b?.takeoffKey]) });
  });

  it("leaves the model, its next changeset and the stored records byte-identical", () => {
    const m = priced();
    const stateBefore = canonicalJson(m);
    const edit = { type: "move_wall", wallId: "W-11", delta: { x: 0, y: 100 } } as const;
    const plain = tryCommit(m, edit);
    withPackSet(COST_TEST_SET, () => priceTakeoff(m, "zz.gc_estimate", "gc-acme"));
    withPackSet(COST_TEST_SET, () => priceTakeoff(m, "zz.sub_quote", "gc-acme"));
    expect(canonicalJson(m)).toBe(stateBefore);
    const afterPricing = tryCommit(m, edit);
    if (!plain.ok || !afterPricing.ok) throw new Error("move_wall refused");
    const strip = (c: typeof plain.changeset) => canonicalJson({ ...c, idempotencyKey: "" });
    expect(strip(afterPricing.changeset)).toBe(strip(plain.changeset));
    expect(canonicalJson(afterPricing.model.elements)).toBe(canonicalJson(plain.model.elements));
    expect(stateBefore).not.toMatch(/"minor"|"currency"|unitRate/);
  });

  it("no model command takes money", () => {
    const keys = new Set<string>();
    for (const option of commandSchema.options) for (const k of Object.keys(option.shape)) keys.add(k);
    for (const k of ["minor", "currency", "unitRate", "amount", "price", "cost"]) expect(keys.has(k)).toBe(false);
  });
});
