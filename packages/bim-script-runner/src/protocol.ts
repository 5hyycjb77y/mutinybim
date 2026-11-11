/**
 * The MutinyBIM script runner: one script, one fresh process, hard caps.
 *
 * Two bundled files (build.ts):
 *
 * - `script-runner.cjs` (supervisor.ts): reads one request file, starts the
 *   script as a fresh child process with `childNodeArgs`, an empty
 *   environment and the caps, prints one JSON line (a `ScriptRunResult`).
 * - `script-child.cjs` (child.ts, the kit bundled in): runs one script with
 *   the kit's `runScript` and prints its output.
 *
 * A host that runs other people's scripts puts these files on a sealed
 * machine with a deny-all network (a container or a microVM) and runs only
 * that copy. `LocalScriptRunner` (local.ts) runs them on this computer for one
 * person's own scripts. The files bundle with esbuild alone; the supervisor
 * has no dependencies, so its bundle stays small.
 */

export const SCRIPT_RUNNER_FILE = "script-runner.cjs";
export const SCRIPT_CHILD_FILE = "script-child.cjs";

/** The kit's runner contract (`RUNNER_CONTRACT` in @permitzip/bim-script), repeated so the supervisor bundles without the kit. */
export const SCRIPT_RUNNER_CAPS = { memoryMb: 1024, wallMs: 30_000, outputBytes: 2 * 1024 * 1024 } as const;

export interface ScriptRunnerLimits {
  readonly memoryMb: number;
  readonly wallMs: number;
  readonly outputBytes: number;
}

/** The request file's shape. `run` is a `ScriptRunRequest`; the child re-checks the slice with the kit's schema. */
export interface ScriptRunnerRequestFile {
  readonly v: 1;
  readonly limits?: Partial<ScriptRunnerLimits>;
  readonly run: {
    readonly source: string;
    readonly scriptHash: string;
    readonly values: Readonly<Record<string, string | number | boolean>>;
    readonly slice: unknown;
  };
}

/** Requested limits, never above the contract. */
export function clampLimits(requested: Partial<ScriptRunnerLimits> | undefined): ScriptRunnerLimits {
  const pick = (want: number | undefined, cap: number) => (typeof want === "number" && Number.isFinite(want) && want > 0 ? Math.min(Math.floor(want), cap) : cap);
  return {
    memoryMb: pick(requested?.memoryMb, SCRIPT_RUNNER_CAPS.memoryMb),
    wallMs: pick(requested?.wallMs, SCRIPT_RUNNER_CAPS.wallMs),
    outputBytes: pick(requested?.outputBytes, SCRIPT_RUNNER_CAPS.outputBytes),
  };
}

/**
 * The child's node flags, exactly (round 11's fix): its own heap cap (V8 flags
 * are process-wide, so a parent's `--max-old-space-size` must not decide it),
 * and the permission model with only the child bundle readable: no file
 * writes, no child processes, no worker threads, no addons, no WASI. Node 22's
 * permission model does not cover sockets; the network is denied by the
 * sandbox's deny-all policy.
 *
 * The young generation is pinned too: V8's heap limit is old space plus three
 * semi-spaces, and the default semi-space grew in Node 24 (1024 MB of old
 * space reports 1120–1216 MB there, 1072 MB on Node 22), which the
 * supervisor's 64 MB allowance refuses.
 */
export const CHILD_SEMI_SPACE_MB = 16;

export function childNodeArgs(limits: ScriptRunnerLimits, childFile: string): string[] {
  return [`--max-old-space-size=${limits.memoryMb}`, `--max-semi-space-size=${CHILD_SEMI_SPACE_MB}`, "--permission", `--allow-fs-read=${childFile}`, "--disable-warning=ExperimentalWarning", childFile];
}

/** The child's environment: nothing at all (no NODE_OPTIONS, no PATH, no credential). */
export function childEnv(): Record<string, string> {
  return {};
}

/** Lines the child prints on stdout. */
export type ChildLine = { readonly ready: true; readonly heapLimitMb: number } | { readonly ok: true; readonly output: unknown; readonly manifest: unknown } | { readonly ok: false; readonly message: string };

/** The longest failure message a run result carries (the host's result schema takes 4,000 characters; longer ones were refused whole). */
export const RUN_MESSAGE_MAX = 3500;

/** A failure message within `RUN_MESSAGE_MAX`, saying how much was cut. */
export function clipRunMessage(message: string): string {
  return message.length <= RUN_MESSAGE_MAX ? message : `${message.slice(0, RUN_MESSAGE_MAX)}… (${message.length - RUN_MESSAGE_MAX} more characters cut)`;
}

/**
 * Words for a script process that ended with no answer. `started`: it said
 * it was ready, so the machine itself came up and something in the run ended
 * it; otherwise the machine never started and the script is not at fault.
 */
export function exitWords(code: number | null, signal: string | null, stderr: string, started: boolean): string {
  const said = stderr.trim().slice(0, 300);
  const base = `the script process exited ${code ?? signal} before answering${said ? `: ${said}` : ""}`;
  if (!started) return `${base}. It ended before it was ready, so the script machine didn't start`;
  if (signal === "SIGKILL") return `${base}. The machine stopped it, most often for using too much memory: read less or build less in one run`;
  return base;
}

/** Said by the script process when it has nothing left to wait for and no result: `run()` awaits something that never finishes. */
export const NEVER_FINISHED_WORDS = "The script ended without a result: run() is waiting on something that never finishes (a promise nothing resolves). A script has no timers or network to wait for; make the edits and return.";

/** Added to an error from a promise the script made and didn't await. */
export const UNAWAITED_WORDS = "(thrown by an async call the script didn't await: put await in front of it)";
