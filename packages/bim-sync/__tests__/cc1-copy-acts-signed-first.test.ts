/**
 * @jest-environment node
 *
 * Contractor copies (round 16): a copy's accept back is signed before anything
 * lands. When the host refuses to sign it (the host checks who may accept
 * back on its side too), the design is untouched; a review or accept back
 * recorded again is the same record; the host is told which connection asked,
 * so it can sign as that person.
 *
 * Fails on the previous code: the records landed on the design first and the
 * act was signed afterwards, so a refused signature left records on the
 * design with no signed act; the recorder never learned who asked.
 */
import type { ElementId } from "@permitzip/bim-kernel";
import { lineageDeltaDigest, LineageError } from "@permitzip/bim-kernel/lineages";
import { InMemoryLineageActs } from "../src";
import type { LineageActRecorder, LineageCaller } from "../src/lineages";
import { admit, avery, BASE, editTerminal, expectLineage, sam, startCopies } from "./support/w11-copies";

/** Sam's shop copy with one edit, and Avery (who edits the design) named to review it. */
async function shopWithAnEdit(acts?: LineageActRecorder) {
  const env = await startCopies(acts ? { acts } : {});
  const samOnDesign = await admit(env, sam, BASE);
  const made = expectLineage(await samOnDesign.ask({ type: "lineage_create", name: "Acme ductwork shop drawings", role: "shop", owner: { party: "Acme Mechanical" } }), "lineage_saved");
  const shopId = `${BASE}~${made.lineage.id}`;
  const samOnShop = await admit(env, sam, shopId);
  expect(await editTerminal(samOnShop, 410)).toEqual({ status: "committed" });
  env.copies.grant(BASE, made.lineage.id, avery.id, "review");
  const served = await env.host.open(shopId);
  if (!served || !made.lineage.parent) throw new Error("the shop copy isn't served");
  const head = await served.store.head();
  const digest = lineageDeltaDigest(["sd-1"], made.lineage.parent.revision, (id: ElementId) => head.elements[id] ?? null);
  return { env, lineageId: made.lineage.id, digest, averyOnDesign: await admit(env, avery, BASE) };
}

describe("cc1: a copy's acts are signed first, once, as the person who asked", () => {
  it("a refused signature lands nothing on the design", async () => {
    const refusing: LineageActRecorder = {
      record: async () => {
        throw new LineageError("You can't land records on that copy. Accepting back needs Edit on it, or edit access to the project's model.");
      },
      list: async () => [],
    };
    const { env, lineageId, digest, averyOnDesign } = await shopWithAnEdit(refusing);
    const before = (await env.host.main.store.head()).revision;
    const back = await averyOnDesign.ask({ type: "lineage_accept_back", from: lineageId, recordIds: ["sd-1"], deltaDigest: digest });
    expect(expectLineage(back, "request_refused").reason).toMatch(/^You can't land records on that copy/);
    expect((await env.host.main.store.head()).revision).toBe(before);
  });

  it("an accept back is signed as the connection that asked, then lands once", async () => {
    const callers: (LineageCaller | undefined)[] = [];
    const inner = new InMemoryLineageActs();
    const acts: LineageActRecorder = {
      record: (input) => {
        callers.push(input.caller);
        return inner.record(input);
      },
      list: () => inner.list(),
    };
    const { env, lineageId, digest, averyOnDesign } = await shopWithAnEdit(acts);
    const before = (await env.host.main.store.head()).revision;
    const back = expectLineage(await averyOnDesign.ask({ type: "lineage_accept_back", from: lineageId, recordIds: ["sd-1"], deltaDigest: digest }), "lineage_act_recorded");
    expect(back.act).toMatchObject({ kind: "accept_back", from: lineageId, recordIds: ["sd-1"] });
    expect((await env.host.main.store.head()).revision).toBe(before + 1);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatchObject({ actorId: avery.id, connectionId: expect.stringMatching(/^conn-/) });
    expect(inner.recorded).toHaveLength(1);
  });

  it("the same act recorded again is the record already written", async () => {
    const acts = new InMemoryLineageActs();
    const input = { baseModelId: BASE, act: { kind: "review" as const, lineageId: "shop", to: "main", deltaDigest: "a".repeat(64), outcome: "approved" }, anchor: { lineageId: "main", revision: 4 }, by: { provider: "host-app", subject: avery.id, kind: "person" as const } };
    const first = await acts.record(input);
    expect(await acts.record(input)).toEqual(first);
    expect(await acts.record({ ...input, act: { ...input.act, outcome: "rejected" } })).not.toEqual(first);
    expect(acts.recorded).toHaveLength(2);
  });
});
