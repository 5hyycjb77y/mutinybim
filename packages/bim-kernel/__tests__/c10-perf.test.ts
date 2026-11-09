/**
 * @jest-environment node
 *
 * Round 10 lane C10: pinning at sign time and the code-change carry stay
 * cheap. C10_PERF=1 runs it (the full rows, with the tier's model, are
 * scripts/perf/mutinybim/checking-context.ts). Ceilings are coarse so a
 * loaded laptop doesn't fail them; the budgets are the gate's.
 *
 * - signoff.pin.context ≤ 5 ms (20 relied rules)
 * - validity.code_change.carry: 10,000 sign-offs, one instrument changes;
 *   only the records filed under it are re-checked
 */
import { CheckingContextIndex, buildCheckingContext, codeChangeCarry, writeCheckingContext, type PinnedRecord, type RuleRecord } from "@permitzip/bim-kernel";
import { IBC_2021, IBC_2024, IECC_2021, VA, rule } from "./fixtures/c10-rules";

const run = process.env.C10_PERF === "1" ? describe : describe.skip;
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";

function p50(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

run("c10-perf", () => {
  const ibc: RuleRecord[] = Array.from({ length: 100 }, (_, i) => rule({ ruleId: `ibc21-${i}`, section: `${100 + i}.1` }));
  const iecc: RuleRecord[] = Array.from({ length: 100 }, (_, i) => rule({ ruleId: `iecc21-${i}`, instrument: "IECC", section: `C${100 + i}` }));

  it("signoff.pin.context ≤ 5 ms", () => {
    const times: number[] = [];
    for (let s = 0; s < 21; s++) {
      const t = performance.now();
      JSON.stringify(writeCheckingContext(buildCheckingContext({ jurisdiction: VA, codesOfRecord: [IBC_2021, IECC_2021], rules: ibc.slice(0, 20) })));
      times.push(performance.now() - t);
    }
    console.log(`[c10 signoff.pin.context] p50 ${p50(times).toFixed(3)} ms`);
    if (ABSOLUTE_BUDGETS) expect(p50(times)).toBeLessThan(5);
  });

  it("validity.code_change.carry re-checks only the reliant records", () => {
    const records: PinnedRecord[] = Array.from({ length: 10_000 }, (_, i) => {
      const own = i % 2 === 0 ? ibc : iecc;
      return { id: `r${i}`, signer: `u${i % 40}`, context: buildCheckingContext({ jurisdiction: VA, codesOfRecord: [IBC_2021, IECC_2021], rules: [0, 1, 2, 3, 4].map((k) => own[(i + k * 17) % own.length] as RuleRecord) }) };
    });
    const index = new CheckingContextIndex(records);
    const current = { codesOfRecord: [IBC_2024, IECC_2021], rules: [...Array.from({ length: 100 }, (_, i) => rule({ ruleId: `ibc24-${i}`, edition: "2024", section: `${100 + i}.1`, ...(i < 60 ? { carriedForward: [{ fromEdition: "2021" }] } : {}) })), ...iecc] };
    const times: number[] = [];
    let rechecked = 0;
    for (let s = 0; s < 11; s++) {
      const t = performance.now();
      rechecked = codeChangeCarry(index, { instruments: ["IBC"] }, current).rechecked;
      times.push(performance.now() - t);
    }
    console.log(`[c10 validity.code_change.carry] p50 ${p50(times).toFixed(2)} ms, ${rechecked} re-checked of 10000`);
    expect(rechecked).toBe(5_000);
    if (ABSOLUTE_BUDGETS) expect(p50(times)).toBeLessThan(200);
  });
});
