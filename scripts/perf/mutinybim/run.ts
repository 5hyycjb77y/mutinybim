/**
 * MutinyBIM standing performance gate. Runs each suite in its own process
 * (one tier per process, cold state per run), combines runs median-of-N,
 * checks absolute budgets, regression bands against a same-hardware baseline,
 * and the structural invariants that prove selective loading and incremental
 * updates. Writes results.json and report.md.
 *
 *   npm run perf:bim                      # 250k, every suite available on this machine
 *   npm run perf:bim:checkpoint           # 1M, every suite (run alone; ~5 GB peak)
 *   npm run perf:bim:ci                   # CI: 250k synthetic, part editor, calc, electrical, plumbing, sheets, schedules; enforced
 *   npm run perf:bim -- --self-test       # comparator self-test, no measurement
 *
 * MUTINYBIM_PERF_BUDGETS=relative (a shared runner whose speed varies): the
 * invariants, sizes (MB, KB) and same-run ratios still block; timings are
 * measured and reported against their budgets without blocking.
 *
 * Budgets: docs/perf/mutinybim-budgets.json.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import {
  BASELINE_DIR,
  RESULT_PREFIX,
  REPO_ROOT,
  absoluteVerdict,
  combineRuns,
  gitInfo,
  hardware,
  loadBudgets,
  metricsWithoutTolerance,
  regressionVerdict,
  round,
  summarize,
  toleranceFor,
  type Budgets,
  type Counts,
  type MetricResult,
  type Summary,
  type SuiteOutput,
  type Verdict,
} from "./lib";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;

const ALL_SUITES = ["synthetic", "reference", "browser", "remote", "parameters", "sheets", "parts", "calc", "electrical", "plumbing", "lint", "schedules", "grid", "batch", "linked"] as const;
/** What CI measures: the synthetic tier, the part editor, the calc plugins, electrical load totals and circuiting, plumbing load point totals, sheets (view regen, tag styles, linked plan cuts from a synthetic IFC), schedules (row engine, formula column, unit formatting, class recognition), the schedule grid scroll, and the batch hot paths (linked reference index and snap, door and window bodies, discipline lookup); no recorded fixtures, no browser, no network. */
const CI_SUITES = ["synthetic", "parts", "calc", "electrical", "plumbing", "sheets", "lint", "schedules", "grid", "batch"] as const;
type SuiteName = (typeof ALL_SUITES)[number];
/** Rows the schedules suite emits (schedule.evaluate stays with sheets). */
const SCHEDULE_SUITE_METRIC = /^(schedule\.(grid|patch|formula|paste|authority|join)\.|schedules\.equipment\.|units\.|registry\.|fields\.|serves\.)/;

// ------------------------------------------------------------------ self-test

function selfTest(): void {
  const tol = { rel: { p50: 0.25, p95: 0.5 }, absFloor: 5 };
  const budgets = loadBudgets();
  const { us: _us, ...defaultsWithoutUs } = budgets.regression.defaults;
  const withoutUsDefault: Budgets = {
    ...budgets,
    regression: { ...budgets.regression, defaults: defaultsWithoutUs },
    metrics: { probe: { label: "probe", unit: "us", scope: "in-process", cache: "warm", p50: 1, p95: 1, status: "active" } },
  };
  const cases: Array<[string, boolean]> = [
    ["every budget row has a regression tolerance", metricsWithoutTolerance(budgets).length === 0],
    ["a unit with no default is named", metricsWithoutTolerance(withoutUsDefault).join() === "probe (unit us)"],
    ["toleranceFor fails loudly on a unit with no default", (() => {
      try {
        toleranceFor(withoutUsDefault, "probe");
        return false;
      } catch (err) {
        return err instanceof Error && err.message.includes("probe (unit us)");
      }
    })()],
    ["noise inside abs floor is OK", regressionVerdict({ p50: 4, p95: 8, n: 5 }, { p50: 2, p95: 4, n: 5 }, tol) === "OK"],
    ["+20% on a big number is OK", regressionVerdict({ p50: 120, p95: 200, n: 5 }, { p50: 100, p95: 180, n: 5 }, tol) === "OK"],
    ["+30% p50 beyond floor regresses", regressionVerdict({ p50: 130, p95: 190, n: 5 }, { p50: 100, p95: 180, n: 5 }, tol) === "REGRESSED"],
    ["p95 doubling regresses", regressionVerdict({ p50: 100, p95: 400, n: 5 }, { p50: 100, p95: 180, n: 5 }, tol) === "REGRESSED"],
    ["no baseline is reported, not passed", regressionVerdict({ p50: 1, p95: 1, n: 5 }, null, tol) === "NO-BASELINE"],
    ["absolute budget fails a slow baseline", absoluteVerdict({ p50: 1100, p95: 1100, n: 5 }, { p50: 1000, p95: 2000 }) === "FAIL"],
    ["median-of-N ignores one outlier run", combineRuns([{ p50: 10, p95: 12, n: 21 }, { p50: 11, p95: 13, n: 21 }, { p50: 90, p95: 99, n: 21 }])?.p50 === 11],
    ["cold runs: p95 is nearest-rank of runs", combineRuns([10, 11, 12, 13, 50].map((v) => ({ p50: v, p95: v, n: 1 })))?.p95 === 50],
  ];
  const failed = cases.filter(([, ok]) => !ok);
  for (const [name, ok] of cases) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (failed.length > 0) process.exit(1);
  console.log(`[perf] self-test passed (${cases.length} cases)`);
}

// ------------------------------------------------------------------ children

/** Where the private reference model's fixture is cached (reference-fixture.json, absent from the open-source tree). */
function defaultReferenceFixtureDir(): string {
  const file = path.join(REPO_ROOT, "scripts/perf/mutinybim/reference-fixture.json");
  if (!existsSync(file)) return path.join(REPO_ROOT, ".fixtures-cache/reference");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("dir" in parsed) || typeof parsed.dir !== "string") throw new Error(`${file} must be {"dir": "<repo-relative folder>"}`);
  return path.join(REPO_ROOT, parsed.dir);
}

/** The newest export's host parameters file under the fixture directory (exports are named by start time). */
function newestParametersFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const exports = readdirSync(dir).filter((d) => d.endsWith("-export")).sort().reverse();
  for (const e of exports) {
    const folder = path.join(dir, e, "unpacked", "parameters");
    if (!existsSync(folder)) continue;
    const file = readdirSync(folder).find((f) => f.endsWith(".parameters.json"));
    if (file) return path.join(folder, file);
  }
  return null;
}

/**
 * Children that measure host code (the agent pack-tool host, the equipment
 * list screen). A checkout without them (the open-source tree) reports their
 * rows as not run.
 */
const HOST_CHILDREN = [
  { script: "pack-tools-dispatch.ts", rows: /^bim\.pack_tools\./, what: "the agent pack-tool host" },
  { script: "equipment-list.ts", rows: /^schedules\.equipment\./, what: "the equipment list screen" },
] as const;
const childPresent = (script: string): boolean => existsSync(path.join(REPO_ROOT, "scripts/perf/mutinybim", script));

function runChild(script: string, childArgs: string[], heapMB: number, nodeArgs: readonly string[] = []): Promise<SuiteOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", `--max-old-space-size=${heapMB}`, ...nodeArgs, "--import", "tsx", path.join(REPO_ROOT, "scripts/perf/mutinybim", script), ...childArgs], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
      if (code !== 0 || !line) {
        reject(new Error(`[perf] ${script} exited ${code}${line ? "" : " without a result line"}:\n${out.slice(-2000)}`));
        return;
      }
      resolve(JSON.parse(line.slice(RESULT_PREFIX.length)) as SuiteOutput);
    });
  });
}

// ------------------------------------------------------------------ aggregation

interface Row {
  readonly key: string;
  readonly metric: string;
  readonly variant: string | undefined;
  readonly perRun: Summary[];
  counts?: Counts;
  note?: string;
}

function aggregate(outputs: readonly SuiteOutput[]): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const out of outputs) {
    for (const s of out.samples) {
      const key = s.variant ? `${s.metric}|${s.variant}` : s.metric;
      const summary = summarize(s.values);
      if (!summary) continue;
      const row = rows.get(key) ?? { key, metric: s.metric, variant: s.variant, perRun: [] };
      row.perRun.push(summary);
      if (s.counts) row.counts = s.counts;
      if (s.note) row.note = s.note;
      rows.set(key, row);
    }
  }
  return rows;
}

interface BaselineFile {
  readonly tier: string;
  readonly hardwareClass: string;
  readonly git: { readonly sha: string };
  readonly recordedAt: string;
  readonly metrics: Record<string, Summary>;
}

function baselinePath(hardwareClass: string, tier: string): string {
  return path.join(BASELINE_DIR, `${hardwareClass}.${tier}.json`);
}

function readBaseline(file: string): BaselineFile | null {
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("metrics" in parsed) || !("tier" in parsed)) throw new Error(`${file} is not a baseline file`);
  return parsed as BaselineFile;
}

// ------------------------------------------------------------------ report

function fmt(n: number | undefined | null, unit: string): string {
  if (n === undefined || n === null) return "–";
  if (unit === "MB") return `${round(n, 1)} MB`;
  if (unit === "KB") return `${round(n, 1)} KB`;
  if (unit === "us") return n >= 1000 ? `${round(n / 1000, 2)} ms` : `${round(n, n < 10 ? 2 : 1)} µs`;
  if (unit === "ns") return n >= 1000 ? `${round(n / 1000, 2)} µs` : `${round(n, 0)} ns`;
  if (unit === "frameMs" || unit === "ms") return n >= 1000 ? `${round(n / 1000, 2)} s` : `${round(n, n < 10 ? 2 : 1)} ms`;
  return String(round(n, 3));
}

function countsText(c: Counts | undefined): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.totalElements !== undefined) parts.push(`total ${c.totalElements.toLocaleString("en-US")}`);
  if (c.subscribedElements !== undefined) parts.push(`subscribed ${c.subscribedElements.toLocaleString("en-US")}`);
  if (c.visibleSolids !== undefined) parts.push(`visible ${c.visibleSolids.toLocaleString("en-US")}`);
  if (c.visibleTriangles !== undefined) parts.push(`tris ${c.visibleTriangles.toLocaleString("en-US")}`);
  if (c.networkElements !== undefined) parts.push(`network ${c.networkElements}`);
  if (c.affectedElements !== undefined) parts.push(`affected ${c.affectedElements}`);
  if (c.solidsRebuilt !== undefined) parts.push(`rebuilt ${c.solidsRebuilt}`);
  return parts.join(", ");
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  if (flag("self-test")) {
    selfTest();
    return;
  }
  const budgets: Budgets = loadBudgets();
  const ci = flag("ci");
  const tier = arg("tier", ci ? budgets.ci.tier : "250k");
  const runs = Number(arg("runs", String(ci ? budgets.ci.runs : budgets.regression.minRuns)));
  const samplesPerRun = arg("samples", "21");
  const suites = arg("suites", (ci ? CI_SUITES : ALL_SUITES).join(","))
    .split(",")
    .filter((s): s is SuiteName => (ALL_SUITES as readonly string[]).includes(s));
  const enforce = ci || flag("enforce");
  const factor = ci ? budgets.ci.budgetFactor : 1;
  const budgetMode = process.env.MUTINYBIM_PERF_BUDGETS ?? "absolute";
  if (budgetMode !== "absolute" && budgetMode !== "relative") throw new Error(`MUTINYBIM_PERF_BUDGETS=${budgetMode} is not "absolute" or "relative"`);
  const relative = budgetMode === "relative";
  const fixtureDir = arg("fixture-dir", process.env.MUTINYBIM_FIXTURE_DIR ?? defaultReferenceFixtureDir());
  const referenceRuns = Number(arg("reference-runs", "3"));
  const browserRuns = Number(arg("browser-runs", "3"));
  const heapMB = tier === "1M" ? 12_288 : 4096;
  const hw = hardware();
  const git = gitInfo();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = arg("out", path.join(REPO_ROOT, ".perf-results/mutinybim", `${stamp}-${tier}`));
  mkdirSync(outDir, { recursive: true });
  const slicePath = path.join(outDir, "zone-slice.json");
  const notRun: Record<string, string> = {};
  const outputs: SuiteOutput[] = [];

  console.log(`[perf] tier=${tier} runs=${runs} suites=${suites.join(",")} budgets=${budgetMode} hardware=${hw.hardwareClass}${hw.noisy ? " (NOISY: load or memory)" : ""}`);
  const hostChildrenAbsent = HOST_CHILDREN.filter((c) => !childPresent(c.script));

  if (suites.includes("synthetic")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const out = await runChild("synthetic.ts", [`--tier=${tier}`, `--samples=${samplesPerRun}`, ...(i === 0 ? [`--write-slice=${slicePath}`] : [])], heapMB);
      outputs.push(out);
      console.log(`[perf] synthetic run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("sheets")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("sheets.ts", [`--tier=${tier}`, `--samples=${samplesPerRun}`], heapMB));
      console.log(`[perf] sheets run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("parts")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("parts.ts", [`--samples=${samplesPerRun}`], 1024));
      console.log(`[perf] parts run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("calc")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("calc.ts", [`--samples=${samplesPerRun}`], 1024));
      console.log(`[perf] calc run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("electrical")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("electrical.ts", [`--tier=${tier}`, `--samples=${samplesPerRun}`], heapMB));
      console.log(`[perf] electrical run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("plumbing")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("plumbing.ts", [`--tier=${tier}`, `--samples=${samplesPerRun}`], heapMB));
      console.log(`[perf] plumbing run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("lint")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("lint.ts", [`--tier=${tier}`, `--samples=${samplesPerRun}`], heapMB));
      console.log(`[perf] lint run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("schedules")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("schedules.ts", [`--tier=${tier}`, `--samples=${samplesPerRun}`], heapMB));
      if (childPresent("equipment-list.ts")) outputs.push(await runChild("equipment-list.ts", [`--samples=${samplesPerRun}`], 1024));
      console.log(`[perf] schedules run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("grid")) {
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("grid.ts", [], 1024));
      console.log(`[perf] grid run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  const fixtureHere = existsSync(fixtureDir);
  if (suites.includes("batch")) {
    // Planned parts, spaces and the load lifecycle (Oct 27 batch): each reads from per-kind indexes and advances from changed ids.
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      outputs.push(await runChild("planned-parts.ts", [`--tier=${tier}`], heapMB));
      outputs.push(await runChild("spaces-density.ts", [`--samples=${samplesPerRun}`], heapMB));
      outputs.push(await runChild("requirements-engine.ts", [`--tier=${tier}`], heapMB));
      outputs.push(await runChild("structural-load-path.ts", [`--samples=${samplesPerRun}`], 1024));
      outputs.push(await runChild("command-dispatch.ts", [`--samples=${samplesPerRun}`], 1024));
      outputs.push(await runChild("package-verify.ts", [`--samples=${samplesPerRun}`], 1024));
      // Per-call hot paths whose budgets used to be Jest wall clocks (moved 2026-11-08).
      outputs.push(await runChild("d16-linked-reference.ts", ["50000", "5000"], heapMB));
      outputs.push(await runChild("a15-walls-openings.ts", [tier, samplesPerRun], heapMB));
      outputs.push(await runChild("discipline-lookup.ts", [`--samples=${samplesPerRun}`], 1024));
      console.log(`[perf] batch run ${i + 1}/${runs} done in ${round((performance.now() - t0) / 1000, 1)} s`);
    }
  }
  if (suites.includes("batch") && childPresent("pack-tools-dispatch.ts")) {
    // The agent pack-tool host is host server code: it loads under the condition Next's server bundle resolves with.
    for (let i = 0; i < runs; i++) {
      outputs.push(await runChild("pack-tools-dispatch.ts", [`--samples=${samplesPerRun}`], 1024, ["--conditions=react-server"]));
    }
  }
  if (suites.includes("batch")) {
    // Approve-card preflight with open issues, at the x11 Jest test's size and at 250k (both sizes every run, whatever the tier).
    for (let i = 0; i < runs; i++) outputs.push(await runChild("x11-preflight-open-issues.ts", ["50", "544"], heapMB));
  }
  if (suites.includes("linked")) {
    // Needs web-ifc and a synthetic architect's IFC; local only until a CI fixture exists.
    for (let i = 0; i < runs; i++) {
      outputs.push(await runChild("linked-background-switch.ts", [`--samples=${samplesPerRun}`], 4096));
    }
  }
  if (suites.includes("reference")) {
    if (!fixtureHere || !childPresent("reference-model.ts")) notRun.reference = `reference model fixture not found at ${fixtureDir} (private; pass --fixture-dir)`;
    else
      for (let i = 0; i < referenceRuns; i++) {
        outputs.push(await runChild("reference-model.ts", [`--fixture-dir=${fixtureDir}`], 4096));
        console.log(`[perf] reference run ${i + 1}/${referenceRuns} done`);
      }
  }
  if (suites.includes("parameters")) {
    const paramsFile = args.find((a) => a.startsWith("--params-file=")) ? arg("params-file", "") : newestParametersFile(fixtureDir);
    if (!paramsFile) notRun.parameters = `no Revit parameters file under ${fixtureDir} (an export from the add-in with parameters/<model>.parameters.json; pass --params-file)`;
    else
      for (let i = 0; i < referenceRuns; i++) {
        outputs.push(await runChild("revit-parameters.ts", [`--params-file=${paramsFile}`], 4096));
        console.log(`[perf] parameters run ${i + 1}/${referenceRuns} done`);
      }
  }
  if (suites.includes("browser")) {
    const fragDir = path.join(defaultReferenceFixtureDir(), "perf-frags");
    const shape = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
    if (!shape) throw new Error(`unknown tier ${tier}`);
    // Same edit target as synthetic.ts: the author's zone is the last zone of the top floor.
    const p = `L${String(shape.floors).padStart(2, "0")}-Z${shape.zonesPerFloor}`;
    try {
      outputs.push(await runChild("browser-3d.ts", [`--frags=${fragDir}`, `--slice=${slicePath}`, `--runs=${browserRuns}`, `--tap=${p}-air-t1-s2-b1-tap`], 4096));
      console.log("[perf] browser done");
    } catch (err) {
      console.error("[perf] browser suite failed", err);
      notRun.browser = `browser suite failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    }
  }
  if (suites.includes("remote")) {
    try {
      outputs.push(await runChild("remote.ts", [...(args.find((a) => a.startsWith("--remote-targets=")) ? [`--targets=${arg("remote-targets", "")}`] : [])], 1024));
      console.log("[perf] remote done");
    } catch (err) {
      console.error("[perf] remote suite failed", err);
      notRun.remote = `remote probe failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    }
  }

  // ---------------------------------------------------------------- evaluate
  const rows = aggregate(outputs);
  const baselineFile = arg("baseline", baselinePath(hw.hardwareClass, tier));
  const baseline = readBaseline(baselineFile);
  // A checkpoint run blocks on every absolute failure; only CI / day-to-day runs honor the known list.
  const known = new Set(flag("checkpoint") ? [] : (budgets.knownBudgetFailures?.[tier] ?? []));
  const results: MetricResult[] = [];
  const knownNowPassing: string[] = [];
  for (const [metric, b] of Object.entries(budgets.metrics)) {
    // Sizes and same-run ratios do not depend on the runner's speed.
    const hardwareIndependent = b.unit === "MB" || b.unit === "KB" || b.unit === "ratio";
    const scale = hardwareIndependent || b.ciBudgetFactor === 1 ? 1 : factor;
    const budget = { p50: b.p50 * scale, p95: b.p95 * scale };
    const matching = [...rows.values()].filter((r) => r.metric === metric);
    if (matching.length === 0) {
      const suite = metric.startsWith("3d.reference.convert") || metric.startsWith("3d.reference.tessellate") ? "reference" : metric.startsWith("3d.") || metric.startsWith("memory.browser") ? "browser" : metric.startsWith("remote.") ? "remote" : metric.startsWith("revit.parameters.") ? "parameters" : metric.startsWith("part.") || metric.startsWith("geometry.") ? "parts" : metric.startsWith("calc.") ? "calc" : metric.startsWith("electrical.") || metric.startsWith("diagram.") ? "electrical" : metric.startsWith("plumbing.") ? "plumbing" : metric.startsWith("lint.") ? "lint" : SCHEDULE_SUITE_METRIC.test(metric) ? "schedules" : metric.startsWith("grid.") ? "grid" : metric.startsWith("planned.") || metric.startsWith("spaces.") || metric.startsWith("requirements.") || metric.startsWith("struct.") || metric.startsWith("kernel.packs.") || metric.startsWith("kernel.discipline.") || metric.startsWith("library.install.verify.") || metric.startsWith("linked.reference.") || metric.startsWith("viewer.opening.body.") ? "batch" : metric.startsWith("linked.") ? "linked" : metric.startsWith("stress.") ? "stress" : "synthetic";
      results.push({
        metric,
        label: b.label,
        unit: b.unit,
        scope: b.scope,
        cache: b.cache,
        current: null,
        budget,
        verdict: b.status === "pending" ? "PENDING" : "NOT-RUN",
        regression: "NO-BASELINE",
        baseline: null,
        note:
          b.status === "pending"
            ? b.measures
            : (notRun[suite] ??
              (() => {
                const absent = hostChildrenAbsent.find((c) => c.rows.test(metric));
                return absent ? `measures ${absent.what}, which this checkout does not have (${absent.script})` : `suite "${suite}" not selected`;
              })()),
      });
      continue;
    }
    for (const row of matching) {
      const current = combineRuns(row.perRun);
      if (!current) continue;
      // Remote rows describe shared test infrastructure (other people's commits, redeploys): absolute budgets only.
      const base = b.scope === "remote" ? null : (baseline?.metrics[row.key] ?? null);
      const verdict: Verdict = b.status === "pending" ? "PENDING" : absoluteVerdict(current, budget);
      if (verdict === "PASS" && known.has(row.key)) knownNowPassing.push(row.key);
      results.push({
        metric: row.key,
        label: b.label,
        unit: b.unit,
        scope: b.scope,
        cache: b.cache,
        current,
        budget,
        verdict,
        regression: regressionVerdict(current, base, toleranceFor(budgets, metric)),
        baseline: base,
        ...(row.counts ? { counts: row.counts } : {}),
        ...(row.note ? { note: row.note } : {}),
      });
    }
  }
  const info = [...rows.values()].filter((r) => !(r.metric in budgets.metrics)).map((r) => ({ key: r.key, current: combineRuns(r.perRun), counts: r.counts, note: r.note }));

  // Invariants: worst value across runs.
  const invariantValues: Record<string, number> = {};
  for (const out of outputs) {
    for (const [k, v] of Object.entries(out.invariants ?? {})) invariantValues[k] = Math.max(invariantValues[k] ?? Number.NEGATIVE_INFINITY, v);
    const sliceRow = out.samples.find((s) => s.metric === "join.cold");
    if (sliceRow?.counts?.subscribedElements !== undefined) invariantValues.subscribedElements = Math.max(invariantValues.subscribedElements ?? 0, sliceRow.counts.subscribedElements);
  }
  const otherTier = tier === "1M" ? "250k" : tier === "250k" ? "1M" : null;
  const otherBaseline = otherTier ? readBaseline(baselinePath(hw.hardwareClass, otherTier)) : null;
  const previewNow = results.find((r) => r.metric === "edit.preview.slide_branch")?.current?.p50;
  const previewOther = otherBaseline?.metrics["edit.preview.slide_branch"]?.p50;
  if (previewNow !== undefined && previewOther !== undefined && previewOther > 0) {
    invariantValues.previewScale = tier === "1M" ? previewNow / previewOther : previewOther / previewNow;
  }
  const tierRank: Record<string, number> = { XS: 0, "250k": 1, "500k": 2, "1M": 3 };
  const invariants = Object.entries(budgets.invariants).map(([id, inv]) => {
    const value = invariantValues[id];
    const applies = !inv.minTier || (tierRank[tier] ?? 0) >= (tierRank[inv.minTier] ?? 0);
    const status = value === undefined || !applies ? "NOT-RUN" : value <= inv.max ? "PASS" : "FAIL";
    return { id, label: inv.label, max: inv.max, value: value === undefined ? null : round(value, 4), status };
  });

  // Relative budgets: a timing says nothing on a runner of unknown speed, so only sizes and same-run ratios block.
  const timingRow = (r: MetricResult): boolean => r.unit === "ms" || r.unit === "frameMs" || r.unit === "us" || r.unit === "ns";
  const blocks = (r: MetricResult): boolean => !relative || !timingRow(r);
  const blocking = [
    ...results.filter((r) => r.verdict === "FAIL" && !known.has(r.metric) && blocks(r)).map((r) => `${r.metric}: over absolute budget`),
    ...results.filter((r) => r.regression === "REGRESSED" && blocks(r)).map((r) => `${r.metric}: regressed vs baseline${hw.noisy ? " (noisy run: re-run before acting)" : ""}`),
    ...invariants.filter((i) => i.status === "FAIL").map((i) => `invariant ${i.id} = ${i.value} > ${i.max}`),
    ...(relative ? [] : knownNowPassing.map((k) => `${k} now passes: delete it from knownBudgetFailures["${tier}"]`)),
  ];

  const context = {
    recordedAt: new Date().toISOString(),
    tier,
    runs,
    samplesPerRun: Number(samplesPerRun),
    ci,
    budgetMode,
    budgetFactor: factor,
    hardware: hw,
    git,
    suites,
    notRun,
    baseline: baseline ? { file: path.relative(REPO_ROOT, baselineFile), sha: baseline.git.sha, recordedAt: baseline.recordedAt } : null,
    suiteContext: outputs
      .filter((o, i, all) => all.findIndex((x) => x.suite === o.suite) === i)
      .map((o) => ({ suite: o.suite, network: o.network, participants: o.participants, workload: o.workload })),
  };
  const full = { context, results, invariants, info, blocking, raw: outputs.map((o) => ({ suite: o.suite, info: o.info, invariants: o.invariants })) };
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify(full, null, 2));

  if (flag("write-baseline")) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    const metrics: Record<string, Summary> = {};
    for (const r of results) if (r.current && r.scope !== "remote") metrics[r.metric] = r.current;
    for (const i of info) if (i.current && !i.key.startsWith("net.") && !i.key.startsWith("remote.")) metrics[i.key] = i.current;
    const file: BaselineFile = { tier, hardwareClass: hw.hardwareClass, git: { sha: git.sha }, recordedAt: context.recordedAt, metrics };
    writeFileSync(baselinePath(hw.hardwareClass, tier), `${JSON.stringify(file, null, 2)}\n`);
    console.log(`[perf] baseline written: ${path.relative(REPO_ROOT, baselinePath(hw.hardwareClass, tier))}`);
  }

  // ---------------------------------------------------------------- markdown
  const lines: string[] = [];
  lines.push(`# MutinyBIM perf gate — ${tier}${ci ? " (CI)" : ""}`, "");
  lines.push(`- Recorded: ${context.recordedAt} on \`${git.branch}\` @ \`${git.sha.slice(0, 9)}\`${git.dirty ? " (uncommitted changes)" : ""}`);
  lines.push(`- Hardware: ${hw.cpu}, ${hw.cores} cores, ${hw.memoryGB} GB (${hw.freeMemoryGB} GB free, load ${hw.loadAvg1m})${hw.noisy ? " — **noisy**" : ""}; ${hw.platform}; Node ${hw.node}`);
  lines.push(`- Runs: ${runs} synthetic × ${samplesPerRun} warm samples; combined median-of-N. Budget factor ×${factor}.`);
  if (relative) lines.push("- Budgets: **relative** (MUTINYBIM_PERF_BUDGETS=relative). Invariants, sizes and same-run ratios block; timings are reported against their budgets and do not block.");
  lines.push(`- Baseline: ${baseline ? `\`${path.relative(REPO_ROOT, baselineFile)}\` (${baseline.git.sha.slice(0, 9)})` : "none for this hardware class and tier (regression = NO-BASELINE)"}`);
  for (const s of context.suiteContext) lines.push(`- ${s.suite}: ${s.network}; participants ${s.participants}; workload ${JSON.stringify(s.workload).slice(0, 300)}`);
  for (const [s, why] of Object.entries(notRun)) lines.push(`- ${s}: NOT RUN — ${why}`);
  lines.push("", "| Metric | Scope | Cache | p50 | p95 | Budget p50 / p95 | Absolute | vs baseline | Counts |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const verdict = r.verdict === "FAIL" && known.has(r.metric) ? "FAIL (known)" : r.verdict === "FAIL" && !blocks(r) ? "FAIL (reported)" : r.verdict;
    lines.push(
      `| ${r.metric} | ${r.scope} | ${r.cache} | ${fmt(r.current?.p50, r.unit)} | ${fmt(r.current?.p95, r.unit)} | ${fmt(r.budget.p50, r.unit)} / ${fmt(r.budget.p95, r.unit)} | ${verdict} | ${r.regression} | ${countsText(r.counts)}${r.verdict === "NOT-RUN" || r.verdict === "PENDING" ? (r.note ? ` ${r.note}` : "") : ""} |`,
    );
  }
  lines.push("", "## Invariants (exact)", "", "| Invariant | Value | Max | Status |", "| --- | --- | --- | --- |");
  for (const i of invariants) lines.push(`| ${i.id} — ${i.label} | ${i.value ?? "–"} | ${i.max} | ${i.status} |`);
  if (info.length > 0) {
    lines.push("", "## Informational", "", "| Metric | p50 | p95 | Counts |", "| --- | --- | --- | --- |");
    for (const i of info) lines.push(`| ${i.key} | ${fmt(i.current?.p50, "ms")} | ${fmt(i.current?.p95, "ms")} | ${countsText(i.counts)} |`);
  }
  lines.push("", `## Blocking (${blocking.length})`, "", ...(blocking.length ? blocking.map((b) => `- ${b}`) : ["- none"]));
  writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`);

  console.log(`[perf] results: ${path.relative(REPO_ROOT, path.join(outDir, "results.json"))}`);
  console.log(`[perf] report:  ${path.relative(REPO_ROOT, path.join(outDir, "report.md"))}`);
  const fails = results.filter((r) => r.verdict === "FAIL").length;
  const passes = results.filter((r) => r.verdict === "PASS").length;
  console.log(`[perf] absolute: ${passes} pass, ${fails} fail (${results.filter((r) => r.verdict === "FAIL" && known.has(r.metric)).length} known), ${results.filter((r) => r.verdict === "PENDING").length} pending, ${results.filter((r) => r.verdict === "NOT-RUN").length} not run; blocking ${blocking.length}`);
  for (const b of blocking) console.log(`[perf]   ${b}`);
  if (enforce && blocking.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[perf] gate failed", err);
  process.exit(1);
});
