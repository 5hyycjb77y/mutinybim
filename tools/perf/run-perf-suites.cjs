#!/usr/bin/env node
/**
 * The perf suites that build a full-size model, each in its own Jest process
 * (one 250k model in memory at a time), one after another.
 *
 *   npm run perf:suites                         # every suite
 *   npm run perf:suites -- --only=k9,o8         # some of them
 *   npm run perf:suites -- --json=<file>        # also write one Jest report per suite into <file>'s folder
 *   npm run perf:suites -- --tier=XS            # a quick check on small models (k11, t8 and a11 always build 250k)
 *
 * MUTINYBIM_PERF_BUDGETS=relative (a shared runner): same-run comparisons,
 * counts and correctness still fail the run; millisecond ceilings are skipped.
 * Unset (or "absolute"): every ceiling holds, as on a calibrated machine.
 *
 * These suites skip in a plain `npm test` because each switch below is off.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const F11_ROWS = { XS: "50", "250k": "544", "1M": "2176" };

/** id, test file, and the switches that turn it on at a model size (the gate uses 250k). */
const SUITES = [
  ["a9", "packages/bim-kernel/__tests__/a9-perf.test.ts", (t) => ({ A9_PERF: "1", A9_PERF_TIER: t })],
  ["c10", "packages/bim-kernel/__tests__/c10-perf.test.ts", () => ({ C10_PERF: "1" })],
  ["f11", "packages/bim-kernel/__tests__/f11-perf.test.ts", (t) => ({ F11_PERF: "1", F11_PERF_ROWS: F11_ROWS[t] })],
  ["j9", "packages/bim-kernel/__tests__/j9-perf.test.ts", (t) => ({ J9_PERF: "1", J9_PERF_TIER: t })],
  ["k10", "packages/bim-kernel/__tests__/k10-perf.test.ts", (t) => ({ K10_PERF: "1", K10_PERF_TIER: t })],
  // Its row-versus-switch ratio is only meaningful on a full-size model: below that both are timer noise.
  ["k11", "packages/bim-kernel/__tests__/k11-perf.test.ts", () => ({ K11_PERF: "1" })],
  ["l11", "packages/bim-kernel/__tests__/l11-perf.test.ts", () => ({ L11_PERF: "1" })],
  ["o8", "packages/bim-kernel/__tests__/o8-delta-perf.test.ts", (t) => ({ O8_PERF: "1", O8_PERF_SCALE: t })],
  ["p10", "packages/bim-kernel/__tests__/p10-perf.test.ts", (t) => ({ P10_PERF: "1", P10_PERF_TIER: t })],
  ["r5g", "packages/bim-kernel/__tests__/r5g-category-resolve-perf.test.ts", () => ({ R5G_PERF: "1" })],
  ["t8", "packages/bim-kernel/__tests__/t8-tap-hosting-perf.test.ts", () => ({ T8_PERF: "1" })],
  ["e12", "packages/bim-pack-electrical/__tests__/e12-perf.test.ts", () => ({ E12_PERF: "1" })],
  ["p12", "packages/bim-pack-plumbing/__tests__/p12-perf.test.ts", () => ({ P12_PERF: "1" })],
  ["a11", "packages/bim-pack/__tests__/a11-perf.test.ts", () => ({ A11_PERF: "1" })],
  ["k8", "packages/bim-pack/__tests__/k8-switch-perf.test.ts", (t) => ({ K8_PERF: "1", K8_PERF_SCALE: t })],
  ["k9", "packages/bim-pack/__tests__/k9-perf.test.ts", (t) => ({ K9_PERF: "1", K9_PERF_SCALE: t })],
  ["w11", "packages/bim-sync/__tests__/w11-perf.test.ts", () => ({ W11_PERF: "1" })],
];

const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = value("only")?.split(",").filter(Boolean);
const tier = value("tier") ?? "250k";
if (!["XS", "250k", "1M"].includes(tier)) {
  console.error(`[perf-suites] --tier=${tier} is not XS, 250k or 1M`);
  process.exit(2);
}
const jsonFile = value("json");
const unknown = (only ?? []).filter((id) => !SUITES.some(([s]) => s === id));
if (unknown.length) {
  console.error(`[perf-suites] unknown suite(s): ${unknown.join(", ")}. Known: ${SUITES.map(([s]) => s).join(", ")}`);
  process.exit(2);
}
const mode = process.env.MUTINYBIM_PERF_BUDGETS ?? "absolute";
if (mode !== "absolute" && mode !== "relative") {
  console.error(`[perf-suites] MUTINYBIM_PERF_BUDGETS=${mode} is not "absolute" or "relative"`);
  process.exit(2);
}

const root = process.cwd();
const jest = require.resolve("jest/bin/jest", { paths: [root] });
const selected = SUITES.filter(([id]) => !only || only.includes(id));
const outDir = jsonFile ? path.dirname(path.resolve(jsonFile)) : null;
if (outDir) fs.mkdirSync(outDir, { recursive: true });

console.log(`[perf-suites] ${selected.length} suite(s), ${tier} models, budgets ${mode}`);
const results = [];
for (const [id, file, switches] of selected) {
  const env = switches(tier);
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`[perf-suites] ${id}: ${file} is missing`);
    results.push({ id, file, ok: false, seconds: 0, why: "test file missing" });
    continue;
  }
  const started = Date.now();
  const report = outDir ? path.join(outDir, `perf-suite-${id}.json`) : null;
  const jestArgs = ["--expose-gc", "--max-old-space-size=8192", jest, file, "--runInBand", "--ci", ...(report ? ["--json", "--testLocationInResults", `--outputFile=${report}`] : [])];
  console.log(`\n[perf-suites] ${id}: ${file} (${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")})`);
  const r = spawnSync(process.execPath, jestArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env, MUTINYBIM_PERF_BUDGETS: mode, JEST_TEST_TIMEOUT: process.env.JEST_TEST_TIMEOUT ?? "600000" },
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (r.error) console.error(`[perf-suites] ${id}: could not start Jest`, r.error);
  results.push({ id, file, ok: r.status === 0, seconds, why: r.status === 0 ? "" : `exit ${r.status ?? r.signal}` });
}

if (jsonFile) {
  // One Jest report holding every suite, so CI's failure reporter reads a single file.
  const merged = { numFailedTests: 0, numPassedTests: 0, testResults: [] };
  for (const { id } of results) {
    const file = path.join(outDir, `perf-suite-${id}.json`);
    if (!fs.existsSync(file)) continue;
    const one = JSON.parse(fs.readFileSync(file, "utf8"));
    merged.numFailedTests += one.numFailedTests ?? 0;
    merged.numPassedTests += one.numPassedTests ?? 0;
    merged.testResults.push(...(one.testResults ?? []));
  }
  fs.writeFileSync(path.resolve(jsonFile), JSON.stringify(merged, null, 2));
}

console.log("\n[perf-suites] summary");
for (const r of results) console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.id.padEnd(4)} ${String(r.seconds).padStart(6)} s  ${r.file}${r.why ? `  (${r.why})` : ""}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`[perf-suites] ${failed.length} of ${results.length} failed: ${failed.map((r) => r.id).join(", ")}`);
  process.exit(1);
}
console.log(`[perf-suites] all ${results.length} passed (budgets ${mode})`);
