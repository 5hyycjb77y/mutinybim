/**
 * @jest-environment node
 *
 * Round 11 lane L11: the lineage reads stay incremental. L11_PERF=1 runs it
 * (the full rows at 250k and 1M are scripts/perf/mutinybim/lineages.ts).
 * Ceilings are coarse so a loaded laptop doesn't fail them; the budgets are
 * the gate's.
 *
 * - lineage.compare touches only the changed ids: a copy that rewrote 2,000
 *   of 100,000 records lists 2,000 differences, well under 1 s
 * - lineage.chain.depth_5.open within 10 % (plus 2 ms of noise) of depth 1
 */
import { asElementId, asRevision, applyChangeset, freezeElements, replayTo, type BimElement, type Changeset, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { compareLineages } from "../src/lineages/compare";
import { forkLineage, lineageChain, lineageLookup, lineageSegments } from "../src/lineages/chain";
import type { Lineage } from "../src/lineages/types";
import { AVERY } from "./l11-fixtures";

const run = process.env.L11_PERF === "1" ? describe : describe.skip;
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";

function p50(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

const N = 100_000;
const CHANGES = 2000;

function model(): ModelState {
  const records: Record<string, BimElement> = {};
  for (let i = 0; i < N; i++) records[`e${i}`] = { id: asElementId(`e${i}`), version: 1, authoredRev: {}, kind: "level", name: `L${i}`, elevationMm: i } as BimElement;
  return { ...createDemoModel("l11-perf"), revision: asRevision(0), elements: freezeElements(records), connections: [] };
}

function line(start: ModelState, ids: (r: number) => string, count: number): { head: ModelState; changes: Changeset[] } {
  let head = start;
  const changes: Changeset[] = [];
  for (let r = 1; r <= count; r++) {
    const id = ids(r);
    const prior = head.elements[id];
    if (!prior) throw new Error(`missing ${id}`);
    const cs = { revision: asRevision(head.revision + 1), baseRevision: head.revision, idempotencyKey: `p${r}`, actor: { id: "p", name: "P", kind: "human" }, command: { type: "set_tag_text", tagId: "p", text: "p" }, elements: [{ ...prior, version: prior.version + 1, name: `x${r}` } as BimElement], readSet: {}, authored: [], intents: [], rebased: false, committedAt: "2026-11-02T00:00:00Z", before: { [id]: prior } } as Changeset;
    head = applyChangeset(head, cs);
    changes.push(cs);
  }
  return { head, changes };
}

run("l11-perf", () => {
  const base = model();
  const root: Lineage = { id: "design", parent: null, role: "design_record", returnPolicy: "never", state: "open", name: "Design", createdBy: AVERY, createdAt: "2026-11-02T00:00:00Z" };

  it("lineage.compare touches only the changed ids", () => {
    const shop = forkLineage({ id: "shop", parent: root, revision: 0, parentHead: 0, role: "shop", name: "Shop", createdBy: AVERY, createdAt: "2026-11-02T00:00:00Z" });
    const copy = line(base, (r) => `e${(r * 7919) % N}`, CHANGES);
    const times: number[] = [];
    let count = 0;
    for (let s = 0; s < 7; s++) {
      const t = performance.now();
      count = compareLineages(lineageLookup([root, shop]), { lineageId: "design", head: base, changes: [] }, { lineageId: "shop", head: copy.head, changes: copy.changes }).differences.length;
      times.push(performance.now() - t);
    }
    console.log(`[l11 lineage.compare 2k of 100k] p50 ${p50(times).toFixed(2)} ms`);
    expect(count).toBe(new Set(copy.changes.map((c) => c.elements[0]?.id)).size);
    if (ABSOLUTE_BUDGETS) expect(p50(times)).toBeLessThan(1000);
  });

  it("lineage.chain.depth_5.open is within 10 % of depth 1", () => {
    const design = line(base, (r) => `e${(r * 104729) % N}`, CHANGES);
    const openAt = (depth: number) => {
      const lineages: Lineage[] = [root];
      let parent = root;
      for (let d = 1; d <= depth; d++) {
        const next = forkLineage({ id: `d${d}`, parent, revision: d === 1 ? 0 : ((d - 1) * CHANGES) / depth, parentHead: CHANGES, role: "proposal", name: `d${d}`, createdBy: AVERY, createdAt: "2026-11-02T00:00:00Z" });
        lineages.push(next);
        parent = next;
      }
      const look = lineageLookup(lineages);
      const leaf = parent.id;
      return () => {
        const segs = lineageSegments(lineageChain(look, leaf), 0, CHANGES);
        const changes = segs.flatMap((s) => design.changes.filter((c) => c.revision > s.from && c.revision <= s.to));
        return replayTo(base, CHANGES, changes, applyChangeset);
      };
    };
    const one = openAt(1);
    const five = openAt(5);
    const t1: number[] = [];
    const t5: number[] = [];
    for (let s = 0; s < 9; s++) {
      let t = performance.now();
      one();
      t1.push(performance.now() - t);
      t = performance.now();
      five();
      t5.push(performance.now() - t);
    }
    console.log(`[l11 lineage.chain.open] depth 1 p50 ${p50(t1).toFixed(2)} ms, depth 5 p50 ${p50(t5).toFixed(2)} ms`);
    expect(five().elements).toEqual(one().elements);
    expect(p50(t5)).toBeLessThan(p50(t1) * 1.1 + 2);
  });
});
