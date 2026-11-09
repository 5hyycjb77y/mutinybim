/**
 * @jest-environment node
 *
 * Round 11 lane K11: `anchorOf` through the kind rows against round 10's
 * switch (frozen copy, imported by module as model.ts did), interleaved in
 * one process, and the hosted-record placement pass of `recomputeDerived`.
 * Prints `[k11 <row>] p50 … p95 …`; an internal design note
 * records the runs. The ceiling here is coarse (a loaded laptop); the budget
 * is the gate's (`kinds.anchor_of.row` ≤ round 10's switch).
 *
 * K11_PERF=1 runs it; K11_PERF_TIER picks the tier (250k by default; 1M
 * only through the shared stack's heavy lock).
 */
import { anchorOf, freezeElements, recomputeDerived, type ModelState } from "../src";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { round10AnchorOf } from "./reference/round10-anchor-of";

type Tier = keyof typeof FULL_BIM_TIERS;
const isTier = (value: string): value is Tier => value in FULL_BIM_TIERS;
const run = process.env.K11_PERF === "1" ? describe : describe.skip;
const tier = process.env.K11_PERF_TIER ?? "250k";

function p50p95(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return { p50: Math.round(at(0.5) * 100) / 100, p95: Math.round(at(0.95) * 100) / 100 };
}

function report(row: string, samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  const s = p50p95(samples);
  process.stderr.write(`[k11 ${row}] p50 ${s.p50} ms, p95 ${s.p95} ms (n=${samples.length})\n`);
  return s;
}

run(`k11 record registry at ${tier}`, () => {
  if (!isTier(tier)) throw new Error(`K11_PERF_TIER ${tier} isn't a full-BIM tier`);
  const built = createFullBimModel({ ...FULL_BIM_TIERS[tier], modelId: `k11-${tier}` });
  const head: ModelState = { ...built, elements: freezeElements(built.elements) };
  const elements = Object.values(head.elements);
  // Bound once: an imported function is read through a getter on every call when transpiled.
  const rowAnchor = anchorOf;
  const switchAnchor = round10AnchorOf;

  it(`kinds.anchor_of.row.${tier}: anchorOf on every element, against round 10's switch`, () => {
    const row: number[] = [];
    const ab: number[] = [];
    let placedRow = 0;
    let placedAb = 0;
    const passRow = () => {
      const t0 = performance.now();
      placedRow = 0;
      for (const el of elements) if (rowAnchor(el) !== null) placedRow++;
      return performance.now() - t0;
    };
    const passAb = () => {
      const t0 = performance.now();
      placedAb = 0;
      for (const el of elements) if (switchAnchor(el) !== null) placedAb++;
      return performance.now() - t0;
    };
    for (let i = 0; i <= 20; i++) {
      const [a, b] = i % 2 === 0 ? [passRow(), passAb()] : (() => {
        const y = passAb();
        return [passRow(), y];
      })();
      if (i === 0) continue;
      row.push(a);
      ab.push(b);
    }
    expect(placedRow).toBe(placedAb);
    const r = report(`kinds.anchor_of.row.${tier}`, row);
    const s = report(`ab.anchor_of.round10_switch.${tier}`, ab);
    // Coarse: the row read may not cost more than half again the switch on a loaded machine.
    expect(r.p50).toBeLessThan(s.p50 * 1.5);
  });

  it(`derived.full.${tier}: every hosted record placed through its row`, () => {
    const samples: number[] = [];
    for (let i = 0; i <= 5; i++) {
      const t0 = performance.now();
      expect(recomputeDerived(head).changedIds.length).toBe(0);
      if (i > 0) samples.push(performance.now() - t0);
    }
    report(`derived.full.${tier}`, samples);
  });
});
