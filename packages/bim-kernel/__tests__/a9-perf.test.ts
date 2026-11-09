/**
 * @jest-environment node
 *
 * Round 9 lane A9: what moving airflow into the Mechanical add-on costs on
 * load and on the tree totals. Each case prints `[a9 <row>] p50 … p95 …`;
 * an internal design note records the runs on round 8b's code
 * and on this lane's. The expectations are coarse ceilings so a loaded
 * laptop doesn't fail them; the budgets are the gate's.
 *
 * A9_PERF=1 runs it; A9_PERF_TIER picks the tier (250k by default; 1M needs
 * the memory to spare). Run through the round's lock.
 */
import { freezeElements, recomputeDerived, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { airflowOf, computeAirflow } from "@permitzip/bim-pack-mechanical";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function p50p95(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return { p50: Math.round(at(0.5) * 100) / 100, p95: Math.round(at(0.95) * 100) / 100 };
}

function report(row: string, samples: readonly number[], extra = ""): void {
  const s = p50p95(samples);
  process.stderr.write(`[a9 ${row}] p50 ${s.p50} ms, p95 ${s.p95} ms (n=${samples.length})${extra ? `; ${extra}` : ""}\n`);
}

function time(n: number, fn: () => void): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t0 = performance.now();
    fn();
    if (i > 0) out.push(performance.now() - t0);
  }
  return out;
}

const tierName = process.env.A9_PERF_TIER ?? "250k";
const run = process.env.A9_PERF === "1" ? describe : describe.skip;
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";

run(`a9 airflow in the Mechanical add-on at ${tierName}`, () => {
  if (!isTier(tierName)) throw new Error(`A9_PERF_TIER=${tierName} isn't a full-BIM tier (${Object.keys(FULL_BIM_TIERS).join(", ")})`);
  installFirstPartyAddOns();
  const built = createFullBimModel({ ...FULL_BIM_TIERS[tierName], modelId: `a9-${tierName}` });
  const head: ModelState = { ...built, elements: freezeElements(built.elements) };
  const rows: string[] = Object.values(head.elements).map((el) => JSON.stringify(el));

  it(`authority.load.parse.${tierName}: every stored row parsed the way the model server's paged boot reads it`, () => {
    const s = time(3, () => {
      const out: Record<string, BimElement> = {};
      for (const line of rows) {
        const el = JSON.parse(line) as BimElement;
        out[el.id] = el;
      }
      expect(Object.keys(out).length).toBe(rows.length);
    });
    report(`authority.load.parse.${tierName}`, s, `${rows.length} rows`);
    if (ABSOLUTE_BUDGETS) expect(p50p95(s).p50).toBeLessThan(30_000);
  });

  it(`kinds.lift.stored.${tierName}: every stored airflow read through the add-on's reader`, () => {
    const elements = Object.values(head.elements);
    let seen = 0;
    const s = time(5, () => {
      seen = 0;
      for (const el of elements) if (airflowOf(el) !== null) seen += 1;
    });
    report(`kinds.lift.stored.${tierName}`, s, `${seen} values read`);
    expect(seen).toBeGreaterThan(0);
    if (ABSOLUTE_BUDGETS) expect(p50p95(s).p50).toBeLessThan(5_000);
  });

  it(`network.tree.totals.${tierName}: airflow over every tree, and the full derived recompute`, () => {
    const totals = time(5, () => {
      expect(computeAirflow(head).size).toBeGreaterThan(0);
    });
    report(`network.tree.totals.${tierName}`, totals);
    const full = time(3, () => {
      expect(recomputeDerived(head).changedIds.length).toBe(0);
    });
    report(`derived.full.${tierName}`, full);
    if (ABSOLUTE_BUDGETS) expect(p50p95(full).p50).toBeLessThan(30_000);
  });
});
