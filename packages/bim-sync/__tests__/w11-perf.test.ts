/**
 * @jest-environment node
 *
 * Round 11 W11 perf flag (W11_PERF=1): a copy that rewrote 10 % of a 100k-record
 * design opens from its checkpoint with nothing replayed, to the same state
 * (digest), faster than replaying its own changesets from the fork; and the
 * open copy shares its unchanged records with the design (copy on write).
 * The 250k / 1M numbers come from scripts/perf/mutinybim/lineage-memory.ts.
 *
 * Fails on round 10's code: there was no checkpoint, so every open replayed.
 */
import { applyChangeset, asBranchState, asElementId, asRevision, forkState, freezeElements, type BimElement, type Changeset, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { lineageStateDigest } from "@permitzip/bim-kernel/lineages";
import { lineageCheckpointBody, openLineageHead } from "../src/lineages";

const RUN = process.env.W11_PERF === "1";
const N = 100_000;

(RUN ? describe : describe.skip)("w11-perf", () => {
  it("opens a 10 % copy from its checkpoint with no replay, same state, faster than replay, sharing the rest", () => {
    const demo = createDemoModel("w11-perf");
    const template = demo.elements["sd-1"];
    if (!template) throw new Error("demo model has no sd-1");
    const record: Record<string, BimElement> = {};
    for (let i = 0; i < N; i++) record[asElementId(`e${i}`)] = { ...template, id: asElementId(`e${i}`), version: 1 };
    const base: ModelState = { ...demo, revision: asRevision(0), elements: freezeElements(record) };
    const own: Changeset[] = [];
    for (let r = 1; r <= N / 10 / 100; r++) {
      const elements: BimElement[] = [];
      for (let k = 0; k < 100; k++) {
        const id = asElementId(`e${(((r - 1) * 100 + k) * 7919) % N}`);
        const before = record[id];
        if (before) elements.push({ ...before, version: 2 });
      }
      own.push({ revision: asRevision(r), baseRevision: r - 1, idempotencyKey: `w11-${r}`, actor: { id: "perf", name: "Perf", kind: "human" }, command: { type: "set_tag_text", tagId: "perf", text: "perf" }, elements, readSet: {}, authored: [], intents: [], rebased: false, committedAt: new Date(0).toISOString() });
    }
    const fork = asBranchState(forkState(base, 0, []), "w11-perf~copy");
    const replay = () => own.reduce((m, cs) => applyChangeset(m, cs), fork);
    const replayed = replay();
    const cp = lineageCheckpointBody("copy", 0, replayed, own);
    const time = (fn: () => unknown) => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;
    const replayMs = median(Array.from({ length: 5 }, () => time(replay)));
    const openMs = median(Array.from({ length: 5 }, () => time(() => openLineageHead({ fork, checkpoint: cp, own }))));
    const opened = openLineageHead({ fork, checkpoint: cp, own });
    expect(opened.replayed).toBe(0);
    expect(lineageStateDigest(opened.model)).toBe(lineageStateDigest(replayed));
    expect(openMs).toBeLessThan(replayMs);
    // Copy on write: an unchanged record is the design's own object.
    const unchanged = Object.keys(record).find((id) => !cp.elements.some((e) => e.id === id)) ?? "";
    expect(opened.model.elements[unchanged]).toBe(base.elements[unchanged]);
  });
});
