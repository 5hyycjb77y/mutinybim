/**
 * @jest-environment node
 *
 * Round 10: the model server's first save on a loaded head answers without
 * recording which add-on contributions each check reads; the sequencer builds
 * that point index right after, while the queue is idle, on whatever the head
 * is by then.
 *
 * Fails on round 9's host: nothing built an index after a save (the first
 * save itself recorded it); with the save no longer recording, a switch would
 * re-check the whole model from then on.
 */
import { issuesOf, pointReadsPending, type Actor, type Command, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { InMemoryCommitStore, Sequencer } from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };
let keys = 0;

async function submit(sequencer: Sequencer, head: ModelState, command: Command): Promise<void> {
  keys += 1;
  const outcome = await sequencer.submit({ idempotencyKey: `k10-seq-${keys}`, baseRevision: head.revision, actor: avery, command });
  if (outcome.status !== "committed") throw new Error(`not committed: ${JSON.stringify(outcome)}`);
}

async function settle(sequencer: Sequencer): Promise<ModelState> {
  for (let i = 0; i < 200; i++) {
    const head = await sequencer.head();
    if (!pointReadsPending(head)) return head;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the point index was never built after the save");
}

describe("k10-point-reads-after-save", () => {
  it("the sequencer builds the head's point index after the first save, also when edits follow it", async () => {
    const loaded = createDemoModel();
    const store = new InMemoryCommitStore({ ...loaded, elements: { ...loaded.elements } });
    const sequencer = await Sequencer.start(store);
    let head = await sequencer.head();
    await submit(sequencer, head, { type: "create_level", levelId: "lvl-k10-a", name: "A", elevationMm: 30_000 });
    head = await sequencer.head();
    // The save was answered with its index still to build.
    expect(pointReadsPending(head)).toBe(true);
    await submit(sequencer, head, { type: "create_level", levelId: "lvl-k10-b", name: "B", elevationMm: 33_000 });
    head = await settle(sequencer);
    expect(head.revision).toBe(loaded.revision + 2);
    expect(issuesOf(head)).toEqual(issuesOf({ ...head, elements: { ...head.elements } }));
  });
});
