import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_CONTRACT, type RunnerLimits, type ScriptRunRequest, type ScriptRunResult, type ScriptRunner } from "@permitzip/bim-script";
import { buildScriptRunner } from "./build";
import { superviseRun } from "./supervisor";
import { RUNNER_RESULT_SCHEMA, toScriptRunResult } from "./result";

/**
 * The script runner on this computer, for one person running their own
 * scripts (a laptop, a local MutinyBIM tool server). Each run is a fresh Node
 * process started by the supervisor with Node's permission model (it reads
 * only its own bundle; no file writes, child processes, worker threads,
 * addons or WASI), an empty environment and the kit's caps (1 GB, 30 s,
 * 2 MB). The script is evaluated in a context that holds only the kit.
 *
 * LOCAL ONLY. Node's permission model does not cover sockets, so a hostile
 * script that escapes its context could reach the network. Never host other
 * people's scripts with this runner: run the same two files on a sealed
 * machine with a deny-all network instead.
 */
export interface LocalScriptRunnerOptions {
  /** The checkout holding `packages/` (the runner bundles from its sources). */
  readonly repoRoot: string;
  /** Where the two bundled files go; default a fresh temporary directory. */
  readonly outDir?: string;
  readonly tsconfig?: string | null;
  readonly limits?: RunnerLimits;
  /** The Node binary for the script process (default: this one). */
  readonly nodePath?: string;
}

export type LocalRunnerAvailability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Node 22 or later: the permission model the child is started with. */
const MIN_NODE_MAJOR = 22;

export class LocalScriptRunner implements ScriptRunner {
  readonly id = "local-process";
  readonly limits: RunnerLimits;
  private built: Promise<{ readonly runner: string; readonly child: string }> | null = null;

  constructor(private readonly options: LocalScriptRunnerOptions) {
    this.limits = options.limits ?? RUNNER_CONTRACT;
  }

  async availability(): Promise<LocalRunnerAvailability> {
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) return { ok: false, reason: `scripts need Node ${MIN_NODE_MAJOR} or later (this is ${process.versions.node})` };
    try {
      await this.files();
      return { ok: true };
    } catch (err) {
      console.error("[script-runner] the local runner couldn't be built", err);
      return { ok: false, reason: `the local script runner couldn't be built (${err instanceof Error ? err.message : String(err)})` };
    }
  }

  private files(): Promise<{ readonly runner: string; readonly child: string }> {
    if (!this.built) {
      const out = this.options.outDir ?? join(realpathSync(mkdtempSync(join(tmpdir(), "mutinybim-script-runner-"))), "lib");
      this.built = buildScriptRunner(out, this.options.repoRoot, this.options.tsconfig === undefined ? {} : { tsconfig: this.options.tsconfig }).catch((err: unknown) => {
        this.built = null;
        throw err;
      });
    }
    return this.built;
  }

  async run(request: ScriptRunRequest): Promise<ScriptRunResult> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    let childFile: string;
    try {
      childFile = (await this.files()).child;
    } catch (err) {
      console.error("[script-runner] the local runner couldn't be built", err);
      return { ok: false, code: "runner_error", message: `the local script runner couldn't be built (${err instanceof Error ? err.message : String(err)})`, ms: ms() };
    }
    const supervised = await superviseRun({ source: request.source, scriptHash: request.scriptHash, values: request.values, slice: request.slice }, { nodePath: this.options.nodePath ?? process.execPath, childFile, limits: this.limits });
    const line = RUNNER_RESULT_SCHEMA.safeParse(supervised);
    if (!line.success) {
      console.error("[script-runner] the supervisor's answer isn't a run result", { issues: line.error.issues.slice(0, 3) });
      return { ok: false, code: "runner_error", message: "the script runner's answer isn't a run result", ms: ms() };
    }
    return toScriptRunResult(line.data, ms);
  }
}
