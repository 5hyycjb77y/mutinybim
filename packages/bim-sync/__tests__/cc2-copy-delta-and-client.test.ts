/**
 * @jest-environment node
 *
 * Contractor copies (round 16), what the Copies screen needs from the model
 * server: `lineage_delta` says which records a copy changed since its anchor
 * and the digest a review or accept back cites, at the copy's head the person
 * looked at; the browser's sync client asks copy questions and gets one
 * answer each, and never asks an older server (it answers itself in words).
 *
 * Fails on the previous code: there was no way for a screen to learn the
 * digest (a review or accept back could only be sent by code that computed it
 * from the model server's own history), and the sync client had no copy
 * requests at all.
 */
import { LINEAGE_OLDER_SERVER_WORDS, LINEAGES_DELTA_FEATURE, LINEAGE_DELTA_WORDS } from "../src/lineages";
import { SyncClient } from "../src";
import { admit, avery, BASE, editTerminal, expectLineage, sam, startCopies } from "./support/w11-copies";

async function shopWithTwoEdits() {
  const env = await startCopies();
  const samOnDesign = await admit(env, sam, BASE);
  const made = expectLineage(await samOnDesign.ask({ type: "lineage_create", name: "Acme ductwork shop drawings", role: "shop", owner: { party: "Acme Mechanical" } }), "lineage_saved");
  const samOnShop = await admit(env, sam, `${BASE}~${made.lineage.id}`);
  expect(await editTerminal(samOnShop, 410)).toEqual({ status: "committed" });
  expect(await editTerminal(samOnShop, 420, "sd-2")).toEqual({ status: "committed" });
  env.copies.grant(BASE, made.lineage.id, avery.id, "review");
  return { env, lineageId: made.lineage.id, samOnShop, averyOnDesign: await admit(env, avery, BASE) };
}

describe("cc2: what a review or accept back cites, and copy questions from the browser", () => {
  it("the copy's changes and digest are what accept back and review take", async () => {
    const { env, lineageId, averyOnDesign } = await shopWithTwoEdits();
    const whole = expectLineage(await averyOnDesign.ask({ type: "lineage_delta", lineageId }), "lineage_delta_result");
    // The two airflows, and the records sized from them.
    expect(whole.changedIds).toEqual(expect.arrayContaining(["sd-1", "sd-2"]));
    expect(whole.anchor.lineageId).toBe("main");
    const some = expectLineage(await averyOnDesign.ask({ type: "lineage_delta", lineageId, recordIds: ["sd-1"], atRevision: whole.headRevision }), "lineage_delta_result");
    expect(some.changedIds).toEqual(["sd-1"]);
    expect(some.deltaDigest).not.toBe(whole.deltaDigest);
    const before = (await env.host.main.store.head()).revision;
    expectLineage(await averyOnDesign.ask({ type: "lineage_accept_back", from: lineageId, recordIds: ["sd-1"], deltaDigest: some.deltaDigest }), "lineage_act_recorded");
    expect((await env.host.main.store.head()).revision).toBe(before + 1);
    const reviewed = expectLineage(await averyOnDesign.ask({ type: "lineage_review", lineageId, outcome: "approved_as_noted", deltaDigest: whole.deltaDigest }), "lineage_act_recorded");
    expect(reviewed.act).toMatchObject({ kind: "review", lineageId, outcome: "approved_as_noted" });
  });

  it("a copy that moved since the person looked, or a record it didn't change, is refused in words", async () => {
    const { lineageId, samOnShop, averyOnDesign } = await shopWithTwoEdits();
    const looked = expectLineage(await averyOnDesign.ask({ type: "lineage_delta", lineageId }), "lineage_delta_result");
    expect(await editTerminal(samOnShop, 430)).toEqual({ status: "committed" });
    expect(expectLineage(await averyOnDesign.ask({ type: "lineage_delta", lineageId, recordIds: ["sd-1"], atRevision: looked.headRevision }), "request_refused").reason).toBe(LINEAGE_DELTA_WORDS.moved);
    expect(expectLineage(await averyOnDesign.ask({ type: "lineage_delta", lineageId, recordIds: ["sd-9"] }), "request_refused").reason).toBe(LINEAGE_DELTA_WORDS.notChanged("sd-9"));
  });

  it("the sync client asks copy questions and gets their answers", async () => {
    const { lineageId, averyOnDesign } = await shopWithTwoEdits();
    const listed = await averyOnDesign.client.lineageRequest({ type: "lineage_list" });
    expect(listed.type).toBe("lineages");
    const delta = await averyOnDesign.client.lineageRequest({ type: "lineage_delta", lineageId });
    expect(delta.type === "lineage_delta_result" ? delta.changedIds : delta).toEqual(expect.arrayContaining(["sd-1", "sd-2"]));
  });

  it("a server that didn't say it serves copy deltas is never asked; the answer says why", async () => {
    const send = jest.fn();
    const client = new SyncClient({ send, close: () => undefined }, avery, {}, 60_000, { clientSessionId: "cc2-old", meter: null, modelId: BASE });
    const answer = await client.lineageRequest({ type: "lineage_delta", lineageId: "shop" });
    expect(answer).toEqual({ type: "request_refused", requestId: "local", reason: LINEAGE_OLDER_SERVER_WORDS[LINEAGES_DELTA_FEATURE] });
    expect(send).not.toHaveBeenCalled();
  });
});
