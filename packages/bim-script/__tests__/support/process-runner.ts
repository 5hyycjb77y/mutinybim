/**
 * The conformance suite's reference runner (test-only): a fresh node process
 * per run, the probe evaluated in an empty `vm` context under the process's
 * own heap cap, the wall clock enforced by killing the process. It carries a
 * minimal kit (the probes use only `ctx.id`, `ctx.random` and
 * `ctx.parts.define`); a host's adapter runs the real kit inside its
 * sandbox image (SP11).
 */
import { spawn } from "node:child_process";
import type { RunnerLimits, ScriptRunRequest, ScriptRunResult, ScriptRunner } from "../../src/runner";

const CHILD = `
const vm = require("node:vm");
process.send({ ready: true, heapLimitMb: require("node:v8").getHeapStatistics().heap_size_limit / 1048576 });
process.once("message", ({ source, values, leakNetwork }) => {
const types = [];
let counter = 0;
let seed = 7;
const ctx = {
  id: (p = "s") => p + "-" + (counter++),
  random: () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; },
  parts: { define: (typeId, definition) => types.push({ typeId, definition }) },
  edit: () => { throw new Error("probes make part types"); },
  label: () => {},
};
const sandbox = { __exports: {}, defineScript: (spec) => spec };
if (leakNetwork) sandbox.fetch = fetch;
const code = source.replace(/^import .*$/m, "").replace("export default", "__exports.default =");
(async () => {
  try {
    vm.runInNewContext(code, sandbox, { filename: "probe.js" });
    await sandbox.__exports.default.run(ctx, values);
    process.send({ ok: true, output: { kind: "part_types", types } });
  } catch (err) {
    process.send({ ok: false, message: String(err && err.message || err) });
  }
})();
});
`;

type ChildMessage = { ready: true; heapLimitMb: number } | { ready?: undefined; ok: boolean; output?: unknown; message?: string };

/** V8's heap-limit abort, as the child prints it to stderr. */
const HEAP_LIMIT = /Reached heap limit|JavaScript heap out of memory/;

// A child process, not a worker thread: V8 flags are process-wide, so a host started with
// `--max-old-space-size` (CI's NODE_OPTIONS) overrides a worker's `resourceLimits` and the
// memory cap silently stops applying. The child gets its own flags and an empty environment.
export class ProcessRunner implements ScriptRunner {
  readonly id: string;
  constructor(
    readonly limits: RunnerLimits,
    private readonly leakNetwork = false,
  ) {
    this.id = leakNetwork ? "leaky-process" : "process";
  }

  run(request: ScriptRunRequest): Promise<ScriptRunResult> {
    const started = performance.now();
    const ms = () => performance.now() - started;
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${this.limits.memoryMb}`, "-e", CHILD], { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (r: ScriptRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve(r);
      };
      child.on("message", (m: ChildMessage) => {
        if (m.ready) {
          // The memory cap is only real if V8 took it; refuse to run rather than run uncapped.
          if (m.heapLimitMb > this.limits.memoryMb + 64) return done({ ok: false, code: "runner_error", message: `heap limit ${Math.round(m.heapLimitMb)} MB, over the ${this.limits.memoryMb} MB cap`, ms: ms() });
          // The cap is the script's run time ("the script ran longer than"), so the clock starts when the script is handed over, not while a loaded machine boots node.
          timer = setTimeout(() => done({ ok: false, code: "cap_time", message: `stopped after ${this.limits.wallMs} ms`, ms: ms() }), this.limits.wallMs);
          child.send({ source: request.source, values: request.values, leakNetwork: this.leakNetwork });
          return;
        }
        if (!m.ok) return done({ ok: false, code: "script_error", message: m.message ?? "error", ms: ms() });
        const bytes = Buffer.byteLength(JSON.stringify(m.output));
        if (bytes > this.limits.outputBytes) return done({ ok: false, code: "cap_output", message: `${bytes} bytes`, ms: ms() });
        done({ ok: true, output: m.output, bytes, ms: ms() });
      });
      child.on("error", (err) => done({ ok: false, code: "runner_error", message: err.message, ms: ms() }));
      child.on("close", (code, signal) => {
        if (HEAP_LIMIT.test(stderr)) return done({ ok: false, code: "cap_memory", message: `over ${this.limits.memoryMb} MB`, ms: ms() });
        done({ ok: false, code: "runner_error", message: `process exited ${code ?? signal}: ${stderr.slice(0, 200)}`, ms: ms() });
      });
    });
  }
}
