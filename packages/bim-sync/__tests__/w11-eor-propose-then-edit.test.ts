/**
 * @jest-environment node
 *
 * Round 11 W11 (D1, product decision answer 2): the engineer of record — the parent's
 * responsible professional whose scope covers what the contractor's copy
 * changes — holds propose (and review) on that copy without being named,
 * and edit only once the copy's owner grants it. Someone whose scope covers
 * nothing the copy changed sees nothing of it.
 *
 * Fails on round 10's code: a copy was authorized as its base (the engineer
 * of record could edit it outright as a Main editor, and nobody could hold
 * propose); there was no review act on the wire.
 */
import { type BimElement } from "@permitzip/bim-kernel";
import { lineageDelta, lineageLookup } from "@permitzip/bim-kernel/lineages";
import { LINEAGE_RIGHTS_WORDS } from "../src/lineages";
import { admit, BASE, editTerminal, expectLineage, avery, sam, startCopies } from "./support/w11-copies";

describe("w11-eor-propose-then-edit", () => {
  it("propose and review by default, edit when the owner grants it", async () => {
    // Avery's accepted scope covers terminal sd-1 (the host's coverage, read as the person).
    const covering = async (input: { userId: string; chain: readonly { lineage: { id: string } }[]; changed: (id: string) => Promise<readonly BimElement[]> }) => {
      const out = new Set<string>();
      if (input.userId !== avery.id) return out;
      for (const link of input.chain.slice(0, -1)) if ((await input.changed(link.lineage.id)).some((el) => el.id === "sd-1")) out.add(link.lineage.id);
      return out;
    };
    const env = await startCopies({ responsibleOn: covering });
    const samOnDesign = await admit(env, sam, BASE);
    const shop = expectLineage(await samOnDesign.ask({ type: "lineage_create", name: "Acme shop drawings", role: "shop", owner: { party: "Acme Mechanical" } }), "lineage_saved").lineage;
    const shopId = `${BASE}~${shop.id}`;

    // Before the copy touches Avery's scope, it's shared only with the people named on it.
    await expect(admit(env, avery, shopId)).rejects.toThrow(LINEAGE_RIGHTS_WORDS.noRead);

    const samOnShop = await admit(env, sam, shopId);
    expect(await editTerminal(samOnShop, 410)).toEqual({ status: "committed" });

    // Now it does: Avery reads, may propose and review, can't edit.
    const averyOnShop = await admit(env, avery, shopId);
    expect([...(averyOnShop.principal.lineage?.rights.get(shop.id) ?? [])].sort()).toEqual(["propose", "read", "review"]);
    expect(await editTerminal(averyOnShop, 999)).toEqual({ status: "rejected", message: LINEAGE_RIGHTS_WORDS.noEdit });

    // He records a review over the delta he was shown; the design is untouched.
    const rows = await env.host.registry.rows(BASE);
    const lookup = lineageLookup(rows.map((r) => r.lineage));
    const line = await env.host.line(shop.id);
    const head = await line.head();
    const delta = lineageDelta(lookup, { lineageId: shop.id, head, changes: await line.history.changesBetween(0, head.revision) });
    const designBefore = (await env.host.main.store.head()).revision;
    const reviewed = expectLineage(await averyOnShop.ask({ type: "lineage_review", lineageId: shop.id, outcome: "approved_as_noted", reason: "Keep 2 in clear above the ceiling.", deltaDigest: delta.deltaDigest }), "lineage_act_recorded");
    expect(reviewed.act).toMatchObject({ kind: "review", lineageId: shop.id, to: "main", outcome: "approved_as_noted" });
    expect(env.acts.recorded).toHaveLength(1);
    expect((await env.host.main.store.head()).revision).toBe(designBefore);
    // Sam, a named editor without a review grant, can't record one.
    expect(expectLineage(await samOnShop.ask({ type: "lineage_review", lineageId: shop.id, outcome: "approved", deltaDigest: delta.deltaDigest }), "request_refused").reason).toBe(LINEAGE_RIGHTS_WORDS.noReview);

    // The owner raises Avery to edit.
    env.copies.grant(BASE, shop.id, avery.id, "edit");
    const averyRaised = await admit(env, avery, shopId);
    expect(averyRaised.principal.canWrite).toBe(true);
    expect(await editTerminal(averyRaised, 415)).toEqual({ status: "committed" });
  });
});
