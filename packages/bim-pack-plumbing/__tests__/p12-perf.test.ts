/**
 * @jest-environment node
 *
 * Round 12 lane P12 performance row `fittings.family.resolve`: resolving a
 * stored pipe fitting's family and parameters through the fitting family
 * point costs at most the round 11 static read + 5 %. Workload: every stored
 * pipe fitting of round 9's every-product model (300+ fittings, every family
 * in every material it is made in), resolved 200 times per sample. The
 * baseline is round 11's path (one static map read, then the parameters);
 * the row is today's `resolveFitting`, which reads the add-on's rows.
 * Installs only Plumbing and gas (@mutinybim-bare-kernel).
 *
 * P12_PERF=1 runs it (light: no 250k model). Fails on round 11's code: there
 * is no point to read through, so the row doesn't exist.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fittingFamilies, resolveFitting, resolveParams, type FittingFamily, type ModelState, type RunFitting } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK } from "../src";

const RUN = process.env.P12_PERF === "1";
const STORED = path.join(__dirname, "..", "..", "bim-kernel", "__tests__", "fixtures", "stored-changesets", "pipe-every-product.json");

function p50(samples: readonly number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function sample(n: number, fn: () => void): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t0 = performance.now();
    fn();
    if (i > 0) out.push(performance.now() - t0);
  }
  return out;
}

(RUN ? describe : describe.skip)("p12-perf", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("fittings.family.resolve ≤ round 11's static read + 5 %", () => {
    const head = (JSON.parse(readFileSync(STORED, "utf8")) as { readonly head: ModelState }).head;
    const fittings = Object.values(head.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.domain === "pipe" && typeof e.family === "string");
    expect(fittings.length).toBeGreaterThan(300);
    const staticById: ReadonlyMap<string, FittingFamily> = new Map(fittingFamilies().map((f) => [f.id, f]));
    const baseline = (): void => {
      for (let r = 0; r < 200; r++) for (const f of fittings) {
        const fam = f.family ? staticById.get(f.family) : undefined;
        if (fam) resolveParams(fam, f.params);
      }
    };
    const now = (): void => {
      for (let r = 0; r < 200; r++) for (const f of fittings) resolveFitting(null, f);
    };
    // Interleaved, so a busy laptop slows both workloads alike.
    const as: number[] = [];
    const bs: number[] = [];
    for (let i = 0; i < 16; i++) {
      as.push(...sample(1, baseline));
      bs.push(...sample(1, now));
    }
    const a = p50(as.slice(1));
    const b = p50(bs.slice(1));
    process.stdout.write(`[p12-perf] fittings.family.resolve static ${a.toFixed(2)} ms, point ${b.toFixed(2)} ms (${((b / a - 1) * 100).toFixed(1)} %) for ${fittings.length * 200} resolves\n`);
    expect(b).toBeLessThanOrEqual(a * 1.05);
  });
});
