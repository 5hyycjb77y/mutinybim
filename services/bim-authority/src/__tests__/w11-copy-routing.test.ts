/**
 * @jest-environment node
 *
 * Round 11 W11, model-server routing half: a copy of a copy is served next to
 * its parent copy, and a copy's net change rides in bounded chunks. The
 * host-side half (copy grants read as the person) is the host plug-in's test.
 */
import { parentModelOf } from "../routing";
import { checkpointChunks, CHECKPOINT_CHUNK_RECORDS } from "../lineages/checkpoints";
import type { Sql } from "../pg-store";

describe("w11-copy-editor-cannot-write-main (routing)", () => {
  it("a copy of a copy routes to its parent copy's machine; the net change rides in bounded chunks", async () => {
    const answers: unknown[][] = [[{ ok: true }], [{ parent: "site-7161~shop1" }]];
    const fake = (async () => answers.shift() ?? []) as unknown as Sql;
    expect(await parentModelOf(fake, "site-7161~prop1")).toBe("site-7161~shop1");
    expect(await parentModelOf(fake, "site-7161")).toBeNull();
    const elements = Array.from({ length: CHECKPOINT_CHUNK_RECORDS + 1 }, (_, i) => ({ id: `e${i}` })) as never;
    const chunks = checkpointChunks({ checkpoint: { lineageId: "x", revision: 9, stateDigest: "a".repeat(64) }, forkRevision: 4, elements, removedIds: ["gone"], addedConnections: [], removedConnections: [] });
    expect(chunks.map((c) => c.elements?.length ?? c.removedIds?.length)).toEqual([CHECKPOINT_CHUNK_RECORDS, 1, 1]);
  });
});
