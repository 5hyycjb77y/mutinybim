/**
 * @jest-environment node
 *
 * Round 11 W11 (D1): a purpose that restricts reading (shop drawings,
 * submittals, operations records) hides the copy from the design's readers
 * who aren't named on it: they can't open it, it isn't in their copy list or
 * their branch list, and they can't copy it. Naming them shows it.
 *
 * Fails on round 10's code: every branch was listed to, and opened by,
 * everyone who reads its base.
 */
import { LINEAGE_RIGHTS_WORDS } from "../src/lineages";
import { admit, BASE, expectLineage, riley, sam, startCopies } from "./support/w11-copies";

describe("w11-restricted-role-hides", () => {
  it("a shop copy is invisible to readers who aren't named, until they are", async () => {
    const env = await startCopies();
    const samOnDesign = await admit(env, sam, BASE);
    const shop = expectLineage(await samOnDesign.ask({ type: "lineage_create", name: "Acme shop drawings", role: "shop" }), "lineage_saved").lineage;
    const proposal = expectLineage(await samOnDesign.ask({ type: "lineage_create", name: "Open option", role: "proposal" }), "lineage_saved").lineage;
    const shopId = `${BASE}~${shop.id}`;

    await expect(admit(env, riley, shopId)).rejects.toThrow(LINEAGE_RIGHTS_WORDS.noRead);
    const rileyOnDesign = await admit(env, riley, BASE);
    expect(expectLineage(await rileyOnDesign.ask({ type: "lineage_list" }), "lineages").lineages.map((l) => l.id)).toEqual(["main", proposal.id]);
    expect(expectLineage(await rileyOnDesign.ask({ type: "lineage_create", name: "Peek", role: "proposal", from: shop.id }), "request_refused").reason).toBe(LINEAGE_RIGHTS_WORDS.noRead);
    const compared = expectLineage(await rileyOnDesign.ask({ type: "lineage_compare", a: "main", b: shop.id }), "request_refused");
    expect(compared.reason).toBe(LINEAGE_RIGHTS_WORDS.noRead);

    env.copies.grant(BASE, shop.id, riley.id, "read");
    const rileyNamed = await admit(env, riley, shopId);
    expect(rileyNamed.principal.canWrite).toBe(false);
    expect(expectLineage(await rileyNamed.ask({ type: "lineage_list" }), "lineages").lineages.map((l) => l.id)).toEqual(["main", shop.id, proposal.id]);
  });

  it("branch_list on a per-copy connection leaves out copies the person can't read", async () => {
    const env = await startCopies();
    const samOnDesign = await admit(env, sam, BASE);
    const shop = expectLineage(await samOnDesign.ask({ type: "lineage_create", name: "Acme shop", role: "shop" }), "lineage_saved").lineage;
    const rileyOnDesign = await admit(env, riley, BASE);
    const listed = await rileyOnDesign.client.request({ type: "branch_list" });
    expect(listed.type).toBe("branches");
    if (listed.type === "branches") expect(listed.branches.map((b) => b.branchId)).not.toContain(shop.id);
    const samListed = await samOnDesign.client.request({ type: "branch_list" });
    if (samListed.type === "branches") expect(samListed.branches.map((b) => b.branchId)).toContain(shop.id);
  });
});
