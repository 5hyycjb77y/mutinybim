/**
 * lineage.* opens and memory in process (round 11 lane W11): a long-lived copy
 * opened by replaying its own changesets from the fork (round 10's path, and
 * still the path without a checkpoint) against opening it from its newest
 * checkpoint (the fork pin, one net-change step, nothing after it), and the
 * heap one diverged copy adds beside its base. No network, no Postgres.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/lineage-memory.ts [--elements=250000] [--samples=7] [--diverged=10]
 *
 * Builds a model of N elements on the chunked element store, then a copy that
 * rewrote `diverged` % of them in changesets of 100 records each (at 1M and
 * 10 %: 100,000 records in 1,000 changesets), and measures:
 *
 *   lineage.open.replay        forkState at the pin + every own changeset applied in order
 *   lineage.open.checkpoint    forkState at the pin + the checkpoint's net change in one step (`openLineageHead`)
 *   lineage.checkpoint.write   the checkpoint body: net change + the kernel's whole-state digest (off the commit path)
 *   authority.memory.lineage   heap the open copy adds beside its base (structure only; synthetic records)
 *
 * Counts prove the checkpoint open replayed 0 changesets and its state digest
 * equals the replayed one.
 */
import { applyChangeset, asElementId, asRevision, asBranchState, forkState, freezeElements, type BimElement, type Changeset, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { lineageStateDigest } from "@permitzip/bim-kernel/lineages";
import { lineageCheckpointBody, openLineageHead } from "@permitzip/bim-sync/lineages";
import { emit, gc, memoryMB } from "./lib";

const args = process.argv.slice(2);
const arg = (name: string, fallback: number): number => Number(args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const elementsN = arg("elements", 250_000);
const samples = arg("samples", 7);
const divergedPct = arg("diverged", 10);
const PER_CHANGESET = 100;

function time<T>(fn: () => T): { ms: number; value: T } {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
}

const demo = createDemoModel("perf-lineage");
const template = demo.elements["sd-1"];
if (!template) throw new Error("demo model has no sd-1");
const record: Record<string, BimElement> = {};
for (let i = 0; i < elementsN; i++) {
  const id = asElementId(`e${i}`);
  record[id] = { ...template, id, version: 1 };
}
const base: ModelState = { ...demo, revision: asRevision(0), elements: freezeElements(record) };
const copyId = "perf-lineage~copy";
const fork = asBranchState(forkState(base, 0, []), copyId);

// The copy's own changesets: `diverged` % of the records rewritten, 100 per changeset.
const rewrite = Math.floor((elementsN * divergedPct) / 100);
const own: Changeset[] = [];
for (let start = 0, r = 1; start < rewrite; start += PER_CHANGESET, r++) {
  const elements: BimElement[] = [];
  for (let i = start; i < Math.min(start + PER_CHANGESET, rewrite); i++) {
    const id = asElementId(`e${(i * 7919) % elementsN}`);
    const before = record[id];
    if (before) elements.push({ ...before, version: before.version + 1 });
  }
  own.push({ revision: asRevision(r), baseRevision: r - 1, idempotencyKey: `perf-${r}`, actor: { id: "perf", name: "Perf", kind: "human" }, command: { type: "set_tag_text", tagId: "perf", text: "perf" }, elements, readSet: {}, authored: [], intents: [], rebased: false, committedAt: new Date(0).toISOString() });
}

function replayOpen(): ModelState {
  let model = asBranchState(forkState(base, 0, []), copyId);
  for (const cs of own) model = applyChangeset(model, cs);
  return model;
}

// Memory first, before anything else holds the copy's records: the base alone, then the base with
// one open copy whose checkpoint arrived as fresh objects (as a database read gives them).
gc();
const baseHeap = memoryMB().heap;
const kept: ModelState[] = [];
{
  const body = structuredClone(lineageCheckpointBody("copy", 0, replayOpen(), own));
  kept.push(openLineageHead({ fork: asBranchState(forkState(base, 0, []), copyId), checkpoint: body, own: [] }).model);
}
gc();
const after = memoryMB();
const copyHeap = after.heap - baseHeap;

const replayed = replayOpen();
const write = time(() => lineageCheckpointBody("copy", 0, replayed, own));
const checkpoint = write.value;

const replayMs: number[] = [];
const checkpointMs: number[] = [];
const writeMs: number[] = [write.ms];
let replayedCount = -1;
let fromCheckpoint: ModelState = replayed;
for (let s = 0; s < samples; s++) {
  replayMs.push(time(() => replayOpen()).ms);
  const opened = time(() => openLineageHead({ fork, checkpoint, own }));
  checkpointMs.push(opened.ms);
  replayedCount = opened.value.replayed;
  fromCheckpoint = opened.value.model;
}
for (let s = 1; s < Math.min(samples, 3); s++) writeMs.push(time(() => lineageCheckpointBody("copy", 0, replayed, own)).ms);
const sameState = lineageStateDigest(fromCheckpoint) === lineageStateDigest(replayed) ? 1 : 0;


emit({
  suite: "batch",
  workload: { elements: elementsN, divergedPct, rewritten: rewrite, ownChangesets: own.length, samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: { keptCopies: kept.length, baseHeapMB: baseHeap, copyHeapMB: copyHeap, totalHeapMB: after.heap, rssMB: after.rss, checkpointRecords: checkpoint.elements.length },
  invariants: { replayedFromCheckpoint: replayedCount, sameStateDigest: sameState },
  samples: [
    { metric: "lineage.open.replay", variant: `diverged_${divergedPct}`, values: replayMs, counts: { affectedElements: rewrite }, note: `Round 10's path: fork pin + ${own.length} own changesets applied in order.` },
    { metric: "lineage.open.checkpoint", variant: `diverged_${divergedPct}`, values: checkpointMs, counts: { affectedElements: checkpoint.elements.length }, note: "Fork pin + the checkpoint's net change in one step, nothing replayed." },
    { metric: "lineage.checkpoint.write", variant: `diverged_${divergedPct}`, values: writeMs, note: "Net change + the kernel's whole-state digest (off the commit path)." },
    { metric: "authority.memory.lineage", variant: `diverged_${divergedPct}`, values: [copyHeap], note: "Heap the open copy adds beside its base, MB (synthetic records, structure only)." },
  ],
});
