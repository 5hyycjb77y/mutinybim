/**
 * @jest-environment node
 *
 * Round 11 lane X11, `agent.preflight.one_edit` on a model with open issues.
 *
 * Lane F's row (round 8) was measured on a valid grid only: its comment said
 * "a model with open issues re-validates in full on every edit, which this row
 * doesn't measure". This is the same grid with 2 typeless heads in every
 * fourth room (21,760 open issues at 250k), the state round 8 F's finding named
 * (≈ 1.4 s per edit). The workload is x11-preflight-fixtures.ts.
 *
 * Here: the work a preflight does. At any size, no preflight may re-read every
 * space (the space index follows the preview and comes back). Round 10's code
 * re-read every space on every preflight: 39.2 ms p50 at 250k, and a full
 * re-read per sample at any size. The millisecond budgets are Perf Gate (BIM)
 * rows agent.preflight.one_edit.open_issues.20k (this size) and
 * agent.preflight.one_edit.open_issues (250k), measured in plain Node by
 * scripts/perf/mutinybim/x11-preflight-open-issues.ts.
 */
import { pct, runPreflights } from "./x11-preflight-fixtures";

const ROWS = Number(process.env.X11_PERF_ROWS ?? 50);

describe("x11 agent.preflight.one_edit with open issues", () => {
  it("x11-preflight-open-issues-fast: one preflight stays on the touched neighbourhood", () => {
    const run = runPreflights(ROWS);
    expect(run.openIssues).toBeGreaterThan(0);
    const all = [...run.sameHead, ...run.newHead];
    expect(all).toHaveLength(18);
    // Re-reading every space is what made a preflight scale with the model (round 10: one per sample).
    expect(run.previewFullSyncs).toBe(0);
    process.stderr.write(
      `[x11 agent.preflight.one_edit open issues] ${run.elementCount} elements, ${run.openIssues} open issues; first after load ${run.firstMs.toFixed(1)} ms; ` +
        `p50 ${pct(all, 0.5).toFixed(1)} ms, p95 ${pct(all, 0.95).toFixed(1)} ms, max ${pct(all, 1).toFixed(1)} ms over ${all.length} ` +
        `(same head p50 ${pct(run.sameHead, 0.5).toFixed(1)}, after a commit p50 ${pct(run.newHead, 0.5).toFixed(1)})\n`,
    );
    // Machine-independent: a preflight that re-validated the whole model would cost about as much as
    // the first one after load (which builds the ledger); staying on the neighbourhood is far cheaper.
    expect(pct(all, 0.5)).toBeLessThan(run.firstMs / 4);
  });
});
