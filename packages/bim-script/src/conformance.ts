import { DEFAULT_SETTINGS } from "@permitzip/bim-kernel";
import { RUNNER_CONTRACT, type ScriptRunResult, type ScriptRunner } from "./runner";
import { SLICE_FORMAT, type ModelSlice } from "./slice";

/**
 * The runner contract's conformance suite (SCRIPTING-PROPOSAL §5.2). Each
 * probe is an ordinary script that tries to break one rule; the suite
 * passes only when the runner stopped it or the attempt had no effect the
 * harness can see. A runner that lets a script reach the network, read a
 * file outside its input or start a process fails, whatever it reports.
 *
 * The harness supplies what the probes aim at: a URL it listens on, a file
 * holding a secret, a path where a started process would leave a mark.
 */

export interface ConformanceTargets {
  /** A URL the harness listens on; `contacted()` says whether anything reached it. */
  readonly url: string;
  contacted(): boolean;
  /** A file outside the run's input, holding `secret`. */
  readonly secretPath: string;
  readonly secret: string;
  /** Where `touch` from a child process would create a file; `markerExists()` checks. */
  readonly markerPath: string;
  markerExists(): boolean;
}

export interface ConformanceResult {
  readonly check: "limits" | "fresh_process" | "deterministic" | "no_network" | "no_files" | "no_child_processes" | "memory_cap" | "time_cap" | "output_cap";
  readonly ok: boolean;
  readonly detail: string;
}

const EMPTY_SLICE: ModelSlice = { format: SLICE_FORMAT, version: 1, modelId: "conformance", revision: 1, reads: {}, selection: [], elements: {}, connections: [], settings: DEFAULT_SETTINGS, features: [] };

const HEADER = `import { defineScript } from "@permitzip/bim-script";\n`;
const PART = `const part = (note, i) => ({ familyName: "Probe", typeName: "Probe " + i, category: "generic", description: String(note).slice(0, 400), typeParams: [], typeValues: {}, instanceParams: [], connectors: [], geometry: [], symbol: [], tagFields: [], source: { kind: "builtin", libraryVersion: "probe" } });\n`;
const text = (name: string) => `${name}: { type: "text", label: "${name}", maxLength: 400 }`;

/** Probe sources. Plain JavaScript that is also TypeScript, importing only the kit. */
export const CONFORMANCE_PROBES = {
  fresh: `${HEADER}${PART}export default defineScript({ kind: "part", reads: {}, parameters: {}, run(ctx) {
  const g = (0, eval)("this");
  const seen = g.__mutinybimProbeRuns ?? 0;
  g.__mutinybimProbeRuns = seen + 1;
  ctx.parts.define("probe", part("runs-before:" + seen, 0));
} });\n`,
  deterministic: `${HEADER}${PART}export default defineScript({ kind: "part", reads: {}, parameters: { n: { type: "number", label: "n", default: 3 } }, run(ctx, v) {
  for (let i = 0; i < v.n; i++) ctx.parts.define(ctx.id("probe"), part(String(ctx.random()), i));
} });\n`,
  network: `${HEADER}${PART}export default defineScript({ kind: "part", reads: {}, parameters: { ${text("url")} }, async run(ctx, v) {
  const tried = [];
  try { await fetch(v.url); tried.push("fetch-ok"); } catch (e) { tried.push("fetch-no"); }
  try { const http = await import("node:http"); await new Promise((done) => { const r = http.get(v.url, () => done(null)); r.on("error", () => done(null)); }); tried.push("http-tried"); } catch (e) { tried.push("http-no"); }
  try { const r = require("node:http"); await new Promise((done) => { const q = r.get(v.url, () => done(null)); q.on("error", () => done(null)); }); tried.push("require-http-tried"); } catch (e) { tried.push("require-no"); }
  ctx.parts.define("probe", part(tried.join(","), 0));
} });\n`,
  files: `${HEADER}${PART}export default defineScript({ kind: "part", reads: {}, parameters: { ${text("path")} }, async run(ctx, v) {
  const got = [];
  try { const fs = await import("node:fs"); got.push(fs.readFileSync(v.path, "utf8")); } catch (e) { got.push("import-no"); }
  try { got.push(require("node:fs").readFileSync(v.path, "utf8")); } catch (e) { got.push("require-no"); }
  try { got.push(process.binding("fs") ? "binding" : ""); } catch (e) { got.push("binding-no"); }
  ctx.parts.define("probe", part(got.join("|"), 0));
} });\n`,
  child: `${HEADER}${PART}export default defineScript({ kind: "part", reads: {}, parameters: { ${text("marker")} }, async run(ctx, v) {
  const tried = [];
  try { const cp = await import("node:child_process"); cp.execFileSync("touch", [v.marker]); tried.push("import-ran"); } catch (e) { tried.push("import-no"); }
  try { require("node:child_process").execFileSync("touch", [v.marker]); tried.push("require-ran"); } catch (e) { tried.push("require-no"); }
  ctx.parts.define("probe", part(tried.join(","), 0));
} });\n`,
  memory: `${HEADER}${PART}export default defineScript({ kind: "part", reads: {}, parameters: {}, run(ctx) {
  // Heap arrays (typed arrays live outside the V8 heap the cap limits), doubling to 16M elements, so any cap is crossed in a few allocations, long before the time cap.
  const hold = [];
  for (let n = 1 << 20; ; n = Math.min(n * 2, 1 << 24)) hold.push(new Array(n).fill(hold.length));
} });\n`,
  time: `${HEADER}${PART}export default defineScript({ kind: "part", reads: {}, parameters: {}, run(ctx) {
  let n = 0;
  for (;;) n++;
} });\n`,
  output: `${HEADER}${PART}export default defineScript({ kind: "part", reads: {}, parameters: { bytes: { type: "number", label: "bytes" } }, run(ctx, v) {
  const pad = "x".repeat(380);
  const n = Math.ceil(v.bytes / 400) + 50;
  for (let i = 0; i < n; i++) ctx.parts.define("probe-" + i, part(pad, i));
} });\n`,
} as const;

/** Content hashes stand in for the probes' (they only seed ids). */
const PROBE_HASH = `sha256:${"0".repeat(64)}`;

const request = (source: string, values: Record<string, string | number> = {}) => ({ source, scriptHash: PROBE_HASH, values, slice: EMPTY_SLICE });

function describeProbe(probe: ScriptRunResult): string {
  return probe.ok ? JSON.stringify(probe.output).slice(0, 400) : `${probe.code}: ${probe.message}`;
}

/** Runs every probe through `runner`, in order; slow probes (the caps) run last. */
export async function runRunnerConformance(runner: ScriptRunner, targets: ConformanceTargets): Promise<ConformanceResult[]> {
  const out: ConformanceResult[] = [];
  const l = runner.limits;
  const within = l.memoryMb <= RUNNER_CONTRACT.memoryMb && l.wallMs <= RUNNER_CONTRACT.wallMs && l.outputBytes <= RUNNER_CONTRACT.outputBytes && l.memoryMb > 0 && l.wallMs > 0 && l.outputBytes > 0;
  out.push({ check: "limits", ok: within, detail: `memory ${l.memoryMb} MB (≤ ${RUNNER_CONTRACT.memoryMb}), time ${l.wallMs} ms (≤ ${RUNNER_CONTRACT.wallMs}), output ${l.outputBytes} bytes (≤ ${RUNNER_CONTRACT.outputBytes})` });

  const first = await runner.run(request(CONFORMANCE_PROBES.fresh));
  const second = await runner.run(request(CONFORMANCE_PROBES.fresh));
  const fresh = [first, second].every((r) => r.ok && JSON.stringify(r.output).includes("runs-before:0"));
  out.push({ check: "fresh_process", ok: fresh, detail: fresh ? "each run started clean" : `a run saw an earlier run's state (${describeProbe(second)})` });

  const a = await runner.run(request(CONFORMANCE_PROBES.deterministic, { n: 3 }));
  const b = await runner.run(request(CONFORMANCE_PROBES.deterministic, { n: 3 }));
  const same = a.ok && b.ok && JSON.stringify(a.output) === JSON.stringify(b.output);
  out.push({ check: "deterministic", ok: same, detail: same ? "the same script and values gave the same output" : `two runs differed (${describeProbe(a)} / ${describeProbe(b)})` });

  const net = await runner.run(request(CONFORMANCE_PROBES.network, { url: targets.url }));
  out.push({ check: "no_network", ok: !targets.contacted(), detail: targets.contacted() ? `the script reached ${targets.url} (${describeProbe(net)})` : "nothing reached the harness" });

  const files = await runner.run(request(CONFORMANCE_PROBES.files, { path: targets.secretPath }));
  const leaked = files.ok && JSON.stringify(files.output).includes(targets.secret);
  out.push({ check: "no_files", ok: !leaked, detail: leaked ? `the script read ${targets.secretPath}` : "no file outside the input was read" });

  const child = await runner.run(request(CONFORMANCE_PROBES.child, { marker: targets.markerPath }));
  out.push({ check: "no_child_processes", ok: !targets.markerExists(), detail: targets.markerExists() ? `a child process ran (${describeProbe(child)})` : "no child process ran" });

  const big = await runner.run(request(CONFORMANCE_PROBES.output, { bytes: l.outputBytes }));
  out.push({ check: "output_cap", ok: !big.ok && big.code === "cap_output", detail: describeProbe(big).slice(0, 200) });

  const mem = await runner.run(request(CONFORMANCE_PROBES.memory));
  out.push({ check: "memory_cap", ok: !mem.ok && mem.code === "cap_memory", detail: describeProbe(mem).slice(0, 200) });

  const slow = await runner.run(request(CONFORMANCE_PROBES.time));
  const stoppedInTime = !slow.ok && slow.code === "cap_time" && slow.ms <= l.wallMs + 5_000;
  out.push({ check: "time_cap", ok: stoppedInTime, detail: describeProbe(slow).slice(0, 200) });
  return out;
}
