/**
 * Scripts on the hosted server: the open runner's two bundled files
 * (`@permitzip/bim-script-runner`, the same ones a host app and the local
 * tool server run), started for each run inside a locked box on this
 * machine.
 *
 * The box (bubblewrap, a Linux sandbox that needs no root):
 * - No network: a network namespace of its own with no interfaces. Nothing
 *   inside can reach the internet, this app, or anything else.
 * - Nothing of ours: a fresh, empty root file system holding only the
 *   system's programs (/usr, read-only), the runner (read-only) and the one
 *   request file. The account database, model files, settings and this
 *   app's code are not in it at all.
 * - Nobody: its own user (65534, "nobody"), process, IPC and hostname
 *   namespaces, every capability dropped, no new privileges, an empty
 *   environment (no settings, no keys).
 * - Limits: the runner's own caps (1 GB of JavaScript memory, 30 s, 2 MB
 *   of output), CPU time and open files capped by prlimit, and the box is
 *   first in line for the kernel's out-of-memory killer, so a script that
 *   hogs memory is stopped before this app is.
 * - Inside the box the runner adds Node's permission model (no file
 *   writes, no child processes, no workers, no addons) and runs the script
 *   in a context holding only the kit.
 * - One run at a time per person, a few at once on the machine, a short
 *   queue; anything over it is refused in words.
 *
 * Before the first run the box is tried once (`availability`): if it
 * reaches a network, writes a file, sees a setting or runs as this app's
 * user, scripts are refused here rather than run unsealed.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNNER_CONTRACT, type RunnerLimits, type ScriptRunRequest, type ScriptRunResult } from "@permitzip/bim-script";
import { RUNNER_RESULT_SCHEMA, SCRIPT_CHILD_FILE, SCRIPT_RUNNER_FILE, toScriptRunResult, type ScriptRunnerRequestFile } from "@permitzip/bim-script-runner";

/** Where the image keeps the runner's two files, root-owned and read-only. */
export const DEFAULT_RUNNER_DIR = "/usr/local/lib/mutinybim/script-runner";

const BOX_RUNNER = "/runner";
const BOX_REQUEST = "/request.json";
const NOBODY = "65534";
/** The supervisor prints one line; anything much bigger is not a result. */
const MAX_ANSWER_BYTES = RUNNER_CONTRACT.outputBytes + 64 * 1024;
const PROBE_WAIT_MS = 15_000;
const PROBE_RETRY_MS = 5 * 60_000;

export type SandboxAvailability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ScriptSandboxOptions {
  /** Holds script-runner.cjs and script-child.cjs (DEFAULT_RUNNER_DIR in the image). */
  readonly runnerDir: string;
  /** Request files go here, one per run, removed after it. */
  readonly workDir: string;
  readonly bwrapPath?: string;
  readonly prlimitPath?: string;
  readonly shellPath?: string;
  /** The Node binary run inside the box; must live under /usr (the only system folder in it). */
  readonly nodePath?: string;
  readonly limits?: RunnerLimits;
  /** Runs at once on this machine (default 2). */
  readonly maxRunning?: number;
  /** Runs one person may have waiting behind their current one (default 2). */
  readonly maxWaitingPerPerson?: number;
  /** Runs one script instead of the box (the queue's own test). */
  readonly runOne?: (request: ScriptRunRequest) => Promise<ScriptRunResult>;
}

/**
 * The box, as arguments to bubblewrap. Exported so a test holds every flag:
 * a box that loses one of them (the network, the empty environment, the
 * read-only runner) fails it.
 */
export function sandboxArgs(input: { readonly runnerDir: string; readonly requestFile: string }): string[] {
  return [
    "--unshare-all",
    "--unshare-user",
    "--uid", NOBODY,
    "--gid", NOBODY,
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--cap-drop", "ALL",
    "--hostname", "script",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin",
    "--ro-bind", input.runnerDir, BOX_RUNNER,
    "--ro-bind", input.requestFile, BOX_REQUEST,
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--chdir", "/",
  ];
}

/** CPU seconds (a little over the wall-clock cap, for the supervisor), open files, no core dumps. */
export function limitArgs(limits: RunnerLimits): string[] {
  return [`--cpu=${Math.ceil(limits.wallMs / 1000) + 15}`, "--nofile=256", "--core=0"];
}

/** Makes the box first in line for the out-of-memory killer, then starts it (a process may always raise its own score). */
const OOM_FIRST = 'echo 1000 > /proc/self/oom_score_adj && exec "$@"';

/** What the box is tried with: it must see no network, no setting, no file of ours, and write nothing. */
const PROBE_SOURCE = [
  "const os = require('node:os'), fs = require('node:fs'), net = require('node:net');",
  "let wrote = false; try { fs.writeFileSync('/usr/.probe', '1'); wrote = true; } catch {}",
  "const report = (reached) => process.stdout.write(JSON.stringify({ interfaces: Object.keys(os.networkInterfaces()).filter((n) => n !== 'lo'), uid: process.getuid(), env: Object.keys(process.env).filter((k) => k !== 'PWD'), wrote, reached, runner: fs.existsSync('/runner/script-runner.cjs') }) + '\\n');",
  "const s = net.connect({ host: '1.1.1.1', port: 53, timeout: 3000 });",
  "s.on('connect', () => { s.destroy(); report(true); }); s.on('error', () => report(false)); s.on('timeout', () => { s.destroy(); report(false); });",
].join(" ");

interface ProbeReport {
  readonly interfaces: readonly string[];
  readonly uid: number;
  readonly env: readonly string[];
  readonly wrote: boolean;
  readonly reached: boolean;
  readonly runner: boolean;
}

function isProbeReport(value: unknown): value is ProbeReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.interfaces) && typeof v.uid === "number" && Array.isArray(v.env) && typeof v.wrote === "boolean" && typeof v.reached === "boolean" && typeof v.runner === "boolean";
}

/** Why a probe's report isn't sealed, or null when it is. */
export function probeProblem(report: ProbeReport, appUid: number | null): string | null {
  if (report.reached) return "the script box reached the internet";
  if (report.interfaces.length > 0) return `the script box has a network (${report.interfaces.join(", ")})`;
  if (report.wrote) return "the script box could write to the system folder";
  if (report.env.length > 0) return "the script box sees settings";
  if (report.uid === 0 || (appUid !== null && report.uid === appUid)) return "the script box runs as a real user";
  if (!report.runner) return "the script box can't see the runner";
  return null;
}

interface Run {
  readonly userId: string;
  readonly request: ScriptRunRequest;
  readonly resolve: (result: ScriptRunResult) => void;
}

export class ScriptSandbox {
  readonly id = "sealed-box";
  readonly limits: RunnerLimits;
  private readonly bwrap: string;
  private readonly prlimit: string;
  private readonly shell: string;
  private readonly node: string;
  private readonly maxRunning: number;
  private readonly maxWaiting: number;
  private probed: { readonly at: number; readonly answer: SandboxAvailability } | null = null;
  private probing: Promise<SandboxAvailability> | null = null;
  private running = 0;
  private readonly busy = new Set<string>();
  private readonly queue: Run[] = [];

  constructor(private readonly options: ScriptSandboxOptions) {
    this.limits = options.limits ?? RUNNER_CONTRACT;
    this.bwrap = options.bwrapPath ?? "/usr/bin/bwrap";
    this.prlimit = options.prlimitPath ?? "/usr/bin/prlimit";
    this.shell = options.shellPath ?? "/bin/sh";
    this.node = options.nodePath ?? process.execPath;
    this.maxRunning = Math.max(1, options.maxRunning ?? 2);
    this.maxWaiting = Math.max(0, options.maxWaitingPerPerson ?? 2);
  }

  /** Whether scripts can run here, tried once (and again after a few minutes when it failed). */
  availability(): Promise<SandboxAvailability> {
    const cached = this.probed;
    if (cached && (cached.answer.ok || Date.now() - cached.at < PROBE_RETRY_MS)) return Promise.resolve(cached.answer);
    this.probing ??= this.probe()
      .then((answer) => {
        this.probed = { at: Date.now(), answer };
        if (!answer.ok) console.error("[mutinybim-web] scripts are off: the script box isn't sealed", { reason: answer.reason });
        else console.log("[mutinybim-web] the script box is sealed; scripts run here");
        return answer;
      })
      .finally(() => {
        this.probing = null;
      });
    return this.probing;
  }

  private async probe(): Promise<SandboxAvailability> {
    if (process.platform !== "linux") return { ok: false, reason: "scripts run only on the Linux server (it needs its sealed box)" };
    for (const [what, file] of [["bubblewrap", this.bwrap], ["prlimit", this.prlimit], ["the shell", this.shell]] as const) {
      if (!existsSync(file)) return { ok: false, reason: `${what} isn't installed (${file})` };
    }
    if (!this.node.startsWith("/usr/")) return { ok: false, reason: `Node must live under /usr to run in the script box (it is at ${this.node})` };
    for (const file of [SCRIPT_RUNNER_FILE, SCRIPT_CHILD_FILE]) {
      if (!existsSync(path.join(this.options.runnerDir, file))) return { ok: false, reason: `the script runner isn't built (${path.join(this.options.runnerDir, file)} is missing)` };
    }
    const requestFile = this.requestFile("probe");
    writeFileSync(requestFile, "{}", { mode: 0o600 });
    try {
      const answer = await this.box(requestFile, ["-e", PROBE_SOURCE], PROBE_WAIT_MS);
      if (answer.kind !== "line") return { ok: false, reason: `the script box didn't start (${answer.message})` };
      let report: unknown;
      try {
        report = JSON.parse(answer.line);
      } catch (err) {
        console.error("[mutinybim-web] the script box's probe printed something that isn't JSON", { err });
        return { ok: false, reason: "the script box's check printed something unexpected" };
      }
      if (!isProbeReport(report)) return { ok: false, reason: "the script box's check printed something unexpected" };
      const problem = probeProblem(report, typeof process.getuid === "function" ? process.getuid() : null);
      return problem ? { ok: false, reason: problem } : { ok: true };
    } finally {
      rmSync(requestFile, { force: true });
    }
  }

  private requestFile(label: string): string {
    mkdirSync(this.options.workDir, { recursive: true, mode: 0o700 });
    return path.join(this.options.workDir, `${label}-${randomUUID()}.json`);
  }

  /** Runs node inside the box with these arguments; the first line it prints, or why there wasn't one. */
  private box(requestFile: string, nodeArgs: readonly string[], waitMs: number): Promise<{ readonly kind: "line"; readonly line: string } | { readonly kind: "none"; readonly message: string; readonly signal: NodeJS.Signals | null }> {
    const args = ["-c", OOM_FIRST, "sh", this.prlimit, ...limitArgs(this.limits), "--", this.bwrap, ...sandboxArgs({ runnerDir: this.options.runnerDir, requestFile }), this.node, ...nodeArgs];
    return new Promise((resolve) => {
      const child = spawn(this.shell, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let settled = false;
      const done = (answer: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve(answer);
      };
      const timer = setTimeout(() => done({ kind: "none", message: `no answer within ${Math.round(waitMs / 1000)} s`, signal: null }), waitMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.length > MAX_ANSWER_BYTES) return done({ kind: "none", message: "the answer was too large", signal: null });
        const nl = out.indexOf("\n");
        if (nl >= 0) done({ kind: "line", line: out.slice(0, nl) });
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (err.length < 4096) err += chunk.slice(0, 4096 - err.length);
      });
      child.on("error", (e) => done({ kind: "none", message: e.message, signal: null }));
      child.on("close", (code, signal) => done({ kind: "none", message: `the script box exited ${code ?? signal}${err ? `: ${err.trim().slice(0, 300)}` : ""}`, signal }));
    });
  }

  /** Queues one person's run; one at a time per person, a few at once on the machine. */
  run(userId: string, request: ScriptRunRequest): Promise<ScriptRunResult> {
    const theirs = this.queue.filter((r) => r.userId === userId).length + (this.busy.has(userId) ? 1 : 0);
    if (theirs > this.maxWaiting) {
      return Promise.resolve({ ok: false, code: "runner_error", message: "you already have scripts running and waiting here; wait for them to finish, then run this one", ms: 0 });
    }
    return new Promise((resolve) => {
      this.queue.push({ userId, request, resolve });
      this.next();
    });
  }

  private next(): void {
    while (this.running < this.maxRunning) {
      const index = this.queue.findIndex((r) => !this.busy.has(r.userId));
      if (index < 0) return;
      const [run] = this.queue.splice(index, 1);
      if (!run) return;
      this.running += 1;
      this.busy.add(run.userId);
      void (this.options.runOne ?? ((request: ScriptRunRequest) => this.runNow(request)))(run.request)
        .catch((err: unknown): ScriptRunResult => {
          console.error("[mutinybim-web] a script run failed in the server", { userId: run.userId, err });
          return { ok: false, code: "runner_error", message: err instanceof Error ? err.message : String(err), ms: 0 };
        })
        .then((result) => {
          this.running -= 1;
          this.busy.delete(run.userId);
          run.resolve(result);
          this.next();
        });
    }
  }

  private async runNow(request: ScriptRunRequest): Promise<ScriptRunResult> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    const ready = await this.availability();
    if (!ready.ok) return { ok: false, code: "runner_error", message: ready.reason, ms: ms() };
    const requestFile = this.requestFile("run");
    const file: ScriptRunnerRequestFile = { v: 1, limits: this.limits, run: { source: request.source, scriptHash: request.scriptHash, values: request.values, slice: request.slice } };
    writeFileSync(requestFile, JSON.stringify(file), { mode: 0o600 });
    try {
      const answer = await this.box(requestFile, [`${BOX_RUNNER}/${SCRIPT_RUNNER_FILE}`, BOX_REQUEST], this.limits.wallMs + 20_000);
      if (answer.kind !== "line") {
        // The kernel's out-of-memory killer took the box (it is first in line).
        if (answer.signal === "SIGKILL" || /SIGKILL/.test(answer.message)) return { ok: false, code: "cap_memory", message: "the script used more memory than this server allows", ms: ms() };
        return { ok: false, code: "runner_error", message: answer.message, ms: ms() };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer.line);
      } catch (err) {
        console.error("[mutinybim-web] the script box printed something that isn't JSON", { err });
        return { ok: false, code: "runner_error", message: "the script box's answer isn't a run result", ms: ms() };
      }
      const line = RUNNER_RESULT_SCHEMA.safeParse(parsed);
      if (!line.success) return { ok: false, code: "runner_error", message: "the script box's answer isn't a run result", ms: ms() };
      // The supervisor reports its child's out-of-memory kill as an exit by SIGKILL.
      if (!line.data.ok && line.data.code === "runner_error" && /exited SIGKILL/.test(line.data.message)) return { ok: false, code: "cap_memory", message: "the script used more memory than this server allows", ms: line.data.ms };
      return toScriptRunResult(line.data, ms);
    } finally {
      rmSync(requestFile, { force: true });
    }
  }
}

/** Where and whether this server runs scripts, as the tool server uses it. */
export interface HostedScripts {
  /** Where scripts run, in bim_run_script's description. */
  readonly where: string;
  availability(): Promise<SandboxAvailability>;
  run(userId: string, request: ScriptRunRequest): Promise<ScriptRunResult>;
}

export const SEALED_WHERE = "in this server's sealed script box (no network, nothing but the model slice it reads; 1 GB, 30 s, 2 MB)";

export function sealedScripts(sandbox: ScriptSandbox): HostedScripts {
  return { where: SEALED_WHERE, availability: () => sandbox.availability(), run: (userId, request) => sandbox.run(userId, request) };
}

export function scriptsOff(reason: string): HostedScripts {
  const answer: SandboxAvailability = { ok: false, reason };
  return { where: "nowhere on this server (scripts are off)", availability: async () => answer, run: async () => ({ ok: false, code: "runner_error", message: reason, ms: 0 }) };
}

export const LOCAL_WHERE = "in a fresh process on this computer (a local test server; 1 GB, 30 s, 2 MB; not network-sealed)";

/** A runner on this computer, for a server only its own person reaches (a loopback address): never for other people's scripts. */
export function localScripts(runner: { run(request: ScriptRunRequest): Promise<ScriptRunResult>; availability(): Promise<SandboxAvailability> }): HostedScripts {
  return { where: LOCAL_WHERE, availability: () => runner.availability(), run: (_userId, request) => runner.run(request) };
}
