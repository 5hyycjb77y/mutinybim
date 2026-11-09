/**
 * @jest-environment node
 *
 * Round 11 W11 (D1, product decision answer 2): a contractor's people edit their copy
 * and never the design. Sam (Acme Mechanical) reads the design, starts a
 * shop-drawings copy of it and names Riley; both edit the copy; neither can
 * edit the design, and Sam can't accept their own records back onto it.
 *
 * Fails on round 10's code: a copy was authorized as its base, so a
 * contractor who could edit their copy could edit Main (and a reader could
 * edit neither); there was no per-copy member store or lineage message.
 */
import { LINEAGE_RIGHTS_WORDS } from "../src/lineages";
import { admit, BASE, editTerminal, expectLineage, avery, riley, sam, startCopies } from "./support/w11-copies";

describe("w11-copy-editor-cannot-write-main", () => {
  it("a copy's named editors edit the copy, are refused on the design with the words, and can't accept back onto it", async () => {
    const env = await startCopies();
    const samOnDesign = await admit(env, sam, BASE);
    expect(samOnDesign.principal.canWrite).toBe(false);
    const made = expectLineage(await samOnDesign.ask({ type: "lineage_create", name: "Acme ductwork shop drawings", role: "shop", owner: { party: "Acme Mechanical" } }), "lineage_saved");
    expect(made.lineage).toMatchObject({ role: "shop", returnPolicy: "accept_back", parent: { lineageId: "main" }, owner: { party: "Acme Mechanical" }, createdBy: { subject: sam.id } });
    env.copies.grant(BASE, made.lineage.id, riley.id, "edit");
    const shopId = `${BASE}~${made.lineage.id}`;

    // Both edit their copy.
    const samOnShop = await admit(env, sam, shopId);
    const rileyOnShop = await admit(env, riley, shopId);
    expect([samOnShop.principal.canWrite, rileyOnShop.principal.canWrite]).toEqual([true, true]);
    expect(await editTerminal(samOnShop, 410)).toEqual({ status: "committed" });
    expect(await editTerminal(rileyOnShop, 420, "sd-2")).toEqual({ status: "committed" });

    // Neither edits the design: refused with the words, nothing written.
    const designHead = (await env.host.main.store.head()).revision;
    const rileyOnDesign = await admit(env, riley, BASE);
    expect(await editTerminal(samOnDesign, 999)).toEqual({ status: "rejected", message: LINEAGE_RIGHTS_WORDS.noEditOnAncestor });
    expect(await editTerminal(rileyOnDesign, 999)).toEqual({ status: "rejected", message: LINEAGE_RIGHTS_WORDS.noEditOnAncestor });
    expect((await env.host.main.store.head()).revision).toBe(designHead);

    // The only way back is an act by someone who may edit the design.
    const back = await samOnShop.ask({ type: "lineage_accept_back", from: made.lineage.id, recordIds: ["sd-1"], deltaDigest: "0".repeat(64) });
    expect(expectLineage(back, "request_refused").reason).toBe(LINEAGE_RIGHTS_WORDS.noAcceptBack);
    expect((await env.host.main.store.head()).revision).toBe(designHead);

    // The design's editor keeps editing the design, and the copy is still the contractor's.
    const averyOnDesign = await admit(env, avery, BASE);
    expect(await editTerminal(averyOnDesign, 300)).toEqual({ status: "committed" });
    await expect(admit(env, avery, shopId)).rejects.toThrow(LINEAGE_RIGHTS_WORDS.noRead);
  });
});
