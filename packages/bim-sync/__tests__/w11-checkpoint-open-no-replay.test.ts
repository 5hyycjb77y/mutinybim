/**
 * @jest-environment node
 *
 * Round 11 W11 (D1): a copy that lives for decades opens from its newest
 * checkpoint, never by replaying every changeset since it was made. The
 * checkpoint holds the copy's net change from its fork (not the whole
 * state), is written off the commit path, and reopening from it gives the
 * same state, byte for byte (the kernel's state digest).
 *
 * Fails on round 10's code: a branch was never checkpointed and every open
 * replayed each of its own changesets from the fork.
 */
import { lineageStateDigest } from "@permitzip/bim-kernel/lineages";
import { checkpointMatches, InMemoryLineageCheckpointStore, LineageCheckpointMismatch, openLineageHead } from "../src/lineages";
import { admit, BASE, editTerminal, expectLineage, sam, settle, startCopies } from "./support/w11-copies";

describe("w11-checkpoint-open-no-replay", () => {
  it("reopens from the newest checkpoint and replays only what came after", async () => {
    const checkpoints = new InMemoryLineageCheckpointStore();
    const env = await startCopies({ checkpoints, checkpointEvery: 5 });
    const samOnDesign = await admit(env, sam, BASE);
    const ops = expectLineage(await samOnDesign.ask({ type: "lineage_create", name: "Operations record", role: "operations" }), "lineage_saved").lineage;
    const id = `${BASE}~${ops.id}`;
    const samOnOps = await admit(env, sam, id);
    for (let i = 0; i < 12; i++) expect(await editTerminal(samOnOps, 300 + i, i % 2 === 0 ? "sd-1" : "sd-2")).toEqual({ status: "committed" });
    await settle();
    const before = await (await env.host.open(id))?.store.head();
    if (!before) throw new Error("copy not served");
    const pin = ops.parent?.revision ?? 0;

    const newest = await checkpoints.latest(id, before.revision);
    expect(newest?.checkpoint.revision).toBe(pin + 10);
    // The net change only (the two terminals and what their airflow recomputed), not the whole model.
    const held = newest?.elements.map((e) => e.id) ?? [];
    expect(held).toEqual(expect.arrayContaining(["sd-1", "sd-2"]));
    expect(held.length).toBeLessThan(Object.keys(before.elements).length);

    const reopened = await env.host.reopen(id);
    expect(reopened?.opened).toMatchObject({ fromCheckpoint: pin + 10, replayed: 2 });
    const after = await reopened?.store.head();
    if (!after) throw new Error("copy not reopened");
    expect(after.revision).toBe(before.revision);
    expect(lineageStateDigest(after)).toBe(lineageStateDigest(before));
  });

  it("a checkpoint made for another fork is refused, never guessed at; the digest names the state", async () => {
    const env = await startCopies();
    const head = await env.host.main.store.head();
    const cp = { checkpoint: { lineageId: "x", revision: head.revision + 1, stateDigest: "0".repeat(64) }, forkRevision: head.revision + 7, elements: [], removedIds: [], addedConnections: [], removedConnections: [] };
    expect(() => openLineageHead({ fork: head, checkpoint: cp, own: [] })).toThrow(LineageCheckpointMismatch);
    expect(checkpointMatches({ ...cp, checkpoint: { ...cp.checkpoint, revision: head.revision, stateDigest: lineageStateDigest(head) } }, head)).toBe(true);
  });
});
