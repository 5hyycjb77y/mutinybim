/**
 * The runner entry inside the script sandbox (bundled into
 * `script-runner.cjs`): `node script-runner.cjs <request.json>` runs one
 * script as a fresh child process and prints one JSON line, a
 * `ScriptRunResult` (`@permitzip/bim-script`). The host re-parses the output
 * with the kit's `parseScriptOutput`; nothing printed here is trusted as is.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT_CHILD_FILE, childEnv, childNodeArgs, clampLimits, clipRunMessage, exitWords, type ChildLine, type ScriptRunnerLimits, type ScriptRunnerRequestFile } from "./protocol";

export type SupervisedResult =
  | { readonly ok: true; readonly output: unknown; readonly manifest: unknown; readonly bytes: number; readonly ms: number }
  | { readonly ok: false; readonly code: "cap_memory" | "cap_time" | "cap_output" | "script_error" | "runner_error"; readonly message: string; readonly ms: number };

export interface SuperviseOptions {
  readonly nodePath: string;
  readonly childFile: string;
  readonly limits: ScriptRunnerLimits;
  /** Sees every spawn (tests check the flags and environment). */
  readonly onSpawn?: (args: readonly string[], env: Readonly<Record<string, string>>) => void;
}

/** V8's heap-limit abort, as the child prints it. */
const HEAP_LIMIT = /Reached heap limit|JavaScript heap out of memory/;
/** stderr kept for words; the child's warnings never fill memory. */
const STDERR_KEEP = 8 * 1024;

export function superviseRun(run: ScriptRunnerRequestFile["run"], options: SuperviseOptions): Promise<SupervisedResult> {
  const { limits } = options;
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const args = childNodeArgs(limits, options.childFile);
  const env = childEnv();
  options.onSpawn?.(args, env);
  return new Promise((resolve) => {
    // The child must get an empty environment; the app program's ProcessEnv (Next) declares NODE_ENV required, which an empty one isn't.
    const child = spawn(options.nodePath, args, { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stderr = "";
    let pending = "";
    let outputBytes = 0;
    let readySeen = false;
    const overMemory = (): SupervisedResult => ({ ok: false, code: "cap_memory", message: `over ${limits.memoryMb} MB`, ms: ms() });
    const done = (result: SupervisedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };
    const onLine = (line: string) => {
      let msg: ChildLine;
      try {
        msg = JSON.parse(line) as ChildLine;
      } catch (err) {
        console.error("[script-runner] the child printed a line that isn't JSON", { err, head: line.slice(0, 120) });
        return done({ ok: false, code: "runner_error", message: "the script process printed something that isn't a result", ms: ms() });
      }
      if ("ready" in msg) {
        readySeen = true;
        // The memory cap is only real if V8 took it; refuse to run rather than run uncapped.
        if (msg.heapLimitMb > limits.memoryMb + 64) return done({ ok: false, code: "runner_error", message: `heap limit ${Math.round(msg.heapLimitMb)} MB, over the ${limits.memoryMb} MB cap`, ms: ms() });
        timer = setTimeout(() => done(HEAP_LIMIT.test(stderr) ? overMemory() : { ok: false, code: "cap_time", message: `stopped after ${limits.wallMs} ms`, ms: ms() }), limits.wallMs);
        child.stdin.end(JSON.stringify(run));
        return;
      }
      if (!msg.ok) return done({ ok: false, code: "script_error", message: clipRunMessage(msg.message), ms: ms() });
      const bytes = Buffer.byteLength(JSON.stringify(msg.output));
      if (bytes > limits.outputBytes) return done({ ok: false, code: "cap_output", message: `${bytes} bytes`, ms: ms() });
      done({ ok: true, output: msg.output, manifest: msg.manifest, bytes, ms: ms() });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      // The result line carries a little framing over the output itself.
      if (readySeen && outputBytes > limits.outputBytes + 4096) return done({ ok: false, code: "cap_output", message: `over ${limits.outputBytes} bytes`, ms: ms() });
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl >= 0 && !settled) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.trim().length > 0) onLine(line);
        nl = pending.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_KEEP) stderr += chunk.slice(0, STDERR_KEEP - stderr.length);
      // V8 prints the heap-limit line before it aborts; a crashing process can take seconds to exit (a core dump), and that wait is not the script's time.
      if (HEAP_LIMIT.test(stderr)) done(overMemory());
    });
    child.stdin.on("error", (err) => {
      if (!settled) console.error("[script-runner] writing the request to the script process failed", err);
    });
    child.on("error", (err) => done({ ok: false, code: "runner_error", message: err.message, ms: ms() }));
    child.on("close", (code, signal) => {
      if (HEAP_LIMIT.test(stderr)) return done(overMemory());
      done({ ok: false, code: "runner_error", message: exitWords(code, signal, stderr, readySeen), ms: ms() });
    });
  });
}

function isRequestFile(value: unknown): value is ScriptRunnerRequestFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { v?: unknown; run?: unknown };
  return v.v === 1 && typeof v.run === "object" && v.run !== null;
}

export async function main(argv: readonly string[]): Promise<number> {
  const path = argv[0];
  const print = (r: SupervisedResult) => process.stdout.write(`${JSON.stringify(r)}\n`);
  if (!path) {
    print({ ok: false, code: "runner_error", message: "usage: script-runner.cjs <request.json>", ms: 0 });
    return 2;
  }
  let request: unknown;
  try {
    request = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error("[script-runner] the request file couldn't be read", { path, err });
    print({ ok: false, code: "runner_error", message: `the request file couldn't be read: ${err instanceof Error ? err.message : String(err)}`, ms: 0 });
    return 1;
  }
  if (!isRequestFile(request)) {
    print({ ok: false, code: "runner_error", message: "the request file isn't a version 1 run request", ms: 0 });
    return 1;
  }
  print(await superviseRun(request.run, { nodePath: process.execPath, childFile: join(__dirname, SCRIPT_CHILD_FILE), limits: clampLimits(request.limits) }));
  return 0;
}

// Run as the bundled CommonJS entry only; an ES module import (the local runner) has no `require`.
if (typeof require !== "undefined" && require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error("[script-runner] failed", err);
      process.exitCode = 1;
    });
}
