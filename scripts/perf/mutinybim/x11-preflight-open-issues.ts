/**
 * What one Approve-card preflight costs on a model with open issues (round 11
 * lane X11), at the size the x11 Jest test runs and at 250k.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/x11-preflight-open-issues.ts [rows...]
 *
 * Rows of the 80-column grid: 50 is about 23k elements (2,000 open issues),
 * 544 about 250k (21,760). Default: both. Metrics, ms per preflight, the 18
 * preflights of packages/bim-kernel/__tests__/x11-preflight-fixtures.ts:
 *   agent.preflight.one_edit.open_issues.20k   50 rows
 *   agent.preflight.one_edit.open_issues       544 rows
 *
 * Moved from that test's Jest wall clock, which read 21.2 ms p50 on CI (run
 * 42505959495) against its 20 ms budget on code the pull request did not
 * touch. The test keeps the work checks (no full space re-read; far cheaper
 * than the first preflight). Prints one `@@perf-result` JSON line.
 */
import { pct, runPreflights } from "../../../packages/bim-kernel/__tests__/x11-preflight-fixtures";

import { emit, gc, type Sample } from "./lib";

const METRIC: Readonly<Record<number, string>> = { 50: "agent.preflight.one_edit.open_issues.20k", 544: "agent.preflight.one_edit.open_issues" };
const rowsArgs = process.argv.slice(2).map(Number);
const rowSizes = rowsArgs.length > 0 ? rowsArgs : [50, 544];

const samples: Sample[] = [];
const invariants: Record<string, number> = {};
for (const rows of rowSizes) {
  const metric = METRIC[rows];
  if (!metric) throw new Error(`[perf/x11-preflight-open-issues] no budget row for ${rows} rows; use ${Object.keys(METRIC).join(" or ")}`);
  gc();
  const run = runPreflights(rows);
  const values = [...run.sameHead, ...run.newHead];
  console.error(`[perf/x11-preflight-open-issues] ${rows} rows: ${run.elementCount} elements, ${run.openIssues} open issues; first ${run.firstMs.toFixed(1)} ms; p50 ${pct(values, 0.5).toFixed(2)} ms, p95 ${pct(values, 0.95).toFixed(2)} ms`);
  samples.push({ metric, values, counts: { totalElements: run.elementCount, affectedElements: 1 }, note: `previewEdit with ${run.openIssues} open issues; half the preflights meet a head committed in between.` });
  invariants[`x11.previewFullSyncs.${rows}`] = run.previewFullSyncs;
}

emit({
  suite: "batch",
  workload: { rows: rowSizes, preflightsPerRun: 18 },
  network: "in-process",
  participants: 1,
  samples,
  invariants,
});
