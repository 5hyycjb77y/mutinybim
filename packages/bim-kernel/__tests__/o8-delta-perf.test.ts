/**
 * @jest-environment node
 *
 * Round 8b lane O perf row `qto.delta.revision_pair` (in-process): the
 * quantity change between two revisions of the all-discipline building, read
 * the way the model server and the browser read it (the ids changed in the
 * range, then those elements and what they name at both ends through
 * `stateAt`), then measured. 200 revisions of 10 rewritten elements each
 * (2,000 changed ids) behind the head, the range ending 50 revisions before
 * it (so the later changes are read too). Budget: 100 / 200 ms at 250k,
 * 200 / 400 ms at 1M.
 *
 * O8_PERF=1 runs it; O8_PERF_SCALE=250k or 1M picks the building (default XS).
 */
import { asElementId, asRevision, changedBetween, hostedIds, quantityDeltaFromReads, readForQuantityDelta, stateAt, type BimElement, type Changeset, type ModelState } from "../src";

import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";

const RUN = process.env.O8_PERF === "1";
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";
const SCALE = process.env.O8_PERF_SCALE;
const describePerf = RUN ? describe : describe.skip;
const BUDGET = SCALE === "1M" ? { p50: 200, p95: 400 } : { p50: 100, p95: 200 };

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withHistory(base: ModelState, revisions: number, perRevision: number): { head: ModelState; changesets: Changeset[] } {
  const next = rng(81);
  const ids = Object.keys(base.elements);
  const elements: Record<string, BimElement> = { ...base.elements };
  const changesets: Changeset[] = [];
  let revision: number = base.revision;
  for (let r = 0; r < revisions; r++) {
    revision += 1;
    const written: BimElement[] = [];
    const before: Record<string, BimElement | null> = {};
    for (let i = 0; i < perRevision; i++) {
      const id = ids[Math.floor(next() * ids.length)] ?? "";
      const el = elements[id];
      if (!el || before[id] !== undefined) continue;
      before[id] = el;
      const changed = { ...el, version: el.version + 1 } as BimElement;
      elements[id] = changed;
      written.push(changed);
    }
    changesets.push({ revision: asRevision(revision), baseRevision: revision - 1, idempotencyKey: `o8p-${r}`, actor: { id: "o8", name: "O8", kind: "human" }, command: { type: "set_tag_text", tagId: "o8", text: "o8" }, elements: written, readSet: {}, authored: [], intents: [], rebased: false, committedAt: new Date(0).toISOString(), before });
  }
  return { head: { ...base, revision: asRevision(revision), elements }, changesets };
}

function pct(list: readonly number[], p: number): number {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}

describePerf("o8-delta-perf (qto.delta.revision_pair)", () => {
  it(`stays within ${BUDGET.p50} / ${BUDGET.p95} ms at ${SCALE ?? "XS"}`, async () => {
    const tier = SCALE === "1M" ? FULL_BIM_TIERS["1M"] : SCALE === "250k" ? FULL_BIM_TIERS["250k"] : FULL_BIM_TIERS.XS;
    const base = createFullBimModel(tier);
    const { head, changesets } = withHistory(base, 250, 10);
    const from = base.revision;
    const to = head.revision - 50;
    const times: number[] = [];
    let changed = 0;
    for (let run = 0; run < 12; run++) {
      const t0 = performance.now();
      const ids = changedBetween(changesets, from, to);
      const later = changedBetween(changesets, to, head.revision);
      const reads = await readForQuantityDelta(ids, async (end, want) => stateAt(head, end === "from" ? from : to, changesets, want.map(asElementId)), { hostedNow: (h) => hostedIds(head.elements, h), laterChanged: later });
      quantityDeltaFromReads(reads, ids, { all: true });
      times.push(performance.now() - t0);
      changed = ids.length;
    }
    const warm = times.slice(2);
    const p50 = pct(warm, 0.5);
    const p95 = pct(warm, 0.95);
    process.stderr.write(`[o8-delta-perf] ${SCALE ?? "XS"} elements=${Object.keys(head.elements).length} changed=${changed} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms\n`);
    if (ABSOLUTE_BUDGETS) {
      expect(p50).toBeLessThanOrEqual(BUDGET.p50);
      expect(p95).toBeLessThanOrEqual(BUDGET.p95);
    }
  }, 600_000);
});
