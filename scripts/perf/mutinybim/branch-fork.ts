/**
 * branch.* in process (round 8b lane B): fork and history reads at 250k and 1M
 * elements, no network, no Postgres.
 *
 *   node --import tsx scripts/perf/mutinybim/branch-fork.ts [--elements=250000] [--samples=7]
 *
 * Builds a model of N elements on the chunked element store, commits 2,000
 * changesets after a version (each rewriting one element, `before` recorded),
 * then measures:
 *
 *   branch.fork                from the head (structural share) and from the version (revert 2,000 changesets)
 *   branch.state_at.2k_ids     2,000 ids at the version, from the head and the changesets after it
 *   authority.memory.branch    heap the fork adds beside its base, as a share of the base (structure only)
 *
 * Counts prove the fork touched 2,000 elements, not N.
 */
import { asElementId, asRevision, forkState, freezeElements, stateAt, type BimElement, type Changeset, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { emit, gc, memoryMB } from "./lib";

const args = process.argv.slice(2);
const elementsN = Number(args.find((a) => a.startsWith("--elements="))?.split("=")[1] ?? 250_000);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 7);
const CHANGES = 2000;

function time<T>(fn: () => T): { ms: number; value: T } {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
}

const demo = createDemoModel("perf-branch");
const template = demo.elements["sd-1"];
if (!template) throw new Error("demo model has no sd-1");
const record: Record<string, BimElement> = {};
for (let i = 0; i < elementsN; i++) {
  const id = asElementId(`e${i}`);
  record[id] = { ...template, id, version: 1 };
}
const version: ModelState = { ...demo, revision: asRevision(0), elements: freezeElements(record) };

// 2,000 changesets after the version, each rewriting one element.
const changesets: Changeset[] = [];
const draft: Record<string, BimElement> = { ...record };
for (let r = 1; r <= CHANGES; r++) {
  const id = asElementId(`e${(r * 7919) % elementsN}`);
  const before = draft[id];
  if (!before) throw new Error(`missing ${id}`);
  const after = { ...before, version: before.version + 1 };
  draft[id] = after;
  changesets.push({ revision: asRevision(r), baseRevision: r - 1, idempotencyKey: `perf-${r}`, actor: { id: "perf", name: "Perf", kind: "human" }, command: { type: "set_tag_text", tagId: "perf", text: "perf" }, elements: [after], readSet: {}, authored: [], intents: [], rebased: false, committedAt: new Date(0).toISOString(), before: { [id]: before } });
}
const head: ModelState = { ...version, revision: asRevision(CHANGES), elements: freezeElements(draft) };
const ids = Array.from({ length: 2000 }, (_, i) => asElementId(`e${(i * 104729) % elementsN}`));

const forkHead: number[] = [];
const forkVersion: number[] = [];
const reads: number[] = [];
let touched = 0;
for (let s = 0; s < samples; s++) {
  forkHead.push(time(() => forkState(head, head.revision, changesets)).ms);
  const forked = time(() => forkState(head, 0, changesets));
  forkVersion.push(forked.ms);
  touched = Object.keys(forked.value.elements).filter((id) => forked.value.elements[id] !== head.elements[id]).length; // full-scan-ok: a count for the report, outside the timed call
  reads.push(time(() => stateAt(head, 0, changesets, ids)).ms);
}

gc();
const baseHeap = memoryMB().heap;
const kept: ModelState[] = [forkState(head, 0, changesets)];
gc();
const branchHeap = memoryMB().heap - baseHeap;

emit({
  suite: "batch",
  workload: { elements: elementsN, changesetsAfterVersion: CHANGES, samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: { touched, keptForks: kept.length, baseHeapMB: baseHeap, branchHeapMB: branchHeap },
  samples: [
    { metric: "branch.fork", variant: "head", values: forkHead, note: "Fork at the head: the head itself." },
    { metric: "branch.fork", variant: "version", values: forkVersion, counts: { affectedElements: touched }, note: `Fork ${CHANGES} changesets back: revert them on the chunked store.` },
    { metric: "branch.state_at.2k_ids", values: reads, note: "2,000 ids at the version from the head and the changesets after it." },
    { metric: "authority.memory.branch", values: [baseHeap > 0 ? (branchHeap / baseHeap) * 100 : 0], note: "Heap one forked branch adds beside its base, percent of the process heap with the base (structure only)." },
  ],
});
