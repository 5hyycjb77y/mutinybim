# Performance

MutinyBIM is built for 250,000- and 1,000,000-element models with many people
editing at once. Performance is checked like correctness: by measured budgets
that block a change.

## The budgets

`docs/perf/mutinybim-budgets.json` holds one row per measured operation: its
unit, scope (in-process, browser, server), cache state, and a p50 and p95
budget. It also holds **invariants**, exact limits that prove selective loading
and incremental updates (for example, how many elements one edit rewrites).

Budgets are set from measurements and only ever tightened. **Never raise a
budget to get a green build.** If your change is slower, fix the hot path; if
that is not possible, say why in the pull request and let a maintainer decide.

## Running it

```bash
npm run perf:bim:ci                 # the gate: 250k synthetic building and the suites CI runs, 3 runs each
npm run perf:bim -- --suites=parts  # one suite, day to day
npm run perf:suites                 # the perf tests that build a full-size model, one per process
npm run perf:suites -- --only=k9,o8 # some of them
```

`perf:bim` writes `results.json` and `report.md` under `.perf-results/`. The
report lists every row with its budget, verdict and the counts that prove the
work was incremental.

Close other heavy programs first; a busy machine is marked "noisy" in the
report. A 250k run needs about 4 GB of free memory.

## Absolute and relative budgets

A timing means something only on known hardware.

- **Absolute** (the default): every timing must meet its budget, at
  `ci.budgetFactor` times the budget in CI. Use this on the reference laptop
  class or a calibrated runner.
- **Relative** (`MUTINYBIM_PERF_BUDGETS=relative`): for shared runners whose
  speed varies. Invariants, sizes (MB, KB), counts and same-run ratios ("the
  incremental path is faster than the full one") still block. Timings are
  measured and reported against their budgets, and do not block.

## In CI

The **Perf gate** workflow (`.github/workflows/perf-gate.yml`) runs on every
pull request and push to `main`. On a pull request that touches none of
`packages/bim-kernel`, `packages/bim-sync`, `packages/bim-viewer*`,
`packages/bim-editor`, `services/bim-authority` or the gate itself, it reports
success without measuring, so it can be a required check.

- With the repository variable `PERF_RUNNER` set to a calibrated runner label,
  pushes and pull requests from this repository's branches run there with
  absolute budgets.
- Without it, and always for pull requests from forks, the gate runs on
  `ubuntu-latest` with relative budgets.

The run summary shows the gate's full report; the results are uploaded as the
`perf-gate-results` artifact.
